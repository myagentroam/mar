import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  createEnvelope,
  encodeFileRelayEnvelope,
  FILE_RELAY_MAX_FRAME_BYTES,
  FILE_RELAY_MAX_PENDING,
  isFileRelayOperation,
  restoreFileRelayBody,
  nodeResponseErrorPayloadSchema,
  publicErrorMessage,
  type NodeEnvelope
} from '@myagentroam/protocol';
import { safePublicError } from './http-errors.js';
import type { UserNodeAuthorization } from './node-access-contracts.js';
import { NodeRequestAdmissionError, NodeRequestError } from './node-request-error.js';

type RequestObserver = (
  phase: 'requested' | 'completed' | 'failed',
  requestId: string,
  errorCode?: string
) => void;
function fileOperationFor(operation: string, data: unknown) {
  return isFileRelayOperation(operation, data) ? operation : undefined;
}

interface PendingRequest {
  readonly nodeId: string;
  readonly fileSocket?: WebSocket;
  readonly fileOperation?: ReturnType<typeof fileOperationFor>;
  readonly operation: string;
  readonly startedAt: number;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly observe?: RequestObserver;
  readonly cleanupAbort?: () => void;
}

/** Transport only. Callers must authorize the fixed operation before dispatch. */
export class NodeRequestChannel {
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;
  constructor(
    private readonly socketFor: (nodeId: string) => WebSocket | undefined,
    private readonly log: (event: string, fields: Record<string, unknown>) => void = () =>
      undefined,
    private readonly recordTraffic?: (bytes: number) => void,
    private readonly fileSocketFor?: (nodeId: string) => WebSocket | undefined
  ) {}

  request(
    nodeId: string,
    operation: string,
    data: unknown,
    user: UserNodeAuthorization,
    timeoutMs = 15_000,
    observe?: RequestObserver,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new NodeRequestAdmissionError('NODE_CONTROL_CLOSED'));
    const modelResourceCapability =
      operation === 'model.resource.read' &&
      user.userId === 0 &&
      user.sessionHash === 'model-resource';
    if (
      !modelResourceCapability &&
      (!Number.isSafeInteger(user.userId) || user.userId <= 0 || user.sessionHash.length === 0)
    )
      return Promise.reject(new NodeRequestAdmissionError('USER_AUTHORIZATION_REQUIRED'));
    return this.sendRequest(nodeId, operation, data, user, timeoutMs, observe, signal);
  }

  /** Server-authored, read-only projection. No arbitrary operation or user may be supplied. */
  requestScheduledTaskIndex(
    nodeId: string,
    data: { workspaceId: string; afterTaskId?: string }
  ): Promise<unknown> {
    return this.sendRequest(
      nodeId,
      'schedule.index.list',
      data,
      { userId: 0, sessionHash: 'scheduled-task-index' },
      15_000
    );
  }

  private sendRequest(
    nodeId: string,
    operation: string,
    data: unknown,
    user: UserNodeAuthorization,
    timeoutMs: number,
    observe?: RequestObserver,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new NodeRequestAdmissionError('NODE_CONTROL_CLOSED'));
    const fileOperation = fileOperationFor(operation, data);
    const socket =
      fileOperation === undefined ? this.socketFor(nodeId) : this.fileSocketFor?.(nodeId);
    if (socket === undefined || socket.readyState !== socket.OPEN)
      return Promise.reject(
        new NodeRequestAdmissionError(fileOperation ? 'FILE_RELAY_UNAVAILABLE' : 'NODE_OFFLINE')
      );
    if (
      fileOperation &&
      ([...this.pending.values()].filter((entry) => entry.fileSocket === socket).length >=
        FILE_RELAY_MAX_PENDING ||
        socket.bufferedAmount >= FILE_RELAY_MAX_PENDING * FILE_RELAY_MAX_FRAME_BYTES)
    )
      return Promise.reject(new NodeRequestAdmissionError('FILE_RELAY_BUSY'));
    const id = randomUUID();
    const issuedAt = Date.now();
    const startedAt = performance.now();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        if (
          operation === 'agent.network' &&
          this.pending.has(id) &&
          socket.readyState === socket.OPEN
        ) {
          try {
            socket.send(JSON.stringify(createEnvelope('node.request.cancel', { requestId: id })));
          } catch {
            /* Connection is gone. */
          }
        }
      };
      const onAbort = () => {
        cancel();
        this.fail(id, new Error('NODE_REQUEST_CANCELLED'));
      };
      const timer = setTimeout(() => {
        cancel();
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
        ...(fileOperation === undefined ? {} : { fileSocket: socket, fileOperation }),
        startedAt,
        timer,
        resolve,
        reject,
        ...(observe === undefined ? {} : { observe }),
        ...(signal === undefined
          ? {}
          : { cleanupAbort: () => signal.removeEventListener('abort', onAbort) })
      });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        observe?.('requested', id);
        const envelope = createEnvelope(
          'node.request',
          {
            operation,
            data,
            userAuthorization: {
              userId: user.userId,
              sessionHash: user.sessionHash,
              ...(user.marctlCaller === undefined ? {} : { marctlCaller: user.marctlCaller }),
              ...(user.marctlExecutionResources === undefined
                ? {}
                : { marctlExecutionResources: user.marctlExecutionResources }),
              ...(user.usageGrant === undefined ? {} : { usageGrant: user.usageGrant }),
              nodeId,
              operation,
              requestId: id,
              issuedAt,
              expiresAt: issuedAt + Math.min(timeoutMs, 15_000)
            }
          },
          { id }
        );
        if (fileOperation === undefined) {
          const serialized = JSON.stringify(envelope);
          this.recordTraffic?.(Buffer.byteLength(serialized));
          socket.send(serialized);
        } else {
          const frame = encodeFileRelayEnvelope(envelope, fileOperation);
          this.recordTraffic?.(frame.byteLength);
          socket.send(frame, (error) => {
            if (error) this.fail(id, new Error('FILE_RELAY_UNAVAILABLE'));
          });
        }
      } catch (error) {
        this.fail(id, error instanceof Error ? error : new Error('NODE_SEND_FAILED'));
      }
    });
  }

  resolve(
    nodeId: string,
    envelope: NodeEnvelope,
    file?: { socket: WebSocket; bytes: Uint8Array; declaredLength: unknown }
  ): void {
    if (envelope.type !== 'node.response' || envelope.replyTo === undefined) return;
    const id = envelope.replyTo;
    const pending = this.pending.get(id);
    if (pending === undefined || pending.nodeId !== nodeId || pending.fileSocket !== file?.socket)
      return;
    if (file && pending.fileOperation)
      restoreFileRelayBody(envelope, pending.fileOperation, file.bytes, file.declaredLength);
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
      this.fail(id, new NodeRequestError(failure, id, parsed.success ? 'node' : 'transport'));
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.cleanupAbort?.();
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
    pending.cleanupAbort?.();
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

  rejectFileSocket(socket: WebSocket): void {
    for (const [id, pending] of this.pending)
      if (pending.fileSocket === socket) this.fail(id, new Error('FILE_RELAY_UNAVAILABLE'));
  }

  close(): void {
    this.closed = true;
    for (const id of this.pending.keys()) this.fail(id, new Error('NODE_CONTROL_CLOSED'));
  }
}
