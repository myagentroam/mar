import { ref } from 'vue';

export function createWorkspaceSessionPagingService(pageSize: number) {
  const visibleLimits = ref(new Map<string, number>());
  const nextCursors = ref(new Map<string, string | null>());
  const loadMoreErrors = ref(new Map<string, unknown>());
  const loadingMore = ref(false);

  function initialize(tabId: string): void {
    if (!visibleLimits.value.has(tabId)) visibleLimits.value.set(tabId, pageSize);
  }

  function reset(tabId: string): void {
    visibleLimits.value.set(tabId, pageSize);
    nextCursors.value.delete(tabId);
    loadMoreErrors.value.delete(tabId);
  }

  function append(tabId: string, count: number, cursor: string | null): void {
    loadMoreErrors.value.delete(tabId);
    nextCursors.value.set(tabId, cursor);
    visibleLimits.value.set(tabId, (visibleLimits.value.get(tabId) ?? pageSize) + count);
  }

  function remove(tabId: string): void {
    visibleLimits.value.delete(tabId);
    nextCursors.value.delete(tabId);
    loadMoreErrors.value.delete(tabId);
  }

  function removeNode(nodeId: string): void {
    for (const tabId of visibleLimits.value.keys())
      if (tabId.startsWith(`${nodeId}:`)) visibleLimits.value.delete(tabId);
    for (const tabId of nextCursors.value.keys())
      if (tabId.startsWith(`${nodeId}:`)) nextCursors.value.delete(tabId);
    for (const tabId of loadMoreErrors.value.keys())
      if (tabId.startsWith(`${nodeId}:`)) loadMoreErrors.value.delete(tabId);
  }

  function ensureVisible(tabId: string, index: number): void {
    const current = visibleLimits.value.get(tabId) ?? pageSize;
    if (index >= current) visibleLimits.value.set(tabId, index + 1);
  }

  return {
    visibleLimits,
    nextCursors,
    loadMoreErrors,
    loadingMore,
    initialize,
    reset,
    append,
    remove,
    removeNode,
    ensureVisible
  };
}
