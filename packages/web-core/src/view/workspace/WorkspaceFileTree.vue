<script setup lang="ts">
import './inspector-row.css';
import { MarDropdown, MarDropdownMenu, MarDropdownItem } from '@myagentroam/mar-ui/dropdown';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue';
import {
  visibleWorkspaceFileTreeRows,
  workspaceFileTreeWindow,
  type WorkspaceFileTreeNode,
  type WorkspaceFileTreeVisibleRow
} from '../../service/workspace-file-tree-service.js';
import { localePreferenceService, translate } from '../../service/locale-preference-service.js';
import FileTypeIcon from './FileTypeIcon.vue';
import { errorMessage } from '../../util/error-presentation.js';
import { consoleKeyboardShortcutService } from '../../service/console-keyboard-shortcut-service.js';
import { isHtmlFile } from '../../util/file-preview.js';

const props = defineProps<{
  readonly root: WorkspaceFileTreeNode;
  readonly rootPath?: string | undefined;
  readonly filter: string;
  readonly selectedPath: string | undefined;
  readonly disabled: boolean;
  readonly mutationsEnabled: boolean;
  readonly localFileManagerEnabled?: boolean;
  readonly mobileViewport: boolean;
  readonly hideRows?: boolean;
}>();
const locale = localePreferenceService().locale;
const emit = defineEmits<{
  toggle: [node: WorkspaceFileTreeNode];
  open: [node: WorkspaceFileTreeNode];
  openExternal: [node: WorkspaceFileTreeNode];
  action: [
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
  ];
  move: [source: WorkspaceFileTreeNode, directory: WorkspaceFileTreeNode];
  loadMore: [node: WorkspaceFileTreeNode];
  select: [node: WorkspaceFileTreeNode];
  dropFiles: [directory: string, files: readonly File[]];
  invalidDrop: [];
}>();
const container = ref<HTMLElement>();
const readState = ref<HTMLElement>();
const focusedPath = ref('.');
const draggingPath = ref<string>();
const movingNode = ref<WorkspaceFileTreeNode>();
const actionNodePath = ref<string>();
const actionMenuVisible = ref(false);
const hoveredActionNodePath = ref<string>();
const focusedActionNodePath = ref<string>();
const rows = computed(() => visibleWorkspaceFileTreeRows(props.root, props.filter));
const scrollTop = ref(0);
const viewportHeight = ref(0);
const rowHeight = ref(24);
const DIRECTORY_HOVER_EXPANSION_DELAY_MS = 500;
let directoryHoverExpansionTimer: ReturnType<typeof setTimeout> | undefined;
let directoryHoverExpansionPath: string | undefined;
const windowedRows = computed(() => {
  const window = workspaceFileTreeWindow(
    rows.value.length,
    scrollTop.value,
    viewportHeight.value,
    rowHeight.value,
    8
  );
  return { ...window, rows: rows.value.slice(window.start, window.end) };
});
watchEffect(() => {
  if (props.disabled || props.hideRows || props.filter.trim() !== '' || viewportHeight.value <= 0)
    return;
  const start = Math.floor(scrollTop.value / rowHeight.value);
  const end = Math.ceil((scrollTop.value + viewportHeight.value) / rowHeight.value);
  const boundary = rows.value
    .slice(start, end)
    .find(
      (row) =>
        row.loadMore &&
        row.node.expanded &&
        !row.node.loading &&
        row.node.failedAppend === undefined
    );
  if (boundary) emit('loadMore', boundary.node);
});
const hasFilteredResult = computed(
  () => props.filter.trim().length === 0 || rows.value.some((row) => row.node.path !== '.')
);

function activate(node: WorkspaceFileTreeNode, event?: MouseEvent): void {
  focusedPath.value = node.path;
  if (node.kind === 'DIRECTORY') {
    emit('select', node);
    emit('toggle', node);
  } else if (event?.ctrlKey === true || event?.metaKey === true) emit('openExternal', node);
  else emit('open', node);
}

