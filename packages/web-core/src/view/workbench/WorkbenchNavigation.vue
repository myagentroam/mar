<script setup lang="ts" generic="ManagementSection extends string">
import { MarLink } from '@myagentroam/mar-ui/link';
import {
  MarDropdown,
  MarDropdownItem,
  MarDropdownMenu,
  type MarDropdownInstance
} from '@myagentroam/mar-ui/dropdown';
import { marIcon } from '../../util/mar-icons.js';
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { createMobileSurfaceFocusService } from '../../service/mobile-surface-focus-service.js';
import logoIcon from '../../assets/logo-icon.png';
import { useDocumentationAvailability } from '../../service/documentation-availability.js';
import {
  localizedDocsPath,
  translate,
  localePreferenceService
} from '../../service/locale-preference-service.js';
import type {
  WorkbenchNotificationView,
  WorkbenchNotification
} from '../../service/workbench-notification-service.js';
import type { WorkspaceUploadTask } from '../../service/workspace-upload-service.js';
import type { RecentRun } from '../../service/workbench-notification-service.js';
import MarIcon from '../common/MarIcon.vue';
import WorkbenchActivityCenter from './WorkbenchActivityCenter.vue';
import WebPerformanceIndicator from './WebPerformanceIndicator.vue';
import type { createWebPerformanceDiagnostics } from '../../service/web-performance-diagnostic-service.js';
import WorkspaceTree from '../workspace/WorkspaceTree.vue';
import WorkbenchSidebarPanel from './WorkbenchSidebarPanel.vue';
import PanelResizeHandle from './PanelResizeHandle.vue';
import { WORKBENCH_PANEL_LIMITS } from '../../service/workbench-layout-service.js';
import type { NodeSummary, Workspace, WorkspaceTarget } from '../../model/workbench.js';

import type { SettingsSection } from '../../model/settings.js';
import type { WorkbenchView } from '../../util/workbench-route.js';
import type { MobileUtilityPanel } from '../../service/workbench-navigation-service.js';

const documentationAvailable = useDocumentationAvailability();
const locale = localePreferenceService().locale;
const sidebarPanel = ref<InstanceType<typeof WorkbenchSidebarPanel>>();
const treeElement = computed(() => sidebarPanel.value?.element);
const mobilePanelTarget = ref<HTMLElement>();
// Persisted sidebar widths include the shell inset outside the measured tree.
const sidebarInset = 9;

const props = defineProps<{
  readonly webVersion: string;
  readonly view: WorkbenchView;
  readonly navigationItems: readonly { readonly id: WorkbenchView; readonly label: string }[];
  readonly settingsSection: SettingsSection;
  readonly settingsItems: readonly { readonly id: SettingsSection; readonly label: string }[];
  readonly managementSection: ManagementSection;
  readonly managementItems: readonly { readonly id: ManagementSection; readonly label: string }[];
  readonly sidebarCollapsed: boolean;
  readonly mobileSidebarOpen: boolean;
  readonly sidebarContentVisible: boolean;
  readonly nodes: readonly NodeSummary[];
  readonly workspaceStartupStatus?: 'loading' | 'failed' | 'ready';
  readonly expandedNodeIds: readonly string[];
  readonly workspaceTreeRevealTarget?: WorkspaceTarget | undefined;
  readonly workspaceTarget: WorkspaceTarget | undefined;
  readonly draggingWorkspace: { readonly nodeId: string; readonly workspaceId: string } | undefined;
  readonly loading: boolean;
  readonly canRegisterNode?: boolean;
  readonly nodeLabel: (node: NodeSummary) => string;
  readonly workspaceLabel: (workspace: Workspace) => string;
  readonly workspaces: (nodeId: string) => readonly Workspace[];
  readonly mobileViewport: boolean;
  readonly mobileUtilityPanel?: MobileUtilityPanel | undefined;
  readonly mobileHistoryOpen?: boolean;
  readonly notificationService: WorkbenchNotificationView;
  readonly performanceDiagnostics: ReturnType<typeof createWebPerformanceDiagnostics>;
  readonly uploads: readonly WorkspaceUploadTask[];
  readonly uploadStatusLabel: (task: WorkspaceUploadTask) => string;
}>();

