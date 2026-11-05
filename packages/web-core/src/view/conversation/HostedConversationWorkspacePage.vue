<script setup lang="ts">
import { createMobileSurfaceFocusService } from '../../service/mobile-surface-focus-service.js';
import { showMessage } from '../../service/message-feedback-service.js';

import MarIcon from '../common/MarIcon.vue';
import { marIcon } from '../../util/mar-icons.js';
import type {
  ConversationFileProjection,
  HostedConversationSnapshot,
  HostedConversationSummary
} from '@myagentroam/protocol';
import { ElMessageBox } from '../../service/message-box-service.js';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { createConversationImageService } from '../../service/conversation-image-service.js';
import { createConversationScrollService } from '../../service/conversation-scroll-service.js';
import {
  buildHostedConversationFileTree,
  visibleHostedConversationFileTreeRows
} from '../../service/hosted-conversation-file-tree-service.js';
import { createHostedConversationFilePreviewService } from '../../service/hosted-conversation-file-preview-service.js';
import { projectedFilePath } from '../../service/hosted-conversation-file-preview-service.js';
import { createStandaloneFileWindowService } from '../../service/standalone-file-window-service.js';
import { translate } from '../../service/locale-preference-service.js';
import {
  hostedConversationFileForPath,
  type createHostedConversationWorkspaceService
} from '../../service/hosted-conversation-workspace-service.js';
import { errorCode } from '../../util/api-error.js';
import type { ConversationItem, ConversationTurn } from '../../model/workbench.js';
import { conversationItemText } from '../../util/conversation-presentation.js';
import { absoluteSessionTime } from '../../util/time-presentation.js';
import { vSessionReorderMotion } from '../common/session-reorder-motion.js';
import { errorMessage, filePreviewErrorSummary } from '../../util/error-presentation.js';
import { fileSizeLabel } from '../../util/file-presentation.js';
import { isMarkdownFile } from '../../util/file-preview.js';
import { hostedConversationTitle } from '../../util/hosted-conversation-presentation.js';
import ConversationScroll from './ConversationScroll.vue';
import BusyIndicator from '../common/BusyIndicator.vue';
import ConversationTimeline from './ConversationTimeline.vue';
import ToolChangeReviewWindow from '../workspace/ToolChangeReviewWindow.vue';
import { createToolChangeReviewService } from '../../service/tool-change-review-service.js';
import type { FileChangeEntry } from '../../util/conversation-presentation.js';
import HostedConversationComposer from '../../view/conversation/HostedConversationComposer.vue';
import HostedConversationEntryPage from '../../view/conversation/HostedConversationEntryPage.vue';
import { createHostedConversationEntryService } from '../../service/hosted-conversation-entry-service.js';
import ImagePreviewDialogs from './ImagePreviewDialogs.vue';
import WorkspaceTextFilePage from '../workspace/WorkspaceTextFilePage.vue';
import WorkspaceFormatFilePage from '../workspace/WorkspaceFormatFilePage.vue';
import FilePreviewSurface from '../workspace/FilePreviewSurface.vue';

const props = defineProps<{
  readonly connected?: boolean;
  readonly workspace: ReturnType<typeof createHostedConversationWorkspaceService>;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly mobileViewport: boolean;
  readonly mobileHistoryOpen: boolean;
  readonly sidebarCollapsed: boolean;
  readonly selectConversation: (
    conversation: HostedConversationSummary,
    initialSnapshot?: HostedConversationSnapshot
  ) => Promise<void>;
  readonly routeTarget:
    | {
        readonly nodeId: string;
        readonly conversationId: string;
      }
    | undefined;
  readonly restoringRoute: boolean;
  readonly clearConversation: () => void;
  readonly hasUnreadConversation: (nodeId: string, conversationId: string) => boolean;
}>();
const standaloneFileWindow = createStandaloneFileWindowService();
const toolReview = createToolChangeReviewService(props.request);
const toolChangeEnabled = computed(() => interactionReady.value);
function openFileChange(entry: FileChangeEntry): void {
  const nodeId = props.workspace.selectedNodeId.value;
  const sessionId = props.workspace.selectedConversationId.value;
  if (!nodeId || !sessionId || !toolChangeEnabled.value) return;
  toolReview.open(entry, { nodeId, sessionId, workspaceId: '', scope: 'HOSTED' });
}
async function openChangeSourceFile(path: string): Promise<void> {
  const file = hostedConversationFileForPath(props.workspace.snapshot.value?.files ?? [], path);
  if (!file) {
    showMessage(translate('presentation.currentFileUnavailable'), 'error');
    return;
  }
  await filePreview.openFile(file);
  if (filePreview.visible.value) toolReview.clear();
}
const emit = defineEmits<{
  closeMobileHistory: [];
}>();

const filter = ref('');
const loadingDirectory = ref(false);
const historyList = ref<HTMLElement>();
const historyAppendMarker = ref<HTMLElement>();
const retryingDirectory = ref(false);
let historyAppendObserver: IntersectionObserver | undefined;
function canAppendHistory(): boolean {
  return (
    !props.workspace.loadingConversations.value &&
    !props.workspace.loadingMoreConversations.value &&
    props.workspace.loadMoreConversationsError.value === undefined &&
    props.workspace.hasMoreConversations.value &&
    props.connected !== false &&
    filter.value.trim() === '' &&
    (props.mobileViewport ? props.mobileHistoryOpen : !props.sidebarCollapsed)
  );
}
watch(
  () => [
    historyList.value,
    historyAppendMarker.value,
    props.workspace.conversations.value,
    props.workspace.loadingMoreConversations.value,
    props.workspace.loadMoreConversationsError.value,
    props.workspace.hasMoreConversations.value,
    props.connected,
    props.mobileViewport,
    props.mobileHistoryOpen,
    props.sidebarCollapsed,
    props.workspace.loadingConversations.value,
    filter.value
  ],
  () => {
    historyAppendObserver?.disconnect();
    if (!props.workspace.loadingMoreConversations.value) retryingDirectory.value = false;
    if (
      !historyList.value ||
      !historyAppendMarker.value ||
      !canAppendHistory() ||
      typeof IntersectionObserver === 'undefined'
    )
      return;
    historyAppendObserver = new IntersectionObserver(
      (entries) => {
        if (
          entries.some((entry) => entry.isIntersecting) &&
          canAppendHistory() &&
          (historyList.value?.getClientRects().length ?? 0) > 0
        ) {
          historyAppendObserver?.disconnect();
          void props.workspace.loadMoreConversations();
        }
      },
      { root: historyList.value, rootMargin: '0px 0px 120px 0px' }
    );
    historyAppendObserver.observe(historyAppendMarker.value);
  },
  { flush: 'post' }
);
function retryDirectoryAppend(): void {
  if (props.workspace.loadingMoreConversations.value) return;
  retryingDirectory.value = true;
  void props.workspace.loadMoreConversations();
}
const openingConversationKey = ref<string>();
const openingFailure = shallowRef<{ readonly key: string; readonly error: unknown }>();
let openingConversationSequence = 0;
const waitingForSnapshot = computed(
  () =>
    props.connected !== false &&
    (props.workspace.watchLoading.value ||
      (props.workspace.watchFailureCode.value === undefined &&
        (openingConversationKey.value !== undefined || props.restoringRoute)))
);
const conversationLoadFailed = computed(
  () =>
    props.workspace.watchFailureCode.value !== undefined ||
    (!props.workspace.watchReady.value &&
      openingFailure.value?.key === selectedConversationKey.value)
);
const conversationLoadError = computed(() => {
  const failure =
    props.workspace.watchFailure.value ??
    (openingFailure.value?.key === selectedConversationKey.value
      ? openingFailure.value.error
      : undefined);
  if (failure !== undefined) return hostedErrorMessage(failure);
  const code = props.workspace.watchFailureCode.value;
  return code === undefined ? undefined : hostedErrorMessage(new Error(code));
});
const mutatingConversationKey = ref<string>();
const actionConversationKey = ref<string>();
const actionMenuVisible = ref(false);
const hoveredConversationKey = ref<string>();
const focusedConversationKey = ref<string>();
const draftingNewConversation = ref(false);
const entry = createHostedConversationEntryService(props.request, {
  submission: {
    workspace: props.workspace,
    select: (snapshot) => props.selectConversation(snapshot.conversation, snapshot)
  }
});
const mobileFilesOpen = defineModel<boolean>('mobileFilesOpen', { default: false });
const filesDragging = ref(false);
const uploadingDroppedFiles = ref(false);
const relatedFilesInput = ref<HTMLInputElement>();
const deletingFileId = ref<string>();
const rollbackPending = ref(false);
const composer = ref<{ restoreMessage(text: string): void }>();
const conversationScrollElement = ref<HTMLElement>();
const expandedFileDirectories = ref<ReadonlySet<string>>(new Set());
let directorySequence = 0;
let filesDragDepth = 0;
let conversationResizeObserver: ResizeObserver | undefined;

