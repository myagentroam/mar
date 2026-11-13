/**
 * Owns file-tab/preview navigation and page lifetimes for one Workspace surface.
 * A tab retains only its originating Pane for quote routing; draft admission and Session identity
 * remain with the supplied Workbench/Pane owners, never with file loading or navigation.
 */
import { computed, nextTick, ref, shallowReadonly, shallowRef, watch, type Ref } from 'vue';
import type {
  DirtyTextDraft,
  WorkspaceFilePagePort,
  WorkspaceFileWorkbenchSnapshot
} from '../model/workspace-file-workbench.js';
import type { WorkspaceFilePreviewTarget } from '../model/workspace-file-preview.js';
import type {
  WorkspaceNavigationNotice,
  WorkspaceNavigationTarget
} from '../model/workspace-navigation.js';
import { createWorkspaceFilePreviewService } from './workspace-file-preview-service.js';
import { createWorkspaceCodeNavigationService } from './workspace-code-navigation-service.js';
import {
  createWorkspaceFileNavigationHistoryService,
  type FileNavigationPosition
} from './workspace-file-navigation-history-service.js';
import { createWorkspaceFileTabService } from './workspace-file-tab-service.js';
import type { WorkspaceFileTreeEntry } from './workspace-file-tree-service.js';
import type { WorkspaceFileOperationTarget } from './workspace-file-operation-service.js';
import { shouldReadTextFilePreview, usesRawFilePreview } from '../util/file-preview.js';
import type {
  WorkspaceFileOpenIntent,
  WorkspaceFileTab,
  WorkspaceFileTabsSnapshot
} from '../util/workspace-file-tab.js';
import { isComposerAttachmentResourcePath } from '@myagentroam/protocol';
import {
  createStandaloneFileWindowService,
  type StandaloneFileOpenIntent
} from './standalone-file-window-service.js';
import { createStandaloneFileBootstrapController } from './standalone-file-bootstrap-controller.js';

export interface WorkspaceFilePreviewFrame extends ReturnType<
  ReturnType<typeof createWorkspaceFilePreviewService>['page']
> {
  readonly id: number;
  readonly repositoryPath: string | undefined;
  readonly worktreePath: Readonly<Ref<string | undefined>>;
  readonly historySource: WorkspaceFilePreviewTarget['history'];
  readonly targetLine: Ref<number | undefined>;
  readonly targetColumn: Ref<number | undefined>;
  readonly navigationLoading: Readonly<Ref<boolean>>;
  readonly navigationTargets: Readonly<Ref<readonly WorkspaceNavigationTarget[]>>;
  readonly navigationNoDefinition: Readonly<Ref<boolean>>;
  readonly navigationNotice: Readonly<Ref<WorkspaceNavigationNotice | undefined>>;
}