const displayView = ref(props.view);
const displayUtility = ref(props.mobileUtilityPanel);
let scrolledRevealTarget: WorkspaceTarget | undefined;
function claimRevealScroll(target: WorkspaceTarget): boolean {
  if (scrolledRevealTarget === target) return false;
  scrolledRevealTarget = target;
  return true;
}
const scrollPositions = new Map<string, number>();
const displayKey = computed(() => displayUtility.value ?? displayView.value);
const workspaceStartupBlocked = computed(
  () => props.workspaceStartupStatus === 'loading' || props.workspaceStartupStatus === 'failed'
);
const mobileMenuOpen = computed(
  () =>
    props.mobileSidebarOpen &&
    !(
      workspaceStartupBlocked.value &&
      props.view === 'nodes' &&
      props.mobileUtilityPanel === undefined
    )
);
const sidebarVisible = computed(() =>
  props.mobileViewport
    ? mobileMenuOpen.value
    : props.sidebarContentVisible && props.view !== 'conversations'
);
function finishMenuLeave(): void {
  displayView.value = props.view;
  displayUtility.value = props.mobileUtilityPanel;
}
watch(
  [() => props.view, () => props.mobileUtilityPanel, sidebarVisible],
  async ([, , visible], [, , wasVisible]) => {
    const body = treeElement.value;
    if (body && wasVisible) scrollPositions.set(displayKey.value, body.scrollTop);
    if (props.mobileViewport && !visible) return;
    displayView.value = props.view;
    displayUtility.value = props.mobileUtilityPanel;
    if (!visible) return;
    await nextTick();
    if (treeElement.value) treeElement.value.scrollTop = scrollPositions.get(displayKey.value) ?? 0;
  }
);

const emit = defineEmits<{
  resizeSidebar: [width: number];
  moveNode: [nodeId: string, targetIndex: number];
  moveWorkspace: [nodeId: string, workspaceId: string, direction: -1 | 1];
  selectNavigation: [view: WorkbenchView];
  selectMobileUtilityPanel: [panel: MobileUtilityPanel | undefined];
  closeMobileSidebar: [];
  selectSettings: [section: SettingsSection];
  selectManagement: [section: ManagementSection];
  toggleNode: [nodeId: string];
  refreshNodeWorkspaces: [nodeId: string];
  refreshWorkspaceTree: [];
  registerNode: [];
  addWorkspace: [nodeId: string];
  openNodeDetails: [node: NodeSummary];
  openWorkspace: [nodeId: string, workspaceId: string];
  startWorkspaceDrag: [event: DragEvent, nodeId: string, workspaceId: string];
  endWorkspaceDrag: [];
  reorderWorkspace: [nodeId: string, workspace: Workspace, position: 'before' | 'after'];
  moveWorkspaceToGroup: [nodeId: string, groupName: string | null];
  moveWorkspaceGroup: [nodeId: string, workspace: Workspace, groupName: string | null];
  removeWorkspace: [nodeId: string, workspace: Workspace];
  openWorkspaceDetails: [nodeId: string, workspace: Workspace];
  renameWorkspace: [nodeId: string, workspace: Workspace];
  openNotification: [notification: WorkbenchNotification];
  openRecentRun: [run: RecentRun];
  retryUpload: [task: WorkspaceUploadTask];
  cancelUpload: [task: WorkspaceUploadTask];
  removeUpload: [task: WorkspaceUploadTask];
}>();

function setMobileUtilityPanel(panel: MobileUtilityPanel, open: boolean): void {
  if (open || props.mobileUtilityPanel === panel)
    emit('selectMobileUtilityPanel', open ? panel : undefined);
}

