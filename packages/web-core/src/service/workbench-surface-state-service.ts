import { ref } from 'vue';

export interface WorkspaceSearchPanelHandle {
  focus(): Promise<void>;
  snapshot(): { readonly contentQuery: string; readonly contentUseRegex: boolean };
  restore(value: { readonly contentQuery?: unknown; readonly contentUseRegex?: unknown }): void;
}

export interface WorkspaceFilesPanelHandle {
  reveal(path: string, current?: () => boolean): Promise<void> | undefined;
}
export interface WorkspaceFileWorkbenchHandle {
  predictionAttention?(): readonly import('@myagentroam/protocol').PromptCompletionAttention[];
  openCurrentRenderedPreview(): boolean;
  downloadFile(path: string): Promise<void>;
}

export interface TerminalDockHandle {
  toggle(): Promise<void>;
  release(): Promise<void>;
}

export function createWorkbenchSurfaceStateService() {
  return {
    quickOpenFileVisible: ref(false),
    workspaceFileWorkbench: ref<WorkspaceFileWorkbenchHandle | null>(),
    terminalDocks: new Map<string, TerminalDockHandle>(),
    draftSessionOpen: ref(false),
    registrationToken: ref<string>(),
    nodeManifestLoading: ref(false)
  };
}
