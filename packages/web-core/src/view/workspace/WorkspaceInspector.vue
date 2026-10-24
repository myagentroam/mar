<script setup lang="ts">
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import type { MessageType } from '../../model/message-feedback.js';
import MarIcon from '../common/MarIcon.vue';
import { marIcon } from '../../util/mar-icons.js';
import { ElMessageBox } from '../../service/message-box-service.js';
import { isComposerAttachmentResourcePath } from '@myagentroam/protocol';
import type {
  FileNavigationRequest,
  WorkspaceNavigationTarget as NavigationTarget
} from '../../model/workspace-navigation.js';
import { createWorkspaceCodeNavigationService } from '../../service/workspace-code-navigation-service.js';
import {
  createWorkspaceContentSearchService,
  type WorkspaceContentMatch as ContentMatch
} from '../../service/workspace-content-search-service.js';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  type Ref,
  watch
} from 'vue';
import { createScopedHttpService } from '../../service/scoped-http-service.js';
import { PromptPredictionAttentionService } from '../../service/prompt-prediction-attention-service.js';
import {
  createWorkspaceFileTreeService,
  type WorkspaceFileTreeEntry,
  type WorkspaceFileTreeNode,
  type WorkspaceFileTreePage,
  type WorkspaceFileTreeSnapshot,
  type WorkspaceFileTreeWorkspace
} from '../../service/workspace-file-tree-service.js';
import { createWorkspaceFileTabService } from '../../service/workspace-file-tab-service.js';
import {
  createWorkspaceFileNavigationHistoryService,
  type FileNavigationPosition
} from '../../service/workspace-file-navigation-history-service.js';
import WorkspaceTextFilePage from './WorkspaceTextFilePage.vue';
import WorkspaceFormatFilePage from './WorkspaceFormatFilePage.vue';
import type { DirtyTextDraft } from './WorkspaceTextFilePage.vue';
import WorkspaceFileTabs from './WorkspaceFileTabs.vue';
import WorkspaceGitDiffPage from './WorkspaceGitDiffPage.vue';
import WorkspaceGitChanges from './WorkspaceGitChanges.vue';
import WorkspaceGitHistory from './WorkspaceGitHistory.vue';
import {
  createWorkspaceGitService,
  type WorkspaceGitSnapshot
} from '../../service/workspace-git-service.js';
import {
  createWorkspaceFileOperationService,
  filePageWorkspace,
  isFilePage,
  type WorkspaceFileOperationTarget
} from '../../service/workspace-file-operation-service.js';
import type { ChangeEntry, HistoryCommit, HistoryFile } from '../../model/workspace-git.js';
import { workspaceChangePath, changeFileName } from '../../util/workspace-git.js';
import { loadToolChangeDiff } from '../../service/tool-change-review-service.js';
import WorkspaceFileTree from './WorkspaceFileTree.vue';
import FileTypeIcon from './FileTypeIcon.vue';
import { createTrailingTask } from '../../util/trailing-task.js';
import { fileSizeLabel } from '../../util/file-presentation.js';
import { errorMessage, filePreviewErrorMessage } from '../../util/error-presentation.js';
import { ApiError, errorCode } from '../../util/api-error.js';
import {
  filePreviewKind,
  isHtmlFile,
  isMarkdownFile,
  shouldReadTextFilePreview,
  type FilePreviewKind
} from '../../util/file-preview.js';
import {
  createWorkspaceFilePreviewService,
  workspaceFilePreviewUrl
} from '../../service/workspace-file-preview-service.js';
import type {
  WorkspaceFilePreviewContent,
  WorkspaceFilePreviewTarget
} from '../../model/workspace-file-preview.js';
import { translate } from '../../service/locale-preference-service.js';
import { createStandaloneFileWindowService } from '../../service/standalone-file-window-service.js';
import type {
  WorkspaceFileOpenIntent,
  WorkspaceFileTab,
  WorkspaceFileTabsSnapshot
} from '../../util/workspace-file-tab.js';
type FileEntry = WorkspaceFileTreeEntry;

interface PendingUpload {
  readonly id: string;
  readonly file: File;
  readonly path: string | null;
  readonly status: 'READY' | 'EXISTS_FILE' | 'EXISTS_DIRECTORY' | 'INVALID_NAME';
  overwrite: boolean;
}

type InspectorSection = 'files' | 'search' | 'changes' | 'history';

type FilePreviewContent = WorkspaceFilePreviewContent;
interface PreviewFrame extends ReturnType<
  ReturnType<typeof createWorkspaceFilePreviewService>['page']
> {
  readonly id: number;
  readonly repositoryPath: string | undefined;
  readonly worktreePath: Readonly<Ref<string | undefined>>;
  readonly historySource: WorkspaceFilePreviewTarget['history'];
  readonly targetLine: Ref<number | undefined>;
  readonly targetColumn: Ref<number | undefined>;
  readonly navigationLoading: Readonly<Ref<boolean>>;
  readonly navigationTargets: Readonly<Ref<readonly NavigationTarget[]>>;
  readonly navigationNoDefinition: Readonly<Ref<boolean>>;
}
interface LoadedPreviewFrame extends PreviewFrame {
  readonly fileContent: Readonly<Ref<FilePreviewContent>>;
}

const props = defineProps<{
  readonly predictionEnabled?: boolean;
  readonly nodeId: string | undefined;
  readonly workspaceId: string | undefined;
  readonly workspaceName: string;
  readonly workspacePath?: string | undefined;
  readonly workspaceKind: 'DIRECTORY' | 'GIT_WORKSPACE' | undefined;
  readonly csrfToken: string;
  readonly renewCsrfToken: () => Promise<string>;
  readonly enabled: boolean;
  readonly capabilityLoading?: boolean;
  readonly nodeOnline?: boolean;
  readonly mobileViewport: boolean;
  readonly contentSearchEnabled: boolean;
  readonly codeNavigationEnabled: boolean;
  readonly codeNavigationPrewarmEnabled: boolean;
  readonly filesRevision?: number;
  readonly changesRevision?: number;
  readonly filesWatchStatus: 'idle' | 'loading' | 'ready' | 'failed';
  readonly changesWatchStatus: 'idle' | 'loading' | 'ready' | 'failed';
  readonly standaloneFileMode?: boolean;
  readonly historyCapability: boolean | undefined;
  readonly fileWriteEnabled: boolean;
  readonly directFileDownload?: (
    path: string,
    worktreePath?: string,
    repositoryPath?: string
  ) => Promise<'COMPLETED' | 'UNAVAILABLE' | 'CANCELLED' | 'FAILED'>;
  readonly directFileObjectUrl?: (
    path: string,
    worktreePath?: string,
    repositoryPath?: string
  ) => Promise<string | undefined>;
  readonly directFileReadRange?: (
    path: string,
    offset: number,
    length: number,
    worktreePath?: string,
    identity?: { readonly revision: string; readonly size: number },
    repositoryPath?: string
  ) => Promise<
    | {
        readonly revision: string;
        readonly size: number;
        readonly offset: number;
        readonly bytes: Uint8Array<ArrayBuffer>;
        readonly nextOffset: number | null;
      }
    | undefined
  >;
  readonly directGitFileDownload?: (
    commit: string,
    path: string,
    repositoryPath: string,
    refs: readonly string[]
  ) => Promise<'COMPLETED' | 'UNAVAILABLE' | 'CANCELLED' | 'FAILED'>;
  readonly directGitFileObjectUrl?: (
    commit: string,
    path: string,
    repositoryPath: string,
    refs: readonly string[]
  ) => Promise<string | undefined>;
  readonly directGitFileReadRange?: (
    commit: string,
    path: string,
    repositoryPath: string,
    refs: readonly string[],
    offset: number,
    length: number,
    identity?: { readonly revision: string; readonly size: number }
  ) => Promise<
    | {
        readonly revision: string;
        readonly size: number;
        readonly bytes: Uint8Array<ArrayBuffer>;
        readonly nextOffset: number | null;
      }
    | undefined
  >;
  readonly subscriptionSnapshot?:
    | {
        readonly nodeId: string;
        readonly workspaceId: string;
        readonly files?: unknown;
        readonly filesWatchRevision?: number;
        readonly changes?: unknown;
        readonly changesWatchRevision?: number;
      }
    | undefined;
}>();

const emit = defineEmits<{
  notice: [value: string, type: MessageType, cause?: unknown];
  branch: [workspaceId: string, value: string | null];
  workspace: [value: WorkspaceFileTreeWorkspace];
  directory: [path: string];
  uploads: [
    value: readonly {
      readonly file: File;
      readonly directory: string;
      readonly overwrite: boolean;
    }[]
  ];
}>();
const http = createScopedHttpService({
  csrfToken: () => props.csrfToken,
  renewCsrfToken: props.renewCsrfToken
});
const standaloneFileWindow = createStandaloneFileWindowService();
const workspaceFileTabService = createWorkspaceFileTabService();
const fileNavigationHistory = createWorkspaceFileNavigationHistoryService();
let fileOpenGeneration = 0;
const fileNavigationRevision = ref(0);
const canGoFileBack = computed(() => {
  void fileNavigationRevision.value;
  return fileNavigationHistory.canTravel(-1);
});
const canGoFileForward = computed(() => {
  void fileNavigationRevision.value;
  return fileNavigationHistory.canTravel(1);
});
const workspaceFileTabsRef = ref<{
  captureDirtyDrafts(): readonly unknown[];
  cursorPosition(id: number): { readonly line: number; readonly column: number } | undefined;
  navigateTo(id: number, line: number, column?: number): void;
  focusPage(id: number): void;
}>();

function currentFilePosition(): FileNavigationPosition | undefined {
  const tabId = workspaceFileTabService.activeTabId.value;
  if (tabId === undefined) return undefined;
  return { tabId, ...workspaceFileTabsRef.value?.cursorPosition(tabId) };
}

function recordFileNavigation(
  source: FileNavigationPosition | undefined,
  tabId: number,
  line?: number,
  column?: number
): void {
  if (source?.tabId === tabId && line === undefined) return;
  fileNavigationHistory.record(source, {
    tabId,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column })
  });
  fileNavigationRevision.value += 1;
}

