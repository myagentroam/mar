import type { NodeAgentSession } from '../database.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import { nodeLog } from '../operational.js';
import { isTerminalRunStatus } from '../util/node-operation-parsers.js';
import { safeErrorCode } from '../util/safe-error.js';

interface IdentityWaiter {
  readonly promise: Promise<string>;
  readonly resolve: (nativeSessionId: string) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface SessionIdentityServiceOptions {
  readonly runtime: NodeRuntimeState;
  readonly releaseAttachments?: (sessionId: string) => void;
  readonly persist: (session: NodeAgentSession, nativeSessionId: string) => void;
  readonly validateCommands: (previousId: string, nextId: string) => void;
  readonly migrateCommands: (previousId: string, nextId: string) => void;
  readonly migrateGoal: (previousId: string, nextId: string) => void;
  readonly migrateQueue: (previousId: string, nextId: string) => void;
  readonly migrateRunnerState: (previousId: string, nextId: string) => void;
  readonly emitSession: (session: NodeAgentSession) => void;
  readonly emitRun: (run: unknown) => void;
  readonly emitQueue: (sessionId: string) => void;
  readonly emitTurn: (turn: unknown) => void;
}

export class SessionIdentityService {
  readonly bootstrapIds = new Set<string>();
  private readonly waiters = new Map<string, IdentityWaiter>();
  private readonly failedBootstrapIds = new Set<string>();

  constructor(private readonly options: SessionIdentityServiceOptions) {}

  markBootstrap(sessionId: string): void {
    this.bootstrapIds.add(sessionId);
  }

  promote(sessionId: string, nativeSessionId: string): void {
    try {
      if (this.failedBootstrapIds.has(sessionId)) throw new Error('SESSION_START_FAILED');
      const current = this.options.runtime.validateSessionIdentityPromotion(
        sessionId,
        nativeSessionId
      );
      this.options.validateCommands(sessionId, nativeSessionId);
      this.options.persist(current, nativeSessionId);
    } catch (error) {
      this.reject(sessionId, error instanceof Error ? error : new Error('SESSION_START_FAILED'));
      throw error;
    }
    // No I/O or publication may interrupt the synchronous ownership migration.
    const session = this.options.runtime.promoteSessionIdentity(sessionId, nativeSessionId, {
      deferRunChanges: true
    });
    this.options.migrateGoal(sessionId, nativeSessionId);
    this.options.migrateCommands(sessionId, nativeSessionId);
    this.options.migrateQueue(sessionId, nativeSessionId);
    this.options.migrateRunnerState(sessionId, nativeSessionId);
    this.bootstrapIds.delete(sessionId);
    const waiter = this.waiters.get(sessionId);
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      this.waiters.delete(sessionId);
      waiter.resolve(nativeSessionId);
    }
    if (sessionId !== nativeSessionId) this.options.runtime.publishSessionIdentity(nativeSessionId);
    this.publish(nativeSessionId, 'session', () => this.options.emitSession(session));
    for (const run of this.options.runtime.listRunsForSession(nativeSessionId))
      this.publish(nativeSessionId, 'run', () => this.options.emitRun(run));
    this.publish(nativeSessionId, 'queue', () => this.options.emitQueue(nativeSessionId));
    for (const turn of this.options.runtime.listConversationTurns({ sessionId: nativeSessionId })
      .turns)
      this.publish(nativeSessionId, 'turn', () => this.options.emitTurn(turn));
  }

  private publish(sessionId: string, phase: string, emit: () => void): void {
    try {
      emit();
    } catch (error) {
      nodeLog('session.identity.publish.failed', {
        sessionId,
        phase,
        errorCode: safeErrorCode(error, 'SESSION_IDENTITY_PUBLICATION_FAILED')
      });
    }
  }

  wait(bootstrapSessionId: string): Promise<string> {
    const existing = this.waiters.get(bootstrapSessionId);
    if (existing !== undefined) return existing.promise;
    let resolveIdentity!: (nativeSessionId: string) => void;
    let rejectIdentity!: (error: Error) => void;
    const promise = new Promise<string>((resolve, reject) => {
      resolveIdentity = resolve;
      rejectIdentity = reject;
    });
    // Startup may still be awaiting a command or the first message when identity fails.
    void promise.catch(() => undefined);
    const timer = setTimeout(() => {
      this.reject(bootstrapSessionId, 'SESSION_NATIVE_ID_TIMEOUT');
    }, 30_000);
    timer.unref();
    this.waiters.set(bootstrapSessionId, {
      promise,
      resolve: resolveIdentity,
      reject: rejectIdentity,
      timer
    });
    return promise;
  }

  reject(sessionId: string, reason: string | Error): void {
    const bootstrap = this.bootstrapIds.has(sessionId);
    if (bootstrap) {
      this.failedBootstrapIds.add(sessionId);
      this.options.releaseAttachments?.(sessionId);
    }
    const waiter = this.waiters.get(sessionId);
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      this.waiters.delete(sessionId);
      waiter.reject(typeof reason === 'string' ? new Error(reason) : reason);
    }
    if (!bootstrap) return;
    queueMicrotask(() => {
      const session = this.options.runtime.getAgentSession(sessionId);
      if (session?.id === sessionId) {
        if (
          this.options.runtime
            .listRunsForSession(sessionId)
            .some((run) => !isTerminalRunStatus(run.status))
        )
          return;
        try {
          this.options.runtime.removeAgentSession(sessionId);
        } catch (error) {
          nodeLog('session.bootstrap.cleanup.failed', {
            sessionId,
            error: error instanceof Error ? error.message.slice(0, 512) : 'Unknown cleanup error'
          });
          return;
        }
      }
      this.bootstrapIds.delete(sessionId);
      this.failedBootstrapIds.delete(sessionId);
    });
  }

  dispose(): void {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('NODE_STOPPED'));
    }
    this.waiters.clear();
    this.bootstrapIds.clear();
    this.failedBootstrapIds.clear();
  }
}
