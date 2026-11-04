<script
  setup
  lang="ts"
  generic="ManagementSection extends string, RegistrationContext, NodeRegistrationContext"
>
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { createMobileSurfaceFocusService } from '../../service/mobile-surface-focus-service.js';
import { marIcon } from '../../util/mar-icons.js';
import MarIcon from '../common/MarIcon.vue';
import LoadingPanel from '../common/LoadingPanel.vue';

import {
  computed,
  defineAsyncComponent,
  h,
  nextTick,
  onBeforeUnmount,
  ref,
  watch,
  type ShallowUnwrapRef
} from 'vue';
import type { Workspace } from '../../model/workbench.js';
import type { createWorkbenchPageController } from '../../service/workbench-page-controller.js';
import { errorMessage, hostedConversationTitle } from '../../util/workbench-presentation.js';
import WorkspaceInspector from '../../view/workspace/WorkspaceInspector.vue';
import WorkspaceSessionList from '../../view/workspace/WorkspaceSessionList.vue';
import BusyIndicator from '../common/BusyIndicator.vue';
import WorkspaceSessionCleanupDialog from '../../view/workspace/WorkspaceSessionCleanupDialog.vue';
import WorkspaceTabs from '../../view/workspace/WorkspaceTabs.vue';
import WorkspaceRegistrationPicker from '../workspace/WorkspaceRegistrationPicker.vue';
import WorkbenchHeader from '../../view/workbench/WorkbenchHeader.vue';
import TerminalDock from '../../view/terminal/TerminalDock.vue';
import HostedConversationWorkspacePage from '../../view/conversation/HostedConversationWorkspacePage.vue';
import { translate } from '../../service/locale-preference-service.js';
import { useManagementComposition } from '../../service/management-composition.js';
import WorkspaceSessionPane from './WorkspaceSessionPane.vue';
import WorkbenchAside from './WorkbenchAside.vue';
import WorkspaceSessionTreePopover from '../workspace/WorkspaceSessionTreePopover.vue';
import type { AsideTool } from '../../service/workbench-aside-service.js';
import { WORKBENCH_PANEL_LIMITS } from '../../service/workbench-layout-service.js';

const loadingComponent = {
  render: () =>
    h(LoadingPanel, { loading: true, variant: 'page', 'aria-label': translate('common.loading') })
};

