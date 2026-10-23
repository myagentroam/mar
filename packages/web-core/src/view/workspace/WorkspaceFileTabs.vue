<script setup lang="ts">
import MarIcon from '../common/MarIcon.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { consoleKeyboardShortcutService } from '../../service/ConsoleKeyboardShortcutService.js';
import { createFilePreviewWindowInteractionService } from '../../service/FilePreviewWindowInteractionService.js';
import { translate } from '../../service/LocalePreferenceService.js';
import type { WorkspaceFileTab } from '../../util/workspace-file-tab.js';

export interface WorkspaceFilePageHandle {
  focus(): void;
  cursorPosition?(): { readonly line: number; readonly column: number } | undefined;
  navigateTo?(line: number, column?: number): void;
  openFind(): boolean;
  selectAll(): boolean;
  toggleEdit(): 'CHANGED' | 'UNAVAILABLE';
  canClose(): Promise<boolean>;
  captureDirtyDrafts?(): readonly unknown[];
  prepareForConfirmedClose?(): void;
}

const props = defineProps<{
  readonly tabs: readonly WorkspaceFileTab[];
  readonly activeTabId?: number | undefined;
  readonly canGoBack?: boolean;
  readonly canGoForward?: boolean;
  readonly canCloseUnmountedTab?: (id: number) => Promise<boolean>;
}>();

const emit = defineEmits<{
  activate: [id: number];
  close: [id: number];
  closeAll: [ids: readonly number[]];
  closeLast: [];
  move: [id: number, targetIndex: number];
  back: [];
  forward: [];
}>();
const root = ref<HTMLElement>();
const pageHandles = new Map<number, WorkspaceFilePageHandle>();
const closing = ref(false);
const activeTab = computed(
  () => props.tabs.find((tab) => tab.id === props.activeTabId) ?? props.tabs.at(-1)
);
let unregisterShortcut: (() => void) | undefined;
const windowInteraction = createFilePreviewWindowInteractionService({
  isOpen: () => props.tabs.length > 0,
  closeWindow: requestCloseAll,
  closeTab: () => (activeTab.value === undefined ? false : requestClose(activeTab.value.id))
});

function registerPageHandle(id: number, handle: unknown): void {
  if (isPageHandle(handle)) pageHandles.set(id, handle);
  else pageHandles.delete(id);
}

function isPageHandle(value: unknown): value is WorkspaceFilePageHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as WorkspaceFilePageHandle).focus === 'function' &&
    typeof (value as WorkspaceFilePageHandle).openFind === 'function' &&
    typeof (value as WorkspaceFilePageHandle).selectAll === 'function' &&
    typeof (value as WorkspaceFilePageHandle).toggleEdit === 'function' &&
    typeof (value as WorkspaceFilePageHandle).canClose === 'function'
  );
}

async function requestClose(id: number): Promise<boolean> {
  return requestCloseTabs([id], false);
}

async function requestCloseAll(): Promise<boolean> {
  return requestCloseTabs(
    props.tabs.map((tab) => tab.id),
    true
  );
}

async function requestCloseTabs(ids: readonly number[], all: boolean): Promise<boolean> {
  if (closing.value || ids.length === 0) return false;
  const tabs = [...props.tabs];
  if (ids.some((id) => !tabs.some((tab) => tab.id === id))) return false;
  const handles = ids.map((id) => pageHandles.get(id));
  closing.value = true;
  try {
    for (const [index, handle] of handles.entries()) {
      const canClose = handle?.canClose() ?? props.canCloseUnmountedTab?.(ids[index]!) ?? true;
      if (!(await canClose)) return false;
    }
    if (
      props.tabs.length !== tabs.length ||
      props.tabs.some((tab, index) => tab !== tabs[index]) ||
      ids.some((id, index) => pageHandles.get(id) !== handles[index])
    )
      return false;
    const closesLastTab = ids.length === props.tabs.length;
    for (const handle of handles) handle?.prepareForConfirmedClose?.();
    if (all) emit('closeAll', ids);
    else emit('close', ids[0]!);
    if (closesLastTab) emit('closeLast');
    return true;
  } finally {
    closing.value = false;
  }
}