function travelFileNavigation(direction: -1 | 1): void {
  const target = fileNavigationHistory.travel(direction, currentFilePosition());
  if (
    target === undefined ||
    !workspaceFileTabService.tabs.value.some((tab) => tab.id === target.tabId)
  )
    return;
  workspaceFileTabService.activate(target.tabId);
  void nextTick(() => {
    if (target.line !== undefined)
      workspaceFileTabsRef.value?.navigateTo(target.tabId, target.line, target.column);
    else workspaceFileTabsRef.value?.focusPage(target.tabId);
  });
  fileNavigationRevision.value += 1;
}
const restoredDirtyDrafts = new Map<string, DirtyTextDraft>();
const filePageFrames = shallowRef<readonly PreviewFrame[]>([]);
const activePreviewId = computed(() => workspaceFileTabService.activeTabId.value);
const activePreview = computed(() =>
  filePageFrames.value.find((preview) => preview.id === activePreviewId.value)
);
const visiblePreview = computed<LoadedPreviewFrame | undefined>(() => {
  const preview = activePreview.value;
  return preview?.fileContent.value === undefined ? undefined : (preview as LoadedPreviewFrame);
});
const workspaceFileTabs = workspaceFileTabService.tabs;
const predictionAttention = new PromptPredictionAttentionService();
watch(
  () => props.predictionEnabled,
  (enabled) => {
    if (!enabled) predictionAttention.clear();
  }
);
function recordPredictionAttention(
  tab: WorkspaceFileTab,
  range?: { startLine: number; endLine: number },
  revision?: string
): void {
  if (
    !props.predictionEnabled ||
    tab.gitFile === true ||
    tab.id !== workspaceFileTabService.activeTabId.value ||
    document.visibilityState !== 'visible' ||
    !document.hasFocus()
  )
    return;
  const isFile = tab.kind === 'WORKTREE_TEXT' || tab.kind === 'HISTORY_TEXT';
  predictionAttention.record(`${props.nodeId}:${props.workspaceId}`, {
    kind: isFile ? 'FILE' : 'DIFF',
    path: tab.path,
    worktreePath: tab.worktreePath,
    ...(range ?? {}),
    ...(revision ? { revision } : {}),
    ...(isFile
      ? {}
      : {
          source:
            tab.kind === 'HISTORY_DIFF'
              ? ('HISTORY' as const)
              : tab.kind === 'TOOL_CHANGE_DIFF'
                ? ('TOOL_CHANGE' as const)
                : ('WORKING_TREE' as const)
        })
  });
}
const activeWorkspaceFileTabId = workspaceFileTabService.activeTabId;
const activeDiffTab = computed(() => {
  const tab = workspaceFileTabService.activeTab.value;
  return tab?.kind === 'WORKTREE_DIFF' || tab?.kind === 'HISTORY_DIFF' ? tab : undefined;
});
const fileContent = computed(() => activePreview.value?.fileContent.value);
const previewWorktreePath = computed(() => activePreview.value?.worktreePath.value);
const previewTargetLine = computed(() => activePreview.value?.targetLine.value);
const filePreviews = createWorkspaceFilePreviewService({
  http,
  transfers: () => ({
    directFileReadRange: props.directFileReadRange,
    directFileObjectUrl: props.directFileObjectUrl,
    directFileDownload: props.directFileDownload,
    directGitFileReadRange: props.directGitFileReadRange,
    directGitFileObjectUrl: props.directGitFileObjectUrl,
    directGitFileDownload: props.directGitFileDownload
  }),
  onFailure: (error, target) =>
    markFailure(
      error,
      translate('generated.workspaceInspector.files'),
      filePreviewErrorMessage(error, target.path)
    ),
  onWritten: (target) => {
    if (
      inspectorDisposed ||
      target.nodeId !== props.nodeId ||
      target.workspaceId !== props.workspaceId
    )
      return;
    void refreshFileTree();
    if (props.workspaceKind === 'GIT_WORKSPACE') void loadChanges();
  }
});
const git = createWorkspaceGitService({
  http,
  target: fileOperationTarget,
  gitEnabled: () => props.workspaceKind === 'GIT_WORKSPACE',
  historyEnabled: () => historyAvailable.value,
  onWorkspace: (workspace) => emit('workspace', workspace),
  onBranch: (workspaceId, branch) => emit('branch', workspaceId, branch),
  onFailure: (error, operation) =>
    markFailure(
      error,
      translate(
        {
          CHANGES: 'generated.workspaceInspector.gitChanges',
          HISTORY: 'generated.workspaceInspector.gitHistory',
          FILES: 'generated.workspaceInspector.commitFiles',
          RESTORE: 'generated.workspaceInspector.revertingChanges'
        }[operation]
      )
    )
});
const changes = git.changes;
const unavailable = ref(false);
const filesRefreshing = ref(false);
const filesBusy = computed(() => filesRefreshing.value);
const activeSection = ref<InspectorSection>('files');
const fileDisplayFilter = ref('');
const contentQuery = ref('');
const contentUseRegex = ref(false);
const contentSearch = createWorkspaceContentSearchService({
  http,
  onFailure: (error) => markFailure(error, translate('generated.workspaceInspector.contentSearch'))
});
const contentAppliedQuery = contentSearch.appliedQuery;
const contentAppliedUseRegex = contentSearch.appliedUseRegex;
const contentMatches = contentSearch.matches;
const contentSearchLoading = contentSearch.loading;
const contentSearchTruncated = contentSearch.truncated;
const contentSearchInput = ref<HTMLInputElement>();
const codeNavigation = createWorkspaceCodeNavigationService({
  http,
  onFailure: (error) => markFailure(error, translate('fileEditor.definitions')),
  onFileTarget: (target, pageId) => {
    const preview = filePageFrames.value.find((candidate) => candidate.id === pageId);
    if (preview !== undefined) openNavigationTarget(target, preview);
  }
});
const historyRepositoryPath = git.historyRepositoryPath;
const selectedHistoryRefs = git.selectedHistoryRefs;
const historyCommits = git.historyCommits;
const historyNextCursor = git.historyNextCursor;
const uploadInput = ref<HTMLInputElement>();
const fileTreeView = ref<{ reveal(path: string, current?: () => boolean): Promise<void> }>();
const uploadDialogOpen = ref(false);
const pendingUploads = ref<PendingUpload[]>([]);
const pendingUploadDirectory = ref('.');
const preparingUploads = ref(false);
let uploadGeneration = 0;
let inspectorGeneration = 0;
let inspectorDisposed = false;
let appliedFilesWatchRevision = -1;
const visibleChanges = git.visibleChanges;
const diffFiles = computed(() => visibleChanges.value.filter((entry) => entry.diffAvailable));
const historyAvailable = computed(
  () => props.workspaceKind === 'GIT_WORKSPACE' && props.historyCapability === true
);
const previewFileWriteEnabled = (preview: PreviewFrame): boolean =>
  props.fileWriteEnabled &&
  preview.historySource === undefined &&
  preview.worktreePath.value === undefined &&
  preview.repositoryPath === undefined &&
  !isComposerAttachmentResourcePath(preview.fileContent.value?.path ?? '');
const previewKind = computed<FilePreviewKind>(() => {
  if (fileContent.value === undefined) return 'unsupported';
  return filePreviewKind(fileContent.value.path, fileContent.value.encoding);
});

function previewKindFor(preview: PreviewFrame): FilePreviewKind {
  const file = preview.fileContent.value;
  return file === undefined ? 'unsupported' : filePreviewKind(file.path, file.encoding);
}

function createPreviewFrame(id: number): PreviewFrame {
  const page = filePreviews.page(id);
  const navigation = codeNavigation.page(id);
  return {
    ...page,
    id,
    get repositoryPath() {
      return page.target.value?.repositoryPath;
    },
    worktreePath: computed(() => page.target.value?.worktreePath),
    get historySource() {
      return page.target.value?.history;
    },
    targetLine: ref<number>(),
    targetColumn: ref<number>(),
    ...navigation
  };
}

const base = computed(() => {
  if (props.nodeId === undefined || props.workspaceId === undefined) return undefined;
  return `/api/workspaces/${encodeURIComponent(props.workspaceId)}`;
});
const ready = computed(() => props.enabled && base.value !== undefined && !unavailable.value);

const fileTree = createWorkspaceFileTreeService({
  workspaceName: () => props.workspaceName,
  list: listTreeDirectory
});

async function searchContent(): Promise<void> {
  if (!props.contentSearchEnabled || props.nodeId === undefined || props.workspaceId === undefined)
    return;
  await contentSearch.search({
    nodeId: props.nodeId,
    workspaceId: props.workspaceId,
    query: contentQuery.value,
    useRegex: contentUseRegex.value
  });
}

function openSearch(): void {
  if (!props.contentSearchEnabled) return;
  activeSection.value = 'search';
  void nextTick(() => contentSearchInput.value?.focus());
}

function contentMatchFragments(
  preview: string
): readonly { readonly text: string; readonly match: boolean }[] {
  if (contentAppliedUseRegex.value) return [{ text: preview, match: false }];
  const index = preview.toLocaleLowerCase().indexOf(contentAppliedQuery.value.toLocaleLowerCase());
  if (index < 0 || contentAppliedQuery.value === '') return [{ text: preview, match: false }];
  const end = index + contentAppliedQuery.value.length;
  return [
    { text: preview.slice(0, index), match: false },
    { text: preview.slice(index, end), match: true },
    { text: preview.slice(end), match: false }
  ].filter((fragment) => fragment.text !== '');
}

function chooseUploadFiles(): void {
  uploadInput.value?.click();
}

async function prepareUploads(
  files: Iterable<File>,
  directory = fileTree.uploadDirectory()
): Promise<void> {
  const target = fileOperationTarget();
  if (target === undefined) return;
  const selected = [...files];
  if (selected.length === 0) return;
  const generation = ++uploadGeneration;
  preparingUploads.value = true;
  try {
    const uploads = await fileOperations.preflight(
      target,
      directory,
      selected.map((file) => file.name)
    );
    if (generation !== uploadGeneration) return;
    pendingUploads.value = selected.map((file, index) => ({
      ...uploads[index]!,
      id: crypto.randomUUID(),
      file,
      overwrite: false
    }));
    pendingUploadDirectory.value = directory;
    uploadDialogOpen.value = true;
  } catch (error) {
    if (generation === uploadGeneration)
      markFailure(error, translate('generated.workspaceInspector.uploadPreflight'));
  } finally {
    if (generation === uploadGeneration) preparingUploads.value = false;
  }
}

function onUploadFiles(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.files !== null) void prepareUploads(input.files);
  input.value = '';
}

function onTreeFileDrop(directory: string, files: readonly File[]): void {
  if (files.length === 0) {
    emit(
      'notice',
      translate('generated.workspaceInspector.onlyFilesCanBeDroppedCompressFolders'),
      'warning'
    );
    return;
  }
  void prepareUploads(files, directory);
}