function onKeydown(event: KeyboardEvent, row: WorkspaceFileTreeVisibleRow): void {
  const nodes = rows.value.filter((candidate) => !candidate.loadMore);
  const index = nodes.findIndex((candidate) => candidate.node.path === row.node.path);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    const target = nodes[Math.max(0, Math.min(nodes.length - 1, index + offset))];
    if (target !== undefined) focus(target.node.path);
    return;
  }
  if (event.key === 'ArrowRight' && row.node.kind === 'DIRECTORY' && !row.node.expanded) {
    event.preventDefault();
    emit('toggle', row.node);
  } else if (event.key === 'ArrowLeft' && row.node.kind === 'DIRECTORY' && row.node.expanded) {
    event.preventDefault();
    emit('toggle', row.node);
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    activate(row.node);
  }
}

function focus(path: string): void {
  focusedPath.value = path;
  revealRow(path);
  void nextTick(() => rowElement(path)?.focus({ preventScroll: true }));
}

function rowElement(path: string): HTMLButtonElement | undefined {
  const escaped = CSS.escape(path);
  return (
    container.value?.querySelector<HTMLButtonElement>(`[data-file-path="${escaped}"]`) ?? undefined
  );
}

async function reveal(path: string, needed: () => boolean = () => true): Promise<void> {
  if (!needed()) return;
  revealRow(path);
  await nextTick();
}

function revealRow(path: string): void {
  const index = rows.value.findIndex((row) => !row.loadMore && row.node.path === path);
  const element = container.value;
  if (index < 0 || element === undefined || props.hideRows) return;
  const top = rowsStart(element) + index * rowHeight.value;
  const bottom = top + rowHeight.value;
  if (top < element.scrollTop) element.scrollTop = top;
  else if (bottom > element.scrollTop + element.clientHeight)
    element.scrollTop = bottom - element.clientHeight;
  updateViewport();
}

function rowsStart(element: HTMLElement): number {
  return (
    Number.parseFloat(getComputedStyle(element).paddingTop) + (readState.value?.offsetHeight ?? 0)
  );
}

function updateViewport(): void {
  const element = container.value;
  if (element === undefined) return;
  // Virtual rows, reveal and paging use coordinates relative to the start of the tree rows.
  const offset = element.scrollTop - rowsStart(element);
  scrollTop.value = Math.max(0, offset);
  viewportHeight.value = Math.max(0, element.clientHeight + Math.min(0, offset));
  const configuredRowHeight = Number.parseFloat(
    getComputedStyle(element).getPropertyValue('--file-tree-row-size')
  );
  if (Number.isFinite(configuredRowHeight) && configuredRowHeight > 0)
    rowHeight.value = configuredRowHeight;
}

let resizeObserver: ResizeObserver | undefined;
let unregisterMenuShortcut: (() => void) | undefined;
onMounted(() => {
  updateViewport();
  if (props.selectedPath !== undefined) void reveal(props.selectedPath);
  resizeObserver = new ResizeObserver(updateViewport);
  if (container.value !== undefined) resizeObserver.observe(container.value);
  if (readState.value !== undefined) resizeObserver.observe(readState.value);
  unregisterMenuShortcut = consoleKeyboardShortcutService.register({
    command: 'workspaceFileTree.dismissMenu',
    scope: 'overlay',
    priority: 100,
    modalOwner: () => container.value,
    keys: [{ key: 'Escape' }],
    when: (event) => {
      const trigger = container.value?.querySelector<HTMLButtonElement>(
        '.file-tree-more[aria-expanded="true"]'
      );
      if (!actionMenuVisible.value || !trigger || !(event.target instanceof Node)) return false;
      const menu = document.getElementById(trigger.getAttribute('aria-controls') ?? '');
      return (
        trigger.contains(event.target) ||
        menu?.contains(event.target) === true ||
        (event.target instanceof Element &&
          event.target.closest('.file-tree-row-shell')?.contains(trigger) === true)
      );
    },
    execute: () => {
      const trigger = container.value?.querySelector<HTMLButtonElement>(
        '.file-tree-more[aria-expanded="true"]'
      );
      if (!trigger) return 'IGNORED';
      trigger.click();
      trigger.focus({ preventScroll: true });
      return 'HANDLED';
    }
  });
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  unregisterMenuShortcut?.();
  cancelDirectoryHoverExpansion();
});
watch(
  () => rows.value.length,
  () => void nextTick(updateViewport)
);

