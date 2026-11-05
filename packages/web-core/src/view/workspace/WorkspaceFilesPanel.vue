<script setup lang="ts">
import { ref, watch } from 'vue';
import MarIcon from '../common/MarIcon.vue';
import WorkspaceFileTree from './WorkspaceFileTree.vue';
import { marIcon } from '../../util/mar-icons.js';
import { errorMessage } from '../../util/error-presentation.js';
import { fileSizeLabel, workspaceAbsolutePath } from '../../util/file-presentation.js';
import { ElMessageBox } from '../../service/message-box-service.js';
import { translate } from '../../service/locale-preference-service.js';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import type { MessageType } from '../../model/message-feedback.js';
import type { WorkspaceFileTreeNode } from '../../service/workspace-file-tree-service.js';
import type { WorkspaceWatchTopicStatus } from '../../service/workspace-watch-service.js';
import type {
  createWorkspaceFilesController,
  WorkspaceUploadPreflight
} from '../../service/workspace-files-controller.js';

interface PendingUpload {
  readonly id: string;
  readonly file: File;
  readonly path: string | null;
  readonly status: 'READY' | 'EXISTS_FILE' | 'EXISTS_DIRECTORY' | 'INVALID_NAME';
  overwrite: boolean;
}

const props = defineProps<{
  service: ReturnType<typeof createWorkspaceFilesController>;
  workspacePath?: string | undefined;
  localFileManagerEnabled?: boolean | undefined;
  mobileViewport: boolean;
  visible: boolean;
  watchStatus?: WorkspaceWatchTopicStatus;
}>();
const emit = defineEmits<{
  refresh: [];
  retryWatch: [];
  open: [path: string, external: boolean];
  html: [path: string];
  download: [path: string];
  failure: [error: unknown, action: string];
  notice: [value: string, type: MessageType];
}>();
const filesController = props.service;
const fileTree = filesController.tree;
const filesBusy = filesController.refreshing;
const preparingUploads = filesController.preparing;
const fileDisplayFilter = ref('');
const uploadInput = ref<HTMLInputElement>();
const fileTreeView = ref<{ reveal(path: string, current?: () => boolean): Promise<void> }>();
const uploadDialogOpen = ref(false);
const pendingUploads = ref<PendingUpload[]>([]);
const pendingUploadDirectory = ref('.');
const pendingUploadTransaction = ref<WorkspaceUploadPreflight>();

