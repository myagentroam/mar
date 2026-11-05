import type {
  WorkspaceFileWorkbenchHandle,
  WorkspaceFilePagePort
} from '../model/workspace-file-workbench.js';
import type { WorkspaceFileOpenIntent, WorkspaceFileTab } from '../util/workspace-file-tab.js';
import { computed, ref, shallowRef, watch, type Ref, type WatchStopHandle } from 'vue';
import type { Workspace, WorkspaceTarget } from '../model/workbench.js';
import {
  createWorkspaceFileOperationService,
  filePageWorkspace,
  isFilePage
} from './workspace-file-operation-service.js';
import {
  createWorkspaceFilesController,
  workspaceFileTreeRootName
} from './workspace-files-controller.js';
import { workspaceTabLabel } from '../util/workbench-presentation.js';
import { createWorkspaceGitService, type WorkspaceGitSnapshot } from './workspace-git-service.js';
import {
  createWorkspaceContentSearchService,
  type WorkspaceContentSearchSnapshot
} from './workspace-content-search-service.js';
import type {
  WorkspaceFileTreeSnapshot,
  WorkspaceFileTreeWorkspace
} from './workspace-file-tree-service.js';
import type { ChangeEntry, HistoryCommit, HistoryFile } from '../model/workspace-git.js';
export interface WorkspaceSearchPanelHandle {
  focus(): Promise<void>;
  snapshot(): { readonly contentQuery: string; readonly contentUseRegex: boolean };
  restore(value: { readonly contentQuery?: unknown; readonly contentUseRegex?: unknown }): void;
}
export interface WorkspaceFilesPanelHandle {
  reveal(path: string, current?: () => boolean): Promise<void> | undefined;
}
import type { createWorkspaceViewCacheService } from './workspace-view-cache-service.js';
import type { ScopedHttpService } from './scoped-http-service.js';
import type { MessageFeedback } from '../model/message-feedback.js';
import { errorCode } from '../util/api-error.js';
import { translate } from './locale-preference-service.js';
import type { createWorkspaceFileWorkbenchController } from './workspace-file-workbench-controller.js';
import { loadToolChangeDiff } from './tool-change-review-service.js';

export interface WorkspaceWatchSnapshot {
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly files?: unknown;
  readonly filesWatchRevision?: number;
  readonly changes?: unknown;
  readonly changesWatchRevision?: number;
}

export function mergeWorkspaceWatchSnapshot(
  current: WorkspaceWatchSnapshot | undefined,
  nodeId: string,
  workspaceId: string,
  snapshot: { readonly files?: unknown; readonly changes?: unknown },
  update?: {
    readonly topic: 'sessions' | 'files' | 'changes';
    readonly revision: number;
  }
): WorkspaceWatchSnapshot {
  const previous =
    current?.nodeId === nodeId && current.workspaceId === workspaceId ? current : undefined;
  // The Watch service already filters stale events. Node revisions can restart with a new Watch.
  return {
    ...previous,
    nodeId,
    workspaceId,
    ...(snapshot.files === undefined
      ? {}
      : {
          files: snapshot.files,
          ...(update?.topic === 'files'
            ? { filesWatchRevision: (previous?.filesWatchRevision ?? 0) + 1 }
            : {})
        }),
    ...(snapshot.changes === undefined
      ? {}
      : {
          changes: snapshot.changes,
          ...(update?.topic === 'changes'
            ? { changesWatchRevision: (previous?.changesWatchRevision ?? 0) + 1 }
            : {})
        })
  };
}