function drop(event: DragEvent, node?: WorkspaceFileTreeNode): void {
  cancelDirectoryHoverExpansion();
  draggingPath.value = undefined;
  if (!acceptsTreeDrop(event)) {
    movingNode.value = undefined;
    return;
  }
  event.preventDefault();
  if (movingNode.value !== undefined) {
    const source = movingNode.value;
    movingNode.value = undefined;
    if (props.mobileViewport) return;
    if (node?.kind === 'DIRECTORY' && node.path !== source.path) emit('move', source, node);
    else emit('invalidDrop');
    return;
  }
  const hasDirectory = [...(event.dataTransfer?.items ?? [])].some((item) => {
    const entry = (
      item as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory: boolean } | null }
    ).webkitGetAsEntry?.();
    return entry?.isDirectory === true;
  });
  if (hasDirectory) {
    emit('invalidDrop');
    return;
  }
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length === 0) {
    emit('invalidDrop');
    return;
  }
  const directory = node?.kind === 'DIRECTORY' ? node.path : '.';
  emit('dropFiles', directory, files);
}

function isFileUploadDrag(event: DragEvent): boolean {
  const transfer = event.dataTransfer;
  return (
    transfer !== null &&
    (Array.from(transfer.types).includes('Files') ||
      [...transfer.items].some((item) => item.kind === 'file'))
  );
}

function cancelDirectoryHoverExpansion(path?: string): void {
  if (path !== undefined && directoryHoverExpansionPath !== path) return;
  if (directoryHoverExpansionTimer !== undefined) clearTimeout(directoryHoverExpansionTimer);
  directoryHoverExpansionTimer = undefined;
  directoryHoverExpansionPath = undefined;
}

function scheduleDirectoryHoverExpansion(node: WorkspaceFileTreeNode): void {
  if (directoryHoverExpansionPath === node.path) return;
  cancelDirectoryHoverExpansion();
  directoryHoverExpansionPath = node.path;
  directoryHoverExpansionTimer = setTimeout(() => {
    if (directoryHoverExpansionPath !== node.path) return;
    directoryHoverExpansionTimer = undefined;
    directoryHoverExpansionPath = undefined;
    if (node.kind === 'DIRECTORY' && !node.expanded) emit('toggle', node);
  }, DIRECTORY_HOVER_EXPANSION_DELAY_MS);
}

function acceptsTreeDrop(event: DragEvent): boolean {
  return (
    !props.hideRows && !(event.target instanceof Node && readState.value?.contains(event.target))
  );
}

function allowRootDrop(event: DragEvent): void {
  if (acceptsTreeDrop(event)) event.preventDefault();
}

function enterRootDropTarget(event: DragEvent): void {
  if (!acceptsTreeDrop(event)) {
    leaveRootDropTarget();
    return;
  }
  event.preventDefault();
  cancelDirectoryHoverExpansion();
  draggingPath.value = '.';
}

function leaveRootDropTarget(): void {
  cancelDirectoryHoverExpansion();
  draggingPath.value = undefined;
}

function enterDropTarget(event: DragEvent, node: WorkspaceFileTreeNode): void {
  draggingPath.value = node.path;
  if (directoryHoverExpansionPath !== node.path) cancelDirectoryHoverExpansion();
  if (node.kind === 'DIRECTORY' && !node.expanded) {
    if (movingNode.value !== undefined) {
      cancelDirectoryHoverExpansion();
      emit('toggle', node);
    } else if (isFileUploadDrag(event)) scheduleDirectoryHoverExpansion(node);
    else {
      cancelDirectoryHoverExpansion();
      emit('toggle', node);
    }
  } else cancelDirectoryHoverExpansion(node.path);
  event.stopPropagation();
  event.preventDefault();
}