function confirmUploads(): void {
  const accepted = pendingUploads.value
    .filter(
      (entry) => entry.status === 'READY' || (entry.status === 'EXISTS_FILE' && entry.overwrite)
    )
    .map((entry) => ({
      file: entry.file,
      directory: pendingUploadDirectory.value,
      overwrite: entry.overwrite
    }));
  const blocked = pendingUploads.value.length - accepted.length;
  if (accepted.length > 0) emit('uploads', accepted);
  if (blocked > 0)
    emit(
      'notice',
      translate('generated.workspaceInspector.filesWereNotUploadedBecauseOfConflicts', {
        value0: blocked
      }),
      'warning'
    );
  uploadDialogOpen.value = false;
  pendingUploads.value = [];
}

function markFailure(error: unknown, action: string, summary?: string): void {
  const code = errorCode(error);
  if (code === 'CAPABILITY_UNAVAILABLE') {
    unavailable.value = true;
    git.reset(true);
    return;
  }
  emit(
    'notice',
    translate('generated.workspaceInspector.unableToLoad', {
      value0: action,
      value1: errorMessage(error, summary)
    }),
    'error',
    error
  );
}

async function listTreeDirectory(path: string, cursor?: string): Promise<WorkspaceFileTreePage> {
  if (inspectorDisposed || !ready.value || base.value === undefined)
    throw new Error('FILE_TREE_NOT_READY');
  const generation = inspectorGeneration;
  const requestBase = base.value;
  const requestNodeId = props.nodeId ?? '';
  try {
    return await fileOperations.list(
      { nodeId: requestNodeId, workspaceId: props.workspaceId ?? '' },
      path,
      cursor
    );
  } catch (error) {
    if (
      generation === inspectorGeneration &&
      requestBase === base.value &&
      errorCode(error) !== 'FILE_NOT_FOUND'
    )
      markFailure(error, 'Files');
    throw error;
  }
}

async function refreshFileTree(): Promise<void> {
  if (inspectorDisposed) return;
  const page = await fileTree.refresh();
  if (page?.workspace !== undefined) emit('workspace', page.workspace);
}

const filesRefreshTask = createTrailingTask(async () => {
  filesRefreshing.value = true;
  try {
    await refreshFileTree();
  } finally {
    filesRefreshing.value = false;
  }
});

async function open(
  entry: FileEntry,
  targetLine?: number,
  worktreePath?: string,
  serverOnly = false,
  stacked = false,
  existingPreview?: PreviewFrame,
  targetColumn?: number,
  repositoryPath?: string
): Promise<void> {
  if (entry.kind === 'DIRECTORY') return;
  if (!ready.value || base.value === undefined) return;
  const textPreview = shouldReadTextFilePreview(entry.path);
  const tab = workspaceFileTabService.open({
    kind: textPreview ? 'WORKTREE_TEXT' : 'WORKTREE_PREVIEW',
    nodeId: props.nodeId ?? '',
    workspaceId: props.workspaceId ?? '',
    path: entry.path,
    repositoryPath: repositoryPath ?? '',
    ...(repositoryPath === undefined ? {} : { gitFile: true }),
    worktreePath: worktreePath ?? '',
    ...(targetLine === undefined ? {} : { targetLine }),
    ...(targetColumn === undefined ? {} : { targetColumn })
  });
  const preview =
    existingPreview ??
    filePageFrames.value.find((candidate) => candidate.id === tab.id) ??
    createPreviewFrame(tab.id);
  if (existingPreview === undefined) {
    clearCodeNavigation();
    if (!filePageFrames.value.includes(preview))
      filePageFrames.value = [...filePageFrames.value, preview];
  }
  codeNavigation.clear(preview.id);
  preview.targetLine.value = targetLine;
  preview.targetColumn.value = targetColumn;
  const target = {
    nodeId: props.nodeId ?? '',
    workspaceId: props.workspaceId ?? '',
    path: entry.path,
    ...(worktreePath === undefined ? {} : { worktreePath }),
    ...(repositoryPath === undefined ? {} : { repositoryPath })
  };
  const opened = await filePreviews.open(
    preview.id,
    {
      ...target
    },
    { textPreview, serverOnly, ...(entry.size === null ? {} : { size: entry.size }) }
  );
  if (
    target.nodeId === props.nodeId &&
    target.workspaceId === props.workspaceId &&
    opened?.encoding === 'utf-8' &&
    filePageFrames.value.includes(preview) &&
    worktreePath === undefined &&
    repositoryPath === undefined
  )
    prewarmCodeNavigation(entry.path, target.nodeId);
}

function workspaceFileContentUrl(
  path: string,
  worktreePath = previewWorktreePath.value,
  download = false,
  repositoryPath?: string
): string {
  if (props.nodeId === undefined || props.workspaceId === undefined)
    throw new Error('NODE_RESPONSE_INVALID');
  return workspaceFilePreviewUrl(
    {
      nodeId: props.nodeId,
      workspaceId: props.workspaceId,
      path,
      ...(worktreePath === undefined ? {} : { worktreePath }),
      ...(repositoryPath === undefined ? {} : { repositoryPath })
    },
    download
  );
}

function navigationSource() {
  const preview = activePreview.value;
  if (
    !props.codeNavigationEnabled ||
    preview?.repositoryPath !== undefined ||
    preview?.worktreePath.value !== undefined ||
    preview?.fileContent.value === undefined ||
    props.nodeId === undefined ||
    props.workspaceId === undefined
  )
    return undefined;
  return {
    pageId: preview.id,
    nodeId: props.nodeId,
    workspaceId: props.workspaceId,
    path: preview.fileContent.value.path
  };
}

async function navigateSymbol(symbol: string): Promise<void> {
  const source = navigationSource();
  if (source !== undefined && symbol.length > 0) await codeNavigation.navigate(source, { symbol });
}

async function navigateFile(request: FileNavigationRequest): Promise<void> {
  const source = navigationSource();
  if (source !== undefined && request.reference.value.length > 0)
    await codeNavigation.navigate(source, request);
}

function prewarmCodeNavigation(path: string, requestNodeId: string): void {
  if (!props.codeNavigationPrewarmEnabled || props.workspaceId === undefined) return;
  void codeNavigation.prewarm({ nodeId: requestNodeId, workspaceId: props.workspaceId, path });
}

function openNavigationTarget(target: NavigationTarget, preview = activePreview.value): void {
  if (preview === undefined) return;
  const source = currentFilePosition();
  clearCodeNavigation(preview);
  if (preview.fileContent.value?.path === target.path) {
    preview.targetLine.value = target.line;
    preview.targetColumn.value = target.column;
    workspaceFileTabsRef.value?.navigateTo(preview.id, target.line, target.column);
    recordFileNavigation(source, preview.id, target.line, target.column);
    return;
  }
  void openFile(target.path, target.line, target.column);
}

function clearCodeNavigation(preview = activePreview.value): void {
  codeNavigation.clear(preview?.id);
}

function textLineCount(content: string): number {
  return content.length === 0 ? 0 : content.split('\n').length;
}

function openWorkspaceFile(
  path: string,
  line?: number,
  worktreePath?: string,
  stacked = false,
  column?: number,
  repositoryPath?: string
): Promise<void> {
  const name = path.split('/').at(-1) ?? path;
  return open(
    { path, name, kind: 'FILE', size: null },
    line,
    worktreePath,
    false,
    stacked,
    undefined,
    column,
    repositoryPath
  );
}

function openWorkspaceFileTab(intent: WorkspaceFileOpenIntent): void {
  const source = currentFilePosition();
  const tab = workspaceFileTabService.open(intent);
  recordFileNavigation(source, tab.id, intent.targetLine, intent.targetColumn);
}

async function reloadPreviewFile(preview: PreviewFrame): Promise<void> {
  const path = preview.fileContent.value?.path;
  if (path === undefined) return;
  const position = workspaceFileTabsRef.value?.cursorPosition(preview.id);
  await openWorkspaceFile(path, position?.line, preview.worktreePath.value, true, position?.column);
}

function openTreeFile(node: WorkspaceFileTreeNode): Promise<void> {
  return openFile(node.path);
}

async function openFile(path: string, line?: number, column?: number): Promise<void> {
  const navigation = ++fileOpenGeneration;
  const generation = inspectorGeneration;
  const nodeId = props.nodeId;
  const workspaceId = props.workspaceId;
  const source = currentFilePosition();
  if (
    (isComposerAttachmentResourcePath(path) || path.startsWith('.mar/temp-files/')) &&
    base.value !== undefined
  ) {
    try {
      await filePreviews.checkReadable({
        nodeId: nodeId ?? '',
        workspaceId: workspaceId ?? '',
        path
      });
    } catch (error) {
      if (generation === inspectorGeneration && navigation === fileOpenGeneration)
        markFailure(
          error,
          translate('generated.workspaceInspector.files'),
          filePreviewErrorMessage(error, path)
        );
      return;
    }
    if (generation !== inspectorGeneration || navigation !== fileOpenGeneration) return;
  }
  activeSection.value = 'files';
  const existing = filePageFrames.value.find(
    (preview) =>
      preview.worktreePath.value === undefined && preview.fileContent.value?.path === path
  );
  if (existing !== undefined) {
    workspaceFileTabService.activate(existing.id);
    existing.targetLine.value = line;
    existing.targetColumn.value = column;
  }
  const opening =
    existing === undefined
      ? openWorkspaceFile(path, line, undefined, true, column)
      : Promise.resolve();
  const targetId =
    existing?.id ??
    filePageFrames.value.find(
      (preview) =>
        preview.worktreePath.value === undefined && preview.fileContent.value?.path === path
    )?.id;
  const current = () =>
    navigation === fileOpenGeneration &&
    generation === inspectorGeneration &&
    nodeId === props.nodeId &&
    workspaceId === props.workspaceId &&
    targetId !== undefined &&
    workspaceFileTabService.activeTabId.value === targetId;
  if (current() && targetId !== undefined) {
    recordFileNavigation(source, targetId, line, column);
    void nextTick(() => {
      if (!current()) return;
      if (existing !== undefined && line !== undefined)
        workspaceFileTabsRef.value?.navigateTo(targetId, line, column);
      workspaceFileTabsRef.value?.focusPage(targetId);
    });
  }
  void (async () => {
    try {
      await fileTree.reveal(path, current);
      if (!current()) return;
      fileTree.selectPath(path);
      await fileTreeView.value?.reveal(path, current);
    } catch (error) {
      if (current()) emit('notice', errorMessage(error), 'error', error);
    }
  })();
  await opening;
}

