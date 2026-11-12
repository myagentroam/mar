import type { ResolvedMcpServer } from '../mcp/model.js';
import { NODE_MCP } from '../mcp/naming.js';
import { McpCapabilityToken } from '../mcp/capability-token.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScheduledSessionStore } from './scheduled-session-store.js';

const capabilitySchema = z.object({
  executionId: z.string(),
  sessionId: z.string(),
  workspaceId: z.string().optional(),
  taskId: z.string().optional(),
  revision: z.number().int().nonnegative().optional(),
  actorUserId: z.number().int().positive()
});
type Capability = z.infer<typeof capabilitySchema>;

interface Request {
  readonly token?: unknown;
  readonly tool?: unknown;
  readonly arguments?: unknown;
}

/** Owns task IPC, revision checks and private credential renewal after successful edits. */
export class ScheduleMcpBridge {
  readonly #tokens = new McpCapabilityToken(NODE_MCP.schedule.name, capabilitySchema);
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
    private readonly resolveExecution: (capability: Capability) => string | undefined,
    private readonly create?: (input: {
      readonly sessionId: string;
      readonly workspaceId: string;
      readonly actorUserId: number;
      readonly objective: string;
      readonly cron: string;
    }) => Promise<{ readonly id: string; readonly sessionId: string; readonly revision: number }>
  ) {}

  async prepare(capability: Capability): Promise<ResolvedMcpServer> {
    await this.#listen();
    const args = scheduleMcpStdioArgs();
    const token = this.#tokens.sign(capability);
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

  async close(): Promise<void> {
    if (this.#listening === undefined) return;
    const server = await this.#listening;
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
      const capability = this.#tokens.verify(request.token);
      if (capability === undefined) throw new Error('SCHEDULE_CAPABILITY_INVALID');
      const sessionId = this.resolveExecution(capability);
      if (sessionId === undefined) throw new Error('SCHEDULE_CAPABILITY_STALE');
      const task = this.store().get(sessionId);
      if (request.tool === NODE_MCP.schedule.tools.get) {
        // A create may commit before stdio receives the token that binds its task identity.
        if (capability.taskId !== undefined && task?.id !== capability.taskId)
          throw new Error('SCHEDULE_CAPABILITY_STALE');
        socket.end(`${JSON.stringify({ result: task ?? null })}\n`);
        return;
      }
      if (
        (task === undefined && capability.taskId !== undefined) ||
        (task !== undefined &&
          (task.id !== capability.taskId || task.revision !== capability.revision))
      )
        throw new Error('SCHEDULE_CAPABILITY_STALE');
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
          sessionId,
          workspaceId: capability.workspaceId,
          actorUserId: capability.actorUserId,
          objective: args.objective,
          cron: args.cron
        });
        const token = this.#tokens.sign({
          ...capability,
          sessionId: created.sessionId,
          taskId: created.id,
          revision: created.revision
        });
        socket.end(`${JSON.stringify({ result: created, token })}\n`);
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
        const token = this.#tokens.sign({
          ...capability,
          revision: result.revision
        });
        this.changed(task.sessionId);
        socket.end(`${JSON.stringify({ result, token })}\n`);
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