function leaveDropTarget(event: DragEvent, path: string): void {
  const currentTarget = event.currentTarget;
  const relatedTarget = event.relatedTarget;
  if (
    currentTarget instanceof HTMLElement &&
    relatedTarget instanceof Node &&
    currentTarget.contains(relatedTarget)
  )
    return;
  cancelDirectoryHoverExpansion(path);
  if (draggingPath.value === path) draggingPath.value = undefined;
}

function fileMoveEnabled(node: WorkspaceFileTreeNode): boolean {
  return props.mutationsEnabled && !props.mobileViewport && node.path !== '.';
}

function startMove(event: DragEvent, node: WorkspaceFileTreeNode): void {
  if (!fileMoveEnabled(node)) {
    event.preventDefault();
    return;
  }
  cancelDirectoryHoverExpansion();
  movingNode.value = node;
  event.dataTransfer?.setData('application/x-mar-workspace-path', node.path);
  if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
}

function endDrag(): void {
  cancelDirectoryHoverExpansion();
  movingNode.value = undefined;
}

function action(command: string, node: WorkspaceFileTreeNode): void {
  if (
    command === 'OPEN' ||
    command === 'OPEN_EXTERNAL' ||
    command === 'PREVIEW_HTML' ||
    command === 'CREATE_FILE' ||
    command === 'CREATE_DIRECTORY' ||
    command === 'DOWNLOAD' ||
    command === 'COPY_PATH' ||
    command === 'COPY_ABSOLUTE_PATH' ||
    command === 'REVEAL_LOCAL' ||
    command === 'RENAME' ||
    command === 'DELETE' ||
    command === 'UPLOAD'
  )
    emit('action', command, node);
}

function nodeActionsVisible(path: string): boolean {
  return (
    props.mobileViewport ||
    hoveredActionNodePath.value === path ||
    focusedActionNodePath.value === path ||
    (actionMenuVisible.value && actionNodePath.value === path)
  );
}

function clearFocus(event: FocusEvent): void {
  const target = event.currentTarget;
  if (
    target instanceof HTMLElement &&
    event.relatedTarget instanceof Node &&
    target.contains(event.relatedTarget)
  )
    return;
  focusedActionNodePath.value = undefined;
}

function triggerNodeActions(path: string, row: HTMLElement): void {
  hoveredActionNodePath.value = path;
  void nextTick(() => row.querySelector<HTMLButtonElement>('.file-tree-more')?.click());
}

function openNodeActions(path: string, event: MouseEvent): void {
  event.preventDefault();
  const row = (event.currentTarget as HTMLElement).closest<HTMLElement>('.file-tree-row-shell');
  actionNodePath.value = path;
  if (row !== null) triggerNodeActions(path, row);
}

function setActionMenuVisible(visible: boolean, path: string): void {
  if (!visible && actionNodePath.value !== path) return;
  actionMenuVisible.value = visible;
  actionNodePath.value = visible ? path : undefined;
}

defineExpose({ reveal });
</script>

