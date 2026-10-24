<script setup lang="ts">
import MarIcon from '../common/MarIcon.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { WorkspaceTab } from '../../model/workbench.js';
import { translate } from '../../service/LocalePreferenceService.js';

const props = defineProps<{
  readonly placement: 'header' | 'body';
  readonly tabs: readonly WorkspaceTab[];
  readonly activeTabId: string | undefined;
  readonly emptyLabel?: string;
  readonly emptyContext?: string;
  readonly nodeLabel: (tab: WorkspaceTab) => string;
  readonly directAvailable: (nodeId: string) => boolean;
  readonly directDescription: (nodeId: string) => string | undefined;
  readonly hasActiveRun: (nodeId: string, workspaceId: string) => boolean;
  readonly hasUnread: (nodeId: string, workspaceId: string) => boolean;
}>();

const emit = defineEmits<{
  activate: [tab: WorkspaceTab];
  close: [tab: WorkspaceTab];
  reorder: [tabId: string, targetIndex: number];
  pin: [tabId: string, pinned: boolean];
}>();

const draggingTabId = ref<string | undefined>();
const dragOverTabId = ref<string | undefined>();
const suppressActivation = ref(false);
const tabList = ref<HTMLElement>();
const canScrollLeft = ref(false);
const canScrollRight = ref(false);
const hasOverflow = ref(false);
const pinnedOffsets = ref<Readonly<Record<string, number>>>({});
const pinnedWidth = ref(0);
const contextMenu = ref<{ tabId: string; x: number; y: number }>();
const contextMenuTrigger = ref<HTMLButtonElement>();
const contextTabIndex = computed(() =>
  props.tabs.findIndex((tab) => tab.id === contextMenu.value?.tabId)
);
const contextTabPinned = computed(() => props.tabs[contextTabIndex.value]?.pinned === true);
let pointerId: number | undefined;
let pointerStartX = 0;
let pointerStartY = 0;
let pointerMoved = false;
let pointerTab: WorkspaceTab | undefined;
let resizeObserver: ResizeObserver | undefined;

function mobileViewport(): boolean {
  return window.matchMedia('(max-width: 767px)').matches;
}

function updateOverflowState(): void {
  const element = tabList.value;
  if (element === undefined) return;
  const overflow = element.scrollWidth > element.clientWidth + 1;
  hasOverflow.value = overflow;
  canScrollLeft.value = overflow && element.scrollLeft > 1;
  canScrollRight.value =
    overflow && element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
}

function updateTabLayout(): void {
  const element = tabList.value;
  const offsets: Record<string, number> = {};
  let width = 0;
  if (element !== undefined && !mobileViewport()) {
    const normal = element.querySelector<HTMLElement>('.workspace-tab:not(.pinned)');
    const style = getComputedStyle(element);
    const gap = Number.parseFloat(style.columnGap) || 0;
    width = Number.parseFloat(style.paddingLeft) || 0;
    for (const pinned of element.querySelectorAll<HTMLElement>('.workspace-tab.pinned')) {
      if (pinned.dataset.tabId === undefined) continue;
      offsets[pinned.dataset.tabId] = width;
      width += pinned.getBoundingClientRect().width + gap;
    }
    const normalMinimum =
      normal === null ? 0 : Number.parseFloat(getComputedStyle(normal).minWidth);
    if (
      normal === null ||
      Object.keys(offsets).length === 0 ||
      element.clientWidth - width - (Number.parseFloat(style.paddingRight) || 0) < normalMinimum
    ) {
      width = 0;
      for (const id of Object.keys(offsets)) delete offsets[id];
    }
  }
  pinnedOffsets.value = offsets;
  pinnedWidth.value = width;
  updateOverflowState();
}

function observeTabList(): void {
  const element = tabList.value;
  resizeObserver?.disconnect();
  if (element === undefined) return;
  resizeObserver ??= new ResizeObserver(() => {
    updateTabLayout();
    scrollActiveTabIntoView();
  });
  resizeObserver.observe(element);
  for (const tab of element.querySelectorAll('.workspace-tab')) resizeObserver.observe(tab);
}