const SettingsContent = defineAsyncComponent({
  loader: () => import('../settings/SettingsContent.vue'),
  loadingComponent,
  delay: 0
});

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
const managementComposition = useManagementComposition<ManagementSection>();
const managementPage = computed(() =>
  managementComposition.resolve(props.page.managementSection, props.page.admin)
);
const cleanupDialogOpen = ref(false);
const workspaceGrid = ref<HTMLElement>();
const terminalMount = ref<HTMLElement>();
const asideAvailableWidth = ref(0);
watch(
  workspaceGrid,
  (element, _previous, onCleanup) => {
    if (element == null) return;
    const measure = () => {
      const sidebar =
        element.querySelector<HTMLElement>('.conversation-sidebar')?.getBoundingClientRect()
          .width ?? 0;
      asideAvailableWidth.value = Math.max(
        0,
        element.clientWidth - (props.page.mobileViewport ? 0 : sidebar)
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const sidebar = element.querySelector<HTMLElement>('.conversation-sidebar');
    if (sidebar) observer.observe(sidebar);
    measure();
    onCleanup(() => observer.disconnect());
  },
  { flush: 'post' }
);
const asideMode = computed(() => props.page.asideViewMode(props.page.asideState?.active));
const asideWidth = computed(() =>
  props.page.mobileViewport
    ? asideAvailableWidth.value
    : props.page.asideWidth(asideMode.value, asideAvailableWidth.value, 360)
);
const asideStacked = computed(
  () =>
    !props.page.mobileViewport && asideAvailableWidth.value > 0 && asideWidth.value === undefined
);
const treeStatus = computed(() =>
  props.page.workspaceHost?.connected === false
    ? 'failed'
    : props.page.workspaceWatchTopicStatus.sessionNavigation
);
const asideVisible = computed(
  () =>
    props.page.view === 'nodes' &&
    props.page.workspaceTarget !== undefined &&
    props.page.asideState !== undefined &&
    (asideStacked.value || (asideWidth.value !== undefined && asideWidth.value > 0)) &&
    (!props.page.mobileViewport ||
      props.page.mobileWorkspaceSurface === 'inspector' ||
      props.page.mobileWorkspaceSurface === 'terminal')
);
watch(asideVisible, (visible) => props.page.setAsideSurfaceVisible(visible), { immediate: true });
onBeforeUnmount(() => props.page.setAsideSurfaceVisible(false));
const terminalVisible = computed(
  () =>
    asideVisible.value &&
    props.page.asideState?.active?.kind === 'tool' &&
    props.page.asideState.active.id === 'terminal'
);
function openPaneSurface(surface: 'sessions' | 'inspector' | 'terminal'): void {
  if (surface === 'terminal') props.page.toggleAsideTerminal();
  else props.page.openMobileWorkspaceSurface(surface);
}
const asideTools = computed(() => [
  { id: 'files' as const, label: translate('generated.workspaceInspector.files3') },
  { id: 'search' as const, label: translate('generated.workspaceInspector.search') },
  { id: 'changes' as const, label: translate('generated.workspaceInspector.gitChanges') },
  { id: 'history' as const, label: translate('generated.workspaceInspector.gitHistory') },
  { id: 'terminal' as const, label: translate('generated.terminalDock.workspaceTerminal') }
]);
const asideSessions = computed(() =>
  (props.page.asideState?.sessions ?? []).map((sessionId) => {
    const session = props.page.sessionNavigationSnapshot?.sessions.find(
      (item) => item.id === sessionId
    );
    return {
      sessionId,
      title: session?.title ?? sessionId,
      active: session?.activity === 'MANAGED_ACTIVE'
    };
  })
);
function inspectorTool(tool: AsideTool | undefined): Exclude<AsideTool, 'terminal'> | null {
  const active = props.page.asideState?.active;
  return !asideVisible.value || active?.kind !== 'tool' || active.id !== tool || tool === 'terminal'
    ? null
    : tool;
}
const cleanupTarget = ref<{ readonly nodeId: string; readonly workspace: Workspace }>();
const treePopup = ref<{
  nodeId: string;
  workspaceId: string;
  sessionId: string;
  anchor: HTMLElement;
  title: string;
}>();
function closeSessionTree(restoreFocus = false): void {
  const previous = treePopup.value;
  treePopup.value = undefined;
  props.page.setSessionTreeAnchor(undefined);
  if (restoreFocus && previous)
    void nextTick(() => {
      if (previous.anchor.isConnected) previous.anchor.focus();
    });
}
function showSessionTree(sessionId: string, anchor: HTMLElement, title: string): void {
  const target = props.page.workspaceTarget;
  if (!target || !props.page.asideSupported) return;
  if (treePopup.value?.anchor === anchor) {
    closeSessionTree(true);
    return;
  }
  treePopup.value = { ...target, sessionId, anchor, title };
  props.page.setSessionTreeAnchor(sessionId);
}
function openAsideTarget(target: {
  nodeId: string;
  workspaceId: string;
  sessionId: string;
}): boolean {
  const accepted = props.page.openAsideSession(target);
  if (accepted && props.page.mobileViewport) props.page.openMobileWorkspaceSurface('inspector');
  return accepted;
}
function openSessionFromTree(sessionId: string, destination: 'aside' | 'main'): void {
  const popup = treePopup.value;
  const current = props.page.workspaceTarget;
  if (
    !popup ||
    !current ||
    popup.nodeId !== current.nodeId ||
    popup.workspaceId !== current.workspaceId
  )
    return;
  const target = { nodeId: popup.nodeId, workspaceId: popup.workspaceId, sessionId };
  if (destination === 'aside') {
    if (openAsideTarget(target)) closeSessionTree(false);
  } else {
    void props.page.openSessionGroupTarget(target);
    closeSessionTree(false);
  }
}
watch(
  () => [
    props.page.workspaceTarget?.nodeId,
    props.page.workspaceTarget?.workspaceId,
    props.page.view,
    props.page.asideSupported
  ],
  () => {
    const popup = treePopup.value;
    if (
      popup &&
      (props.page.view !== 'nodes' ||
        !props.page.asideSupported ||
        props.page.workspaceTarget?.nodeId !== popup.nodeId ||
        props.page.workspaceTarget.workspaceId !== popup.workspaceId)
    )
      closeSessionTree();
  }
);
onBeforeUnmount(() => {
  if (treePopup.value) closeSessionTree();
});
const hostedConversationHeader = computed(() => {
  const workspace = props.page.hostedConversationWorkspace;
  return (
    workspace.snapshot.value?.conversation ??
    workspace.conversations.value.find(
      (conversation) =>
        conversation.nodeId === workspace.selectedNodeId.value &&
        conversation.id === workspace.selectedConversationId.value
    )
  );
});

function openWorkspaceSessionCleanupDialog(): void {
  const nodeId = props.page.workspaceTarget?.nodeId;
  const workspace = props.page.selectedWorkspace;
  if (nodeId === undefined || workspace === undefined) return;
  cleanupTarget.value = { nodeId, workspace };
  cleanupDialogOpen.value = true;
}

async function cleanupWorkspaceSessions(inactiveDays: number) {
  const target = cleanupTarget.value;
  if (target === undefined) return undefined;
  return props.page.cleanupWorkspaceSessions(target.nodeId, target.workspace, inactiveDays);
}

function updateCleanupDialogOpen(value: boolean): void {
  cleanupDialogOpen.value = value;
  if (!value) cleanupTarget.value = undefined;
}

const mobileToolsFocus = createMobileSurfaceFocusService({
  isOpen: () => props.page.mobileViewport && props.page.mobileWorkspaceSurface !== 'conversation',
  regions: () => [
    document.querySelector<HTMLElement>(
      props.page.mobileWorkspaceSurface === 'sessions'
        ? '.workspace-grid.mobile-surface-sessions .conversation-sidebar'
        : '.workspace-grid .workspace-aside'
    ),
    document.querySelector<HTMLElement>('.activity-rail')
  ],
  close: () => props.page.closeMobileWorkspaceSurface(),
  terminal: () => terminalVisible.value
});
onBeforeUnmount(mobileToolsFocus.dispose);
</script>

<template>
  <section
    :class="[
      'workbench',
      {
        settings: page.view !== 'nodes' && page.view !== 'conversations',
        standalone: page.view === 'conversations',
        compact: page.sidebarCollapsed
      }
    ]"
  >
    <el-dialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="page.workspaceRegistrationNodeId !== undefined"
      :model-value="true"
      :title="translate('generated.workbenchSurface.registerWorkspace')"
      width="min(980px, calc(100vw - 32px))"
      destroy-on-close
      @update:model-value="
        (value: boolean) => {
          if (!value) page.closeWorkspaceRegistration();
        }
      "
      :close-icon="marIcon('close')"
    >
      <slot name="workspace-registration">
        <WorkspaceRegistrationPicker
          v-model="page.openWorkspaceTools"
          v-model:preserve-git-config="page.workspacePreserveGitConfig"
          :directory="page.workspaceDirectory"
          :selected-path="page.workspacePath"
          :pending-directory-name="page.pendingWorkspaceDirectoryName"
          :loading-directory="page.loadingWorkspaceDirectory"
          :loading="page.loading"
          :node-ready="page.workspaceRegistrationReady"
          :selected-path-valid="page.selectedWorkspaceDirectorySelectable"
          @navigate="page.loadWorkspaceDirectories"
          @select="page.selectWorkspaceDirectory"
          @select-pending="page.selectPendingWorkspaceDirectory"
          @discard-pending="page.discardPendingWorkspaceDirectory"
          @register="page.registerWorkspace"
        />
      </slot>
    </el-dialog>
    <WorkbenchHeader
      :mobile-viewport="page.mobileViewport"
      :view="page.view"
      :sidebar-collapsed="page.sidebarCollapsed"
      :settings-section="page.settingsSection"
      :management-section="page.managementSection"
      :settings-items="page.settingsItems"
      :management-items="page.managementItems"
      :conversation-title="
        hostedConversationHeader === undefined
          ? translate('hostedConversations.temporaryTitle')
          : hostedConversationTitle(hostedConversationHeader)
      "
      @toggle-sidebar="page.sidebarCollapsed = !page.sidebarCollapsed"
    >
      <template v-if="page.view === 'nodes' && !page.mobileViewport" #workspace-tabs>
        <WorkspaceTabs
          placement="header"
          :tabs="page.workspaceTabs"
          :active-tab-id="page.activeWorkspaceTabId"
          :empty-label="
            page.workspaceHost === undefined
              ? translate('workspaceTabs.newTab')
              : page.nodeLabel(page.workspaceHost)
          "
          :empty-context="translate('navigation.selectWorkspace')"
          :node-label="page.workspaceTabNodeLabel"
          :direct-available="page.workspaceDirectAvailable"
          :direct-description="page.workspaceDirectDescription"
          :has-active-run="page.workbenchNotificationService.hasActiveWorkspaceRun"
          :has-unread="page.workbenchNotificationService.hasUnreadWorkspace"
          @activate="page.activateWorkspaceTab"
          @close="page.closeWorkspaceTab"
          @reorder="page.workspaceTabService.move"
          @pin="page.workspaceTabService.setPinned"
        />
      </template>
    </WorkbenchHeader>
    <section v-show="page.view === 'nodes'" class="session-layout">
      <section
        v-if="page.view === 'nodes' && page.workspaceTarget === undefined"
        class="welcome-panel compact-welcome"
      >
        <h1>{{ translate('generated.workbenchSurface.selectAWorkspace') }}</h1>
        <p>
          {{ translate('generated.workbenchSurface.selectANodeInTheResourceExplorer') }}
        </p>
        <p class="workspace-selection-hint">
          {{ translate('generated.workbenchSurface.noNodeConnectedYetCreateARegistration') }}
          <el-button link type="primary" @click="page.openNodeRegistration">{{
            translate('generated.workbenchSurface.openNodeManagement')
          }}</el-button>
        </p>
      </section>
      <template v-else-if="page.view === 'nodes' && page.workspaceTarget !== undefined">
        <WorkspaceTabs
          v-if="page.mobileViewport"
          placement="body"
          :tabs="page.workspaceTabs"
          :active-tab-id="page.activeWorkspaceTabId"
          :node-label="page.workspaceTabNodeLabel"
          :direct-available="page.workspaceDirectAvailable"
          :direct-description="page.workspaceDirectDescription"
          :has-active-run="page.workbenchNotificationService.hasActiveWorkspaceRun"
          :has-unread="page.workbenchNotificationService.hasUnreadWorkspace"
          @activate="page.activateWorkspaceTab"
          @close="page.closeWorkspaceTab"
          @reorder="page.workspaceTabService.move"
          @pin="page.workspaceTabService.setPinned"
        />
        <el-alert
          v-if="
            page.workspaceHost?.connected !== false &&
            !page.nodeReady &&
            page.selectedNodeStatus !== undefined
          "
          class="readonly-banner"
          :closable="false"
          show-icon
          :title="
            page.selectedNodeStatus ??
            translate('generated.workbenchSurface.nodeWorkbenchCapabilitiesAreUnavailable')
          "
          type="error"
          ><template #icon><MarIcon name="error" /></template
        ></el-alert>
        <section
          v-if="page.workspaceHost?.connected === false"
          class="workspace-offline-placeholder"
          role="status"
        >
          <div class="workspace-offline-message">
            <MarIcon name="connection-off" class="workspace-offline-icon" aria-hidden="true" />
            <p>{{ translate('generated.workbenchSurface.offlineWorkspace') }}</p>
          </div>
        </section>
        <section
          v-if="
            page.workspaceHost?.connected !== false &&
            page.workspaceTarget !== undefined &&
            page.selectedWorkspace === undefined
          "
          class="welcome-panel compact-welcome workspace-selection-panel workspace-recovery-panel"
        >
          <div
            v-if="page.workspaceSelectionLoading"
            class="page-loading-state"
            role="status"
            :aria-label="translate('common.loading')"
          >
            <BusyIndicator />
          </div>
          <div v-else class="workspace-recovery-state">
            <p role="status">
              {{ translate('generated.workbenchSurface.workspaceMetadataUnavailable') }}
            </p>
            <el-button link size="small" @click="page.retryWorkspaceSelection">
              {{ translate('common.loadFailedRetry') }}
            </el-button>
          </div>
        </section>
        <div
          ref="workspaceGrid"
          v-else-if="page.selectedWorkspace !== undefined"
          v-show="page.workspaceHost?.connected !== false"
          :class="[
            'workspace-grid',
            `mobile-surface-${page.mobileWorkspaceSurface}`,
            { stacked: asideStacked }
          ]"
          :style="{ '--aside-width': `${asideWidth ?? 0}px` }"
        >
          <WorkspaceSessionList
            :aside-supported="page.asideSupported"
            @open-aside="openAsideTarget"
            :session-group="page.workspaceSessionGroup"
            @select-group="page.selectWorkspaceSessionGroup"
            @open-tree="showSessionTree"
            :sessions="page.visibleWorkspaceSessions"
            :selected-session-id="page.selectedSessionId"
            :mobile-viewport="page.mobileViewport"
            :can-load-more="page.canLoadMoreWorkspaceSessions"
            :loading-more="page.loadingMoreWorkspaceSessions"
            :load-more-error="page.loadMoreWorkspaceSessionsError"
            :active="
              (!page.mobileViewport || page.mobileWorkspaceSurface === 'sessions') &&
              page.workspaceHost?.connected !== false
            "
            :watch-status="page.workspaceWatchTopicStatus.sessions"
            :node-ready="page.nodeReady"
            :loading="page.loading"
            :workspace-kind="page.selectedWorkspace?.kind"
            :workspace-kind-label="page.workspaceKindLabel(page.selectedWorkspace)"
            :workspace-branch="page.workspaceBranchLabel(page.selectedWorkspace)"
            :title="page.sessionTitle"
            :runner-icon="page.runnerBrandIcon"
            :activity="page.sessionActivity"
            :can-delete-session="page.canDeleteSession"
            :activity-label="page.sessionActivityLabel"
            :activity-date-time="page.sessionActivityDateTime"
            :activity-title="page.sessionActivityTitle"
            :relative-activity="page.sessionRelativeActivity"
            :node-id="page.workspaceTarget?.nodeId"
            :workspace-id="page.selectedWorkspace.id"
            :skill-supported="true"
            :mcp-supported="true"
            :cleanup-sessions-supported="page.cleanupSessionsEnabled"
            :search-supported="page.workspaceSessionSearchEnabled"
            :search-query="page.workspaceSessionSearchQuery"
            :searching="page.searchingWorkspaceSessions"
            :refreshing="page.refreshingWorkspaceSessions"
            :workspace-manageable="page.selectedWorkspace.manageable !== false"
            :request="page.request"
            :has-unread="
              (sessionId) =>
                page.workbenchNotificationService.hasUnreadSession(
                  page.workspaceTarget?.nodeId!,
                  page.selectedWorkspace!.id,
                  sessionId
                )
            "
            @create="page.openNewSessionComposer"
            @open="page.openSessionFromList"
            @rename="page.renameSession"
            @pin="page.setSessionPinned"
            @move-pin="page.movePinnedSession"
            @move-pin-to="page.movePinnedSessionTo"
            @delete-session="page.deleteSession"
            @cleanup-sessions="openWorkspaceSessionCleanupDialog"
            @load-more="page.loadMoreWorkspaceSessions"
            @search="page.searchWorkspaceSessions"
            @refresh="page.refreshWorkspaceSessions"
          />
          <WorkspaceSessionCleanupDialog
            v-if="cleanupDialogOpen && cleanupTarget !== undefined"
            :model-value="cleanupDialogOpen"
            :cleanup="cleanupWorkspaceSessions"
            @update:model-value="updateCleanupDialogOpen"
          />
          <WorkspaceSessionPane
            :controller="page.mainPaneController"
            :aside-ready="page.asideState?.active !== undefined"
            :tree-supported="page.asideSupported"
            :tree-open-session-id="treePopup?.sessionId"
            :tree-summaries="page.sessionNavigationSnapshot?.summaries"
            :tree-status="treeStatus"
            @open-tree="showSessionTree"
            @open-surface="openPaneSurface"
            @preview-attachment="page.openAttachmentPreview"
            @reload="page.reloadSelectedSession"
          />
          <Transition
            name="workspace-aside"
            :css="
              page.mobileViewport &&
              page.workspaceTarget !== undefined &&
              page.workspaceHost?.connected !== false
            "
          >
            <div
              v-if="page.asideState"
              v-show="asideVisible"
              class="workspace-aside"
              tabindex="-1"
              :aria-hidden="!asideVisible"
            >
              <WorkbenchAside
                :inert="!asideVisible"
                :workspace="page.workspaceTarget!"
                :state="page.asideState"
                :tools="asideTools"
                :sessions="asideSessions"
                :tab-label="translate('generated.workbenchAside.tabs')"
                :close-label="
                  (title) => translate('generated.workbenchAside.close', { value0: title })
                "
                :resize-label="translate('generated.workbenchAside.resize')"
                :width="
                  asideStacked
                    ? asideAvailableWidth
                    : (asideWidth ?? WORKBENCH_PANEL_LIMITS[asideMode].min)
                "
                :mobile="page.mobileViewport"
                :close-surface-label="translate('workbench.closeWorkspaceTools')"
                :min-width="WORKBENCH_PANEL_LIMITS[asideMode].min"
                :max-width="
                  Math.max(
                    WORKBENCH_PANEL_LIMITS[asideMode].min,
                    Math.min(WORKBENCH_PANEL_LIMITS[asideMode].max, asideAvailableWidth - 360)
                  )
                "
                :mode="asideMode"
                @select-tool="page.selectAsideTool"
                @select-session="page.openAsideSession"
                @close-session="page.closeAsideSession"
                @resize="page.setPanelWidth(asideMode, $event)"
                @close-surface="page.closeMobileWorkspaceSurface"
              >
                <template #tool="{ tool }">
                  <WorkspaceInspector
                    :aside-tool="inspectorTool(tool)"
                    :ref="(instance) => (page.workspaceInspector = instance as never)"
                    :node-id="page.workspaceTarget?.nodeId"
                    :workspace-id="page.workspaceTarget?.workspaceId"
                    :workspace-name="
                      page.selectedWorkspace === undefined
                        ? translate('generated.workbenchSurface.workspace')
                        : page.workspaceTabLabel(page.selectedWorkspace)
                    "
                    :workspace-kind="page.selectedWorkspace?.kind"
                    :workspace-path="page.selectedWorkspace?.path"
                    :history-capability="page.nodeManifest?.git?.supportsHistory"
                    :csrf-token="page.csrfToken"
                    :renew-csrf-token="page.renewCsrfToken"
                    :enabled="page.filesReady"
                    :prediction-enabled="page.workPromptCompletion.enabled"
                    :capability-loading="
                      page.nodeManifestLoading && page.nodeManifest === undefined
                    "
                    :node-online="
                      page.workspaceHost?.connected === true && page.workspaceHost.disabled !== true
                    "
                    :mobile-viewport="page.mobileViewport"
                    :content-search-enabled="page.contentSearchReady"
                    :code-navigation-enabled="page.codeNavigationReady"
                    :code-navigation-prewarm-enabled="page.codeNavigationPrewarmReady"
                    :file-write-enabled="page.fileWriteReady"
                    :local-file-manager-enabled="page.workspaceLocalFileManagerAvailable"
                    :files-revision="page.workspaceFilesRevision"
                    :changes-revision="page.workspaceChangesRevision"
                    :subscription-snapshot="page.workspaceWatchSnapshot"
                    :files-watch-status="page.workspaceWatchTopicStatus.files"
                    :changes-watch-status="page.workspaceWatchTopicStatus.changes"
                    :direct-file-download="page.directWorkspaceFileDownload"
                    :direct-file-object-url="page.directWorkspaceFileObjectUrl"
                    :direct-file-read-range="page.directWorkspaceFileReadRange"
                    :direct-git-file-download="page.directGitFileDownload"
                    :direct-git-file-object-url="page.directGitFileObjectUrl"
                    :direct-git-file-read-range="page.directGitFileReadRange"
                    :standalone-file-mode="page.standaloneFileMode"
                    @directory="page.changeWorkspaceWatchDirectory"
                    @retry-watch="page.retryWorkspaceWatch"
                    @branch="
                      (workspaceId, branch) =>
                        page.updateWorkspaceBranch(
                          page.workspaceTarget?.nodeId ?? '',
                          workspaceId,
                          branch
                        )
                    "
                    @workspace="
                      page.updateWorkspaceMetadata(page.workspaceTarget?.nodeId ?? '', $event)
                    "
                    @notice="page.notice"
                    @uploads="page.queueWorkspaceUploads"
                  />
                </template>
                <template #session>
                  <WorkspaceSessionPane
                    :controller="page.asidePaneController"
                    :aside-ready="page.asideState?.active !== undefined"
                    :tree-supported="page.asideSupported"
                    :tree-open-session-id="treePopup?.sessionId"
                    :tree-summaries="page.sessionNavigationSnapshot?.summaries"
                    :tree-status="treeStatus"
                    @open-tree="showSessionTree"
                    @open-surface="openPaneSurface"
                    @preview-attachment="page.openAttachmentPreview"
                    @reload="page.reloadAsideSession"
                  />
                </template>
                <template #terminal>
                  <div ref="terminalMount" class="aside-terminal-mount" />
                </template>
              </WorkbenchAside>
            </div>
          </Transition>
        </div>
      </template>
      <Teleport :to="terminalMount ?? 'body'" :disabled="terminalMount === undefined">
        <div
          v-for="tab in page.workspaceTabs"
          :key="tab.id"
          v-show="terminalVisible && tab.id === page.activeWorkspaceTabId && page.terminalReady"
          tabindex="-1"
          :inert="!terminalVisible"
          class="terminal-dock"
        >
          <TerminalDock
            :error-message="errorMessage"
            embedded
            :ref="
              (instance) => {
                if (instance === null) page.terminalDocks.delete(tab.id);
                else
                  page.terminalDocks.set(
                    tab.id,
                    instance as unknown as {
                      release(): Promise<void>;
                      toggle(): Promise<void>;
                    }
                  );
              }
            "
            :node-id="tab.nodeId"
            :direct="page.terminalDirectClient"
            :workspace-id="tab.workspaceId"
            :csrf-token="page.csrfToken"
            :renew-csrf-token="page.renewCsrfToken"
            :enabled="
              page.view === 'nodes' && tab.id === page.activeWorkspaceTabId && page.terminalReady
            "
            :capability="page.nodeManifest?.terminal"
            :node-os-release="
              page.nodes.find((node) => node.id === tab.nodeId)?.metadata?.osRelease
            "
            :visible="
              page.view === 'nodes' &&
              tab.id === page.activeWorkspaceTabId &&
              page.terminalReady &&
              terminalVisible
            "
            :mobile-mode="page.mobileViewport"
            :active="page.view === 'nodes' && tab.id === page.activeWorkspaceTabId"
            @collapse="page.mobileViewport && page.closeMobileWorkspaceSurface()"
            @notice="page.notice"
          />
        </div>
      </Teleport>
    </section>
    <HostedConversationWorkspacePage
      v-if="page.view === 'conversations'"
      :connected="page.liveConnected"
      :workspace="page.hostedConversationWorkspace"
      :request="page.request"
      :mobile-viewport="page.mobileViewport"
      :mobile-history-open="page.hostedConversationMobileHistoryOpen"
      v-model:mobile-files-open="page.hostedConversationMobileFilesOpen"
      :sidebar-collapsed="page.sidebarCollapsed"
      :select-conversation="page.selectHostedConversation"
      :route-target="page.hostedConversationRoute"
      :restoring-route="page.restoringHostedConversationRoute"
      :clear-conversation="page.clearHostedConversation"
      :has-unread-conversation="page.workbenchNotificationService.hasUnreadConversation"
      @close-mobile-history="page.closeHostedConversationMobileHistory"
    />
    <template v-else-if="page.view === 'settings'">
      <slot name="settings">
        <SettingsContent
          :web-version="page.webVersion"
          :pwa-state="page.pwaState"
          :checking-for-updates="page.checkingForUpdates"
          v-model:new-password="page.newPassword"
          :section="page.settingsSection"
          :sessions="page.adminSessions"
          :password-validation-error="page.passwordValidationError"
          :registration-token="page.registrationToken"
          :loading="page.loading"
          :format-session-time="page.formatSessionTime"
          :request="page.request"
          :quick-prompts="page.quickPrompts"
          :quick-prompts-loading="page.quickPromptsLoading"
          :quick-prompts-failed="page.quickPromptsFailed"
          :refresh-quick-prompts="page.refreshQuickPrompts"
          :system-notifications="page.workbenchNotificationService.systemNotifications"
          @clear-password-error="page.passwordValidationError = ''"
          @refresh-sessions="page.refreshAdminSessions"
          @logout-session="page.logoutAdminSession"
          :change-password="page.changePassword"
          @logout="page.logout"
          @create-registration-token="page.createRegistrationToken"
          @check-for-updates="page.checkForUpdates"
          @apply-web-update="page.applyWebUpdate"
        />
      </slot>
    </template>
    <template v-else-if="page.view === 'management'">
      <slot name="management-notice" />
      <component
        :is="managementPage.component"
        :key="managementPage.id"
        v-bind="managementPage.props(page)"
        @changed="page.refreshNodes"
        @extension-changed="page.refreshAdmin"
      />
    </template>
    <WorkspaceSessionTreePopover
      v-if="treePopup"
      :key="treePopup.sessionId"
      :anchor="treePopup.anchor"
      :session-id="treePopup.sessionId"
      :title="treePopup.title"
      :tree="page.sessionNavigationSnapshot?.tree"
      :status="treeStatus"
      :main-session-id="page.draftSessionOpen ? undefined : page.selectedSessionId"
      :aside-session-ids="page.asideState?.sessions ?? []"
      :active-aside-id="
        page.asideState?.active?.kind === 'session' ? page.asideState.active.sessionId : undefined
      "
      @close="closeSessionTree"
      @open="openSessionFromTree"
      @retry="page.retryWorkspaceWatch"
    />
  </section>