function close(event: Event, id: number): void {
  event.stopPropagation();
  void requestClose(id);
}

function handleShortcut(event: KeyboardEvent): 'HANDLED' | 'IGNORED' {
  if (
    root.value?.contains(event.target as Node) === true &&
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229
  ) {
    if (event.key === 'ArrowLeft') {
      if (props.canGoBack) emit('back');
      return 'HANDLED';
    }
    if (event.key === 'ArrowRight') {
      if (props.canGoForward) emit('forward');
      return 'HANDLED';
    }
  }
  if (
    root.value?.contains(event.target as Node) !== true ||
    event.altKey ||
    event.shiftKey ||
    event.ctrlKey === event.metaKey ||
    event.isComposing ||
    event.keyCode === 229
  )
    return 'IGNORED';
  const target = event.target;
  if (
    event.key.toLowerCase() === 'a' &&
    target instanceof Element &&
    target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])') !== null
  )
    return 'IGNORED';
  const handle = activeTab.value === undefined ? undefined : pageHandles.get(activeTab.value.id);
  if (handle === undefined) return 'IGNORED';
  const key = event.key.toLowerCase();
  if (key === 'f') return handle.openFind() ? 'HANDLED' : 'IGNORED';
  if (key === 'a') return handle.selectAll() ? 'HANDLED' : 'IGNORED';
  if (key !== 'e') return 'IGNORED';
  return handle.toggleEdit() === 'CHANGED' ? 'HANDLED' : 'IGNORED';
}

function activate(id: number): void {
  emit('activate', id);
}

function onTabKeydown(event: KeyboardEvent, id: number): void {
  const index = props.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  let targetIndex: number | undefined;
  if (event.key === 'ArrowLeft') targetIndex = (index - 1 + props.tabs.length) % props.tabs.length;
  else if (event.key === 'ArrowRight') targetIndex = (index + 1) % props.tabs.length;
  else if (event.key === 'Home') targetIndex = 0;
  else if (event.key === 'End') targetIndex = props.tabs.length - 1;
  if (targetIndex === undefined) return;
  event.preventDefault();
  const target = props.tabs[targetIndex];
  if (target === undefined) return;
  emit('activate', target.id);
  void nextTick(() => {
    root.value
      ?.querySelectorAll<HTMLButtonElement>('.workspace-file-tab-activate')
      .item(targetIndex)
      .focus();
  });
}

function captureDirtyDrafts(): readonly unknown[] {
  return [...pageHandles.values()].flatMap((handle) => handle.captureDirtyDrafts?.() ?? []);
}

function cursorPosition(
  id: number
): { readonly line: number; readonly column: number } | undefined {
  return pageHandles.get(id)?.cursorPosition?.();
}

function navigateTo(id: number, line: number, column?: number): void {
  pageHandles.get(id)?.navigateTo?.(line, column);
}

function focusPage(id: number): void {
  pageHandles.get(id)?.focus();
}

onMounted(() => {
  document.documentElement.classList.add('file-preview-open');
  document.body.classList.add('file-preview-open');
  windowInteraction.mount();
  unregisterShortcut = consoleKeyboardShortcutService.register({
    priority: 100,
    handle: handleShortcut
  });
});
onBeforeUnmount(() => {
  unregisterShortcut?.();
  windowInteraction.dispose();
  document.documentElement.classList.remove('file-preview-open');
  document.body.classList.remove('file-preview-open');
});
defineExpose({
  requestClose,
  requestCloseAll,
  captureDirtyDrafts,
  cursorPosition,
  navigateTo,
  focusPage
});
</script>