<template>
  <div
    ref="container"
    class="workspace-file-tree"
    :class="{ 'is-root-drop-target': !hideRows && draggingPath === '.' }"
    @dragenter="enterRootDropTarget"
    @dragleave.self="leaveRootDropTarget"
    @dragover="allowRootDrop"
    @drop="drop($event)"
    @scroll="updateViewport"
  >
    <div ref="readState" class="file-tree-read-state" :class="{ 'is-centered': hideRows }">
      <slot name="read-state" />
    </div>
    <div
      v-show="!hideRows"
      class="file-tree-virtual-space"
      :style="{ height: `${windowedRows.totalHeight}px` }"
      role="tree"
      :aria-label="translate('generated.workspaceFileTree.fileTree')"
    >
      <div
        class="file-tree-virtual-window"
        :style="{ transform: `translateY(${windowedRows.offset}px)` }"
      >
        <template
          v-for="row in windowedRows.rows"
          :key="`${row.node.path}:${row.loadMore ? 'more' : 'node'}`"
          v-memo="[
            row.node,
            row.node.name,
            rootPath,
            row.node.kind,
            row.node.expanded,
            row.node.loading,
            row.node.failedAppend,
            row.depth,
            row.loadMore,
            selectedPath === row.node.path,
            draggingPath === row.node.path,
            focusedPath === row.node.path,
            nodeActionsVisible(row.node.path),
            disabled,
            mutationsEnabled,
            mobileViewport,
            locale
          ]"
        >
          <div
            v-if="!row.loadMore"
            class="file-tree-row-shell"
            :class="{
              'mar-inspector-row': !disabled,
              selected: selectedPath === row.node.path,
              'drop-target': draggingPath === row.node.path
            }"
            @dragenter.stop.prevent="enterDropTarget($event, row.node)"
            @dragleave.stop="leaveDropTarget($event, row.node.path)"
            @dragover.stop.prevent
            @drop.stop="drop($event, row.node)"
            @mouseenter="hoveredActionNodePath = row.node.path"
            @mouseleave="hoveredActionNodePath = undefined"
            @focusin="focusedActionNodePath = row.node.path"
            @focusout="clearFocus"
            @contextmenu="openNodeActions(row.node.path, $event)"
          >
            <button
              v-tooltip="row.node.path === '.' ? (rootPath ?? row.node.name) : row.node.path"
              :aria-label="row.node.path === '.' ? (rootPath ?? row.node.name) : row.node.path"
              class="file-tree-row mar-inspector-row-action"
              type="button"
              role="treeitem"
              :data-file-path="row.node.path"
              :aria-expanded="row.node.kind === 'DIRECTORY' ? row.node.expanded : undefined"
              :aria-selected="selectedPath === row.node.path"
              :aria-level="row.depth + 1"
              :disabled="disabled"
              :tabindex="focusedPath === row.node.path ? 0 : -1"
              :style="{ '--tree-depth': row.depth }"
              :draggable="fileMoveEnabled(row.node)"
              @click="activate(row.node, $event)"
              @keydown="onKeydown($event, row)"
              @dragstart="startMove($event, row.node)"
              @dragend="endDrag"
            >
              <MarIcon
                name="chevron-right"
                v-if="row.node.kind === 'DIRECTORY'"
                class="tree-chevron"
                :class="{ expanded: row.node.expanded }"
              />
              <span v-else class="tree-chevron"></span>
              <FileTypeIcon class="tree-kind" :name="row.node.name" :kind="row.node.kind" />
              <span class="tree-name">{{ row.node.name }}</span>
            </button>
            <MarDropdown
              v-if="nodeActionsVisible(row.node.path)"
              trigger="click"
              placement="bottom-start"
              :offset="12"
              :persistent="false"
              @command="action($event, row.node)"
              @visible-change="setActionMenuVisible($event, row.node.path)"
            >
              <button
                class="file-tree-more mar-icon-action mar-icon-action--inline"
                :class="{ 'is-visible': nodeActionsVisible(row.node.path) }"
                type="button"
                v-tooltip="
                  translate('generated.workspaceFileTree.moreActionsFor', { value0: row.node.name })
                "
                :aria-label="
                  translate('generated.workspaceFileTree.moreActionsFor', { value0: row.node.name })
                "
                :disabled="disabled"
                :tabindex="nodeActionsVisible(row.node.path) ? 0 : -1"
                @click.stop
              >
                <MarIcon name="more" />
              </button>
              <template #dropdown>
                <MarDropdownMenu>
                  <MarDropdownItem v-if="row.node.kind === 'FILE'" command="OPEN"
                    ><MarIcon name="view" />{{
                      translate('generated.workspaceFileTree.open')
                    }}</MarDropdownItem
                  >
                  <MarDropdownItem v-if="row.node.kind === 'FILE'" command="OPEN_EXTERNAL"
                    ><MarIcon name="external-link" />{{
                      translate('generated.workspaceFileTree.openInNewWindow')
                    }}</MarDropdownItem
                  >
                  <MarDropdownItem
                    v-if="row.node.kind === 'FILE' && isHtmlFile(row.node.path)"
                    command="PREVIEW_HTML"
                    ><MarIcon name="view" />{{ translate('htmlPreview.preview') }}</MarDropdownItem
                  >
                  <MarDropdownItem v-if="row.node.kind === 'FILE'" command="DOWNLOAD"
                    ><MarIcon name="download" />{{
                      translate('generated.workspaceFileTree.download')
                    }}</MarDropdownItem
                  >
                  <MarDropdownItem
                    v-if="mutationsEnabled && row.node.kind === 'DIRECTORY'"
                    command="CREATE_FILE"
                    ><MarIcon name="document-add" />{{
                      translate('generated.workspaceFileTree.newFile')
                    }}</MarDropdownItem
                  >
                  <MarDropdownItem
                    v-if="mutationsEnabled && row.node.kind === 'DIRECTORY'"
                    command="CREATE_DIRECTORY"
                    ><MarIcon name="folder-add" />{{
                      translate('generated.workspaceFileTree.newFolder')
                    }}</MarDropdownItem
                  >
                  <MarDropdownItem v-if="row.node.kind === 'DIRECTORY'" command="UPLOAD"
                    ><MarIcon name="upload" />{{
                      translate('generated.workspaceFileTree.uploadFiles')
                    }}</MarDropdownItem
                  >
                  <MarDropdownItem command="COPY_PATH"
                    ><MarIcon name="path-relative" :size="14" />{{
                      translate('generated.workspaceFileTree.copyRelativePath')
                    }}</MarDropdownItem
                  >
                  <MarDropdownItem command="COPY_ABSOLUTE_PATH" :disabled="!rootPath"
                    ><MarIcon name="path-absolute" :size="14" />{{
                      translate('generated.workspaceFileTree.copyAbsolutePath')
                    }}</MarDropdownItem
                  >
                  <MarDropdownItem v-if="localFileManagerEnabled" command="REVEAL_LOCAL"
                    ><MarIcon name="folder-open" />{{
                      translate('generated.workspaceFileTree.openInLocalFileManager')
                    }}</MarDropdownItem
                  >
                  <MarDropdownItem v-if="mutationsEnabled && row.node.path !== '.'" command="RENAME"
                    ><MarIcon name="edit" />{{
                      translate('generated.workspaceFileTree.rename')
                    }}</MarDropdownItem
                  >
                  <MarDropdownItem
                    v-if="mutationsEnabled && row.node.path !== '.'"
                    command="DELETE"
                    divided
                    ><MarIcon name="delete" />{{
                      translate('generated.workspaceFileTree.delete')
                    }}</MarDropdownItem
                  >
                </MarDropdownMenu>
              </template>
            </MarDropdown>
            <span v-else class="file-tree-more" aria-hidden="true"></span>
          </div>
          <div v-else class="file-tree-load-more" :style="{ '--tree-depth': row.depth }">
            <MarButton
              v-if="row.node.failedAppend !== undefined"
              class="mar-text-action"
              link
              v-tooltip="!row.node.loading ? errorMessage(row.node.failure) : ''"
              :aria-description="!row.node.loading ? errorMessage(row.node.failure) : undefined"
              :aria-disabled="row.node.loading || disabled"
              :aria-busy="row.node.loading || undefined"
              @click="!row.node.loading && !disabled && emit('loadMore', row.node)"
            >
              <template v-if="row.node.loading"
                ><MarIcon name="loading-action" />
                {{ translate('generated.workspaceInspector.loading') }}</template
              >
              <template v-else>{{ translate('common.loadFailedRetry') }}</template>
            </MarButton>
            <span v-else-if="row.node.loading" role="status"
              ><MarIcon name="loading-action" />
              {{ translate('generated.workspaceInspector.loading') }}</span
            >
          </div>
        </template>
      </div>
    </div>
    <p v-if="!hideRows && !hasFilteredResult" class="file-tree-empty">
      {{ translate('workspaceDisplayFilter.empty') }}
    </p>
  </div>
