import {
  recentRunProjectionMessageSchema,
  type RecentRun,
  type RecentRunProjection
} from '@myagentroam/protocol';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { NodeRequestAuthorization } from './node-access-contracts.js';

const TTL_MS = 12 * 60 * 60_000;
const CLEANUP_INTERVAL_MS = 5 * 60_000;
const TERMINAL_LIMIT = 100;
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);

interface StoredRecentRun extends RecentRunProjection {
  readonly workspaceName?: string;
}

/** Owns the in-memory recent-run projection, its retention, and user-scoped deltas. */
export class RecentRunService {
  private lastCleanupAt = Number.NEGATIVE_INFINITY;
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly nodeQueues = new Map<string, Promise<unknown>>();
  private readonly runsBySession = new Map<string, StoredRecentRun>();
  private readonly terminalRunsByUser = new Map<number, Map<string, StoredRecentRun>>();

  constructor(
    private readonly database: { readonly raw: Pool },
    private readonly authorize: NodeRequestAuthorization,
    private readonly push: (userId: number, message: object) => void,
    private readonly now: () => number = Date.now
  ) {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
  }

  async consume(nodeId: string, value: unknown): Promise<boolean> {
    const parsed = recentRunProjectionMessageSchema.safeParse(value);
    if (!parsed.success) return false;
    return this.enqueue(nodeId, async () => {
      this.cleanup();
      if (parsed.data.kind === 'UPDATE') {
        await this.upsertAuthorized(nodeId, parsed.data.run);
        return true;
      }
      const present = new Set<string>();
      for (const run of parsed.data.runs) {
        if (await this.upsertAuthorized(nodeId, run))
          present.add(taskKey(run.userId, nodeId, run.sessionId));
      }
      this.removeMissingActive(nodeId, present);
      return true;
    });
  }

  async disconnected(nodeId: string): Promise<void> {
    await this.enqueue(nodeId, async () => {
      for (const [key, run] of this.runsBySession) {
        if (run.nodeId !== nodeId || TERMINAL.has(run.status)) continue;
        this.deleteRun(key, run);
        this.pushRemoval(run);
      }
    });
  }

  async reclassify(change: import('@myagentroam/protocol').SessionGroupChanged): Promise<void> {
    await this.enqueue(change.nodeId, async () => {
      this.cleanup();
      for (const [key, run] of this.runsBySession) {
        if (
          run.nodeId !== change.nodeId ||
          run.workspaceId !== change.workspaceId ||
          run.sessionId !== change.sessionId
        )
          continue;
        if (
          !(await this.authorize(
            run.userId,
            change.nodeId,
            'workbench.event.receive',
            change,
            change.workspaceId
          ))
        )
          continue;
        // Another Node can evict this run while authorization is pending.
        if (this.runsBySession.get(key) !== run) continue;
        const next = { ...run, sessionGroup: change.sessionGroup };
        this.storeRun(key, next);
        this.push(run.userId, { type: 'recent-run.updated', run: publicRun(next) });
      }
    });
  }

  async list(userId: number): Promise<readonly RecentRun[]> {
    this.cleanup();
    const runs: RecentRun[] = [];
    for (const run of [...this.runsBySession.values()].sort(compareRecentRuns)) {
      if (run.userId !== userId) continue;
      if (await this.authorize(userId, run.nodeId, 'workbench.event.receive', run, run.workspaceId))
        runs.push(publicRun(run));
    }
    return runs;
  }

  private async upsertAuthorized(nodeId: string, run: RecentRunProjection): Promise<boolean> {
    if (run.nodeId !== nodeId) return false;
    if (
      !(await this.authorize(run.userId, nodeId, 'workbench.event.receive', run, run.workspaceId))
    )
      return false;
    const key = taskKey(run.userId, nodeId, run.sessionId);
    const existing = this.runsBySession.get(key);
    if (existing?.runId === run.runId && existing.version > run.version) return true;
    if (existing?.runId !== run.runId && existing !== undefined && newerThan(existing, run))
      return true;
    const stored: StoredRecentRun = {
      ...run,
      ...(existing?.workspaceId === run.workspaceId && existing.workspaceName !== undefined
        ? { workspaceName: existing.workspaceName }
        : await this.workspaceName(nodeId, run.workspaceId))
    };
    // The workspace lookup may yield to a write from another Node.
    const previous = this.runsBySession.get(key);
    const evicted = this.storeRun(key, stored);
    if (previous !== undefined && (previous.runId !== run.runId || evicted === stored))
      this.pushRemoval(previous);
    if (evicted !== undefined && evicted !== stored) this.pushRemoval(evicted);
    if (evicted !== stored)
      this.push(run.userId, { type: 'recent-run.updated', run: publicRun(stored) });
    return true;
  }