function openWorkspaceFileExternal(
  path: string,
  line?: number,
  column?: number,
  renderedPreview: 'markdown' | 'html' | undefined = undefined,
  worktreePath?: string,
  repositoryPath?: string
): void {
  if (props.nodeId === undefined || props.workspaceId === undefined) return;
  const parameters = new URLSearchParams({
    standaloneFile: '1',
    nodeId: props.nodeId,
    workspaceId: props.workspaceId,
    path,
    rawContent: '1',
    ...(props.fileWriteEnabled && worktreePath === undefined && repositoryPath === undefined
      ? { write: '1' }
      : {}),
    ...(repositoryPath === undefined ? {} : { repositoryPath }),
    ...(worktreePath === undefined ? {} : { worktreePath }),
    ...(renderedPreview === 'markdown' ? { markdownPreview: '1' } : {}),
    ...(renderedPreview === 'html' ? { htmlPreview: '1' } : {}),
    ...(line === undefined ? {} : { line: String(line) }),
    ...(column === undefined ? {} : { column: String(column) })
  });
  const popup = standaloneFileWindow.open(`/console?${parameters.toString()}`);
  if (popup === undefined)
    emit(
      'notice',
      translate('generated.workspaceInspector.theBrowserBlockedTheFilePreviewWindow'),
      'error'
    );
}

function openGitDiffExternal(intent: WorkspaceFileOpenIntent): void {
  if (intent.kind !== 'WORKTREE_DIFF' && intent.kind !== 'HISTORY_DIFF') return;
  if (props.nodeId === undefined || props.workspaceId === undefined) return;
  const parameters = new URLSearchParams({
    standaloneFile: '1',
    nodeId: props.nodeId,
    workspaceId: props.workspaceId,
    fileTabKind: intent.kind,
    ...(intent.gitFile ? { gitFile: '1' } : {}),
    path: intent.path,
    ...(intent.repositoryPath === '' ? {} : { repositoryPath: intent.repositoryPath }),
    ...(intent.worktreePath === '' ? {} : { worktreePath: intent.worktreePath }),
    ...(intent.commit === undefined ? {} : { commit: intent.commit }),
    ...(intent.previousPath === undefined ? {} : { previousPath: intent.previousPath })
  });
  for (const refName of intent.refs ?? []) parameters.append('refs', refName);
  for (const candidatePath of intent.paths ?? [intent.path])
    parameters.append('paths', candidatePath);
  if (standaloneFileWindow.open(`/console?${parameters.toString()}`) === undefined)
    emit(
      'notice',
      translate('generated.workspaceInspector.theBrowserBlockedTheFilePreviewWindow'),
      'error'
    );
}

function openCurrentRenderedPreview(): boolean {
  if (fileContent.value === undefined) return false;
  const path = fileContent.value.path;
  const preview = isMarkdownFile(path) ? 'markdown' : isHtmlFile(path) ? 'html' : undefined;
  if (preview === undefined || activePreview.value?.repositoryPath !== undefined) return false;
  if (preview === 'html' && activePreview.value?.worktreePath.value !== undefined) return false;
  openWorkspaceFileExternal(
    path,
    previewTargetLine.value,
    undefined,
    preview,
    activePreview.value?.worktreePath.value,
    activePreview.value?.repositoryPath
  );
  return true;
}

function childPath(directory: string, name: string): string {
  return directory === '.' ? name : `${directory}/${name}`;
}

function fileOperationTarget(): WorkspaceFileOperationTarget | undefined {
  if (
    inspectorDisposed ||
    !ready.value ||
    props.nodeId === undefined ||
    props.workspaceId === undefined
  )
    return undefined;
  return { nodeId: props.nodeId, workspaceId: props.workspaceId };
}
const fileOperations = createWorkspaceFileOperationService({
  http,
  onWritten: async (target) => {
    if (
      inspectorDisposed ||
      target.nodeId !== props.nodeId ||
      target.workspaceId !== props.workspaceId
    )
      return;
    await refreshFileTree();
    if (target.nodeId !== props.nodeId || target.workspaceId !== props.workspaceId) return;
    if (props.workspaceKind === 'GIT_WORKSPACE') await git.loadChanges();
  }
});
async function mutateFile(
  action: 'CREATE_FILE' | 'CREATE_DIRECTORY' | 'MOVE' | 'DELETE',
  path: string,
  destination?: string
): Promise<string | undefined> {
  const target = fileOperationTarget(),
    generation = inspectorGeneration;
  if (target === undefined) return undefined;
  const result = await fileOperations.mutate(target, action, path, destination);
  return generation === inspectorGeneration ? result : undefined;
}

async function promptName(title: string, initialValue = ''): Promise<string | undefined> {
  try {
    const result = await ElMessageBox.prompt('', title, {
      closeIcon: marIcon('close'),
      inputValue: initialValue,
      inputPlaceholder: translate('generated.workspaceInspector.enterAName'),
      confirmButtonText: translate('generated.workspaceInspector.confirm'),
      cancelButtonText: translate('generated.workspaceInspector.cancel'),
      inputValidator: (value) =>
        value.trim().length > 0 &&
        value === value.trim() &&
        !value.includes('/') &&
        !value.includes('\\') &&
        value !== '.' &&
        value !== '..' &&
        value !== '.git'
          ? true
          : translate('generated.workspaceInspector.enterAValidSingleLevelName')
    });
    return result.value;
  } catch {
    return undefined;
  }
}

async function onFileTreeAction(
  action:
    | 'OPEN'
    | 'OPEN_EXTERNAL'
    | 'CREATE_FILE'
    | 'CREATE_DIRECTORY'
    | 'DOWNLOAD'
    | 'COPY_PATH'
    | 'RENAME'
    | 'DELETE'
    | 'UPLOAD',
  node: WorkspaceFileTreeNode
): Promise<void> {
  const generation = inspectorGeneration;
  const current = () => generation === inspectorGeneration;
  try {
    if (action === 'OPEN') {
      await openTreeFile(node);
      return;
    }
    if (action === 'OPEN_EXTERNAL') {
      openWorkspaceFileExternal(node.path);
      return;
    }
    if (action === 'COPY_PATH') {
      await navigator.clipboard.writeText(node.path);
      emit('notice', translate('generated.workspaceInspector.relativePathCopied'), 'info');
      return;
    }
    if (action === 'DOWNLOAD') {
      await downloadFile(node.path);
      return;
    }
    if (action === 'UPLOAD') {
      fileTree.select(node);
      chooseUploadFiles();
      return;
    }
    if (action === 'CREATE_FILE' || action === 'CREATE_DIRECTORY') {
      const name = await promptName(
        action === 'CREATE_FILE'
          ? translate('generated.workspaceInspector.newFile')
          : translate('generated.workspaceInspector.newFolder')
      );
      if (name === undefined || !current()) return;
      const created = await mutateFile(action, childPath(node.path, name));
      if (created !== undefined) {
        await fileTree.reveal(created);
        if (!current()) return;
        fileTree.selectPath(created);
        await fileTreeView.value?.reveal(created, current);
      }
      return;
    }
    if (action === 'RENAME') {
      const name = await promptName(translate('generated.workspaceInspector.rename'), node.name);
      if (name === undefined || name === node.name || !current()) return;
      const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '.';
      const previousSelection = fileTree.selectedPath.value;
      const renamed = await mutateFile('MOVE', node.path, childPath(parent, name));
      if (renamed !== undefined) {
        const selected = movedSelectionPath(previousSelection, node.path, renamed);
        await fileTree.reveal(selected);
        if (!current()) return;
        fileTree.selectPath(selected);
        await fileTreeView.value?.reveal(selected, current);
      }
      return;
    }
    await ElMessageBox.confirm(
      node.kind === 'DIRECTORY'
        ? translate('generated.workspaceInspector.deleteFolderAndAllOfItsContents', {
            value0: node.name
          })
        : translate('generated.workspaceInspector.deleteFile', { value0: node.name }),
      translate('generated.workspaceInspector.confirmDeletion'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('generated.workspaceInspector.delete'),
        cancelButtonText: translate('generated.workspaceInspector.cancel2')
      }
    );
    if (!current()) return;
    const selected = fileTree.selectedPath.value;
    const deletingSelection =
      selected === node.path || (selected !== undefined && selected.startsWith(`${node.path}/`));
    await mutateFile('DELETE', node.path);
    if (!current()) return;
    if (deletingSelection) {
      closeAllFilePreviews();
    }
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    if (current()) markFailure(error, translate('generated.workspaceInspector.fileOperation'));
  }
}

async function moveTreeNode(
  source: WorkspaceFileTreeNode,
  directory: WorkspaceFileTreeNode
): Promise<void> {
  const generation = inspectorGeneration;
  const current = () => generation === inspectorGeneration;
  try {
    const previousSelection = fileTree.selectedPath.value;
    const moved = await mutateFile('MOVE', source.path, childPath(directory.path, source.name));
    if (moved !== undefined) {
      const selected = movedSelectionPath(previousSelection, source.path, moved);
      await fileTree.reveal(selected);
      if (!current()) return;
      fileTree.selectPath(selected);
      await fileTreeView.value?.reveal(selected, current);
    }
  } catch (error) {
    if (current()) markFailure(error, translate('generated.workspaceInspector.movingFile'));
  }
}

function movedSelectionPath(
  selected: string | undefined,
  source: string,
  destination: string
): string {
  if (selected === source) return destination;
  return selected?.startsWith(`${source}/`)
    ? `${destination}${selected.slice(source.length)}`
    : destination;
}

async function openWorkspaceFileComparison(
  path: string,
  line?: number,
  column?: number
): Promise<void> {
  if (props.workspaceKind === 'GIT_WORKSPACE') {
    await loadChanges();
    const entry = diffFiles.value.find((candidate) => workspaceChangePath(candidate) === path);
    if (entry?.diffAvailable === true) {
      await openChangeDiff(entry);
      return;
    }
  }
  await openFile(path, line, column);
}

async function revealAndOpenWorkspaceFile(path: string, line?: number): Promise<void> {
  activeSection.value = 'files';
  await fileTree.reveal(path);
  fileTree.selectPath(path);
  await fileTreeView.value?.reveal(path);
  await openWorkspaceFileComparison(path, line);
}

interface WorkspaceInspectorSnapshot extends WorkspaceGitSnapshot {
  readonly activeSection: InspectorSection;
  readonly fileTree: WorkspaceFileTreeSnapshot;
  readonly contentQuery: string;
  readonly contentAppliedQuery: string;
  readonly contentUseRegex: boolean;
  readonly contentAppliedUseRegex: boolean;
  readonly contentMatches: readonly ContentMatch[];
  readonly contentSearchTruncated: boolean;
  readonly fileTabs: WorkspaceFileTabsSnapshot;
  readonly dirtyTextDrafts: readonly DirtyTextDraft[];
}

let pendingWorkspaceRestore:
  | {
      readonly nodeId: string;
      readonly workspaceId: string;
      readonly snapshot: unknown;
    }
  | undefined;