</template>

<style scoped>
.workspace-file-tree {
  --file-tree-row-size: var(--mar-compact-row-size);
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 0.375rem 8px;
  outline: none;
}

.file-tree-read-state {
  display: flex;
  flex: none;
  flex-direction: column;
}

.file-tree-read-state.is-centered {
  flex: 1 1 auto;
  min-height: 0;
}

.workspace-file-tree.is-root-drop-target {
  outline: 2px dashed var(--mar-control-focus);
  outline-offset: -3px;
  background: var(--mar-fill-soft);
}

.file-tree-virtual-space,
.file-tree-virtual-window {
  position: relative;
  flex: none;
  width: 100%;
  min-width: 0;
}

.file-tree-virtual-window {
  position: absolute;
  inset: 0 auto auto 0;
}

.file-tree-empty {
  margin: 0;
  color: var(--mar-text-secondary);
  padding: 0.45rem 0.65rem;
  font-size: var(--mar-font-size-meta);
  text-align: center;
}

@media (min-width: 768px) {
  .workspace-file-tree {
    --file-tree-row-size: 24px;
  }

  .tree-name {
    font-size: var(--mar-font-size-navigation);
  }
}

.file-tree-row,
.file-tree-load-more {
  display: grid;
  width: 100%;
  min-width: 0;
  min-height: var(--file-tree-row-size);
  height: var(--file-tree-row-size);
  box-sizing: border-box;
  border: 0;
  background: transparent;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  line-height: 1.25;
  text-align: left;
  white-space: nowrap;
}

