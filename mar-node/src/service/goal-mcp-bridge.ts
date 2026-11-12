import type { ResolvedMcpServer } from '../mcp/model.js';
import { NODE_MCP } from '../mcp/naming.js';
import { McpCapabilityToken } from '../mcp/capability-token.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { GoalRuntime } from './goal-runtime.js';

const capabilitySchema = z.object({
  executionId: z.string(),
  sessionId: z.string(),
  goalId: z.string(),
  revision: z.number().int().nonnegative()
});
type GoalCapability = z.infer<typeof capabilitySchema>;

interface IpcRequest {
  readonly token?: unknown;
  readonly tool?: unknown;
  readonly arguments?: unknown;
}

/** Owns Goal IPC and revision validation, not Execution authorization or Session aliases. */
export class GoalMcpBridge {
  private readonly tokens = new McpCapabilityToken(NODE_MCP.goal.name, capabilitySchema);
  private readonly sockets = new Set<Socket>();
  private readonly endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\mar-goal-${process.pid}-${randomUUID()}`
      : join(tmpdir(), `mar-goal-${process.pid}-${randomUUID()}.sock`);
  private listening?: Promise<Server>;

  constructor(
    private readonly goals: GoalRuntime,
    private readonly changed: (sessionId: string) => void,
    private readonly resolveExecution: (capability: GoalCapability) => string | undefined
  ) {}

  private listen(): Promise<Server> {
    this.listening ??= new Promise((resolve, reject) => {
      const server = createServer((socket) => this.handle(socket));
      server.once('error', reject);
      server.listen(this.endpoint, () => resolve(server));
    });
    return this.listening;
  }

  async prepare(capability: GoalCapability): Promise<ResolvedMcpServer> {
    await this.listen();
    const args = goalMcpStdioArgs();
    const token = this.tokens.sign(capability);
    return {
      name: NODE_MCP.goal.name,
      origin: 'BUILTIN',
      lifecycle: 'EXECUTION',
      transport: 'STDIO',
      command: process.execPath,
      args,
      environment: {
        MAR_GOAL_MCP_ENDPOINT: this.endpoint,
        MAR_GOAL_MCP_TOKEN: token
      },
      allowedToolCallers: {
        [NODE_MCP.goal.tools.get]: ['direct', 'programmatic'],
        [NODE_MCP.goal.tools.update]: ['direct', 'programmatic']
      }
    };
  }

  async close(): Promise<void> {
    if (this.listening === undefined) return;
    const server = await this.listening;
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
    for (const socket of this.sockets) socket.destroy();
    await closed;
    if (process.platform !== 'win32') await unlink(this.endpoint).catch(() => undefined);
  }

  private handle(socket: Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    let body = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64_000) socket.destroy();
      if (!body.includes('\n')) return;
      void this.respond(socket, body.slice(0, body.indexOf('\n')));
    });
  }

  private async respond(socket: Socket, body: string): Promise<void> {
    try {
      const request = JSON.parse(body) as IpcRequest;
      const claims = this.tokens.verify(request.token);
      if (claims === undefined) throw new Error('GOAL_CAPABILITY_INVALID');
      const sessionId = this.resolveExecution(claims);
      if (sessionId === undefined) throw new Error('GOAL_CAPABILITY_STALE');
      const capability = { ...claims, sessionId };
      const current = this.current(capability);
      if (request.tool === NODE_MCP.goal.tools.get) {
        socket.end(`${JSON.stringify({ result: current })}\n`);
        return;
      }
      if (request.tool !== NODE_MCP.goal.tools.update) throw new Error('GOAL_TOOL_INVALID');
      const status =
        request.arguments !== null &&
        typeof request.arguments === 'object' &&
        'status' in request.arguments
          ? request.arguments.status
          : undefined;
      if (status !== 'completed' && status !== 'blocked') throw new Error('GOAL_STATUS_INVALID');
      const goal = this.goals.update(
        capability.sessionId,
        capability.goalId,
        capability.revision,
        status
      );
      this.changed(capability.sessionId);
      socket.end(
        `${JSON.stringify({
          result:
            goal.status === 'active'
              ? goal
              : { ...goal, elapsedWallMs: this.goals.elapsedWallMs(goal) }
        })}\n`
      );
    } catch (error) {
      socket.end(
        `${JSON.stringify({ error: error instanceof Error ? error.message : 'GOAL_IPC_FAILED' })}\n`
      );
    }
  }

  private current(capability: GoalCapability) {
    const goal = this.goals.get(capability.sessionId);
    if (
      goal === undefined ||
      goal.id !== capability.goalId ||
      goal.revision !== capability.revision
    )
      throw new Error('GOAL_CAPABILITY_STALE');
    return goal;
  }
}

function goalMcpStdioArgs(): readonly string[] {
  const javascript = fileURLToPath(new URL('./goal-mcp-stdio.js', import.meta.url));
  if (existsSync(javascript)) return [javascript];
  const typescript = fileURLToPath(new URL('./goal-mcp-stdio.ts', import.meta.url));
  if (!existsSync(typescript)) throw new Error('GOAL_MCP_STDIO_ENTRY_UNAVAILABLE');
  return ['--import', import.meta.resolve('tsx'), typescript];
}