const filteredConversations = computed(() => {
  const query = filter.value.trim().toLocaleLowerCase();
  if (query === '') return props.workspace.conversations.value;
  return props.workspace.conversations.value.filter((conversation) =>
    hostedConversationTitle(conversation).toLocaleLowerCase().includes(query)
  );
});
const historyReorderSnapshot = computed(() => ({
  context: filter.value.trim().toLocaleLowerCase(),
  ready:
    props.connected !== false &&
    !loadingDirectory.value &&
    !props.workspace.loadingMoreConversations.value,
  items: filteredConversations.value.map((conversation) => ({
    key: conversationKey(conversation),
    lastActivityAt: conversation.lastActivityAt,
    pin: conversation.pinnedAt
  }))
}));
const selectedSummary = computed(
  () =>
    props.workspace.snapshot.value?.conversation ??
    props.workspace.conversations.value.find(
      (conversation) =>
        conversation.nodeId === props.workspace.selectedNodeId.value &&
        conversation.id === props.workspace.selectedConversationId.value
    )
);
const interactionReady = computed(() => {
  const conversation = props.workspace.snapshot.value?.conversation;
  return (
    props.workspace.watchFailureCode.value === undefined &&
    conversation !== undefined &&
    conversation.status === 'ACTIVE'
  );
});
const rollbackEnabled = computed(
  () =>
    interactionReady.value &&
    props.workspace.snapshot.value?.conversation.activity.status === 'IDLE' &&
    props.workspace.snapshot.value !== undefined
);
const filesWritable = computed(
  () => interactionReady.value && !props.workspace.templateChanging.value
);
const readonlyVisible = computed(() => {
  if (selectedSummary.value === undefined) return false;
  if (props.workspace.watchFailureCode.value !== undefined) return true;
  return props.workspace.snapshot.value !== undefined && !interactionReady.value;
});
const readonlyReason = computed(() => {
  if (props.workspace.watchFailureCode.value !== undefined)
    return translate('hostedConversations.watchUnavailableReadonly');
  return translate('hostedConversations.readonly');
});
const filesByCategory = computed(() => {
  const groups = new Map<ConversationFileProjection['category'], ConversationFileProjection[]>([
    ['UPLOAD', []],
    ['OUTPUT', []]
  ]);
  for (const file of props.workspace.snapshot.value?.files ?? [])
    groups.get(file.category)!.push(file);
  return [...groups.entries()].map(([category, files]) => {
    const tree = buildHostedConversationFileTree(files);
    return {
      category,
      files,
      rows: visibleHostedConversationFileTreeRows(tree, (path) =>
        expandedFileDirectories.value.has(fileDirectoryKey(category, path))
      )
    };
  });
});
const timelineTurns = computed(() => props.workspace.turns.value);
const selectedConversationKey = computed(
  () =>
    `${props.workspace.selectedNodeId.value ?? ''}:${props.workspace.selectedConversationId.value ?? ''}`
);
const conversationScrollService = createConversationScrollService();
const conversationImages = createConversationImageService(props.workspace.selectedNodeId, {
  sourceUrl: ({ nodeId, runId, imageSelector }) => {
    const conversationId = props.workspace.selectedConversationId.value;
    if (conversationId === undefined) return undefined;
    return `/api/nodes/${encodeURIComponent(nodeId)}/hosted-conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/images/${encodeURIComponent(imageSelector)}`;
  }
});
const filePage = ref<{ focus(): void }>();
const filePreview = createHostedConversationFilePreviewService({
  source: props.workspace
});
const filePreviewError = computed(() =>
  filePreview.error.value === undefined
    ? undefined
    : filePreviewErrorSummary(filePreview.error.value, filePreview.file.value?.relativePath ?? '')
);

function closeMobileHistory(): void {
  emit('closeMobileHistory');
}

function closeMobilePanels(): void {
  mobileFilesOpen.value = false;
  closeMobileHistory();
}

function openMobileFiles(): void {
  closeMobileHistory();
  mobileFilesOpen.value = true;
}

function fileDirectoryKey(category: ConversationFileProjection['category'], path: string): string {
  return `${category}:${path}`;
}

function fileDirectoryExpanded(
  category: ConversationFileProjection['category'],
  path: string
): boolean {
  return expandedFileDirectories.value.has(fileDirectoryKey(category, path));
}

