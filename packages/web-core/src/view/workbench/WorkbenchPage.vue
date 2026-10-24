<script
  setup
  lang="ts"
  generic="ManagementSection extends string, RegistrationContext, NodeRegistrationContext"
>
import LoginPage from '../../view/LoginPage.vue';
import logoIcon from '../../assets/logo-icon.png';
import QuickOpenDialog from '../../view/workspace/QuickOpenDialog.vue';
import WorkbenchNavigation from '../../view/workbench/WorkbenchNavigation.vue';
import PasswordGate from '../../view/PasswordGate.vue';
import ImagePreviewDialogs from '../../view/conversation/ImagePreviewDialogs.vue';
import type { createWorkbenchPageController } from '../../service/workbench-page-controller.js';
import FilePreviewLoading from '../workspace/FilePreviewLoading.vue';
import BusyIndicator from '../common/BusyIndicator.vue';
import WorkbenchSurface from './WorkbenchSurface.vue';
import { useI18n } from 'vue-i18n';

import { computed, ref, type ShallowUnwrapRef } from 'vue';
import NodeDetailsDialogs from '../settings/NodeDetailsDialogs.vue';
import type { NodeDetailsData, WorkspaceDetailsData } from '../../model/node-details.js';
import type { NodeSummary, Workspace } from '../../model/workbench.js';
const props = defineProps<{
  page: ShallowUnwrapRef<
    ReturnType<
      typeof createWorkbenchPageController<
        ManagementSection,
        RegistrationContext,
        NodeRegistrationContext
      >
    >
  >;
}>();
const emit = defineEmits<{ openWorkspaceDetails: [nodeId: string, workspace: Workspace] }>();
const { t } = useI18n();
const panelStyle = computed(() => {
  const sidebar = props.page.panelWidths.sidebar;
  const inspector = props.page.panelWidths.inspector;
  return {
    ...(sidebar === undefined
      ? {}
      : {
          '--mar-workbench-sidebar-width': `min(${sidebar}px, var(--mar-sidebar-available-width))`,
          '--mar-workbench-sidebar-total-width':
            'calc(var(--mar-activity-rail-width) + var(--mar-workbench-sidebar-width))'
        }),
    ...(inspector === undefined ? {} : { '--mar-inspector-width': `${inspector}px` })
  };
});
const workspaceDetails = ref<{ readonly nodeId: string; readonly workspace: Workspace }>();
const workspaceDetailsOpen = ref(false);
const nodeDetailsRefreshing = ref(false);
function openWorkspaceDetails(nodeId: string, workspace: Workspace): void {
  emit('openWorkspaceDetails', nodeId, workspace);
  workspaceDetails.value = { nodeId, workspace };
  workspaceDetailsOpen.value = true;
}
function workspaceDetailsNode(): NodeSummary | undefined {
  return props.page.nodes.find((candidate) => candidate.id === workspaceDetails.value?.nodeId);
}
function workspaceDetailsNodeLabel(): string | undefined {
  const node = workspaceDetailsNode();
  return node === undefined ? undefined : props.page.nodeLabel(node);
}
const nodeDetailsData = computed<NodeDetailsData | undefined>(() => {
  const details = props.page.nodeDetails;
  if (details === undefined) return undefined;
  const node = props.page.nodes.find((candidate) => candidate.id === details.id) ?? details;
  return { ...node, label: props.page.nodeLabel(node) };
});
async function refreshNodeDetails(): Promise<void> {
  if (nodeDetailsRefreshing.value || props.page.nodeDetails === undefined) return;
  nodeDetailsRefreshing.value = true;
  try {
    await props.page.refreshNodes();
  } finally {
    nodeDetailsRefreshing.value = false;
  }
}
const workspaceDetailsData = computed<WorkspaceDetailsData | undefined>(() => {
  const workspace = workspaceDetails.value?.workspace;
  if (workspace === undefined) return undefined;
  return { ...workspace, label: workspace.displayName || workspace.path };
});
function closeStandaloneFileWindow(): void {
  window.close();
}
</script>
<template>
  <main
    class="console-shell"
    :style="panelStyle"
    :class="{
      'console-shell--gate': !page.adminLoaded || !page.admin.authenticated || page.locked
    }"
  >
    <div
      v-if="!page.adminLoaded"
      class="page-loading-state"
      role="status"
      aria-busy="true"
      :aria-label="t('common.loading')"
    >
      <BusyIndicator />
    </div>
    <LoginPage
      v-else-if="!page.admin.authenticated"
      :loading="page.loading"
      :logo-url="logoIcon"
      @login="page.login"
    >
      <template #identity-extension><slot name="identity-extension" /></template>
    </LoginPage>

    <PasswordGate
      v-else-if="page.locked"
      v-model:password="page.newPassword"
      :validation-error="page.passwordValidationError"
      :loading="page.loading"
      @clear-error="page.passwordValidationError = ''"
      @submit="page.changePassword"
    />

    <template v-else>
      <input
        :ref="(element) => (page.workspaceUploadRecoveryInput = element as HTMLInputElement)"
        class="workspace-upload-input"
        type="file"
        :aria-label="t('workbench.recoverUpload')"
        @change="page.recoverWorkspaceUpload"
      />
      <WorkbenchNavigation
        :aria-hidden="page.standaloneFileMode || undefined"
        :inert="page.standaloneFileMode"
        :web-version="page.webVersion"
        :view="page.view"
        :navigation-items="page.navigationItems"
        :settings-section="page.settingsSection"
        :settings-items="page.settingsItems"
        :management-section="page.managementSection"
        :management-items="page.managementItems"
        :sidebar-collapsed="page.sidebarCollapsed"
        :mobile-sidebar-open="page.mobileSidebarOpen"
        :sidebar-content-visible="page.sidebarContentVisible"
        :nodes="page.orderedNodes"
        :mobile-viewport="page.mobileViewport"
        :mobile-utility-panel="page.mobileUtilityPanel"
        :mobile-history-open="page.hostedConversationMobileHistoryOpen"
        :expanded-node-ids="page.expandedNodeIds"
        :workspace-target="page.workspaceTarget"
        :dragging-workspace="page.draggingWorkspace"
        :loading="page.loading"
        :notification-service="page.workbenchNotificationService"
        :performance-diagnostics="page.webPerformanceDiagnostics"
        :uploads="page.workspaceUploadTasks"
        :upload-status-label="page.workspaceUploadStatusLabel"
        :node-label="page.nodeLabel"
        :workspace-label="page.workspaceTabLabel"
        :workspaces="page.orderedWorkspaces"
        @resize-sidebar="page.setPanelWidth('sidebar', $event)"
        @select-navigation="page.selectNavigation"
        @select-mobile-utility-panel="page.selectMobileUtilityPanel"
        @close-mobile-sidebar="page.closeMobileSidebar"
        @select-settings="page.selectSettingsSection"
        @select-management="page.selectManagementSection"
        @move-node="page.moveNode"
        @move-workspace="page.workspaceTreeService.moveWorkspace"
        @toggle-node="page.toggleNodeExpansion"
        @refresh-node-workspaces="page.refreshNodeWorkspaces"
        @refresh-workspace-tree="page.refreshWorkspaceTree"
        @add-workspace="page.addWorkspaceForNode"
        @open-node-details="page.showNodeDetails"
        @open-workspace="page.openWorkspaceFromTree"
        @start-workspace-drag="page.startWorkspaceDrag"
        @end-workspace-drag="page.workspaceTreeService.endDrag"
        @reorder-workspace="page.reorderWorkspace"
        @move-workspace-to-group="page.moveWorkspaceToGroup"
        @move-workspace-group="page.moveWorkspaceGroup"
        @remove-workspace="page.removeWorkspace"
        @open-workspace-details="openWorkspaceDetails"
        @rename-workspace="page.renameWorkspace"
        @open-notification="page.openWorkbenchNotification"
        @open-recent-run="page.openRecentRun"
        @retry-upload="page.retryWorkspaceUpload"
        @cancel-upload="page.cancelWorkspaceUpload"
        @remove-upload="page.deleteWorkspaceUpload"
      />
      <Transition name="workspace-scrim">
        <button
          v-if="page.mobileViewport && page.mobileWorkspaceSurface !== 'conversation'"
          class="workspace-surface-scrim"
          :aria-label="t('workbench.closeWorkspaceTools')"
          type="button"
          @click="page.closeMobileWorkspaceSurface"
        ></button>
      </Transition>
      <slot name="surface">
        <WorkbenchSurface
          :page="page"
          :aria-hidden="page.standaloneFileMode || undefined"
          :inert="page.standaloneFileMode"
        />
      </slot>
      <div
        v-if="page.standaloneFileMode && (page.standaloneFileLoading || page.standaloneFileError)"
        class="standalone-file-loading"
        :aria-busy="page.standaloneFileLoading"
        aria-live="polite"
      >
        <template v-if="page.standaloneFileError">
          <p>{{ t('generated.standaloneFilePreviewPage.unableToReadTheFileCheckYour') }}</p>
          <el-button @click="closeStandaloneFileWindow">
            {{ t('generated.filePreviewDialog.closePreview') }}
          </el-button>
        </template>
        <FilePreviewLoading v-else variant="page" />
      </div>
      <slot name="resource-details">
        <NodeDetailsDialogs
          v-model:node-open="page.nodeDetailsDialogOpen"
          v-model:workspace-open="workspaceDetailsOpen"
          v-model:usage-open="page.runnerUsageDialogOpen"
          :node="nodeDetailsData"
          :workspace="workspaceDetailsData"
          :workspace-node-id="workspaceDetailsNode()?.id"
          :workspace-node-connected="workspaceDetailsNode()?.connected"
          :workspace-git-manageable="workspaceDetails?.workspace.manageable"
          :workspace-secret-manageable="workspaceDetails?.workspace.manageable"
          :workspace-node-label="workspaceDetailsNodeLabel()"
          :usage="page.runnerUsageDetails"
          :usage-loading="page.runnerUsageLoading"
          :usage-disabled-reason="page.runnerUsageDisabledReason"
          :node-refreshable="page.nodeDetails !== undefined"
          :node-refreshing="nodeDetailsRefreshing"
          :secret-writable="true"
          :request="page.request"
          @refresh-node="refreshNodeDetails"
          @usage="page.showRunnerUsage"
        />
      </slot>
    </template>
    <ImagePreviewDialogs
      v-model:attachment-open="page.attachmentPreviewOpen"
      v-model:conversation-open="page.conversationImagePreviewOpen"
      :attachment="page.attachmentPreview"
      :conversation="page.conversationImagePreview"
      @clear-attachment="page.attachmentPreview = undefined"
      @clear-conversation="page.conversationImagePreview = undefined"
      @conversation-error="page.handleConversationImagePreviewError"
    />
    <QuickOpenDialog
      :open="page.quickOpenFileVisible"
      :node-id="page.workspaceTarget?.nodeId"
      :workspace-id="page.workspaceTarget?.workspaceId"
      :files-ready="page.filesReady"
      :symbols-ready="page.codeNavigationReady"
      :nodes="page.nodes"
      :sessions="page.sessions"
      :session-title="page.sessionTitle"
      :open-session="page.openSessionFromList"
      :open-workspace="page.openQuickWorkspace"
      :workspace-tabs="page.workspaceTabs"
      @close="page.closeQuickOpenFile"
      @open-file="page.openQuickWorkspaceFile"
    />
    <p class="sr-only" data-testid="web-health">{{ t('common.webReady') }}</p>
  </main>