export function createWorkspaceFileToolsController(input: {
  target: Readonly<Ref<WorkspaceTarget | undefined>>;
  http: ScopedHttpService;
  workspacePath: () => string | undefined;
  workspaceKind: () => string | undefined;
  workbench: Pick<
    ReturnType<typeof createWorkspaceFileWorkbenchController>,
    'invalidateDeletedSelection' | 'openToolIntent'
  >;
  updateBranch: (workspaceId: string, branch: string | null) => void;
  queueUploads: Parameters<typeof createWorkspaceFilesController>[0]['queue'];
  notice: MessageFeedback;
  errorMessage: (error: unknown) => string;
  cache: () => Pick<
    ReturnType<typeof createWorkspaceViewCacheService>,
    'isActive' | 'updateSearch' | 'view'
  >;
  ready: () => boolean;
  visible: () => boolean;
  activeTool: () => string | undefined;
  searchReady: () => boolean;
  historySupported: () => boolean;
  isGit: () => boolean;
  workspace: () => Workspace | undefined;
  updateWorkspace: (nodeId: string, workspace: WorkspaceFileTreeWorkspace) => void;
}) {
  const filesPanel = shallowRef<WorkspaceFilesPanelHandle>();
  const rootName = computed(() => {
    const workspace = input.workspace();
    return workspaceFileTreeRootName(
      workspace?.path,
      workspace === undefined ? '' : workspaceTabLabel(workspace)
    );
  });
  const reportFailure = (error: unknown, action: string) =>
    input.notice(
      translate('generated.workspaceInspector.unableToLoad', {
        value0: action,
        value1: input.errorMessage(error)
      }),
      'error',
      error
    );
  const operations = createWorkspaceFileOperationService({
    http: input.http,
    onWritten: async (_target, current) => {
      if (current?.() === false) return;
      await files.refresh();
      if (current?.() !== false && input.isGit()) await git.loadChanges();
    }
  });
  const git = createWorkspaceGitService({
    http: input.http,
    target: () => (input.ready() ? input.target.value : undefined),
    gitEnabled: input.isGit,
    workspacePath: input.workspacePath,
    historyEnabled: () => input.isGit() && input.historySupported(),
    onWorkspace: (workspace) => input.updateWorkspace(input.target.value?.nodeId ?? '', workspace),
    onBranch: input.updateBranch,
    onFailure: (error, operation) => {
      if (operation === 'RESTORE')
        reportFailure(error, translate('generated.workspaceInspector.revertingChanges'));
    }
  });
  const files = createWorkspaceFilesController({
    target: () => (input.ready() ? input.target.value : undefined),
    workspaceName: () => rootName.value,
    list: operations.list,
    onWorkspace: (workspace) => input.updateWorkspace(input.target.value?.nodeId ?? '', workspace),
    onDeletedSelection: () => input.workbench.invalidateDeletedSelection(),
    onRevealSelection: async (path, current) => {
      await filesPanel.value?.reveal(path, current);
    },
    onMutationFailure: (error, context, target, path) =>
      reportFailure(
        error,
        `${translate(context === 'move' ? 'generated.workspaceInspector.movingFile' : 'generated.workspaceInspector.fileOperation')} (${target.nodeId}/${target.workspaceId}: ${path})`
      ),
    mutate: operations.mutate,
    revealLocal: operations.reveal,
    preflight: operations.preflight,
    queue: input.queueUploads,
    onFailure: (error) =>
      reportFailure(error, translate('generated.workspaceInspector.uploadPreflight'))
  });
  const search = createWorkspaceContentSearchService({
    http: input.http,
    onFailure: (error) => {
      if (errorCode(error) === 'CAPABILITY_UNAVAILABLE')
        reportFailure(error, translate('generated.workspaceInspector.contentSearch'));
    }
  });
  const filesRevision = ref(0);
  const changesRevision = ref(0);
  const watchSnapshot = ref<WorkspaceWatchSnapshot>();
  const searchPanel = shallowRef<WorkspaceSearchPanelHandle>();
  let appliedFilesRevision = -1;
  let pendingGit: WorkspaceGitSnapshot | undefined;
  function applyWatch(): void {
    const snapshot = watchSnapshot.value;
    const target = input.target.value;
    if (
      snapshot === undefined ||
      target === undefined ||
      snapshot.nodeId !== target.nodeId ||
      snapshot.workspaceId !== target.workspaceId
    )
      return;
    const revision = snapshot.filesWatchRevision;
    if (
      isFilePage(snapshot.files) &&
      (revision === undefined
        ? appliedFilesRevision < 0
        : Number.isInteger(revision) && revision > appliedFilesRevision)
    ) {
      files.tree.applyRootPage(snapshot.files.files);
      const workspace = filePageWorkspace(snapshot.files.workspace);
      if (workspace !== undefined) input.updateWorkspace(target.nodeId, workspace);
      appliedFilesRevision = revision === undefined || !Number.isInteger(revision) ? 0 : revision;
    }
    if (snapshot.changes !== undefined)
      git.applyWatch(snapshot.changes, snapshot.changesWatchRevision);
  }
  const stopWatchSnapshot = watch(watchSnapshot, applyWatch);
  let surfaceStops: WatchStopHandle[] = [];
  function mountSurface(): void {
    if (surfaceStops.length > 0) return;
    const filesVisible = computed(
      () => input.visible() && input.ready() && input.activeTool() === 'files'
    );
    const searchVisible = computed(
      () =>
        input.visible() && input.ready() && input.searchReady() && input.activeTool() === 'search'
    );
    const historyVisible = computed(
      () =>
        input.visible() &&
        input.ready() &&
        input.isGit() &&
        input.historySupported() &&
        input.activeTool() === 'history'
    );
    const loadVisibleGitTool = () => {
      if (!input.visible() || !input.ready()) return;
      if (input.activeTool() === 'changes') void git.loadChanges(true);
      else if (historyVisible.value) void git.openHistory();
    };
    surfaceStops = [
      watch(
        [filesVisible, () => input.target.value?.nodeId, () => input.target.value?.workspaceId],
        ([visible, nodeId, workspaceId], [wasVisible, oldNodeId, oldWorkspaceId]) => {
          if (wasVisible && !visible && nodeId === oldNodeId && workspaceId === oldWorkspaceId)
            files.invalidate();
          if (visible && (!wasVisible || nodeId !== oldNodeId || workspaceId !== oldWorkspaceId))
            void files.requestRefresh();
        },
        { flush: 'sync' }
      ),
      watch(filesRevision, () => {
        if (filesVisible.value) void files.requestRefresh();
      }),
      watch(
        searchVisible,
        (visible, previous) => {
          if (previous && !visible) search.cancelPending();
        },
        { flush: 'sync' }
      ),
      watch(
        historyVisible,
        (visible, previous) => {
          if (previous && !visible) git.cancelHistoryPending();
        },
        { flush: 'sync' }
      ),
      watch(
        [
          input.visible,
          input.ready,
          () => input.target.value?.nodeId,
          () => input.target.value?.workspaceId,
          input.isGit,
          input.historySupported,
          input.activeTool
        ],
        loadVisibleGitTool,
        { flush: 'post' }
      ),
      watch(changesRevision, () => {
        if (input.visible() && input.activeTool() === 'changes') void git.loadChanges();
      })
    ];
    loadVisibleGitTool();
    if (filesVisible.value) void files.requestRefresh();
  }
  function unmountSurface(): void {
    surfaceStops.forEach((stop) => stop());
    surfaceStops = [];
  }
  function acceptWatch(
    nodeId: string,
    workspaceId: string,
    snapshot: { readonly files?: unknown; readonly changes?: unknown },
    update: { readonly topic: 'sessions' | 'files' | 'changes'; readonly revision: number }
  ): void {
    watchSnapshot.value = mergeWorkspaceWatchSnapshot(
      watchSnapshot.value,
      nodeId,
      workspaceId,
      snapshot,
      update
    );
  }
  function resetTarget(): void {
    pendingGit = undefined;
    appliedFilesRevision = -1;
  }
  function restorePendingGit(): void {
    if (pendingGit === undefined || !input.ready() || !input.isGit()) return;
    const snapshot = pendingGit;
    pendingGit = undefined;
    applyWatch();
    git.restore(snapshot);
  }
  function restoreFiles(snapshot: WorkspaceFileTreeSnapshot | undefined): void {
    if (snapshot === undefined) files.resetTree();
    else files.restoreTree(snapshot);
    files.tree.setRootName(rootName.value);
    appliedFilesRevision = -1;
    applyWatch();
  }
  function restoreGit(snapshot: WorkspaceGitSnapshot | undefined): void {
    pendingGit = snapshot;
    if (snapshot !== undefined) restorePendingGit();
  }
  function refreshAfterWrite(): void {
    void files.requestRefresh();
    if (input.isGit()) void git.loadChanges();
  }
  function activateTarget(): void {
    resetTarget();
    files.invalidate();
    files.resetTree();
    git.reset();
    search.reset();
    searchPanel.value?.restore({});
  }
  function setSearchPanel(panel: WorkspaceSearchPanelHandle | null): void {
    const previous = searchPanel.value;
    if (previous === panel) return;
    const target = input.target.value;
    const cache = input.cache();
    if (
      previous !== undefined &&
      target !== undefined &&
      cache.isActive(target.nodeId, target.workspaceId)
    )
      cache.updateSearch(target.nodeId, target.workspaceId, {
        ...search.snapshot(),
        ...previous.snapshot()
      });
    searchPanel.value = panel ?? undefined;
    if (panel !== null && target !== undefined)
      panel.restore(cache.view(target.nodeId, target.workspaceId).search ?? {});
  }
  function searchSnapshot(
    previous?: WorkspaceContentSearchSnapshot
  ): WorkspaceContentSearchSnapshot {
    return {
      ...search.snapshot(),
      ...(searchPanel.value?.snapshot() ??
        (previous === undefined
          ? {}
          : {
              ...(previous.contentQuery === undefined
                ? {}
                : { contentQuery: previous.contentQuery }),
              ...(previous.contentUseRegex === undefined
                ? {}
                : { contentUseRegex: previous.contentUseRegex })
            }))
    };
  }
  function restoreSearch(snapshot?: WorkspaceContentSearchSnapshot): void {
    search.restore(snapshot ?? {});
    searchPanel.value?.restore(snapshot ?? {});
  }
  function focusSearch(): void {
    void searchPanel.value?.focus();
  }
  function suspendFiles(): void {
    files.invalidate();
    files.invalidateTree();
  }
  const stopRootName = watch(rootName, (name) => files.tree.setRootName(name));
  const stopTarget = watch(
    () => [input.target.value?.nodeId, input.target.value?.workspaceId] as const,
    ([nodeId, workspaceId], [oldNodeId, oldWorkspaceId]) => {
      if (nodeId === oldNodeId && workspaceId === oldWorkspaceId) return;
      activateTarget();
    },
    { flush: 'sync' }
  );
  const stopReadiness = watch(
    [input.ready, input.workspaceKind],
    ([ready, kind], [wasReady, oldKind]) => {
      if (oldKind === 'GIT_WORKSPACE' && kind !== undefined && kind !== 'GIT_WORKSPACE') {
        resetTarget();
        git.reset(true);
      }
      if (wasReady && !ready) suspendFiles();
      if (ready) {
        applyWatch();
        restorePendingGit();
      }
    },
    { flush: 'sync' }
  );
  function dispose(): void {
    unmountSurface();
    stopWatchSnapshot();
    stopRootName();
    stopTarget();
    stopReadiness();
    git.reset();
    files.invalidate();
    files.resetTree();
    search.reset();
  }
  function refreshVisible(tool: 'files' | 'changes'): void {
    if (tool === 'changes') void git.loadChanges();
    else void files.requestRefresh();
  }
  async function revealFileTree(path: string, current: () => boolean = () => true): Promise<void> {
    const scope = files.captureTarget();
    const needed = () => scope !== undefined && files.isCurrentTarget(scope) && current();
    if (!needed()) return;
    await files.tree.reveal(path, needed);
    if (!needed()) return;
    files.tree.selectPath(path);
    await filesPanel.value?.reveal(path, needed);
  }
  function openGitChange(entry: ChangeEntry, external = false): void {
    const target = input.target.value;
    if (!input.ready() || target === undefined) return;
    const intent = entry.diffAvailable ? git.changeIntent(entry) : undefined;
    const location = git.changeLocation(entry);
    input.workbench.openToolIntent(
      { ...target, ...location, ...(intent === undefined ? {} : { tab: intent }) },
      external
    );
  }
  function openHistoryDiff(commit: HistoryCommit, file: HistoryFile, external = false): void {
    const target = input.target.value;
    if (!input.ready() || target === undefined) return;
    const intent = git.historyIntent(commit, file);
    if (intent !== undefined)
      input.workbench.openToolIntent({ ...target, path: intent.path, tab: intent }, external);
  }
  function loadDiff(tab: WorkspaceFileTab, signal?: AbortSignal): Promise<unknown> {
    return tab.kind === 'TOOL_CHANGE_DIFF'
      ? loadToolChangeDiff(tab, (path) => input.http.request(path), signal)
      : git.loadDiff(tab, signal);
  }
  function invalidate(topic: 'files' | 'changes'): void {
    if (topic === 'files') filesRevision.value += 1;
    else changesRevision.value += 1;
  }
  function invalidateWorkspace(nodeId: string, workspaceId: string, topic: string): void {
    if (input.target.value?.nodeId !== nodeId || input.target.value.workspaceId !== workspaceId)
      return;
    if (topic === 'files' || topic === 'changes') invalidate(topic);
  }

  return {
    invalidateWorkspace,
    files,
    git,
    search,
    reportFailure,
    revealFileTree,
    loadDiff,
    setFilesPanel: (panel: WorkspaceFilesPanelHandle | null) => {
      filesPanel.value = panel ?? undefined;
    },
    mountSurface,
    unmountSurface,
    acceptWatch,
    applyWatch,
    resetTarget,
    restorePendingGit,
    restoreFiles,
    restoreGit,
    refreshAfterWrite,
    invalidate,
    activateTarget,
    suspendFiles,
    dispose,
    refreshVisible,
    openGitChange,
    openHistoryDiff,
    setSearchPanel,
    searchSnapshot,
    restoreSearch,
    focusSearch
  };
}

