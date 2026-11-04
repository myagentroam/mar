<script setup lang="ts">
import MarIcon from '../common/MarIcon.vue';
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { fileKeys } from '../../service/console-shortcut-keys.js';
import MarTab from '../common/MarTab.vue';
import { tabStripIdentity } from '../../util/tab-strip-identity.js';
import {
  consoleKeyboardShortcutService,
  type ConsoleShortcutBinding
} from '../../service/console-keyboard-shortcut-service.js';
import { createFilePreviewWindowInteractionService } from '../../service/file-preview-window-interaction-service.js';
import FilePreviewSurface from './FilePreviewSurface.vue';
import { translate } from '../../service/locale-preference-service.js';
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
  readonly presentation?: 'overlay' | 'window';
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
const tabPrefix = `file-tabs-${useId()}`;
const surface = ref<InstanceType<typeof FilePreviewSurface>>();
const pageHandles = new Map<number, WorkspaceFilePageHandle>();
const closing = ref(false);
const leaving = ref(false);
const activeTab = computed(
  () => props.tabs.find((tab) => tab.id === props.activeTabId) ?? props.tabs.at(-1)
);
const previewLabel = computed(() => {
  const tab = activeTab.value;
  if (tab?.kind === 'TOOL_CHANGE_DIFF')
    return `${tab.path} ${translate('presentation.thisChange')}`;
  if (tab?.kind === 'WORKTREE_DIFF' || tab?.kind === 'HISTORY_DIFF')
    return `${tab.path} ${translate('common.gitDiff')}`;
  return translate('generated.filePreviewDialog.filePreview', { value0: tab?.path ?? '' });
});
let unregisterShortcut: (() => void) | undefined;
const windowInteraction = createFilePreviewWindowInteractionService({
  isOpen: () => props.tabs.length > 0,
  root: () => root.value,
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
    if (closesLastTab && props.presentation !== 'window' && surface.value) {
      leaving.value = true;
      if (!(await surface.value.close())) return false;
    }
    for (const handle of handles) handle?.prepareForConfirmedClose?.();
    if (all) emit('closeAll', ids);
    else emit('close', ids[0]!);
    if (closesLastTab) emit('closeLast');
    return true;
  } finally {
    leaving.value = false;
    closing.value = false;
  }
}

const shortcutOwner = () => root.value;
const activeHandle = () =>
  activeTab.value === undefined ? undefined : pageHandles.get(activeTab.value.id);
const shortcutBindings: readonly ConsoleShortcutBinding[] = [
  {
    command: 'filePreview.back',
    priority: 100,
    scope: 'file-preview',
    owner: shortcutOwner,
    keys: fileKeys.back,
    when: () => true,
    execute: () => {
      if (props.canGoBack) emit('back');
      return 'HANDLED';
    }
  },
  {
    command: 'filePreview.forward',
    priority: 100,
    scope: 'file-preview',
    owner: shortcutOwner,
    keys: fileKeys.forward,
    when: () => true,
    execute: () => {
      if (props.canGoForward) emit('forward');
      return 'HANDLED';
    }
  },
  {
    command: 'filePreview.find',
    priority: 100,
    scope: 'file-preview',
    owner: shortcutOwner,
    keys: fileKeys.find,
    when: () => true,
    execute: () => (activeHandle()?.openFind() ? 'HANDLED' : 'IGNORED')
  },
  {
    command: 'filePreview.selectAll',
    priority: 100,
    scope: 'file-preview',
    owner: shortcutOwner,
    keys: fileKeys.selectAll,
    when: (event) =>
      !(
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, [contenteditable]:not([contenteditable="false"])'
        ) !== null
      ),
    execute: () => (activeHandle()?.selectAll() ? 'HANDLED' : 'IGNORED')
  },
  {
    command: 'filePreview.toggleEdit',
    priority: 100,
    scope: 'file-preview',
    owner: shortcutOwner,
    keys: fileKeys.toggleEdit,
    when: () => true,
    execute: () => (activeHandle()?.toggleEdit() === 'CHANGED' ? 'HANDLED' : 'IGNORED')
  }
];

