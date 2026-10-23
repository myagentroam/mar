<script setup lang="ts" generic="ManagementSection extends string">
import { marIcon } from '../../util/mar-icons.js';
import { nextTick, ref } from 'vue';
import logoIcon from '../../assets/logo-icon.png';
import { useDocumentationAvailability } from '../../service/DocumentationAvailability.js';
import {
  localizedDocsPath,
  localePreferenceService
} from '../../service/LocalePreferenceService.js';
import type {
  WorkbenchNotificationService,
  WorkbenchNotification
} from '../../service/WorkbenchNotificationService.js';
import type { WorkspaceUploadTask } from '../../service/WorkspaceUploadService.js';
import type { RecentRun } from '../../service/WorkbenchNotificationService.js';
import MarIcon from '../common/MarIcon.vue';
import WorkbenchNotificationCenter from './WorkbenchNotificationCenter.vue';
import WorkbenchRecentSessions from './WorkbenchRecentSessions.vue';
import WebPerformanceIndicator from './WebPerformanceIndicator.vue';
import type { createWebPerformanceDiagnostics } from '../../service/WebPerformanceDiagnosticService.js';
import WorkspaceTree from '../workspace/WorkspaceTree.vue';
import PanelResizeHandle from './PanelResizeHandle.vue';
import { WORKBENCH_PANEL_LIMITS } from '../../service/WorkbenchLayoutService.js';
import type { NodeSummary, Workspace, WorkspaceTarget } from '../../model/workbench.js';

import type { SettingsSection } from '../../model/settings.js';
import type { WorkbenchView } from '../../util/workbench-route.js';

const documentationAvailable = useDocumentationAvailability();
const locale = localePreferenceService().locale;
const treeElement = ref<HTMLElement>();

defineProps<{
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
  readonly expandedNodeIds: readonly string[];
  readonly workspaceTarget: WorkspaceTarget | undefined;
  readonly draggingWorkspace: { readonly nodeId: string; readonly workspaceId: string } | undefined;
  readonly loading: boolean;
  readonly nodeLabel: (node: NodeSummary) => string;
  readonly workspaceLabel: (workspace: Workspace) => string;
  readonly workspaces: (nodeId: string) => readonly Workspace[];
  readonly mobileViewport: boolean;
  readonly notificationService: WorkbenchNotificationService;
  readonly performanceDiagnostics: ReturnType<typeof createWebPerformanceDiagnostics>;
  readonly uploads: readonly WorkspaceUploadTask[];
  readonly uploadStatusLabel: (task: WorkspaceUploadTask) => string;
}>();