function snapshot(): WorkspaceInspectorSnapshot {
  const drafts = new Map<string, DirtyTextDraft>(
    [...restoredDirtyDrafts.values()].map((draft) => [draft.tabIdentity, draft])
  );
  for (const draft of workspaceFileTabsRef.value?.captureDirtyDrafts() ?? []) {
    if (isDirtyTextDraft(draft)) drafts.set(draft.tabIdentity, draft);
  }
  return {
    activeSection: activeSection.value,
    fileTree: fileTree.snapshot(),
    contentQuery: contentQuery.value,
    contentAppliedQuery: contentAppliedQuery.value,
    contentUseRegex: contentUseRegex.value,
    contentAppliedUseRegex: contentAppliedUseRegex.value,
    contentMatches: [...contentMatches.value],
    contentSearchTruncated: contentSearchTruncated.value,
    ...git.snapshot(),
    fileTabs: workspaceFileTabService.snapshot(),
    dirtyTextDrafts: [...drafts.values()]
  };
}

function restore(snapshot: unknown): void {
  if (typeof snapshot !== 'object' || snapshot === null) return;
  const value = snapshot as Partial<WorkspaceInspectorSnapshot>;
  if (
    value.activeSection !== 'files' &&
    value.activeSection !== 'search' &&
    value.activeSection !== 'changes' &&
    value.activeSection !== 'history'
  )
    return;
  if (typeof value.fileTree !== 'object' || value.fileTree === null) return;
  inspectorGeneration += 1;
  activeSection.value =
    ((value.activeSection === 'changes' || value.activeSection === 'history') &&
      props.workspaceKind !== 'GIT_WORKSPACE') ||
    (value.activeSection === 'history' && !historyAvailable.value) ||
    (value.activeSection === 'search' && !props.contentSearchEnabled)
      ? 'files'
      : value.activeSection;
  fileTree.restore(value.fileTree);
  contentQuery.value = typeof value.contentQuery === 'string' ? value.contentQuery : '';
  contentUseRegex.value = value.contentUseRegex === true;
  contentSearch.restore(value);
  git.restore(value);
  if (
    typeof value.fileTabs === 'object' &&
    value.fileTabs !== null &&
    Array.isArray((value.fileTabs as WorkspaceFileTabsSnapshot).tabs)
  )
    workspaceFileTabService.restore(value.fileTabs as WorkspaceFileTabsSnapshot);
  restoredDirtyDrafts.clear();
  if (Array.isArray(value.dirtyTextDrafts)) {
    for (const draft of value.dirtyTextDrafts) {
      if (
        typeof draft === 'object' &&
        draft !== null &&
        typeof (draft as DirtyTextDraft).tabIdentity === 'string' &&
        typeof (draft as DirtyTextDraft).path === 'string' &&
        typeof (draft as DirtyTextDraft).content === 'string' &&
        typeof (draft as DirtyTextDraft).expectedRevision === 'string'
      )
        restoredDirtyDrafts.set((draft as DirtyTextDraft).tabIdentity, draft as DirtyTextDraft);
    }
  }
  void restoreWorkspaceFileTabs();
  unavailable.value = false;
}

function restoreWorkspace(nodeId: string, workspaceId: string, value: unknown): void {
  if (props.nodeId === nodeId && props.workspaceId === workspaceId) {
    pendingWorkspaceRestore = undefined;
    restore(value);
    return;
  }
  pendingWorkspaceRestore = { nodeId, workspaceId, snapshot: value };
}

function switchWorkspace(): void {
  const pending = pendingWorkspaceRestore;
  pendingWorkspaceRestore = undefined;
  if (
    pending !== undefined &&
    pending.nodeId === props.nodeId &&
    pending.workspaceId === props.workspaceId
  ) {
    restore(pending.snapshot);
    return;
  }
  reset();
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

async function restoreWorkspaceFileTabs(): Promise<void> {
  const activeIdentity = workspaceFileTabService.activeTab.value?.identity;
  for (const tab of workspaceFileTabService.tabs.value) {
    if (tab.kind === 'WORKTREE_TEXT' || tab.kind === 'WORKTREE_PREVIEW') {
      await openWorkspaceFile(
        tab.path,
        tab.targetLine,
        tab.worktreePath === '' ? undefined : tab.worktreePath,
        true,
        tab.targetColumn,
        tab.gitFile ? tab.repositoryPath : undefined
      );
      continue;
    }
    if (tab.kind !== 'HISTORY_TEXT' || tab.commit === undefined) continue;
    const { previousPath: _previousPath, ...historyText } = tab;
    await openHistoryText({
      ...historyText,
      kind: 'HISTORY_DIFF',
      paths: [tab.path]
    });
  }
  const active = workspaceFileTabService.tabs.value.find((tab) => tab.identity === activeIdentity);
  if (active !== undefined) workspaceFileTabService.activate(active.id);
}

defineExpose({
  predictionAttention: () => predictionAttention.snapshot(`${props.nodeId}:${props.workspaceId}`),
  openWorkspaceFile,
  openWorkspaceFileTab,
  openFile,
  openWorkspaceFileComparison,
  openWorkspaceFileExternal,
  openCurrentRenderedPreview,
  revealAndOpenWorkspaceFile,
  openChanges,
  openSearch,
  refreshVisibleSection,
  snapshot,
  restore,
  restoreWorkspace
});

async function savePreviewFile(
  preview: PreviewFrame,
  content: string,
  expectedRevision: string
): Promise<string> {
  if (!ready.value || !props.fileWriteEnabled) throw new Error('FILE_WRITE_INVALID');
  return filePreviews.save(preview.id, content, expectedRevision);
}

async function downloadFile(
  path: string,
  worktreePath?: string,
  preview?: PreviewFrame
): Promise<void> {
  if (!ready.value || props.nodeId === undefined || props.workspaceId === undefined) return;
  try {
    if (preview?.fileContent.value?.path === path) await filePreviews.download(preview.id);
    else
      await filePreviews.downloadTarget({
        nodeId: props.nodeId,
        workspaceId: props.workspaceId,
        path,
        ...(worktreePath === undefined ? {} : { worktreePath })
      });
  } catch (error) {
    markFailure(error, path);
  }
}

async function downloadPreviewFile(preview: PreviewFrame): Promise<void> {
  try {
    await filePreviews.download(preview.id);
  } catch (error) {
    markFailure(error, translate('generated.workspaceInspector.fileDownload'));
  }
}

function closeAllFilePreviews(): void {
  fileOpenGeneration += 1;
  fileNavigationHistory.clear();
  fileNavigationRevision.value += 1;
  for (const preview of filePageFrames.value) {
    filePreviews.close(preview.id);
    workspaceFileTabService.remove(preview.id);
  }
  filePageFrames.value = [];
  codeNavigation.reset();
}

function closeFilePreview(preview: PreviewFrame): void {
  const index = filePageFrames.value.indexOf(preview);
  if (index < 0) return;
  const wasActive = activePreview.value === preview;
  filePreviews.close(preview.id);
  codeNavigation.release(preview.id);
  filePageFrames.value = filePageFrames.value.filter((item) => item !== preview);
  workspaceFileTabService.remove(preview.id);
  fileNavigationHistory.remove(preview.id);
  fileNavigationRevision.value += 1;
  if (wasActive)
    workspaceFileTabService.activate(
      filePageFrames.value.at(index - 1)?.id ?? filePageFrames.value.at(index)?.id ?? -1
    );
}

function activateFilePreview(id: number): void {
  const preview = filePageFrames.value.find((candidate) => candidate.id === id);
  if (preview === undefined || preview === activePreview.value) return;
  workspaceFileTabService.activate(preview.id);
}

function removeWorkspaceFileTab(id: number): void {
  const preview = filePageFrames.value.find((candidate) => candidate.id === id);
  if (preview !== undefined) {
    closeFilePreview(preview);
    return;
  }
  workspaceFileTabService.remove(id);
  fileNavigationHistory.remove(id);
  fileNavigationRevision.value += 1;
}

function closeStandaloneFileWindow(): void {
  if (props.standaloneFileMode === true) window.close();
}

function closeWorkspaceFileTabs(ids: readonly number[]): void {
  for (const id of ids) removeWorkspaceFileTab(id);
}

function activateWorkspaceFileTab(id: number): void {
  const source = currentFilePosition();
  if (id < 0) {
    activateFilePreview(id);
  } else workspaceFileTabService.activate(id);
  if (workspaceFileTabService.activeTabId.value === id) {
    const position = workspaceFileTabsRef.value?.cursorPosition(id);
    recordFileNavigation(source, id, position?.line, position?.column);
  }
}

function downloadDiffContent(diff: unknown, path: string): void {
  const text =
    typeof diff === 'object' &&
    diff !== null &&
    typeof (diff as { readonly text?: unknown }).text === 'string'
      ? (diff as { readonly text: string }).text
      : typeof diff === 'object' &&
          diff !== null &&
          typeof (diff as { readonly summary?: unknown }).summary === 'string'
        ? (diff as { readonly summary: string }).summary
        : translate('generated.workspaceInspector.gitDiffHasNoDownloadableTextContent');
  const blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = `${path.split('/').at(-1) ?? 'changes'}.diff`;
  anchor.click();
  URL.revokeObjectURL(blobUrl);
}

async function openWorktreeDiffText(tab: WorkspaceFileTab): Promise<void> {
  if (tab.kind !== 'WORKTREE_DIFF') return;
  const source = currentFilePosition();
  const repositoryPath = tab.gitFile
    ? tab.repositoryPath
    : gitFileRepositoryPath(tab.repositoryPath, tab.worktreePath || undefined);
  const path =
    repositoryPath !== undefined
      ? tab.path
      : tab.worktreePath === ''
        ? tab.repositoryPath === ''
          ? tab.path
          : `${tab.repositoryPath}/${tab.path}`
        : tab.path;
  await openWorkspaceFile(
    path,
    undefined,
    tab.worktreePath === '' ? undefined : tab.worktreePath,
    true,
    undefined,
    repositoryPath
  );
  const targetId = workspaceFileTabService.activeTabId.value;
  if (targetId !== undefined) recordFileNavigation(source, targetId);
}

function openDiffEditor(tab: WorkspaceFileTab): void {
  if (tab.kind === 'TOOL_CHANGE_DIFF') {
    void openFile(tab.path);
    return;
  }
  if (tab.kind === 'WORKTREE_DIFF') {
    void openWorktreeDiffText(tab);
    return;
  }
  void openHistoryText(tab);
}

async function previewDiffFile(tab: WorkspaceFileTab, diff: unknown): Promise<void> {
  if (tab.kind !== 'HISTORY_DIFF') {
    openDiffEditor(tab);
    return;
  }
  await openHistoryText(tab, diff);
}

async function openHistoryText(tab: WorkspaceFileTab, diff?: unknown): Promise<void> {
  if (tab.kind !== 'HISTORY_DIFF' || tab.commit === undefined || !ready.value) return;
  const source = currentFilePosition();
  const historyTab = workspaceFileTabService.open({
    kind: 'HISTORY_TEXT',
    nodeId: props.nodeId ?? '',
    workspaceId: props.workspaceId ?? '',
    path: tab.path,
    repositoryPath: tab.repositoryPath,
    worktreePath: '',
    commit: tab.commit,
    refs: tab.refs ?? []
  });
  recordFileNavigation(source, historyTab.id);
  const preview =
    filePageFrames.value.find((frame) => frame.id === historyTab.id) ??
    createPreviewFrame(historyTab.id);
  codeNavigation.clear(preview.id);
  if (!filePageFrames.value.includes(preview))
    filePageFrames.value = [...filePageFrames.value, preview];
  await filePreviews.open(
    historyTab.id,
    {
      nodeId: props.nodeId ?? '',
      workspaceId: props.workspaceId ?? '',
      path: tab.path,
      history: { commit: tab.commit, repositoryPath: tab.repositoryPath, refs: tab.refs ?? [] }
    },
    { textPreview: diff === undefined || !isBinaryDiff(diff) }
  );
}

async function navigateDiffSymbol(tab: WorkspaceFileTab, symbol: string): Promise<void> {
  if (tab.kind !== 'WORKTREE_DIFF') return;
  await openWorktreeDiffText(tab);
  await navigateSymbol(symbol);
}

async function navigateDiffFile(
  tab: WorkspaceFileTab,
  request: FileNavigationRequest
): Promise<void> {
  if (tab.kind !== 'WORKTREE_DIFF') return;
  await openWorktreeDiffText(tab);
  await navigateFile(request);
}

function isBinaryDiff(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly binary?: unknown }).binary === true
  );
}