const menuLabel = computed(() =>
  translate(
    displayUtility.value === 'activity'
      ? 'activityCenter.title'
      : displayView.value === 'settings'
        ? 'navigation.settingsCategories'
        : displayView.value === 'management'
          ? 'navigation.managementCategories'
          : 'navigation.nodeWorkspace'
  )
);

const menuFocus = createMobileSurfaceFocusService({
  isOpen: () => props.mobileViewport && mobileMenuOpen.value,
  regions: () => [treeElement.value, document.querySelector<HTMLElement>('.activity-rail')],
  close: () => emit('closeMobileSidebar')
});
onBeforeUnmount(menuFocus.dispose);

const forwardOpenWorkspace = (nodeId: string, workspaceId: string) =>
  emit('openWorkspace', nodeId, workspaceId);
const forwardNodeMove = (nodeId: string, targetIndex: number) =>
  emit('moveNode', nodeId, targetIndex);
const forwardWorkspaceMove = (nodeId: string, workspaceId: string, direction: -1 | 1) =>
  emit('moveWorkspace', nodeId, workspaceId, direction);
const forwardWorkspaceDrag = (event: DragEvent, nodeId: string, workspaceId: string) =>
  emit('startWorkspaceDrag', event, nodeId, workspaceId);
const forwardWorkspaceTarget = (
  nodeId: string,
  workspace: Workspace,
  position: 'before' | 'after'
) => emit('reorderWorkspace', nodeId, workspace, position);
const forwardWorkspaceGroupTarget = (nodeId: string, groupName: string | null) =>
  emit('moveWorkspaceToGroup', nodeId, groupName);
const forwardWorkspaceGroupMove = (
  nodeId: string,
  workspace: Workspace,
  groupName: string | null
) => emit('moveWorkspaceGroup', nodeId, workspace, groupName);
const forwardWorkspaceRemoval = (nodeId: string, workspace: Workspace) =>
  emit('removeWorkspace', nodeId, workspace);
const forwardWorkspaceDetails = (nodeId: string, workspace: Workspace) =>
  emit('openWorkspaceDetails', nodeId, workspace);
const forwardWorkspaceRename = (nodeId: string, workspace: Workspace) =>
  emit('renameWorkspace', nodeId, workspace);
const blankMenu = ref<MarDropdownInstance>();
const blankMenuAnchor = shallowRef<DOMRect>();
const blankMenuReference = { getBoundingClientRect: () => blankMenuAnchor.value ?? new DOMRect() };
const blankMenuVisible = ref(false);
watch(blankMenu, (menu) => {
  if (menu === null || menu === undefined) blankMenuVisible.value = false;
});
function openBlankMenu(event: MouseEvent): void {
  if (
    event.defaultPrevented ||
    (event.target instanceof Element &&
      event.target.closest(
        '.tree-node-row, .workspace-branches li, .workspace-tree-filter, .tree-filter-empty, .tree-foot'
      ))
  ) {
    blankMenu.value?.handleClose();
    return;
  }
  event.preventDefault();
  blankMenuAnchor.value = new DOMRect(event.clientX, event.clientY);
  if (!blankMenuVisible.value) treeElement.value?.focus({ preventScroll: true });
  void nextTick(() => blankMenu.value?.handleOpen());
}
function handleBlankMenuEscape(event: KeyboardEvent): void {
  if (!blankMenuVisible.value) return;
  event.preventDefault();
  event.stopPropagation();
  treeElement.value?.focus({ preventScroll: true });
  blankMenu.value?.handleClose();
}
function runBlankMenuCommand(command: string): void {
  if (command === 'refresh') emit('refreshWorkspaceTree');
  if (command === 'register' && props.canRegisterNode) emit('registerNode');
}
</script>