function activate(id: number): void {
  emit('activate', id);
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

function focusActivePage(): void {
  const handle = activeTab.value && pageHandles.get(activeTab.value.id);
  if (handle) handle.focus();
  else root.value?.focus();
}

onMounted(() => {
  if (props.presentation === 'window') {
    document.documentElement.classList.add('file-preview-open');
    document.body.classList.add('file-preview-open');
  }
  windowInteraction.mount();
  const unregister = shortcutBindings.map((binding) =>
    consoleKeyboardShortcutService.register(binding)
  );
  unregister.push(
    consoleKeyboardShortcutService.registerRegion({
      scope: 'file-preview',
      root: shortcutOwner,
      blocksOtherScopes: true
    })
  );
  unregisterShortcut = () => unregister.forEach((release) => release());
});
onBeforeUnmount(() => {
  unregisterShortcut?.();
  windowInteraction.dispose();
  if (props.presentation === 'window') {
    document.documentElement.classList.remove('file-preview-open');
    document.body.classList.remove('file-preview-open');
  }
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
  <FilePreviewSurface
    v-if="props.tabs.length > 0"
    ref="surface"
    :overlay="props.presentation !== 'window'"
    :label="previewLabel"
    @focus="focusActivePage"
    @close="requestCloseAll"
  >
    <section
      ref="root"
      class="workspace-file-tabs"
      :class="{ 'is-window': props.presentation === 'window' }"
      :inert="leaving"
      tabindex="-1"
      :role="props.presentation === 'window' ? 'region' : undefined"
      :aria-label="translate('generated.filePreviewDialog.filePreviewTabs')"
    >
      <header class="workspace-file-tab-header">
        <MarTab
          class="workspace-file-tab-list"
          :id-prefix="tabPrefix"
          :items="
            props.tabs.map((tab) => ({
              id: tab.id,
              label: tab.fileName,
              description: tab.path,
              closeLabel: translate('generated.filePreviewDialog.closePreview'),
              closeDisabled: closing
            }))
          "
          :active-id="activeTab?.id"
          :label="translate('generated.filePreviewDialog.filePreviewTabs')"
          item-class="workspace-file-tab"
          tab-class="workspace-file-tab-activate"
          close-class="workspace-file-tab-close"
          @activate="(id) => typeof id === 'number' && activate(id)"
          @close="(id) => typeof id === 'number' && requestClose(id)"
        />
        <button
          v-tooltip="translate('filePreviewDialog.closeFileWindow')"
          class="icon-button utility-control workspace-file-window-close"
          type="button"
          :disabled="closing"
          :aria-label="translate('filePreviewDialog.closeFileWindow')"
          @click="requestCloseAll"
        >
          <MarIcon name="close" />
        </button>
      </header>
      <div class="workspace-file-tab-content">
        <div
          v-for="tab in props.tabs"
          v-show="tab.id === activeTab?.id"
          :id="tabStripIdentity(tabPrefix, tab.id).panel"
          :key="tab.id"
          class="workspace-file-tab-panel"
          role="tabpanel"
          :aria-labelledby="tabStripIdentity(tabPrefix, tab.id).tab"
        >
          <slot
            :tab="tab"
            :active="tab.id === activeTab?.id"
            :register-page-handle="(handle: unknown) => registerPageHandle(tab.id, handle)"
            :request-close="() => requestClose(tab.id)"
          />
        </div>
      </div>
    </section>
  </FilePreviewSurface>
</template>

<style scoped>
.workspace-file-tabs {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  background: var(--mar-bg-page);
  color: var(--mar-text-primary);
}

.workspace-file-tabs.is-window {
  position: fixed;
  z-index: 50;
  inset: 0;
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

:global(html[data-theme='vscode-dark-2026']) .workspace-file-tab-header {
  background: var(--mar-bg-page);
}

.workspace-file-window-close {
  display: grid;
  width: 24px;
  min-width: 24px;
  height: 24px;
  place-items: center;
  border: 0;
  border-radius: 3px;
  cursor: pointer;
  font-size: 13px;
}

.workspace-file-window-close {
  flex: 0 0 24px;
  margin-inline: 0.25rem;
}

.workspace-file-window-close:focus-visible {
  outline-offset: 1px;
}

.workspace-file-tab-content {
  display: flex;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}
.workspace-file-tab-panel {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

@media (max-width: 767px) {
  .workspace-file-tab-header {
    height: 40px;
    min-height: 40px;
    flex: 0 0 40px;
  }

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