function toggleFileDirectory(category: ConversationFileProjection['category'], path: string): void {
  const key = fileDirectoryKey(category, path);
  const next = new Set(expandedFileDirectories.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedFileDirectories.value = next;
}

function fileDirectoryActionLabel(
  category: ConversationFileProjection['category'],
  path: string
): string {
  return translate(
    fileDirectoryExpanded(category, path)
      ? 'hostedConversations.collapseFileDirectory'
      : 'hostedConversations.expandFileDirectory',
    { category: categoryLabel(category), path }
  );
}

function handleConversationScroll(): void {
  conversationScrollService.handleScroll(() => {
    if (props.workspace.olderHistoryError.value === undefined) void loadOlderConversationHistory();
  });
}

function setConversationScrollElement(element: HTMLElement | undefined): void {
  conversationResizeObserver?.disconnect();
  conversationScrollElement.value = element;
  conversationScrollService.setElement(element);
  if (element === undefined) return;
  conversationResizeObserver = new ResizeObserver(() => conversationScrollService.handleResize());
  conversationResizeObserver.observe(element);
  if (conversationScrollService.following.value)
    void conversationScrollService.scrollToLatestAfterLayout();
}

async function loadOlderConversationHistory(): Promise<void> {
  const element = conversationScrollElement.value;
  const previousHeight = element?.scrollHeight ?? 0;
  const target = selectedConversationKey.value;
  await props.workspace.loadOlderHistory();
  await nextTick();
  if (
    target === selectedConversationKey.value &&
    element === conversationScrollElement.value &&
    element !== undefined &&
    props.workspace.olderHistoryError.value === undefined
  )
    element.scrollTop += element.scrollHeight - previousHeight;
}

async function initialize(): Promise<void> {
  await loadDirectory();
}

async function loadDirectory(): Promise<void> {
  const sequence = ++directorySequence;
  loadingDirectory.value = true;
  try {
    await props.workspace.loadConversations();
    if (sequence !== directorySequence) return;
    if (draftingNewConversation.value) return;
    const currentId = props.workspace.selectedConversationId.value;
    const selectedRouteTarget =
      props.routeTarget !== undefined &&
      props.workspace.selectedNodeId.value === props.routeTarget.nodeId &&
      currentId === props.routeTarget.conversationId;
    const awaitingRouteSnapshot =
      props.restoringRoute ||
      (selectedRouteTarget &&
        props.workspace.snapshot.value === undefined &&
        props.workspace.watchFailureCode.value === undefined);
    const currentExists =
      props.workspace.selectedNodeId.value !== undefined &&
      props.workspace.conversations.value.some(
        (conversation) =>
          conversation.nodeId === props.workspace.selectedNodeId.value &&
          conversation.id === currentId
      );
    if (awaitingRouteSnapshot || currentExists) return;
    props.clearConversation();
    const initial = props.workspace.conversations.value[0];
    if (initial !== undefined) await openConversation(initial, false);
    else {
      entry.resume();
      draftingNewConversation.value = true;
    }
  } catch (error) {
    if (sequence === directorySequence) showMessage(hostedErrorMessage(error), 'error', error);
  } finally {
    if (sequence === directorySequence) loadingDirectory.value = false;
  }
}

async function refreshDirectory(): Promise<void> {
  await loadDirectory();
}

async function openConversation(
  conversation: HostedConversationSummary,
  closePanels = true
): Promise<void> {
  const key = conversationKey(conversation);
  if (openingConversationKey.value === key) return;
  const sequence = ++openingConversationSequence;
  openingConversationKey.value = key;
  openingFailure.value = undefined;
  entry.suspend();
  draftingNewConversation.value = false;
  if (closePanels) closeMobilePanels();
  try {
    await props.selectConversation(conversation);
  } catch (error) {
    if (sequence === openingConversationSequence)
      openingFailure.value = { key: `${conversation.nodeId}:${conversation.id}`, error };
  } finally {
    if (sequence === openingConversationSequence) openingConversationKey.value = undefined;
  }
}

function retryConversation(): void {
  const conversation = selectedSummary.value;
  if (conversation === undefined || waitingForSnapshot.value || props.connected === false) return;
  void openConversation(conversation, false);
}

function beginNewConversation(): void {
  entry.resume();
  draftingNewConversation.value = true;
  props.clearConversation();
  closeMobilePanels();
}

function firstMessageStarted(): void {
  draftingNewConversation.value = false;
  closeMobilePanels();
}

async function editConversationTitle(conversation: HostedConversationSummary): Promise<void> {
  if (mutatingConversationKey.value !== undefined) return;
  let title: string;
  try {
    title = (
      await ElMessageBox.prompt(
        translate('hostedConversations.titlePrompt'),
        translate('hostedConversations.editTitle'),
        {
          closeIcon: marIcon('close'),
          inputValue: hostedConversationTitle(conversation),
          inputPlaceholder: translate('hostedConversations.titlePlaceholder'),
          inputValidator: (candidate) => {
            const length = candidate.trim().length;
            if (length === 0) return translate('hostedConversations.titleRequired');
            return length <= 160 || translate('hostedConversations.titleTooLong');
          },
          confirmButtonText: translate('common.save'),
          cancelButtonText: translate('common.cancel')
        }
      )
    ).value;
  } catch {
    return;
  }
  const key = conversationKey(conversation);
  mutatingConversationKey.value = key;
  try {
    await props.workspace.updateMetadata(
      { title: title.trim() },
      conversation.nodeId,
      conversation.id
    );
  } catch (error) {
    showMessage(hostedErrorMessage(error), 'error', error);
  } finally {
    if (mutatingConversationKey.value === key) mutatingConversationKey.value = undefined;
  }
}

async function setConversationPinned(
  conversation: HostedConversationSummary,
  pinned: boolean
): Promise<void> {
  if (mutatingConversationKey.value !== undefined) return;
  const key = conversationKey(conversation);
  mutatingConversationKey.value = key;
  try {
    await props.workspace.updateMetadata({ pinned }, conversation.nodeId, conversation.id);
  } catch (error) {
    showMessage(hostedErrorMessage(error), 'error', error);
  } finally {
    if (mutatingConversationKey.value === key) mutatingConversationKey.value = undefined;
  }
}

async function deleteConversation(conversation: HostedConversationSummary): Promise<void> {
  if (mutatingConversationKey.value !== undefined) return;
  try {
    await ElMessageBox.confirm(
      translate('hostedConversations.deleteConfirmation', {
        title: hostedConversationTitle(conversation)
      }),
      translate('hostedConversations.deleteTitle'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('hostedConversations.delete'),
        cancelButtonText: translate('hostedConversations.cancel')
      }
    );
  } catch {
    return;
  }
  const key = conversationKey(conversation);
  const deletingSelectedConversation =
    conversation.nodeId === props.workspace.selectedNodeId.value &&
    conversation.id === props.workspace.selectedConversationId.value;
  mutatingConversationKey.value = key;
  try {
    await props.workspace.deleteConversation(conversation.nodeId, conversation.id);
    if (
      deletingSelectedConversation &&
      props.workspace.selectedConversationId.value === undefined
    ) {
      props.clearConversation();
      entry.resume();
      draftingNewConversation.value = true;
      closeMobilePanels();
    }
    await refreshDirectory();
    showMessage(translate('hostedConversations.deleted'), 'success');
  } catch (error) {
    showMessage(hostedErrorMessage(error), 'error', error);
  } finally {
    if (mutatingConversationKey.value === key) mutatingConversationKey.value = undefined;
  }
}

function conversationKey(conversation: Pick<HostedConversationSummary, 'nodeId' | 'id'>): string {
  return `${conversation.nodeId}\0${conversation.id}`;
}

function conversationActionsVisible(key: string): boolean {
  return (
    hoveredConversationKey.value === key ||
    focusedConversationKey.value === key ||
    (actionMenuVisible.value && actionConversationKey.value === key)
  );
}

function clearConversationFocus(event: FocusEvent): void {
  const target = event.currentTarget;
  if (
    target instanceof HTMLElement &&
    event.relatedTarget instanceof Node &&
    target.contains(event.relatedTarget)
  )
    return;
  focusedConversationKey.value = undefined;
}

function triggerConversationActions(key: string, row: HTMLElement): void {
  hoveredConversationKey.value = key;
  actionConversationKey.value = key;
  void nextTick(() => row.querySelector<HTMLButtonElement>('.history-more-button')?.click());
}

function openConversationActions(conversation: HostedConversationSummary, event: MouseEvent): void {
  event.preventDefault();
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  triggerConversationActions(conversationKey(conversation), target);
}

function openConversationFromList(conversation: HostedConversationSummary): void {
  void openConversation(conversation);
}

function setConversationActionMenuVisible(visible: boolean, key: string): void {
  if (visible) {
    actionConversationKey.value = key;
    actionMenuVisible.value = true;
  } else if (actionConversationKey.value === key) {
    actionMenuVisible.value = false;
    actionConversationKey.value = undefined;
  }
}

function categoryLabel(category: ConversationFileProjection['category']): string {
  switch (category) {
    case 'UPLOAD':
      return translate('hostedConversations.fileCategoryUPLOAD');
    case 'OUTPUT':
      return translate('hostedConversations.fileCategoryOUTPUT');
  }
}

async function copyMessage(text: string, onSuccess: () => void): Promise<void> {
  try {
    if (navigator.clipboard?.writeText === undefined) throw new Error('CLIPBOARD_UNAVAILABLE');
    await navigator.clipboard.writeText(text);
    onSuccess();
  } catch {
    showMessage(translate('hostedConversations.copyFailed'), 'error');
  }
}

async function rollbackConversation(turn: ConversationTurn, item: ConversationItem): Promise<void> {
  if (
    rollbackPending.value ||
    !rollbackEnabled.value ||
    item.kind !== 'user_message' ||
    item.status !== 'COMPLETED' ||
    !['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'LOST'].includes(turn.status) ||
    turn.rewind === undefined
  )
    return;
  const text = conversationItemText(item.kind, item.payload);
  const boundary = turn.rewind.before;
  const conversationKeyAtConfirmation = selectedConversationKey.value;
  try {
    await ElMessageBox.confirm(
      translate('hostedConversations.rollbackConfirmation'),
      translate('hostedConversations.rollbackTitle'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('hostedConversations.rollback'),
        cancelButtonText: translate('common.cancel')
      }
    );
  } catch {
    return;
  }
  const currentTurn = timelineTurns.value.find((candidate) => candidate.id === turn.id);
  const currentItem = currentTurn?.items.find((candidate) => candidate.id === item.id);
  if (
    rollbackPending.value ||
    !rollbackEnabled.value ||
    selectedConversationKey.value !== conversationKeyAtConfirmation ||
    currentTurn?.rewind?.before !== boundary ||
    currentItem?.kind !== 'user_message' ||
    currentItem.status !== 'COMPLETED'
  )
    return;
  rollbackPending.value = true;
  try {
    await props.workspace.rollback(turn.id, boundary, item.id);
    if (selectedConversationKey.value === conversationKeyAtConfirmation)
      composer.value?.restoreMessage(text);
  } catch (error) {
    showMessage(hostedErrorMessage(error), 'error', error);
  } finally {
    rollbackPending.value = false;
  }
}

function handleFilesDragEnter(event: DragEvent): void {
  if (!filesWritable.value || !dragContainsFiles(event)) return;
  filesDragDepth += 1;
  filesDragging.value = true;
}

function handleFilesDragOver(event: DragEvent): void {
  if (event.dataTransfer !== null)
    event.dataTransfer.dropEffect =
      filesWritable.value && dragContainsFiles(event) ? 'copy' : 'none';
}

function handleFilesDragLeave(): void {
  filesDragDepth = Math.max(0, filesDragDepth - 1);
  if (filesDragDepth === 0) filesDragging.value = false;
}

async function handleFilesDrop(event: DragEvent): Promise<void> {
  filesDragDepth = 0;
  filesDragging.value = false;
  if (!filesWritable.value || uploadingDroppedFiles.value) return;
  await uploadRelatedFiles(event.dataTransfer?.files ?? []);
}

function chooseRelatedFiles(): void {
  if (!filesWritable.value || uploadingDroppedFiles.value) return;
  relatedFilesInput.value?.click();
}

function handleRelatedFilesSelected(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  void uploadRelatedFiles(files);
}

async function uploadRelatedFiles(selectedFiles: Iterable<File>): Promise<void> {
  if (!filesWritable.value || uploadingDroppedFiles.value) return;
  const files = Array.from(selectedFiles);
  if (files.length === 0) return;
  uploadingDroppedFiles.value = true;
  let uploaded = 0;
  try {
    for (const file of files) {
      try {
        await props.workspace.uploadFile(file, crypto.randomUUID());
        uploaded += 1;
      } catch (error) {
        showMessage(
          translate('hostedConversations.fileUploadFailed', {
            name: file.name,
            message: hostedErrorMessage(error)
          }),
          'error',
          error
        );
      }
    }
  } finally {
    uploadingDroppedFiles.value = false;
  }
  if (uploaded > 0)
    showMessage(
      translate('hostedConversations.filesUploaded', {
        count: uploaded
      }),
      'success'
    );
}

function dragContainsFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

async function deleteProjectedFile(file: ConversationFileProjection): Promise<void> {
  if (!filesWritable.value || deletingFileId.value !== undefined) return;
  try {
    await ElMessageBox.confirm(
      translate('hostedConversations.fileDeleteConfirmation', { name: file.displayName }),
      translate('hostedConversations.fileDeleteTitle'),
      {
        closeIcon: marIcon('close'),
        icon: marIcon('warning'),
        type: 'warning',
        confirmButtonText: translate('hostedConversations.fileDelete'),
        cancelButtonText: translate('common.cancel')
      }
    );
  } catch {
    return;
  }
  deletingFileId.value = file.id;
  try {
    await props.workspace.deleteFile(file.id);
    if (filePreview.file.value?.id === file.id) filePreview.close();
    showMessage(
      translate('hostedConversations.fileDeleted', {
        name: file.displayName
      }),
      'success'
    );
  } catch (error) {
    showMessage(hostedErrorMessage(error), 'error', error);
  } finally {
    if (deletingFileId.value === file.id) deletingFileId.value = undefined;
  }
}

function openLinkedFile(
  path: string,
  line: number | undefined,
  column: number | undefined,
  external: boolean
): void {
  const file = hostedConversationFileForPath(props.workspace.snapshot.value?.files ?? [], path);
  if (file === undefined) return;
  if (external) {
    const nodeId = props.workspace.selectedNodeId.value;
    const conversationId = props.workspace.selectedConversationId.value;
    if (nodeId === undefined || conversationId === undefined) return;
    const parameters = new URLSearchParams({
      standaloneFile: '1',
      source: 'hosted',
      nodeId,
      workspaceId: conversationId,
      conversationId,
      fileId: file.id,
      path: projectedFilePath(file),
      mimeType: file.mimeType,
      size: String(file.size)
    });
    if (line !== undefined) parameters.set('line', String(line));
    if (column !== undefined) parameters.set('column', String(column));
    standaloneFileWindow.open(`/console?${parameters.toString()}`);
    return;
  }
  void filePreview.openFile(file, line, column);
}

function markdownResourceUrl(path: string): string {
  const file = hostedConversationFileForPath(props.workspace.snapshot.value?.files ?? [], path);
  return file === undefined ? '' : props.workspace.contentUrl(file);
}

function closePreview(): void {
  filePreview.close();
  conversationImages.previewOpen.value = false;
  conversationImages.preview.value = undefined;
}

function hostedErrorMessage(error: unknown): string {
  const structured =
    typeof error === 'object' && error !== null && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : undefined;
  const code =
    errorCode(error) ?? (typeof structured?.code === 'string' ? structured.code : undefined);
  let summary: string | undefined;
  switch (code) {
    case 'CONVERSATION_HOSTING_STORAGE_FULL':
      summary = translate('hostedConversations.storageFull');
      break;
    case 'HOSTED_CONVERSATION_FILE_RECONCILE_FAILED':
      summary = translate('hostedConversations.fileProjectionFailed');
      break;
    case 'HOSTED_CONVERSATION_FILE_NOT_FOUND':
      summary = translate('hostedConversations.fileNotFound');
      break;
    case 'HOSTED_CONVERSATION_FILE_CONFLICT':
    case 'HOSTED_CONVERSATION_FILE_INVALID':
      summary = translate('hostedConversations.fileConflict');
      break;
    case 'HOSTED_CONVERSATION_UPGRADE_FAILED':
      summary = translate('hostedConversations.upgradeFailed');
      break;
    case 'HOSTED_CONVERSATION_NOT_FOUND':
      summary = translate('hostedConversations.notFound');
      break;
    case 'HOSTED_CONVERSATION_RUN_ACTIVE':
      summary = translate('hostedConversations.runActive');
      break;
    case 'HOSTED_CONVERSATION_STATE_INVALID':
      summary = translate('hostedConversations.stateInvalid');
      break;
    case 'HOSTED_CONVERSATION_ROLLBACK_TARGET_INVALID':
      summary = translate('hostedConversations.rollbackTargetInvalid');
      break;
    case 'HOSTED_CONVERSATION_RESPONSE_INVALID':
      summary = translate('hostedConversations.responseInvalid');
      break;
    case 'HOSTED_CONVERSATION_WATCH_INITIAL_FAILED':
    case 'HOSTED_CONVERSATION_WATCH_FAILED':
      summary = translate('hostedConversations.watchFailed');
      break;
    default:
      summary =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : typeof structured?.message === 'string' && structured.message.trim().length > 0
            ? structured.message.trim()
            : translate('hostedConversations.operationFailed');
  }
  return errorMessage(error, summary);
}

watch(
  () => props.restoringRoute,
  (restoring, wasRestoring) => {
    if (!restoring && wasRestoring) void loadDirectory();
  }
);
watch(selectedConversationKey, closePreview);
watch(selectedConversationKey, toolReview.clear);
watch(timelineTurns, (turns) => conversationImages.retain(turns), { immediate: true });
watch(selectedConversationKey, () => {
  expandedFileDirectories.value = new Set();
  conversationScrollService.following.value = true;
  void conversationScrollService.scrollToLatestAfterLayout();
});
watch(
  () => props.workspace.snapshot.value,
  () => {
    if (conversationScrollService.following.value)
      void conversationScrollService.scrollToLatestAfterLayout();
  },
  { flush: 'post' }
);
watch(
  () => props.mobileHistoryOpen,
  (open) => {
    if (open) mobileFilesOpen.value = false;
  }
);
watch(
  () => props.mobileViewport,
  (mobile) => {
    if (!mobile) {
      closeMobilePanels();
      return;
    }
    if (conversationScrollService.following.value)
      void conversationScrollService.scrollToLatestAfterLayout();
  }
);

const mobileFocus = createMobileSurfaceFocusService({
  isOpen: () => props.mobileViewport && (props.mobileHistoryOpen || mobileFilesOpen.value),
  regions: () => [
    document.getElementById(props.mobileHistoryOpen ? 'hosted-pane-history' : 'hosted-pane-files'),
    document.querySelector<HTMLElement>('.activity-rail')
  ],
  close: closeMobilePanels
});
onBeforeUnmount(mobileFocus.dispose);
onBeforeUnmount(entry.dispose);

onMounted(initialize);
onBeforeUnmount(() => {
  historyAppendObserver?.disconnect();
  conversationResizeObserver?.disconnect();
  filePreview.dispose();
});
</script>

<template>
  <section :class="['hosted-workspace', { 'history-collapsed': sidebarCollapsed }]">
    <Transition name="mobile-surface-scrim">
      <button
        v-if="mobileViewport && (mobileHistoryOpen || mobileFilesOpen)"
        class="hosted-conversation-scrim"
        type="button"
        :aria-label="
          mobileHistoryOpen
            ? translate('hostedConversations.closeHistory')
            : translate('hostedConversations.closeFiles')
        "
        @click="closeMobilePanels"
      ></button>
    </Transition>

    <aside
      id="hosted-pane-history"
      tabindex="-1"
      class="hosted-conversation-history"
      :class="{ 'mobile-open': mobileViewport && mobileHistoryOpen }"
      :inert="mobileViewport ? !mobileHistoryOpen : sidebarCollapsed"
      :aria-label="translate('hostedConversations.historyTitle')"
    >
      <header class="sidebar-heading session-heading history-header">
        <div class="session-heading-meta">
          <h2>{{ translate('hostedConversations.historyTitle') }}</h2>
        </div>
      </header>
      <div class="history-controls">
        <el-button class="history-create-button" type="primary" @click="beginNewConversation">
          <MarIcon name="session-add" />
          <span>{{ translate('hostedConversations.create') }}</span>
        </el-button>
        <div class="history-search-row">
          <el-input
            v-model="filter"
            clearable
            :prefix-icon="marIcon('search')"
            :placeholder="translate('hostedConversations.searchHistory')"
            :aria-label="translate('hostedConversations.searchHistory')"
            :clear-icon="marIcon('clear-input')"
          />
          <el-button
            v-tooltip="translate('hostedConversations.refreshHistory')"
            class="history-refresh-button utility-control"
            :aria-label="translate('hostedConversations.refreshHistory')"
            :disabled="loadingDirectory"
            :loading="workspace.loadingConversations.value && workspace.conversationsLoaded.value"
            :aria-busy="workspace.loadingConversations.value && workspace.conversationsLoaded.value"
            :icon="marIcon('refresh')"
            size="small"
            text
            @click="refreshDirectory"
            :loading-icon="marIcon('loading-action')"
          />
        </div>
      </div>
      <div
        ref="historyList"
        v-loading="workspace.loadingConversations.value && !workspace.conversationsLoaded.value"
        v-session-reorder-motion="historyReorderSnapshot"
        class="history-list"
      >
        <p
          v-if="!loadingDirectory && filteredConversations.length === 0"
          class="history-empty-text"
        >
          {{
            translate(
              filter.trim()
                ? 'hostedConversations.noLoadedHistoryMatches'
                : 'hostedConversations.noHistory'
            )
          }}
        </p>
        <article
          v-for="conversation in filteredConversations"
          :key="conversationKey(conversation)"
          class="mar-session-reorder-item"
          :class="{
            selected:
              conversation.nodeId === workspace.selectedNodeId.value &&
              conversation.id === workspace.selectedConversationId.value
          }"
          @mouseenter="hoveredConversationKey = conversationKey(conversation)"
          @mouseleave="hoveredConversationKey = undefined"
          @focusin="focusedConversationKey = conversationKey(conversation)"
          @focusout="clearConversationFocus"
          @contextmenu="openConversationActions(conversation, $event)"
        >
          <button
            class="history-open"
            type="button"
            :aria-current="
              conversation.nodeId === workspace.selectedNodeId.value &&
              conversation.id === workspace.selectedConversationId.value
                ? 'page'
                : undefined
            "
            @click="openConversationFromList(conversation)"
          >
            <span class="history-title-row">
              <MarIcon
                name="star-filled"
                v-if="conversation.pinnedAt !== null"
                class="history-pin-indicator"
                :aria-label="translate('hostedConversations.pinnedLabel')"
              />
              <span
                v-if="workspace.conversationIsRunning(conversation)"
                class="history-run-indicator"
                aria-hidden="true"
              ></span>
              <span
                v-if="hasUnreadConversation(conversation.nodeId, conversation.id)"
                class="history-unread-label mar-unread-label"
                >{{ translate('hostedConversations.unreadLabel') }}</span
              >
              <strong>{{ hostedConversationTitle(conversation) }}</strong>
            </span>
            <time :datetime="new Date(conversation.lastActivityAt).toISOString()">
              {{
                translate('presentation.lastActivity', {
                  value: absoluteSessionTime(conversation.lastActivityAt)
                })
              }}
            </time>
          </button>
          <el-dropdown
            v-if="conversationActionsVisible(conversationKey(conversation))"
            class="history-row-actions"
            placement="bottom-end"
            popper-class="session-action-menu"
            trigger="click"
            @visible-change="
              setConversationActionMenuVisible($event, conversationKey(conversation))
            "
          >
            <button
              v-tooltip="
                translate('hostedConversations.moreActions', {
                  title: hostedConversationTitle(conversation)
                })
              "
              class="history-more-button utility-control"
              type="button"
              :disabled="mutatingConversationKey !== undefined"
              :aria-label="
                translate('hostedConversations.moreActions', {
                  title: hostedConversationTitle(conversation)
                })
              "
            >
              <MarIcon name="more" />
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  @click="setConversationPinned(conversation, conversation.pinnedAt === null)"
                >
                  <MarIcon name="pin" />
                  {{
                    translate(
                      conversation.pinnedAt === null
                        ? 'hostedConversations.pin'
                        : 'hostedConversations.unpin'
                    )
                  }}
                </el-dropdown-item>
                <el-dropdown-item @click="editConversationTitle(conversation)">
                  <MarIcon name="edit" />
                  {{ translate('hostedConversations.editTitle') }}
                </el-dropdown-item>
                <el-dropdown-item divided @click="deleteConversation(conversation)">
                  <MarIcon name="delete" />
                  {{ translate('hostedConversations.delete') }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </article>
        <p v-if="filter.trim()" class="history-filter-note">
          {{ translate('hostedConversations.filterLoadedOnly') }}
        </p>
        <div
          v-if="workspace.hasMoreConversations.value"
          ref="historyAppendMarker"
          class="list-append-state"
          :aria-busy="workspace.loadingMoreConversations.value"
        >
          <span
            v-if="workspace.loadingMoreConversations.value && !retryingDirectory"
            role="status"
            :aria-label="translate('common.loading')"
            ><BusyIndicator class="read-loading-indicator"
          /></span>
          <el-button
            v-if="
              retryingDirectory ||
              (workspace.loadMoreConversationsError.value &&
                !workspace.loadingMoreConversations.value)
            "
            link
            :aria-disabled="workspace.loadingMoreConversations.value"
            :aria-busy="workspace.loadingMoreConversations.value"
            :aria-label="
              workspace.loadingMoreConversations.value ? translate('common.loading') : undefined
            "
            @click="retryDirectoryAppend"
          >
            <BusyIndicator
              v-if="workspace.loadingMoreConversations.value"
              class="read-loading-indicator"
            />
            <template v-else>{{ translate('common.loadFailedRetry') }}</template>
          </el-button>
        </div>
      </div>
    </aside>

    <main
      id="hosted-pane-conversation"
      class="hosted-conversation-main"
      :inert="mobileViewport && (mobileHistoryOpen || mobileFilesOpen)"
    >
      <button
        v-tooltip="translate('hostedConversations.mobileFiles')"
        v-if="mobileViewport"
        class="hosted-mobile-files-button"
        type="button"
        :aria-label="translate('hostedConversations.mobileFiles')"
        @click="openMobileFiles"
      >
        <MarIcon name="folder-open" />
      </button>
      <el-alert
        v-if="workspace.snapshot.value?.error"
        class="snapshot-error-alert"
        :closable="false"
        show-icon
        type="error"
        :title="hostedErrorMessage(workspace.snapshot.value.error)"
        ><template #icon><MarIcon name="error" /></template
      ></el-alert>
      <el-alert
        v-if="readonlyVisible"
        class="readonly-alert"
        :closable="false"
        show-icon
        type="warning"
        :title="readonlyReason"
        ><template #icon><MarIcon name="warning" /></template
      ></el-alert>
      <section
        v-if="draftingNewConversation || selectedSummary === undefined"
        class="conversation-draft"
      >
        <HostedConversationEntryPage
          :request="request"
          :workspace="workspace"
          :mobile-viewport="mobileViewport"
          :connected="connected"
          :entry="entry"
          @started="firstMessageStarted"
        />
      </section>
      <template v-else>
        <ConversationScroll
          class="hosted-timeline-scroll"
          :context-key="selectedConversationKey"
          :has-older="workspace.historyNextCursor.value !== null"
          :loading-initial="waitingForSnapshot"
          :initial-sync-pending="waitingForSnapshot"
          :initial-load-failed="conversationLoadFailed"
          :initial-error="conversationLoadError"
          :loading-older="workspace.loadingOlderHistory.value"
          :older-error="
            workspace.olderHistoryError.value === undefined
              ? ''
              : hostedErrorMessage(workspace.olderHistoryError.value)
          "
          :has-turns="timelineTurns.length > 0"
          :following="conversationScrollService.following.value"
          :empty-prompt="interactionReady && !workspace.snapshot.value?.run ? 'hosted' : undefined"
          @scroll-element="setConversationScrollElement"
          @scroll="handleConversationScroll"
          @scroll-intent="conversationScrollService.stopFollowing"
          @load-older="loadOlderConversationHistory"
          @reload="retryConversation"
          @latest="conversationScrollService.scrollToLatest"
        >
          <ConversationTimeline
            v-if="workspace.snapshot.value !== undefined"
            :runs="workspace.snapshot.value?.run ? [workspace.snapshot.value.run] : []"
            :turns="timelineTurns"
            workspace-root="/workspace"
            :loading="rollbackPending"
            :initializing="openingConversationKey !== undefined"
            :initial-render-version="0"
            :capture-render-anchor="conversationScrollService.captureRenderAnchor"
            :image-attachments="conversationImages.attachments"
            :user-input-questions="() => []"
            :user-input-answer="() => ''"
            :user-input-submitted="() => false"
            :plan-continuation="undefined"
            :node-ready="interactionReady"
            :synchronized="connected !== false && workspace.watchReady.value"
            :tool-change-enabled="toolChangeEnabled"
            :rewind-enabled="false"
            :rollback-enabled="rollbackEnabled"
            @copy="copyMessage"
            @rollback="rollbackConversation"
            @open-image="conversationImages.open"
            @image-unavailable="conversationImages.markUnavailable"
            @open-file="openLinkedFile"
            @open-file-change="openFileChange"
          />
        </ConversationScroll>
        <HostedConversationComposer
          v-if="workspace.snapshot.value !== undefined"
          :connected="connected"
          ref="composer"
          :key="selectedConversationKey"
          :workspace="workspace"
          :mobile-viewport="mobileViewport"
          :readonly="!interactionReady || rollbackPending"
          :readonly-reason="readonlyReason"
          :template-change-blocked="rollbackPending || uploadingDroppedFiles"
        />
      </template>
    </main>

    <aside
      id="hosted-pane-files"
      tabindex="-1"
      :inert="mobileViewport && !mobileFilesOpen"
      class="hosted-conversation-files"
      :class="{
        'mobile-open': mobileViewport && mobileFilesOpen,
        'is-file-dragging': filesDragging
      }"
      :aria-label="translate('hostedConversations.filesTitle')"
      @dragenter.prevent="handleFilesDragEnter"
      @dragover.prevent="handleFilesDragOver"
      @dragleave.prevent="handleFilesDragLeave"
      @drop.prevent="handleFilesDrop"
    >
      <header class="pane-header files-header">
        <h2>{{ translate('hostedConversations.filesTitle') }}</h2>
      </header>
      <template v-if="selectedSummary !== undefined">
        <input
          ref="relatedFilesInput"
          class="related-files-input"
          type="file"
          multiple
          :disabled="!filesWritable || uploadingDroppedFiles"
          @change="handleRelatedFilesSelected"
        />
        <button
          class="files-drop-target"
          :class="{ active: filesDragging, disabled: !filesWritable }"
          :aria-disabled="!filesWritable"
          type="button"
          :disabled="!filesWritable || uploadingDroppedFiles"
          @click="chooseRelatedFiles"
        >
          <MarIcon name="upload" />
          <span>
            {{
              filesDragging
                ? translate('hostedConversations.filesDropNow')
                : translate('hostedConversations.filesDropHint')
            }}
          </span>
        </button>
        <div v-loading="uploadingDroppedFiles" class="files-list">
          <section v-for="group in filesByCategory" :key="group.category">
            <h3>{{ categoryLabel(group.category) }}</h3>
            <p v-if="group.files.length === 0">{{ translate('hostedConversations.noFiles') }}</p>
            <div
              v-for="row in group.rows"
              :key="`${group.category}:${row.node.kind}:${row.node.path}`"
              class="file-row"
              :class="{ 'is-directory': row.node.kind === 'DIRECTORY' }"
              :style="{ '--file-depth': row.depth }"
            >
              <span
                v-tooltip="row.node.path"
                v-if="row.node.kind === 'DIRECTORY'"
                class="mar-tooltip-control"
                ><button
                  class="file-directory"
                  type="button"
                  :aria-expanded="fileDirectoryExpanded(group.category, row.node.path)"
                  :aria-label="fileDirectoryActionLabel(group.category, row.node.path)"
                  @click="toggleFileDirectory(group.category, row.node.path)"
                >
                  <MarIcon
                    name="chevron-right"
                    class="file-directory-chevron"
                    :class="{
                      expanded: fileDirectoryExpanded(group.category, row.node.path)
                    }"
                  />
                  <MarIcon name="folder-open" class="file-directory-kind" />
                  <span>{{ row.node.name }}</span>
                </button></span
              >
              <template v-else>
                <button
                  v-tooltip="row.node.file.relativePath"
                  :aria-label="row.node.file.relativePath"
                  class="file-open"
                  type="button"
                  @click="filePreview.openFile(row.node.file)"
                >
                  <span>{{ row.node.file.displayName }}</span>
                  <small>{{ fileSizeLabel(row.node.file.size) }}</small>
                </button>
                <button
                  v-tooltip="
                    translate('hostedConversations.fileDeleteNamed', {
                      name: row.node.file.displayName
                    })
                  "
                  class="file-delete"
                  type="button"
                  :disabled="!filesWritable || deletingFileId !== undefined"
                  :aria-label="
                    translate('hostedConversations.fileDeleteNamed', {
                      name: row.node.file.displayName
                    })
                  "
                  @click="deleteProjectedFile(row.node.file)"
                >
                  <MarIcon name="delete" />
                </button>
              </template>
            </div>
          </section>
        </div>
      </template>
      <div v-else class="files-draft-empty">
        <p>{{ translate('hostedConversations.filesAvailableAfterCreate') }}</p>
      </div>
    </aside>

    <Teleport to="body">
      <ToolChangeReviewWindow
        :review="toolReview"
        @open-source="openChangeSourceFile"
        @error="showMessage(hostedErrorMessage($event), 'error', $event)"
      />
      <ImagePreviewDialogs
        :attachment-open="false"
        :attachment="undefined"
        :conversation-open="conversationImages.previewOpen.value"
        :conversation="conversationImages.preview.value"
        @update:conversation-open="conversationImages.previewOpen.value = $event"
        @clear-conversation="conversationImages.preview.value = undefined"
      />
      <FilePreviewSurface
        v-if="filePreview.visible.value && filePreview.content.value"
        :overlay="true"
        :label="
          translate('generated.filePreviewDialog.filePreview', {
            value0: filePreview.content.value.path
          })
        "
        @focus="filePage?.focus()"
        @close="filePreview.close"
      >
        <WorkspaceTextFilePage
          ref="filePage"
          v-if="
            filePreview.visible.value &&
            filePreview.content.value &&
            filePreview.kind.value === 'text'
          "
          :downloading="filePreview.downloading.value"
          :file="filePreview.content.value"
          :loading="filePreview.loading.value"
          :load-error="filePreviewError"
          @reload="filePreview.retry"
          :fullscreen="true"
          :contained="true"
          :kind="filePreview.kind.value"
          :markdown="
            filePreview.content.value.encoding === 'utf-8' &&
            isMarkdownFile(filePreview.content.value.path)
          "
          :render-markdown="true"
          :markdown-resource-url="markdownResourceUrl"
          :target-line="filePreview.targetLine.value"
          :target-column="filePreview.targetColumn.value"
          :write-enabled="false"
          @close="filePreview.close"
          @download="filePreview.download"
          @open-markdown-file="
            (path, external) => openLinkedFile(path, undefined, undefined, external)
          "
        />
        <WorkspaceFormatFilePage
          ref="filePage"
          v-else-if="filePreview.visible.value && filePreview.content.value"
          :content-url="filePreview.contentUrl.value"
          :downloading="filePreview.downloading.value"
          :file="filePreview.content.value"
          :loading="filePreview.loading.value"
          :load-error="filePreviewError"
          @reload="filePreview.retry"
          :fullscreen="true"
          :contained="true"
          :kind="filePreview.kind.value"
          @close="filePreview.close"
          @download="filePreview.download"
        />
      </FilePreviewSurface>
    </Teleport>
  </section>
