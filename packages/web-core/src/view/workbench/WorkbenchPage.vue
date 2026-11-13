<script
  setup
  lang="ts"
  generic="ManagementSection extends string, RegistrationContext, NodeRegistrationContext"
>
import LoginPage from '../../view/LoginPage.vue';
import AuthenticationUnavailable from '../../view/AuthenticationUnavailable.vue';
import logoIcon from '../../assets/logo-icon.png';
import QuickOpenDialog from '../../view/workspace/QuickOpenDialog.vue';
import WorkbenchNavigation from '../../view/workbench/WorkbenchNavigation.vue';
import PasswordGate from '../../view/PasswordGate.vue';
import ImagePreviewDialogs from '../../view/conversation/ImagePreviewDialogs.vue';
import type { WorkbenchShellView, WorkbenchSurfaceView } from '../workbench-contract.js';
import FilePreviewLoading from '../workspace/FilePreviewLoading.vue';
import BusyIndicator from '../common/BusyIndicator.vue';
import WorkbenchSurface from './WorkbenchSurface.vue';
import { useI18n } from 'vue-i18n';

import { computed, ref } from 'vue';
import NodeDetailsDialogs from '../settings/NodeDetailsDialogs.vue';
import type { NodeDetailsData, WorkspaceDetailsData } from '../../model/node-details.js';
import type { NodeSummary, Workspace } from '../../model/workbench.js';
const props = defineProps<{
  page: WorkbenchShellView<ManagementSection, RegistrationContext, NodeRegistrationContext>;
  surface: WorkbenchSurfaceView<ManagementSection, RegistrationContext, NodeRegistrationContext>;
}>();
const emit = defineEmits<{ openWorkspaceDetails: [nodeId: string, workspace: Workspace] }>();
const { t } = useI18n();
const panelStyle = computed(() => {
  const sidebar = props.page.layout.panelWidths.sidebar;
  const inspector = props.page.layout.panelWidths.compact;
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
  return props.page.resources.nodes.find(
    (candidate) => candidate.id === workspaceDetails.value?.nodeId
  );
}
function workspaceDetailsNodeLabel(): string | undefined {
  const node = workspaceDetailsNode();
  return node === undefined ? undefined : props.page.resources.nodeLabel(node);
}
const nodeDetailsData = computed<NodeDetailsData | undefined>(() => {
  const details = props.page.resources.nodeDetails;
  if (details === undefined) return undefined;
  const node =
    props.page.resources.nodes.find((candidate) => candidate.id === details.id) ?? details;
  return { ...node, label: props.page.resources.nodeLabel(node) };
});
async function refreshNodeDetails(): Promise<void> {
  if (nodeDetailsRefreshing.value || props.page.resources.nodeDetails === undefined) return;
  nodeDetailsRefreshing.value = true;
  try {
    await props.page.resources.refreshNodes();
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
      'console-shell--gate':
        !page.identity.adminLoaded || !page.identity.admin.authenticated || page.identity.locked
    }"
  >
    <div
      v-if="!page.identity.adminLoaded"
      class="mar-page-loading-state"
      role="status"
      aria-busy="true"
      :aria-label="t('common.loading')"
    >
      <BusyIndicator />
    </div>
    <AuthenticationUnavailable
      v-else-if="page.identity.authenticationUnknown"
      :loading="page.identity.authenticationRestoring"
      :logo-url="logoIcon"
      @retry="page.identity.refreshAdmin"
    />
    <LoginPage
      v-else-if="!page.identity.admin.authenticated"
      :loading="page.identity.loading"
      :logo-url="logoIcon"
      @login="page.identity.login"
    >
      <template #identity-extension><slot name="identity-extension" /></template>
    </LoginPage>

    <PasswordGate
      v-else-if="page.identity.locked"
      v-model:password="page.identity.newPassword"
      :validation-error="page.identity.passwordValidationError"
      :loading="page.identity.loading"
      @clear-error="page.identity.passwordValidationError = ''"
      @submit="page.identity.changePassword"
    />

    <template v-else>
      <input
        :ref="
          (element) => (page.uploads.workspaceUploadRecoveryInput = element as HTMLInputElement)
        "
        class="workspace-upload-input"
        type="file"
        :aria-label="t('workbench.recoverUpload')"
        @change="page.uploads.recoverWorkspaceUpload"
      />
      <WorkbenchNavigation
        :aria-hidden="page.files.standaloneFileMode || undefined"
        :inert="page.files.standaloneFileMode"
        :web-version="page.application.webVersion"
        :view="page.application.view"
        :navigation-items="page.application.navigationItems"
        :settings-section="page.application.settingsSection"
        :settings-items="page.application.settingsItems"
        :management-section="page.application.managementSection"
        :management-items="page.application.managementItems"
        :sidebar-collapsed="page.layout.sidebarCollapsed"
        :mobile-sidebar-open="page.layout.mobileSidebarOpen"
        :sidebar-content-visible="page.layout.sidebarContentVisible"
        :nodes="page.tree.orderedNodes"
        :mobile-viewport="page.layout.mobileViewport"
        :mobile-utility-panel="page.layout.mobileUtilityPanel"
        :mobile-history-open="page.hosted.hostedConversationMobileHistoryOpen"
        :expanded-node-ids="page.tree.expandedNodeIds"
        :workspace-tree-reveal-target="page.tree.workspaceTreeRevealTarget"
        :workspace-target="page.selection.workspaceTarget"
        :dragging-workspace="page.tree.draggingWorkspace"
        :loading="page.identity.loading"
        :notification-service="page.notifications"
        :performance-diagnostics="page.application.webPerformanceDiagnostics"
        :uploads="page.uploads.workspaceUploadTasks"
        :upload-status-label="page.uploads.workspaceUploadStatusLabel"
        :node-label="page.resources.nodeLabel"
        :workspace-label="page.selection.workspaceTabLabel"
        :workspaces="page.tree.orderedWorkspaces"
        @resize-sidebar="page.layout.setPanelWidth('sidebar', $event)"
        @select-navigation="page.application.selectNavigation"
        @select-mobile-utility-panel="page.layout.selectMobileUtilityPanel"
        @close-mobile-sidebar="page.layout.closeMobileSidebar"
        @select-settings="page.application.selectSettingsSection"
        @select-management="page.application.selectManagementSection"
        @move-node="page.tree.moveNode"
        @move-workspace="page.tree.moveTreeWorkspace"
        @toggle-node="page.tree.toggleNodeExpansion"
        @refresh-node-workspaces="page.tree.refreshNodeWorkspaces"
        @refresh-workspace-tree="page.tree.refreshWorkspaceTree"
        @add-workspace="page.tree.addWorkspaceForNode"
        @open-node-details="page.resources.showNodeDetails"
        @open-workspace="page.tree.openWorkspaceFromTree"
        @start-workspace-drag="page.tree.startWorkspaceDrag"
        @end-workspace-drag="page.tree.endWorkspaceDrag"
        @reorder-workspace="page.tree.reorderWorkspace"
        @move-workspace-to-group="page.tree.moveWorkspaceToGroup"
        @move-workspace-group="page.tree.moveWorkspaceGroup"
        @remove-workspace="page.tree.removeWorkspace"
        @open-workspace-details="openWorkspaceDetails"
        @rename-workspace="page.tree.renameWorkspace"
        @open-notification="page.application.openWorkbenchNotification"
        @open-recent-run="page.application.openRecentRun"
        @open-session-target="page.selection.openSessionGroupTarget"
        @retry-upload="page.uploads.retryWorkspaceUpload"
        @cancel-upload="page.uploads.cancelWorkspaceUpload"
        @remove-upload="page.uploads.deleteWorkspaceUpload"
      />
      <Transition name="workspace-scrim">
        <button
          v-if="page.layout.mobileViewport && page.layout.mobileWorkspaceSurface !== 'conversation'"
          class="workspace-surface-scrim"
          :aria-label="t('workbench.closeWorkspaceTools')"
          type="button"
          @click="page.layout.closeMobileWorkspaceSurface"
        ></button>
      </Transition>
      <slot name="surface">
        <WorkbenchSurface
          :page="surface"
          :aria-hidden="page.files.standaloneFileMode || undefined"
          :inert="page.files.standaloneFileMode"
        />
      </slot>
      <div
        v-if="
          page.files.standaloneFileMode &&
          (page.files.standaloneFileLoading || page.files.standaloneFileError)
        "
        class="standalone-file-loading"
        :aria-busy="page.files.standaloneFileLoading"
        aria-live="polite"
      >
        <template v-if="page.files.standaloneFileError">
          <p>{{ t('generated.standaloneFilePreviewPage.unableToReadTheFileCheckYour') }}</p>
          <el-button @click="closeStandaloneFileWindow">
            {{ t('generated.filePreviewDialog.closePreview') }}
          </el-button>
        </template>
        <FilePreviewLoading v-else variant="page" />
      </div>
      <slot name="resource-details">
        <NodeDetailsDialogs
          v-model:node-open="page.resources.nodeDetailsDialogOpen"
          v-model:workspace-open="workspaceDetailsOpen"
          v-model:usage-open="page.resources.runnerUsageDialogOpen"
          :node="nodeDetailsData"
          :workspace="workspaceDetailsData"
          :workspace-node-id="workspaceDetailsNode()?.id"
          :workspace-node-connected="workspaceDetailsNode()?.connected"
          :workspace-git-manageable="workspaceDetails?.workspace.manageable"
          :workspace-secret-manageable="workspaceDetails?.workspace.manageable"
          :workspace-node-label="workspaceDetailsNodeLabel()"
          :usage="page.resources.runnerUsageDetails"
          :usage-loading="page.resources.runnerUsageLoading"
          :usage-disabled-reason="page.resources.runnerUsageDisabledReason"
          :node-refreshable="page.resources.nodeDetails !== undefined"
          :node-refreshing="nodeDetailsRefreshing"
          :secret-writable="true"
          :request="page.identity.request"
          @refresh-node="refreshNodeDetails"
          @usage="page.resources.showRunnerUsage"
        />
      </slot>
    </template>
    <ImagePreviewDialogs
      v-model:attachment-open="page.interactions.attachmentPreviewOpen"
      v-model:conversation-open="page.interactions.conversationImagePreviewOpen"
      :attachment="page.interactions.attachmentPreview"
      :conversation="page.interactions.conversationImagePreview"
      @clear-attachment="page.interactions.attachmentPreview = undefined"
      @clear-conversation="page.interactions.conversationImagePreview = undefined"
      @conversation-error="page.interactions.handleConversationImagePreviewError"
    />
    <QuickOpenDialog
      :open="page.interactions.quickOpenFileVisible"
      :node-id="page.selection.workspaceTarget?.nodeId"
      :workspace-id="page.selection.workspaceTarget?.workspaceId"
      :files-ready="page.files.filesReady"
      :symbols-ready="page.application.codeNavigationReady"
      :nodes="page.resources.nodes"
      :sessions="page.sessionList.sessions"
      :session-title="page.sessionList.sessionTitle"
      :open-session="page.selection.openSessionFromList"
      :open-workspace="page.interactions.openQuickWorkspace"
      :workspace-tabs="page.selection.workspaceTabs"
      @close="page.interactions.closeQuickOpenFile"
      @open-file="page.interactions.openQuickWorkspaceFile"
    />
    <p class="sr-only" data-testid="web-health">{{ t('common.webReady') }}</p>
  </main>
</template>

<style scoped>
.console-shell {
  --mar-sidebar-available-width: max(
    220px,
    calc(
      100vw - var(--mar-activity-rail-width) - var(--mar-session-sidebar-width) - 360px -
        var(--mar-inspector-min-width)
    )
  );
}

@media (max-width: 1180px) {
  .console-shell {
    --mar-sidebar-available-width: max(
      220px,
      calc(100vw - var(--mar-activity-rail-width) - 242px - 340px)
    );
  }
}

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
    inset: var(--mar-sidebar-header-height) 0 0;
    border: 0;
    background: var(--mar-overlay-scrim);
    cursor: pointer;
  }

  .workspace-surface-scrim {
    position: fixed;
    z-index: 11;
    inset: var(--mar-sidebar-header-height) 0 0;
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
