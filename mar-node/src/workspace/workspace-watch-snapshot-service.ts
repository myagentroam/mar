import type { NodeWorkspace } from './contracts.js';
import type { WorkspaceChangeService } from './workspace-change-service.js';
import type { WorkspaceFileService } from './workspace-file-service.js';
import type { WorkspaceWatch } from './workspace-watch-service.js';
import type { WorkspaceWatchService } from './workspace-watch-service.js';

export type WorkspaceWatchTopic = 'sessions' | 'files' | 'changes' | 'sessionNavigation';

const FILES_REFRESH_INTERVAL_MS = 30_000;

export interface WorkspaceWatchSnapshotServiceOptions {
  readonly requireWorkspace: (workspaceId: unknown) => NodeWorkspace;
  readonly watch: WorkspaceWatchService;
  readonly files: WorkspaceFileService;
  readonly changes: WorkspaceChangeService;
  readonly listSessions: (
    workspaceId: string,
    sessionGroup?: import('@myagentroam/protocol').SessionGroup
  ) => Promise<unknown>;
  readonly sessionNavigation?: (
    workspaceId: string,
    query: import('@myagentroam/protocol').WorkspaceSessionNavigationQuery
  ) => Promise<unknown>;
  readonly nodeId: () => string;
  readonly emitWatchEvent: (payload: unknown) => void;
  readonly filesRefreshIntervalMs?: number;
}

