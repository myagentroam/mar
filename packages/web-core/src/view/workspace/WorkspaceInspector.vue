<script setup lang="ts">
import BusyIndicator from '../common/BusyIndicator.vue';
import { managementDateTime } from '../../util/time-presentation.js';
import {
  ArrowRight,
  DocumentCopy,
  DocumentAdd,
  Loading,
  Refresh,
  RefreshLeft,
  Search
} from '@element-plus/icons-vue';
import { ElMessageBox } from 'element-plus';
import {
  isComposerAttachmentResourcePath,
  publicErrorSchema,
  workspaceGitTrackingSchema,
  workspaceSymbolDefinitionSchema,
  workspaceSymbolIndexPreparationSchema,
  type PublicError,
  type WorkspaceGitTracking
} from '@myagentroam/protocol';
import type { FileNavigationRequest } from './CodeFileEditor.vue';
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
import { createScopedHttpService } from '../../service/ScopedHttpService.js';
import { PromptPredictionAttentionService } from '../../service/PromptPredictionAttentionService.js';
import {
  createWorkspaceFileTreeService,
  type WorkspaceFileTreeEntry,
  type WorkspaceFileTreeNode,
  type WorkspaceFileTreePage,
  type WorkspaceFileTreeSnapshot,
  type WorkspaceFileTreeWorkspace
} from '../../service/WorkspaceFileTreeService.js';
import { createWorkspaceFileTabService } from '../../service/WorkspaceFileTabService.js';
import {
  createWorkspaceFileNavigationHistoryService,
  type FileNavigationPosition
} from '../../service/WorkspaceFileNavigationHistoryService.js';
import WorkspaceTextFilePage from './WorkspaceTextFilePage.vue';
import WorkspaceFormatFilePage from './WorkspaceFormatFilePage.vue';
import type { DirtyTextDraft } from './WorkspaceTextFilePage.vue';
import WorkspaceFileTabs from './WorkspaceFileTabs.vue';
import WorkspaceGitDiffPage from './WorkspaceGitDiffPage.vue';
import { loadToolChangeDiff } from '../../service/ToolChangeReviewService.js';
import WorkspaceFileTree from './WorkspaceFileTree.vue';
import FileTypeIcon from './FileTypeIcon.vue';
import { createTrailingTask } from '../../util/trailing-task.js';
import { currentChangesBranch, fileSizeLabel } from '../../util/file-presentation.js';
import { errorMessage, filePreviewErrorMessage } from '../../util/error-presentation.js';
import { ApiError, errorCode } from '../../util/api-error.js';
import {
  binaryFilePreviewKind,
  decodeFilePreviewText,
  filePreviewKind,
  isHtmlFile,
  isMarkdownFile,
  shouldReadTextFilePreview,
  TEXT_FILE_PREVIEW_LIMIT_BYTES,
  type FilePreviewKind,
  usesRawFilePreview
} from '../../util/file-preview.js';
import {
  revokeWorkspaceDirectObjectUrl,
  triggerBrowserFileDownload
} from '../../service/WorkspaceDirectObjectUrlService.js';
import { directFileContentRevision } from '../../service/WorkspaceDirectFileReadService.js';
import { readFilePreview, readFilePreviewObject } from '../../service/FilePreviewReadService.js';
import { translate } from '../../service/LocalePreferenceService.js';
import { createStandaloneFileWindowService } from '../../service/StandaloneFileWindowService.js';
import type {
  WorkspaceFileOpenIntent,
  WorkspaceFileTab,
  WorkspaceFileTabsSnapshot
} from '../../util/workspace-file-tab.js';
import {
  buildGitHistoryGraph,
  gitGraphNodeX,
  gitGraphWidth
} from '../../util/git-history-graph.js';

type FileEntry = WorkspaceFileTreeEntry;

interface PendingUpload {
  readonly id: string;
  readonly file: File;
  readonly path: string | null;
  readonly status: 'READY' | 'EXISTS_FILE' | 'EXISTS_DIRECTORY' | 'INVALID_NAME';
  overwrite: boolean;
}

type InspectorSection = 'files' | 'search' | 'changes' | 'history';

interface ContentMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
}
interface NavigationTarget {
  readonly source: 'DEFINITION' | 'REFERENCE' | 'FILE';
  readonly path: string;
  readonly line: number;
  readonly column?: number | undefined;
  readonly kind?: string | undefined;
  readonly scope?: string | undefined;
  readonly preview?: string | undefined;
}

interface FilePreviewContent {
  readonly path: string;
  readonly size?: number;
  readonly encoding: 'utf-8' | 'base64';
  readonly content: string;
  readonly truncated: boolean;
  readonly revision?: string;
}

interface PreviewFrame {
  repositoryPath?: string | undefined;
  readonly id: number;
  readonly fileContent: Ref<FilePreviewContent | undefined>;
  readonly contentUrl: Ref<string | undefined>;
  readonly worktreePath: Ref<string | undefined>;
  readonly loading: Ref<boolean>;
  readonly targetLine: Ref<number | undefined>;
  readonly targetColumn: Ref<number | undefined>;
  readonly navigationLoading: Ref<boolean>;
  readonly navigationTargets: Ref<readonly NavigationTarget[]>;
  readonly navigationNoDefinition: Ref<boolean>;
  readonly downloading: Ref<boolean>;
  historySource:
    | {
        readonly commit: string;
        readonly repositoryPath: string;
        readonly refs: readonly string[];
      }
    | undefined;
  directIdentity: { readonly revision: string; readonly size: number } | undefined;
  directReadStarted: boolean;
  textDecoder: TextDecoder;
  requestGeneration: number;
}
interface LoadedPreviewFrame extends PreviewFrame {
  readonly fileContent: Ref<FilePreviewContent>;
}

interface HistoryRef {
  readonly name: string;
  readonly displayName: string;
  readonly kind: 'LOCAL' | 'REMOTE';
  readonly hash: string;
  readonly current: boolean;
}

interface HistoryCommit {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly subject: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly committedAt: number;
  readonly refs: readonly string[];
}

interface HistoryFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly change: string;
}

