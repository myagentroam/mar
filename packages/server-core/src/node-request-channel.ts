import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  createEnvelope,
  nodeResponseErrorPayloadSchema,
  publicErrorMessage,
  type NodeResponseErrorPayload,
  type NodeEnvelope
} from '@myagentroam/protocol';
import { safePublicError } from './http-errors.js';

export interface UserNodeAuthorization {
  readonly usageGrant?: import('@myagentroam/protocol').ModelUsageGrant | undefined;
  readonly userId: number;
  readonly sessionHash: string;
  /** Server-only context; never forwarded as a Node credential field. */
  readonly workspaceId?: string;
}

type RequestObserver = (
  phase: 'requested' | 'completed' | 'failed',
  requestId: string,
  errorCode?: string
) => void;
interface PendingRequest {
  readonly nodeId: string;
  readonly operation: string;
  readonly startedAt: number;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly observe?: RequestObserver;
}

export class NodeRequestError extends Error {
  readonly code: string;
  readonly publicMessage: string;
  readonly publicDetails: string | undefined;
  readonly publicParameters: Readonly<Record<string, string | number>> | undefined;
  readonly upstreamRequestId: string;

  constructor(failure: NodeResponseErrorPayload, upstreamRequestId: string) {
    super(failure.error);
    this.name = 'NodeRequestError';
    this.code = failure.error;
    this.publicMessage = failure.message ?? publicErrorMessage(failure.error);
    this.publicDetails = failure.details;
    this.publicParameters = failure.parameters;
    this.upstreamRequestId = upstreamRequestId;
  }
}

/** Transport only. Callers must authorize the fixed operation before dispatch. */
export class NodeRequestChannel {
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;
  constructor(
    private readonly socketFor: (nodeId: string) => WebSocket | undefined,
    private readonly log: (event: string, fields: Record<string, unknown>) => void = () =>
      undefined,
    private readonly recordTraffic?: (bytes: number) => void
  ) {}

  request(
    nodeId: string,
    operation: string,
    data: unknown,
    user: UserNodeAuthorization,
    timeoutMs = 15_000,
    observe?: RequestObserver
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('NODE_CONTROL_CLOSED'));
    const modelImageCapability =
      operation === 'model.image.read' && user.userId === 0 && user.sessionHash === 'model-image';
    if (
      !modelImageCapability &&
      (!Number.isSafeInteger(user.userId) || user.userId <= 0 || user.sessionHash.length === 0)
    )
      return Promise.reject(new Error('USER_AUTHORIZATION_REQUIRED'));
    const socket = this.socketFor(nodeId);
    if (socket === undefined || socket.readyState !== socket.OPEN)
      return Promise.reject(new Error('NODE_OFFLINE'));
    const id = randomUUID();
    const issuedAt = Date.now();
    const startedAt = performance.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(
          id,
          new NodeRequestError(
            { error: 'NODE_REQUEST_TIMEOUT', message: publicErrorMessage('NODE_REQUEST_TIMEOUT') },
            id
          )
        );
      }, timeoutMs);
      this.pending.set(id, {
        nodeId,
        operation,
        startedAt,
        timer,
        resolve,
        reject,
        ...(observe === undefined ? {} : { observe })
      });
      try {
        observe?.('requested', id);
        const serialized = JSON.stringify(
          createEnvelope(
            'node.request',
            {
              operation,
              data,
              userAuthorization: {
                userId: user.userId,
                sessionHash: user.sessionHash,
                ...(user.usageGrant === undefined ? {} : { usageGrant: user.usageGrant }),
                nodeId,
                operation,
                requestId: id,
                issuedAt,
                expiresAt: issuedAt + Math.min(timeoutMs, 15_000)
              }
            },
            { id }
          )
        );
        this.recordTraffic?.(Buffer.byteLength(serialized));
        socket.send(serialized);
      } catch (error) {
        this.fail(id, error instanceof Error ? error : new Error('NODE_SEND_FAILED'));
      }
    });
  }

  resolve(nodeId: string, envelope: NodeEnvelope): void {
    if (envelope.type !== 'node.response' || envelope.replyTo === undefined) return;
    const id = envelope.replyTo;
    const pending = this.pending.get(id);
    if (pending === undefined || pending.nodeId !== nodeId) return;
    const payload = envelope.payload;
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload) ||
      ('error' in payload && typeof payload.error !== 'string')
    ) {
      this.fail(
        id,
        new NodeRequestError(
          { error: 'MESSAGE_INVALID', message: publicErrorMessage('MESSAGE_INVALID') },
          id
        )
      );
      return;
    }
    if ('error' in payload) {
      const parsed = nodeResponseErrorPayloadSchema.safeParse(payload);
      const failure = parsed.success
        ? parsed.data
        : { error: 'MESSAGE_INVALID', message: publicErrorMessage('MESSAGE_INVALID') };
      this.fail(id, new NodeRequestError(failure, id));
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    try {
      const durationMs = Math.round(performance.now() - pending.startedAt);
      if (durationMs >= 250)
        this.log('node.relay.request.completed', {
          nodeId,
          operation: pending.operation,
          requestId: id,
          durationMs
        });
      pending.observe?.('completed', id);
      pending.resolve('result' in payload ? payload.result : undefined);
    } catch {
      pending.reject(
        new NodeRequestError(
          { error: 'INTERNAL_ERROR', message: publicErrorMessage('INTERNAL_ERROR') },
          id
        )
      );
    }
  }

  private fail(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const failure = safePublicError(error);
    const correlated =
      error instanceof NodeRequestError
        ? error
        : new NodeRequestError(
            {
              error: failure.code,
              message: failure.message,
              ...(failure.details === undefined ? {} : { details: failure.details }),
              ...(failure.parameters === undefined ? {} : { parameters: failure.parameters })
            },
            id
          );
    try {
      const code = failure.code;
      this.log('node.relay.request.failed', {
        nodeId: pending.nodeId,
        operation: pending.operation,
        requestId: id,
        durationMs: Math.round(performance.now() - pending.startedAt),
        error: code
      });
      pending.observe?.('failed', id, code);
    } catch {
      // Observability failures must not leave requests pending or interrupt cleanup.
    } finally {
      pending.reject(correlated);
    }
  }

  rejectNode(nodeId: string, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.nodeId === nodeId) this.fail(id, error);
    }
  }

  close(): void {
    this.closed = true;
    for (const id of this.pending.keys()) this.fail(id, new Error('NODE_CONTROL_CLOSED'));
  }
}