/** Owns Workspace topic reads, single-flight invalidation and directed snapshot delivery. */
export class WorkspaceWatchSnapshotService {
  private readonly filePrewarmTimers = new Map<WorkspaceWatch, NodeJS.Timeout>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private readonly reads = new Map<string, Promise<unknown>>();
  private readonly signatures = new Map<string, string>();
  // Handoff only between consecutive group selections on the same page/Workspace.
  // Weak keys release the two resource payloads with their lease, not a second TTL cache.
  private readonly resourceSnapshots = new WeakMap<
    WorkspaceWatch,
    Partial<
      Record<
        'sessions' | 'files' | 'changes',
        { readonly payload: unknown; readonly revision: number }
      >
    >
  >();
  private filesRefreshTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: WorkspaceWatchSnapshotServiceOptions) {}

  async initial(
    workspace: NodeWorkspace,
    watch: WorkspaceWatch,
    previous?: WorkspaceWatch
  ): Promise<void> {
    if (watch.topics.files !== undefined) this.ensureFilesRefreshTimer();
    await Promise.all(
      this.subscribedTopics(watch).map(async (topic) => {
        const revision = this.readRevision(workspace.id, topic);
        try {
          const retained =
            topic === 'sessionNavigation' ||
            previous === undefined ||
            (topic === 'sessions' && previous.topics.sessionGroup !== watch.topics.sessionGroup)
              ? undefined
              : this.resourceSnapshots.get(previous)?.[topic];
          const payload =
            retained !== undefined &&
            retained.revision === revision &&
            !this.readActive(workspace.id, topic, watch) &&
            !this.refreshes.has(`${workspace.id}:${topic}`)
              ? retained.payload
              : await this.read(workspace, topic, watch);
          if (!this.matches(workspace.id, watch)) return;
          if (revision !== this.readRevision(workspace.id, topic)) {
            void this.invalidate(workspace.id, topic);
            return;
          }
          if (topic !== 'sessionNavigation')
            this.signatures.set(this.viewKey(workspace.id, topic, watch), signature(payload));
          this.deliver(workspace, watch, topic, payload);
        } catch {
          if (revision === this.readRevision(workspace.id, topic))
            this.fail(workspace.id, watch, topic);
          else void this.invalidate(workspace.id, topic);
        }
      })
    );
  }

  prewarmFiles(workspace: NodeWorkspace, watch: WorkspaceWatch): void {
    this.cancelFilePrewarm(watch);
    const timer = setTimeout(() => {
      this.filePrewarmTimers.delete(watch);
      const needed = () => this.matches(workspace.id, watch) && watch.prepareFiles === true;
      if (needed()) void this.options.files.prepare(workspace, needed).catch(() => undefined);
    }, 750);
    timer.unref();
    this.filePrewarmTimers.set(watch, timer);
  }

  cancelFilePrewarm(watch: WorkspaceWatch): void {
    const timer = this.filePrewarmTimers.get(watch);
    if (timer !== undefined) clearTimeout(timer);
    this.filePrewarmTimers.delete(watch);
  }

  async invalidate(workspaceId: string, topic: WorkspaceWatchTopic): Promise<void> {
    if (topic === 'sessions') void this.invalidate(workspaceId, 'sessionNavigation');
    const key = `${workspaceId}:${topic}`;
    const active = this.refreshes.get(key);
    if (active !== undefined) {
      this.dirty.add(key);
      return active;
    }
    if (this.readActive(workspaceId, topic)) this.dirty.add(key);
    const refresh = this.refresh(workspaceId, topic).catch(() => {
      for (const watch of this.subscribers(workspaceId, topic))
        this.fail(workspaceId, watch, topic);
    });
    this.refreshes.set(key, refresh);
    try {
      await refresh;
    } finally {
      if (this.refreshes.get(key) === refresh) this.refreshes.delete(key);
      // Reads can outlive their leases; they must not sustain a subscriber-free microtask loop.
      if (this.dirty.delete(key) && this.subscribers(workspaceId, topic).length > 0)
        void this.invalidate(workspaceId, topic);
    }
  }

  ensureSnapshot(workspaceId: string, topic: WorkspaceWatchTopic): Promise<void> {
    return this.refreshes.get(`${workspaceId}:${topic}`) ?? this.invalidate(workspaceId, topic);
  }

  clear(workspaceId: string): void {
    for (const [watch, timer] of this.filePrewarmTimers)
      if (watch.workspaceId === workspaceId) {
        clearTimeout(timer);
        this.filePrewarmTimers.delete(watch);
      }
    for (const key of [...this.dirty])
      if (key.startsWith(`${workspaceId}:`)) this.dirty.delete(key);
    for (const key of [...this.signatures.keys()])
      if (key.startsWith(`${workspaceId}:`)) this.signatures.delete(key);
  }

  clearAll(): void {
    for (const timer of this.filePrewarmTimers.values()) clearTimeout(timer);
    this.filePrewarmTimers.clear();
    if (this.filesRefreshTimer !== undefined) clearInterval(this.filesRefreshTimer);
    this.filesRefreshTimer = undefined;
    this.dirty.clear();
    this.signatures.clear();
  }

  private ensureFilesRefreshTimer(): void {
    if (this.filesRefreshTimer !== undefined) return;
    this.filesRefreshTimer = setInterval(() => {
      const workspaceIds = this.options.watch.activeWorkspaceIds('files');
      if (workspaceIds.length === 0) {
        if (this.filesRefreshTimer !== undefined) clearInterval(this.filesRefreshTimer);
        this.filesRefreshTimer = undefined;
        return;
      }
      for (const workspaceId of workspaceIds) void this.invalidate(workspaceId, 'files');
    }, this.options.filesRefreshIntervalMs ?? FILES_REFRESH_INTERVAL_MS);
    this.filesRefreshTimer.unref();
  }

  private async refresh(workspaceId: string, topic: WorkspaceWatchTopic): Promise<void> {
    const subscribers = this.subscribers(workspaceId, topic);
    if (subscribers.length === 0) return;
    const workspace = this.options.requireWorkspace(workspaceId);
    if (topic === 'sessionNavigation') {
      await Promise.all(
        subscribers.map(async (watch) => {
          try {
            const payload = await this.read(workspace, topic, watch);
            this.deliver(workspace, watch, topic, payload);
          } catch {
            this.fail(workspaceId, watch, topic);
          }
        })
      );
      return;
    }
    if (topic === 'changes') {
      const first = subscribers[0];
      if (first === undefined) return;
      const revision = this.readRevision(workspaceId, topic);
      let payload: unknown;
      try {
        payload = await this.read(workspace, topic, first);
      } catch (error) {
        if (revision !== this.readRevision(workspaceId, topic)) {
          void this.invalidate(workspaceId, topic);
          return;
        }
        throw error;
      }
      if (revision !== this.readRevision(workspaceId, topic)) {
        void this.invalidate(workspaceId, topic);
        return;
      }
      const activeSubscribers = subscribers.filter((watch) => this.matches(workspaceId, watch));
      if (activeSubscribers.length === 0) return;
      if (!this.changed(this.viewKey(workspaceId, topic, first), payload)) return;
      for (const watch of activeSubscribers) this.deliver(workspace, watch, topic, payload);
      return;
    }
    const views = new Map<string, WorkspaceWatch[]>();
    for (const watch of subscribers) {
      const key =
        topic === 'files'
          ? JSON.stringify(watch.topics.files)
          : (watch.topics.sessionGroup ?? 'ALL');
      views.set(key, [...(views.get(key) ?? []), watch]);
    }
    await Promise.all(
      [...views.values()].map(async (viewSubscribers) => {
        const first = viewSubscribers[0];
        if (first === undefined) return;
        try {
          const payload = await this.read(workspace, topic, first);
          const activeSubscribers = viewSubscribers.filter((watch) =>
            this.matches(workspaceId, watch)
          );
          if (activeSubscribers.length === 0) return;
          if (!this.changed(this.viewKey(workspaceId, topic, first), payload)) return;
          for (const watch of activeSubscribers) this.deliver(workspace, watch, topic, payload);
        } catch {
          for (const watch of viewSubscribers) this.fail(workspaceId, watch, topic);
        }
      })
    );
  }

  private read(
    workspace: NodeWorkspace,
    topic: WorkspaceWatchTopic,
    watch: WorkspaceWatch
  ): Promise<unknown> {
    const key = this.readKey(workspace.id, topic, watch);
    const active = this.reads.get(key);
    if (active !== undefined) return active;
    const read = (
      topic === 'sessionNavigation'
        ? this.options.sessionNavigation!(workspace.id, watch.topics.sessionNavigation!)
        : topic === 'sessions'
          ? this.options.listSessions(workspace.id, watch.topics.sessionGroup)
          : topic === 'changes'
            ? workspace.kind === 'GIT_WORKSPACE'
              ? this.options.changes.current(workspace)
              : Promise.resolve(
                  workspace.includeParentRepository === false
                    ? { workspace, changes: [], repositories: [] }
                    : null
                )
            : this.options.files.list(workspace, watch.topics.files!).then((files) => ({
                files,
                workspace: this.options.requireWorkspace(workspace.id)
              }))
    ).finally(() => {
      if (this.reads.get(key) === read) this.reads.delete(key);
    });
    this.reads.set(key, read);
    return read;
  }

  private changed(key: string, payload: unknown): boolean {
    const next = signature(payload);
    if (this.signatures.get(key) === next) return false;
    this.signatures.set(key, next);
    return true;
  }

  private readRevision(workspaceId: string, topic: WorkspaceWatchTopic): number {
    return topic === 'changes' ? this.options.changes.revision(workspaceId) : 0;
  }

  private readKey(workspaceId: string, topic: WorkspaceWatchTopic, watch: WorkspaceWatch): string {
    return topic === 'sessionNavigation'
      ? `${workspaceId}:sessionNavigation:${watch.watchId}`
      : topic === 'files'
        ? `${workspaceId}:files:${JSON.stringify(watch.topics.files)}`
        : `${workspaceId}:${topic}:${watch.topics.sessionGroup ?? 'ALL'}:${this.readRevision(workspaceId, topic)}`;
  }

  private viewKey(workspaceId: string, topic: WorkspaceWatchTopic, watch: WorkspaceWatch): string {
    return topic === 'sessionNavigation'
      ? `${workspaceId}:sessionNavigation:${watch.sessionHash}:${watch.workbenchConnectionId}`
      : topic === 'files'
        ? `${workspaceId}:files:${JSON.stringify(watch.topics.files)}`
        : `${workspaceId}:${topic}:${watch.topics.sessionGroup ?? 'ALL'}`;
  }

  private readActive(
    workspaceId: string,
    topic: WorkspaceWatchTopic,
    watch?: WorkspaceWatch
  ): boolean {
    if (watch !== undefined) return this.reads.has(this.readKey(workspaceId, topic, watch));
    return this.subscribers(workspaceId, topic).some((subscriber) =>
      this.reads.has(this.readKey(workspaceId, topic, subscriber))
    );
  }

  private subscribers(workspaceId: string, topic: WorkspaceWatchTopic): WorkspaceWatch[] {
    return this.options.watch
      .activeWatches(workspaceId)
      .filter((watch) =>
        topic === 'files'
          ? watch.topics.files !== undefined
          : topic === 'sessionNavigation'
            ? watch.topics.sessionNavigation !== undefined
            : watch.topics[topic]
      );
  }

  private subscribedTopics(watch: WorkspaceWatch): WorkspaceWatchTopic[] {
    return [
      ...(watch.topics.sessions ? (['sessions'] as const) : []),
      ...(watch.topics.sessionNavigation === undefined ? [] : (['sessionNavigation'] as const)),
      ...(watch.topics.files === undefined ? [] : (['files'] as const)),
      ...(watch.topics.changes ? (['changes'] as const) : [])
    ];
  }

  private deliver(
    workspace: NodeWorkspace,
    watch: WorkspaceWatch,
    topic: WorkspaceWatchTopic,
    payload: unknown
  ): void {
    if (!this.matches(workspace.id, watch)) return;
    if (topic !== 'sessionNavigation') {
      const snapshots = this.resourceSnapshots.get(watch) ?? {};
      snapshots[topic] = { payload, revision: this.readRevision(workspace.id, topic) };
      this.resourceSnapshots.set(watch, snapshots);
    }
    this.options.emitWatchEvent({
      type: 'watch.workspace.snapshot',
      workbenchConnectionId: watch.workbenchConnectionId,
      watchId: watch.watchId,
      nodeGeneration: watch.nodeGeneration,
      nodeId: this.options.nodeId(),
      workspaceId: workspace.id,
      topic,
      revision: this.options.watch.nextRevision(this.viewKey(workspace.id, topic, watch)),
      snapshotSequence: this.options.watch.nextSnapshotSequence(),
      expiresAt: watch.expiresAt,
      payload
    });
  }

  private fail(workspaceId: string, watch: WorkspaceWatch, topic: WorkspaceWatchTopic): void {
    if (!this.matches(workspaceId, watch)) return;
    if (topic !== 'sessionNavigation') {
      const snapshots = this.resourceSnapshots.get(watch);
      if (snapshots !== undefined) delete snapshots[topic];
    }
    this.options.emitWatchEvent({
      type: 'watch.failed',
      workbenchConnectionId: watch.workbenchConnectionId,
      watchType: 'workspace',
      watchId: watch.watchId,
      nodeGeneration: watch.nodeGeneration,
      nodeId: this.options.nodeId(),
      workspaceId,
      topic,
      code: 'WORKSPACE_WATCH_SNAPSHOT_FAILED',
      message: 'Workspace watch snapshot failed.'
    });
  }

  private matches(workspaceId: string, watch: WorkspaceWatch): boolean {
    return this.options.watch.matches(
      workspaceId,
      `${watch.sessionHash}:${watch.workbenchConnectionId}`,
      watch.watchId
    );
  }
}

function signature(payload: unknown): string {
  return JSON.stringify(payload) ?? String(payload);
}
