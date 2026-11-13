<script setup lang="ts">
import type { ComposerQuoteTarget } from '../../model/composer-quote.js';
import type { MessageType } from '../../model/message-feedback.js';
import { isComposerAttachmentResourcePath } from '@myagentroam/protocol';
import type {
  FileNavigationRequest,
  WorkspaceNavigationTarget as NavigationTarget
} from '../../model/workspace-navigation.js';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { PromptPredictionAttentionService } from '../../service/prompt-prediction-attention-service.js';
import { type WorkspaceFilePreviewFrame as PreviewFrame } from '../../service/workspace-file-workbench-controller.js';
import type { WorkspaceFilePagePort } from '../../model/workspace-file-workbench.js';
import type { createWorkspaceFileWorkbenchController } from '../../service/workspace-file-workbench-controller.js';
import WorkspaceTextFilePage from './WorkspaceTextFilePage.vue';
import WorkspaceFormatFilePage from './WorkspaceFormatFilePage.vue';
import WorkspaceFileTabs from './WorkspaceFileTabs.vue';
import WorkspaceGitDiffPage from './WorkspaceGitDiffPage.vue';
import {
  errorMessage,
  filePreviewErrorMessage,
  filePreviewErrorSummary
} from '../../util/error-presentation.js';
import {
  filePreviewKind,
  isHtmlFile,
  isMarkdownFile,
  type FilePreviewKind
} from '../../util/file-preview.js';
import { translate } from '../../service/locale-preference-service.js';
import { confirmDiscardFileDraft } from '../../service/file-draft-confirm-service.js';
import type { WorkspaceFileOpenIntent, WorkspaceFileTab } from '../../util/workspace-file-tab.js';

const props = defineProps<{
  readonly quoteTargetFor?: (tab: WorkspaceFileTab) => ComposerQuoteTarget | undefined;
  readonly predictionEnabled?: boolean;
  readonly nodeId: string | undefined;
  readonly workspaceId: string | undefined;
  readonly controller: ReturnType<typeof createWorkspaceFileWorkbenchController>;
  readonly registerPage: (
    page: WorkspaceFilePagePort | undefined,
    previous?: WorkspaceFilePagePort
  ) => void;
  readonly adjacentDiff: (
    tab: WorkspaceFileTab,
    direction: -1 | 1
  ) => WorkspaceFileOpenIntent | undefined;
  readonly loadDiff: (tab: WorkspaceFileTab, signal?: AbortSignal) => Promise<unknown>;
  readonly openExternal: (
    path: string,
    line?: number,
    column?: number,
    renderedPreview?: 'markdown' | 'html',
    worktreePath?: string,
    repositoryPath?: string
  ) => void;
  readonly enabled: boolean;
  readonly codeNavigationEnabled: boolean;
  readonly standaloneFileMode?: boolean;
  readonly fileWriteEnabled: boolean;
}>();

const emit = defineEmits<{
  notice: [value: string, type: MessageType, cause?: unknown];
  openHtmlPreview: [path: string];
}>();
const workspaceFileTabsRef = ref<WorkspaceFilePagePort>();
const fileWorkbench = props.controller;
watch(workspaceFileTabsRef, (page, previous) => props.registerPage(page, previous), {
  flush: 'sync'
});
onBeforeUnmount(() => props.registerPage(undefined, workspaceFileTabsRef.value));
const { frames: filePageFrames } = fileWorkbench;
const fileWindowSuspended = fileWorkbench.suspended;
const {
  canGoBack: canGoFileBack,
  canGoForward: canGoFileForward,
  travel: travelFileNavigation
} = fileWorkbench;
const activePreviewId = fileWorkbench.activeTabId;
const activePreview = computed(() =>
  filePageFrames.value.find((preview) => preview.id === activePreviewId.value)
);
const workspaceFileTabs = fileWorkbench.tabList;
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
    tab.id !== fileWorkbench.activeTabId.value ||
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
const activeWorkspaceFileTabId = fileWorkbench.activeTabId;
const activeDiffTab = computed(() => {
  const tab = fileWorkbench.activeTab.value;
  return tab?.kind === 'WORKTREE_DIFF' || tab?.kind === 'HISTORY_DIFF' ? tab : undefined;
});
const fileContent = computed(() => activePreview.value?.fileContent.value);
const previewWorktreePath = computed(() => activePreview.value?.worktreePath.value);
const previewTargetLine = computed(() => activePreview.value?.targetLine.value);

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