</template>

<style scoped>
.console-shell {
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--mar-bg-page);
}

.console-shell:not(.console-shell--gate) {
  height: 100vh;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}

.console-shell--gate {
  display: grid;
  height: 100vh;
  height: 100dvh;
  place-items: center;
  overflow: auto;
  padding: 1rem;
}

.workspace-upload-input {
  display: none;
}

.standalone-file-loading {
  position: fixed;
  z-index: 49;
  inset: 0;
  display: grid;
  place-items: center;
  background: var(--mar-bg-page);
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  text-align: center;
}

.standalone-file-loading p {
  margin: 0;
}

.sr-only {
  position: absolute;
  overflow: hidden;
  width: 1px;
  height: 1px;
  padding: 0;
  border: 0;
  margin: -1px;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

@media (max-width: 767px) {
  .console-shell:not(.console-shell--gate) {
    position: relative;
    display: flex;
    flex-direction: column;
  }

  .sidebar-scrim {
    position: fixed;
    z-index: 7;
    inset: var(--sidebar-header-height) 0 0;
    border: 0;
    background: var(--mar-overlay-scrim);
    cursor: pointer;
  }

  .workspace-surface-scrim {
    position: fixed;
    z-index: 11;
    inset: var(--sidebar-header-height) 0 0;
    border: 0;
    background: var(--mar-overlay-scrim);
    cursor: pointer;
  }
}
</style>

<style scoped>
.workspace-surface-scrim {
  transition: opacity var(--mar-motion-duration-collapse) var(--mar-motion-easing-collapse);
}
.workspace-scrim-enter-from,
.workspace-scrim-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .workspace-surface-scrim {
    transition: none;
  }
}
</style>