</template>

<style scoped>
.session-layout {
  --workspace-layout-inset: 0px;
  display: flex;
  height: calc(100vh - var(--mar-workbench-header-height));
  min-height: 0;
  flex-direction: column;
  box-sizing: border-box;
  overflow: hidden;
  padding: 0;
}

.welcome-panel {
  display: grid;
  max-width: 560px;
  min-height: 260px;
  align-content: center;
  justify-items: start;
  gap: 0.35rem;
  border: 1px solid var(--mar-border-medium);
  border-radius: 5px;
  background: var(--mar-bg-panel);
  padding: 2rem;
}

.welcome-panel h1 {
  margin: 0;
}

.welcome-panel p {
  max-width: 430px;
  margin-bottom: 0.8rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  line-height: 1.6;
}

.compact-welcome {
  flex: 1 1 auto;
  width: 100%;
  max-width: none;
  min-height: 0;
  margin: 0.45rem 0 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  overflow: auto;
  align-content: start;
  justify-items: stretch;
  padding: 1rem clamp(0.9rem, 1.6vw, 1.25rem);
}

.workspace-selection-panel > h1 {
  font-size: var(--mar-font-size-page-title);
}

.workspace-selection-panel > p {
  max-width: 720px;
  margin-bottom: 0.25rem;
}

