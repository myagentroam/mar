import type { AgentRun, WorkspaceQueue } from '../model/workbench.js';

export type WorkspaceQueueSnapshotSource = 'event' | 'initial';

export function newestWorkspaceQueueSnapshot(
  current: WorkspaceQueue | undefined,
  next: WorkspaceQueue
): WorkspaceQueue {
  return current !== undefined && current.version >= next.version ? current : next;
}

export function reconcileWorkspaceQueueSnapshot(
  current: WorkspaceQueue | undefined,
  next: WorkspaceQueue,
  source: WorkspaceQueueSnapshotSource = 'event'
): WorkspaceQueue {
  return source === 'initial' ? next : newestWorkspaceQueueSnapshot(current, next);
}

export function projectSessionQueue(
  current: WorkspaceQueue,
  next: WorkspaceQueue,
  runs: readonly AgentRun[],
  source: WorkspaceQueueSnapshotSource = 'event'
): WorkspaceQueue {
  const activeIds = new Set(
    runs
      .filter((run) => ['STARTING', 'RUNNING', 'CANCELLING'].includes(run.status))
      .map((run) => run.clientMessageId)
  );
  const snapshot = reconcileWorkspaceQueueSnapshot(current, next, source);
  return {
    ...snapshot,
    items: snapshot.items.filter((item) => !activeIds.has(item.clientMessageId))
  };
}