</template>

<style scoped>
.hosted-workspace {
  position: relative;
  display: grid;
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  grid-template-columns: minmax(420px, 1fr) minmax(260px, 318px);
  overflow: hidden;
  background: var(--mar-bg-page);
}

.hosted-conversation-history,
.hosted-conversation-main,
.hosted-conversation-files {
  min-width: 0;
  min-height: 0;
  background: var(--mar-bg-panel);
}

.hosted-conversation-history,
.hosted-conversation-files {
  display: flex;
  flex-direction: column;
}

.hosted-conversation-history[hidden],
.hosted-conversation-files[hidden] {
  display: none;
}

.hosted-conversation-history {
  border-right: 1px solid var(--mar-border-medium);
}

.hosted-conversation-files {
  border-left: 1px solid var(--mar-border-medium);
}

.pane-header {
  display: flex;
  min-height: 68px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--mar-border-subtle);
  padding: 12px 16px;
}

.pane-header span {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.pane-header h1,
.pane-header h2 {
  margin: 3px 0 0;
  overflow: hidden;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-title);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-header {
  box-sizing: border-box;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-start;
  margin: 0;
  overflow: hidden;
  padding: 12px 20px;
  text-align: left;
}

.history-header .session-heading-meta {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  justify-content: flex-start;
  gap: 0.35rem;
}

.history-header h2 {
  margin: 0;
  font-size: var(--mar-font-size-title);
}

.history-controls {
  display: grid;
  gap: 8px;
  border-bottom: 1px solid var(--mar-border-subtle);
  padding: 0 12px 10px;
}

.history-create-button {
  width: 100%;
  justify-content: flex-start;
}

.history-search-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--mar-compact-control-size);
  align-items: center;
  gap: 6px;
}