function scrollActiveTabIntoView(): void {
  const id = props.activeTabId;
  const element =
    id === undefined
      ? undefined
      : tabList.value?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`);
  const list = tabList.value;
  if (element === undefined || element === null || list === undefined) return;
  if (id !== undefined && pinnedOffsets.value[id] !== undefined) return;
  const bounds = element.getBoundingClientRect();
  const viewport = list.getBoundingClientRect();
  const style = getComputedStyle(list);
  const left = viewport.left + (pinnedWidth.value || Number.parseFloat(style.paddingLeft) || 0);
  const right = viewport.right - (Number.parseFloat(style.paddingRight) || 0);
  const delta =
    bounds.left < left ? bounds.left - left : bounds.right > right ? bounds.right - right : 0;
  if (delta !== 0) list.scrollBy({ left: delta, behavior: 'smooth' });
}

function scrollTabs(direction: -1 | 1): void {
  const element = tabList.value;
  if (element === undefined) return;
  element.scrollBy({
    left: direction * Math.max(180, Math.floor((element.clientWidth - pinnedWidth.value) * 0.7)),
    behavior: 'smooth'
  });
}

function activateFromMenu(tabId: string | number | object): void {
  if (typeof tabId !== 'string') return;
  const tab = props.tabs.find((candidate) => candidate.id === tabId);
  if (tab !== undefined) emit('activate', tab);
}

async function openContextMenu(event: MouseEvent, tab: WorkspaceTab): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  contextMenu.value = undefined;
  await nextTick();
  const menu = {
    tabId: tab.id,
    x: Math.max(6, Math.min(event.clientX, window.innerWidth - 180)),
    y: Math.max(6, Math.min(event.clientY, window.innerHeight - 154))
  };
  contextMenu.value = menu;
  await nextTick();
  if (contextMenu.value?.tabId === menu.tabId) contextMenuTrigger.value?.click();
}

function contextCommand(command: 'previous' | 'next' | 'close' | 'pin'): void {
  const index = contextTabIndex.value;
  const tab = props.tabs[index];
  contextMenu.value = undefined;
  if (tab === undefined) return;
  if (command === 'pin') emit('pin', tab.id, tab.pinned !== true);
  else if (command === 'close') {
    if (tab.pinned !== true) emit('close', tab);
  } else {
    const targetIndex = index + (command === 'previous' ? -1 : 1);
    if (targetIndex >= 0 && targetIndex < props.tabs.length) emit('reorder', tab.id, targetIndex);
  }
}

function closeContextMenuOnEscape(event: KeyboardEvent): void {
  if (contextMenu.value === undefined || event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  contextMenu.value = undefined;
}

function syncTabList(scrollActive = false): void {
  void nextTick(() => {
    observeTabList();
    updateTabLayout();
    if (scrollActive) scrollActiveTabIntoView();
  });
}

watch(
  () => props.tabs,
  () => {
    if (contextTabIndex.value < 0) contextMenu.value = undefined;
    syncTabList(true);
  },
  { flush: 'post', immediate: true }
);

watch(
  () => props.activeTabId,
  () => syncTabList(true),
  { flush: 'post' }
);

onMounted(() => window.addEventListener('keydown', closeContextMenuOnEscape, { capture: true }));
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener('keydown', closeContextMenuOnEscape, { capture: true });
});

function resetPointerInteraction(): void {
  draggingTabId.value = undefined;
  dragOverTabId.value = undefined;
  pointerId = undefined;
  pointerMoved = false;
  pointerTab = undefined;
}

function beginDragging(element: HTMLElement, event: PointerEvent, tab: WorkspaceTab): void {
  pointerId = event.pointerId;
  pointerStartX = event.clientX;
  pointerStartY = event.clientY;
  pointerMoved = false;
  pointerTab = tab;
  draggingTabId.value = element.dataset.tabId;
  element.setPointerCapture(event.pointerId);
}

function suppressNextActivation(): void {
  suppressActivation.value = true;
  window.setTimeout(() => {
    suppressActivation.value = false;
  }, 0);
}

function handlePointerDown(event: PointerEvent, tab: WorkspaceTab): void {
  if (event.button !== 0 || (event.target as HTMLElement).closest('.tab-close, .tab-pin') !== null)
    return;
  if (mobileViewport()) return;
  beginDragging(event.currentTarget as HTMLElement, event, tab);
}

function handlePointerMove(event: PointerEvent): void {
  if (pointerId !== event.pointerId || draggingTabId.value === undefined) return;
  if (!pointerMoved) {
    pointerMoved = Math.hypot(event.clientX - pointerStartX, event.clientY - pointerStartY) >= 4;
  }
  if (!pointerMoved) return;
  const element = document.elementFromPoint(event.clientX, event.clientY);
  dragOverTabId.value = element?.closest<HTMLElement>('.workspace-tab')?.dataset.tabId;
  event.preventDefault();
}

function handlePointerUp(event: PointerEvent): void {
  if (pointerId !== event.pointerId || draggingTabId.value === undefined) return;
  const draggedTabId = draggingTabId.value;
  const targetTab = document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest<HTMLElement>('.workspace-tab');
  const targetTabId = targetTab?.dataset.tabId;
  const tabsElement = targetTab?.parentElement;
  if (!pointerMoved && pointerTab !== undefined) {
    activate(pointerTab);
    suppressNextActivation();
  }
  if (
    pointerMoved &&
    targetTab !== undefined &&
    targetTab !== null &&
    targetTabId !== undefined &&
    tabsElement !== null &&
    tabsElement !== undefined
  ) {
    const children = [...tabsElement.children] as HTMLElement[];
    const targetIndex = children.findIndex((child) => child.dataset.tabId === targetTabId);
    const sourceIndex = children.findIndex((child) => child.dataset.tabId === draggedTabId);
    const midpoint = targetTab.getBoundingClientRect().left + targetTab.offsetWidth / 2;
    const insertionIndex = event.clientX > midpoint ? targetIndex + 1 : targetIndex;
    emit(
      'reorder',
      draggedTabId,
      insertionIndex > sourceIndex ? insertionIndex - 1 : insertionIndex
    );
    suppressNextActivation();
  }
  resetPointerInteraction();
}

function handlePointerCancel(event: PointerEvent): void {
  if (pointerId !== event.pointerId) return;
  resetPointerInteraction();
}

function activate(tab: WorkspaceTab): void {
  if (suppressActivation.value) return;
  emit('activate', tab);
}
</script>

<template>
  <section
    v-if="tabs.length > 0 || (placement === 'header' && emptyLabel !== undefined)"
    :class="['workspace-tab-strip', `workspace-tab-strip-${placement}`]"
  >
    <button
      v-if="hasOverflow"
      class="tab-strip-scroll"
      :aria-label="translate('workspaceTabs.scrollPrevious')"
      :disabled="!canScrollLeft"
      type="button"
      @click="scrollTabs(-1)"
    >
      <MarIcon name="chevron-left" />
    </button>
    <div
      ref="tabList"
      class="workspace-tabs"
      role="tablist"
      :aria-label="translate('generated.workspaceTabs.openWorkspaces')"
      @scroll.passive="updateOverflowState"
    >
      <div
        v-if="tabs.length === 0 && emptyLabel !== undefined"
        class="workspace-tab workspace-tab-placeholder active"
        role="tab"
        aria-selected="true"
      >
        <span class="workspace-tab-content">
          <span>{{ emptyLabel }}</span>
          <small v-if="emptyContext">{{ emptyContext }}</small>
        </span>
      </div>
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="workspace-tab"
        :data-tab-id="tab.id"
        :class="{
          active: activeTabId === tab.id,
          pinned: tab.pinned === true,
          'sticky-pinned': pinnedOffsets[tab.id] !== undefined,
          dragging: draggingTabId === tab.id,
          'drag-over': dragOverTabId === tab.id && draggingTabId !== tab.id
        }"
        :style="
          pinnedOffsets[tab.id] === undefined ? undefined : { left: `${pinnedOffsets[tab.id]}px` }
        "
        @pointerdown="handlePointerDown($event, tab)"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointercancel="handlePointerCancel"
        @contextmenu="openContextMenu($event, tab)"
      >
        <button
          v-tooltip="tab.label"
          :aria-label="tab.label"
          role="tab"
          :aria-selected="activeTabId === tab.id"
          type="button"
          @click="activate(tab)"
        >
          <span class="workspace-tab-content">
            <span>{{ tab.label }}</span>
            <small class="workspace-tab-meta">
              <span
                v-tooltip="directDescription(tab.nodeId)"
                v-if="activeTabId === tab.id && directAvailable(tab.nodeId)"
                class="workspace-tab-node direct-available-node"
                :aria-description="directDescription(tab.nodeId)"
              >
                <span class="workspace-tab-node-label">{{ nodeLabel(tab) }}</span>
                <MarIcon name="link" class="workspace-tab-direct-icon" aria-hidden="true" />
              </span>
              <span v-else class="workspace-tab-node">{{ nodeLabel(tab) }}</span>
              <span
                v-tooltip="translate('generated.sessionPresentation.managed')"
                v-if="hasActiveRun(tab.nodeId, tab.workspaceId)"
                class="workspace-tab-running session-activity managed_active"
                role="img"
                :aria-label="translate('workspaceTabs.running')"
                ><i aria-hidden="true"
              /></span>
              <span
                v-tooltip="translate('workspaceTabs.unreadDescription')"
                v-if="hasUnread(tab.nodeId, tab.workspaceId)"
                class="workspace-tab-unread"
                :aria-label="translate('workspaceTabs.unreadDescription')"
                >{{ translate('workspaceTabs.unread') }}</span
              >
            </small>
          </span>
        </button>
        <button
          v-tooltip="translate('workspaceTabs.unpin')"
          v-if="tab.pinned === true"
          class="tab-pin icon-button utility-control"
          :aria-label="translate('workspaceTabs.unpinLabel', { label: tab.label })"
          type="button"
          @click.stop="emit('pin', tab.id, false)"
        >
          <MarIcon name="pin" />
        </button>
        <button
          v-else
          class="tab-close icon-button utility-control"
          :aria-label="translate('generated.workspaceTabs.close', { value0: tab.label })"
          type="button"
          @click="emit('close', tab)"
        >
          <MarIcon name="close" />
        </button>
      </div>
    </div>
    <div v-if="hasOverflow" class="workspace-tab-overflow-actions">
      <button
        class="tab-strip-scroll"
        :aria-label="translate('workspaceTabs.scrollNext')"
        :disabled="!canScrollRight"
        type="button"
        @click="scrollTabs(1)"
      >
        <MarIcon name="chevron-right" />
      </button>
      <el-dropdown trigger="click" @command="activateFromMenu">
        <button
          class="workspace-tab-menu"
          :aria-label="translate('workspaceTabs.allOpenWorkspaces')"
          type="button"
        >
          <MarIcon name="chevron-down" />
        </button>
        <template #dropdown>
          <el-dropdown-menu class="workspace-tab-menu-list">
            <el-dropdown-item
              v-for="tab in tabs"
              :key="tab.id"
              :class="{ active: activeTabId === tab.id }"
              :command="tab.id"
            >
              <span>{{ tab.label }}</span>
              <small class="workspace-tab-meta">
                <span
                  v-tooltip="directDescription(tab.nodeId)"
                  v-if="activeTabId === tab.id && directAvailable(tab.nodeId)"
                  class="workspace-tab-node direct-available-node"
                  :aria-description="directDescription(tab.nodeId)"
                >
                  <span class="workspace-tab-node-label">{{ nodeLabel(tab) }}</span>
                  <MarIcon name="link" class="workspace-tab-direct-icon" aria-hidden="true" />
                </span>
                <span v-else class="workspace-tab-node">{{ nodeLabel(tab) }}</span>
                <span
                  v-tooltip="translate('generated.sessionPresentation.managed')"
                  v-if="hasActiveRun(tab.nodeId, tab.workspaceId)"
                  class="workspace-tab-running session-activity managed_active"
                  role="img"
                  :aria-label="translate('workspaceTabs.running')"
                  ><i aria-hidden="true"
                /></span>
                <span
                  v-tooltip="translate('workspaceTabs.unreadDescription')"
                  v-if="hasUnread(tab.nodeId, tab.workspaceId)"
                  class="workspace-tab-unread"
                  :aria-label="translate('workspaceTabs.unreadDescription')"
                  >{{ translate('workspaceTabs.unread') }}</span
                >
              </small>
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
    <div
      v-if="contextMenu !== undefined"
      class="workspace-tab-context-anchor"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
    >
      <el-dropdown
        trigger="click"
        placement="bottom-start"
        @command="contextCommand"
        @visible-change="!$event && (contextMenu = undefined)"
      >
        <button
          ref="contextMenuTrigger"
          class="workspace-tab-context-trigger"
          type="button"
          tabindex="-1"
        />
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="pin">
              <MarIcon name="pin" />{{
                translate(contextTabPinned ? 'workspaceTabs.unpin' : 'workspaceTabs.pin')
              }}
            </el-dropdown-item>
            <el-dropdown-item command="previous" :disabled="contextTabIndex <= 0">
              <MarIcon name="chevron-left" />{{ translate('workspaceTabs.movePrevious') }}
            </el-dropdown-item>
            <el-dropdown-item
              command="next"
              :disabled="contextTabIndex < 0 || contextTabIndex >= tabs.length - 1"
            >
              <MarIcon name="chevron-right" />{{ translate('workspaceTabs.moveNext') }}
            </el-dropdown-item>
            <el-dropdown-item command="close" divided :disabled="contextTabPinned">
              <MarIcon name="close" />{{ translate('workspaceTabs.close') }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </section>
</template>

<style scoped>
.workspace-tab-context-anchor {
  position: fixed;
  z-index: 5000;
  width: 1px;
  height: 1px;
}

.workspace-tab-context-trigger {
  width: 1px;
  height: 1px;
  padding: 0;
  border: 0;
  background: transparent;
}

.workspace-tab-strip {
  --workspace-tab-base-bg: var(--mar-bg-chrome);
  --workspace-tab-gap: 3px;
  display: flex;
  min-width: 0;
  min-height: 34px;
  align-items: stretch;
  border-bottom: 1px solid var(--mar-border-subtle);
  background: var(--mar-bg-chrome);
}

.workspace-tab-strip-header {
  --workspace-tab-base-bg: var(--mar-bg-chrome);
  width: 100%;
  height: 100%;
  min-height: 0;
  border-bottom: 0;
  background: transparent;
}

.workspace-tab-strip-header .workspace-tabs {
  height: 100%;
  min-height: 0;
  align-items: center;
  padding: 5px 6px 5px 2px;
}

.workspace-tab-strip-header .workspace-tab {
  min-height: 32px;
}

.workspace-tab-strip-header .tab-strip-scroll,
.workspace-tab-strip-header .workspace-tab-menu {
  height: 32px;
  align-self: center;
  border-left: 0;
  border-radius: var(--el-border-radius-base);
  background: transparent;
}

.workspace-tabs {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  min-height: 34px;
  align-items: stretch;
  gap: var(--workspace-tab-gap);
  overflow-x: auto;
  margin: 0;
  padding: 4px 6px;
  scrollbar-width: none;
}

.workspace-tabs::-webkit-scrollbar {
  display: none;
}

.tab-strip-scroll,
.workspace-tab-menu {
  display: inline-grid;
  width: 28px;
  min-width: 28px;
  height: 100%;
  place-items: center;
  border: 0;
  border-left: 1px solid var(--mar-border-subtle);
  background: var(--mar-bg-page);
  color: var(--mar-text-secondary);
  cursor: pointer;
}

.tab-strip-scroll:hover:not(:disabled),
.workspace-tab-menu:hover {
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}

.tab-strip-scroll:disabled {
  cursor: default;
  opacity: 0.34;
}

.workspace-tab-overflow-actions {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
  position: relative;
  z-index: 1;
}

:global(.workspace-tab-menu-list .el-dropdown-menu__item) {
  display: grid;
  min-width: 220px;
  grid-template-columns: minmax(0, 1fr);
  gap: 1px;
}

:global(.workspace-tab-menu-list .el-dropdown-menu__item > span),
:global(.workspace-tab-menu-list .el-dropdown-menu__item > small) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.workspace-tab-menu-list .el-dropdown-menu__item > small) {
  color: var(--mar-text-faint);
  font-size: var(--mar-font-size-meta);
}

:global(.workspace-tab-menu-list .el-dropdown-menu__item.active) {
  color: var(--mar-color-brand);
}

.workspace-tab {
  position: relative;
  display: flex;
  flex: none;
  align-items: stretch;
  min-height: 27px;
  width: fit-content;
  min-width: 124px;
  max-width: 236px;
  border-radius: var(--mar-radius-selection);
  background: var(--workspace-tab-base-bg);
  touch-action: pan-y;
  user-select: none;
}

.workspace-tab.dragging {
  z-index: 1;
  opacity: 0.55;
}

.workspace-tab.drag-over {
  box-shadow: inset 2px 0 0 var(--mar-color-brand);
}

.workspace-tab.sticky-pinned {
  position: sticky;
  z-index: 2;
}

.workspace-tab.sticky-pinned::before {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--workspace-tab-gap));
  border: var(--workspace-tab-gap) solid var(--workspace-tab-base-bg);
  border-radius: calc(var(--mar-radius-selection) + var(--workspace-tab-gap));
  pointer-events: none;
}

.workspace-tab.sticky-pinned.dragging {
  z-index: 3;
}

.workspace-tab.active {
  background:
    linear-gradient(var(--mar-fill-selection), var(--mar-fill-selection)),
    var(--workspace-tab-base-bg);
}

.workspace-tab-placeholder {
  align-items: center;
  color: var(--mar-text-primary);
  padding: 3px 12px 2px 8px;
}

.workspace-tab > button:first-child {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: var(--mar-text-muted);
  padding: 3px 34px 2px 8px;
  text-align: left;
  cursor: pointer;
}

.workspace-tab:not(.active):hover {
  background: var(--mar-fill-row-hover);
}

.workspace-tab:not(.active) > button:first-child:hover:not(:disabled) {
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}

.workspace-tab-content {
  display: grid;
  min-width: 0;
  gap: 0;
  line-height: normal;
}

.workspace-tab-content > span {
  overflow: hidden;
  font-size: var(--mar-font-size-body);
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-tab.active > button:first-child {
  color: var(--mar-text-primary);
}

.workspace-tab small {
  overflow: hidden;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-tab.active small {
  color: var(--mar-text-secondary);
}

@media (min-width: 768px) {
  .workspace-tab-content > span {
    font-size: calc(var(--mar-font-size-body) - 1px);
  }

  .workspace-tab small {
    font-size: calc(var(--mar-font-size-meta) - 1px);
  }
}

.workspace-tab-meta {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
}

.workspace-tab-node,
.workspace-tab-node-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.direct-available-node {
  display: inline-flex;
  align-items: center;
  gap: 0.1875rem;
}

.workspace-tab-direct-icon {
  flex: none;
  color: var(--mar-text-secondary);
  font-size: inherit;
}

.workspace-tab-unread {
  flex: none;
  border: 1px solid var(--mar-border-subtle);
  border-radius: var(--mar-radius-marker);
  background: transparent;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
  font-weight: 500;
  line-height: 1;
  padding: 1px 3px;
}

@media (min-width: 768px) {
  .workspace-tab-unread {
    font-size: calc(var(--mar-font-size-meta) - 1px);
  }
}

.workspace-tab .tab-close,
.workspace-tab .tab-pin {
  --mar-action-icon-size: 14px;
  position: absolute;
  right: 3px;
  display: inline-grid;
  align-self: center;
  margin: 2px 0;
  place-items: center;
}

@media (max-width: 767px) {
  .workspace-tab-strip,
  .workspace-tabs {
    min-height: 44px;
  }

  .tab-strip-scroll,
  .workspace-tab-overflow-actions {
    display: none;
  }
}

@media (max-width: 767px) {
  .workspace-tab {
    min-height: 43px;
    width: fit-content;
    min-width: 6.5rem;
    max-width: min(68vw, 18rem);
    touch-action: pan-x;
  }
}

@media (max-width: 767px) {
  .workspace-tab > button:first-child {
    min-width: 0;
    padding: 0.35rem calc(0.55rem + var(--mar-utility-control-size)) 0.35rem 0.55rem;
  }
}

@media (max-width: 767px) {
  .workspace-tab-content {
    display: grid;
    gap: 1px;
  }
}

@media (max-width: 767px) {
  .workspace-tab-content > span {
    display: block;
    font-size: var(--mar-font-size-body);
  }
}

@media (max-width: 767px) {
  .workspace-tab small {
    font-size: var(--mar-font-size-meta);
  }
}

@media (max-width: 460px) {
  .workspace-tab > button:first-child {
    min-width: 0;
  }
}
</style>
