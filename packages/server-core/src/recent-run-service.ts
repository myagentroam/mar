import {
  recentRunProjectionMessageSchema,
  type RecentRun,
  type RecentRunProjection
} from '@myagentroam/protocol';
import type { RowDataPacket } from 'mysql2/promise';
import type { NotificationStore } from './notification-contracts.js';

const TTL_MS = 12 * 60 * 60_000;
const CLEANUP_INTERVAL_MS = 5 * 60_000;
const TERMINAL_LIMIT = 100;
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);

interface StoredRecentRun extends RecentRunProjection {
  readonly workspaceName?: string;
}

export class RecentRunService {
  private lastCleanupAt = Number.NEGATIVE_INFINITY;
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly nodeQueues = new Map<string, Promise<unknown>>();
  private readonly runsBySession = new Map<string, StoredRecentRun>();

  constructor(
    private readonly database: NotificationStore,
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
        this.runsBySession.delete(key);
        this.push(run.userId, { type: 'recent-run.removed', nodeId, runId: run.runId });
      }
    });
  }

  async list(userId: number): Promise<readonly RecentRun[]> {
    this.cleanup();
    const runs: RecentRun[] = [];
    for (const run of [...this.runsBySession.values()].sort(compareRecentRuns)) {
      if (run.userId !== userId) continue;
      if (
        await this.database.userCanRequestNode(
          userId,
          run.nodeId,
          'workbench.event.receive',
          run,
          run.workspaceId
        )
      )
        runs.push(publicRun(run));
    }
    return runs;
  }

  private async upsertAuthorized(nodeId: string, run: RecentRunProjection): Promise<boolean> {
    if (run.nodeId !== nodeId) return false;
    if (
      !(await this.database.userCanRequestNode(
        run.userId,
        nodeId,
        'workbench.event.receive',
        run,
        run.workspaceId
      ))
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
    this.runsBySession.set(key, stored);
    if (existing !== undefined && existing.runId !== run.runId)
      this.push(existing.userId, {
        type: 'recent-run.removed',
        nodeId,
        runId: existing.runId
      });
    this.push(run.userId, { type: 'recent-run.updated', run: publicRun(stored) });
    return true;
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
      this.runsBySession.delete(key);
      this.push(run.userId, { type: 'recent-run.removed', nodeId, runId: run.runId });
    }
  }

  private cleanup(): void {
    const timestamp = this.now();
    if (timestamp - this.lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    const cutoff = timestamp - TTL_MS;
    for (const [key, run] of this.runsBySession)
      if (run.completedAt !== null && run.completedAt <= cutoff) {
        this.runsBySession.delete(key);
        this.push(run.userId, { type: 'recent-run.removed', nodeId: run.nodeId, runId: run.runId });
      }
    const byUser = new Map<number, RecentRunProjection[]>();
    for (const run of this.runsBySession.values()) {
      if (run.completedAt === null) continue;
      const values = byUser.get(run.userId) ?? [];
      values.push(run);
      byUser.set(run.userId, values);
    }
    for (const values of byUser.values())
      for (const run of values.sort(compareRecentRuns).slice(TERMINAL_LIMIT)) {
        this.runsBySession.delete(taskKey(run.userId, run.nodeId, run.sessionId));
        this.push(run.userId, { type: 'recent-run.removed', nodeId: run.nodeId, runId: run.runId });
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
  return value;
}
