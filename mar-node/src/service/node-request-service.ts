import type { NodeEnvelope } from '@myagentroam/protocol';
import { nodeLog } from '../operational.js';
import { validUserAuthorization } from '../connection/authorization.js';
import { safePublicError } from '../util/safe-error.js';

interface NodeRequestServiceOptions {
  readonly nodeId: () => string | undefined;
  readonly databaseAvailable: () => boolean;
  readonly execute: (operation: string, data: unknown) => Promise<unknown>;
  readonly send: (type: string, payload: unknown, replyTo?: string) => void;
}

/** Validates and executes the closed Admin-facing Node operation envelope. */
export class NodeRequestService {
  constructor(private readonly options: NodeRequestServiceOptions) {}

  async handle(envelope: NodeEnvelope): Promise<void> {
    const payload = envelope.payload as {
      operation?: unknown;
      data?: unknown;
      userAuthorization?: unknown;
    };
    if (typeof payload.operation !== 'string' || !this.options.databaseAvailable()) {
      this.sendError(envelope.id, new Error('MESSAGE_INVALID'), 'MESSAGE_INVALID');
      return;
    }
    if (
      !validUserAuthorization(
        payload.userAuthorization,
        envelope,
        payload.operation,
        this.options.nodeId()
      )
    ) {
      this.sendError(
        envelope.id,
        new Error('USER_AUTHORIZATION_REQUIRED'),
        'USER_AUTHORIZATION_REQUIRED'
      );
      return;
    }
    const startedAt = performance.now();
    try {
      const usageGrant = (
        payload.userAuthorization as {
          usageGrant?: import('@myagentroam/protocol').ModelUsageGrant;
        }
      ).usageGrant;
      const data =
        payload.data !== null && typeof payload.data === 'object'
          ? {
              ...(payload.data as Record<string, unknown>),
              __workspaceWatchSessionHash: (payload.userAuthorization as { sessionHash: string })
                .sessionHash,
              __requestUserId: (payload.userAuthorization as { userId: number }).userId,
              ...(usageGrant === undefined ? {} : { __usageGrant: usageGrant })
            }
          : payload.data;
      const result = await this.options.execute(payload.operation, data);
      this.options.send('node.response', { result }, envelope.id);
      const durationMs = Math.round(performance.now() - startedAt);
      if (durationMs >= 250)
        nodeLog('node.operation.completed', {
          nodeId: this.options.nodeId(),
          operation: payload.operation,
          requestId: envelope.id,
          durationMs
        });
    } catch (error) {
      const failure = safePublicError(error, 'INTERNAL_ERROR');
      nodeLog('node.operation.failed', {
        nodeId: this.options.nodeId(),
        operation: payload.operation,
        requestId: envelope.id,
        durationMs: Math.round(performance.now() - startedAt),
        error: failure.code,
        ...(failure.details === undefined ? {} : { errorDetails: failure.details })
      });
      this.options.send('node.response', nodeResponseFailure(failure), envelope.id);
    }
  }

  private sendError(replyTo: string, error: unknown, fallback: string): void {
    const failure = safePublicError(error, fallback);
    this.options.send('node.response', nodeResponseFailure(failure), replyTo);
  }
}

function nodeResponseFailure(failure: ReturnType<typeof safePublicError>): object {
  const { code, ...metadata } = failure;
  return { error: code, ...metadata };
}
