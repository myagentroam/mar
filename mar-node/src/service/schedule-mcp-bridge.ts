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
import { scheduleIpcFrameLimit } from './schedule-mcp-contract.js';

const capabilitySchema = z.object({
  executionId: z.string(),
  sessionId: z.string(),
  workspaceId: z.string(),
  actorUserId: z.number().int().positive()
});
type Capability = z.infer<typeof capabilitySchema>;

interface Request {
  readonly token?: unknown;
  readonly tool?: unknown;
  readonly arguments?: unknown;
}

/** Owns private schedule IPC and verifies the execution capability before dispatch. */
export class ScheduleMcpBridge {
  readonly #tokens = new McpCapabilityToken(NODE_MCP.schedule.name, capabilitySchema);
  readonly #sockets = new Set<Socket>();
  readonly #endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\mar-schedule-${process.pid}-${randomUUID()}`
      : join(tmpdir(), `mar-schedule-${process.pid}-${randomUUID()}.sock`);
  #listening?: Promise<Server>;

  constructor(
    private readonly resolveExecution: (capability: Capability) => Promise<string | undefined>,
    private readonly invoke: (
      scope: Pick<Capability, 'sessionId' | 'workspaceId' | 'actorUserId'>,
      tool: string,
      payload: unknown
    ) => Promise<unknown>
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
      allowedToolCallers: Object.fromEntries(
        Object.values(NODE_MCP.schedule.tools).map((tool) => [
          tool,
          ['direct', 'programmatic'] as const
        ])
      )
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
    socket.on('error', () => socket.destroy());
    let body = '';
    let received = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      if (received) return;
      body += chunk;
      if (body.length > scheduleIpcFrameLimit) {
        socket.destroy();
        return;
      }
      if (!body.includes('\n')) return;
      received = true;
      void this.#respond(socket, body.slice(0, body.indexOf('\n')));
    });
  }

  async #respond(socket: Socket, body: string): Promise<void> {
    try {
      const request = JSON.parse(body) as Request;
      const capability = this.#tokens.verify(request.token);
      if (capability === undefined) throw new Error('SCHEDULE_CAPABILITY_INVALID');
      const sessionId = await this.resolveExecution(capability);
      if (sessionId === undefined) throw new Error('SCHEDULE_CAPABILITY_STALE');
      if (typeof request.tool !== 'string') throw new Error('SCHEDULE_TOOL_INVALID');
      const result = await this.invoke(
        { sessionId, workspaceId: capability.workspaceId, actorUserId: capability.actorUserId },
        request.tool,
        request.arguments
      );
      socket.end(`${JSON.stringify({ result })}\n`);
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.message)
          ? error.message
          : 'SCHEDULE_IPC_FAILED';
      socket.end(`${JSON.stringify({ error: code })}\n`);
    }
  }
}

function scheduleMcpStdioArgs(): readonly string[] {
  const javascript = fileURLToPath(new URL('./schedule-mcp-stdio.js', import.meta.url));
  if (existsSync(javascript)) return [javascript];
  const typescript = fileURLToPath(new URL('./schedule-mcp-stdio.ts', import.meta.url));
  if (!existsSync(typescript)) throw new Error('SCHEDULE_MCP_STDIO_ENTRY_UNAVAILABLE');
  return ['--import', import.meta.resolve('tsx'), typescript];
}
