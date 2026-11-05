import type { AgentRun, WorkspaceQueue } from '../model/workbench.js';
import { computed, ref, type Ref } from 'vue';

export type WorkspaceQueueSnapshotSource = 'event' | 'initial';

export function createWorkspaceQueueProjection(runs: Readonly<Ref<readonly AgentRun[]>>) {
  const queue = ref<WorkspaceQueue>({ version: 0, paused: false, items: [] });
  function merge(next: WorkspaceQueue, source: WorkspaceQueueSnapshotSource = 'event'): void {
    queue.value = projectSessionQueue(queue.value, next, runs.value, source);
  }
  function reset(): void {
    queue.value = { version: 0, paused: false, items: [] };
  }
  function restore(snapshot: WorkspaceQueue): void {
    queue.value = snapshot;
  }
  return { queue: computed(() => queue.value), merge, reset, restore };
}

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