<template>
  <header class="workbench-brand" data-testid="workbench-brand">
    <a
      v-tooltip="$t('common.productVersion', { version: webVersion })"
      class="brand-home-link"
      href="/"
      :aria-label="$t('navigation.home')"
    >
      <img :src="logoIcon" :alt="$t('common.productName')" />
    </a>
  </header>
  <aside class="activity-rail" :aria-label="$t('navigation.main')">
    <nav :aria-label="$t('navigation.main')">
      <template v-for="item in navigationItems" :key="item.id">
        <button
          v-tooltip="{ content: item.label, placement: mobileViewport ? 'bottom' : 'right' }"
          :class="[
            'nav-menu-button',
            {
              active: view === item.id,
              utility: item.id === 'management' || item.id === 'settings'
            }
          ]"
          :aria-label="item.label"
          :aria-current="view === item.id ? 'page' : undefined"
          :aria-expanded="
            mobileViewport
              ? view === item.id &&
                (item.id === 'conversations'
                  ? mobileHistoryOpen === true
                  : mobileSidebarOpen && mobileUtilityPanel === undefined)
              : undefined
          "
          type="button"
          @click="emit('selectNavigation', item.id)"
        >
          <span class="nav-item-content">
            <MarIcon name="workspace" aria-hidden="true" v-if="item.id === 'nodes'" />
            <MarIcon
              name="conversation"
              aria-hidden="true"
              v-else-if="item.id === 'conversations'"
            />
            <MarIcon name="settings" aria-hidden="true" v-else-if="item.id === 'settings'" />
            <MarIcon name="administration" aria-hidden="true" v-else />
          </span>
        </button>
        <WorkbenchActivityCenter
          v-if="item.id === 'conversations'"
          :service="notificationService"
          :uploads="uploads"
          :status-label="uploadStatusLabel"
          :mobile-mode="mobileViewport"
          :mobile-open="mobileUtilityPanel === 'activity'"
          :mobile-presented="displayUtility === 'activity'"
          :mobile-panel-target="mobilePanelTarget"
          :preview-suppressed="mobileViewport && (mobileSidebarOpen || mobileHistoryOpen)"
          @update:mobile-open="setMobileUtilityPanel('activity', $event)"
          @open-recent-run="emit('openRecentRun', $event)"
          @open-notification="emit('openNotification', $event)"
          @retry-upload="emit('retryUpload', $event)"
          @cancel-upload="emit('cancelUpload', $event)"
          @remove-upload="emit('removeUpload', $event)"
        />
      </template>
      <MarLink
        v-tooltip="$t('navigation.help')"
        v-if="documentationAvailable"
        class="nav-menu-button documentation-link mar-icon-action"
        :href="localizedDocsPath(locale, 'getting-started/overview')"
        underline="never"
        target="_blank"
        rel="noopener noreferrer"
        :aria-label="$t('navigation.help')"
      >
        <span class="nav-item-content">
          <MarIcon class="documentation-icon" aria-hidden="true" name="help" />
        </span>
      </MarLink>
    </nav>
    <div v-if="!mobileViewport" class="activity-rail-footer">
      <WebPerformanceIndicator :diagnostics="performanceDiagnostics" />
    </div>
  </aside>
  <Transition name="mobile-menu-scrim">
    <button
      v-if="mobileViewport && mobileMenuOpen"
      class="sidebar-scrim"
      type="button"
      :aria-label="$t('workbench.closeSidebar')"
      tabindex="-1"
      @click="emit('closeMobileSidebar')"
    />
  </Transition>
  <Transition
    :name="mobileViewport ? 'mobile-menu' : 'desktop-menu'"
    @after-leave="finishMenuLeave"
  >
    <WorkbenchSidebarPanel
      v-show="mobileViewport ? mobileMenuOpen : view !== 'conversations'"
      ref="sidebarPanel"
      :collapsed="sidebarCollapsed"
      class="workspace-tree"
      :class="{ 'mobile-open': mobileMenuOpen }"
      :inert="mobileViewport && !mobileMenuOpen"
      :aria-label="menuLabel"
      tabindex="-1"
      @contextmenu="
        view === 'nodes' &&
        !workspaceStartupBlocked &&
        mobileUtilityPanel === undefined &&
        openBlankMenu($event)
      "
      @keydown.esc="handleBlankMenuEscape"
    >
      <div
        v-show="displayUtility !== undefined"
        ref="mobilePanelTarget"
        class="mobile-menu-content"
      />
      <template v-if="displayUtility === undefined && displayView === 'nodes'">
        <MarDropdown
          v-if="!workspaceStartupBlocked && blankMenuAnchor && sidebarVisible"
          ref="blankMenu"
          virtual-triggering
          :virtual-ref="blankMenuReference"
          trigger="contextmenu"
          placement="bottom-start"
          :offset="2"
          @visible-change="blankMenuVisible = $event"
          @command="runBlankMenuCommand"
        >
          <template #dropdown>
            <MarDropdownMenu :aria-label="menuLabel" @keydown.capture.esc="handleBlankMenuEscape">
              <MarDropdownItem v-if="canRegisterNode" command="register" :icon="marIcon('plus')">{{
                $t('generated.resourceSharingPage.registerNode')
              }}</MarDropdownItem>
              <MarDropdownItem command="refresh" :icon="marIcon('refresh')">{{
                $t('generated.workspaceTree.refreshWorkspaces')
              }}</MarDropdownItem>
            </MarDropdownMenu>
          </template>
        </MarDropdown>
        <WorkspaceTree
          v-if="sidebarContentVisible || mobileViewport"
          :nodes="nodes"
          :startup-status="workspaceStartupStatus"
          :expanded-node-ids="expandedNodeIds"
          :reveal-target="workspaceTreeRevealTarget"
          :claim-reveal-scroll="claimRevealScroll"
          :visible="mobileViewport ? mobileSidebarOpen : !sidebarCollapsed"
          :workspace-target="workspaceTarget"
          :dragging-workspace="draggingWorkspace"
          :mobile-viewport="mobileViewport"
          :loading="loading"
          :node-label="nodeLabel"
          :workspace-label="workspaceLabel"
          :workspaces="workspaces"
          @move-node="forwardNodeMove"
          @move-workspace="forwardWorkspaceMove"
          @toggle-node="emit('toggleNode', $event)"
          @refresh-node-workspaces="emit('refreshNodeWorkspaces', $event)"
          @add-workspace="emit('addWorkspace', $event)"
          @open-node-details="emit('openNodeDetails', $event)"
          @open-workspace="forwardOpenWorkspace"
          @start-workspace-drag="forwardWorkspaceDrag"
          @end-workspace-drag="emit('endWorkspaceDrag')"
          @reorder-workspace="forwardWorkspaceTarget"
          @move-workspace-to-group="forwardWorkspaceGroupTarget"
          @move-workspace-group="forwardWorkspaceGroupMove"
          @remove-workspace="forwardWorkspaceRemoval"
          @open-workspace-details="forwardWorkspaceDetails"
          @rename-workspace="forwardWorkspaceRename"
        />
      </template>
      <template v-else-if="displayUtility === undefined">
        <nav
          v-if="(sidebarContentVisible || mobileViewport) && displayView === 'settings'"
          :key="displayView"
          class="settings-nav"
          :aria-label="$t('navigation.settingsMenu')"
        >
          <button
            v-for="item in settingsItems"
            :key="item.id"
            :class="{ active: settingsSection === item.id }"
            :aria-current="settingsSection === item.id ? 'page' : undefined"
            type="button"
            @click="emit('selectSettings', item.id)"
          >
            {{ item.label }}
          </button>
        </nav>
        <nav
          v-else-if="(sidebarContentVisible || mobileViewport) && displayView === 'management'"
          :key="displayView"
          class="settings-nav"
          :aria-label="$t('navigation.managementMenu')"
        >
          <button
            v-for="item in managementItems"
            :key="item.id"
            :class="{ active: managementSection === item.id }"
            :aria-current="managementSection === item.id ? 'page' : undefined"
            type="button"
            @click="emit('selectManagement', item.id)"
          >
            {{ item.label }}
          </button>
        </nav>
      </template>
    </WorkbenchSidebarPanel>
  </Transition>
  <PanelResizeHandle
    v-if="view === 'nodes' && !sidebarCollapsed && !mobileViewport"
    class="workspace-tree-resize"
    :target="treeElement"
    :label="$t('generated.panelResize.workspaceTree')"
    :min="WORKBENCH_PANEL_LIMITS.sidebar.min - sidebarInset"
    :max="WORKBENCH_PANEL_LIMITS.sidebar.max - sidebarInset"
    :direction="1"
    @resize="emit('resizeSidebar', $event + sidebarInset)"
  />
