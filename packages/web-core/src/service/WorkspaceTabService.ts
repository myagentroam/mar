import { ref } from 'vue';
import type { NodeSummary, Workspace, WorkspaceTab, WorkspaceTarget } from '../model/workbench.js';

export interface WorkspaceTabControllerOptions {
  readonly maxTabs: number;
  readonly tabId: (nodeId: string, workspaceId: string) => string;
  readonly workspaceLabel: (workspace: Workspace) => string;
  readonly nodeLabel: (node: NodeSummary) => string;
  readonly onEvict: (tab: WorkspaceTab) => void;
  readonly onChange: () => void;
}

export function restoreWorkspaceTabs(
  stored: readonly WorkspaceTab[],
  maxTabs: number
): WorkspaceTab[] {
  return [
    ...stored.filter((tab) => tab.pinned === true),
    ...stored.filter((tab) => tab.pinned !== true).slice(0, maxTabs)
  ];
}

export function createWorkspaceTabService(options: WorkspaceTabControllerOptions) {
  const tabs = ref<WorkspaceTab[]>([]);
  let lastActivityAt = 0;
  const pendingRestores = new Set<string>();

  function restore(stored: readonly WorkspaceTab[]): void {
    tabs.value = restoreWorkspaceTabs(stored, options.maxTabs);
    pendingRestores.clear();
    for (const tab of tabs.value) pendingRestores.add(tab.id);
    lastActivityAt = tabs.value.reduce((latest, tab) => Math.max(latest, tab.lastActiveAt), 0);
  }

  function remember(nodeId: string, node: NodeSummary | undefined, workspace: Workspace): void {
    const id = options.tabId(nodeId, workspace.id);
    const lastActiveAt = Math.max(Date.now(), lastActivityAt + 1);
    lastActivityAt = lastActiveAt;
    const existingIndex = tabs.value.findIndex((tab) => tab.id === id);
    const next = createTab(nodeId, node, workspace, lastActivityAt);
    if (existingIndex >= 0) {
      const existing = tabs.value[existingIndex];
      const retainedLabel = node === undefined ? existing?.nodeLabel : next.nodeLabel;
      tabs.value = tabs.value.map((tab, index) =>
        index === existingIndex
          ? {
              ...tab,
              ...next,
              ...(retainedLabel === undefined ? {} : { nodeLabel: retainedLabel })
            }
          : tab
      );
      options.onChange();
      return;
    }

    const updated = [...tabs.value];
    evictOverflow(updated, options.maxTabs - 1);
    tabs.value = [...updated, next];
    options.onChange();
  }

  function evictOverflow(updated: WorkspaceTab[], limit: number, retainedId?: string): void {
    while (updated.filter((tab) => tab.pinned !== true).length > limit) {
      const candidates = updated.filter((tab) => tab.pinned !== true && tab.id !== retainedId);
      if (candidates.length === 0) return;
      const leastRecentlyUsed = candidates.reduce((candidate, tab) =>
        tab.lastActiveAt < candidate.lastActiveAt ? tab : candidate
      );
      options.onEvict(leastRecentlyUsed);
      pendingRestores.delete(leastRecentlyUsed.id);
      updated.splice(
        updated.findIndex((tab) => tab.id === leastRecentlyUsed.id),
        1
      );
    }
  }

  function rememberTarget(target: WorkspaceTarget, node: NodeSummary | undefined): void {
    const id = options.tabId(target.nodeId, target.workspaceId);
    if (tabs.value.some((tab) => tab.id === id)) {
      touch(id);
      return;
    }
    const updated = [...tabs.value];
    evictOverflow(updated, options.maxTabs - 1);
    lastActivityAt = Math.max(Date.now(), lastActivityAt + 1);
    tabs.value = [
      ...updated,
      {
        id,
        ...target,
        ...(node === undefined ? {} : { nodeLabel: options.nodeLabel(node) }),
        label: target.workspaceId,
        lastActiveAt: lastActivityAt
      }
    ];
    options.onChange();
  }

  function setPinned(tabId: string, pinned: boolean): void {
    const tab = tabs.value.find((candidate) => candidate.id === tabId);
    if (tab === undefined || (tab.pinned === true) === pinned) return;
    const next = tabs.value.filter((candidate) => candidate.id !== tabId);
    const pinnedCount = next.filter((candidate) => candidate.pinned === true).length;
    next.splice(pinnedCount, 0, { ...tab, pinned });
    evictOverflow(next, options.maxTabs, tabId);
    tabs.value = next;
    options.onChange();
  }

  function remove(tab: WorkspaceTab): void {
    pendingRestores.delete(tab.id);
    tabs.value = tabs.value.filter((candidate) => candidate.id !== tab.id);
    options.onChange();
  }

  function move(tabId: string, targetIndex: number): void {
    const sourceIndex = tabs.value.findIndex((tab) => tab.id === tabId);
    if (sourceIndex < 0 || tabs.value.length < 2) return;
    const pinnedCount = tabs.value.filter((tab) => tab.pinned === true).length;
    const boundedIndex = Math.max(0, Math.min(targetIndex, tabs.value.length - 1));
    if (sourceIndex === boundedIndex) return;
    const next = [...tabs.value];
    const [tab] = next.splice(sourceIndex, 1);
    if (tab === undefined) return;
    const pinned = boundedIndex < pinnedCount;
    const moved = (tab.pinned === true) === pinned ? tab : { ...tab, pinned };
    next.splice(boundedIndex, 0, moved);
    evictOverflow(next, options.maxTabs, tabId);
    tabs.value = next;
    options.onChange();
  }

  function removeWhere(predicate: (tab: WorkspaceTab) => boolean): void {
    const removed = tabs.value.filter(predicate);
    if (removed.length === 0) return;
    tabs.value = tabs.value.filter((tab) => !predicate(tab));
    for (const tab of removed) {
      pendingRestores.delete(tab.id);
      options.onEvict(tab);
    }
    options.onChange();
  }

  function touch(tabId: string): void {
    if (!tabs.value.some((tab) => tab.id === tabId)) return;
    lastActivityAt = Math.max(Date.now(), lastActivityAt + 1);
    tabs.value = tabs.value.map((tab) =>
      tab.id === tabId ? { ...tab, lastActiveAt: lastActivityAt } : tab
    );
    options.onChange();
  }

  function mostRecentlyUsed(excluded: ReadonlySet<string> = new Set()): WorkspaceTab | undefined {
    return tabs.value.reduce<WorkspaceTab | undefined>(
      (latest, tab) =>
        !excluded.has(tab.id) && (latest === undefined || tab.lastActiveAt > latest.lastActiveAt)
          ? tab
          : latest,
      undefined
    );
  }

  function updateLabel(nodeId: string, workspaceId: string, label: string): void {
    const id = options.tabId(nodeId, workspaceId);
    if (!tabs.value.some((tab) => tab.id === id)) return;
    tabs.value = tabs.value.map((tab) => (tab.id === id ? { ...tab, label } : tab));
    options.onChange();
  }

  function createTab(
    nodeId: string,
    node: NodeSummary | undefined,
    workspace: Workspace,
    lastActiveAt: number
  ): WorkspaceTab {
    return {
      id: options.tabId(nodeId, workspace.id),
      nodeId,
      ...(node === undefined ? {} : { nodeLabel: options.nodeLabel(node) }),
      workspaceId: workspace.id,
      label: options.workspaceLabel(workspace),
      lastActiveAt
    };
  }

  function rememberSession(nodeId: string, workspaceId: string, sessionId?: string): void {
    const id = options.tabId(nodeId, workspaceId);
    const tab = tabs.value.find((candidate) => candidate.id === id);
    if (tab === undefined || tab.selectedSessionId === sessionId) return;
    tabs.value = tabs.value.map((candidate) => {
      if (candidate.id !== id) return candidate;
      const next = { ...candidate };
      delete next.selectedSessionId;
      return sessionId === undefined ? next : { ...next, selectedSessionId: sessionId };
    });
    options.onChange();
  }

  function takeRestoredSelection(nodeId: string, workspaceId: string): WorkspaceTab | undefined {
    const id = options.tabId(nodeId, workspaceId);
    const tab = tabs.value.find((tab) => tab.id === id);
    if (pendingRestores.delete(id) || tab?.selectedSessionId !== undefined) return tab;
    return undefined;
  }

  return {
    tabs,
    remember,
    rememberTarget,
    rememberSession,
    takeRestoredSelection,
    remove,
    move,
    setPinned,
    touch,
    mostRecentlyUsed,
    removeWhere,
    updateLabel,
    restore
  };
}
