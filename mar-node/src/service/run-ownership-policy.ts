import type { NodeAgentRun, NodeQueueItem } from '../runtime-model.js';
import type { NodeRuntimeState } from '../runtime-state.js';

export function assertRunOwner(run: NodeAgentRun, requestUserId: unknown): void {
  if (Number.isSafeInteger(requestUserId) && run.initiatedByUserId !== requestUserId)
    throw new Error('RUN_OWNED_BY_ANOTHER_USER');
}

export function assertQueueItemOwner(item: NodeQueueItem, requestUserId: unknown): void {
  if (Number.isSafeInteger(requestUserId) && item.initiatedByUserId !== requestUserId)
    throw new Error('RUN_OWNED_BY_ANOTHER_USER');
}

export function assertSessionControlOwner(
  runtime: NodeRuntimeState,
  sessionId: string,
  requestUserId: unknown
): void {
  if (!Number.isSafeInteger(requestUserId)) return;
  const active = runtime.activeSessionRun(sessionId);
  if (active !== undefined) {
    assertRunOwner(active, requestUserId);
    return;
  }
  for (const itemId of runtime.sessionQueue(sessionId).itemIds) {
    const item = runtime.getQueueItem(itemId);
    if (item !== undefined) assertQueueItemOwner(item, requestUserId);
  }
}