</template>

<style scoped>
.activity-rail {
  --mar-activity-rail-gap: 0.25rem;
  --mar-activity-rail-icon-size: 1.25rem;
  position: fixed;
  z-index: 4;
  inset: var(--mar-sidebar-header-height) auto 0 0;
  display: flex;
  width: var(--mar-activity-rail-width);
  flex-direction: column;
  align-items: center;
  gap: var(--mar-activity-rail-gap);
  background: var(--mar-bg-chrome);
}

.workbench-brand {
  position: fixed;
  z-index: 5;
  display: flex;
  height: var(--mar-sidebar-header-height);
  align-items: center;
  background: var(--mar-bg-chrome);
}

.brand-home-link {
  display: block;
  flex: 0 0 auto;
  border-radius: 5px;
}

.brand-home-link:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: 2px;
}

.workbench-brand img {
  display: block;
  width: var(--mar-brand-logo-size);
  height: var(--mar-brand-logo-size);
  flex: 0 0 auto;
  object-fit: contain;
}

.activity-rail nav {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  width: 100%;
  gap: var(--mar-activity-rail-gap);
  padding: 0.5rem 0 0;
}

.activity-rail-footer {
  flex: none;
  width: 100%;
  padding-bottom: 8px;
}

.activity-rail :deep(button.nav-menu-button) {
  box-sizing: border-box;
  display: grid;
  min-height: var(--mar-rail-item-height);
  min-width: 0;
  width: calc(100% - 4px);
  place-items: center;
  gap: 2px;
  border: 0;
  border-radius: var(--mar-radius-selection);
  background: transparent;
  color: var(--mar-text-secondary);
  margin: 0 2px;
  padding: 3px 0;
  cursor: pointer;
}