interface HistoryContextMenu {
  readonly commit: HistoryCommit;
  readonly x: number;
  readonly y: number;
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
  notice: [value: string];
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
const fileContent = computed({
  get: () => activePreview.value?.fileContent.value,
  set: (value: FilePreviewContent | undefined) => {
    const preview = activePreview.value;
    if (preview !== undefined) preview.fileContent.value = value;
  }
});
const previewContentUrl = computed({
  get: () => activePreview.value?.contentUrl.value,
  set: (value: string | undefined) => {
    const preview = activePreview.value;
    if (preview !== undefined) preview.contentUrl.value = value;
  }
});
const previewWorktreePath = computed({
  get: () => activePreview.value?.worktreePath.value,
  set: (value: string | undefined) => {
    const preview = activePreview.value;
    if (preview !== undefined) preview.worktreePath.value = value;
  }
});
const previewLoading = computed({
  get: () => activePreview.value?.loading.value ?? false,
  set: (value: boolean) => {
    const preview = activePreview.value;
    if (preview !== undefined) preview.loading.value = value;
  }
});
const previewTargetLine = computed({
  get: () => activePreview.value?.targetLine.value,
  set: (value: number | undefined) => {
    const preview = activePreview.value;
    if (preview !== undefined) preview.targetLine.value = value;
  }
});
const navigationLoading = computed({
  get: () => activePreview.value?.navigationLoading.value ?? false,
  set: (value: boolean) => {
    const preview = activePreview.value;
    if (preview !== undefined) preview.navigationLoading.value = value;
  }
});
const navigationTargets = computed({
  get: () => activePreview.value?.navigationTargets.value ?? [],
  set: (value: readonly NavigationTarget[]) => {
    const preview = activePreview.value;
    if (preview !== undefined) preview.navigationTargets.value = value;
  }
});
const navigationNoDefinition = computed({
  get: () => activePreview.value?.navigationNoDefinition.value ?? false,
  set: (value: boolean) => {
    const preview = activePreview.value;
    if (preview !== undefined) preview.navigationNoDefinition.value = value;
  }
});
const downloading = computed({
  get: () => activePreview.value?.downloading.value ?? false,
  set: (value: boolean) => {
    const preview = activePreview.value;
    if (preview !== undefined) preview.downloading.value = value;
  }
});
const changes = ref<unknown>();
const restoringPath = ref<string>();
const unavailable = ref(false);
const filesRefreshing = ref(false);
const changesRefreshing = ref(false);
const filesBusy = computed(() => filesRefreshing.value);
const activeSection = ref<InspectorSection>('files');
const fileDisplayFilter = ref('');
const contentQuery = ref('');
const contentAppliedQuery = ref('');
const contentUseRegex = ref(false);
const contentAppliedUseRegex = ref(false);
const contentMatches = ref<ContentMatch[]>([]);
const contentSearchLoading = ref(false);
const contentSearchTruncated = ref(false);
const contentSearchInput = ref<HTMLInputElement>();
let contentSearchGeneration = 0;
const historyRepositoryPath = ref('');
const historyRefs = ref<HistoryRef[]>([]);
const selectedHistoryRefs = ref<string[]>([]);
const historyCommits = ref<HistoryCommit[]>([]);
const historyGraphRows = computed(() => {
  const rows = buildGitHistoryGraph(historyCommits.value);
  return historyCommits.value.map((commit, index) => ({ commit, graph: rows[index]! }));
});
const historyNextCursor = ref<string | null>(null);
const historyLoading = ref(false);
const historyFilesLoading = ref<string>();
const expandedHistoryCommits = ref<string[]>([]);
const expandedHistoryDirectories = ref<Record<string, readonly string[]>>({});
const historyFiles = ref<Record<string, readonly HistoryFile[]>>({});
const historyContextMenu = ref<HistoryContextMenu>();
const uploadInput = ref<HTMLInputElement>();
const fileTreeView = ref<{ reveal(path: string, current?: () => boolean): Promise<void> }>();
const uploadDialogOpen = ref(false);
const pendingUploads = ref<PendingUpload[]>([]);
const pendingUploadDirectory = ref('.');
const preparingUploads = ref(false);
let inspectorGeneration = 0;
let filePreviewRequestGeneration = 0;
let codeNavigationRequestGeneration = 0;
let nextPreviewFrameId = 0;
let appliedFilesWatchRevision = -1;
let appliedChangesWatchRevision = -1;
const visibleChanges = computed(() => changeEntries(changes.value));
const visibleChangeRepositories = computed(() => changeRepositories(changes.value));
const changeDiscoveryErrors = computed(() => {
  const value = changes.value as { readonly errors?: unknown } | undefined;
  return Array.isArray(value?.errors)
    ? value.errors.flatMap((error: unknown) => {
        const parsed = publicErrorSchema.safeParse(error);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
});
const visibleGitWorktrees = computed(() =>
  hasExplicitChangeRepositoryGroups(changes.value) ? [] : changeWorktrees(changes.value)
);
const gitWorktreesTruncated = computed(() => changeWorktreesTruncated(changes.value));
const diffFiles = computed(() => visibleChanges.value.filter((entry) => entry.diffAvailable));
const historyAvailable = computed(
  () => props.workspaceKind === 'GIT_WORKSPACE' && props.historyCapability === true
);
const historyRepositories = computed(() =>
  visibleChangeRepositories.value
    .filter((repository) => repository.source !== 'WORKTREE' && repository.status !== 'UNAVAILABLE')
    .map((repository) => ({
      value: repository.repositoryPath === '' ? '__ROOT_REPOSITORY__' : repository.repositoryPath,
      label: repository.repositoryName
    }))
);
const previewFileWriteEnabled = (preview: PreviewFrame): boolean =>
  props.fileWriteEnabled &&
  preview.worktreePath.value === undefined &&
  preview.repositoryPath === undefined &&
  !isComposerAttachmentResourcePath(preview.fileContent.value?.path ?? '');
const historyRepositorySelection = computed({
  get: () =>
    historyRepositoryPath.value === '' ? '__ROOT_REPOSITORY__' : historyRepositoryPath.value,
  set: (value: string) => {
    historyRepositoryPath.value = value === '__ROOT_REPOSITORY__' ? '' : value;
  }
});
const previewKind = computed<FilePreviewKind>(() => {
  if (fileContent.value === undefined) return 'unsupported';
  return filePreviewKind(fileContent.value.path, fileContent.value.encoding);
});

function previewKindFor(preview: PreviewFrame): FilePreviewKind {
  const file = preview.fileContent.value;
  return file === undefined ? 'unsupported' : filePreviewKind(file.path, file.encoding);
}

function createPreviewFrame(id: number): PreviewFrame {
  return {
    id,
    fileContent: ref<FilePreviewContent>(),
    contentUrl: ref<string>(),
    worktreePath: ref<string>(),
    loading: ref(false),
    targetLine: ref<number>(),
    targetColumn: ref<number>(),
    navigationLoading: ref(false),
    navigationTargets: ref<readonly NavigationTarget[]>([]),
    navigationNoDefinition: ref(false),
    downloading: ref(false),
    historySource: undefined,
    directIdentity: undefined,
    directReadStarted: false,
    textDecoder: new TextDecoder('utf-8', { fatal: true }),
    requestGeneration: 0
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

function queryUrl(
  pathname: string,
  values: Record<string, string | undefined>,
  nodeId = props.nodeId ?? ''
): string {
  const parameters = new URLSearchParams({ nodeId });
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) parameters.set(key, value);
  return `${pathname}?${parameters.toString()}`;
}

async function get(pathname: string): Promise<unknown> {
  return http.request(pathname);
}

async function searchContent(): Promise<void> {
  const value = contentQuery.value;
  if (!props.contentSearchEnabled || base.value === undefined || value === '') return;
  const generation = ++contentSearchGeneration;
  contentSearchLoading.value = true;
  try {
    const result = await get(
      queryUrl(`${base.value}/content/search`, {
        q: value,
        ...(contentUseRegex.value ? { regex: 'true' } : {})
      })
    );
    if (generation !== contentSearchGeneration) return;
    const search = (result as { search?: unknown }).search;
    if (!isContentSearch(search)) throw new Error('NODE_RESPONSE_INVALID');
    contentMatches.value = [...search.matches];
    contentSearchTruncated.value = search.truncated;
    contentAppliedQuery.value = value;
    contentAppliedUseRegex.value = contentUseRegex.value;
  } catch (error) {
    if (generation === contentSearchGeneration)
      markFailure(error, translate('generated.workspaceInspector.contentSearch'));
  } finally {
    if (generation === contentSearchGeneration) contentSearchLoading.value = false;
  }
}

function openSearch(): void {
  if (!props.contentSearchEnabled) return;
  activeSection.value = 'search';
  void nextTick(() => contentSearchInput.value?.focus());
}

function isContentSearch(value: unknown): value is {
  readonly matches: readonly ContentMatch[];
  readonly truncated: boolean;
} {
  if (typeof value !== 'object' || value === null) return false;
  const search = value as { matches?: unknown; truncated?: unknown };
  return (
    Array.isArray(search.matches) &&
    search.matches.every(
      (match) =>
        typeof match === 'object' &&
        match !== null &&
        typeof (match as ContentMatch).path === 'string' &&
        Number.isInteger((match as ContentMatch).line) &&
        (match as ContentMatch).line > 0 &&
        Number.isInteger((match as ContentMatch).column) &&
        (match as ContentMatch).column > 0 &&
        typeof (match as ContentMatch).preview === 'string'
    ) &&
    typeof search.truncated === 'boolean'
  );
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

async function post(pathname: string, body: unknown): Promise<unknown> {
  return http.request(pathname, {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

function chooseUploadFiles(): void {
  uploadInput.value?.click();
}

async function prepareUploads(
  files: Iterable<File>,
  directory = fileTree.uploadDirectory()
): Promise<void> {
  if (!ready.value || base.value === undefined) return;
  const selected = [...files];
  if (selected.length === 0) return;
  preparingUploads.value = true;
  try {
    const result = await post(`${base.value}/uploads/preflight`, {
      nodeId: props.nodeId,
      directory,
      files: selected.map((file) => ({ name: file.name }))
    });
    const uploads = (result as { uploads?: unknown }).uploads;
    if (!Array.isArray(uploads)) throw new Error('NODE_RESPONSE_INVALID');
    pendingUploads.value = selected.map((file, index) => {
      const value = uploads[index] as { status?: unknown; path?: unknown } | undefined;
      const status =
        value?.status === 'READY' ||
        value?.status === 'EXISTS_FILE' ||
        value?.status === 'EXISTS_DIRECTORY'
          ? value.status
          : 'INVALID_NAME';
      return {
        id: crypto.randomUUID(),
        file,
        status,
        path: typeof value?.path === 'string' ? value.path : null,
        overwrite: false
      };
    });
    pendingUploadDirectory.value = directory;
    uploadDialogOpen.value = true;
  } catch (error) {
    markFailure(error, translate('generated.workspaceInspector.uploadPreflight'));
  } finally {
    preparingUploads.value = false;
  }
}

function onUploadFiles(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.files !== null) void prepareUploads(input.files);
  input.value = '';
}

function onTreeFileDrop(directory: string, files: readonly File[]): void {
  if (files.length === 0) {
    emit('notice', translate('generated.workspaceInspector.onlyFilesCanBeDroppedCompressFolders'));
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
      })
    );
  uploadDialogOpen.value = false;
  pendingUploads.value = [];
}

function isFilePage(
  value: unknown
): value is { readonly files: WorkspaceFileTreePage; readonly workspace?: unknown } {
  if (typeof value !== 'object' || value === null || !('files' in value)) return false;
  const files = (value as { readonly files?: unknown }).files;
  return (
    typeof files === 'object' &&
    files !== null &&
    Array.isArray((files as { readonly entries?: unknown }).entries) &&
    ((files as { readonly nextCursor?: unknown }).nextCursor === null ||
      typeof (files as { readonly nextCursor?: unknown }).nextCursor === 'string')
  );
}

function filePageWorkspace(value: unknown): WorkspaceFileTreeWorkspace | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const workspace = value as {
    readonly id?: unknown;
    readonly path?: unknown;
    readonly kind?: unknown;
    readonly gitSummary?: unknown;
  };
  if (
    typeof workspace.id !== 'string' ||
    typeof workspace.path !== 'string' ||
    (workspace.kind !== 'DIRECTORY' && workspace.kind !== 'GIT_WORKSPACE')
  )
    return undefined;
  const branch =
    typeof workspace.gitSummary === 'object' &&
    workspace.gitSummary !== null &&
    'branch' in workspace.gitSummary &&
    (typeof workspace.gitSummary.branch === 'string' || workspace.gitSummary.branch === null)
      ? workspace.gitSummary.branch
      : undefined;
  return {
    id: workspace.id,
    path: workspace.path,
    kind: workspace.kind,
    ...(branch === undefined ? {} : { gitSummary: { branch } })
  };
}

function markFailure(error: unknown, action: string, summary?: string): void {
  const code = errorCode(error);
  if (code === 'CAPABILITY_UNAVAILABLE') {
    unavailable.value = true;
    changes.value = undefined;
    return;
  }
  emit(
    'notice',
    translate('generated.workspaceInspector.unableToLoad', {
      value0: action,
      value1: summary ?? errorMessage(error)
    })
  );
}

async function listTreeDirectory(path: string, cursor?: string): Promise<WorkspaceFileTreePage> {
  if (!ready.value || base.value === undefined) throw new Error('FILE_TREE_NOT_READY');
  const generation = inspectorGeneration;
  const requestBase = base.value;
  const requestNodeId = props.nodeId ?? '';
  try {
    const result = await get(queryUrl(`${requestBase}/files`, { path, cursor }, requestNodeId));
    if (!isFilePage(result)) throw new Error('NODE_RESPONSE_INVALID');
    const workspace = filePageWorkspace(result.workspace);
    return {
      ...result.files,
      ...(workspace === undefined ? {} : { workspace })
    };
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
  const generation = inspectorGeneration;
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
  const requestGeneration = ++filePreviewRequestGeneration;
  preview.requestGeneration = requestGeneration;
  const requestBase = base.value;
  const requestNodeId = props.nodeId ?? '';
  preview.targetLine.value = targetLine;
  preview.targetColumn.value = targetColumn;
  preview.worktreePath.value = worktreePath;
  preview.repositoryPath = repositoryPath;
  preview.historySource = undefined;
  preview.directIdentity = undefined;
  preview.directReadStarted = false;
  preview.textDecoder = new TextDecoder('utf-8', { fatal: true });
  revokePreviewObjectUrl(preview);
  preview.fileContent.value = {
    path: entry.path,
    ...(entry.size === null ? {} : { size: entry.size }),
    encoding: textPreview ? 'utf-8' : 'base64',
    content: '',
    truncated: false
  };
  preview.contentUrl.value = undefined;
  preview.loading.value = true;
  await nextTick();
  try {
    if (generation !== inspectorGeneration || requestGeneration !== preview.requestGeneration)
      return;
    if (usesRawFilePreview(entry.path)) {
      const direct = serverOnly
        ? undefined
        : await readFilePreviewObject(entry.path, async () =>
            props.directFileObjectUrl?.(entry.path, worktreePath, repositoryPath)
          );
      if (generation !== inspectorGeneration || requestGeneration !== preview.requestGeneration) {
        if (direct?.startsWith('blob:')) revokeWorkspaceDirectObjectUrl(direct);
        return;
      }
      preview.contentUrl.value =
        direct ?? workspaceFileContentUrl(entry.path, worktreePath, false, repositoryPath);
      return;
    }
    const first = await readFilePreview(
      (limit) =>
        readFileRange(
          preview,
          entry.path,
          0,
          limit,
          requestBase,
          requestNodeId,
          worktreePath,
          !serverOnly
        ),
      () => generation === inspectorGeneration && requestGeneration === preview.requestGeneration
    );
    const read = { path: entry.path, ...first };
    const encoding = read.encoding === 'base64' ? 'base64' : 'utf-8';
    const revision = typeof read.revision === 'string' ? read.revision : undefined;
    let content = read.content;
    let truncated = read.nextOffset !== null;
    if (encoding === 'base64') {
      if (generation !== inspectorGeneration || requestGeneration !== preview.requestGeneration)
        return;
      content = '';
      truncated = false;
    } else {
      revokePreviewObjectUrl(preview);
      preview.contentUrl.value = undefined;
      truncated = read.nextOffset !== null;
    }
    if (generation !== inspectorGeneration || requestGeneration !== preview.requestGeneration)
      return;
    preview.fileContent.value = {
      path: read.path,
      size: read.size,
      encoding,
      content,
      truncated,
      ...(revision === undefined ? {} : { revision })
    };
    if (encoding === 'utf-8' && worktreePath === undefined && repositoryPath === undefined)
      prewarmCodeNavigation(entry.path, requestBase, requestNodeId);
  } catch (error) {
    if (
      !serverOnly &&
      preview.directReadStarted &&
      generation === inspectorGeneration &&
      requestGeneration === preview.requestGeneration
    ) {
      return await open(
        entry,
        targetLine,
        worktreePath,
        true,
        stacked,
        preview,
        targetColumn,
        repositoryPath
      );
    }
    if (
      generation === inspectorGeneration &&
      requestGeneration === preview.requestGeneration &&
      errorCode(error) === 'FILE_TOO_LARGE'
    ) {
      preview.fileContent.value = {
        path: entry.path,
        ...(entry.size === null ? {} : { size: entry.size }),
        encoding: 'base64',
        content: '',
        truncated: false
      };
    } else if (
      generation === inspectorGeneration &&
      requestGeneration === preview.requestGeneration
    ) {
      markFailure(
        error,
        translate('generated.workspaceInspector.files'),
        filePreviewErrorMessage(error, entry.path)
      );
    }
  } finally {
    if (generation === inspectorGeneration && requestGeneration === preview.requestGeneration)
      preview.loading.value = false;
  }
}

function workspaceFileContentUrl(
  path: string,
  worktreePath = previewWorktreePath.value,
  download = false,
  repositoryPath?: string
): string {
  if (base.value === undefined) throw new Error('NODE_RESPONSE_INVALID');
  return queryUrl(`${base.value}/files/content`, {
    path,
    ...(repositoryPath === undefined ? {} : { repositoryPath }),
    ...(worktreePath === undefined ? {} : { worktreePath }),
    ...(download ? { download: '1' } : {})
  });
}

async function navigateSymbol(symbol: string): Promise<void> {
  const preview = activePreview.value;
  if (
    !props.codeNavigationEnabled ||
    preview?.repositoryPath !== undefined ||
    base.value === undefined ||
    preview === undefined ||
    preview.fileContent.value === undefined ||
    symbol.length === 0
  )
    return;
  const generation = ++codeNavigationRequestGeneration;
  const previewGeneration = preview.requestGeneration;
  const path = preview.fileContent.value.path;
  const requestBase = base.value;
  const requestNodeId = props.nodeId ?? '';
  preview.navigationLoading.value = true;
  preview.navigationTargets.value = [];
  preview.navigationNoDefinition.value = false;
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const result = await get(
        queryUrl(
          `${requestBase}/symbols/definition`,
          { path, symbol, references: '0' },
          requestNodeId
        )
      );
      const parsed = workspaceSymbolDefinitionSchema.safeParse(
        (result as { readonly definition?: unknown }).definition
      );
      if (!parsed.success) throw new Error('NODE_RESPONSE_INVALID');
      if (
        generation !== codeNavigationRequestGeneration ||
        previewGeneration !== preview.requestGeneration ||
        preview !== activePreview.value
      )
        return;
      if (parsed.data.state === 'BUILDING') {
        await waitForNavigationPoll(generation, preview, previewGeneration);
        continue;
      }
      if (parsed.data.state === 'FAILED')
        throw new Error(parsed.data.failureCode ?? 'SYMBOL_INDEX_BUILD_FAILED');
      if (parsed.data.state === 'UNAVAILABLE') throw new Error('SYMBOL_INDEX_UNAVAILABLE');
      const definitions: NavigationTarget[] = parsed.data.targets.map((target) => ({
        ...target,
        source: 'DEFINITION' as const
      }));
      preview.navigationTargets.value = definitions;
      preview.navigationLoading.value = false;
      void loadSymbolReferences({
        generation,
        preview,
        previewGeneration,
        requestBase,
        requestNodeId,
        path,
        symbol,
        definitions
      });
      return;
    }
    throw new Error('SYMBOL_INDEX_BUILD_FAILED');
  } catch (error) {
    if (
      generation === codeNavigationRequestGeneration &&
      previewGeneration === preview.requestGeneration &&
      preview === activePreview.value
    )
      markFailure(error, translate('fileEditor.definitions'));
  } finally {
    if (
      generation === codeNavigationRequestGeneration &&
      previewGeneration === preview.requestGeneration &&
      preview === activePreview.value
    )
      preview.navigationLoading.value = false;
  }
}

async function loadSymbolReferences(input: {
  readonly generation: number;
  readonly preview: PreviewFrame;
  readonly previewGeneration: number;
  readonly requestBase: string;
  readonly requestNodeId: string;
  readonly path: string;
  readonly symbol: string;
  readonly definitions: readonly NavigationTarget[];
}): Promise<void> {
  try {
    const result = await get(
      queryUrl(
        `${input.requestBase}/symbols/definition`,
        { path: input.path, symbol: input.symbol, references: '1' },
        input.requestNodeId
      )
    );
    const parsed = workspaceSymbolDefinitionSchema.safeParse(
      (result as { readonly definition?: unknown }).definition
    );
    if (
      !parsed.success ||
      input.generation !== codeNavigationRequestGeneration ||
      input.previewGeneration !== input.preview.requestGeneration ||
      input.preview !== activePreview.value
    )
      return;
    if (parsed.data.state !== 'READY' && parsed.data.state !== 'STALE') {
      if (input.definitions.length === 0) input.preview.navigationNoDefinition.value = true;
      return;
    }
    const references: NavigationTarget[] = parsed.data.references.map((target) => ({
      ...target,
      source: 'REFERENCE' as const
    }));
    const definitions =
      parsed.data.targets.length === 0
        ? input.definitions
        : parsed.data.targets.map((target) => ({
            ...target,
            source: 'DEFINITION' as const
          }));
    input.preview.navigationTargets.value = [...definitions, ...references];
    input.preview.navigationNoDefinition.value =
      definitions.length === 0 && references.length === 0;
  } catch {
    if (
      input.generation === codeNavigationRequestGeneration &&
      input.previewGeneration === input.preview.requestGeneration &&
      input.preview === activePreview.value &&
      input.definitions.length === 0
    )
      input.preview.navigationNoDefinition.value = true;
  }
}

async function navigateFile(request: FileNavigationRequest): Promise<void> {
  const preview = activePreview.value;
  if (
    !props.codeNavigationEnabled ||
    base.value === undefined ||
    preview === undefined ||
    preview.fileContent.value === undefined ||
    request.reference.value.length === 0
  )
    return;
  const generation = ++codeNavigationRequestGeneration;
  const previewGeneration = preview.requestGeneration;
  preview.navigationLoading.value = true;
  preview.navigationTargets.value = [];
  preview.navigationNoDefinition.value = false;
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const result = await http.request(`${base.value}/symbols/definition`, {
        method: 'POST',
        body: JSON.stringify({
          nodeId: props.nodeId ?? '',
          path: preview.fileContent.value.path,
          reference: { ...request.reference, sourceContext: request.sourceContext }
        })
      });
      const parsed = workspaceSymbolDefinitionSchema.safeParse(
        (result as { readonly definition?: unknown }).definition
      );
      if (!parsed.success) throw new Error('NODE_RESPONSE_INVALID');
      if (
        generation !== codeNavigationRequestGeneration ||
        previewGeneration !== preview.requestGeneration ||
        preview !== activePreview.value
      )
        return;
      if (parsed.data.state === 'BUILDING') {
        await waitForNavigationPoll(generation, preview, previewGeneration);
        continue;
      }
      if (parsed.data.state === 'FAILED')
        throw new Error(parsed.data.failureCode ?? 'SYMBOL_INDEX_BUILD_FAILED');
      if (parsed.data.state === 'UNAVAILABLE') throw new Error('SYMBOL_INDEX_UNAVAILABLE');
      const targets = parsed.data.paths.map((target) => ({ ...target, source: 'FILE' as const }));
      if (targets.length === 0) preview.navigationNoDefinition.value = true;
      else if (targets.length === 1) openNavigationTarget(targets[0]!, preview);
      else preview.navigationTargets.value = targets;
      return;
    }
    throw new Error('SYMBOL_INDEX_BUILD_FAILED');
  } catch (error) {
    if (
      generation === codeNavigationRequestGeneration &&
      previewGeneration === preview.requestGeneration &&
      preview === activePreview.value
    )
      markFailure(error, translate('fileEditor.definitions'));
  } finally {
    if (
      generation === codeNavigationRequestGeneration &&
      previewGeneration === preview.requestGeneration &&
      preview === activePreview.value
    )
      preview.navigationLoading.value = false;
  }
}

function prewarmCodeNavigation(path: string, requestBase: string, requestNodeId: string): void {
  if (!props.codeNavigationPrewarmEnabled) return;
  void get(queryUrl(`${requestBase}/symbols/prepare`, { path }, requestNodeId))
    .then((result) => {
      if (
        !workspaceSymbolIndexPreparationSchema.safeParse(
          (result as { readonly preparation?: unknown }).preparation
        ).success
      )
        throw new Error('NODE_RESPONSE_INVALID');
    })
    .catch(() => undefined);
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
  codeNavigationRequestGeneration += 1;
  if (preview === undefined) return;
  preview.navigationLoading.value = false;
  preview.navigationTargets.value = [];
  preview.navigationNoDefinition.value = false;
}

async function waitForNavigationPoll(
  generation: number,
  preview: PreviewFrame,
  previewGeneration: number
): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1_000));
  if (
    generation !== codeNavigationRequestGeneration ||
    previewGeneration !== preview.requestGeneration ||
    preview !== activePreview.value
  )
    throw new Error('SYMBOL_INDEX_BUILD_FAILED');
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
      const result = await get(
        queryUrl(`${base.value}/files/read`, { path, offset: '0', limit: '1' }, props.nodeId ?? '')
      );
      if (!isFileRead(result)) throw new Error('NODE_RESPONSE_INVALID');
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
      if (current()) emit('notice', errorMessage(error));
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
    emit('notice', translate('generated.workspaceInspector.theBrowserBlockedTheFilePreviewWindow'));
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
    emit('notice', translate('generated.workspaceInspector.theBrowserBlockedTheFilePreviewWindow'));
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

