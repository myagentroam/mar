import { computed, readonly, ref, type ComputedRef, type DeepReadonly, type Ref } from 'vue';
import {
  workspaceFileTabIdentity,
  workspaceFileTabName,
  type WorkspaceFileOpenIntent,
  type WorkspaceFileTab,
  type WorkspaceFileTabsSnapshot
} from '../util/workspace-file-tab.js';

export interface WorkspaceFileTabService {
  readonly tabs: DeepReadonly<Ref<readonly WorkspaceFileTab[]>>;
  readonly activeTabId: DeepReadonly<Ref<number | undefined>>;
  readonly activeTab: ComputedRef<WorkspaceFileTab | undefined>;
  open(intent: WorkspaceFileOpenIntent): WorkspaceFileTab;
  activate(id: number): void;
  setQuotePane(id: number, pane: 'main' | 'aside'): void;
  move(id: number, targetIndex: number): void;
  remove(id: number): void;
  clear(): void;
  updatePath(identity: string, path: string): void;
  findByPath(path: string): readonly WorkspaceFileTab[];
  snapshot(): WorkspaceFileTabsSnapshot;
  restore(snapshot: WorkspaceFileTabsSnapshot): void;
}

export function createWorkspaceFileTabService(): WorkspaceFileTabService {
  const tabs = ref<readonly WorkspaceFileTab[]>([]);
  const activeTabId = ref<number>();
  let nextId = 0;
  const activeTab = computed(
    () => tabs.value.find((tab) => tab.id === activeTabId.value) ?? tabs.value.at(-1)
  );

  function activate(id: number): void {
    if (tabs.value.some((tab) => tab.id === id)) activeTabId.value = id;
  }

  function open(intent: WorkspaceFileOpenIntent): WorkspaceFileTab {
    const identity = workspaceFileTabIdentity(intent);
    const existing = tabs.value.find((tab) => tab.identity === identity);
    if (existing !== undefined) {
      const updated = {
        ...existing,
        quotePane: intent.quotePane ?? 'main',
        ...(intent.targetLine === undefined ? {} : { targetLine: intent.targetLine }),
        ...(intent.targetColumn === undefined ? {} : { targetColumn: intent.targetColumn })
      };
      tabs.value = tabs.value.map((tab) => (tab.id === existing.id ? updated : tab));
      activeTabId.value = existing.id;
      return updated;
    }
    const tab: WorkspaceFileTab = {
      ...intent,
      identity,
      id: ++nextId,
      fileName: workspaceFileTabName(intent.path)
    };
    tabs.value = [...tabs.value, tab];
    activeTabId.value = tab.id;
    return tab;
  }

  function move(id: number, targetIndex: number): void {
    const sourceIndex = tabs.value.findIndex((tab) => tab.id === id);
    if (sourceIndex < 0) return;
    const nextIndex = Math.max(0, Math.min(targetIndex, tabs.value.length - 1));
    if (sourceIndex === nextIndex) return;
    const next = [...tabs.value];
    const [tab] = next.splice(sourceIndex, 1);
    if (tab === undefined) return;
    next.splice(nextIndex, 0, tab);
    tabs.value = next;
  }

  function remove(id: number): void {
    const index = tabs.value.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const wasActive = activeTabId.value === id;
    tabs.value = tabs.value.filter((tab) => tab.id !== id);
    if (wasActive) activeTabId.value = tabs.value.at(index - 1)?.id ?? tabs.value.at(index)?.id;
  }

  function clear(): void {
    tabs.value = [];
    activeTabId.value = undefined;
  }

  function updatePath(identity: string, path: string): void {
    tabs.value = tabs.value.map((tab) =>
      tab.identity === identity ? { ...tab, path, fileName: workspaceFileTabName(path) } : tab
    );
  }

  function findByPath(path: string): readonly WorkspaceFileTab[] {
    return tabs.value.filter((tab) => tab.path === path);
  }

  function snapshot(): WorkspaceFileTabsSnapshot {
    return {
      tabs: tabs.value,
      ...(activeTab.value === undefined ? {} : { activeIdentity: activeTab.value.identity })
    };
  }

  function restore(snapshot: WorkspaceFileTabsSnapshot): void {
    const identities = new Set<string>();
    const restored: WorkspaceFileTab[] = [];
    let greatestId = 0;
    for (const candidate of snapshot.tabs) {
      if (identities.has(candidate.identity)) continue;
      identities.add(candidate.identity);
      restored.push(candidate);
      greatestId = Math.max(greatestId, candidate.id);
    }
    tabs.value = restored;
    nextId = greatestId;
    activeTabId.value =
      restored.find((tab) => tab.identity === snapshot.activeIdentity)?.id ?? restored.at(-1)?.id;
  }

  return {
    tabs: readonly(tabs),
    activeTabId: readonly(activeTabId),
    activeTab,
    open,
    activate,
    setQuotePane: (id, quotePane) => {
      tabs.value = tabs.value.map((tab) => (tab.id === id ? { ...tab, quotePane } : tab));
    },
    move,
    remove,
    clear,
    updatePath,
    findByPath,
    snapshot,
    restore
  };
}