export function createWorkspaceFileWorkbenchController(options: {
  readonly page: () => WorkspaceFilePagePort | undefined;
  readonly access: Parameters<typeof createWorkspaceFilePreviewService>[0]['access'];
  readonly preview: Omit<Parameters<typeof createWorkspaceFilePreviewService>[0], 'access'>;
  readonly navigation: Parameters<typeof createWorkspaceCodeNavigationService>[0];
  readonly target: () => WorkspaceFileOperationTarget | undefined;
  readonly prewarmEnabled: () => boolean;
  readonly resolveRepositoryPath: (
    repositoryPath: string,
    worktreePath?: string
  ) => string | undefined | Promise<string | undefined>;
  readonly reveal: (path: string, current: () => boolean) => Promise<void>;
  readonly onOpenFailure: (error: unknown, path: string) => void;
  readonly onDownloadFailure?: (error: unknown, path: string) => void;
  readonly onRevealFailure: (error: unknown) => void;
  readonly comparison: (path: string) => Promise<WorkspaceFileOpenIntent | undefined>;
  readonly fileWriteEnabled: () => boolean;
  readonly externalTarget: () => WorkspaceFileOperationTarget | undefined;
  readonly onPopupBlocked: () => void;
  readonly lifecycle?: {
    readonly ready: () => boolean;
    readonly workspaceKind: () => string | undefined;
    readonly isReloadingForUpdate: () => boolean;
    readonly bootstrap: Omit<
      Parameters<typeof createStandaloneFileBootstrapController>[0],
      'nodeId' | 'workspaceId' | 'filesReady' | 'open'
    >;
  };
}) {
  const pageHandle = shallowRef<WorkspaceFilePagePort>();
  const page = () => pageHandle.value ?? options.page();
  const tabs = createWorkspaceFileTabService();
  const history = createWorkspaceFileNavigationHistoryService();
  const previews = createWorkspaceFilePreviewService({
    ...options.preview,
    access: options.access
  });
  const navigation = createWorkspaceCodeNavigationService(options.navigation);
  const fileWindow = createStandaloneFileWindowService();
  const htmlWindows = createStandaloneFileWindowService();
  function openExternal(
    path: string,
    line?: number,
    column?: number,
    renderedPreview?: 'markdown' | 'html',
    worktreePath?: string,
    repositoryPath?: string
  ): void {
    const target = options.externalTarget();
    if (target === undefined) return;
    const parameters = new URLSearchParams({
      standaloneFile: '1',
      ...target,
      path,
      rawContent: '1',
      ...(options.fileWriteEnabled() && worktreePath === undefined && repositoryPath === undefined
        ? { write: '1' }
        : {}),
      ...(repositoryPath === undefined ? {} : { repositoryPath }),
      ...(worktreePath === undefined ? {} : { worktreePath }),
      ...(renderedPreview === 'markdown' ? { markdownPreview: '1' } : {}),
      ...(renderedPreview === 'html' ? { htmlPreview: '1' } : {}),
      ...(line === undefined ? {} : { line: String(line) }),
      ...(column === undefined ? {} : { column: String(column) })
    });
    if (fileWindow.open(`/console?${parameters}`) === undefined) options.onPopupBlocked();
  }
  function openDiffExternal(intent: WorkspaceFileOpenIntent): void {
    if (intent.kind !== 'WORKTREE_DIFF' && intent.kind !== 'HISTORY_DIFF') return;
    const target = options.externalTarget();
    if (target === undefined) return;
    const parameters = new URLSearchParams({
      standaloneFile: '1',
      ...target,
      fileTabKind: intent.kind,
      path: intent.path,
      ...(intent.gitFile ? { gitFile: '1' } : {}),
      ...(intent.repositoryPath === '' ? {} : { repositoryPath: intent.repositoryPath }),
      ...(intent.worktreePath === '' ? {} : { worktreePath: intent.worktreePath }),
      ...(intent.commit === undefined ? {} : { commit: intent.commit }),
      ...(intent.previousPath === undefined ? {} : { previousPath: intent.previousPath })
    });
    for (const refName of intent.refs ?? []) parameters.append('refs', refName);
    for (const path of intent.paths ?? [intent.path]) parameters.append('paths', path);
    if (fileWindow.open(`/console?${parameters}`) === undefined) options.onPopupBlocked();
  }
  function openLocation(
    location: {
      readonly path: string;
      readonly worktreePath?: string;
      readonly repositoryPath?: string;
    },
    external: boolean
  ): void {
    if (external)
      openExternal(
        location.path,
        undefined,
        undefined,
        undefined,
        location.worktreePath,
        location.repositoryPath
      );
    else
      void openWorkspaceFile(
        location.path,
        undefined,
        location.worktreePath,
        false,
        undefined,
        location.repositoryPath
      );
  }
  function openHtmlExternal(path: string): void {
    const target = options.externalTarget();
    if (target === undefined) return;
    const parameters = new URLSearchParams({
      standaloneFile: '1',
      ...target,
      path,
      htmlPreview: '1'
    });
    if (htmlWindows.openNew(`/console?${parameters}`) === undefined) options.onPopupBlocked();
  }
  const stopActiveTabWatch = watch(tabs.activeTabId, () => navigation.cancel(), { flush: 'sync' });
  const frames = shallowRef<readonly WorkspaceFilePreviewFrame[]>([]);
  const suspended = ref(false);
  const drafts = new Map<string, DirtyTextDraft>();
  let openGeneration = 0;
  let restoreGeneration = 0;
  let restorationPending = false;
  let pendingFocus:
    { tab: WorkspaceFileTab; generation: number; line?: number; column?: number } | undefined;
  function beginOpen(): number {
    pendingFocus = undefined;
    return ++openGeneration;
  }
  function isOpenCurrent(generation: number): boolean {
    return generation === openGeneration;
  }
  function invalidateOpen(): void {
    openGeneration += 1;
    pendingFocus = undefined;
  }
  function pageReady(id?: number): void {
    const pending = pendingFocus;
    if (pending === undefined || (id !== undefined && id !== pending.tab.id)) return;
    const target = options.target();
    if (
      pending.generation !== openGeneration ||
      tabs.activeTab.value !== pending.tab ||
      target?.nodeId !== pending.tab.nodeId ||
      target.workspaceId !== pending.tab.workspaceId
    ) {
      pendingFocus = undefined;
      return;
    }
    const port = page();
    if (port === undefined || !port.focusPage(pending.tab.id)) return;
    pendingFocus = undefined;
    if (pending.line !== undefined) port.navigateTo(pending.tab.id, pending.line, pending.column);
  }
  function focusWhenReady(tab: WorkspaceFileTab | undefined, generation: number): void {
    if (tab === undefined || !isOpenCurrent(generation) || tabs.activeTab.value !== tab) return;
    pendingFocus = { tab, generation };
    void nextTick(() => pageReady(tab.id));
  }
  function invalidateTarget(): void {
    invalidateOpen();
    restoreGeneration += 1;
    restorationPending = false;
  }
  function setSuspended(value: boolean): void {
    suspended.value = value;
  }
  function isDirtyTextDraft(value: unknown): value is DirtyTextDraft {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as DirtyTextDraft).tabIdentity === 'string' &&
      typeof (value as DirtyTextDraft).path === 'string' &&
      typeof (value as DirtyTextDraft).content === 'string' &&
      typeof (value as DirtyTextDraft).expectedRevision === 'string'
    );
  }
  function collectDrafts(): Map<string, DirtyTextDraft> {
    const identities = new Set(tabs.tabs.value.map((tab) => tab.identity));
    const collected = new Map([...drafts].filter(([identity]) => identities.has(identity)));
    for (const draft of page()?.captureDirtyDrafts() ?? [])
      if (isDirtyTextDraft(draft) && identities.has(draft.tabIdentity))
        collected.set(draft.tabIdentity, draft);
    return collected;
  }
  function suspendForHtml(): boolean {
    if (page()?.hasPendingSave()) return false;
    for (const [identity, draft] of collectDrafts()) drafts.set(identity, draft);
    for (const frame of frames.value) {
      const position = page()?.cursorPosition(frame.id);
      if (position !== undefined) {
        frame.targetLine.value = position.line;
        frame.targetColumn.value = position.column;
      }
    }
    invalidateOpen();
    navigation.cancel();
    setSuspended(true);
    return true;
  }
  function snapshot(): WorkspaceFileWorkbenchSnapshot {
    const fileTabs = tabs.snapshot();
    return {
      fileTabs: {
        ...fileTabs,
        tabs: fileTabs.tabs.map((tab) => {
          const frame = frames.value.find((item) => item.id === tab.id);
          const position = page()?.cursorPosition(tab.id);
          const line = position?.line ?? frame?.targetLine.value;
          const column = position?.column ?? frame?.targetColumn.value;
          return {
            ...tab,
            ...(line === undefined ? {} : { targetLine: line }),
            ...(column === undefined ? {} : { targetColumn: column })
          };
        })
      },
      dirtyTextDrafts: [...collectDrafts().values()],
      fileWindowSuspended: suspended.value
    };
  }
  function restoreDrafts(values: readonly unknown[]): void {
    drafts.clear();
    for (const draft of values) if (isDirtyTextDraft(draft)) drafts.set(draft.tabIdentity, draft);
  }
  function restoreFileState(
    snapshot: WorkspaceFileTabsSnapshot,
    dirtyDrafts: readonly unknown[],
    isSuspended: boolean
  ): void {
    invalidateOpen();
    const generation = ++restoreGeneration;
    closeAllPreviews();
    tabs.restore(snapshot);
    restoreDrafts(dirtyDrafts);
    setSuspended(isSuspended);
    void restoreContents(generation);
  }
  async function restoreContents(generation: number): Promise<void> {
    if (options.target() === undefined) {
      restorationPending = true;
      return;
    }
    restorationPending = false;
    for (const tab of tabs.tabs.value) {
      if (generation !== restoreGeneration) return;
      if (
        !tabs.tabs.value.some(
          (current) => current.id === tab.id && current.identity === tab.identity
        )
      )
        continue;
      const activeId = tabs.activeTabId.value;
      let opening: Promise<void>;
      if (tab.kind === 'WORKTREE_TEXT' || tab.kind === 'WORKTREE_PREVIEW') {
        opening = openWorkspaceFile(
          tab.path,
          tab.targetLine,
          tab.worktreePath === '' ? undefined : tab.worktreePath,
          true,
          tab.targetColumn,
          tab.gitFile ? tab.repositoryPath : undefined,
          false,
          true
        );
      } else if (tab.kind === 'HISTORY_TEXT' && tab.commit !== undefined) {
        const { previousPath: _previousPath, ...historyText } = tab;
        opening = openHistoryText(
          { ...historyText, kind: 'HISTORY_DIFF', paths: [tab.path] },
          undefined,
          false
        );
      } else continue;
      if (activeId !== undefined) tabs.activate(activeId);
      await opening;
    }
  }
  function resumeRestoration(): void {
    if (restorationPending && options.target() !== undefined)
      void restoreContents(restoreGeneration);
  }
  function createFrame(id: number): WorkspaceFilePreviewFrame {
    const preview = previews.page(id);
    return {
      ...preview,
      id,
      get repositoryPath() {
        return preview.target.value?.repositoryPath;
      },
      worktreePath: computed(() => preview.target.value?.worktreePath),
      get historySource() {
        return preview.target.value?.history;
      },
      targetLine: ref<number>(),
      targetColumn: ref<number>(),
      ...navigation.page(id)
    };
  }
  function ensureFrame(id: number): WorkspaceFilePreviewFrame {
    const existing = frames.value.find((frame) => frame.id === id);
    if (existing !== undefined) return existing;
    const frame = createFrame(id);
    frames.value = [...frames.value, frame];
    return frame;
  }
  async function openEntry(
    entry: WorkspaceFileTreeEntry,
    input: {
      readonly line?: number;
      readonly column?: number;
      readonly worktreePath?: string;
      readonly repositoryPath?: string;
      readonly serverOnly: boolean;
      readonly existingPreview?: WorkspaceFilePreviewFrame;
    }
  ): Promise<void> {
    const target = options.target();
    if (entry.kind === 'DIRECTORY' || target === undefined) return;
    const textPreview = shouldReadTextFilePreview(entry.path);
    const tab = tabs.open({
      kind: textPreview ? 'WORKTREE_TEXT' : 'WORKTREE_PREVIEW',
      ...target,
      path: entry.path,
      repositoryPath: input.repositoryPath ?? '',
      ...(input.repositoryPath === undefined ? {} : { gitFile: true }),
      worktreePath: input.worktreePath ?? '',
      ...(input.line === undefined ? {} : { targetLine: input.line }),
      ...(input.column === undefined ? {} : { targetColumn: input.column })
    });
    const frame = input.existingPreview ?? ensureFrame(tab.id);
    navigation.clear(frame.id);
    frame.targetLine.value = input.line;
    frame.targetColumn.value = input.column;
    const opened = await previews.open(
      frame.id,
      {
        ...target,
        path: entry.path,
        ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
        ...(input.repositoryPath === undefined ? {} : { repositoryPath: input.repositoryPath })
      },
      {
        textPreview,
        serverOnly: input.serverOnly,
        ...(entry.size === null ? {} : { size: entry.size })
      }
    );
    const active = options.target();
    if (
      active?.nodeId === target.nodeId &&
      active.workspaceId === target.workspaceId &&
      opened?.encoding === 'utf-8' &&
      frames.value.includes(frame) &&
      input.worktreePath === undefined &&
      input.repositoryPath === undefined
    )
      if (options.prewarmEnabled())
        void navigation.prewarm({
          nodeId: target.nodeId,
          workspaceId: target.workspaceId,
          path: entry.path
        });
  }
  async function openHistoryText(
    intent: WorkspaceFileOpenIntent,
    diff?: unknown,
    trackNavigation = true
  ): Promise<void> {
    const target = options.target();
    if (
      target === undefined ||
      (intent.kind !== 'HISTORY_DIFF' && intent.kind !== 'HISTORY_TEXT') ||
      intent.commit === undefined
    )
      return;
    const source = currentPosition();
    const tab = tabs.open({
      kind: 'HISTORY_TEXT',
      ...target,
      path: intent.path,
      repositoryPath: intent.repositoryPath,
      worktreePath: '',
      commit: intent.commit,
      refs: intent.refs ?? [],
      ...(intent.targetLine === undefined ? {} : { targetLine: intent.targetLine }),
      ...(intent.targetColumn === undefined ? {} : { targetColumn: intent.targetColumn })
    });
    if (trackNavigation) recordNavigation(source, tab.id, intent.targetLine, intent.targetColumn);
    const frame = ensureFrame(tab.id);
    navigation.clear(frame.id);
    frame.targetLine.value = intent.targetLine;
    frame.targetColumn.value = intent.targetColumn;
    const binary =
      typeof diff === 'object' && diff !== null && (diff as { binary?: unknown }).binary === true;
    await previews.open(
      tab.id,
      {
        ...target,
        path: intent.path,
        history: {
          commit: intent.commit,
          repositoryPath: intent.repositoryPath,
          refs: intent.refs ?? []
        }
      },
      { textPreview: !binary && shouldReadTextFilePreview(intent.path) }
    );
  }
  function openWorkspaceFile(
    path: string,
    line?: number,
    worktreePath?: string,
    _stacked = false,
    column?: number,
    repositoryPath?: string,
    showWindow = true,
    continueOpen = false
  ): Promise<void> {
    const generation = showWindow && !continueOpen ? beginOpen() : undefined;
    if (showWindow) setSuspended(false);
    const opening = openEntry(
      { path, name: path.split('/').at(-1) ?? path, kind: 'FILE', size: null },
      {
        serverOnly: false,
        ...(line === undefined ? {} : { line }),
        ...(column === undefined ? {} : { column }),
        ...(worktreePath === undefined ? {} : { worktreePath }),
        ...(repositoryPath === undefined ? {} : { repositoryPath })
      }
    );
    if (generation !== undefined) focusWhenReady(tabs.activeTab.value, generation);
    return opening;
  }
  async function openWorktreeDiffText(
    tab: WorkspaceFileOpenIntent,
    continueOpen = false
  ): Promise<number | undefined> {
    if (tab.kind !== 'WORKTREE_DIFF') return;
    const generation = continueOpen ? openGeneration : beginOpen();
    const sourceId = tabs.activeTabId.value;
    const repositoryPath = await options.resolveRepositoryPath(
      tab.repositoryPath,
      tab.worktreePath || undefined
    );
    const target = options.target();
    if (
      !isOpenCurrent(generation) ||
      tabs.activeTabId.value !== sourceId ||
      target?.nodeId !== tab.nodeId ||
      target.workspaceId !== tab.workspaceId
    )
      return;
    const path =
      repositoryPath !== undefined
        ? tab.path
        : tab.worktreePath === '' && tab.repositoryPath !== ''
          ? `${tab.repositoryPath}/${tab.path}`
          : tab.path;
    if (repositoryPath === undefined && tab.worktreePath === '') {
      const opening = openFile(path, undefined, undefined, tab.quotePane);
      const sourceGeneration = openGeneration;
      const sourceTab = tabs.activeTab.value;
      await opening;
      return isOpenCurrent(sourceGeneration) &&
        tabs.activeTab.value === sourceTab &&
        sourceTab?.path === path &&
        (sourceTab.kind === 'WORKTREE_TEXT' || sourceTab.kind === 'WORKTREE_PREVIEW')
        ? sourceTab.id
        : undefined;
    }
    const source = currentPosition();
    const opening = openWorkspaceFile(
      path,
      undefined,
      tab.worktreePath || undefined,
      true,
      undefined,
      repositoryPath,
      true,
      true
    );
    focusWhenReady(tabs.activeTab.value, generation);
    const targetId = tabs.activeTabId.value;
    if (targetId !== undefined) recordNavigation(source, targetId);
    await opening;
    return isOpenCurrent(generation) && tabs.activeTabId.value === targetId ? targetId : undefined;
  }
  async function openTab(intent: WorkspaceFileOpenIntent): Promise<void> {
    const target = options.target();
    if (
      target === undefined ||
      target.nodeId !== intent.nodeId ||
      target.workspaceId !== intent.workspaceId
    )
      return;
    const generation = beginOpen();
    setSuspended(false);
    if (
      usesRawFilePreview(intent.path) &&
      (intent.kind === 'WORKTREE_DIFF' ||
        intent.kind === 'HISTORY_DIFF' ||
        intent.kind === 'HISTORY_TEXT')
    ) {
      if (intent.kind === 'WORKTREE_DIFF') {
        await openWorktreeDiffText(intent, true);
        return;
      }
      if (!intent.commit) return;
      const opening = openHistoryText(intent);
      const tab = tabs.activeTab.value;
      focusWhenReady(tab, generation);
      await opening;
      return;
    }
    if (intent.kind === 'HISTORY_TEXT') {
      if (!intent.commit) return;
      const opening = openHistoryText(intent);
      focusWhenReady(tabs.activeTab.value, generation);
      await opening;
      return;
    }
    const source = currentPosition();
    const tab = tabs.open(intent);
    recordNavigation(source, tab.id, intent.targetLine, intent.targetColumn);
    focusWhenReady(tabs.activeTab.value, generation);
    await nextTick();
  }
  async function openFile(
    path: string,
    line?: number,
    column?: number,
    quotePane: 'main' | 'aside' = 'main'
  ): Promise<void> {
    const generation = beginOpen();
    const target = options.target();
    if (target === undefined) return;
    const source = currentPosition();
    const sameTarget = () => {
      const current = options.target();
      return (
        isOpenCurrent(generation) &&
        current?.nodeId === target.nodeId &&
        current.workspaceId === target.workspaceId
      );
    };
    if (isComposerAttachmentResourcePath(path) || path.startsWith('.mar/temp-files/')) {
      try {
        await previews.checkReadable({ ...target, path });
      } catch (error) {
        if (sameTarget()) options.onOpenFailure(error, path);
        return;
      }
      if (!sameTarget()) return;
    }
    setSuspended(false);
    const existing = frames.value.find(
      (frame) =>
        frame.worktreePath.value === undefined &&
        frame.repositoryPath === undefined &&
        frame.historySource === undefined &&
        frame.fileContent.value?.path === path
    );
    if (existing !== undefined) {
      tabs.activate(existing.id);
      if (line !== undefined) existing.targetLine.value = line;
      if (column !== undefined) existing.targetColumn.value = column;
    }
    const opening =
      existing === undefined
        ? openWorkspaceFile(path, line, undefined, true, column, undefined, true, true)
        : Promise.resolve();
    if (tabs.activeTabId.value !== undefined) tabs.setQuotePane(tabs.activeTabId.value, quotePane);
    const targetTab = tabs.activeTab.value;
    const targetId = targetTab?.id;
    const current = () =>
      sameTarget() &&
      targetId !== undefined &&
      tabs.activeTab.value === targetTab &&
      tabs.activeTabId.value === targetId;
    if (current() && targetId !== undefined) {
      recordNavigation(source, targetId, line, column);
      pendingFocus = {
        tab: targetTab!,
        generation,
        ...(existing !== undefined && line !== undefined ? { line } : {}),
        ...(existing !== undefined && column !== undefined ? { column } : {})
      };
      void nextTick(() => {
        if (current()) pageReady(targetId);
      });
    }
    void options.reveal(path, current).catch((error: unknown) => {
      if (current()) options.onRevealFailure(error);
    });
    await opening;
  }
  async function openComparison(
    path: string,
    line?: number,
    column?: number,
    quotePane: 'main' | 'aside' = 'main'
  ): Promise<void> {
    const generation = beginOpen();
    const target = options.target();
    if (target === undefined) return;
    const intent = await options.comparison(path);
    const current = options.target();
    if (
      !isOpenCurrent(generation) ||
      current?.nodeId !== target.nodeId ||
      current.workspaceId !== target.workspaceId
    )
      return;
    if (intent !== undefined) await openTab({ ...intent, quotePane });
    else await openFile(path, line, column, quotePane);
  }
  async function openStandalone(intent: StandaloneFileOpenIntent): Promise<void> {
    if (intent.tab !== undefined) return openTab(intent.tab);
    if (intent.worktreePath === undefined && intent.repositoryPath === undefined)
      return openFile(intent.path, intent.line, intent.column);
    return openWorkspaceFile(
      intent.path,
      intent.line,
      intent.worktreePath,
      false,
      intent.column,
      intent.repositoryPath
    );
  }
  function openToolIntent(intent: StandaloneFileOpenIntent, external: boolean): void {
    const target = options.target();
    if (target?.nodeId !== intent.nodeId || target.workspaceId !== intent.workspaceId) return;
    if (intent.tab === undefined) openLocation(intent, external);
    else if (external) openDiffExternal(intent.tab);
    else void openStandalone(intent);
  }
  const revision = ref(0);
  const canGoBack = computed(() => {
    void revision.value;
    return history.canTravel(-1);
  });
  const canGoForward = computed(() => {
    void revision.value;
    return history.canTravel(1);
  });

  function currentPosition(): FileNavigationPosition | undefined {
    const tabId = tabs.activeTabId.value;
    return tabId === undefined ? undefined : { tabId, ...page()?.cursorPosition(tabId) };
  }
  function recordNavigation(
    source: FileNavigationPosition | undefined,
    tabId: number,
    line?: number,
    column?: number
  ): void {
    if (source?.tabId === tabId && line === undefined) return;
    history.record(source, {
      tabId,
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column })
    });
    revision.value += 1;
  }
  function travel(direction: -1 | 1): void {
    const target = history.travel(direction, currentPosition());
    if (target === undefined || !tabs.tabs.value.some((tab) => tab.id === target.tabId)) return;
    tabs.activate(target.tabId);
    const tab = tabs.activeTab.value;
    const targetPage = page();
    void nextTick(() => {
      if (tab === undefined || tabs.activeTab.value !== tab || page() !== targetPage) return;
      if (target.line !== undefined)
        targetPage?.navigateTo(target.tabId, target.line, target.column);
      else targetPage?.focusPage(target.tabId);
    });
    revision.value += 1;
  }
  function removeNavigation(id: number): void {
    history.remove(id);
    revision.value += 1;
  }
  function clearNavigation(): void {
    history.clear();
    revision.value += 1;
  }
  function closePreview(preview: WorkspaceFilePreviewFrame): void {
    const index = frames.value.indexOf(preview);
    if (index < 0) return;
    const tab = tabs.tabs.value.find((item) => item.id === preview.id);
    if (tab !== undefined) drafts.delete(tab.identity);
    const wasActive = tabs.activeTabId.value === preview.id;
    previews.close(preview.id);
    navigation.release(preview.id);
    frames.value = frames.value.filter((item) => item !== preview);
    tabs.remove(preview.id);
    removeNavigation(preview.id);
    if (wasActive)
      tabs.activate(frames.value.at(index - 1)?.id ?? frames.value.at(index)?.id ?? -1);
  }
  function closeAllPreviews(): void {
    clearNavigation();
    for (const preview of frames.value) {
      const tab = tabs.tabs.value.find((item) => item.id === preview.id);
      if (tab !== undefined) drafts.delete(tab.identity);
      previews.close(preview.id);
      tabs.remove(preview.id);
    }
    frames.value = [];
    navigation.reset();
  }
  function closeTabs(ids: readonly number[]): void {
    for (const id of ids) {
      const tab = tabs.tabs.value.find((item) => item.id === id);
      if (tab === undefined) continue;
      drafts.delete(tab.identity);
      const preview = frames.value.find((item) => item.id === id);
      if (preview !== undefined) closePreview(preview);
      else {
        tabs.remove(id);
        removeNavigation(id);
      }
    }
  }
  function reset(): void {
    invalidateTarget();
    setSuspended(false);
    drafts.clear();
    closeAllPreviews();
    tabs.clear();
  }
  function invalidateDeletedSelection(): void {
    invalidateTarget();
    setSuspended(false);
    drafts.clear();
    closeAllPreviews();
  }
  function removeGitTabs(): void {
    closeTabs(
      tabs.tabs.value
        .filter(
          (tab) =>
            tab.gitFile === true ||
            tab.worktreePath !== '' ||
            tab.kind === 'WORKTREE_DIFF' ||
            tab.kind === 'HISTORY_DIFF' ||
            tab.kind === 'HISTORY_TEXT'
        )
        .map((tab) => tab.id)
    );
  }
  function activateTab(id: number): void {
    const source = currentPosition();
    tabs.activate(id);
    if (tabs.activeTabId.value !== id) return;
    const position = page()?.cursorPosition(id);
    recordNavigation(source, id, position?.line, position?.column);
  }
  function navigateInPage(id: number, line: number, column?: number): void {
    const frame = frames.value.find((candidate) => candidate.id === id);
    if (frame === undefined) return;
    const source = currentPosition();
    frame.targetLine.value = line;
    frame.targetColumn.value = column;
    page()?.navigateTo(id, line, column);
    recordNavigation(source, id, line, column);
  }
  function openNavigationTarget(target: WorkspaceNavigationTarget, pageId: number): void {
    const frame = frames.value.find((item) => item.id === pageId);
    if (frame === undefined) return;
    navigation.clear(pageId);
    if (frame.fileContent.value?.path === target.path)
      navigateInPage(pageId, target.line, target.column);
    else void openFile(target.path, target.line, target.column);
  }
  async function reloadFile(id: number): Promise<void> {
    const frame = frames.value.find((item) => item.id === id);
    const target = frame?.target.value;
    if (frame === undefined || target === undefined || frame.loading.value) return;
    const position = page()?.cursorPosition(id);
    if (position !== undefined) {
      frame.targetLine.value = position.line;
      frame.targetColumn.value = position.column;
    }
    navigation.clear(id);
    const size = frame.fileContent.value?.size;
    await previews.open(id, target, {
      serverOnly: true,
      ...(size === undefined ? {} : { size })
    });
  }
  async function downloadPath(path: string): Promise<void> {
    const target = options.externalTarget();
    if (target === undefined) return;
    try {
      await previews.downloadTarget({ ...target, path });
    } catch (error) {
      (options.onDownloadFailure ?? options.onOpenFailure)(error, path);
    }
  }

  function restore(value: unknown): void {
    if (typeof value !== 'object' || value === null) return;
    const snapshot = value as Partial<WorkspaceFileWorkbenchSnapshot>;
    invalidateTarget();
    if (snapshot.fileTabs !== undefined && Array.isArray(snapshot.fileTabs.tabs))
      restoreFileState(
        snapshot.fileTabs,
        snapshot.dirtyTextDrafts ?? [],
        snapshot.fileWindowSuspended === true
      );
    else restoreDrafts(snapshot.dirtyTextDrafts ?? []);
  }
  function dispose(): void {
    standalone?.dispose();
    if (options.lifecycle !== undefined && typeof window !== 'undefined')
      window.removeEventListener('beforeunload', protectSuspendedFileDrafts);
    for (const stop of lifecycleStops) stop();
    stopActiveTabWatch();
    invalidateTarget();
    previews.reset();
    navigation.reset();
  }
  function setPage(
    value: WorkspaceFilePagePort | undefined,
    previous?: WorkspaceFilePagePort
  ): void {
    if (value !== undefined) {
      pageHandle.value = value;
      pageReady();
    } else if (pageHandle.value === previous) pageHandle.value = undefined;
  }
  function protectSuspendedFileDrafts(event: BeforeUnloadEvent): void {
    if (!suspended.value || drafts.size === 0 || options.lifecycle?.isReloadingForUpdate()) return;
    event.preventDefault();
    event.returnValue = '';
  }
  const lifecycleStops: (() => void)[] = [];
  const lifecycle = options.lifecycle;
  const standalone =
    lifecycle === undefined
      ? undefined
      : createStandaloneFileBootstrapController({
          ...lifecycle.bootstrap,
          nodeId: () => options.externalTarget()?.nodeId,
          workspaceId: () => options.externalTarget()?.workspaceId,
          filesReady: lifecycle.ready,
          open: openStandalone
        });
  if (lifecycle !== undefined) {
    lifecycleStops.push(
      watch(
        () => [options.externalTarget()?.nodeId, options.externalTarget()?.workspaceId] as const,
        ([nodeId, workspaceId], [oldNodeId, oldWorkspaceId]) => {
          if (nodeId === oldNodeId && workspaceId === oldWorkspaceId) return;
          pageHandle.value = undefined;
          reset();
        },
        { flush: 'sync' }
      )
    );
    lifecycleStops.push(
      watch(
        [lifecycle.ready, lifecycle.workspaceKind],
        ([ready, kind], [, oldKind]) => {
          if (oldKind === 'GIT_WORKSPACE' && kind !== undefined && kind !== 'GIT_WORKSPACE')
            removeGitTabs();
          if (ready) resumeRestoration();
        },
        { flush: 'sync' }
      )
    );
    if (typeof window !== 'undefined')
      window.addEventListener('beforeunload', protectSuspendedFileDrafts);
  }
  return {
    standalone,
    setPage,
    tabList: tabs.tabs,
    activeTabId: tabs.activeTabId,
    activeTab: tabs.activeTab,
    activateTab,
    openNavigationTarget,
    saveFile: previews.save,
    reloadFile,
    downloadFile: previews.download,
    downloadTarget: previews.downloadTarget,
    downloadPath,
    navigate: navigation.navigate,
    clearNavigationResult: navigation.clear,
    restore,
    resumeRestoration,
    pageReady,
    frames: shallowReadonly(frames),
    suspended: shallowReadonly(suspended),
    suspendForHtml,
    snapshot,
    draftFor: (identity: string) => drafts.get(identity),
    consumeDraft: (identity: string) => drafts.delete(identity),
    hasDraft: (identity: string) => drafts.has(identity),
    hasSuspendedDrafts: () => suspended.value && drafts.size > 0,
    openHistoryText,
    openWorkspaceFile,
    openWorktreeDiffText,
    openTab,
    openFile,
    openExternal,
    openDiffExternal,
    openLocation,
    openHtmlExternal,
    openComparison,
    openStandalone,
    openToolIntent,
    canGoBack,
    canGoForward,
    travel,
    closeTabs,
    reset,
    invalidateDeletedSelection,
    removeGitTabs,
    dispose
  };
}