.workspace-recovery-panel {
  align-content: center;
  justify-items: center;
  text-align: center;
}

.workspace-recovery-state {
  display: grid;
  justify-items: center;
  gap: 0.5rem;
}

.workspace-recovery-state > p {
  margin: 0;
}

.workspace-selection-hint {
  color: var(--mar-text-tertiary) !important;
  font-size: var(--mar-font-size-meta) !important;
}

.readonly-banner {
  border-radius: 0;
  margin: 0;
  --el-alert-bg-color: var(--mar-color-danger-bg);
  --el-color-error: var(--mar-color-danger-text);
}

.workspace-offline-placeholder {
  display: grid;
  min-height: 0;
  flex: 1 1 auto;
  place-items: center;
  padding: 2rem 1.5rem;
  color: var(--mar-text-secondary);
  text-align: center;
}

.workspace-offline-message {
  display: grid;
  max-width: 28rem;
  justify-items: center;
  gap: 0.5rem;
}

.workspace-offline-icon {
  color: var(--mar-text-muted);
  font-size: 1.75rem;
}

.workspace-offline-message p {
  margin: 0;
  font-size: var(--mar-font-size-meta);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

@media (max-width: 767px) {
  .workspace-offline-icon {
    font-size: 1.5rem;
  }

  .workspace-offline-message p {
    font-size: var(--mar-font-size-body);
  }
}

.workspace-grid {
  display: grid;
  height: 0;
  grid-template-columns: var(--mar-session-sidebar-width) minmax(0, 1fr) var(--aside-width, 0px);
  width: 100%;
  max-width: 100%;
  min-height: 0;
  min-width: 0;
  flex: 1 1 auto;
  border: 0;
  border-bottom: 1px solid var(--mar-border-default);
  border-radius: 0;
  margin-top: 0;
  overflow: hidden;
}

.workspace-aside {
  display: flex;
  min-width: 0;
  min-height: 0;
}
.workspace-aside > :deep(.workbench-aside) {
  flex: 1;
  width: 100% !important;
}

.conversation-panel {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--mar-bg-panel);
}

