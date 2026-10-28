import type { ResolvedMcpServer } from '../mcp/model.js';
import { NODE_MCP } from '../mcp/naming.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  notificationInputSchema,
  notificationChannelsRequestSchema,
  type NotificationChannelsRequest,
  type NotificationChannelsResult,
  mailNotificationRequestSchema,
  type MailNotificationRequest
} from '@myagentroam/protocol';
import type { NodeRuntimeState } from '../runtime-state.js';
import { sessionGroup } from '../session/session-presentation-service.js';

interface Capability {
  readonly sessionGroup?: import('@myagentroam/protocol').SessionGroup;
  readonly executionId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly userId: number;
  readonly source: 'MANUAL' | 'SCHEDULED';
}

export class NotificationMcpBridge {
  private readonly capabilities = new Map<string, Capability>();
  private readonly sockets = new Set<Socket>();
  private readonly endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\mar-notification-${process.pid}-${randomUUID()}`
      : join(tmpdir(), `mar-notification-${process.pid}-${randomUUID()}.sock`);
  private listening?: Promise<Server>;

  constructor(
    private readonly resolve: (capability: Capability) => Capability | undefined,
    private readonly send: (input: MailNotificationRequest) => Promise<void>,
    private readonly channels?: {
      readonly supported: () => boolean;
      readonly send: (input: NotificationChannelsRequest) => Promise<NotificationChannelsResult>;
    }
  ) {}

  async prepare(capability: Capability): Promise<ResolvedMcpServer> {
    await this.listen();
    const args = notificationMcpStdioArgs();
    const token = randomBytes(32).toString('base64url');
    const notificationChannels = this.channels?.supported() === true;
    this.capabilities.set(token, capability);
    return {
      name: NODE_MCP.notification.name,
      origin: 'BUILTIN',
      lifecycle: 'EXECUTION',
      transport: 'STDIO',
      command: process.execPath,
      args,
      environment: {
        MAR_NOTIFICATION_MCP_ENDPOINT: this.endpoint,
        MAR_NOTIFICATION_MCP_TOKEN: token,
        MAR_NOTIFICATION_MCP_CHANNELS: notificationChannels ? '1' : '0'
      },
      allowedToolCallers: {
        [NODE_MCP.notification.tools.email]: ['direct', 'programmatic'],
        ...(notificationChannels
          ? { [NODE_MCP.notification.tools.send]: ['direct', 'programmatic'] as const }
          : {})
      }
    };
  }

  revoke(executionId: string): void {
    for (const [token, capability] of this.capabilities)
      if (capability.executionId === executionId) this.capabilities.delete(token);
  }

  revokeAll(): void {
    this.capabilities.clear();
  }

  async close(): Promise<void> {
    if (this.listening === undefined) return;
    const server = await this.listening;
    this.revokeAll();
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
    for (const socket of this.sockets) socket.destroy();
    await closed;
    if (process.platform !== 'win32') await unlink(this.endpoint).catch(() => undefined);
  }

  private listen(): Promise<Server> {
    this.listening ??= new Promise((resolve, reject) => {
      const server = createServer((socket) => this.handle(socket));
      server.once('error', reject);
      server.listen(this.endpoint, () => resolve(server));
    });
    return this.listening;
  }

  private handle(socket: Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    let body = '';
    let received = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      if (received) return;
      body += chunk;
      if (body.length > 16_000) {
        socket.destroy();
        return;
      }
      if (body.includes('\n')) {
        received = true;
        void this.respond(socket, body.slice(0, body.indexOf('\n')));
      }
    });
  }

  private async respond(socket: Socket, body: string): Promise<void> {
    try {
      const request = JSON.parse(body) as Record<string, unknown>;
      const capability =
        typeof request['token'] === 'string' ? this.capabilities.get(request['token']) : undefined;
      if (capability === undefined) throw new Error('MAIL_CAPABILITY_INVALID');
      const current = this.resolve(capability);
      if (current === undefined) throw new Error('MAIL_CAPABILITY_STALE');
      if (request['tool'] === NODE_MCP.notification.tools.send) {
        if (this.channels?.supported() !== true) throw new Error('NOTIFICATION_UNSUPPORTED');
        const args = request['arguments'] as Record<string, unknown>;
        if (args === null || typeof args !== 'object' || Array.isArray(args))
          throw new Error('NOTIFICATION_INPUT_INVALID');
        const { callId, ...input } = args;
        const parsed = notificationInputSchema.safeParse(input);
        if (!parsed.success) throw new Error('NOTIFICATION_INPUT_INVALID');
        const value = notificationChannelsRequestSchema.safeParse({
          ...parsed.data,
          ...current,
          callId,
          apiVersion: 1,
          eventType: 'notification',
          kind: 'AGENT_MESSAGE',
          occurredAt: Date.now(),
          sessionTitle: current.sessionId
        });
        if (!value.success) throw new Error('NOTIFICATION_INPUT_INVALID');
        const result = await this.channels.send(value.data);
        socket.end(`${JSON.stringify({ result })}\n`);
        return;
      }
      if (request['tool'] !== NODE_MCP.notification.tools.email)
        throw new Error('MAIL_TOOL_INVALID');
      const args = request['arguments'];
      if (args === null || typeof args !== 'object' || Array.isArray(args))
        throw new Error('MAIL_INPUT_INVALID');
      const { templateId, title, recipientEmail, message, callId } = args as Record<
        string,
        unknown
      >;
      if (
        (templateId !== undefined && typeof templateId !== 'string') ||
        (title !== undefined &&
          (typeof title !== 'string' || title.length > 160 || /[\r\n]/u.test(title))) ||
        (recipientEmail !== undefined && typeof recipientEmail !== 'string') ||
        typeof message !== 'string' ||
        typeof callId !== 'string'
      )
        throw new Error('MAIL_INPUT_INVALID');
      const parsed = mailNotificationRequestSchema.safeParse({
        ...current,
        templateId: templateId ?? '',
        ...(title === undefined ? {} : { title }),
        ...(recipientEmail === undefined ? {} : { recipientEmail }),
        message,
        callId
      });
      if (!parsed.success) throw new Error('MAIL_INPUT_INVALID');
      await this.send(parsed.data);
      socket.end(`${JSON.stringify({ result: { accepted: true } })}\n`);
    } catch (error) {
      const code =
        error instanceof Error && /^(MAIL|NOTIFICATION)_[A-Z0-9_]+$/u.test(error.message)
          ? error.message
          : 'MAIL_DELIVERY_UNCERTAIN';
      socket.end(`${JSON.stringify({ error: code })}\n`);
    }
  }
}

export function resolveNotificationCapability(
  runtime: Pick<NodeRuntimeState, 'getRun' | 'getAgentSession' | 'currentExecutionId'>,
  capability: Capability
): Capability | undefined {
  const run = runtime.getRun(capability.executionId);
  const session = runtime.getAgentSession(capability.sessionId);
  if (
    run === undefined ||
    session === undefined ||
    ['SUCCEEDED', 'FAILED', 'INTERRUPTED'].includes(run.status) ||
    runtime.currentExecutionId(run.id) !== capability.executionId ||
    run.sessionId !== session.id ||
    run.workspaceId !== capability.workspaceId ||
    run.initiatedByUserId !== capability.userId ||
    (run.source === 'SCHEDULED' ? 'SCHEDULED' : 'MANUAL') !== capability.source
  )
    return undefined;
  return { ...capability, sessionId: session.id, sessionGroup: sessionGroup(session) };
}

function notificationMcpStdioArgs(): readonly string[] {
  const javascript = fileURLToPath(new URL('./notification-mcp-stdio.js', import.meta.url));
  if (existsSync(javascript)) return [javascript];
  const typescript = fileURLToPath(new URL('./notification-mcp-stdio.ts', import.meta.url));
  if (!existsSync(typescript)) throw new Error('NOTIFICATION_MCP_STDIO_ENTRY_UNAVAILABLE');
  return ['--import', import.meta.resolve('tsx'), typescript];
}