const loadChanges = git.loadChanges;

function refreshVisibleSection(nodeId: string, workspaceId: string): void {
  if (props.nodeId !== nodeId || props.workspaceId !== workspaceId || !ready.value) return;
  if (activeSection.value === 'files') void filesRefreshTask.request();
  else if (activeSection.value === 'changes') void loadChanges();
}

function openChanges(): void {
  activeSection.value = 'changes';
  void loadChanges();
}

async function openHistory(): Promise<void> {
  activeSection.value = 'history';
  await git.openHistory();
}

async function loadDiff(tab: WorkspaceFileTab, signal?: AbortSignal): Promise<unknown> {
  return tab.kind === 'TOOL_CHANGE_DIFF'
    ? loadToolChangeDiff(tab, (path) => http.request(path), signal)
    : git.loadDiff(tab, signal);
}

function openHistoryDiff(commit: HistoryCommit, file: HistoryFile, external = false): void {
  if (base.value === undefined) return;
  const intent: WorkspaceFileOpenIntent = {
    kind: 'HISTORY_DIFF',
    nodeId: props.nodeId ?? '',
    workspaceId: props.workspaceId ?? '',
    path: file.path,
    repositoryPath: git.historySource.value.repositoryPath,
    worktreePath: '',
    commit: commit.hash,
    ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
    refs: [...git.historySource.value.refs],
    paths: [file.path]
  };
  if (external) {
    openGitDiffExternal(intent);
    return;
  }
  openWorkspaceFileTab(intent);
}

async function moveDiffFile(tab: WorkspaceFileTab, direction: -1 | 1): Promise<void> {
  if (tab.kind !== 'WORKTREE_DIFF') return;
  const files = diffFiles.value.filter(
    (entry) =>
      entry.repositoryPath === tab.repositoryPath && (entry.worktreePath ?? '') === tab.worktreePath
  );
  if (files.length === 0) return;
  const current = files.findIndex((entry) => entry.path === tab.path);
  const target = (Math.max(current, 0) + direction + files.length) % files.length;
  await openChangeDiff(files[target] as ChangeEntry);
}

function changeDiffIntent(entry: ChangeEntry): WorkspaceFileOpenIntent {
  const sameRepositoryPaths = diffFiles.value
    .filter(
      (candidate) =>
        candidate.repositoryPath === entry.repositoryPath &&
        (candidate.worktreePath ?? '') === (entry.worktreePath ?? '')
    )
    .map((candidate) => candidate.path);
  return {
    kind: 'WORKTREE_DIFF',
    ...(gitFileRepositoryPath(entry.repositoryPath, entry.worktreePath) === undefined
      ? {}
      : { gitFile: true }),
    nodeId: props.nodeId ?? '',
    workspaceId: props.workspaceId ?? '',
    path: entry.path,
    repositoryPath: entry.repositoryPath,
    worktreePath: entry.worktreePath ?? '',
    paths: sameRepositoryPaths
  };
}

async function openChangeDiff(entry: ChangeEntry): Promise<void> {
  if (!ready.value || base.value === undefined || !entry.diffAvailable) return;
  const source = currentFilePosition();
  const tab = workspaceFileTabService.open(changeDiffIntent(entry));
  recordFileNavigation(source, tab.id);
}

function refreshFiles(): void {
  void filesRefreshTask.request();
}

function gitFileRepositoryPath(repositoryPath: string, worktreePath?: string): string | undefined {
  if (worktreePath !== undefined) return undefined;
  const root = (changes.value as { repositoryRoot?: unknown } | undefined)?.repositoryRoot;
  return typeof root === 'string' && (repositoryPath !== '' || root !== props.workspacePath)
    ? repositoryPath
    : undefined;
}

function openChange(entry: ChangeEntry, external = false): void {
  const repositoryPath = gitFileRepositoryPath(entry.repositoryPath, entry.worktreePath);
  const path =
    repositoryPath === undefined && entry.worktreePath === undefined
      ? workspaceChangePath(entry)
      : entry.path;
  if (external) {
    if (entry.diffAvailable) openGitDiffExternal(changeDiffIntent(entry));
    else
      openWorkspaceFileExternal(
        path,
        undefined,
        undefined,
        undefined,
        entry.worktreePath,
        repositoryPath
      );
    return;
  }
  if (!entry.diffAvailable) {
    void openWorkspaceFile(path, undefined, entry.worktreePath, false, undefined, repositoryPath);
    return;
  }
  void openChangeDiff(entry);
}

function resetGitState(): void {
  git.reset(true);
  if (activeSection.value === 'changes' || activeSection.value === 'history')
    activeSection.value = 'files';
  for (const preview of [...filePageFrames.value])
    if (
      preview.repositoryPath !== undefined ||
      preview.worktreePath.value !== undefined ||
      preview.historySource !== undefined
    )
      closeFilePreview(preview);
  for (const tab of workspaceFileTabService.tabs.value)
    if (
      tab.gitFile === true ||
      tab.worktreePath !== '' ||
      tab.kind === 'WORKTREE_DIFF' ||
      tab.kind === 'HISTORY_DIFF' ||
      tab.kind === 'HISTORY_TEXT'
    )
      workspaceFileTabService.remove(tab.id);
}

function reset(): void {
  inspectorGeneration += 1;
  closeAllFilePreviews();
  workspaceFileTabService.clear();
  appliedFilesWatchRevision = -1;
  unavailable.value = false;
  activeSection.value = 'files';
  git.reset();
  uploadGeneration += 1;
  preparingUploads.value = false;
  uploadDialogOpen.value = false;
  pendingUploads.value = [];
  contentSearch.reset();
  fileDisplayFilter.value = '';
  contentQuery.value = '';
  contentUseRegex.value = false;
  fileTree.reset();
}

watch(
  [() => props.nodeId, () => props.workspaceId, () => props.workspaceKind],
  ([nodeId, workspaceId, workspaceKind], [previousNodeId, previousWorkspaceId, previousKind]) => {
    if (nodeId !== previousNodeId || workspaceId !== previousWorkspaceId) {
      switchWorkspace();
      return;
    }
    if (workspaceKind !== previousKind) resetGitState();
  }
);
watch(
  () => props.workspaceName,
  (name) => fileTree.setRootName(name)
);
watch(
  () => props.contentSearchEnabled,
  (enabled) => {
    if (!enabled && activeSection.value === 'search') activeSection.value = 'files';
  }
);
watch(activePreviewId, () => codeNavigation.cancel(), { flush: 'sync' });
watch(
  () => props.filesRevision,
  () => {
    if (activeSection.value === 'files') void filesRefreshTask.request();
  }
);
watch(
  () => props.changesRevision,
  () => {
    if (activeSection.value === 'changes') void loadChanges();
  }
);
function applySubscriptionSnapshot(snapshot = props.subscriptionSnapshot): void {
  if (
    snapshot === undefined ||
    snapshot.nodeId !== props.nodeId ||
    snapshot.workspaceId !== props.workspaceId
  )
    return;
  if (
    isFilePage(snapshot.files) &&
    isNewerWatchRevision(snapshot.filesWatchRevision, appliedFilesWatchRevision)
  ) {
    fileTree.applyRootPage(snapshot.files.files);
    const workspace = filePageWorkspace(snapshot.files.workspace);
    if (workspace !== undefined) emit('workspace', workspace);
    appliedFilesWatchRevision = appliedWatchRevision(snapshot.filesWatchRevision);
  }
  if (snapshot.changes !== undefined)
    git.applyWatch(snapshot.changes, snapshot.changesWatchRevision);
}

function isNewerWatchRevision(revision: number | undefined, applied: number): boolean {
  return revision === undefined ? applied < 0 : Number.isInteger(revision) && revision > applied;
}

function appliedWatchRevision(revision: number | undefined): number {
  return revision === undefined || !Number.isInteger(revision) ? 0 : revision;
}
watch(() => props.subscriptionSnapshot, applySubscriptionSnapshot);
onMounted(() => {
  reset();
  applySubscriptionSnapshot();
});
onBeforeUnmount(() => {
  inspectorDisposed = true;
  inspectorGeneration += 1;
  fileTree.reset();
  fileOpenGeneration += 1;
  uploadGeneration += 1;
  git.reset();
  codeNavigation.reset();
  contentSearch.reset();
});
onBeforeUnmount(() => filePreviews.reset());
</script>