.inspector-column {
  position: relative;
  border-left: 1px solid var(--mar-border-subtle);
  background: var(--mar-bg-chrome);
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.inspector-column > :deep(.workspace-inspector) {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
}

.inspector-resize {
  left: -4px;
}

.terminal-dock {
  flex: none;
  margin-top: 0;
  border: 0;
  border-radius: 0;
  overflow: hidden;
}

@media (min-width: 768px) {
  .workspace-grid.stacked {
    grid-template-columns: var(--mar-session-sidebar-width) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
  }
  .workspace-grid.stacked > :deep(.conversation-sidebar) {
    grid-column: 1;
    grid-row: 1 / 3;
  }
  .workspace-grid.stacked > :deep(.conversation-panel) {
    grid-column: 2;
    grid-row: 1;
  }
  .workspace-grid.stacked > .workspace-aside {
    grid-column: 2;
    grid-row: 2;
  }
  .workspace-grid.stacked :deep(.workbench-aside-resize) {
    display: none;
  }
}

@media (max-width: 1180px) {
  .inspector-resize {
    display: none;
  }

  .workspace-grid {
    grid-template-columns: min(242px, var(--mar-session-sidebar-width)) minmax(0, 1fr) var(
        --aside-width,
        0px
      );
  }
  .workspace-grid.stacked {
    grid-template-columns: min(242px, var(--mar-session-sidebar-width)) minmax(0, 1fr);
  }
}

@media (max-width: 1180px) {
  .inspector-column {
    grid-column: 1 / -1;
    max-height: 350px;
    border-top: 1px solid var(--mar-border-strong);
    border-left: 0;
  }
}

@media (max-width: 767px) {
  .workspace-grid {
    position: relative;
    height: 0;
    min-height: 0;
    border-bottom: 0;
    grid-template-rows: minmax(0, 1fr);
    grid-template-columns: 1fr;
    flex: 1 1 auto;
    overflow: hidden;
  }
}

@media (max-width: 767px) {
  .session-layout {
    height: auto;
    min-height: 0;
    flex: 1 1 auto;
    overflow: hidden;
  }
}

@media (max-width: 767px) {
  .inspector-column {
    max-height: none;
    background: var(--mar-bg-chrome);
  }
}

@media (max-width: 767px) {
  .workspace-grid.mobile-surface-inspector .inspector-column {
    transform: translateX(0);
    visibility: visible;
    pointer-events: auto;
    transition:
      transform 0.16s ease,
      visibility 0s;
  }
}

@media (max-width: 767px) {
  .conversation-panel {
    grid-area: 1 / 1;
    min-height: 0;
  }
}

@media (max-width: 767px) {
  .terminal-dock {
    display: flex;
    min-height: 0;
    flex-direction: column;
    background: var(--mar-bg-chrome);
  }
}
</style>

<style scoped>
.workbench {
  display: flex;
  height: 100vh;
  min-height: 100vh;
  flex-direction: column;
  margin-left: var(--mar-workbench-sidebar-total-width);
  overflow: hidden;
  background: var(--mar-bg-panel);
}

.workbench.compact {
  margin-left: var(--mar-activity-rail-width);
}

@media (min-width: 768px) and (prefers-reduced-motion: no-preference) {
  .workspace-grid {
    transition: grid-template-columns var(--mar-motion-duration-collapse)
      var(--mar-motion-easing-collapse);
  }
  .workspace-grid:has(.panel-resize-handle:active),
  .workspace-grid:has(.panel-resize-handle.dragging) {
    transition: none;
  }
  .workbench {
    transition: margin-left var(--mar-motion-duration-collapse) var(--mar-motion-easing-collapse);
  }

  .console-shell:has(.workspace-tree-resize.dragging) .workbench {
    transition: none;
  }
}

.workbench.standalone {
  margin-left: var(--mar-workbench-sidebar-total-width);
}

.workbench.standalone.compact {
  margin-left: var(--mar-activity-rail-width);
}

.workbench.settings {
  margin-left: var(--mar-workbench-sidebar-total-width);
}

.workbench.settings.compact {
  margin-left: var(--mar-activity-rail-width);
}

.workbench.settings :deep(.settings-content) {
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
}

.workspace-selection-panel :deep(.workspace-tools) {
  width: 100%;
  max-width: 1080px;
  margin-top: 0.55rem;
}

.workspace-selection-panel :deep(.workspace-tools .el-collapse-item__content) {
  padding-top: 0.35rem;
}

@media (max-width: 767px) {
  .workbench,
  .workbench.compact,
  .workbench.standalone,
  .workbench.standalone.compact,
  .workbench.settings,
  .workbench.settings.compact {
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
    margin-left: 0;
    overflow: hidden;
  }

  .workbench.settings :deep(.settings-content) {
    min-height: 0;
    flex: 1 1 auto;
    overflow: auto;
  }

  .conversation-sidebar,
  .inspector-column {
    position: fixed;
    z-index: 12;
    inset: var(--sidebar-header-height) auto 0 0;
    width: min(300px, calc(100vw - 48px));
    border: 0;
    border-right: 1px solid var(--mar-border-strong);
    box-shadow: 10px 0 24px var(--mar-shadow-medium);
    transform: translateX(-104%);
    visibility: hidden;
    pointer-events: none;
    transition:
      transform 0.16s ease,
      visibility 0.16s step-end;
  }

  .workspace-grid.mobile-surface-sessions .conversation-sidebar {
    transform: translateX(0);
    visibility: visible;
    pointer-events: auto;
    transition:
      transform 0.16s ease,
      visibility 0s;
  }
}

@media (prefers-reduced-motion: reduce) {
  .workbench,
  .terminal-dock {
    transition: none;
  }
}
</style>

<style scoped>
:deep(.aside-terminal-mount),
.terminal-dock {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}
@media (max-width: 767px) {
  .workspace-aside {
    position: fixed;
    z-index: 12;
    inset: var(--sidebar-header-height) 0 0;
    width: 100% !important;
    min-width: 0;
  }
  .workspace-aside :deep(.workbench-aside-resize) {
    display: none;
  }
  .terminal-dock {
    position: relative;
    inset: auto;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    box-shadow: none;
    transform: none;
    visibility: visible;
    pointer-events: auto;
  }
}
@media (max-width: 767px) and (prefers-reduced-motion: no-preference) {
  .workspace-aside-enter-active,
  .workspace-aside-leave-active {
    transition:
      transform var(--mar-motion-duration-collapse) var(--mar-motion-easing-collapse),
      opacity var(--mar-motion-duration-collapse) var(--mar-motion-easing-collapse);
  }
  .workspace-aside-enter-from,
  .workspace-aside-leave-to {
    transform: translateX(0.75rem);
    opacity: 0;
  }
}
:global(.workspace-selection-hint .el-button) {
  vertical-align: baseline;
}
</style>

<style scoped>
@media (prefers-reduced-motion: reduce) {
  .workspace-grid .conversation-sidebar,
  .workspace-grid.mobile-surface-sessions .conversation-sidebar,
  .workspace-grid .inspector-column,
  .workspace-grid.mobile-surface-inspector .inspector-column,
  .terminal-dock {
    transition: none;
  }
}
</style>