.documentation-link {
  position: fixed;
  z-index: 7;
  top: calc((var(--mar-workbench-header-height) - var(--mar-utility-control-size)) / 2);
  right: 8px;
  display: grid;
  width: var(--mar-utility-control-size);
  height: var(--mar-utility-control-size);
  place-items: center;
  box-sizing: border-box;
  --mar-ui-link-text-color: var(--mar-text-secondary);
  --mar-ui-link-hover-text-color: var(--mar-text-primary);
  padding: 2px;
  cursor: pointer;
  font-size: var(--mar-font-size-meta);
  text-decoration: none;
}

.activity-rail :deep(button.nav-menu-button:hover:not(:disabled, [aria-current='page'])) {
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}

.documentation-icon {
  display: inline-flex;
  width: 22px;
  height: 22px;
  font-size: 22px;
}

.activity-rail nav button.active:not(:disabled) {
  background: var(--mar-fill-selection);
  color: var(--mar-color-brand-text);
}

.activity-rail :deep(button.nav-menu-button:focus-visible) {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: -2px;
}

.nav-item-content {
  display: grid;
  place-items: center;
  gap: 2px;
}

.activity-rail nav button .nav-item-content {
  width: 100%;
}

.activity-rail :deep(button.nav-menu-button .mar-icon) {
  font-size: var(--mar-activity-rail-icon-size);
}

.rail-label {
  width: 100%;
  white-space: nowrap;
  text-align: center;
  font-size: var(--mar-font-size-meta);
  line-height: 1.1;
}

.workspace-tree {
  overflow: auto;
  overscroll-behavior: contain;
  background: var(--mar-bg-panel);
}

