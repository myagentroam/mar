import type { ResolvedMcpServer } from '../mcp/model.js';
import { NODE_MCP } from '../mcp/naming.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScheduledSessionStore } from './scheduled-session-store.js';

interface Capability {
  readonly executionId: string;
  readonly sessionId: string;
  readonly workspaceId?: string;
  readonly taskId?: string;
  readonly revision?: number;
  readonly actorUserId: number;
}

interface Request {
  readonly token?: unknown;
  readonly tool?: unknown;
  readonly arguments?: unknown;
}

export class ScheduleMcpBridge {
  readonly #capabilities = new Map<string, Capability>();
  readonly #sockets = new Set<Socket>();
  readonly #endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\mar-schedule-${process.pid}-${randomUUID()}`
      : join(tmpdir(), `mar-schedule-${process.pid}-${randomUUID()}.sock`);
  #listening?: Promise<Server>;

  constructor(
    private readonly store: () => ScheduledSessionStore,
    private readonly changed: (sessionId: string) => void,
    private readonly proposed: (sessionId: string, proposalId: string) => void,
    private readonly create?: (input: {
      readonly sessionId: string;
      readonly workspaceId: string;
      readonly actorUserId: number;
      readonly objective: string;
      readonly cron: string;
    }) => Promise<{ readonly id: string; readonly sessionId: string; readonly revision: number }>,
    private readonly resolveSessionId?: (sessionId: string) => string
  ) {}

  async prepare(capability: Capability): Promise<ResolvedMcpServer> {
    await this.#listen();
    const args = scheduleMcpStdioArgs();
    const token = randomBytes(32).toString('base64url');
    this.#capabilities.set(token, capability);
    return {
      name: NODE_MCP.schedule.name,
      origin: 'BUILTIN',
      lifecycle: 'EXECUTION',
      transport: 'STDIO',
      command: process.execPath,
      args,
      environment: {
        MAR_SCHEDULE_MCP_ENDPOINT: this.#endpoint,
        MAR_SCHEDULE_MCP_TOKEN: token
      },
      allowedToolCallers: {
        [NODE_MCP.schedule.tools.get]: ['direct', 'programmatic'],
        [NODE_MCP.schedule.tools.create]: ['direct', 'programmatic'],
        [NODE_MCP.schedule.tools.update]: ['direct', 'programmatic']
      }
    };
  }

  revoke(executionId: string): void {
    for (const [token, capability] of this.#capabilities)
      if (capability.executionId === executionId) this.#capabilities.delete(token);
  }

  async close(): Promise<void> {
    if (this.#listening === undefined) return;
    const server = await this.#listening;
    this.#capabilities.clear();
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
    for (const socket of this.#sockets) socket.destroy();
    await closed;
    if (process.platform !== 'win32') await unlink(this.#endpoint).catch(() => undefined);
  }

  #listen(): Promise<Server> {
    this.#listening ??= new Promise((resolve, reject) => {
      const server = createServer((socket) => this.#handle(socket));
      server.once('error', reject);
      server.listen(this.#endpoint, () => resolve(server));
    });
    return this.#listening;
  }

  #handle(socket: Socket): void {
    this.#sockets.add(socket);
    socket.once('close', () => this.#sockets.delete(socket));
    let body = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64_000) {
        socket.destroy();
        return;
      }
      if (body.includes('\n')) void this.#respond(socket, body.slice(0, body.indexOf('\n')));
    });
  }

  async #respond(socket: Socket, body: string): Promise<void> {
    try {
      const request = JSON.parse(body) as Request;
      const capability =
        typeof request.token === 'string' ? this.#capabilities.get(request.token) : undefined;
      if (capability === undefined) throw new Error('SCHEDULE_CAPABILITY_INVALID');
      const sessionId = this.resolveSessionId?.(capability.sessionId) ?? capability.sessionId;
      const task = this.store().get(sessionId);
      if (
        (task === undefined && capability.taskId !== undefined) ||
        (task !== undefined &&
          (task.id !== capability.taskId || task.revision !== capability.revision))
      )
        throw new Error('SCHEDULE_CAPABILITY_STALE');
      if (request.tool === NODE_MCP.schedule.tools.get) {
        socket.end(`${JSON.stringify({ result: task ?? null })}\n`);
        return;
      }
      if (request.tool === NODE_MCP.schedule.tools.create) {
        if (task !== undefined) throw new Error('SCHEDULE_ALREADY_EXISTS');
        const args = record(request.arguments);
        if (
          typeof args.objective !== 'string' ||
          typeof args.cron !== 'string' ||
          capability.workspaceId === undefined ||
          this.create === undefined
        )
          throw new Error('SCHEDULE_INVALID');
        const created = await this.create({
          sessionId: capability.sessionId,
          workspaceId: capability.workspaceId,
          actorUserId: capability.actorUserId,
          objective: args.objective,
          cron: args.cron
        });
        this.#capabilities.set(request.token as string, {
          ...capability,
          sessionId: created.sessionId,
          taskId: created.id,
          revision: created.revision
        });
        socket.end(`${JSON.stringify({ result: created })}\n`);
        return;
      }
      if (request.tool !== NODE_MCP.schedule.tools.update) throw new Error('SCHEDULE_TOOL_INVALID');
      if (task === undefined) throw new Error('SCHEDULE_NOT_FOUND');
      const args = record(request.arguments);
      const result = this.store().updateFromAgent(
        task.sessionId,
        task.revision,
        capability.actorUserId,
        args
      );
      if ('proposalId' in result) {
        this.proposed(task.sessionId, result.proposalId);
        socket.end(`${JSON.stringify({ result })}\n`);
      } else {
        this.#capabilities.set(request.token as string, {
          ...capability,
          revision: result.revision
        });
        this.changed(task.sessionId);
        socket.end(`${JSON.stringify({ result })}\n`);
      }
    } catch (error) {
      socket.end(
        `${JSON.stringify({ error: error instanceof Error ? error.message : 'SCHEDULE_IPC_FAILED' })}\n`
      );
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scheduleMcpStdioArgs(): readonly string[] {
  const javascript = fileURLToPath(new URL('./schedule-mcp-stdio.js', import.meta.url));
  if (existsSync(javascript)) return [javascript];
  const typescript = fileURLToPath(new URL('./schedule-mcp-stdio.ts', import.meta.url));
  if (!existsSync(typescript)) throw new Error('SCHEDULE_MCP_STDIO_ENTRY_UNAVAILABLE');
  return ['--import', import.meta.resolve('tsx'), typescript];
}