export interface WorkbenchFilesView {
  fileWorkbench: ReturnType<typeof createWorkspaceFileWorkbenchController>;
  workspaceFileWorkbench: WorkspaceFileWorkbenchHandle | null | undefined;
  mountSurface: () => void;
  unmountSurface: () => void;
  workspaceFiles: ReturnType<typeof createWorkspaceFileToolsController>['files'];
  workspaceGit: ReturnType<typeof createWorkspaceFileToolsController>['git'];
  workspaceSearch: ReturnType<typeof createWorkspaceFileToolsController>['search'];
  setWorkspaceFilePage: (
    value: WorkspaceFilePagePort | undefined,
    previous?: WorkspaceFilePagePort
  ) => void;
  setWorkspaceFilesPanel: (panel: WorkspaceFilesPanelHandle | null) => void;
  setWorkspaceSearchPanel: (panel: WorkspaceSearchPanelHandle | null) => void;
  downloadWorkspaceFile: (path: string) => Promise<void>;
  openWorkspaceFileExternal: (
    path: string,
    line?: number,
    column?: number,
    renderedPreview?: 'markdown' | 'html',
    worktreePath?: string,
    repositoryPath?: string
  ) => void;
  openWorkspaceGitChange: (entry: ChangeEntry, external?: boolean) => void;
  openWorkspaceHistoryDiff: (commit: HistoryCommit, file: HistoryFile, external?: boolean) => void;
  loadWorkspaceDiff: (tab: WorkspaceFileTab, signal?: AbortSignal) => Promise<unknown>;
  adjacentWorkspaceDiff: (
    tab: WorkspaceFileTab,
    direction: -1 | 1
  ) => WorkspaceFileOpenIntent | undefined;
  reportWorkspaceFileFailure: (error: unknown, action: string) => void;
  fileWriteReady: boolean;
  contentSearchReady: boolean;
  filesReady: boolean;
  standaloneFileMode: boolean;
  standaloneFileLoading: boolean;
  standaloneFileError: boolean;
}