<template>
  <article class="info-card workspace-inspector">
    <div class="section-heading">
      <h2>
        {{
          mobileViewport
            ? translate('generated.workspaceInspector.files2')
            : translate('generated.workspaceInspector.filesChanges')
        }}
      </h2>
      <span v-if="unavailable">{{
        translate('generated.workspaceInspector.capabilityUnavailable')
      }}</span>
    </div>
    <p v-if="!enabled" class="empty">
      {{
        capabilityLoading
          ? translate('generated.workspaceInspector.loading')
          : nodeOnline
            ? translate('generated.workspaceInspector.capabilityUnavailable')
            : translate('generated.workspaceInspector.theNodeIsOfflineOrDoesNot')
      }}
    </p>
    <p v-else-if="unavailable" class="empty">
      {{ translate('generated.workspaceInspector.theTargetNodeDoesNotCurrentlySupport') }}
    </p>
    <template v-else>
      <div
        class="inspector-tabs"
        role="tablist"
        :aria-label="translate('generated.workspaceInspector.inspectorContent')"
      >
        <el-button
          :class="{ active: activeSection === 'files' }"
          role="tab"
          :aria-selected="activeSection === 'files'"
          size="small"
          text
          @click="activeSection = 'files'"
        >
          {{ translate('generated.workspaceInspector.files3') }}
        </el-button>
        <el-button
          v-if="contentSearchEnabled"
          :class="{ active: activeSection === 'search' }"
          role="tab"
          :aria-selected="activeSection === 'search'"
          size="small"
          text
          @click="openSearch"
        >
          {{ translate('generated.workspaceInspector.search') }}
        </el-button>
        <el-button
          v-if="workspaceKind === 'GIT_WORKSPACE'"
          :class="{ active: activeSection === 'changes' }"
          role="tab"
          :aria-selected="activeSection === 'changes'"
          size="small"
          text
          @click="openChanges"
        >
          {{ translate('generated.workspaceInspector.gitChanges') }}
        </el-button>
        <el-button
          v-if="historyAvailable"
          :class="{ active: activeSection === 'history' }"
          role="tab"
          :aria-selected="activeSection === 'history'"
          size="small"
          text
          @click="openHistory"
        >
          {{ translate('generated.workspaceInspector.gitHistory') }}
        </el-button>
      </div>
      <p
        v-if="
          (activeSection === 'files' && filesWatchStatus === 'loading') ||
          (activeSection === 'changes' && changesWatchStatus === 'loading')
        "
        class="watch-status"
      >
        {{
          activeSection === 'files'
            ? translate('workspaceWatch.loadingFiles')
            : translate('workspaceWatch.loadingChanges')
        }}
      </p>
      <p
        v-else-if="
          (activeSection === 'files' && filesWatchStatus === 'failed') ||
          (activeSection === 'changes' && changesWatchStatus === 'failed')
        "
        class="watch-status failed"
      >
        {{
          activeSection === 'files'
            ? translate('workspaceWatch.filesFailed')
            : translate('workspaceWatch.changesFailed')
        }}
      </p>
      <template v-if="activeSection === 'files'">
        <section class="file-explorer">
          <div class="explorer-toolbar">
            <input
              ref="uploadInput"
              class="workspace-upload-input"
              type="file"
              multiple
              @change="onUploadFiles"
            />
            <el-input
              v-model="fileDisplayFilter"
              class="file-display-filter"
              :aria-label="translate('workspaceDisplayFilter.label')"
              clearable
              :placeholder="translate('workspaceDisplayFilter.placeholder')"
              size="small"
              :clear-icon="marIcon('clear-input')"
            >
              <template #prefix><MarIcon name="search" /></template>
            </el-input>
            <button
              v-tooltip="translate('generated.workspaceInspector.refreshFiles2')"
              class="file-explorer-utility-button utility-control"
              :disabled="filesBusy"
              :aria-label="translate('generated.workspaceInspector.refreshFiles')"
              :aria-busy="filesBusy || undefined"
              type="button"
              @click="refreshFiles"
            >
              <MarIcon name="loading-action" v-if="filesBusy" />
              <MarIcon name="refresh" v-else />
            </button>
            <button
              v-tooltip="translate('generated.workspaceInspector.uploadFiles2')"
              class="file-explorer-utility-button utility-control"
              :disabled="preparingUploads"
              :aria-label="translate('generated.workspaceInspector.uploadFiles')"
              :aria-busy="preparingUploads || undefined"
              type="button"
              @click="chooseUploadFiles"
            >
              <MarIcon name="loading-action" v-if="preparingUploads" />
              <MarIcon name="document-add" v-else />
            </button>
          </div>
          <WorkspaceFileTree
            ref="fileTreeView"
            :root="fileTree.root.value"
            :filter="fileDisplayFilter"
            :selected-path="fileTree.selectedPath.value"
            :disabled="filesBusy"
            :mutations-enabled="true"
            :mobile-viewport="mobileViewport"
            @toggle="fileTree.toggle"
            @open="openTreeFile"
            @open-external="(node) => openWorkspaceFileExternal(node.path)"
            @action="onFileTreeAction"
            @move="moveTreeNode"
            @load-more="fileTree.loadMore"
            @select="fileTree.select"
            @drop-files="onTreeFileDrop"
            @invalid-drop="
              emit(
                'notice',
                translate('generated.workspaceInspector.foldersCannotBeDroppedCompressThemBefore'),
                'warning'
              )
            "
          />
        </section>
      </template>
      <section v-else-if="activeSection === 'search'" class="content-search">
        <div class="content-search-options">
          <el-checkbox v-model="contentUseRegex" size="small">{{
            translate('generated.workspaceInspector.useRegularExpression')
          }}</el-checkbox>
        </div>
        <form class="explorer-toolbar content-search-toolbar" @submit.prevent="searchContent">
          <el-input
            ref="contentSearchInput"
            v-model="contentQuery"
            :aria-label="translate('generated.workspaceInspector.searchFileContents')"
            maxlength="256"
            :placeholder="translate('generated.workspaceInspector.searchFileContents2')"
            size="small"
          />
          <button
            v-tooltip="translate('generated.workspaceInspector.runContentSearch2')"
            class="content-search-button file-explorer-utility-button utility-control"
            :disabled="contentSearchLoading"
            :aria-label="translate('generated.workspaceInspector.runContentSearch')"
            :aria-busy="contentSearchLoading || undefined"
            type="submit"
          >
            <MarIcon name="loading-action" v-if="contentSearchLoading" />
            <MarIcon name="search" v-else />
          </button>
        </form>
        <p v-if="contentSearchTruncated" class="content-search-warning">
          {{ translate('generated.workspaceInspector.resultsAreIncompleteNarrowTheSearchScope') }}
        </p>
        <ul
          class="content-search-results"
          :aria-label="translate('generated.workspaceInspector.contentSearchResults')"
        >
          <li v-for="match in contentMatches" :key="`${match.path}:${match.line}:${match.column}`">
            <button
              v-tooltip="match.path"
              :aria-label="match.path"
              type="button"
              @click="
                $event.ctrlKey || $event.metaKey
                  ? openWorkspaceFileExternal(match.path, match.line, match.column)
                  : openFile(match.path, match.line, match.column)
              "
            >
              <span class="content-search-name"
                ><FileTypeIcon :name="changeFileName(match.path)" /><strong>{{
                  match.path
                }}</strong></span
              ><small>{{
                translate('generated.workspaceInspector.line', { value0: match.line })
              }}</small>
              <code
                ><template
                  v-for="(fragment, index) in contentMatchFragments(match.preview)"
                  :key="index"
                  ><mark v-if="fragment.match">{{ fragment.text }}</mark
                  ><template v-else>{{ fragment.text }}</template></template
                ></code
              >
            </button>
          </li>
          <li
            v-if="
              contentAppliedQuery !== '' && contentMatches.length === 0 && !contentSearchLoading
            "
            class="file-search-empty"
          >
            {{ translate('generated.workspaceInspector.noMatchingContent') }}
          </li>
        </ul>
      </section>
      <WorkspaceGitChanges
        v-else-if="activeSection === 'changes'"
        :service="git"
        :target="fileOperationTarget()"
        @open="openChange"
        @notice="(value, type, cause) => emit('notice', value, type, cause)"
      />
      <WorkspaceGitHistory
        v-else-if="activeSection === 'history'"
        :service="git"
        @open="openHistoryDiff"
        @notice="(value, type, cause) => emit('notice', value, type, cause)"
      />
    </template>
  </article>
  <Teleport to="body">
    <WorkspaceFileTabs
      v-if="workspaceFileTabs.length > 0"
      ref="workspaceFileTabsRef"
      :tabs="workspaceFileTabs"
      :presentation="standaloneFileMode ? 'window' : 'overlay'"
      :active-tab-id="activeWorkspaceFileTabId"
      :can-go-back="canGoFileBack"
      :can-go-forward="canGoFileForward"
      @back="travelFileNavigation(-1)"
      @forward="travelFileNavigation(1)"
      @activate="activateWorkspaceFileTab"
      @close="removeWorkspaceFileTab"
      @close-all="closeWorkspaceFileTabs"
      @close-last="closeStandaloneFileWindow"
      v-slot="{ tab, active, registerPageHandle, requestClose }"
    >
      <template v-for="preview in filePageFrames" :key="preview.id">
        <WorkspaceTextFilePage
          v-if="
            tab.id === preview.id &&
            preview.fileContent.value !== undefined &&
            previewKindFor(preview) === 'text'
          "
          :ref="registerPageHandle"
          v-show="active"
          :active="active"
          :downloading="preview.downloading.value"
          :file="preview.fileContent.value"
          :kind="previewKindFor(preview)"
          :loading="preview.loading.value"
          :markdown="
            preview.repositoryPath === undefined &&
            preview.worktreePath.value === undefined &&
            preview.fileContent.value.encoding === 'utf-8' &&
            isMarkdownFile(preview.fileContent.value.path)
          "
          :html="
            preview.repositoryPath === undefined &&
            preview.worktreePath.value === undefined &&
            preview.fileContent.value.encoding === 'utf-8' &&
            isHtmlFile(preview.fileContent.value.path)
          "
          :write-enabled="previewFileWriteEnabled(preview)"
          :save-file="
            (content, expectedRevision) => savePreviewFile(preview, content, expectedRevision)
          "
          :target-line="preview.targetLine.value"
          :target-column="preview.targetColumn.value"
          :code-navigation-enabled="
            codeNavigationEnabled &&
            preview.worktreePath.value === undefined &&
            preview.repositoryPath === undefined
          "
          :navigation-loading="preview.navigationLoading.value"
          :navigation-targets="preview.navigationTargets.value"
          :navigation-no-definition="preview.navigationNoDefinition.value"
          :editor-identity="preview.id"
          :tab-identity="tab.identity"
          :initial-dirty-draft="restoredDirtyDrafts.get(tab.identity)"
          @close="requestClose"
          @download="downloadPreviewFile(preview)"
          @open-markdown-preview="
            openWorkspaceFileExternal(
              preview.fileContent.value.path,
              preview.targetLine.value,
              preview.targetColumn.value,
              'markdown'
            )
          "
          @open-html-preview="
            openWorkspaceFileExternal(preview.fileContent.value.path, undefined, undefined, 'html')
          "
          @navigate-symbol="navigateSymbol"
          @navigate-file="navigateFile"
          @dismiss-navigation="clearCodeNavigation(preview)"
          @open-navigation-target="openNavigationTarget($event, preview)"
          @reload="reloadPreviewFile(preview)"
          @dirty-draft-applied="restoredDirtyDrafts.delete($event)"
          @viewed="
            active && recordPredictionAttention(tab, $event, preview.fileContent.value?.revision)
          "
        />
        <WorkspaceFormatFilePage
          v-else-if="tab.id === preview.id && preview.fileContent.value !== undefined"
          :ref="registerPageHandle"
          v-show="active"
          :active="active"
          :content-url="preview.contentUrl.value"
          :downloading="preview.downloading.value"
          :file="preview.fileContent.value"
          :kind="previewKindFor(preview)"
          :loading="preview.loading.value"
          @close="requestClose"
          @download="downloadPreviewFile(preview)"
        />
      </template>
      <WorkspaceGitDiffPage
        v-if="
          tab.kind === 'WORKTREE_DIFF' ||
          tab.kind === 'HISTORY_DIFF' ||
          tab.kind === 'TOOL_CHANGE_DIFF'
        "
        :ref="registerPageHandle"
        v-show="active"
        :active="active"
        :code-navigation-enabled="codeNavigationEnabled && tab.gitFile !== true"
        :load="loadDiff"
        @viewed="active && recordPredictionAttention(tab)"
        :tab="tab"
        @close="requestClose"
        @download="downloadDiffContent($event, tab.path)"
        @edit="openDiffEditor(tab)"
        @load-error="
          markFailure(
            $event,
            tab.kind === 'HISTORY_DIFF'
              ? translate('generated.workspaceInspector.historicalFileDiff')
              : translate('generated.workspaceInspector.fileDiff')
          )
        "
        @move-file="moveDiffFile(tab, $event)"
        @preview="previewDiffFile(tab, $event)"
        @navigate-symbol="navigateDiffSymbol(tab, $event)"
        @navigate-file="navigateDiffFile(tab, $event)"
      />
    </WorkspaceFileTabs>
  </Teleport>
  <el-dialog
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    v-if="uploadDialogOpen"
    v-model="uploadDialogOpen"
    class="upload-confirm-dialog"
    :title="translate('generated.workspaceInspector.confirmFileUpload')"
    append-to-body
    width="560px"
    :close-icon="marIcon('close')"
  >
    <p class="upload-dialog-target">
      {{ translate('generated.workspaceInspector.targetDirectory') }}:
      <code>{{ pendingUploadDirectory }}</code>
    </p>
    <ul class="upload-dialog-list">
      <li v-for="entry in pendingUploads" :key="entry.id">
        <span
          ><strong>{{ entry.file.name }}</strong
          ><small>{{ fileSizeLabel(entry.file.size) }}</small></span
        >
        <el-select
          v-if="entry.status === 'EXISTS_FILE'"
          v-model="entry.overwrite"
          :aria-label="translate('generated.workspaceInspector.existingFileHandling')"
          size="small"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
        >
          <el-option :value="false" :label="translate('generated.workspaceInspector.skip')" />
          <el-option :value="true" :label="translate('generated.workspaceInspector.overwrite')" />
        </el-select>
        <small v-else-if="entry.status === 'READY'">{{
          translate('generated.workspaceInspector.newFile2')
        }}</small>
        <small v-else
          >{{ translate('generated.workspaceInspector.cannotUpload') }}:
          {{
            entry.status === 'EXISTS_DIRECTORY'
              ? translate('generated.workspaceInspector.aDirectoryHasTheSameName')
              : translate('generated.workspaceInspector.invalidNameOrDuplicateInBatch')
          }}</small
        >
      </li>
    </ul>
    <template #footer>
      <el-button @click="uploadDialogOpen = false">{{
        translate('generated.workspaceInspector.cancel4')
      }}</el-button>
      <el-button type="primary" @click="confirmUploads">{{
        translate('generated.workspaceInspector.startUpload')
      }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.workspace-inspector.info-card {
  display: flex;
  height: 100%;
  min-height: 100%;
  flex-direction: column;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0.55rem 0.7rem 0.7rem;
}

.workspace-inspector > .section-heading h2 {
  margin-bottom: 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  font-weight: 500;
  line-height: 1.4;
}

@media (max-width: 1180px) {
  .workspace-inspector.info-card {
    height: auto;
    min-height: auto;
  }
}

@media (max-width: 767px) {
  .workspace-inspector.info-card {
    height: 100%;
    min-height: 100%;
    max-height: none;
  }
  :global(.upload-confirm-dialog.el-dialog),
  :global(.upload-confirm-dialog .el-dialog) {
    width: calc(100vw - 32px) !important;
  }
}
</style>

<style scoped>
.inspector-tabs {
  display: flex;
  flex-shrink: 0;
  gap: 0.1rem;
  overflow-x: auto;
  overflow-y: hidden;
  margin: 0.45rem 0 0;
  padding: 0 0.35rem 0.35rem;
  border-bottom: 1px solid var(--mar-border-subtle);
}

.watch-status {
  margin: 0.2rem 0.55rem;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
}

.watch-status.failed {
  color: var(--el-color-warning);
}

.inspector-tabs button {
  position: relative;
  flex-shrink: 0;
  min-height: var(--mar-compact-control-size);
  border: 0;
  border-radius: var(--mar-radius-selection);
  background: transparent;
  color: var(--mar-text-tertiary);
  padding: 0.2rem 0.25rem;
  font-size: calc(var(--mar-font-size-body) - 1px);
  font-weight: 500;
}

@media (min-width: 768px) {
  .inspector-tabs button {
    font-size: var(--mar-font-size-meta);
  }
}

.inspector-tabs button:not(.active):hover:not(:disabled) {
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}

.inspector-tabs button.active,
.inspector-tabs button.active:hover:not(:disabled) {
  background: var(--mar-fill-selection);
  color: var(--mar-text-primary);
}

.content-search {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.content-search-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  margin-top: 0.2rem;
}

.content-search-options {
  margin-top: 0.3rem;
}

.content-search-options :deep(.el-checkbox) {
  height: 1.2rem;
  font-size: var(--mar-font-size-meta);
}

.content-search-warning {
  margin: 0.35rem 0 0;
  color: var(--mar-color-warning-text);
  font-size: var(--mar-font-size-meta);
}

.content-search-results {
  min-height: 0;
  margin: 0.45rem 0 0;
  padding: 0;
  list-style: none;
  overflow: auto;
}

.content-search-results > li + li {
  margin-top: 2px;
}

.content-search-results button {
  display: grid;
  width: 100%;
  grid-template-columns: minmax(0, 1fr) max-content;
  gap: 0.18rem 0.5rem;
  border: 0;
  border-radius: var(--mar-radius-selection);
  background: transparent;
  color: var(--mar-text-primary);
  padding: 0.35rem 0.25rem;
  text-align: left;
  cursor: pointer;
}

.content-search-results button:hover,
.content-search-results button:focus-visible {
  background: var(--mar-fill-row-hover);
}

.content-search-results button:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: -2px;
}