async function mutateFile(
  action: 'CREATE_FILE' | 'CREATE_DIRECTORY' | 'MOVE' | 'DELETE',
  path: string,
  destination?: string
): Promise<string | undefined> {
  if (base.value === undefined) return undefined;
  const result = (await post(`${base.value}/files/mutate`, {
    nodeId: props.nodeId,
    action,
    path,
    ...(destination === undefined ? {} : { destination })
  })) as { readonly file?: { readonly path?: unknown } };
  await refreshFileTree();
  return typeof result.file?.path === 'string' ? result.file.path : undefined;
}

async function promptName(title: string, initialValue = ''): Promise<string | undefined> {
  try {
    const result = await ElMessageBox.prompt('', title, {
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
      emit('notice', translate('generated.workspaceInspector.relativePathCopied'));
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
      if (name === undefined) return;
      const created = await mutateFile(action, childPath(node.path, name));
      if (created !== undefined) {
        await fileTree.reveal(created);
        fileTree.selectPath(created);
        await fileTreeView.value?.reveal(created);
      }
      return;
    }
    if (action === 'RENAME') {
      const name = await promptName(translate('generated.workspaceInspector.rename'), node.name);
      if (name === undefined || name === node.name) return;
      const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '.';
      const previousSelection = fileTree.selectedPath.value;
      const renamed = await mutateFile('MOVE', node.path, childPath(parent, name));
      if (renamed !== undefined) {
        const selected = movedSelectionPath(previousSelection, node.path, renamed);
        await fileTree.reveal(selected);
        fileTree.selectPath(selected);
        await fileTreeView.value?.reveal(selected);
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
        type: 'warning',
        confirmButtonText: translate('generated.workspaceInspector.delete'),
        cancelButtonText: translate('generated.workspaceInspector.cancel2')
      }
    );
    const selected = fileTree.selectedPath.value;
    const deletingSelection =
      selected === node.path || (selected !== undefined && selected.startsWith(`${node.path}/`));
    await mutateFile('DELETE', node.path);
    if (deletingSelection) {
      closeAllFilePreviews();
    }
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    markFailure(error, translate('generated.workspaceInspector.fileOperation'));
  }
}

async function moveTreeNode(
  source: WorkspaceFileTreeNode,
  directory: WorkspaceFileTreeNode
): Promise<void> {
  try {
    const previousSelection = fileTree.selectedPath.value;
    const moved = await mutateFile('MOVE', source.path, childPath(directory.path, source.name));
    if (moved !== undefined) {
      const selected = movedSelectionPath(previousSelection, source.path, moved);
      await fileTree.reveal(selected);
      fileTree.selectPath(selected);
      await fileTreeView.value?.reveal(selected);
    }
  } catch (error) {
    markFailure(error, translate('generated.workspaceInspector.movingFile'));
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

interface WorkspaceInspectorSnapshot {
  readonly activeSection: InspectorSection;
  readonly fileTree: WorkspaceFileTreeSnapshot;
  readonly contentQuery: string;
  readonly contentAppliedQuery: string;
  readonly contentUseRegex: boolean;
  readonly contentAppliedUseRegex: boolean;
  readonly contentMatches: readonly ContentMatch[];
  readonly contentSearchTruncated: boolean;
  readonly changes: unknown;
  readonly historyRepositoryPath: string;
  readonly selectedHistoryRefs: readonly string[];
  readonly historyCommits: readonly HistoryCommit[];
  readonly historyNextCursor: string | null;
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
    changes: changes.value,
    historyRepositoryPath: historyRepositoryPath.value,
    selectedHistoryRefs: [...selectedHistoryRefs.value],
    historyCommits: [...historyCommits.value],
    historyNextCursor: historyNextCursor.value,
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
  contentAppliedQuery.value =
    typeof value.contentAppliedQuery === 'string' ? value.contentAppliedQuery : '';
  contentUseRegex.value = value.contentUseRegex === true;
  contentAppliedUseRegex.value = value.contentAppliedUseRegex === true;
  contentMatches.value = Array.isArray(value.contentMatches)
    ? value.contentMatches.filter((match): match is ContentMatch =>
        isContentSearch({ matches: [match], truncated: false })
      )
    : [];
  contentSearchTruncated.value = value.contentSearchTruncated === true;
  changes.value = props.workspaceKind === 'GIT_WORKSPACE' ? value.changes : undefined;
  const gitWorkspace = props.workspaceKind === 'GIT_WORKSPACE';
  historyRepositoryPath.value =
    gitWorkspace && typeof value.historyRepositoryPath === 'string'
      ? value.historyRepositoryPath
      : '';
  selectedHistoryRefs.value =
    gitWorkspace && Array.isArray(value.selectedHistoryRefs)
      ? value.selectedHistoryRefs.filter((item): item is string => typeof item === 'string')
      : [];
  historyCommits.value =
    gitWorkspace && Array.isArray(value.historyCommits) ? value.historyCommits : [];
  historyNextCursor.value =
    gitWorkspace && typeof value.historyNextCursor === 'string' ? value.historyNextCursor : null;
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

function isFileRead(value: unknown): value is {
  readonly file: {
    readonly path: string;
    readonly size: number;
    readonly encoding: 'utf-8' | 'base64';
    readonly content: string;
    readonly nextOffset: number | null;
    readonly revision?: string;
  };
} {
  if (typeof value !== 'object' || value === null || !('file' in value)) return false;
  const file = (value as { readonly file?: unknown }).file;
  return (
    typeof file === 'object' &&
    file !== null &&
    typeof (file as { readonly path?: unknown }).path === 'string' &&
    ((file as { readonly encoding?: unknown }).encoding === 'utf-8' ||
      (file as { readonly encoding?: unknown }).encoding === 'base64') &&
    Number.isSafeInteger((file as { readonly size?: unknown }).size) &&
    (file as { readonly size: number }).size >= 0 &&
    typeof (file as { readonly content?: unknown }).content === 'string' &&
    ((file as { readonly nextOffset?: unknown }).nextOffset === null ||
      Number.isSafeInteger((file as { readonly nextOffset?: unknown }).nextOffset))
  );
}

async function readFileRange(
  preview: PreviewFrame,
  filePath: string,
  offset: number,
  limit: number,
  requestBase = base.value,
  requestNodeId = props.nodeId ?? '',
  worktreePath = preview.worktreePath.value,
  allowDirect = true
): Promise<{
  readonly encoding: 'utf-8' | 'base64';
  readonly size: number;
  readonly content: string;
  readonly nextOffset: number | null;
  readonly revision?: string;
}> {
  if (requestBase === undefined) throw new Error('NODE_RESPONSE_INVALID');
  const direct = allowDirect
    ? await props.directFileReadRange?.(
        filePath,
        offset,
        limit,
        worktreePath,
        preview.directIdentity,
        preview.repositoryPath
      )
    : undefined;
  if (direct !== undefined) {
    preview.directReadStarted = true;
    preview.directIdentity = {
      revision: direct.revision,
      size: direct.size
    };
    const revision = await directFileContentRevision(direct);
    if (offset === 0) preview.textDecoder = new TextDecoder('utf-8', { fatal: true });
    const content = decodeFilePreviewText(
      direct.bytes,
      direct.nextOffset === null,
      preview.textDecoder
    );
    if (content !== undefined) {
      return {
        encoding: 'utf-8',
        size: direct.size,
        content,
        nextOffset: direct.nextOffset,
        ...(revision === undefined ? {} : { revision })
      };
    }
    preview.directIdentity = undefined;
    preview.textDecoder = new TextDecoder('utf-8', { fatal: true });
    return {
      encoding: 'base64',
      size: direct.size,
      content: '',
      nextOffset: direct.nextOffset,
      ...(revision === undefined ? {} : { revision })
    };
  }
  if (allowDirect && preview.directReadStarted) throw new Error('DIRECT_FILE_READ_FAILED');
  const result = await get(
    queryUrl(
      `${requestBase}/files/read`,
      {
        path: filePath,
        offset: String(offset),
        limit: String(limit),
        ...(preview.repositoryPath === undefined ? {} : { repositoryPath: preview.repositoryPath }),
        ...(worktreePath === undefined ? {} : { worktreePath })
      },
      requestNodeId
    )
  );
  if (!isFileRead(result)) throw new Error('NODE_RESPONSE_INVALID');
  return result.file;
}

async function savePreviewFile(
  preview: PreviewFrame,
  content: string,
  expectedRevision: string
): Promise<string> {
  if (
    base.value === undefined ||
    preview.fileContent.value === undefined ||
    preview.worktreePath.value !== undefined
  )
    throw new Error('FILE_WRITE_INVALID');
  const result = (await http.request(`${base.value}/files/write`, {
    method: 'PUT',
    body: JSON.stringify({
      nodeId: props.nodeId,
      path: preview.fileContent.value.path,
      content,
      expectedRevision
    })
  })) as { readonly file?: { readonly revision?: unknown; readonly size?: unknown } };
  const revision = result.file?.revision;
  const size = result.file?.size;
  if (
    typeof revision !== 'string' ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0
  )
    throw new Error('NODE_RESPONSE_INVALID');
  preview.fileContent.value = { ...preview.fileContent.value, content, revision, size };
  void Promise.allSettled([refreshFileTree(), loadChanges()]);
  return revision;
}

function saveVisiblePreviewFile(content: string, expectedRevision: string): Promise<string> {
  const preview = visiblePreview.value;
  if (preview === undefined) return Promise.reject(new Error('FILE_WRITE_INVALID'));
  return savePreviewFile(preview, content, expectedRevision);
}

async function downloadFile(
  path: string | undefined,
  worktreePath?: string,
  preview?: PreviewFrame
): Promise<void> {
  if (path === undefined || !ready.value || base.value === undefined) return;
  if (preview !== undefined) preview.downloading.value = true;
  try {
    const direct = await props.directFileDownload?.(path, worktreePath, preview?.repositoryPath);
    if (direct !== undefined && direct !== 'UNAVAILABLE') return;
    const anchor = document.createElement('a');
    anchor.href = workspaceFileContentUrl(path, worktreePath, true, preview?.repositoryPath);
    anchor.download = path.split('/').at(-1) ?? 'download.txt';
    anchor.click();
  } catch (error) {
    markFailure(error, translate('generated.workspaceInspector.fileDownload'));
  } finally {
    if (preview !== undefined) preview.downloading.value = false;
  }
}

async function downloadPreviewFile(preview: PreviewFrame): Promise<void> {
  if (preview.contentUrl.value === undefined || preview.fileContent.value === undefined) {
    await downloadFile(preview.fileContent.value?.path, preview.worktreePath.value, preview);
    return;
  }
  preview.downloading.value = true;
  try {
    if (preview.contentUrl.value.startsWith('blob:')) {
      triggerBrowserFileDownload(
        preview.contentUrl.value,
        preview.fileContent.value.path.split('/').at(-1) ?? 'download'
      );
      return;
    }
    if (preview.historySource !== undefined) {
      const direct = await props.directGitFileDownload?.(
        preview.historySource.commit,
        preview.fileContent.value.path,
        preview.historySource.repositoryPath,
        preview.historySource.refs
      );
      if (direct !== undefined && direct !== 'UNAVAILABLE') return;
      if (base.value === undefined) return;
      const parameters = new URLSearchParams({
        nodeId: props.nodeId ?? '',
        path: preview.fileContent.value.path,
        download: '1'
      });
      if (preview.historySource.repositoryPath.length > 0)
        parameters.set('repositoryPath', preview.historySource.repositoryPath);
      for (const refName of preview.historySource.refs) parameters.append('refs', refName);
      const anchor = document.createElement('a');
      anchor.href = `${base.value}/git/commits/${encodeURIComponent(preview.historySource.commit)}/files/content?${parameters.toString()}`;
      anchor.download = preview.fileContent.value.path.split('/').at(-1) ?? 'download';
      anchor.click();
      return;
    }
    await downloadFile(preview.fileContent.value.path, preview.worktreePath.value, preview);
  } catch (error) {
    markFailure(error, translate('generated.workspaceInspector.fileDownload'));
  } finally {
    preview.downloading.value = false;
  }
}

function revokePreviewObjectUrl(preview = activePreview.value): void {
  if (preview?.contentUrl.value?.startsWith('blob:'))
    revokeWorkspaceDirectObjectUrl(preview.contentUrl.value);
  if (preview !== undefined) preview.contentUrl.value = undefined;
}

function closeAllFilePreviews(): void {
  fileOpenGeneration += 1;
  fileNavigationHistory.clear();
  fileNavigationRevision.value += 1;
  for (const preview of filePageFrames.value) {
    preview.requestGeneration = ++filePreviewRequestGeneration;
    revokePreviewObjectUrl(preview);
    workspaceFileTabService.remove(preview.id);
  }
  filePageFrames.value = [];
  codeNavigationRequestGeneration += 1;
}

function closeFilePreview(preview: PreviewFrame): void {
  const index = filePageFrames.value.indexOf(preview);
  if (index < 0) return;
  const wasActive = activePreview.value === preview;
  preview.requestGeneration = ++filePreviewRequestGeneration;
  clearCodeNavigation(preview);
  revokePreviewObjectUrl(preview);
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
  codeNavigationRequestGeneration += 1;
  if (activePreview.value !== undefined) activePreview.value.navigationLoading.value = false;
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
  if (tab.kind !== 'HISTORY_DIFF' || tab.commit === undefined || base.value === undefined) return;
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
    filePageFrames.value.find((candidate) => candidate.id === historyTab.id) ??
    createPreviewFrame(historyTab.id);
  const requestGeneration = ++filePreviewRequestGeneration;
  preview.requestGeneration = requestGeneration;
  preview.historySource = {
    commit: tab.commit,
    repositoryPath: tab.repositoryPath,
    refs: tab.refs ?? []
  };
  if (!filePageFrames.value.includes(preview))
    filePageFrames.value = [...filePageFrames.value, preview];
  const binaryKind = binaryFilePreviewKind(tab.path);
  const textPreview = diff === undefined || !isBinaryDiff(diff);
  preview.fileContent.value = {
    path: tab.path,
    encoding: textPreview ? 'utf-8' : 'base64',
    content: '',
    truncated: false
  };
  preview.loading.value = textPreview || binaryKind !== 'unsupported';
  if (!preview.loading.value) return;
  const parameters = new URLSearchParams({ nodeId: props.nodeId ?? '', path: tab.path });
  if (tab.repositoryPath.length > 0) parameters.set('repositoryPath', tab.repositoryPath);
  for (const refName of tab.refs ?? []) parameters.append('refs', refName);
  const fallback = `${base.value}/git/commits/${encodeURIComponent(tab.commit)}/files/content?${parameters.toString()}`;
  try {
    if (textPreview) {
      const range = await readGitHistoryTextRange(
        tab.commit,
        tab.path,
        tab.repositoryPath,
        tab.refs ?? [],
        fallback
      );
      if (requestGeneration !== preview.requestGeneration) return;
      preview.fileContent.value = {
        path: tab.path,
        size: range.size,
        encoding: 'utf-8',
        content: range.content,
        truncated: range.truncated
      };
      return;
    }
    if (binaryKind === 'unsupported') return;
    const size = await readGitHistoryFileSize(
      tab.commit,
      tab.path,
      tab.repositoryPath,
      tab.refs ?? [],
      fallback
    ).catch(() => undefined);
    if (requestGeneration !== preview.requestGeneration) return;
    preview.fileContent.value = {
      path: tab.path,
      ...(size === undefined ? {} : { size }),
      encoding: 'base64',
      content: '',
      truncated: false
    };
    const commit = tab.commit;
    const direct = await readFilePreviewObject(tab.path, async () =>
      props.directGitFileObjectUrl?.(commit, tab.path, tab.repositoryPath, tab.refs ?? [])
    );
    if (requestGeneration !== preview.requestGeneration) {
      if (direct?.startsWith('blob:')) revokeWorkspaceDirectObjectUrl(direct);
      return;
    }
    preview.contentUrl.value = direct ?? fallback;
  } catch (error) {
    if (requestGeneration === preview.requestGeneration)
      markFailure(error, translate('generated.workspaceInspector.files'));
  } finally {
    if (requestGeneration === preview.requestGeneration) preview.loading.value = false;
  }
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

async function readGitHistoryTextRange(
  commit: string,
  path: string,
  repositoryPath: string,
  refs: readonly string[],
  fallbackUrl: string
): Promise<{ readonly content: string; readonly size: number; readonly truncated: boolean }> {
  const direct = await props.directGitFileReadRange?.(
    commit,
    path,
    repositoryPath,
    refs,
    0,
    TEXT_FILE_PREVIEW_LIMIT_BYTES
  );
  if (direct !== undefined) {
    return {
      content: new TextDecoder('utf-8', { fatal: true }).decode(direct.bytes),
      size: direct.size,
      truncated: direct.nextOffset !== null
    };
  }
  const response = await fetch(fallbackUrl, {
    credentials: 'same-origin',
    headers: { range: `bytes=0-${TEXT_FILE_PREVIEW_LIMIT_BYTES - 1}` }
  });
  if (!response.ok) throw new Error(`REQUEST_FAILED_${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const total = response.headers.get('content-range')?.match(/\/(\d+)$/u)?.[1];
  const size = total === undefined ? bytes.byteLength : Number(total);
  if (!Number.isSafeInteger(size) || size < bytes.byteLength)
    throw new Error('NODE_RESPONSE_INVALID');
  return {
    content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    size,
    truncated: bytes.byteLength < size
  };
}

async function readGitHistoryFileSize(
  commit: string,
  path: string,
  repositoryPath: string,
  refs: readonly string[],
  fallbackUrl: string
): Promise<number> {
  const direct = await props.directGitFileReadRange?.(commit, path, repositoryPath, refs, 0, 1);
  if (direct !== undefined) return direct.size;
  const response = await fetch(fallbackUrl, {
    credentials: 'same-origin',
    headers: { range: 'bytes=0-0' }
  });
  if (!response.ok) throw new Error(`REQUEST_FAILED_${response.status}`);
  const total = response.headers.get('content-range')?.match(/\/(\d+)$/u)?.[1];
  const size = total === undefined ? Number(response.headers.get('content-length')) : Number(total);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('NODE_RESPONSE_INVALID');
  return size;
}

function isBinaryDiff(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly binary?: unknown }).binary === true
  );
}

async function performChangesRefresh(): Promise<void> {
  if (!ready.value || base.value === undefined || props.workspaceKind !== 'GIT_WORKSPACE') return;
  const generation = inspectorGeneration;
  const requestBase = base.value;
  const requestNodeId = props.nodeId ?? '';
  const workspaceId = props.workspaceId;
  if (workspaceId === undefined) return;
  try {
    const result = await get(queryUrl(`${requestBase}/changes`, {}, requestNodeId));
    if (generation === inspectorGeneration && props.workspaceKind === 'GIT_WORKSPACE') {
      changes.value = result;
      const branch = currentChangesBranch(result);
      if (branch !== undefined) emit('branch', workspaceId, branch);
    }
  } catch (error) {
    if (generation === inspectorGeneration)
      markFailure(error, translate('generated.workspaceInspector.gitChanges'));
  }
}

const changesRefreshTask = createTrailingTask(async () => {
  changesRefreshing.value = true;
  try {
    await performChangesRefresh();
  } finally {
    changesRefreshing.value = false;
  }
});

function loadChanges(): Promise<void> {
  return changesRefreshTask.request();
}

function refreshVisibleSection(nodeId: string, workspaceId: string): void {
  if (props.nodeId !== nodeId || props.workspaceId !== workspaceId || !ready.value) return;
  if (activeSection.value === 'files') void filesRefreshTask.request();
  else if (activeSection.value === 'changes') void loadChanges();
}

function openChanges(): void {
  activeSection.value = 'changes';
  void loadChanges();
}

function gitHistoryUrl(pathname: string, values: Record<string, string | undefined> = {}): string {
  const parameters = new URLSearchParams({ nodeId: props.nodeId ?? '' });
  if (historyRepositoryPath.value.length > 0)
    parameters.set('repositoryPath', historyRepositoryPath.value);
  for (const refName of selectedHistoryRefs.value) parameters.append('refs', refName);
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) parameters.set(key, value);
  return `${pathname}?${parameters.toString()}`;
}

async function loadHistoryRefs(generation = inspectorGeneration): Promise<HistoryRef[]> {
  if (!ready.value || base.value === undefined || !historyAvailable.value) return [];
  const result = await get(gitHistoryUrl(`${base.value}/git/refs`));
  if (generation !== inspectorGeneration) return [];
  const values =
    typeof result === 'object' && result !== null ? (result as { refs?: unknown }).refs : undefined;
  if (!Array.isArray(values)) throw new Error('NODE_RESPONSE_INVALID');
  return values.filter(
    (entry): entry is HistoryRef =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as HistoryRef).name === 'string' &&
      typeof (entry as HistoryRef).displayName === 'string' &&
      ((entry as HistoryRef).kind === 'LOCAL' || (entry as HistoryRef).kind === 'REMOTE')
  );
}

async function loadHistory(reset = false): Promise<void> {
  if (!ready.value || base.value === undefined || !historyAvailable.value) return;
  if (!reset && historyLoading.value) return;
  if (reset) inspectorGeneration += 1;
  const generation = inspectorGeneration;
  historyLoading.value = true;
  try {
    const refs = reset ? await loadHistoryRefs(generation) : undefined;
    if (generation !== inspectorGeneration) return;
    const result = await get(
      gitHistoryUrl(`${base.value}/git/history`, {
        limit: '50',
        ...(reset || historyNextCursor.value === null ? {} : { cursor: historyNextCursor.value })
      })
    );
    if (generation !== inspectorGeneration) return;
    if (
      typeof result !== 'object' ||
      result === null ||
      !Array.isArray((result as { commits?: unknown }).commits)
    )
      throw new Error('NODE_RESPONSE_INVALID');
    const page = (result as { commits: HistoryCommit[]; nextCursor?: unknown }).commits;
    const nextCursor =
      typeof (result as { nextCursor?: unknown }).nextCursor === 'string'
        ? (result as { nextCursor: string }).nextCursor
        : null;
    if (reset) {
      historyRefs.value = refs ?? [];
      historyCommits.value = page;
      historyNextCursor.value = nextCursor;
      expandedHistoryCommits.value = [];
      expandedHistoryDirectories.value = {};
      historyFiles.value = {};
    } else {
      historyCommits.value = [...historyCommits.value, ...page];
      historyNextCursor.value = nextCursor;
    }
  } catch (error) {
    if (generation === inspectorGeneration)
      markFailure(error, translate('generated.workspaceInspector.gitHistory'));
  } finally {
    if (generation === inspectorGeneration) historyLoading.value = false;
  }
}

async function openHistory(): Promise<void> {
  activeSection.value = 'history';
  if (changes.value === undefined) await loadChanges();
  await loadHistory(true);
}

async function resetHistory(): Promise<void> {
  await loadHistory(true);
}

async function changeHistoryRepository(): Promise<void> {
  selectedHistoryRefs.value = [];
  await resetHistory();
}

async function toggleHistoryCommit(commit: HistoryCommit): Promise<void> {
  if (expandedHistoryCommits.value.includes(commit.hash)) {
    expandedHistoryCommits.value = expandedHistoryCommits.value.filter(
      (hash) => hash !== commit.hash
    );
    return;
  }
  expandedHistoryCommits.value = [...expandedHistoryCommits.value, commit.hash];
  if (expandedHistoryDirectories.value[commit.hash] === undefined)
    expandedHistoryDirectories.value = { ...expandedHistoryDirectories.value, [commit.hash]: [] };
  if (historyFiles.value[commit.hash] !== undefined || base.value === undefined) return;
  historyFilesLoading.value = commit.hash;
  const generation = inspectorGeneration;
  try {
    const result = await get(gitHistoryUrl(`${base.value}/git/commits/${commit.hash}/files`));
    if (generation !== inspectorGeneration) return;
    const files =
      typeof result === 'object' && result !== null
        ? (result as { files?: unknown }).files
        : undefined;
    if (!Array.isArray(files)) throw new Error('NODE_RESPONSE_INVALID');
    historyFiles.value = { ...historyFiles.value, [commit.hash]: files as HistoryFile[] };
  } catch (error) {
    if (generation !== inspectorGeneration) return;
    expandedHistoryCommits.value = expandedHistoryCommits.value.filter(
      (hash) => hash !== commit.hash
    );
    const { [commit.hash]: _removed, ...directories } = expandedHistoryDirectories.value;
    expandedHistoryDirectories.value = directories;
    markFailure(error, translate('generated.workspaceInspector.commitFiles'));
  } finally {
    if (generation === inspectorGeneration) historyFilesLoading.value = undefined;
  }
}

async function loadDiff(tab: WorkspaceFileTab, signal?: AbortSignal): Promise<unknown> {
  if (tab.kind === 'TOOL_CHANGE_DIFF') return loadToolChangeDiff(tab, get, signal);
  if (base.value === undefined) throw new Error('FILE_TREE_NOT_READY');
  if (tab.kind === 'HISTORY_DIFF') {
    if (tab.commit === undefined) throw new Error('NODE_RESPONSE_INVALID');
    const parameters = new URLSearchParams({ nodeId: props.nodeId ?? '', path: tab.path });
    if (tab.repositoryPath.length > 0) parameters.set('repositoryPath', tab.repositoryPath);
    if (tab.previousPath !== undefined) parameters.set('previousPath', tab.previousPath);
    for (const refName of tab.refs ?? []) parameters.append('refs', refName);
    const result = await get(
      `${base.value}/git/commits/${encodeURIComponent(tab.commit)}/diff?${parameters.toString()}`
    );
    if (typeof result !== 'object' || result === null || !('diff' in result))
      throw new Error('NODE_RESPONSE_INVALID');
    return (result as { readonly diff: unknown }).diff;
  }
  if (tab.kind !== 'WORKTREE_DIFF') throw new Error('NODE_RESPONSE_INVALID');
  const result = await get(
    queryUrl(
      `${base.value}/changes/diff`,
      {
        path: tab.path,
        ...(tab.repositoryPath === '' ? {} : { repositoryPath: tab.repositoryPath }),
        ...(tab.worktreePath === '' ? {} : { worktreePath: tab.worktreePath })
      },
      props.nodeId ?? ''
    )
  );
  if (typeof result !== 'object' || result === null || !('diff' in result))
    throw new Error('NODE_RESPONSE_INVALID');
  return (result as { readonly diff: unknown }).diff;
}

function openHistoryDiff(commit: HistoryCommit, file: HistoryFile, event?: MouseEvent): void {
  if (base.value === undefined) return;
  const intent: WorkspaceFileOpenIntent = {
    kind: 'HISTORY_DIFF',
    nodeId: props.nodeId ?? '',
    workspaceId: props.workspaceId ?? '',
    path: file.path,
    repositoryPath: historyRepositoryPath.value,
    worktreePath: '',
    commit: commit.hash,
    ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
    refs: [...selectedHistoryRefs.value],
    paths: [file.path]
  };
  if (event?.ctrlKey || event?.metaKey) {
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

function openChange(entry: ChangeEntry, event?: MouseEvent): void {
  const repositoryPath = gitFileRepositoryPath(entry.repositoryPath, entry.worktreePath);
  const path =
    repositoryPath === undefined && entry.worktreePath === undefined
      ? workspaceChangePath(entry)
      : entry.path;
  if (event?.ctrlKey || event?.metaKey) {
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

async function restoreChange(entry: ChangeEntry): Promise<void> {
  if (!ready.value || base.value === undefined || restoringPath.value !== undefined) return;
  const workspacePath = workspaceChangePath(entry);
  const action =
    entry.state === 'UNTRACKED'
      ? translate('generated.workspaceInspector.deleteUntrackedFile')
      : translate('generated.workspaceInspector.revertChanges');
  try {
    await ElMessageBox.confirm(
      translate('generated.workspaceInspector.thisActionCannotBeUndone', {
        value0: action,
        value1: workspacePath
      }),
      action,
      {
        confirmButtonText:
          entry.state === 'UNTRACKED'
            ? translate('generated.workspaceInspector.delete2')
            : translate('generated.workspaceInspector.revert'),
        cancelButtonText: translate('generated.workspaceInspector.cancel3'),
        type: 'warning'
      }
    );
  } catch {
    return;
  }
  restoringPath.value = changeKey(entry);
  try {
    await post(queryUrl(`${base.value}/changes/restore`, {}), {
      path: entry.path,
      state: entry.state,
      nodeId: props.nodeId,
      ...(entry.repositoryPath === '' ? {} : { repositoryPath: entry.repositoryPath }),
      ...(entry.worktreePath === undefined ? {} : { worktreePath: entry.worktreePath })
    });
    emit(
      'notice',
      entry.state === 'UNTRACKED'
        ? translate('generated.workspaceInspector.deleted', { value0: workspacePath })
        : translate('generated.workspaceInspector.reverted', { value0: workspacePath })
    );
    await loadChanges();
  } catch (error) {
    markFailure(error, translate('generated.workspaceInspector.revertingChanges'));
  } finally {
    restoringPath.value = undefined;
  }
}

function resetGitState(): void {
  inspectorGeneration += 1;
  if (activeSection.value === 'changes' || activeSection.value === 'history')
    activeSection.value = 'files';
  changes.value = undefined;
  changesRefreshing.value = false;
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
  restoringPath.value = undefined;
  historyRepositoryPath.value = '';
  historyRefs.value = [];
  selectedHistoryRefs.value = [];
  historyCommits.value = [];
  historyNextCursor.value = null;
  historyLoading.value = false;
  historyFilesLoading.value = undefined;
  expandedHistoryCommits.value = [];
  expandedHistoryDirectories.value = {};
  historyFiles.value = {};
}

function reset(): void {
  inspectorGeneration += 1;
  closeAllFilePreviews();
  workspaceFileTabService.clear();
  appliedFilesWatchRevision = -1;
  appliedChangesWatchRevision = -1;
  unavailable.value = false;
  activeSection.value = 'files';
  changes.value = undefined;
  historyRepositoryPath.value = '';
  historyRefs.value = [];
  selectedHistoryRefs.value = [];
  historyCommits.value = [];
  historyNextCursor.value = null;
  expandedHistoryCommits.value = [];
  expandedHistoryDirectories.value = {};
  historyFiles.value = {};
  contentSearchGeneration += 1;
  fileDisplayFilter.value = '';
  contentQuery.value = '';
  contentAppliedQuery.value = '';
  contentUseRegex.value = false;
  contentAppliedUseRegex.value = false;
  contentMatches.value = [];
  contentSearchLoading.value = false;
  contentSearchTruncated.value = false;
  fileTree.reset();
}

interface ChangeEntry {
  readonly repositoryPath: string;
  readonly repositoryName: string;
  readonly source: 'ROOT' | 'SUBMODULE' | 'WORKTREE';
  readonly worktreePath?: string;
  readonly path: string;
  readonly state: 'STAGED' | 'UNSTAGED' | 'UNTRACKED';
  readonly change: string;
  readonly diffAvailable: boolean;
}

interface ChangeRepository {
  readonly repositoryPath: string;
  readonly repositoryName: string;
  readonly source: 'ROOT' | 'SUBMODULE' | 'WORKTREE';
  readonly worktreePath?: string;
  readonly physicalPath?: string;
  readonly current: boolean;
  readonly branch: string | null;
  readonly tracking?: WorkspaceGitTracking;
  readonly head?: string;
  readonly status?: 'CLEAN' | 'DIRTY' | 'UNAVAILABLE';
  readonly locked: boolean;
  readonly prunable: boolean;
  readonly error?: PublicError;
  readonly changes: readonly ChangeEntry[];
}

interface GitWorktreeSummary {
  readonly directoryName: string;
  readonly branch: string | null;
  readonly head: string;
  readonly current: boolean;
  readonly status: 'CLEAN' | 'DIRTY' | 'UNAVAILABLE';
  readonly locked: boolean;
  readonly prunable: boolean;
}

function parseChangeEntries(
  value: unknown,
  repositoryPath: string,
  repositoryName: string,
  source: ChangeRepository['source'],
  worktreePath?: string
): readonly ChangeEntry[] {
  if (typeof value !== 'object' || value === null) return [];
  const raw = (value as { readonly changes?: unknown }).changes;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const entry = item as Record<string, unknown>;
    return typeof entry.path === 'string'
      ? [
          {
            repositoryPath,
            repositoryName,
            source,
            ...(worktreePath === undefined ? {} : { worktreePath }),
            path: entry.path,
            state:
              entry.state === 'STAGED' || entry.state === 'UNSTAGED' || entry.state === 'UNTRACKED'
                ? entry.state
                : 'UNTRACKED',
            change: typeof entry.change === 'string' ? entry.change : 'MODIFIED',
            diffAvailable: entry.diffAvailable === true
          }
        ]
      : [];
  });
}

function changeRepositories(value: unknown): readonly ChangeRepository[] {
  if (typeof value !== 'object' || value === null) return [];
  const record = value as {
    readonly repositories?: unknown;
  };
  if (!Array.isArray(record.repositories)) return [];
  const repositories = record.repositories.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const repository = item as Record<string, unknown>;
    if (typeof repository.repositoryPath !== 'string') return [];
    if (
      repository.source !== 'ROOT' &&
      repository.source !== 'SUBMODULE' &&
      repository.source !== 'WORKTREE'
    )
      return [];
    const source: ChangeRepository['source'] = repository.source;
    const worktreePath =
      source === 'WORKTREE' && typeof repository.worktreePath === 'string'
        ? repository.worktreePath
        : undefined;
    if (source === 'WORKTREE' && worktreePath === undefined) return [];
    const repositoryName =
      typeof repository.repositoryName === 'string' && repository.repositoryName.length > 0
        ? repository.repositoryName
        : repository.repositoryPath || translate('generated.workspaceInspector.rootRepository');
    const groupError = publicErrorSchema.safeParse(repository.error);
    const tracking = workspaceGitTrackingSchema.safeParse(repository.tracking);
    const parsed: ChangeRepository = {
      repositoryPath: repository.repositoryPath,
      repositoryName,
      source,
      ...(worktreePath === undefined ? {} : { worktreePath }),
      ...(typeof repository.physicalPath === 'string'
        ? { physicalPath: repository.physicalPath }
        : {}),
      current: repository.current === true || source === 'ROOT',
      branch: typeof repository.branch === 'string' ? repository.branch : null,
      ...(tracking.success && repository.status !== 'UNAVAILABLE'
        ? { tracking: tracking.data }
        : {}),
      ...(typeof repository.head === 'string' ? { head: repository.head } : {}),
      ...(repository.status === 'CLEAN' ||
      repository.status === 'DIRTY' ||
      repository.status === 'UNAVAILABLE'
        ? { status: repository.status }
        : {}),
      locked: repository.locked === true,
      prunable: repository.prunable === true,
      ...(groupError.success ? { error: groupError.data } : {}),
      changes:
        repository.status === 'UNAVAILABLE'
          ? []
          : parseChangeEntries(
              repository,
              repository.repositoryPath,
              repositoryName,
              source,
              worktreePath
            )
    };
    return [parsed];
  });
  const root = repositories.find((repository) => repository.source === 'ROOT');
  return root === undefined
    ? repositories
    : [root, ...repositories.filter((repository) => repository !== root)];
}

function gitGroupErrorMessage(error: PublicError): string {
  return errorMessage(new ApiError(error.code, error.message, error.parameters, error.details));
}

function changeEntries(value: unknown): readonly ChangeEntry[] {
  return changeRepositories(value).flatMap((repository) => repository.changes);
}

function hasExplicitChangeRepositoryGroups(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const repositories = (value as { readonly repositories?: unknown }).repositories;
  if (!Array.isArray(repositories)) return false;
  return repositories.some(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      ((item as { readonly source?: unknown }).source === 'ROOT' ||
        (item as { readonly source?: unknown }).source === 'SUBMODULE' ||
        (item as { readonly source?: unknown }).source === 'WORKTREE')
  );
}

function changeWorktrees(value: unknown): readonly GitWorktreeSummary[] {
  if (typeof value !== 'object' || value === null) return [];
  const worktrees = (value as { readonly worktrees?: unknown }).worktrees;
  if (!Array.isArray(worktrees)) return [];
  return worktrees.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const worktree = item as Record<string, unknown>;
    if (
      typeof worktree.directoryName !== 'string' ||
      worktree.directoryName.length === 0 ||
      (typeof worktree.branch !== 'string' && worktree.branch !== null) ||
      typeof worktree.head !== 'string' ||
      !/^[0-9a-f]{40,64}$/u.test(worktree.head) ||
      typeof worktree.current !== 'boolean' ||
      (worktree.status !== 'CLEAN' &&
        worktree.status !== 'DIRTY' &&
        worktree.status !== 'UNAVAILABLE') ||
      typeof worktree.locked !== 'boolean' ||
      typeof worktree.prunable !== 'boolean'
    )
      return [];
    return [worktree as unknown as GitWorktreeSummary];
  });
}

function changeWorktreesTruncated(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly worktreesTruncated?: unknown }).worktreesTruncated === true
  );
}

function worktreeReference(worktree: GitWorktreeSummary): string {
  return (
    worktree.branch ??
    translate('gitWorktrees.detachedHead', {
      head: worktree.head.slice(0, 8)
    })
  );
}

function worktreeStatusLabel(status: GitWorktreeSummary['status']): string {
  if (status === 'CLEAN') return translate('gitWorktrees.clean');
  if (status === 'DIRTY') return translate('gitWorktrees.dirty');
  return translate('gitWorktrees.unavailable');
}

function worktreeStatusType(status: GitWorktreeSummary['status']): 'success' | 'warning' | 'info' {
  if (status === 'CLEAN') return 'success';
  if (status === 'DIRTY') return 'warning';
  return 'info';
}

function repositoryKey(repository: ChangeRepository): string {
  return `${repository.source}:${repository.worktreePath ?? repository.repositoryPath}`;
}

function changeKey(
  entry: Pick<ChangeEntry, 'repositoryPath' | 'worktreePath' | 'path' | 'state'>
): string {
  return `${entry.worktreePath ?? entry.repositoryPath}:${entry.state}:${entry.path}`;
}

function workspaceChangePath(
  entry: Pick<ChangeEntry, 'repositoryPath' | 'repositoryName' | 'worktreePath' | 'path'>
): string {
  if (entry.worktreePath !== undefined)
    return `${entry.worktreePath.replace(/[\\/]+$/u, '')}/${entry.path}`;
  return entry.repositoryPath.length === 0 ? entry.path : `${entry.repositoryPath}/${entry.path}`;
}

function repositoryKindLabel(source: ChangeRepository['source']): string {
  if (source === 'ROOT') return translate('gitWorktrees.rootRepository');
  if (source === 'SUBMODULE') return translate('gitWorktrees.submodule');
  return translate('gitWorktrees.worktree');
}

function repositoryReference(repository: ChangeRepository): string | undefined {
  if (repository.branch !== null) return repository.branch;
  if (repository.head === undefined) return undefined;
  return translate('gitWorktrees.detachedHead', { head: repository.head.slice(0, 8) });
}

function shortChange(change: string): string {
  return (
    {
      ADDED: 'A',
      MODIFIED: 'M',
      DELETED: 'D',
      RENAMED: 'R',
      COPIED: 'C',
      TYPE_CHANGED: 'T'
    }[change] ?? '?'
  );
}

function shortState(state: ChangeEntry['state']): string {
  return { STAGED: 'S', UNSTAGED: 'W', UNTRACKED: '?' }[state];
}

function changeFileName(changePath: string): string {
  return changePath.split('/').at(-1) ?? changePath;
}

function changeDirectory(changePath: string): string {
  const separator = changePath.lastIndexOf('/');
  return separator > 0 ? changePath.slice(0, separator) : '';
}

function historyTime(value: number): string {
  return Number.isFinite(value) ? managementDateTime(value) : '-';
}

function openHistoryContextMenu(commit: HistoryCommit, event: MouseEvent): void {
  event.preventDefault();
  const width = 176;
  const height = 38;
  historyContextMenu.value = {
    commit,
    x: Math.max(6, Math.min(event.clientX, window.innerWidth - width - 6)),
    y: Math.max(6, Math.min(event.clientY, window.innerHeight - height - 6))
  };
}

function closeHistoryContextMenu(): void {
  historyContextMenu.value = undefined;
}

function closeHistoryContextMenuOnPointerDown(event: PointerEvent): void {
  if (event.target instanceof Element && event.target.closest('.history-context-menu') !== null)
    return;
  closeHistoryContextMenu();
}

async function copyHistoryCommitId(): Promise<void> {
  const commit = historyContextMenu.value?.commit;
  if (commit === undefined) return;
  closeHistoryContextMenu();
  await navigator.clipboard.writeText(commit.hash);
  emit('notice', translate('generated.workspaceInspector.commitIdCopied'));
}

function historyTreeIndent(depth: number): string {
  const safeDepth = Math.min(8, Math.max(0, depth));
  return `${safeDepth * 10 + 2}px`;
}

type HistoryFileRow =
  | {
      readonly kind: 'DIRECTORY';
      readonly path: string;
      readonly name: string;
      readonly depth: number;
    }
  | {
      readonly kind: 'FILE';
      readonly file: HistoryFile;
      readonly name: string;
      readonly depth: number;
    };

function isVisibleHistoryPath(path: string, expandedDirectories: readonly string[]): boolean {
  const parts = path.split('/').filter(Boolean);
  return parts
    .slice(0, -1)
    .every((_, index) => expandedDirectories.includes(parts.slice(0, index + 1).join('/')));
}

function historyFileRows(
  files: readonly HistoryFile[],
  expandedDirectories: readonly string[]
): readonly HistoryFileRow[] {
  const directories = new Set<string>();
  const rows: HistoryFileRow[] = [];
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const parts = file.path.split('/').filter(Boolean);
    for (let depth = 0; depth < parts.length - 1; depth += 1) {
      const path = parts.slice(0, depth + 1).join('/');
      if (directories.has(path)) continue;
      directories.add(path);
      if (!isVisibleHistoryPath(path, expandedDirectories)) continue;
      rows.push({ kind: 'DIRECTORY', path, name: parts[depth] ?? path, depth });
    }
    if (!isVisibleHistoryPath(file.path, expandedDirectories)) continue;
    rows.push({ kind: 'FILE', file, name: parts.at(-1) ?? file.path, depth: parts.length - 1 });
  }
  return rows;
}

function toggleHistoryDirectory(commitHash: string, path: string): void {
  const expanded = expandedHistoryDirectories.value[commitHash] ?? [];
  expandedHistoryDirectories.value = {
    ...expandedHistoryDirectories.value,
    [commitHash]: expanded.includes(path)
      ? expanded.filter((item) => item !== path)
      : [...expanded, path]
  };
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
  if (
    snapshot.changes !== undefined &&
    isNewerWatchRevision(snapshot.changesWatchRevision, appliedChangesWatchRevision)
  ) {
    const workspace = filePageWorkspace(
      (snapshot.changes as { workspace?: unknown } | null)?.workspace
    );
    appliedChangesWatchRevision = appliedWatchRevision(snapshot.changesWatchRevision);
    if (workspace !== undefined) emit('workspace', workspace);
    if ((workspace?.kind ?? props.workspaceKind) !== 'GIT_WORKSPACE') {
      resetGitState();
      return;
    }
    changes.value = snapshot.changes;
    const branch = currentChangesBranch(snapshot.changes);
    if (branch !== undefined) emit('branch', snapshot.workspaceId, branch);
  }
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
function closeOnEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  closeHistoryContextMenu();
}
onMounted(() => {
  window.addEventListener('keydown', closeOnEscape);
  window.addEventListener('pointerdown', closeHistoryContextMenuOnPointerDown);
  window.addEventListener('resize', closeHistoryContextMenu);
  window.addEventListener('scroll', closeHistoryContextMenu, true);
});
onBeforeUnmount(() => {
  fileOpenGeneration += 1;
  clearCodeNavigation();
  window.removeEventListener('keydown', closeOnEscape);
  window.removeEventListener('pointerdown', closeHistoryContextMenuOnPointerDown);
  window.removeEventListener('resize', closeHistoryContextMenu);
  window.removeEventListener('scroll', closeHistoryContextMenu, true);
});
onBeforeUnmount(revokePreviewObjectUrl);
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
            >
              <template #prefix
                ><el-icon><Search /></el-icon
              ></template>
            </el-input>
            <button
              class="file-explorer-utility-button utility-control"
              :disabled="filesBusy"
              :aria-label="translate('generated.workspaceInspector.refreshFiles')"
              :aria-busy="filesBusy || undefined"
              :title="translate('generated.workspaceInspector.refreshFiles2')"
              type="button"
              @click="refreshFiles"
            >
              <el-icon v-if="filesBusy" class="is-loading"><Loading /></el-icon>
              <el-icon v-else><Refresh /></el-icon>
            </button>
            <button
              class="file-explorer-utility-button utility-control"
              :disabled="preparingUploads"
              :aria-label="translate('generated.workspaceInspector.uploadFiles')"
              :aria-busy="preparingUploads || undefined"
              :title="translate('generated.workspaceInspector.uploadFiles2')"
              type="button"
              @click="chooseUploadFiles"
            >
              <el-icon v-if="preparingUploads" class="is-loading"><Loading /></el-icon>
              <el-icon v-else><DocumentAdd /></el-icon>
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
                translate('generated.workspaceInspector.foldersCannotBeDroppedCompressThemBefore')
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
            class="content-search-button file-explorer-utility-button utility-control"
            :disabled="contentSearchLoading"
            :aria-label="translate('generated.workspaceInspector.runContentSearch')"
            :aria-busy="contentSearchLoading || undefined"
            :title="translate('generated.workspaceInspector.runContentSearch2')"
            type="submit"
          >
            <el-icon v-if="contentSearchLoading" class="is-loading"><Loading /></el-icon>
            <el-icon v-else><Search /></el-icon>
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
              type="button"
              :title="match.path"
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
      <section v-else-if="activeSection === 'changes'" class="current-changes">
        <div v-if="visibleGitWorktrees.length > 0" class="git-worktrees">
          <div class="git-worktree-heading">
            <strong>{{ translate('gitWorktrees.title') }}</strong>
            <small v-if="gitWorktreesTruncated">
              {{ translate('gitWorktrees.truncated') }}
            </small>
          </div>
          <ul class="git-worktree-list" :aria-label="translate('gitWorktrees.title')">
            <li
              v-for="(worktree, index) in visibleGitWorktrees"
              :key="`${worktree.directoryName}:${worktree.head}:${index}`"
            >
              <strong class="git-worktree-name" :title="worktree.directoryName">
                {{ worktree.directoryName }}
              </strong>
              <code :title="worktreeReference(worktree)">
                {{ worktreeReference(worktree) }}
              </code>
              <span class="git-worktree-statuses">
                <el-tag v-if="worktree.current" effect="plain" size="small">
                  {{ translate('gitWorktrees.current') }}
                </el-tag>
                <el-tag :type="worktreeStatusType(worktree.status)" effect="plain" size="small">
                  {{ worktreeStatusLabel(worktree.status) }}
                </el-tag>
                <el-tag v-if="worktree.locked" type="warning" effect="plain" size="small">
                  {{ translate('gitWorktrees.locked') }}
                </el-tag>
                <el-tag v-if="worktree.prunable" type="info" effect="plain" size="small">
                  {{ translate('gitWorktrees.prunable') }}
                </el-tag>
              </span>
            </li>
          </ul>
        </div>
        <p v-else-if="gitWorktreesTruncated" class="git-worktrees-truncated" role="status">
          {{ translate('gitWorktrees.truncated') }}
        </p>
        <p
          v-for="(error, index) in changeDiscoveryErrors"
          :key="index"
          class="change-repository-empty"
          role="status"
        >
          {{ gitGroupErrorMessage(error) }}
        </p>
        <p v-if="visibleChangeRepositories.length === 0" class="empty">
          {{ translate('generated.workspaceInspector.theWorkspaceHasNoRepositoriesToDisplay') }}
        </p>
        <ul v-else class="change-list">
          <template
            v-for="repository in visibleChangeRepositories"
            :key="repositoryKey(repository)"
          >
            <li class="change-repository-heading" :data-repository-path="repository.repositoryPath">
              <div class="repository-heading-content">
                <div class="repository-title-row">
                  <strong :title="repository.physicalPath || repository.repositoryPath">
                    {{ repository.repositoryName }}
                  </strong>
                  <code
                    v-if="repositoryReference(repository)"
                    class="repository-branch current-branch"
                    :title="repositoryReference(repository)"
                  >
                    {{ repositoryReference(repository) }}
                  </code>
                  <button
                    v-if="repository.source === 'ROOT'"
                    class="changes-refresh-button file-explorer-utility-button utility-control"
                    :disabled="changesRefreshing"
                    :aria-label="translate('generated.workspaceInspector.refreshGitChanges')"
                    :aria-busy="changesRefreshing || undefined"
                    :title="translate('generated.workspaceInspector.refreshGitChanges2')"
                    type="button"
                    @click="loadChanges()"
                  >
                    <el-icon v-if="changesRefreshing" class="is-loading"><Loading /></el-icon>
                    <el-icon v-else><Refresh /></el-icon>
                  </button>
                </div>
                <div class="repository-tags-row">
                  <el-tag class="repository-kind" type="info" effect="plain" size="small">
                    {{ repositoryKindLabel(repository.source) }}
                  </el-tag>
                  <el-tag v-if="repository.current" effect="plain" size="small">
                    {{ translate('gitWorktrees.current') }}
                  </el-tag>
                  <el-tag
                    v-if="repository.status"
                    :type="worktreeStatusType(repository.status)"
                    effect="plain"
                    size="small"
                  >
                    {{ worktreeStatusLabel(repository.status) }}
                  </el-tag>
                  <el-tag v-if="repository.locked" type="warning" effect="plain" size="small">
                    {{ translate('gitWorktrees.locked') }}
                  </el-tag>
                  <el-tag v-if="repository.prunable" type="info" effect="plain" size="small">
                    {{ translate('gitWorktrees.prunable') }}
                  </el-tag>
                  <el-tag
                    v-if="
                      repository.tracking &&
                      (repository.tracking.ahead > 0 || repository.tracking.behind > 0)
                    "
                    class="repository-sync-tag"
                    effect="plain"
                    size="small"
                    :title="translate('gitSync.description', repository.tracking)"
                    :aria-label="translate('gitSync.description', repository.tracking)"
                  >
                    <span aria-hidden="true"
                      >↓ {{ repository.tracking.behind }} ↑ {{ repository.tracking.ahead }}</span
                    >
                  </el-tag>
                </div>
                <code
                  v-if="repository.source === 'SUBMODULE' && repository.repositoryPath"
                  class="repository-relative-path"
                  :title="repository.repositoryPath"
                >
                  {{ repository.repositoryPath }}
                </code>
                <code
                  v-if="
                    (repository.source === 'WORKTREE' || repository.source === 'ROOT') &&
                    repository.physicalPath
                  "
                  class="repository-physical-path"
                  :title="repository.physicalPath"
                >
                  {{ repository.physicalPath }}
                </code>
              </div>
            </li>
            <li v-if="repository.changes.length === 0" class="change-repository-empty">
              {{
                repository.error !== undefined
                  ? gitGroupErrorMessage(repository.error)
                  : repository.status === 'UNAVAILABLE'
                    ? translate('gitWorktrees.unavailable')
                    : translate('generated.workspaceInspector.noUncommittedChanges')
              }}
            </li>
            <li v-for="entry in repository.changes" :key="changeKey(entry)" class="change-entry">
              <button
                class="change-path"
                type="button"
                :aria-label="
                  entry.diffAvailable
                    ? translate('generated.workspaceInspector.viewDiffFor', {
                        value0: workspaceChangePath(entry)
                      })
                    : translate('generated.workspaceInspector.preview', {
                        value0: workspaceChangePath(entry)
                      })
                "
                :title="workspaceChangePath(entry)"
                @click="openChange(entry, $event)"
              >
                <span class="change-path-content">
                  <span class="change-file-heading"
                    ><FileTypeIcon :name="changeFileName(entry.path)" /><strong
                      class="change-file-name"
                      >{{ changeFileName(entry.path) }}</strong
                    ></span
                  >
                  <small v-if="changeDirectory(entry.path)" class="change-directory">
                    {{ changeDirectory(entry.path) }}
                  </small>
                </span>
              </button>
              <span :title="entry.change">{{ shortChange(entry.change) }}</span>
              <small :title="entry.state">{{ shortState(entry.state) }}</small>
              <el-button
                class="change-restore utility-control"
                text
                :icon="RefreshLeft"
                :loading="restoringPath === changeKey(entry)"
                :disabled="restoringPath !== undefined"
                :aria-label="
                  entry.state === 'UNTRACKED'
                    ? translate('generated.workspaceInspector.deleteChangesTo', {
                        value0: workspaceChangePath(entry)
                      })
                    : translate('generated.workspaceInspector.revertChangesTo', {
                        value0: workspaceChangePath(entry)
                      })
                "
                :title="
                  entry.state === 'UNTRACKED'
                    ? translate('generated.workspaceInspector.deleteUntrackedFile2')
                    : translate('generated.workspaceInspector.revertChanges2')
                "
                size="small"
                @click="restoreChange(entry)"
              />
            </li>
          </template>
        </ul>
      </section>
      <section v-else-if="activeSection === 'history'" class="git-history">
        <div class="history-toolbar">
          <el-select
            v-model="historyRepositorySelection"
            class="history-filter"
            :aria-label="translate('generated.workspaceInspector.selectGitRepository')"
            :placeholder="translate('generated.workspaceInspector.selectAGitRepository')"
            size="small"
            @change="changeHistoryRepository"
          >
            <el-option
              v-for="repository in historyRepositories"
              :key="repository.value"
              :label="repository.label"
              :value="repository.value"
            />
          </el-select>
          <el-select
            v-model="selectedHistoryRefs"
            class="history-filter"
            :aria-label="translate('generated.workspaceInspector.selectGitBranch')"
            :placeholder="translate('generated.workspaceInspector.allBranches')"
            multiple
            collapse-tags
            collapse-tags-tooltip
            clearable
            size="small"
            @change="resetHistory"
          >
            <el-option-group :label="translate('generated.workspaceInspector.localBranches')">
              <el-option
                v-for="item in historyRefs.filter((entry) => entry.kind === 'LOCAL')"
                :key="item.name"
                :label="item.displayName"
                :value="item.name"
              />
            </el-option-group>
            <el-option-group :label="translate('generated.workspaceInspector.remoteBranches')">
              <el-option
                v-for="item in historyRefs.filter((entry) => entry.kind === 'REMOTE')"
                :key="item.name"
                :label="item.displayName"
                :value="item.name"
              />
            </el-option-group>
          </el-select>
          <button
            class="history-refresh file-explorer-utility-button utility-control"
            :disabled="historyLoading"
            :aria-label="translate('generated.workspaceInspector.refreshGitHistory')"
            :aria-busy="historyLoading || undefined"
            :title="translate('generated.workspaceInspector.refreshGitHistory2')"
            type="button"
            @click="resetHistory"
          >
            <el-icon v-if="historyLoading" class="is-loading"><Loading /></el-icon>
            <el-icon v-else><Refresh /></el-icon>
          </button>
        </div>
        <p v-if="!historyLoading && historyCommits.length === 0" class="empty">
          {{ translate('generated.workspaceInspector.noGitCommitHistory') }}
        </p>
        <ul v-else class="history-list">
          <li
            v-for="{ commit, graph } in historyGraphRows"
            :key="commit.hash"
            class="history-commit"
          >
            <button
              class="history-commit-row"
              type="button"
              :title="`${commit.subject || translate('generated.workspaceInspector.untitled')}\n${commit.authorName} · ${historyTime(commit.committedAt)}${commit.refs.length > 0 ? `\n${commit.refs.join(', ')}` : ''}`"
              @click="toggleHistoryCommit(commit)"
              @contextmenu="openHistoryContextMenu(commit, $event)"
            >
              <svg
                class="history-graph"
                :style="{ width: `${gitGraphWidth(graph)}px` }"
                :viewBox="`0 0 ${gitGraphWidth(graph)} 38`"
                aria-hidden="true"
              >
                <path
                  v-for="(edge, edgeIndex) in graph.edges"
                  :key="`${commit.hash}:${edgeIndex}`"
                  class="history-graph-edge"
                  :class="`history-graph-color-${edge.color % 6}`"
                  :d="edge.path"
                />
                <circle
                  class="history-graph-node-ring"
                  :cx="gitGraphNodeX(graph)"
                  cy="19"
                  r="4.5"
                />
                <circle
                  class="history-graph-node"
                  :class="`history-graph-color-${graph.lane % 6}`"
                  :cx="gitGraphNodeX(graph)"
                  cy="19"
                  r="3"
                />
              </svg>
              <span class="history-content">
                <span class="history-title-row">
                  <span class="history-subject">{{
                    commit.subject || translate('generated.workspaceInspector.untitled2')
                  }}</span>
                  <span
                    v-for="refName in commit.refs"
                    :key="refName"
                    class="history-ref"
                    :title="refName"
                    >{{ refName }}</span
                  >
                </span>
                <small>{{ commit.authorName }} · {{ historyTime(commit.committedAt) }}</small>
              </span>
            </button>
            <div
              v-if="expandedHistoryCommits.includes(commit.hash)"
              class="history-expanded"
              :style="{ gridTemplateColumns: `${gitGraphWidth(graph)}px minmax(0, 1fr)` }"
            >
              <svg
                class="history-graph-continuation"
                :style="{ width: `${gitGraphWidth(graph)}px` }"
                aria-hidden="true"
              >
                <line
                  v-for="lane in graph.outgoingLaneCount"
                  :key="lane"
                  :class="`history-graph-color-${(lane - 1) % 6}`"
                  :x1="(lane - 1) * 14 + 7"
                  y1="0"
                  :x2="(lane - 1) * 14 + 7"
                  y2="100%"
                />
              </svg>
              <ul class="history-files">
                <li v-if="historyFilesLoading === commit.hash" class="empty" role="status">
                  <BusyIndicator />
                  {{ translate('generated.workspaceInspector.loadingCommitFiles') }}
                </li>
                <li
                  v-for="row in historyFileRows(
                    historyFiles[commit.hash] ?? [],
                    expandedHistoryDirectories[commit.hash] ?? []
                  )"
                  :key="
                    row.kind === 'DIRECTORY'
                      ? `directory:${row.path}`
                      : `file:${row.file.previousPath ?? ''}:${row.file.path}`
                  "
                >
                  <el-button
                    v-if="row.kind === 'DIRECTORY'"
                    text
                    size="small"
                    class="history-directory"
                    :style="{ paddingLeft: historyTreeIndent(row.depth) }"
                    :title="row.path"
                    :aria-expanded="
                      (expandedHistoryDirectories[commit.hash] ?? []).includes(row.path)
                    "
                    @click.stop="toggleHistoryDirectory(commit.hash, row.path)"
                  >
                    <el-icon
                      class="history-directory-toggle"
                      :class="{
                        'is-expanded': (expandedHistoryDirectories[commit.hash] ?? []).includes(
                          row.path
                        )
                      }"
                      ><ArrowRight
                    /></el-icon>
                    <FileTypeIcon :name="row.name" kind="DIRECTORY" />{{ row.name }}
                  </el-button>
                  <el-button
                    v-else
                    text
                    size="small"
                    :title="
                      row.file.previousPath
                        ? `${row.file.previousPath} → ${row.file.path}`
                        : row.file.path
                    "
                    :style="{ paddingLeft: historyTreeIndent(row.depth) }"
                    @click.stop="openHistoryDiff(commit, row.file, $event)"
                  >
                    <span class="history-file-status">{{ shortChange(row.file.change) }}</span>
                    <FileTypeIcon :name="row.name" />
                    <span class="history-file-path">{{ row.name }}</span>
                  </el-button>
                </li>
              </ul>
            </div>
          </li>
        </ul>
        <Teleport to="body">
          <div
            v-if="historyContextMenu !== undefined"
            class="history-context-menu"
            :style="{ left: `${historyContextMenu.x}px`, top: `${historyContextMenu.y}px` }"
            role="menu"
          >
            <button type="button" role="menuitem" @click="copyHistoryCommitId">
              <el-icon><DocumentCopy /></el-icon>
              {{ translate('generated.workspaceInspector.copyCommitId') }}
            </button>
          </div>
        </Teleport>
        <el-button
          v-if="historyNextCursor !== null"
          class="history-load-more"
          link
          :loading="historyLoading"
          :disabled="historyLoading"
          @click="loadHistory(false)"
        >
          {{ translate('generated.workspaceInspector.loadMore') }}
        </el-button>
      </section>
    </template>
  </article>
  <Teleport to="body">
    <WorkspaceFileTabs
      v-if="workspaceFileTabs.length > 0"
      ref="workspaceFileTabsRef"
      :tabs="workspaceFileTabs"
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
    v-model="uploadDialogOpen"
    class="upload-confirm-dialog"
    :title="translate('generated.workspaceInspector.confirmFileUpload')"
    append-to-body
    width="560px"
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
  gap: 0.2rem;
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
  padding: 0.3rem 0.55rem;
  font-size: var(--mar-font-size-body);
  font-weight: 500;
}

@media (min-width: 768px) {
  .inspector-tabs button {
    font-size: calc(var(--mar-font-size-body) - 1px);
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
  padding: 0.35rem 0.25rem;
  text-align: left;
  cursor: pointer;
}

.content-search-results button:hover,
.content-search-results button:focus-visible {
  background: var(--mar-color-brand-subtle);
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
.content-search-name,
.change-file-heading {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.35rem;
}
.content-search-name strong,
.change-file-heading strong {
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

.git-worktrees {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--mar-border-strong);
  padding: 0.15rem 2px 0.4rem;
}

.git-worktree-heading {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  justify-content: space-between;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-meta);
}

.git-worktree-heading small {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
  font-weight: 400;
}

.git-worktree-list {
  display: grid;
  gap: 0.25rem;
  overflow-x: hidden;
  overflow-y: auto;
  max-height: min(18rem, 35vh);
  margin: 0.3rem 0 0;
  padding: 0;
  list-style: none;
}

.git-worktree-list li {
  display: grid;
  grid-template-columns: minmax(6rem, 0.8fr) minmax(7rem, 1fr) auto;
  gap: 0.45rem;
  align-items: center;
  min-width: 0;
}

.git-worktree-name,
.git-worktree-list code {
  overflow: hidden;
  min-width: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-worktree-name {
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-meta);
  font-weight: 600;
}

.git-worktree-list code {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}

.git-worktree-statuses {
  display: flex;
  gap: 0.25rem;
  align-items: center;
  justify-content: flex-end;
}

.git-worktree-statuses :deep(.el-tag) {
  height: 1.25rem;
  padding-inline: 0.3rem;
  font-size: var(--mar-font-size-meta);
}

.git-worktrees-truncated {
  margin: 0;
  border-bottom: 1px solid var(--mar-border-strong);
  padding: 0.25rem 2px 0.4rem;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
}

.change-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.change-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  gap: 7px;
  align-items: center;
  border-top: 1px solid var(--mar-fill-hover);
  padding: 5px 2px;
}

.change-list .change-repository-heading {
  grid-column: 1 / -1;
  grid-template-columns: minmax(0, 1fr);
  margin-top: 0.75rem;
  border-top: 1px solid var(--mar-border-default);
  padding: 0.5rem 0.25rem 0.35rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  font-weight: 600;
}

.change-list > .change-repository-heading:first-child {
  margin-top: 0;
  border-top: 0;
  padding-top: 0.2rem;
}

.change-list .change-repository-empty {
  grid-column: 1 / -1;
  border-top: 0;
  padding: 0.2rem 2px 0.25rem;
  color: var(--mar-text-faint);
  font-size: var(--mar-font-size-meta);
}

.change-repository-heading strong {
  color: var(--mar-text-primary);
}

.repository-heading-content {
  display: grid;
  gap: 0.2rem;
  min-width: 0;
}

.repository-title-row {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  min-width: 0;
}

.repository-title-row strong {
  flex: 0 1 auto;
  overflow: hidden;
  min-width: 0;
  max-width: 60%;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repository-title-row .repository-branch {
  flex: 0 1 auto;
}

.repository-title-row .changes-refresh-button {
  flex: 0 0 auto;
  margin-left: auto;
}

.repository-tags-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem;
}

.repository-tags-row :deep(.el-tag) {
  height: 1.3rem;
  padding-inline: 0.28rem;
  font-size: var(--mar-font-size-meta);
  font-weight: 500;
}

.repository-sync-tag {
  font-variant-numeric: tabular-nums;
}

.change-repository-heading code {
  margin-left: 0;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
  font-weight: 400;
}

.current-branch {
  display: block;
  width: fit-content;
  overflow: hidden;
  min-width: 0;
  max-width: min(46vw, 20rem);
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repository-physical-path,
.repository-relative-path {
  display: block;
  overflow-wrap: anywhere;
  color: var(--mar-text-faint);
  line-height: 1.35;
  white-space: normal;
}

.change-list .change-path {
  justify-content: flex-start;
  overflow: hidden;
  min-width: 0;
  height: auto;
  padding: 0;
  color: var(--mar-text-primary);
  font-family: var(--mar-font-mono);
  font-size: var(--mar-font-size-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.change-list .change-entry,
.change-list .change-path,
.history-commit-row,
.history-files :deep(.el-button) {
  border-radius: var(--mar-radius-selection);
}

.change-list .change-entry:hover,
.change-list .change-entry:focus-within {
  background: var(--mar-fill-row-hover);
}

.change-list .change-path:not(.is-disabled):hover {
  color: var(--mar-text-primary);
}

.change-list .change-restore {
  min-width: 1.4rem;
  padding: 0.15rem;
}

.change-list > li > span {
  color: var(--mar-color-brand-text);
  font-size: var(--mar-font-size-meta);
}

.change-list small {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
}

.current-changes {
  margin-top: 0.2rem;
  padding-top: 0;
}

.workspace-inspector .current-changes {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.workspace-inspector .current-changes .change-list {
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
}

@media (max-width: 767px) {
  .workspace-inspector .run-form {
    grid-template-columns: 1fr auto;
  }

  .git-worktree-list li {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .git-worktree-list code {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .git-worktree-statuses {
    flex-wrap: wrap;
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

button.changes-refresh-button {
  min-width: var(--mar-compact-control-size);
  min-height: var(--mar-compact-control-size);
  margin-left: 0.15rem;
}
</style>

<style scoped>
.change-list li {
  gap: 3px;
  border-top: 0;
  min-height: 18px;
  color: var(--mar-text-primary);
  padding: 0 2px;
}
.change-list .change-path {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 18px;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 1px 2px;
  line-height: 1.1;
  font-size: var(--mar-font-size-meta);
  text-align: left;
  cursor: pointer;
}
.change-list .change-path:hover:not(:disabled),
.change-list .change-path:focus-visible {
  background: var(--mar-fill-hover);
}
.change-list .change-path:disabled {
  cursor: default;
  opacity: 0.6;
}
.change-path-content {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.change-file-heading {
  flex: 0 0 auto;
  overflow: hidden;
  max-width: 60%;
}
.change-file-heading .change-file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.change-list .change-file-name,
.change-list .change-directory {
  display: inline;
}
.change-list .change-file-name {
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-meta);
  font-weight: 500;
}
.change-list .change-directory {
  flex: 1 1 auto;
  overflow: hidden;
  min-width: 0;
  margin-left: 0.45rem;
  color: var(--mar-text-faint);
  font-family: inherit;
  font-size: var(--mar-font-size-nano);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.change-list > li > small {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
  line-height: 1;
}
.change-entry > span {
  font-size: var(--mar-font-size-nano);
}
.change-list .change-restore {
  min-width: 1.25rem;
  min-height: 18px;
  padding: 0.1rem;
}
:deep(.change-list .change-restore.el-button) {
  min-height: 18px;
}

.git-history {
  display: grid;
  gap: 8px;
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 6px;
}

.history-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr) auto;
  gap: 6px;
  align-items: center;
  min-width: 0;
}

.history-toolbar :deep(.el-select) {
  min-width: 0;
}

.history-filter :deep(.el-select__wrapper) {
  min-height: 26px;
  border: 0;
  background: transparent;
  box-shadow: none;
  padding-inline: 6px;
}

.history-filter :deep(.el-select__wrapper:hover),
.history-filter :deep(.el-select__wrapper.is-focused) {
  background: var(--mar-fill-hover);
  box-shadow: none;
}

button.history-refresh {
  width: 24px;
  min-width: 24px;
  height: 24px;
  min-height: 24px;
  color: var(--mar-text-tertiary);
}

.history-list,
.history-files {
  width: 100%;
  min-width: 0;
  list-style: none;
  margin: 0;
  padding: 0;
}

.history-commit {
  min-width: 0;
}

.history-commit-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 0 2px;
  text-align: left;
  cursor: pointer;
  min-height: 38px;
}

.history-graph {
  display: block;
  height: 38px;
  min-width: 14px;
  overflow: visible;
}

.history-expanded {
  display: grid;
  min-width: 0;
  position: relative;
  padding-inline: 2px;
}

.history-graph-continuation {
  display: block;
  position: absolute;
  inset-block: 0;
  left: 2px;
  height: 100%;
  overflow: visible;
}

.history-graph-continuation line {
  stroke: currentColor;
  stroke-linecap: round;
  stroke-width: 1.6;
}

.history-graph-edge {
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-width: 1.6;
}

.history-graph-node-ring {
  fill: var(--mar-bg-panel);
  stroke: var(--mar-bg-panel);
  stroke-width: 3;
}

.history-graph-node {
  fill: currentColor;
  stroke: currentColor;
}

.history-graph-color-0 {
  color: var(--mar-color-brand-text);
}

.history-graph-color-1 {
  color: var(--mar-color-success-text);
}

.history-graph-color-2 {
  color: var(--mar-color-accent);
}

.history-graph-color-3 {
  color: var(--mar-color-warning-text);
}

.history-graph-color-4 {
  color: var(--mar-text-secondary);
}

.history-graph-color-5 {
  color: var(--mar-color-danger-text);
}

.history-context-menu {
  position: fixed;
  z-index: 5000;
  min-width: 176px;
  overflow: hidden;
  border: 1px solid var(--mar-border-subtle);
  border-radius: 5px;
  background: var(--mar-bg-panel);
  box-shadow: var(--el-box-shadow-light);
  padding: 4px;
}

.history-context-menu button {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 28px;
  gap: 7px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--mar-text-primary);
  font: inherit;
  font-size: var(--mar-font-size-meta);
  padding: 4px 8px;
  text-align: left;
  cursor: pointer;
}

.history-context-menu button:hover,
.history-context-menu button:focus-visible {
  background: var(--mar-fill-hover);
  outline: none;
}

.history-commit-row:hover {
  background: var(--mar-fill-row-hover);
}

.history-content,
.history-title-row {
  display: flex;
  min-width: 0;
}

.history-content {
  flex-direction: column;
  gap: 1px;
  padding-block: 4px;
}

.history-title-row {
  align-items: center;
  gap: 4px;
}

.history-subject {
  min-width: 0;
  overflow: hidden;
  font-size: var(--mar-font-size-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-ref {
  flex: 0 1 auto;
  max-width: 92px;
  overflow: hidden;
  border-radius: 8px;
  background: var(--mar-color-brand-subtle);
  color: var(--mar-color-brand-text);
  font-size: var(--mar-font-size-nano);
  padding: 1px 5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-content small {
  overflow: hidden;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-nano);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-files {
  grid-column: 2;
  min-width: 0;
  margin: 0;
  border: 1px solid var(--mar-border-subtle);
  border-radius: 5px;
  padding: 3px 0;
}

.history-files > .empty {
  padding: 1px 2px;
  font-size: var(--mar-font-size-meta);
  line-height: 18px;
}

.history-directory {
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: 20px;
  gap: 4px;
  overflow: hidden;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-files :deep(.history-directory.el-button) {
  justify-content: flex-start;
}

.history-directory .el-icon {
  flex: none;
  font-size: 10px;
}

.history-directory-toggle {
  margin-right: 2px;
  transition: transform 120ms ease;
}

.history-directory-toggle.is-expanded {
  transform: rotate(90deg);
}

.history-files :deep(.el-button) {
  justify-content: flex-start;
  width: 100%;
  min-height: 20px;
  overflow: hidden;
  padding: 1px 2px;
  font-size: var(--mar-font-size-body);
  line-height: 18px;
}

.history-files :deep(.el-button span) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-file-path {
  flex: 1;
  text-align: left;
}

.history-file-status {
  display: inline-block;
  flex: none;
  width: 16px;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-nano);
}

.history-files :deep(.file-type-icon) {
  width: 12px;
  flex-basis: 12px;
  margin-right: 3px;
  overflow: visible;
  font-size: var(--mar-font-size-meta);
}

.history-load-more {
  justify-self: center;
  color: var(--mar-color-brand-text);
  font-size: var(--mar-font-size-meta);
  line-height: 20px;
  text-decoration: none;
}

.history-load-more:hover {
  text-decoration: underline;
}

.history-load-more[aria-disabled='true'] {
  color: var(--mar-text-faint);
  cursor: default;
  text-decoration: none;
}

@media (max-width: 767px) {
  .history-toolbar {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .history-toolbar > .history-filter:nth-child(2) {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .history-toolbar > .history-refresh {
    grid-column: 2;
    grid-row: 1;
  }
}
</style>