const base = computed(() => {
  if (props.nodeId === undefined || props.workspaceId === undefined) return undefined;
  return `/api/workspaces/${encodeURIComponent(props.workspaceId)}`;
});
const ready = computed(() => props.enabled && base.value !== undefined);
function markFailure(error: unknown, action: string, summary?: string): void {
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
  if (source !== undefined && symbol.length > 0) await fileWorkbench.navigate(source, { symbol });
}

async function navigateFile(request: FileNavigationRequest): Promise<void> {
  const source = navigationSource();
  if (source !== undefined && request.reference.value.length > 0)
    await fileWorkbench.navigate(source, request);
}

function openNavigationTarget(target: NavigationTarget, preview = activePreview.value): void {
  if (preview === undefined) return;
  fileWorkbench.openNavigationTarget(target, preview.id);
}

function clearCodeNavigation(preview = activePreview.value): void {
  fileWorkbench.clearNavigationResult(preview?.id);
}

function textLineCount(content: string): number {
  return content.length === 0 ? 0 : content.split('\n').length;
}

const openWorkspaceFile = fileWorkbench.openWorkspaceFile;

const openWorkspaceFileTab = fileWorkbench.openTab;

async function reloadPreviewFile(preview: PreviewFrame): Promise<void> {
  await fileWorkbench.reloadFile(preview.id);
}

function previewErrorFor(preview: PreviewFrame): string | undefined {
  return preview.error.value === undefined
    ? undefined
    : filePreviewErrorSummary(preview.error.value, preview.target.value?.path ?? '');
}

async function openFile(path: string, line?: number, column?: number): Promise<void> {
  await fileWorkbench.openFile(path, line, column);
}

const openWorkspaceFileExternal = props.openExternal;

