import type { WorkspaceFileTabsSnapshot } from '../util/workspace-file-tab.js';

export interface DirtyTextDraft {
  readonly tabIdentity: string;
  readonly path: string;
  readonly content: string;
  readonly expectedRevision: string;
}

export interface WorkspaceFileWorkbenchSnapshot {
  readonly fileTabs: WorkspaceFileTabsSnapshot;
  readonly dirtyTextDrafts: readonly DirtyTextDraft[];
  readonly fileWindowSuspended?: boolean;
}

export interface WorkspaceFilePagePort {
  requestCloseAll(): Promise<boolean>;
  captureDirtyDrafts(): readonly unknown[];
  hasPendingSave(): boolean;
  cursorPosition(id: number): { readonly line: number; readonly column: number } | undefined;
  navigateTo(id: number, line: number, column?: number): void;
  focusPage(id: number): boolean;
}
