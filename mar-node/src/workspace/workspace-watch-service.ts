import { posix } from 'node:path';

export interface WorkspaceWatch {
  readonly workspaceId: string;
  readonly watchId: string;
  readonly sessionHash: string;
  readonly workbenchConnectionId: string;
  readonly nodeGeneration: string;
  readonly prepareFiles?: boolean;
  expiresAt: number;
  readonly topics: {
    readonly sessions: boolean;
    readonly sessionGroup?: import('@myagentroam/protocol').SessionGroup;
    readonly changes: boolean;
    readonly files:
      { readonly path: string; readonly cursor?: string; readonly limit?: number } | undefined;
  };
  timer: NodeJS.Timeout;
}

const WATCH_TTL_MS = 45_000;

export class WorkspaceWatchService {
  private readonly watches = new Map<string, Map<string, WorkspaceWatch>>();
  private readonly watchRevisions = new Map<string, number>();
  private watchSnapshotSequence = 0;

  constructor(
    private readonly onSessionWatchRequired: (workspaceId: string) => void,
    private readonly onSessionWatchUnused: (workspaceId: string) => void,
    private readonly onWorkspaceWatchUnused: (workspaceId: string) => void,
    private readonly onWatchRemoved: (watch: WorkspaceWatch) => void = () => undefined
  ) {}

  parseTopics(input: Record<string, unknown>): WorkspaceWatch['topics'] {
    if (!plain(input.topics)) throw new Error('WORKSPACE_WATCH_INVALID');
    const sessions = input.topics.sessions === true;
    const sessionGroup = input.topics.sessionGroup;
    if (sessionGroup !== undefined && sessionGroup !== 'MAIN' && sessionGroup !== 'CHILD')
      throw new Error('WORKSPACE_WATCH_INVALID');
    const changes = input.topics.changes === true;
    const rawFiles = input.topics.files;
    let files: WorkspaceWatch['topics']['files'];
    if (rawFiles !== undefined) {
      if (!plain(rawFiles) || typeof rawFiles.path !== 'string')
        throw new Error('WORKSPACE_WATCH_INVALID');
      if (
        (rawFiles.cursor !== undefined && typeof rawFiles.cursor !== 'string') ||
        (rawFiles.limit !== undefined &&
          (typeof rawFiles.limit !== 'number' ||
            !Number.isInteger(rawFiles.limit) ||
            rawFiles.limit < 1 ||
            rawFiles.limit > 200))
      )
        throw new Error('WORKSPACE_WATCH_INVALID');
      files = {
        path: normalizeViewPath(rawFiles.path),
        ...(typeof rawFiles.cursor === 'string' ? { cursor: rawFiles.cursor } : {}),
        ...(typeof rawFiles.limit === 'number' ? { limit: rawFiles.limit } : {})
      };
    }
    if (!sessions && !changes && files === undefined) throw new Error('WORKSPACE_WATCH_INVALID');
    return { sessions, changes, files, ...(sessionGroup === undefined ? {} : { sessionGroup }) };
  }

  key(input: Record<string, unknown>): string {
    return `${this.sessionHash(input)}:${this.connectionId(input)}`;
  }

  sessionHash(input: Record<string, unknown>): string {
    return typeof input.__workspaceWatchSessionHash === 'string'
      ? input.__workspaceWatchSessionHash
      : 'local-test';
  }

  connectionId(input: Record<string, unknown>): string {
    if (typeof input.workbenchConnectionId !== 'string') throw new Error('WORKSPACE_WATCH_INVALID');
    return input.workbenchConnectionId;
  }

  create(
    workspaceId: string,
    watchId: string,
    sessionHash: string,
    workbenchConnectionId: string,
    nodeGeneration: string,
    topics: WorkspaceWatch['topics'],
    prepareFiles = false
  ): WorkspaceWatch {
    const key = `${sessionHash}:${workbenchConnectionId}`;
    for (const [activeWorkspaceId, watches] of this.watches)
      if (activeWorkspaceId !== workspaceId && watches.has(key))
        this.remove(activeWorkspaceId, key);
    const previous = this.watches.get(workspaceId)?.get(key);
    const watch: WorkspaceWatch = {
      workspaceId,
      watchId,
      sessionHash,
      workbenchConnectionId,
      nodeGeneration,
      expiresAt: Date.now() + WATCH_TTL_MS,
      topics,
      prepareFiles,
      timer: undefined as unknown as NodeJS.Timeout
    };
    watch.timer = this.expiryTimer(workspaceId, key);
    const watches = this.watches.get(workspaceId) ?? new Map<string, WorkspaceWatch>();
    watches.set(key, watch);
    this.watches.set(workspaceId, watches);
    if (previous !== undefined) {
      clearTimeout(previous.timer);
      this.onWatchRemoved(previous);
      if (previous.topics.sessions && !this.topicActive(workspaceId, 'sessions'))
        this.onSessionWatchUnused(workspaceId);
    }
    if (topics.sessions) this.onSessionWatchRequired(workspaceId);
    return watch;
  }