function openCurrentRenderedPreview(): boolean {
  if (fileContent.value === undefined) return false;
  const path = fileContent.value.path;
  const preview = isMarkdownFile(path) ? 'markdown' : isHtmlFile(path) ? 'html' : undefined;
  if (preview === undefined || activePreview.value?.repositoryPath !== undefined) return false;
  if (preview === 'html' && activePreview.value?.worktreePath.value !== undefined) return false;
  if (
    preview === 'html' &&
    props.standaloneFileMode !== true &&
    (path.startsWith('/') || /^[a-z]:[\\/]/i.test(path) || path.split(/[\\/]/).includes('..'))
  )
    return false;
  if (preview === 'html' && props.standaloneFileMode !== true) {
    suspendFileWindowForHtml(path);
    return true;
  }
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

function suspendFileWindowForHtml(path: string): void {
  if (!ready.value) {
    emit(
      'notice',
      translate('generated.workbenchPageInteractionService.filePreviewIsCurrentlyUnavailable'),
      'error'
    );
    return;
  }
  if (!fileWorkbench.suspendForHtml()) {
    emit('notice', translate('htmlPreview.saving'), 'info');
    return;
  }
  emit('openHtmlPreview', path);
}

async function canCloseUnmountedTab(id: number): Promise<boolean> {
  const tab = fileWorkbench.tabList.value.find((item) => item.id === id);
  return tab === undefined || !fileWorkbench.hasDraft(tab.identity) || confirmDiscardFileDraft();
}

defineExpose({
  predictionAttention: () => predictionAttention.snapshot(`${props.nodeId}:${props.workspaceId}`),
  openCurrentRenderedPreview,
  downloadFile
});

async function savePreviewFile(
  preview: PreviewFrame,
  content: string,
  expectedRevision: string
): Promise<string> {
  if (!ready.value || !props.fileWriteEnabled) throw new Error('FILE_WRITE_INVALID');
  return fileWorkbench.saveFile(preview.id, content, expectedRevision);
}

async function downloadFile(
  path: string,
  worktreePath?: string,
  preview?: PreviewFrame
): Promise<void> {
  if (!ready.value || props.nodeId === undefined || props.workspaceId === undefined) return;
  try {
    if (preview?.fileContent.value?.path === path) await fileWorkbench.downloadFile(preview.id);
    else
      await fileWorkbench.downloadTarget({
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
    await fileWorkbench.downloadFile(preview.id);
  } catch (error) {
    markFailure(error, translate('generated.workspaceInspector.fileDownload'));
  }
}

function removeWorkspaceFileTab(id: number): void {
  fileWorkbench.closeTabs([id]);
}

function closeStandaloneFileWindow(): void {
  if (props.standaloneFileMode === true) window.close();
}

function closeWorkspaceFileTabs(ids: readonly number[]): void {
  fileWorkbench.closeTabs(ids);
}

const activateWorkspaceFileTab = fileWorkbench.activateTab;

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

const openWorktreeDiffText = fileWorkbench.openWorktreeDiffText;

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

const openHistoryText = fileWorkbench.openHistoryText;

async function navigateDiffSymbol(tab: WorkspaceFileTab, symbol: string): Promise<void> {
  if (tab.kind !== 'WORKTREE_DIFF') return;
  const sourceId = await openWorktreeDiffText(tab);
  if (sourceId === undefined || activePreview.value?.id !== sourceId) return;
  await navigateSymbol(symbol);
}

async function navigateDiffFile(
  tab: WorkspaceFileTab,
  request: FileNavigationRequest
): Promise<void> {
  if (tab.kind !== 'WORKTREE_DIFF') return;
  const sourceId = await openWorktreeDiffText(tab);
  if (sourceId === undefined || activePreview.value?.id !== sourceId) return;
  await navigateFile(request);
}

async function loadDiff(tab: WorkspaceFileTab, signal?: AbortSignal): Promise<unknown> {
  return props.loadDiff(tab, signal);
}

async function moveDiffFile(tab: WorkspaceFileTab, direction: -1 | 1): Promise<void> {
  if (tab.kind !== 'WORKTREE_DIFF') return;
  const intent = props.adjacentDiff(tab, direction);
  if (intent !== undefined && ready.value && base.value !== undefined)
    await openWorkspaceFileTab(intent);
}
</script>

<template>
  <Teleport to="body">
    <WorkspaceFileTabs
      v-if="workspaceFileTabs.length > 0 && !fileWindowSuspended"
      ref="workspaceFileTabsRef"
      :tabs="workspaceFileTabs"
      :presentation="standaloneFileMode ? 'window' : 'overlay'"
      :active-tab-id="activeWorkspaceFileTabId"
      :can-go-back="canGoFileBack"
      :can-go-forward="canGoFileForward"
      :can-close-unmounted-tab="canCloseUnmountedTab"
      @back="travelFileNavigation(-1)"
      @forward="travelFileNavigation(1)"
      @activate="activateWorkspaceFileTab"
      @page-ready="fileWorkbench.pageReady"
      @close="removeWorkspaceFileTab"
      @close-all="closeWorkspaceFileTabs"
      @close-last="closeStandaloneFileWindow"
      v-slot="{ tab, active, registerPageHandle, requestClose, requestCloseAll }"
    >
      <template v-for="preview in filePageFrames" :key="preview.id">
        <WorkspaceTextFilePage
          :quote-target="props.quoteTargetFor?.(tab)"
          :quote-origin="tab.kind === 'HISTORY_TEXT' ? 'HISTORY' : 'WORKING_TREE'"
          :quote-revision="tab.commit"
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
          :load-error="previewErrorFor(preview)"
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
            (standaloneFileMode ||
              (!preview.fileContent.value.path.startsWith('/') &&
                !/^[a-z]:[\\/]/i.test(preview.fileContent.value.path) &&
                !preview.fileContent.value.path.split(/[\\/]/).includes('..'))) &&
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
          :navigation-notice="preview.navigationNotice.value"
          :editor-identity="preview.id"
          :tab-identity="tab.identity"
          :initial-dirty-draft="fileWorkbench.draftFor(tab.identity)"
          @close="requestClose"
          @quoted="requestCloseAll"
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
            standaloneFileMode
              ? openWorkspaceFileExternal(
                  preview.fileContent.value.path,
                  undefined,
                  undefined,
                  'html'
                )
              : suspendFileWindowForHtml(preview.fileContent.value.path)
          "
          @navigate-symbol="navigateSymbol"
          @navigate-file="navigateFile"
          @dismiss-navigation="clearCodeNavigation(preview)"
          @open-navigation-target="openNavigationTarget($event, preview)"
          @reload="reloadPreviewFile(preview)"
          @dirty-draft-applied="fileWorkbench.consumeDraft($event)"
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
          :load-error="previewErrorFor(preview)"
          @reload="reloadPreviewFile(preview)"
          @close="requestClose"
          @download="downloadPreviewFile(preview)"
        />
      </template>
      <WorkspaceGitDiffPage
        :quote-target="props.quoteTargetFor?.(tab)"
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
        @quoted="requestCloseAll"
        @download="downloadDiffContent($event, tab.path)"
        @edit="openDiffEditor(tab)"
        @move-file="moveDiffFile(tab, $event)"
        @preview="previewDiffFile(tab, $event)"
        @navigate-symbol="navigateDiffSymbol(tab, $event)"
        @navigate-file="navigateDiffFile(tab, $event)"
      />
    </WorkspaceFileTabs>
  </Teleport>
</template>
