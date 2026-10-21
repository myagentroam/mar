import { ref } from 'vue';
import type { WorkspaceFileOpenIntent } from '../util/workspace-file-tab.js';

export interface WorkspaceInspectorHandle {
  predictionAttention?(): readonly import('@myagentroam/protocol').PromptCompletionAttention[];
  openFile(path: string, line?: number, column?: number): Promise<void>;
  openWorkspaceFileTab(intent: WorkspaceFileOpenIntent): void;
  openWorkspaceFile(
    path: string,
    line?: number,
    worktreePath?: string,
    stacked?: boolean,
    column?: number
  ): Promise<void>;
  openWorkspaceFileComparison(path: string, line?: number, column?: number): Promise<void>;
  openWorkspaceFileExternal(path: string, line?: number, column?: number): void;
  openCurrentRenderedPreview(): boolean;
  revealAndOpenWorkspaceFile(path: string, line?: number): Promise<void>;
  openChanges(): void;
  openSearch(): void;
  refreshVisibleSection(nodeId: string, workspaceId: string): void;
  snapshot(): unknown;
  restore(snapshot: unknown): void;
  restoreWorkspace(nodeId: string, workspaceId: string, snapshot: unknown): void;
}

export interface TerminalDockHandle {
  toggle(): Promise<void>;
  release(): Promise<void>;
}

export function createWorkbenchSurfaceStateService() {
  return {
    quickOpenFileVisible: ref(false),
    workspaceInspector: ref<WorkspaceInspectorHandle | null>(),
    terminalDocks: new Map<string, TerminalDockHandle>(),
    draftSessionOpen: ref(false),
    registrationToken: ref<string>(),
    nodeManifestLoading: ref(false)
  };
}