.file-tree-row {
  min-height: calc(var(--file-tree-row-size) - 2px);
  height: calc(var(--file-tree-row-size) - 2px);
  grid-template-columns: 0.8rem 18px minmax(0, 1fr);
  gap: 0;
  width: auto;
  flex: 1;
  align-items: center;
  padding: 0 6px 0 calc(4px + var(--tree-depth) * 8px);
  cursor: pointer;
}

.file-tree-row-shell {
  position: relative;
  display: flex;
  width: 100%;
  min-width: 0;
  height: var(--file-tree-row-size);
  box-sizing: border-box;
  border-block: 1px solid transparent;
  border-radius: var(--mar-radius-selection);
  background-clip: padding-box;
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}

.file-tree-row-shell.selected {
  background-color: var(--mar-fill-selection);
}

.file-tree-row-shell.selected .file-tree-row {
  color: var(--mar-text-primary);
}

.file-tree-row-shell.drop-target {
  background-color: var(--mar-fill-soft);
  outline: 1px solid var(--mar-control-focus);
  outline-offset: -1px;
}

.file-tree-row:disabled {
  cursor: default;
}

.file-tree-more {
  --mar-ui-action-icon-size: 14px;
  display: inline-flex;
  width: 22px;
  height: 20px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--mar-radius-control);
  background: transparent;
  color: var(--mar-text-secondary);
  cursor: pointer;
  align-self: center;
  flex: 0 0 22px;
  margin-left: 0;
}

.file-tree-more:not(.is-visible) {
  visibility: hidden;
}

.tree-chevron,
.tree-kind {
  color: var(--mar-text-secondary);
}

.tree-chevron {
  font-size: 0.6rem;
}

.tree-kind {
  font-size: 0.875rem;
}

.tree-chevron.expanded {
  transform: rotate(90deg);
}

@media (prefers-reduced-motion: no-preference) {
  .tree-chevron {
    transition: transform 100ms ease;
  }
}

.tree-name {
  min-width: 0;
  overflow: hidden;
  padding-right: 2px;
  color: var(--mar-text-primary);
  line-height: 1.5;
  text-overflow: ellipsis;
}

.file-tree-load-more > button,
.file-tree-load-more > span {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 4px;
  min-width: 0;
  height: 100%;
  box-sizing: border-box;
  border: 0;
  background: transparent;
  font: inherit;
  margin: 0;
  padding: 0;
  text-align: left;
}

.file-tree-load-more {
  --mar-ui-action-icon-size: 1em;
  font-size: var(--mar-font-size-meta);
  padding: 0 6px 0 calc(4px + 0.8rem + 18px + var(--tree-depth) * 8px);
}

.file-tree-load-more > button {
  cursor: pointer;
}
</style>