.mobile-menu-content {
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
}
.workspace-tree:focus {
  outline: none;
}

@media (min-width: 768px) {
  .activity-rail nav {
    align-self: flex-start;
    width: calc(100% + 20px);
    padding-right: 20px;
    pointer-events: none;
  }

  .activity-rail nav > * {
    pointer-events: auto;
  }

  .documentation-icon {
    width: 16px;
    height: 16px;
    font-size: 16px;
  }

  .console-shell:has(.workspace-tree-resize.dragging) .workspace-tree {
    transition: none;
  }

  .activity-rail nav .nav-menu-button.utility {
    margin-top: auto;
  }

  .activity-rail nav .nav-menu-button.utility ~ .nav-menu-button.utility {
    margin-top: 0;
  }

  .activity-rail nav .nav-menu-button {
    flex-shrink: 0;
  }

  .activity-rail {
    --mar-rail-item-height: calc(var(--mar-activity-rail-width) - 8px);
    box-sizing: border-box;
    width: calc(var(--mar-activity-rail-width) + 9px);
    padding-inline: calc((9px + 4px) / 2);
    border-right: 0;
    background: transparent;
  }

  .workbench-brand {
    inset: 8px auto auto 0;
    width: calc(var(--mar-activity-rail-width) + 9px);
    justify-content: center;
    border-right: 0;
    border-bottom: 0;
    background: transparent;
    padding: 0;
  }

  .documentation-link {
    top: calc(9px + (var(--mar-workbench-header-height) - var(--mar-utility-control-size)) / 2);
    right: 16px;
  }
}

.workspace-tree-resize {
  position: fixed;
  top: 9px;
  bottom: 9px;
  left: calc(var(--mar-workbench-sidebar-total-width) - 4px);
}

.workspace-tree.collapsed {
  width: 0;
  overflow: hidden;
  border-right: 0;
}

.settings-nav {
  display: grid;
  gap: 3px;
  padding: 8px 0;
}

.settings-nav button {
  min-height: var(--mar-settings-row-height);
  width: 100%;
  border: 0;
  border-radius: var(--mar-radius-control);
  background: transparent;
  color: var(--mar-text-secondary);
  width: calc(100% - 12px);
  margin: 0 6px;
  padding: 7px 10px;
  text-align: left;
  font: inherit;
  font-size: var(--mar-font-size-body);
  line-height: 1.35;
  overflow-wrap: anywhere;
  cursor: pointer;
}

.settings-nav button:hover {
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}

.settings-nav button.active {
  background: var(--mar-fill-selection);
  color: var(--mar-text-primary);
  font-weight: 400;
}

.settings-nav button:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: -2px;
}

@media (max-width: 767px) {
  .workbench-brand {
    position: static;
    width: 100%;
    height: var(--mar-sidebar-header-height);
    flex: 0 0 var(--mar-sidebar-header-height);
    border-top: 0;
    border-bottom: 1px solid var(--mar-border-default);
    border-right: 0;
    padding: 0 12px;
  }
}

@media (max-width: 767px) {
  .activity-rail {
    position: absolute;
    z-index: 12;
    top: 0;
    right: 8px;
    bottom: auto;
    left: calc(12px + var(--mar-brand-logo-size) + 8px);
    width: auto;
    height: var(--mar-sidebar-header-height);
    flex-direction: row;
    border: 0;
    background: transparent;
  }
}

@media (max-width: 767px) {
  .activity-rail nav {
    display: flex;
    flex-direction: row;
    box-sizing: border-box;
    align-items: center;
    min-width: 0;
    width: 100%;
    max-width: 100%;
    height: 100%;
    flex: 1 1 auto;
    padding: 4px 0 5px;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-inline: contain;
    scrollbar-width: none;
    touch-action: pan-x pinch-zoom;
  }

  .activity-rail nav::-webkit-scrollbar {
    display: none;
  }
}

