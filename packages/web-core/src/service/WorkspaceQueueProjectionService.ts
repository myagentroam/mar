import type { WorkspaceQueue } from '../model/workbench.js';

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