<template>
  <section v-if="props.tabs.length > 0" ref="root" class="workspace-file-tabs">
    <header class="workspace-file-tab-header">
      <nav
        class="workspace-file-tab-list"
        role="tablist"
        :aria-label="translate('generated.filePreviewDialog.filePreviewTabs')"
      >
        <div
          v-for="tab in props.tabs"
          :key="tab.id"
          class="workspace-file-tab"
          :class="{ 'is-active': tab.id === activeTab?.id }"
        >
          <button
            v-tooltip="tab.path"
            class="workspace-file-tab-activate"
            :aria-description="tab.path"
            role="tab"
            :aria-selected="tab.id === activeTab?.id"
            :tabindex="tab.id === activeTab?.id ? 0 : -1"
            type="button"
            @click="activate(tab.id)"
            @keydown="onTabKeydown($event, tab.id)"
          >
            <span>{{ tab.fileName }}</span>
          </button>
          <button
            v-tooltip="translate('generated.filePreviewDialog.closePreview')"
            class="workspace-file-tab-close"
            type="button"
            :disabled="closing"
            :aria-label="translate('generated.filePreviewDialog.closePreview')"
            @click="close($event, tab.id)"
          >
            <MarIcon name="close" />
          </button>
        </div>
      </nav>
      <button
        v-tooltip="translate('filePreviewDialog.closeFileWindow')"
        class="workspace-file-window-close"
        type="button"
        :disabled="closing"
        :aria-label="translate('filePreviewDialog.closeFileWindow')"
        @click="requestCloseAll"
      >
        <MarIcon name="close" />
      </button>
    </header>
    <div class="workspace-file-tab-content">
      <template v-for="tab in props.tabs" :key="tab.id">
        <slot
          :tab="tab"
          :active="tab.id === activeTab?.id"
          :register-page-handle="(handle: unknown) => registerPageHandle(tab.id, handle)"
          :request-close="() => requestClose(tab.id)"
        />
      </template>
    </div>
  </section>
</template>

<style scoped>
.workspace-file-tabs {
  position: fixed;
  z-index: 50;
  inset: 0;
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  background: var(--mar-bg-page);
  color: var(--mar-text-primary);
}

.workspace-file-tab-header {
  position: relative;
  z-index: 1;
  display: flex;
  height: 32px;
  min-height: 32px;
  flex: 0 0 32px;
  align-items: center;
  border-bottom: 1px solid var(--mar-border-strong);
  background: var(--mar-bg-subtle);
  color: var(--mar-text-secondary);
}

.workspace-file-tab-list {
  display: flex;
  min-width: 0;
  height: 100%;
  flex: 1;
  overflow-x: auto;
  overflow-y: hidden;
  gap: 3px;
  padding: 3px;
}

.workspace-file-tab {
  display: inline-flex;
  flex-shrink: 0;
  min-width: 0;
  align-items: center;
  border-radius: var(--mar-radius-selection);
  background: transparent;
  color: inherit;
}

.workspace-file-tab-activate {
  display: inline-flex;
  min-width: 0;
  height: 100%;
  align-items: center;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 0 4px 0 8px;
}

.workspace-file-tab-activate > span {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-file-tab.is-active {
  background: var(--mar-fill-selection);
  color: var(--mar-text-primary);
}

.workspace-file-tab:not(.is-active):hover {
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}

:global(html[data-theme='vscode-dark-2026']) .workspace-file-tab-header {
  background: var(--mar-bg-page);
}

.workspace-file-tab-close,
.workspace-file-window-close {
  display: grid;
  width: 24px;
  min-width: 24px;
  height: 24px;
  place-items: center;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
}

.workspace-file-window-close {
  flex: 0 0 24px;
  margin-inline: 0.25rem;
}

.workspace-file-tab-close:hover,
.workspace-file-tab-close:focus-visible,
.workspace-file-window-close:hover,
.workspace-file-window-close:focus-visible {
  background: transparent;
  color: var(--mar-color-brand-text);
}

.workspace-file-tab-close:focus-visible,
.workspace-file-window-close:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: 1px;
}

.workspace-file-tab-content {
  display: flex;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

@media (max-width: 767px) {
  .workspace-file-tab-header {
    height: 40px;
    min-height: 40px;
    flex: 0 0 40px;
  }

  .workspace-file-tab-list {
    align-items: center;
    gap: 4px;
    padding: 2px 4px;
  }

  .workspace-file-tab {
    height: 36px;
    min-height: 36px;
  }

  .workspace-file-tab-activate > span {
    max-width: 120px;
  }

  .workspace-file-tab-close,
  .workspace-file-window-close {
    width: 36px;
    min-width: 36px;
    height: 36px;
  }

  .workspace-file-window-close {
    flex-basis: 36px;
  }
}
</style>