const emit = defineEmits<{
  resizeSidebar: [width: number];
  moveNode: [nodeId: string, targetIndex: number];
  moveWorkspace: [nodeId: string, workspaceId: string, direction: -1 | 1];
  selectNavigation: [view: WorkbenchView];
  selectSettings: [section: SettingsSection];
  selectManagement: [section: ManagementSection];
  toggleNode: [nodeId: string];
  refreshNodeWorkspaces: [nodeId: string];
  refreshWorkspaceTree: [];
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
const blankMenuButton = ref<HTMLButtonElement>();
const blankMenuPosition = ref({ left: 0, top: 0 });
function openBlankMenu(event: MouseEvent): void {
  if (
    event.target instanceof Element &&
    event.target.closest(
      '.tree-node-row, .workspace-branches li, .workspace-tree-filter, .tree-filter-empty, .tree-foot'
    )
  )
    return;
  event.preventDefault();
  const aside = event.currentTarget;
  if (!(aside instanceof HTMLElement)) return;
  const bounds = aside.getBoundingClientRect();
  blankMenuPosition.value = {
    left: event.clientX - bounds.left,
    top: event.clientY - bounds.top + aside.scrollTop
  };
  void nextTick(() => blankMenuButton.value?.click());
}
</script>

<template>
  <header
    :class="['workbench-brand', { collapsed: sidebarCollapsed }]"
    data-testid="workbench-brand"
  >
    <a
      v-tooltip="$t('common.productVersion', { version: webVersion })"
      class="brand-home-link"
      href="/"
      :aria-label="$t('navigation.home')"
    >
      <img :src="logoIcon" :alt="$t('common.productName')" />
    </a>
    <div class="brand-copy">
      <div class="brand-heading">
        <strong>{{ $t('common.productName') }}</strong>
        <span class="brand-version">{{ webVersion }}</span>
      </div>
      <span>{{ $t('navigation.brandSummary') }}</span>
    </div>
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
        <WorkbenchRecentSessions
          v-if="item.id === 'conversations'"
          :service="notificationService"
          :mobile-mode="mobileViewport"
          @open-recent-run="emit('openRecentRun', $event)"
        />
      </template>
      <el-link
        v-tooltip="$t('navigation.help')"
        v-if="documentationAvailable"
        class="nav-menu-button documentation-link"
        :href="localizedDocsPath(locale, 'getting-started/overview')"
        underline="never"
        target="_blank"
        rel="noopener noreferrer"
        :aria-label="$t('navigation.help')"
      >
        <span class="nav-item-content">
          <MarIcon class="documentation-icon" aria-hidden="true" name="help" />
          <span class="rail-label">{{ $t('navigation.help') }}</span>
        </span>
      </el-link>
      <WorkbenchNotificationCenter
        class="global-notification-center"
        :service="notificationService"
        :uploads="uploads"
        :status-label="uploadStatusLabel"
        :mobile-mode="mobileViewport"
        @open-notification="emit('openNotification', $event)"
        @retry-upload="emit('retryUpload', $event)"
        @cancel-upload="emit('cancelUpload', $event)"
        @remove-upload="emit('removeUpload', $event)"
      />
    </nav>
    <WebPerformanceIndicator v-if="!mobileViewport" :diagnostics="performanceDiagnostics" />
  </aside>
  <aside
    v-if="view === 'nodes'"
    ref="treeElement"
    :class="['workspace-tree', { collapsed: sidebarCollapsed, 'mobile-open': mobileSidebarOpen }]"
    :aria-label="$t('navigation.nodeWorkspace')"
    @contextmenu="openBlankMenu"
  >
    <el-dropdown
      trigger="click"
      class="workspace-tree-blank-menu"
      :style="blankMenuPosition"
      @command="emit('refreshWorkspaceTree')"
    >
      <button ref="blankMenuButton" type="button" tabindex="-1" aria-hidden="true" />
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="refresh" :icon="marIcon('refresh')">{{
            $t('generated.workspaceTree.refreshWorkspaces')
          }}</el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
    <WorkspaceTree
      v-if="sidebarContentVisible"
      :nodes="nodes"
      :expanded-node-ids="expandedNodeIds"
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
  </aside>
  <aside
    v-else-if="view === 'settings' || view === 'management'"
    :class="['workspace-tree', { collapsed: sidebarCollapsed, 'mobile-open': mobileSidebarOpen }]"
    :aria-label="
      view === 'settings'
        ? $t('navigation.settingsCategories')
        : $t('navigation.managementCategories')
    "
  >
    <nav
      v-if="sidebarContentVisible && view === 'settings'"
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
      v-else-if="sidebarContentVisible"
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
  </aside>
  <PanelResizeHandle
    v-if="view === 'nodes' && !sidebarCollapsed && !mobileViewport"
    class="workspace-tree-resize"
    :target="treeElement"
    :label="$t('generated.panelResize.workspaceTree')"
    :min="WORKBENCH_PANEL_LIMITS.sidebar.min"
    :max="WORKBENCH_PANEL_LIMITS.sidebar.max"
    :direction="1"
    @resize="emit('resizeSidebar', $event)"
  />
</template>

<style scoped>
.activity-rail {
  position: fixed;
  z-index: 4;
  inset: var(--sidebar-header-height) auto 0 0;
  display: flex;
  width: var(--mar-activity-rail-width);
  flex-direction: column;
  align-items: center;
  background: var(--mar-bg-chrome);
}

.workbench-brand {
  position: fixed;
  z-index: 5;
  inset: 0 auto auto 0;
  display: flex;
  width: var(--mar-workbench-sidebar-total-width);
  height: var(--sidebar-header-height);
  align-items: center;
  gap: 10px;
  background: var(--mar-bg-chrome);
  padding: 0 18px;
  overflow: hidden;
}

.workbench-brand.collapsed {
  width: var(--mar-activity-rail-width);
  gap: 0;
  overflow: hidden;
  padding: 0 8px;
}

.workbench-brand.collapsed .brand-copy {
  display: none;
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

.brand-copy {
  display: grid;
  min-width: 0;
  gap: 0.25rem;
}

.brand-heading {
  display: flex;
  align-items: baseline;
  gap: 0.3rem;
  line-height: 1.2;
}

.brand-heading strong {
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-title);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.brand-copy .brand-version {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
  font-weight: 400;
  line-height: 1.2;
  letter-spacing: normal;
}

.brand-copy span {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
  line-height: 1.2;
}

.activity-rail nav {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  width: 100%;
  gap: 0.25rem;
  padding: 0.5rem 0 52px;
}

.global-notification-center {
  position: fixed;
  z-index: 30;
  top: calc((var(--mar-workbench-header-height) - var(--mar-utility-control-size)) / 2);
  right: 10px;
}

.activity-rail nav button {
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
  right: 50px;
  display: flex;
  height: var(--mar-utility-control-size);
  align-items: center;
  border-radius: 4px;
  --el-link-text-color: var(--mar-text-secondary);
  --el-link-hover-text-color: var(--mar-color-brand-text);
  padding: 0 8px;
  cursor: pointer;
  font-size: var(--mar-font-size-meta);
  text-decoration: none;
}

.activity-rail nav button:hover:not(:disabled) {
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}

.documentation-icon {
  display: none;
}

.documentation-link .rail-label {
  width: auto;
  overflow-wrap: normal;
  font-size: inherit;
  line-height: inherit;
  white-space: nowrap;
}

.activity-rail nav button.active:not(:disabled) {
  background: var(--mar-fill-selection);
  color: var(--mar-color-brand-text);
}

.activity-rail nav button:focus-visible {
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

.activity-rail nav button .mar-icon {
  font-size: 1.25rem;
}

.rail-label {
  width: 100%;
  white-space: nowrap;
  text-align: center;
  font-size: var(--mar-font-size-meta);
  line-height: 1.1;
}

.workspace-tree {
  position: fixed;
  z-index: 3;
  inset: var(--sidebar-header-height) auto 0 var(--mar-activity-rail-width);
  width: var(--mar-workbench-sidebar-width);
  overflow: auto;
  border-right: 1px solid var(--mar-border-subtle);
  background: var(--mar-bg-panel);
}

@media (min-width: 768px) {
  .workbench-brand {
    transition:
      width var(--mar-motion-duration-collapse) var(--mar-motion-easing-collapse),
      padding var(--mar-motion-duration-collapse) var(--mar-motion-easing-collapse);
  }

  .workspace-tree {
    transition: width var(--mar-motion-duration-collapse) var(--mar-motion-easing-collapse);
  }

  .console-shell:has(.workspace-tree-resize.dragging) .workbench-brand,
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
    border-right: 1px solid var(--mar-border-subtle);
  }

  .workbench-brand {
    border-right: 1px solid var(--mar-border-subtle);
    border-bottom: 1px solid var(--mar-border-subtle);
  }
}

.workspace-tree-resize {
  position: fixed;
  top: 0;
  left: calc(var(--mar-workbench-sidebar-total-width) - 4px);
}

.workspace-tree.collapsed {
  width: 0;
  overflow: hidden;
  border-right: 0;
}

.workspace-tree-blank-menu {
  position: absolute;
  z-index: -1;
  width: 0;
  height: 0;
}

.workspace-tree-blank-menu > button {
  width: 0;
  height: 0;
  padding: 0;
  border: 0;
  opacity: 0;
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
  border-radius: var(--el-border-radius-base);
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
  font-weight: 500;
}

.settings-nav button:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: -2px;
}

@media (max-width: 767px) {
  .workbench-brand {
    position: static;
    width: 100%;
    height: var(--sidebar-header-height);
    flex: 0 0 var(--sidebar-header-height);
    border-top: 0;
    border-bottom: 1px solid var(--mar-border-default);
    border-right: 0;
    padding: 0 12px;
  }
}

@media (max-width: 767px) {
  .workbench-brand.collapsed {
    width: 100%;
    gap: 0;
    padding: 0 12px;
  }
}

@media (max-width: 767px) {
  .brand-copy {
    display: none;
  }
}

@media (max-width: 767px) {
  .activity-rail {
    position: absolute;
    z-index: 12;
    top: 0;
    right: 52px;
    bottom: auto;
    left: calc(12px + var(--mar-brand-logo-size) + 8px);
    width: auto;
    height: var(--sidebar-header-height);
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
  .global-notification-center {
    position: fixed;
    z-index: 30;
    top: 0;
    right: 0;
    display: block;
    height: var(--sidebar-header-height);
    flex: 0 0 var(--sidebar-header-height);
    margin-left: 0;
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
    min-height: 18px;
    grid-template-rows: 18px;
    align-content: center;
    gap: 2px;
  }

  .activity-rail nav .nav-menu-button .mar-icon {
    display: grid;
    width: 18px;
    height: 18px;
    place-items: center;
    font-size: 1.125rem;
    line-height: 18px;
  }

  .activity-rail nav .nav-menu-button .rail-label {
    display: none;
  }

  .documentation-link {
    position: static;
    cursor: pointer;
  }

  .documentation-link .nav-item-content {
    display: grid;
  }

  .documentation-icon {
    display: inline-flex;
  }

  .rail-label {
    width: auto;
    overflow-wrap: normal;
    white-space: nowrap;
  }
}

@media (max-width: 767px) {
  .documentation-link:hover,
  .documentation-link:focus-visible {
    background: var(--mar-color-brand-subtle);
    color: var(--mar-color-brand-text);
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
    inset: var(--sidebar-header-height) auto 0 0;
    width: min(300px, calc(100vw - 48px));
    max-height: none;
    border-right: 1px solid var(--mar-border-strong);
    border-bottom: 0;
    box-shadow: 0 8px 24px var(--mar-shadow-medium);
    transform: translateX(-100%);
    transition: transform 0.16s ease;
  }
}

@media (max-width: 767px) {
  .workspace-tree.collapsed {
    display: block;
    width: min(300px, calc(100vw - 48px));
    max-height: none;
    overflow-y: auto;
    border-right: 1px solid var(--mar-border-strong);
    transform: translateX(-100%);
  }
}

@media (max-width: 767px) {
  .workspace-tree.mobile-open {
    transform: translateX(0);
  }
}
</style>

<style scoped>
@media (prefers-reduced-motion: reduce) {
  .workspace-tree,
  .workbench-brand {
    transition: none;
  }
}

@media (prefers-reduced-motion: no-preference) {
  .activity-rail nav button {
    transition:
      background-color var(--mar-motion-duration-collapse) ease,
      color var(--mar-motion-duration-collapse) ease;
  }
}
</style>

<style scoped>
:global(.nav-item-content > .mar-icon) {
  font-size: 1rem;
  line-height: 1;
}
</style>