.history-refresh-button {
  width: var(--mar-compact-control-size);
  min-width: var(--mar-compact-control-size);
  height: var(--mar-compact-control-size);
  min-height: var(--mar-compact-control-size);
  margin: 0;
  border-radius: 6px;
  color: var(--mar-text-secondary);
  padding: 0;
}

.history-refresh-button :deep(.mar-icon) {
  font-size: var(--mar-font-size-body);
}

.history-list,
.files-list {
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
}

.history-list {
  padding: 8px;
}

.history-filter-note {
  margin: 0;
  padding: 0.5rem;
  color: var(--mar-text-faint);
  font-size: var(--mar-font-size-meta);
}

.history-empty-text {
  margin: 0;
  padding: 34px 12px;
  color: var(--mar-text-faint);
  font-size: var(--mar-font-size-meta);
  line-height: 1.6;
  text-align: center;
}

.history-list article {
  position: relative;
  display: flex;
  align-items: center;
  border: 1px solid transparent;
  border-radius: 8px;
  margin: 2px 0;
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}

.history-list article:hover {
  background: var(--mar-fill-row-hover);
}

.history-list article.selected {
  background: var(--mar-fill-selection);
}

.history-list article.selected .history-open,
.history-list article.selected .history-title-row strong,
.history-list article.selected .history-open time,
.history-list article.selected .history-pin-indicator {
  color: var(--mar-text-primary);
}