  renew(workspaceId: string, key: string, watchId?: string): WorkspaceWatch | undefined {
    const watch = this.watches.get(workspaceId)?.get(key);
    if (watch === undefined || watch.watchId !== watchId) return undefined;
    if (watch.expiresAt <= Date.now()) {
      this.remove(workspaceId, key);
      return undefined;
    }
    clearTimeout(watch.timer);
    watch.expiresAt = Date.now() + WATCH_TTL_MS;
    watch.timer = this.expiryTimer(workspaceId, key);
    return watch;
  }

  matches(workspaceId: string, key: string, watchId: string): boolean {
    const watch = this.watches.get(workspaceId)?.get(key);
    return watch !== undefined && watch.watchId === watchId && watch.expiresAt > Date.now();
  }

  observes(workspaceId: string, sessionHash: string, connectionId: string): boolean {
    const watch = this.watches.get(workspaceId)?.get(`${sessionHash}:${connectionId}`);
    return watch !== undefined && watch.expiresAt > Date.now();
  }

  existing(workspaceId: string, key: string): WorkspaceWatch | undefined {
    const watch = this.watches.get(workspaceId)?.get(key);
    return watch !== undefined && watch.expiresAt > Date.now() ? watch : undefined;
  }

  remove(workspaceId: string, key: string): void {
    const watches = this.watches.get(workspaceId);
    const watch = watches?.get(key);
    if (watch === undefined) return;
    clearTimeout(watch.timer);
    watches?.delete(key);
    if (watches?.size === 0) this.watches.delete(workspaceId);
    this.onWatchRemoved(watch);
    if (watches?.size === 0) {
      this.clearRevisions(workspaceId);
      this.onWorkspaceWatchUnused(workspaceId);
    }
    if (!this.topicActive(workspaceId, 'sessions')) this.onSessionWatchUnused(workspaceId);
  }

  clear(workspaceId: string): void {
    const watches = this.watches.get(workspaceId);
    this.watches.delete(workspaceId);
    if (watches !== undefined)
      for (const watch of watches.values()) {
        clearTimeout(watch.timer);
        this.onWatchRemoved(watch);
      }
    this.clearRevisions(workspaceId);
    this.onSessionWatchUnused(workspaceId);
    this.onWorkspaceWatchUnused(workspaceId);
  }

  clearAll(): void {
    const workspaceIds = [...this.watches.keys()];
    const watchesByWorkspace = [...this.watches.values()];
    this.watches.clear();
    for (const watches of watchesByWorkspace)
      for (const watch of watches.values()) {
        clearTimeout(watch.timer);
        this.onWatchRemoved(watch);
      }
    this.watchRevisions.clear();
    for (const workspaceId of workspaceIds) {
      this.onSessionWatchUnused(workspaceId);
      this.onWorkspaceWatchUnused(workspaceId);
    }
  }

  nextRevision(viewKey: string): number {
    const revision = (this.watchRevisions.get(viewKey) ?? 0) + 1;
    this.watchRevisions.set(viewKey, revision);
    return revision;
  }

  nextSnapshotSequence(): number {
    this.watchSnapshotSequence += 1;
    return this.watchSnapshotSequence;
  }

  topicActive(workspaceId: string, topic: 'files' | 'changes' | 'sessions'): boolean {
    return [...(this.watches.get(workspaceId)?.values() ?? [])].some((watch) =>
      topic === 'files' ? watch.topics.files !== undefined : watch.topics[topic]
    );
  }

  activeWatches(workspaceId: string): readonly WorkspaceWatch[] {
    return [...(this.watches.get(workspaceId)?.values() ?? [])].filter(
      (watch) => watch.expiresAt > Date.now()
    );
  }

  activeWorkspaceIds(topic: 'files' | 'changes' | 'sessions'): readonly string[] {
    return [...this.watches.keys()].filter((workspaceId) => this.topicActive(workspaceId, topic));
  }

  private expiryTimer(workspaceId: string, key: string): NodeJS.Timeout {
    const timer = setTimeout(() => this.remove(workspaceId, key), WATCH_TTL_MS);
    timer.unref();
    return timer;
  }

  private clearRevisions(workspaceId: string): void {
    for (const key of [...this.watchRevisions.keys()])
      if (key.startsWith(`${workspaceId}:`)) this.watchRevisions.delete(key);
  }
}

function normalizeViewPath(value: string): string {
  const normalized = posix.normalize(value.replaceAll('\\', '/'));
  return normalized.length === 0 ? '.' : normalized;
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
