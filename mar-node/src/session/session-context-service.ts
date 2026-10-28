import type { NodeAgentSession } from './contracts.js';
import type { RunnerRegistry } from '../runner/runner-registry.js';

const REFRESH_DELAYS_MS = [100, 400, 1_000] as const;
const CONTEXT_SNAPSHOT_TTL_MS = 30 * 60_000;

export interface SessionContextUsage {
  readonly model: string | null;
  readonly usedTokens: number;
  readonly maxTokens: number;
  readonly percentage: number;
}

export interface SessionContextReadResult {
  readonly context: SessionContextUsage | null;
  readonly pending: boolean;
}

export interface SessionContextServiceOptions {
  readonly runners: RunnerRegistry;
  readonly session: (sessionId: string) => NodeAgentSession | undefined;
  readonly stopped: () => boolean;
  readonly publish: (input: {
    sessionId: string;
    workspaceId: string;
    context: SessionContextUsage | null;
    pending: false;
  }) => void;
}

export class SessionContextService {
  private readonly snapshots = new Map<string, SessionContextUsage>();
  private readonly snapshotTimers = new Map<string, NodeJS.Timeout>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly versions = new Map<string, number>();

  constructor(private readonly options: SessionContextServiceOptions) {}

  async read(session: NodeAgentSession): Promise<SessionContextReadResult> {
    if (session.externalSessionId === null) {
      this.clearSnapshot(session.id);
      return { context: null, pending: false };
    }
    const usage = await this.options.runners.product(session.runner)?.readContextUsage(session);
    if (usage === undefined) {
      this.clearSnapshot(session.id);
      return { context: null, pending: false };
    }
    const context: SessionContextUsage = {
      model: usage.model ?? session.model,
      usedTokens: usage.usedTokens,
      maxTokens: usage.maxTokens,
      percentage: Math.round((usage.usedTokens / usage.maxTokens) * 1000) / 10
    };
    this.snapshots.set(session.id, context);
    const previousTimer = this.snapshotTimers.get(session.id);
    if (previousTimer !== undefined) clearTimeout(previousTimer);
    const timer = setTimeout(() => {
      this.snapshotTimers.delete(session.id);
      this.snapshots.delete(session.id);
    }, CONTEXT_SNAPSHOT_TTL_MS);
    timer.unref();
    this.snapshotTimers.set(session.id, timer);
    return { context, pending: false };
  }

  snapshot(sessionId: string): SessionContextUsage | null {
    return this.snapshots.get(sessionId) ?? null;
  }

  schedule(input: string | NodeAgentSession): void {
    const sessionId = typeof input === 'string' ? input : input.id;
    const projectedSession = typeof input === 'string' ? undefined : input;
    const pending = this.timers.get(sessionId);
    if (pending !== undefined) clearTimeout(pending);
    this.timers.delete(sessionId);
    const version = (this.versions.get(sessionId) ?? 0) + 1;
    this.versions.set(sessionId, version);
    let published = this.snapshots.get(sessionId);
    const attempt = (index: number): void => {
      const timer = setTimeout(() => {
        if (this.timers.get(sessionId) === timer) this.timers.delete(sessionId);
        if (!this.current(sessionId, version)) return;
        const session = this.options.session(sessionId) ?? projectedSession;
        if (session === undefined || session.externalSessionId === null) return;
        void this.read(session)
          .then(({ context }) => {
            if (!this.current(sessionId, version)) return;
            if (context === null) {
              if (published === undefined) return;
              published = undefined;
              this.options.publish({
                sessionId: session.id,
                workspaceId: session.workspaceId,
                context: null,
                pending: false
              });
            } else if (published === undefined || !sameUsage(published, context)) {
              published = context;
              this.options.publish({
                sessionId: session.id,
                workspaceId: session.workspaceId,
                context,
                pending: false
              });
            }
          })
          .catch(() => undefined)
          .finally(() => {
            if (!this.current(sessionId, version)) return;
            if (index + 1 < REFRESH_DELAYS_MS.length) attempt(index + 1);
            else this.versions.delete(sessionId);
          });
      }, REFRESH_DELAYS_MS[index]);
      this.timers.set(sessionId, timer);
      timer.unref();
    };
    attempt(0);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.snapshotTimers.values()) clearTimeout(timer);
    this.timers.clear();
    this.snapshotTimers.clear();
    this.versions.clear();
    this.snapshots.clear();
  }

  private current(sessionId: string, version: number): boolean {
    return !this.options.stopped() && this.versions.get(sessionId) === version;
  }

  private clearSnapshot(sessionId: string): void {
    const timer = this.snapshotTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.snapshotTimers.delete(sessionId);
    this.snapshots.delete(sessionId);
  }
}

function sameUsage(left: SessionContextUsage, right: SessionContextUsage): boolean {
  return (
    left.model === right.model &&
    left.usedTokens === right.usedTokens &&
    left.maxTokens === right.maxTokens &&
    left.percentage === right.percentage
  );
}
