export interface FileNavigationPosition {
  readonly tabId: number;
  readonly line?: number;
  readonly column?: number;
}

/** Owns a bounded jump history for the current file workbench. */
export function createWorkspaceFileNavigationHistoryService() {
  let entries: FileNavigationPosition[] = [];
  let index = -1;

  function record(from: FileNavigationPosition | undefined, to: FileNavigationPosition): void {
    if (from === undefined) return;
    if (index < 0) {
      entries = [from];
      index = 0;
    } else {
      entries[index] = from;
    }
    if (from.tabId === to.tabId && from.line === to.line && from.column === to.column) return;
    entries = [...entries.slice(0, index + 1), to];
    if (entries.length > 256) entries = entries.slice(-256);
    index = entries.length - 1;
  }

  function travel(direction: -1 | 1, current: FileNavigationPosition | undefined) {
    const next = index + direction;
    if (next < 0 || next >= entries.length) return undefined;
    if (current !== undefined) entries[index] = current;
    index = next;
    return entries[index];
  }

  function canTravel(direction: -1 | 1): boolean {
    return index + direction >= 0 && index + direction < entries.length;
  }

  function remove(tabId: number): void {
    const before = entries.slice(0, index + 1).filter((entry) => entry.tabId !== tabId).length;
    entries = entries.filter((entry) => entry.tabId !== tabId);
    index = Math.min(entries.length - 1, before - 1);
  }

  function clear(): void {
    entries = [];
    index = -1;
  }

  return { record, travel, canTravel, remove, clear };
}
