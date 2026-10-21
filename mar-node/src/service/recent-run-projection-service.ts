import type { NodeAgentSession } from '../database.js';
import type { NodeAgentRun } from '../runtime-model.js';
import type { RecentRunProjection, RecentRunProjectionMessage } from '@myagentroam/protocol';

const TERMINAL_TTL_MS = 12 * 60 * 60_000;
const CLEANUP_INTERVAL_MS = 5 * 60_000;
const TERMINAL_LIMIT = 100;

export class RecentRunProjectionService {
  private readonly runsBySession = new Map<string, RecentRunProjection>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly emit: (message: RecentRunProjectionMessage) => void,
    private readonly now: () => number = Date.now
  ) {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  record(run: NodeAgentRun, session: NodeAgentSession, userMessage?: string): void {
    if (!Number.isSafeInteger(run.initiatedByUserId) || run.initiatedByUserId === undefined) return;
    if (session.externalSessionId === null) return;
    const key = taskKey(run.initiatedByUserId, run.sessionId);
    const existing = this.runsBySession.get(key);
    const sameRun = existing?.runId === run.id;
    if (sameRun && existing.version > run.version) return;
    if (!sameRun && existing !== undefined && newerThan(existing, run)) return;
    const startedAt = (sameRun ? existing.startedAt : null) ?? run.startedAt;
    const completedAt = terminal(run.status)
      ? ((sameRun ? existing.completedAt : null) ?? run.completedAt ?? run.updatedAt)
      : null;
    const latestUserMessage =
      messagePreview(userMessage) ?? (sameRun ? existing.userMessage : undefined);
    const projection: RecentRunProjection = {
      runId: run.id,
      nodeId: run.nodeId,
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      sessionTitle: session.customTitle ?? session.runnerTitle ?? session.id,
      ...(latestUserMessage === undefined ? {} : { userMessage: latestUserMessage }),
      runner: run.runner,
      status: run.status,
      createdAt: run.createdAt,
      startedAt,
      completedAt,
      sortAt: startedAt ?? run.createdAt,
      updatedAt: run.updatedAt,
      version: run.version,
      userId: run.initiatedByUserId
    };
    this.runsBySession.set(key, projection);
    this.cleanup();
    this.emit({ kind: 'UPDATE', run: projection });
  }

  snapshot(): readonly RecentRunProjection[] {
    this.cleanup();
    return [...this.runsBySession.values()].sort(compareRecentRuns);
  }

  publishSnapshot(): void {
    this.emit({ kind: 'SNAPSHOT', runs: [...this.snapshot()] });
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
  }

  private cleanup(): void {
    const cutoff = this.now() - TERMINAL_TTL_MS;
    for (const [key, run] of this.runsBySession)
      if (run.completedAt !== null && run.completedAt <= cutoff) this.runsBySession.delete(key);
    const byUser = new Map<number, RecentRunProjection[]>();
    for (const run of this.runsBySession.values()) {
      if (run.completedAt === null) continue;
      const values = byUser.get(run.userId) ?? [];
      values.push(run);
      byUser.set(run.userId, values);
    }
    for (const values of byUser.values())
      for (const run of values.sort(compareRecentRuns).slice(TERMINAL_LIMIT))
        this.runsBySession.delete(taskKey(run.userId, run.sessionId));
  }
}

function compareRecentRuns(left: RecentRunProjection, right: RecentRunProjection): number {
  return (
    right.sortAt - left.sortAt ||
    right.createdAt - left.createdAt ||
    right.runId.localeCompare(left.runId)
  );
}

function newerThan(existing: RecentRunProjection, run: NodeAgentRun): boolean {
  return (
    existing.createdAt > run.createdAt ||
    (existing.createdAt === run.createdAt && existing.runId.localeCompare(run.id) > 0)
  );
}

function taskKey(userId: number, sessionId: string): string {
  return `${userId}\0${sessionId}`;
}

function messagePreview(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/gu, ' ');
  return normalized === undefined || normalized.length === 0 ? undefined : normalized.slice(0, 500);
}

function terminal(status: NodeAgentRun['status']): boolean {
  return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(status);
}
