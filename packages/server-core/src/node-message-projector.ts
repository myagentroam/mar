import type { WebSocket } from 'ws';
import { watchEventSchema, workbenchEventSchema, type NodeEnvelope } from '@myagentroam/protocol';
import type { RelayedWorkbenchEvent, WorkbenchRelayService } from './workbench-relay-service.js';

interface NodeMessageProjectorOptions {
  readonly relay: WorkbenchRelayService;
  readonly send: (socket: WebSocket, type: string, payload: unknown, replyTo?: string) => void;
  readonly sendInvalid: (socket: WebSocket, replyTo?: string) => void;
  readonly notification?: (nodeId: string, payload: unknown) => Promise<boolean>;
  readonly hostedConversationActivity?: (nodeId: string, payload: unknown) => Promise<boolean>;
  readonly recentRuns?: (nodeId: string, payload: unknown) => Promise<boolean>;
  readonly sendWatchEvent?: (
    connectionId: string,
    message: object
  ) => Promise<'delivered' | 'unavailable' | 'authorization-revoked'>;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

const PROJECTED_TYPES = new Set([
  'workbench.event',
  'watch.event',
  'approval.request',
  'session.external-id',
  'session.channel.ready',
  'recent-runs'
]);

export class NodeMessageProjector {
  constructor(private readonly options: NodeMessageProjectorOptions) {}

  handles(type: string): boolean {
    return PROJECTED_TYPES.has(type);
  }

  project(nodeId: string, socket: WebSocket, envelope: NodeEnvelope): void {
    switch (envelope.type) {
      case 'workbench.event':
        this.workbenchEvent(nodeId, socket, envelope);
        return;
      case 'watch.event':
        this.watchEvent(nodeId, socket, envelope);
        return;
      case 'approval.request':
        this.approval(socket, envelope);
        return;
      case 'session.external-id':
        this.externalSessionId(socket, envelope);
        return;
      case 'session.channel.ready':
        this.channelReady(socket, envelope);
        return;
      case 'recent-runs':
        void this.options.recentRuns?.(nodeId, envelope.payload).catch(() => false);
    }
  }

  private watchEvent(nodeId: string, socket: WebSocket, envelope: NodeEnvelope): void {
    const parsed = watchEventSchema.safeParse(envelope.payload);
    if (!parsed.success || parsed.data.nodeId !== nodeId) {
      this.options.sendInvalid(socket, envelope.id);
      return;
    }
    void (
      this.options.sendWatchEvent?.(parsed.data.workbenchConnectionId, parsed.data) ??
      Promise.resolve('unavailable')
    )
      .catch(() => 'unavailable' as const)
      .then((delivery) => {
        if (parsed.data.type === 'watch.failed')
          this.options.log?.('workbench.watch.failed.relayed', {
            nodeId,
            workspaceId: parsed.data.workspaceId,
            ...(parsed.data.sessionId === undefined ? {} : { sessionId: parsed.data.sessionId }),
            workbenchConnectionId: parsed.data.workbenchConnectionId,
            watchId: parsed.data.watchId,
            watchType: parsed.data.watchType,
            code: parsed.data.code,
            delivery
          });
        this.options.send(socket, 'ack', { type: 'watch.event', delivery }, envelope.id);
      });
  }

  workbenchEvent(nodeId: string, socket: WebSocket, envelope: NodeEnvelope): void {
    const parsed = workbenchEventSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      this.options.sendInvalid(socket, envelope.id);
      return;
    }
    const event: RelayedWorkbenchEvent = { nodeId, ...parsed.data };
    this.options.send(
      socket,
      'ack',
      { type: 'workbench.event', sequence: event.sequence },
      envelope.id
    );
    if (
      event.category === 'conversation' &&
      record(event.payload) &&
      record(event.payload.event) &&
      event.payload.event.eventType === 'notification'
    ) {
      void this.options.notification?.(nodeId, event.payload.event.payload).catch(() => false);
      return;
    }
    if (
      event.category === 'hosted-conversation' &&
      record(event.payload) &&
      event.payload.kind === 'notification' &&
      record(event.payload.event) &&
      event.payload.event.eventType === 'notification'
    ) {
      void this.options.notification?.(nodeId, event.payload.event.payload).catch(() => false);
      return;
    }
    if (
      event.category === 'hosted-conversation' &&
      record(event.payload) &&
      event.payload.kind === 'activity'
    ) {
      const projection = { ...event.payload };
      delete projection.kind;
      void this.options.hostedConversationActivity?.(nodeId, projection).catch(() => false);
      return;
    }
    this.options.relay.publish(event);
  }

  private approval(socket: WebSocket, envelope: NodeEnvelope): void {
    const payload = envelope.payload as {
      runId?: unknown;
      approvalId?: unknown;
      expiresAt?: unknown;
    };
    if (
      typeof payload.runId !== 'string' ||
      (payload.approvalId !== undefined && typeof payload.approvalId !== 'string') ||
      !Number.isSafeInteger(payload.expiresAt)
    )
      return this.options.sendInvalid(socket, envelope.id);
    this.options.send(
      socket,
      'ack',
      { type: 'approval.request', approvalId: payload.approvalId },
      envelope.id
    );
  }

  private externalSessionId(socket: WebSocket, envelope: NodeEnvelope): void {
    const payload = envelope.payload as { sessionId?: unknown; externalSessionId?: unknown };
    if (typeof payload.sessionId !== 'string' || typeof payload.externalSessionId !== 'string')
      return this.options.sendInvalid(socket, envelope.id);
    this.options.send(socket, 'ack', { type: 'session.external-id' }, envelope.id);
  }

  private channelReady(socket: WebSocket, envelope: NodeEnvelope): void {
    const payload = envelope.payload as { sessionId?: unknown; token?: unknown };
    if (typeof payload.sessionId !== 'string' || typeof payload.token !== 'string')
      return this.options.sendInvalid(socket, envelope.id);
    this.options.send(socket, 'ack', { type: 'session.channel.ready' }, envelope.id);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
