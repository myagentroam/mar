import type { NodeAgentSession } from '../database.js';
import { nodeLog } from '../operational.js';
import { WorkspaceDomainState } from './workspace-domain-state.js';

const WATCH_INTERVAL_MS = 30_000;
const CACHE_TTL_MS = 15_000;

export interface WorkspaceSessionServiceOptions {
  discover: (
    workspaceId: string,
    onRunnerDiscovered: (
      runner: NodeAgentSession['runner'],
      sessions: readonly NodeAgentSession[]
    ) => void
  ) => Promise<readonly NodeAgentSession[]>;
  listPage: (workspaceId: string) => Promise<unknown>;
  active: (workspaceId: string) => boolean;
  invalidate: (workspaceId: string) => void;
}

export class WorkspaceSessionService {
  private readonly cacheGenerations = new Map<string, symbol>();
  private readonly initialReads = new Map<string, Promise<readonly NodeAgentSession[]>>();
  private readonly incompleteDiscoveries = new Set<string>();
  private readonly staleDiscoveries = new Set<string>();

  constructor(
    private readonly state: WorkspaceDomainState,
    private readonly options: WorkspaceSessionServiceOptions
  ) {}

  ensureWatch(workspaceId: string): void {
    if (
      this.state.sessionWatchTimers.has(workspaceId) ||
      this.state.sessionWatchReads.has(workspaceId)
    )
      return;
    void this.runWatchCycle(workspaceId);
  }

  stopWatch(workspaceId: string): void {
    const timer = this.state.sessionWatchTimers.get(workspaceId);
    if (timer !== undefined) clearTimeout(timer);
    this.state.sessionWatchTimers.delete(workspaceId);
    this.state.sessionWatchSignatures.delete(workspaceId);
  }

  discoveryPending(workspaceId: string): boolean {
    // Partial cold batches still await native identity confirmation for the remaining Runners.
    return this.incompleteDiscoveries.has(workspaceId);
  }

  async cached(workspaceId: string): Promise<readonly NodeAgentSession[]> {
    const cached = this.state.sessionCache.get(workspaceId);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.sessions;
    let discovery = this.state.sessionCacheReads.get(workspaceId);
    if (discovery === undefined) {
      // A retired read must not regain ownership when its Workspace state is reclaimed.
      const generation = Symbol();
      this.cacheGenerations.set(workspaceId, generation);
      let resolveInitial!: (sessions: readonly NodeAgentSession[]) => void;
      let rejectInitial!: (error: unknown) => void;
      const initial = new Promise<readonly NodeAgentSession[]>((resolve, reject) => {
        resolveInitial = resolve;
        rejectInitial = reject;
      });
      if (cached === undefined) {
        this.initialReads.set(workspaceId, initial);
        this.incompleteDiscoveries.add(workspaceId);
      }
      // A cached caller does not await this promise, but failures still belong to the read.
      void initial.catch(() => undefined);
      let acceptingBatches = true;
      let batchPublished = false;
      let notifyCompletion = false;
      const publish = (sessions: readonly NodeAgentSession[], notify = true): void => {
        if (this.cacheGenerations.get(workspaceId) !== generation) return;
        const previous = this.state.sessionCache.get(workspaceId)?.sessions;
        this.state.sessionCache.set(workspaceId, {
          sessions,
          expiresAt: this.staleDiscoveries.has(workspaceId) ? 0 : Date.now() + CACHE_TTL_MS
        });
        if (
          notify &&
          previous !== undefined &&
          sessionSignature(previous) !== sessionSignature(sessions)
        )
          this.options.invalidate(workspaceId);
      };
      const read = this.options
        .discover(workspaceId, (runner, sessions) => {
          if (!acceptingBatches || this.cacheGenerations.get(workspaceId) !== generation) return;
          const previous = this.state.sessionCache.get(workspaceId)?.sessions;
          const merged = [
            ...(previous ?? []).filter((session) => session.runner !== runner),
            ...sessions
          ];
          // An empty early Runner must not turn an undiscovered Workspace into an empty list.
          if (previous === undefined && merged.length === 0) return;
          publish(merged);
          batchPublished = true;
          resolveInitial(merged);
        })
        .then((sessions) => {
          if (this.cacheGenerations.get(workspaceId) === generation)
            this.incompleteDiscoveries.delete(workspaceId);
          const previous = this.state.sessionCache.get(workspaceId)?.sessions;
          notifyCompletion =
            batchPublished ||
            (previous !== undefined && sessionSignature(previous) !== sessionSignature(sessions));
          publish(sessions, false);
          resolveInitial(sessions);
          return sessions;
        })
        .catch((error: unknown) => {
          rejectInitial(error);
          if (this.cacheGenerations.get(workspaceId) === generation) {
            nodeLog('native.session.discovery.failed', { workspaceId });
            const partial = this.state.sessionCache.get(workspaceId);
            if (partial !== undefined)
              this.state.sessionCache.set(workspaceId, { ...partial, expiresAt: 0 });
          }
          throw error;
        })
        .finally(() => {
          acceptingBatches = false;
          if (this.state.sessionCacheReads.get(workspaceId) === read) {
            this.state.sessionCacheReads.delete(workspaceId);
            // Events during discovery require a trailing refresh, even if its result is unchanged.
            if (this.staleDiscoveries.delete(workspaceId)) notifyCompletion = true;
          }
          if (this.initialReads.get(workspaceId) === initial) this.initialReads.delete(workspaceId);
          if (notifyCompletion && this.cacheGenerations.get(workspaceId) === generation)
            this.options.invalidate(workspaceId);
          if (
            !this.state.sessionCacheReads.has(workspaceId) &&
            !this.state.sessionCache.has(workspaceId) &&
            this.cacheGenerations.get(workspaceId) === generation
          )
            this.cacheGenerations.delete(workspaceId);
        });
      discovery = read;
      this.state.sessionCacheReads.set(workspaceId, discovery);
      // Later Runner failures cannot become unhandled after the first batch was returned.
      void discovery.catch(() => undefined);
    }
    if (cached !== undefined) return cached.sessions;
    return this.initialReads.get(workspaceId) ?? discovery;
  }