  private storeRun(key: string, run: StoredRecentRun): StoredRecentRun | undefined {
    this.runsBySession.set(key, run);
    if (!TERMINAL.has(run.status)) {
      this.untrackTerminal(key, run.userId);
      return;
    }

    const terminals = this.terminalRunsByUser.get(run.userId) ?? new Map<string, StoredRecentRun>();
    this.terminalRunsByUser.set(run.userId, terminals);
    terminals.set(key, run);
    if (terminals.size <= TERMINAL_LIMIT) return;

    let oldestKey = key;
    let oldest = run;
    for (const [candidateKey, candidate] of terminals) {
      if (compareRecentRuns(candidate, oldest) < 0) continue;
      oldestKey = candidateKey;
      oldest = candidate;
    }
    this.deleteRun(oldestKey, oldest);
    return oldest;
  }

  private deleteRun(key: string, run: StoredRecentRun): void {
    this.runsBySession.delete(key);
    this.untrackTerminal(key, run.userId);
  }

  private untrackTerminal(key: string, userId: number): void {
    const terminals = this.terminalRunsByUser.get(userId);
    if (terminals === undefined) return;
    terminals.delete(key);
    if (terminals.size === 0) this.terminalRunsByUser.delete(userId);
  }

  private pushRemoval(run: StoredRecentRun): void {
    this.push(run.userId, { type: 'recent-run.removed', nodeId: run.nodeId, runId: run.runId });
  }

  private async workspaceName(
    nodeId: string,
    workspaceId: string
  ): Promise<{ readonly workspaceName?: string }> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT display_name FROM workspaces WHERE node_id=? AND workspace_id=?',
      [nodeId, workspaceId]
    );
    return rows[0]?.['display_name'] === undefined || rows[0]?.['display_name'] === null
      ? {}
      : { workspaceName: String(rows[0]['display_name']) };
  }

  private removeMissingActive(nodeId: string, present: ReadonlySet<string>): void {
    for (const [key, run] of this.runsBySession) {
      if (
        run.nodeId !== nodeId ||
        TERMINAL.has(run.status) ||
        present.has(taskKey(run.userId, nodeId, run.sessionId))
      )
        continue;
      this.deleteRun(key, run);
      this.pushRemoval(run);
    }
  }

  private cleanup(): void {
    const timestamp = this.now();
    if (timestamp - this.lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    const cutoff = timestamp - TTL_MS;
    for (const [key, run] of this.runsBySession)
      if (run.completedAt !== null && run.completedAt <= cutoff) {
        this.deleteRun(key, run);
        this.pushRemoval(run);
      }
    this.lastCleanupAt = timestamp;
  }

  private async enqueue<T>(nodeId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.nodeQueues.get(nodeId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.nodeQueues.set(nodeId, current);
    try {
      return await current;
    } finally {
      if (this.nodeQueues.get(nodeId) === current) this.nodeQueues.delete(nodeId);
    }
  }
}

function taskKey(userId: number, nodeId: string, sessionId: string): string {
  return `${userId}\0${nodeId}\0${sessionId}`;
}

function compareRecentRuns(left: RecentRunProjection, right: RecentRunProjection): number {
  return (
    right.sortAt - left.sortAt ||
    right.createdAt - left.createdAt ||
    right.runId.localeCompare(left.runId)
  );
}

function newerThan(left: RecentRunProjection, right: RecentRunProjection): boolean {
  return compareRecentRuns(left, right) < 0;
}

function publicRun(run: StoredRecentRun): RecentRun {
  const { userId: _userId, ...value } = run;
  void _userId;
  return { ...value, sessionGroup: value.sessionGroup ?? 'MAIN' };
}