function childPath(directory: string, name: string): string {
  return directory === '.' ? name : `${directory}/${name}`;
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
    | 'PREVIEW_HTML'
    | 'CREATE_FILE'
    | 'CREATE_DIRECTORY'
    | 'DOWNLOAD'
    | 'COPY_PATH'
    | 'COPY_ABSOLUTE_PATH'
    | 'REVEAL_LOCAL'
    | 'RENAME'
    | 'DELETE'
    | 'UPLOAD',
  node: WorkspaceFileTreeNode
): Promise<void> {
  const scope = filesController.captureTarget();
  if (scope === undefined) return;
  const current = () => filesController.isCurrentTarget(scope);
  try {
    if (action === 'OPEN') {
      emit('open', node.path, false);
      return;
    }
    if (action === 'OPEN_EXTERNAL') {
      emit('open', node.path, true);
      return;
    }
    if (action === 'PREVIEW_HTML') {
      emit('html', node.path);
      return;
    }
    if (action === 'COPY_PATH') {
      await navigator.clipboard.writeText(node.path);
      if (current())
        emit('notice', translate('generated.workspaceInspector.relativePathCopied'), 'info');
      return;
    }
    if (action === 'COPY_ABSOLUTE_PATH') {
      if (!props.workspacePath) return;
      await navigator.clipboard.writeText(workspaceAbsolutePath(props.workspacePath, node.path));
      if (current())
        emit('notice', translate('generated.workspaceInspector.absolutePathCopied'), 'info');
      return;
    }
    if (action === 'REVEAL_LOCAL') {
      if (props.localFileManagerEnabled === true)
        await filesController.revealLocal(scope, node.path);
      return;
    }
    if (action === 'DOWNLOAD') {
      emit('download', node.path);
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
      await filesController.mutate(scope, action, childPath(node.path, name));
      return;
    }
    if (action === 'RENAME') {
      const name = await promptName(translate('generated.workspaceInspector.rename'), node.name);
      if (name === undefined || name === node.name || !current()) return;
      const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '.';
      await filesController.mutate(scope, 'MOVE', node.path, childPath(parent, name));
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
    await filesController.mutate(scope, 'DELETE', node.path);
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    if (current()) emit('failure', error, translate('generated.workspaceInspector.fileOperation'));
  }
}

async function moveTreeNode(
  source: WorkspaceFileTreeNode,
  directory: WorkspaceFileTreeNode
): Promise<void> {
  const scope = filesController.captureTarget();
  if (scope === undefined) return;
  await filesController.mutate(
    scope,
    'MOVE',
    source.path,
    childPath(directory.path, source.name),
    'move'
  );
}

function chooseUploadFiles(): void {
  uploadInput.value?.click();
}

async function prepareUploads(
  files: Iterable<File>,
  directory = fileTree.uploadDirectory()
): Promise<void> {
  const transaction = await filesController.preflight([...files], directory);
  if (
    transaction === undefined ||
    !props.visible ||
    !filesController.isCurrentPreflight(transaction)
  )
    return;
  pendingUploadTransaction.value = transaction;
  pendingUploads.value = transaction.files.map((file, index) => ({
    ...transaction.candidates[index]!,
    id: crypto.randomUUID(),
    file,
    overwrite: false
  }));
  pendingUploadDirectory.value = directory;
  uploadDialogOpen.value = true;
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
  const transaction = pendingUploadTransaction.value;
  const blocked =
    transaction === undefined
      ? undefined
      : filesController.submit(
          transaction,
          pendingUploads.value.map((entry) => entry.overwrite)
        );
  if (blocked !== undefined && blocked > 0)
    emit(
      'notice',
      translate('generated.workspaceInspector.filesWereNotUploadedBecauseOfConflicts', {
        value0: blocked
      }),
      'warning'
    );
  uploadDialogOpen.value = false;
  pendingUploads.value = [];
  pendingUploadTransaction.value = undefined;
}

watch(
  () => props.visible,
  (visible, wasVisible) => {
    if (wasVisible && !visible) {
      uploadDialogOpen.value = false;
      pendingUploads.value = [];
      pendingUploadTransaction.value = undefined;
    }
  },
  { flush: 'sync' }
);

defineExpose({
  chooseUploadFiles,
  reveal: (path: string, current?: () => boolean) => fileTreeView.value?.reveal(path, current),
  invalidate: () => {
    pendingUploadTransaction.value = undefined;
  },
  reset: () => {
    uploadDialogOpen.value = false;
    pendingUploads.value = [];
    pendingUploadTransaction.value = undefined;
    fileDisplayFilter.value = '';
  }
});
</script>

<template>
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
        @click="emit('refresh')"
      >
        <MarIcon name="refresh" />
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
    <el-button
      v-if="
        (watchStatus === 'loading' || watchStatus === 'failed') &&
        !filesBusy &&
        !fileTree.refreshError.value
      "
      class="watch-status"
      link
      :class="{ failed: watchStatus === 'failed' }"
      :aria-disabled="watchStatus === 'loading'"
      :aria-busy="watchStatus === 'loading' || undefined"
      @click="watchStatus === 'failed' && emit('retryWatch')"
    >
      <template v-if="watchStatus === 'loading'"
        ><MarIcon name="loading-action" />
        {{ translate('generated.workspaceInspector.loading') }}</template
      >
      <template v-else>{{ translate('common.loadFailedRetry') }}</template>
    </el-button>
    <el-button
      v-if="fileTree.refreshError.value"
      v-tooltip="!filesBusy ? errorMessage(fileTree.refreshError.value.cause) : ''"
      :aria-description="!filesBusy ? errorMessage(fileTree.refreshError.value.cause) : undefined"
      class="watch-status"
      link
      :class="{ failed: !filesBusy }"
      :aria-disabled="filesBusy"
      :aria-busy="filesBusy || undefined"
      @click="!filesBusy && emit('refresh')"
    >
      <template v-if="filesBusy"
        ><MarIcon name="loading-action" />
        {{ translate('generated.workspaceInspector.loading') }}</template
      >
      <template v-else>{{ translate('common.loadFailedRetry') }}</template>
    </el-button>
    <p v-else-if="filesBusy" class="watch-status" role="status">
      <MarIcon name="loading-action" />
      {{ translate('generated.workspaceInspector.loading') }}
    </p>
    <WorkspaceFileTree
      v-if="visible"
      ref="fileTreeView"
      :root="fileTree.root.value"
      :root-path="workspacePath"
      :filter="fileDisplayFilter"
      :selected-path="fileTree.selectedPath.value"
      :disabled="filesBusy"
      :mutations-enabled="true"
      :local-file-manager-enabled="localFileManagerEnabled"
      :mobile-viewport="mobileViewport"
      @toggle="fileTree.toggle"
      @open="(node) => emit('open', node.path, false)"
      @open-external="(node) => emit('open', node.path, true)"
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
  </section>
</template>

<style scoped>
.watch-status {
  margin: 0.2rem 0.55rem;
  font-size: var(--mar-font-size-meta);
}

.watch-status:not(button) {
  color: var(--mar-text-muted);
}

button.watch-status {
  align-self: flex-start;
  border: 0;
  padding: 0;
  background: transparent;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

button.watch-status[aria-disabled='true'] {
  color: var(--mar-text-muted);
  cursor: default;
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
  margin: 0;
  padding: 0;
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

:deep(.el-button) {
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

:deep(.el-button + .el-button) {
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

:deep(.el-button:not(.utility-control):hover:not(:disabled)),
:deep(.el-button:not(.utility-control):focus-visible) {
  background: var(--mar-fill-muted);
  color: var(--mar-text-primary);
}

:deep(.el-input__wrapper) {
  min-height: 26px;
  border: 1px solid var(--mar-border-medium);
  border-radius: 6px;
  background: var(--mar-bg-subtle);
  box-shadow: none;
  padding: 1px 7px;
}

:deep(.el-input__inner) {
  font-size: var(--mar-font-size-input);
}

:deep(.el-input__wrapper.is-focus),
:deep(.el-input__wrapper:focus-within) {
  background: var(--mar-bg-panel);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--mar-color-brand) 14%, transparent);
}
</style>