  clear(): void {
    for (const timer of this.state.sessionWatchTimers.values()) clearTimeout(timer);
    this.state.sessionWatchTimers.clear();
    this.state.sessionWatchSignatures.clear();
    this.state.sessionWatchReads.clear();
    this.cacheGenerations.clear();
    this.state.sessionCache.clear();
    this.state.sessionCacheReads.clear();
    this.initialReads.clear();
    this.incompleteDiscoveries.clear();
    this.staleDiscoveries.clear();
  }

  invalidate(workspaceId: string): void {
    this.invalidateCache(workspaceId);
    this.stopWatch(workspaceId);
  }

  markCacheStale(workspaceId: string): void {
    const cached = this.state.sessionCache.get(workspaceId);
    if (cached !== undefined) this.state.sessionCache.set(workspaceId, { ...cached, expiresAt: 0 });
    if (this.state.sessionCacheReads.has(workspaceId)) this.staleDiscoveries.add(workspaceId);
  }

  invalidateCache(workspaceId: string): void {
    this.cacheGenerations.delete(workspaceId);
    this.state.sessionCache.delete(workspaceId);
    this.state.sessionCacheReads.delete(workspaceId);
    this.initialReads.delete(workspaceId);
    this.incompleteDiscoveries.delete(workspaceId);
    this.staleDiscoveries.delete(workspaceId);
  }

  private async refreshWatch(workspaceId: string): Promise<void> {
    const current = this.state.sessionWatchReads.get(workspaceId);
    if (current !== undefined) return current;
    const refresh = this.performRefresh(workspaceId).finally(() =>
      this.state.sessionWatchReads.delete(workspaceId)
    );
    this.state.sessionWatchReads.set(workspaceId, refresh);
    return refresh;
  }

  private async runWatchCycle(workspaceId: string): Promise<void> {
    await this.refreshWatch(workspaceId);
    if (!this.options.active(workspaceId) || this.state.sessionWatchTimers.has(workspaceId)) return;
    const timer = setTimeout(() => {
      this.state.sessionWatchTimers.delete(workspaceId);
      void this.runWatchCycle(workspaceId);
    }, WATCH_INTERVAL_MS);
    timer.unref();
    this.state.sessionWatchTimers.set(workspaceId, timer);
  }

  private async performRefresh(workspaceId: string): Promise<void> {
    if (!this.options.active(workspaceId)) return this.stopWatch(workspaceId);
    try {
      const signature = JSON.stringify(await this.options.listPage(workspaceId));
      if (!this.options.active(workspaceId)) return this.stopWatch(workspaceId);
      const previous = this.state.sessionWatchSignatures.get(workspaceId);
      this.state.sessionWatchSignatures.set(workspaceId, signature);
      if (previous === undefined || previous === signature) return;
      this.options.invalidate(workspaceId);
    } catch {
      // The bounded interval retries without fabricating session state.
    }
  }
}

function sessionSignature(sessions: readonly NodeAgentSession[]): string {
  return JSON.stringify(
    sessions.map((session) => [
      session.id,
      session.runner,
      session.externalSessionId,
      session.nativeControl,
      session.model,
      session.effort,
      session.access,
      session.runnerTitle,
      session.customTitle,
      session.titleSource,
      session.lastActivityAt,
      session.pinnedAt,
      session.pinOrder,
      session.externalDiscovered
    ])
  );
}