.history-open {
  display: grid;
  width: 100%;
  min-width: 0;
  flex: 1 1 auto;
  gap: 5px;
  border: 0;
  background: transparent;
  padding: 9px 10px;
  text-align: left;
  cursor: pointer;
}

.history-title-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
}

.history-title-row strong {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-title-row strong {
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
}

.history-open time {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-list article.selected .history-open time {
  color: var(--mar-text-secondary);
}

.history-pin-indicator {
  width: 12px;
  height: 12px;
  flex: none;
  color: var(--mar-color-warning-accent);
  font-size: 12px;
}

.history-run-indicator {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
}

.history-run-indicator {
  background: var(--mar-color-success-text);
  box-shadow: 0 0 0 2px var(--mar-color-success-bg);
}

.history-row-actions {
  position: absolute;
  top: 50%;
  right: 5px;
  display: inline-flex;
  align-items: center;
  transform: translateY(-50%);
}

.history-more-button {
  --mar-action-icon-size: 14px;
  display: inline-grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--mar-text-secondary);
  cursor: pointer;
}

.history-more-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

:global(.session-action-menu .el-dropdown-menu__item) {
  gap: 0.4rem;
}

.hosted-conversation-main {
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.conversation-draft {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
  background: var(--mar-bg-panel);
}

.readonly-alert,
.snapshot-error-alert {
  margin: 10px 14px 0;
}

.hosted-timeline-scroll {
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
}

.hosted-timeline-scroll :deep(.conversation-scroll) {
  padding: 0 clamp(6px, 2vw, 22px);
}

.hosted-timeline-scroll :deep(.conversation-timeline) {
  max-width: 900px;
  margin: 0 auto;
  padding: 18px 0 30px;
}

.conversation-empty {
  display: grid;
  min-height: 0;
  flex: 1 1 auto;
  place-items: center;
  align-content: center;
  gap: 10px;
  padding: 24px;
  color: var(--mar-text-secondary);
  text-align: center;
}

.conversation-empty > .mar-icon {
  color: var(--mar-color-brand);
  font-size: 34px;
}

.conversation-empty h2,
.conversation-empty p {
  margin: 0;
}

.conversation-empty p {
  max-width: 420px;
  line-height: 1.6;
}

.hosted-conversation-files .pane-header h2 {
  margin: 0;
}

.files-header {
  box-sizing: border-box;
  min-height: 44px;
  flex: 0 0 44px;
  justify-content: flex-start;
  padding: 8px 14px;
}

.related-files-input {
  display: none;
}

.files-draft-empty {
  padding: 20px;
  color: var(--mar-text-tertiary);
  text-align: center;
}

.files-draft-empty p {
  max-width: 220px;
  margin: 0;
  font-size: var(--mar-font-size-meta);
  line-height: 1.6;
}

.files-drop-target {
  display: flex;
  width: calc(100% - 24px);
  min-height: 54px;
  align-items: center;
  gap: 8px;
  margin: 10px 12px 0;
  border: 1px dashed var(--mar-border-medium);
  border-radius: 8px;
  background: transparent;
  padding: 10px 12px;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background-color 120ms ease,
    color 120ms ease;
}

.files-drop-target > .mar-icon {
  flex: none;
  color: var(--mar-color-brand);
  font-size: 18px;
}

.files-drop-target:hover:not(:disabled):not(.active) {
  border-color: var(--mar-border-strong);
  background: var(--mar-fill-hover);
  color: var(--mar-text-primary);
}

.files-drop-target.active,
.hosted-conversation-files.is-file-dragging .files-drop-target {
  border-color: var(--mar-color-brand-border);
  background: var(--mar-color-brand-subtle);
  color: var(--mar-color-brand-text);
}

.files-drop-target.disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.files-list {
  padding: 12px;
}

.files-list section + section {
  margin-top: 18px;
}

.files-list h3 {
  margin: 0 0 6px;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.files-list p {
  margin: 0;
  color: var(--mar-text-faint);
  font-size: var(--mar-font-size-meta);
}

.file-row {
  --file-depth: 0;

  display: grid;
  box-sizing: border-box;
  grid-template-columns: minmax(0, 1fr) 30px;
  align-items: center;
  border-radius: 6px;
  padding-left: calc(var(--file-depth) * 14px);
}

.file-row:hover,
.file-row:focus-within {
  background: var(--mar-fill-hover);
}

.file-open {
  display: grid;
  width: 100%;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  padding: 7px 8px;
  color: var(--mar-text-primary);
  text-align: left;
  cursor: pointer;
}

.file-open:focus-visible,
.file-delete:focus-visible,
.file-directory:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--mar-color-brand-border);
}

.file-directory {
  display: flex;
  min-width: 0;
  min-height: 30px;
  grid-column: 1 / -1;
  align-items: center;
  gap: 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  padding: 5px 8px;
  color: var(--mar-text-primary);
  text-align: left;
  cursor: pointer;
}

.file-directory-chevron {
  flex: none;
  color: var(--mar-text-faint);
  font-size: 11px;
}

.file-directory-chevron svg {
  transition: transform 120ms ease;
}

.file-directory-chevron svg.expanded {
  transform: rotate(90deg);
}

.file-directory-kind {
  flex: none;
  color: var(--mar-color-brand-text);
  font-size: 15px;
}

.file-directory span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-open span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-open small {
  justify-self: end;
  color: var(--mar-text-tertiary);
  line-height: 1.35;
  text-align: right;
}

.file-delete {
  --mar-action-icon-size: 14px;
  display: inline-grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--mar-text-faint);
  cursor: pointer;
}