@media (max-width: 767px) {
  .activity-rail nav .nav-menu-button {
    appearance: none;
    box-sizing: border-box;
    display: grid;
    flex: 0 0 auto;
    min-height: 0;
    min-width: 0;
    width: 36px;
    height: 36px;
    place-items: center;
    border: 0;
    border-radius: var(--mar-radius-selection);
    background: transparent;
    color: var(--mar-text-secondary);
    border-left: 0;
    margin: 0 1px;
    padding: 2px 6px;
    font: inherit;
    line-height: normal;
    text-decoration: none;
  }

  .activity-rail nav .nav-menu-button .nav-item-content {
    min-height: 22px;
    grid-template-rows: 22px;
    align-content: center;
    gap: 2px;
  }

  .activity-rail nav .nav-menu-button .mar-icon {
    display: grid;
    width: 22px;
    height: 22px;
    place-items: center;
    font-size: 22px;
    line-height: 22px;
  }

  .activity-rail nav .nav-menu-button .rail-label {
    display: none;
  }

  .documentation-link {
    position: static;
    cursor: pointer;
  }

  .rail-label {
    width: auto;
    overflow-wrap: normal;
    white-space: nowrap;
  }
}

@media (max-width: 767px) {
  .activity-rail nav .documentation-link:hover,
  .activity-rail nav .documentation-link:active,
  .activity-rail nav .documentation-link:focus-visible {
    background: var(--mar-fill-row-hover);
    color: var(--mar-text-primary);
    text-decoration: none;
  }
}

@media (max-width: 767px) {
  .activity-rail nav button.active:not(:disabled) {
    background: var(--mar-fill-selection);
    color: var(--mar-color-brand-text);
  }
}

@media (max-width: 767px) {
  .workspace-tree {
    position: fixed;
    z-index: 8;
    inset: var(--mar-sidebar-header-height) auto 0 0;
    width: min(300px, calc(100vw - 48px));
    max-height: none;
    border-right: 1px solid var(--mar-border-subtle);
    border-bottom: 0;
    box-shadow: 0 8px 24px var(--mar-shadow-medium);
    transform: translateX(0);
    transition: transform var(--mar-motion-duration-collapse) var(--mar-motion-easing-collapse);
  }
}

@media (max-width: 767px) {
  .workspace-tree.collapsed {
    display: block;
    width: min(300px, calc(100vw - 48px));
    max-height: none;
    overflow-y: auto;
    border-right: 1px solid var(--mar-border-subtle);
    transform: translateX(0);
  }
}

@media (max-width: 767px) {
  .workspace-tree.mobile-menu-enter-from,
  .workspace-tree.mobile-menu-leave-to {
    transform: translateX(-100%);
  }
  .sidebar-scrim {
    position: fixed;
    inset: var(--mar-sidebar-header-height) 0 0;
    z-index: 7;
    border: 0;
    padding: 0;
    background: var(--mar-overlay-scrim);
    transition: opacity var(--mar-motion-duration-collapse) var(--mar-motion-easing-collapse);
  }
  .mobile-menu-scrim-enter-from,
  .mobile-menu-scrim-leave-to {
    opacity: 0;
  }
}
</style>

<style scoped>
@media (prefers-reduced-motion: reduce) {
  .workspace-tree,
  .sidebar-scrim {
    transition: none;
  }
}

@media (prefers-reduced-motion: no-preference) {
  .mobile-menu-content > :deep(*),
  .workspace-tree.mobile-open .settings-nav {
    animation: mobile-menu-content-in var(--mar-motion-duration-collapse)
      var(--mar-motion-easing-collapse);
  }
  .activity-rail :deep(button.nav-menu-button) {
    transition:
      background-color var(--mar-motion-duration-collapse) ease,
      color var(--mar-motion-duration-collapse) ease;
  }
}

@keyframes mobile-menu-content-in {
  from {
    opacity: 0.65;
    transform: translateY(2px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>

<style scoped>
:global(.nav-item-content > .mar-icon) {
  font-size: 1rem;
  line-height: 1;
}
</style>