.content-search-results strong,
.content-search-results code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.content-search-results strong {
  font-size: var(--mar-font-size-body);
  font-weight: 600;
  line-height: 1.25;
}

.content-search-name {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.35rem;
}

.content-search-name strong {
  min-width: 0;
}

.content-search-results mark {
  border-radius: 2px;
  background: var(--mar-color-warning-bg);
  color: var(--mar-text-primary);
}

.content-search-results small {
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
}

.content-search-results code {
  grid-column: 1 / -1;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}

.file-explorer {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.explorer-toolbar {
  display: flex;
  justify-content: flex-start;
  gap: 0.25rem;
  align-items: center;
  margin: 0.3rem 0 0;
  border-bottom: 1px solid var(--mar-border-subtle);
  padding: 0 0 0.25rem;
}

.file-display-filter {
  min-width: 0;
  flex: 1 1 auto;
}

.workspace-upload-input {
  display: none;
}

.upload-dialog-target {
  margin-bottom: 0.65rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
}

.upload-dialog-list {
  display: grid;
  max-height: min(45vh, 320px);
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}

.upload-dialog-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.65rem;
  align-items: center;
  border-top: 1px solid var(--mar-fill-hover);
  padding: 0.5rem 0;
}

.upload-dialog-list span,
.upload-dialog-list small {
  min-width: 0;
}

.upload-dialog-list strong,
.upload-dialog-list span > small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upload-dialog-list span > small,
.upload-dialog-list > small {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
}

@media (max-width: 767px) {
  .workspace-inspector .run-form {
    grid-template-columns: 1fr auto;
  }
}

@media (max-width: 767px) {
  .workspace-inspector .run-form button:last-child {
    grid-column: 1 / -1;
  }
}
</style>

<style scoped>
:global(.inspector-tabs .el-button + .el-button) {
  margin-left: 0;
}

:global(.explorer-toolbar .el-button) {
  min-width: 26px;
  min-height: 26px;
  width: 26px;
  height: 26px;
  border-radius: 5px;
  background: transparent;
  padding-inline: 0.35rem;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-body);
}

:global(.explorer-toolbar .el-button + .el-button) {
  margin-left: 0;
}

button.file-explorer-utility-button {
  display: inline-grid;
  width: 26px;
  min-width: 26px;
  height: 26px;
  min-height: 26px;
  place-items: center;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--mar-text-secondary);
  font: inherit;
  padding: 0;
  cursor: pointer;
}

button.file-explorer-utility-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

:global(.explorer-toolbar .el-button:not(.utility-control):hover:not(:disabled)),
:global(.explorer-toolbar .el-button:not(.utility-control):focus-visible) {
  background: var(--mar-fill-muted);
  color: var(--mar-text-primary);
}

:global(.explorer-toolbar .el-input__wrapper) {
  min-height: 26px;
  border: 1px solid var(--mar-border-medium);
  border-radius: 6px;
  background: var(--mar-bg-subtle);
  box-shadow: none;
  padding: 1px 7px;
}

:global(.explorer-toolbar .el-input__inner) {
  font-size: var(--mar-font-size-input);
}

:global(.explorer-toolbar .el-input__wrapper.is-focus),
:global(.explorer-toolbar .el-input__wrapper:focus-within) {
  background: var(--mar-bg-panel);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--mar-color-brand) 14%, transparent);
}
</style>
