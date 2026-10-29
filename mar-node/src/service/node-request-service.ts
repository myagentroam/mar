import type { NodeEnvelope } from '@myagentroam/protocol';
import { nodeLog } from '../operational.js';
import { validUserAuthorization } from '../connection/authorization.js';
import { safePublicError } from '../util/safe-error.js';

interface NodeRequestServiceOptions {
  readonly nodeId: () => string | undefined;
  readonly databaseAvailable: () => boolean;
  readonly execute: (operation: string, data: unknown) => Promise<unknown>;
  readonly resolveMarctlCaller?: (caller: unknown, userId: number, data: unknown) => unknown;
  readonly authorizeMarctlOperation?: (
    caller: unknown,
    operation: string,
    data: unknown,
    userId: number
  ) => Promise<void>;
  readonly send: (type: string, payload: unknown, replyTo?: string) => void;
}

/** Validates and executes the closed Admin-facing Node operation envelope. */
export class NodeRequestService {
  private readonly waits = new Map<string, AbortController>();

  constructor(private readonly options: NodeRequestServiceOptions) {}

  cancelWait(requestId: string): void {
    this.waits.get(requestId)?.abort();
  }

  disconnect(): void {
    for (const controller of this.waits.values()) controller.abort();
    this.waits.clear();
  }

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
    const waiting =
      payload.operation === 'agent.network' &&
      payload.data !== null &&
      typeof payload.data === 'object' &&
      (payload.data as { action?: unknown }).action === 'wait';
    const controller = waiting ? new AbortController() : undefined;
    if (controller) this.waits.set(envelope.id, controller);
    try {
      const authorization = payload.userAuthorization as {
        userId: number;
        marctlCaller?: unknown;
        marctlExecutionResources?: unknown;
      };
      const marctlCaller =
        authorization.marctlCaller === undefined
          ? undefined
          : this.options.resolveMarctlCaller?.(
              authorization.marctlCaller,
              authorization.userId,
              payload.data
            );
      if (authorization.marctlCaller !== undefined && marctlCaller === undefined)
        throw new Error('MARCTL_EXECUTION_CREDENTIAL_INVALID');
      if (marctlCaller !== undefined) {
        if (!this.options.authorizeMarctlOperation)
          throw new Error('MARCTL_EXECUTION_CREDENTIAL_INVALID');
        await this.options.authorizeMarctlOperation(
          marctlCaller,
          payload.operation,
          payload.data,
          authorization.userId
        );
      }
      const usageGrant = (
        payload.userAuthorization as {
          usageGrant?: import('@myagentroam/protocol').ModelUsageGrant;
        }
      ).usageGrant;
      const data =
        payload.data !== null && typeof payload.data === 'object'
          ? (() => {
              const {
                __marctlCaller: _untrustedCaller,
                __usageGrant: _untrustedGrant,
                __marctlExecutionResources: _untrustedExecutionResources,
                __requestAbortSignal: _untrustedSignal,
                ...input
              } = payload.data as Record<string, unknown>;
              return {
                ...input,
                __workspaceWatchSessionHash: (payload.userAuthorization as { sessionHash: string })
                  .sessionHash,
                __requestUserId: (payload.userAuthorization as { userId: number }).userId,
                ...(marctlCaller === undefined ? {} : { __marctlCaller: marctlCaller }),
                ...(payload.operation === 'agent.network' &&
                marctlCaller !== null &&
                typeof marctlCaller === 'object' &&
                (marctlCaller as { type?: unknown }).type === 'execution' &&
                authorization.marctlExecutionResources !== null &&
                typeof authorization.marctlExecutionResources === 'object' &&
                !Array.isArray(authorization.marctlExecutionResources)
                  ? { __marctlExecutionResources: authorization.marctlExecutionResources }
                  : {}),
                ...(usageGrant === undefined ? {} : { __usageGrant: usageGrant }),
                ...(controller === undefined ? {} : { __requestAbortSignal: controller.signal })
              };
            })()
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
    } finally {
      if (controller && this.waits.get(envelope.id) === controller) this.waits.delete(envelope.id);
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