.file-delete:hover:not(:disabled) {
  background: var(--mar-color-danger-bg);
  color: var(--mar-color-danger-text);
}

.file-delete:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.hosted-conversation-scrim,
.hosted-mobile-files-button {
  display: none;
}

@media (min-width: 768px) {
  .hosted-conversation-history {
    position: fixed;
    z-index: 3;
    inset: var(--sidebar-header-height) auto 0 var(--mar-activity-rail-width);
    width: var(--mar-workbench-sidebar-width);
    background: var(--mar-bg-subtle);
    transition:
      width var(--mar-motion-duration-collapse) var(--mar-motion-easing-collapse),
      visibility 0s;
  }

  .hosted-workspace.history-collapsed .hosted-conversation-history {
    width: 0;
    overflow: hidden;
    visibility: hidden;
    pointer-events: none;
    transition-delay: 0s, var(--mar-motion-duration-collapse);
  }
}

@media (max-width: 1023px) {
  .hosted-workspace {
    grid-template-columns: minmax(360px, 1fr) 250px;
  }
}

@media (max-width: 767px) {
  .hosted-workspace {
    display: flex;
  }

  .file-directory {
    min-height: 36px;
  }

  .hosted-conversation-scrim {
    position: fixed;
    z-index: 11;
    inset: var(--sidebar-header-height) 0 0;
    display: block;
    border: 0;
    background: var(--mar-overlay-scrim);
    cursor: pointer;
  }

  .hosted-mobile-files-button {
    position: absolute;
    z-index: 4;
    top: 8px;
    right: 10px;
    display: inline-grid;
    width: 34px;
    height: 34px;
    place-items: center;
    border: 1px solid var(--mar-border-medium);
    border-radius: 8px;
    background: var(--mar-bg-panel);
    color: var(--mar-text-secondary);
    box-shadow: 0 2px 8px var(--mar-shadow-soft);
    cursor: pointer;
  }

  .hosted-conversation-main {
    width: 100%;
    flex: 1 1 auto;
    border: 0;
  }

  .hosted-conversation-history,
  .hosted-conversation-files {
    position: fixed;
    z-index: 12;
    inset: var(--sidebar-header-height) auto 0 0;
    width: min(300px, calc(100vw - 48px));
    flex: none;
    border: 0;
    border-right: 1px solid var(--mar-border-subtle);
    box-shadow: 0 8px 24px var(--mar-shadow-medium);
    transform: translateX(-100%);
    visibility: hidden;
    pointer-events: none;
    transition:
      transform 0.16s ease,
      visibility 0.16s step-end;
  }

  .hosted-conversation-history.mobile-open,
  .hosted-conversation-files.mobile-open {
    transform: translateX(0);
    visibility: visible;
    pointer-events: auto;
    transition:
      transform 0.16s ease,
      visibility 0s;
  }

  .hosted-timeline-scroll :deep(.conversation-scroll) {
    padding-top: 50px;
  }

  .history-search-row {
    grid-template-columns: minmax(0, 1fr) 36px;
  }

  .history-refresh-button {
    width: 36px;
    min-width: 36px;
    height: 36px;
    min-height: 36px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .hosted-conversation-history,
  .hosted-conversation-files {
    transition: none;
  }
}
</style>

<style scoped>
@media (max-width: 767px) {
  .hosted-conversation-scrim {
    transition: opacity var(--mar-motion-duration-collapse) var(--mar-motion-easing-collapse);
  }
  .mobile-surface-scrim-enter-from,
  .mobile-surface-scrim-leave-to {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .hosted-conversation-history,
  .hosted-conversation-files,
  .hosted-conversation-scrim {
    transition: none;
  }
}
</style>
