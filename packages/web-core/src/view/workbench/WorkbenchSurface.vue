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
import { errorSummary } from '../../util/error-presentation.js';
import { ApiError } from '../../util/api-error.js';
import MarIcon from '../common/MarIcon.vue';
import LoadingPanel from '../common/LoadingPanel.vue';

import {
  computed,
  defineAsyncComponent,
  h,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch
} from 'vue';
import type { Workspace } from '../../model/workbench.js';
import type { WorkbenchSurfaceView } from '../workbench-contract.js';
import { errorMessage, hostedConversationTitle } from '../../util/workbench-presentation.js';
import WorkspaceFileWorkbench from '../workspace/WorkspaceFileWorkbench.vue';
import WorkspaceGitChanges from '../workspace/WorkspaceGitChanges.vue';
import WorkspaceGitHistory from '../workspace/WorkspaceGitHistory.vue';
import WorkspaceContentSearch from '../workspace/WorkspaceContentSearch.vue';
import WorkspaceFilesPanel from '../workspace/WorkspaceFilesPanel.vue';
import WorkspaceHtmlBrowser from '../workspace/WorkspaceHtmlBrowser.vue';
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
  page: WorkbenchSurfaceView<ManagementSection, RegistrationContext, NodeRegistrationContext>;
}>();
const managementComposition = useManagementComposition<ManagementSection>();
const managementPage = computed(() =>
  managementComposition.resolve(props.page.application.managementSection, props.page.identity.admin)
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
        element.clientWidth - (props.page.layout.mobileViewport ? 0 : sidebar)
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
const asideMode = computed(() =>
  props.page.aside.asideViewMode(props.page.aside.asideState?.active)
);
const workspaceCapabilitiesLoading = computed(
  () => props.page.resources.nodeManifestLoading && props.page.resources.nodeManifest === undefined
);
const workspaceOffline = computed(
  () =>
    props.page.application.networkUnavailable ||
    props.page.resources.workspaceHost?.connected === false
);
const workspaceFilesRestriction = computed(() => {
  const host = props.page.resources.workspaceHost;
  const capability = props.page.resources.nodeManifest?.files;
  if (host?.connected !== true || host.disabled === true || capability?.available !== false)
    return undefined;
  const fallback = translate('generated.workspaceInspector.filesUnsupported');
  return capability.reasonCode === null
    ? fallback
    : errorSummary(new ApiError(capability.reasonCode, fallback));
});
const asideWidth = computed(() =>
  props.page.layout.mobileViewport
    ? asideAvailableWidth.value
    : props.page.aside.asideWidth(asideMode.value, asideAvailableWidth.value, 360)
);
const treeStatus = computed(() =>
  workspaceOffline.value
    ? 'failed'
    : props.page.application.workspaceWatchTopicStatus.sessionNavigation
);
const asideVisible = computed(
  () =>
    props.page.application.view === 'nodes' &&
    props.page.selection.workspaceTarget !== undefined &&
    props.page.aside.asideState !== undefined &&
    asideWidth.value !== undefined &&
    asideWidth.value > 0 &&
    (!props.page.layout.mobileViewport ||
      props.page.layout.mobileWorkspaceSurface === 'inspector' ||
      props.page.layout.mobileWorkspaceSurface === 'terminal')
);
watch(asideVisible, (visible) => props.page.aside.setAsideSurfaceVisible(visible), {
  immediate: true
});
onBeforeUnmount(() => props.page.aside.setAsideSurfaceVisible(false));
const terminalVisible = computed(
  () =>
    asideVisible.value &&
    props.page.aside.asideState?.active?.kind === 'tool' &&
    props.page.aside.asideState.active.id === 'terminal'
);
function openPaneSurface(surface: 'sessions' | 'inspector' | 'terminal'): void {
  if (surface === 'terminal') props.page.aside.toggleAsideTerminal();
  else props.page.layout.openMobileWorkspaceSurface(surface);
}
const asideTools = computed(() => [
  { id: 'files' as const, label: translate('generated.workspaceInspector.files3') },
  { id: 'search' as const, label: translate('generated.workspaceInspector.search') },
  { id: 'changes' as const, label: translate('generated.workspaceInspector.gitChanges') },
  { id: 'history' as const, label: translate('generated.workspaceInspector.gitHistory') },
  { id: 'terminal' as const, label: translate('generated.terminalDock.workspaceTerminal') }
]);
const asideSessions = computed(() =>
  (props.page.aside.asideState?.sessions ?? []).map((sessionId) => {
    const session = props.page.aside.asideSessionMetadata.find((item) => item.id === sessionId);
    return {
      sessionId,
      title: session?.title ?? sessionId,
      active: session?.activity === 'MANAGED_ACTIVE'
    };
  })
);
function activeTool(tool: AsideTool | undefined): AsideTool | null {
  const active = props.page.aside.asideState?.active;
  return !asideVisible.value || active?.kind !== 'tool' || active.id !== tool || tool === 'terminal'
    ? null
    : tool;
}
const filesVisible = computed(
  () => asideVisible.value && props.page.files.filesReady && activeTool('files') === 'files'
);
const searchVisible = computed(() => {
  const active = props.page.aside.asideState?.active;
  return (
    asideVisible.value &&
    props.page.files.filesReady &&
    props.page.files.contentSearchReady &&
    active?.kind === 'tool' &&
    active.id === 'search'
  );
});
onMounted(() => props.page.files.mountSurface());
onBeforeUnmount(() => props.page.files.unmountSurface());
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
  props.page.sessionList.setSessionTreeAnchor(undefined);
  if (restoreFocus && previous)
    void nextTick(() => {
      if (previous.anchor.isConnected) previous.anchor.focus();
    });
}
function showSessionTree(sessionId: string, anchor: HTMLElement, title: string): void {
  const target = props.page.selection.workspaceTarget;
  if (!target || !props.page.aside.asideSupported) return;
  if (treePopup.value?.anchor === anchor) {
    closeSessionTree(true);
    return;
  }
  treePopup.value = { ...target, sessionId, anchor, title };
  props.page.sessionList.setSessionTreeAnchor(sessionId);
}
function openAsideTarget(target: {
  nodeId: string;
  workspaceId: string;
  sessionId: string;
}): boolean {
  const accepted = props.page.aside.openAsideSession(target);
  if (accepted && props.page.layout.mobileViewport)
    props.page.layout.openMobileWorkspaceSurface('inspector');
  return accepted;
}
function openSessionFromTree(sessionId: string, destination: 'aside' | 'main'): void {
  const popup = treePopup.value;
  const current = props.page.selection.workspaceTarget;
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
    void props.page.selection.openSessionGroupTarget(target);
    closeSessionTree(false);
  }
}
watch(
  () => [
    props.page.selection.workspaceTarget?.nodeId,
    props.page.selection.workspaceTarget?.workspaceId,
    props.page.application.view,
    props.page.aside.asideSupported
  ],
  () => {
    const popup = treePopup.value;
    if (
      popup &&
      (props.page.application.view !== 'nodes' ||
        !props.page.aside.asideSupported ||
        props.page.selection.workspaceTarget?.nodeId !== popup.nodeId ||
        props.page.selection.workspaceTarget.workspaceId !== popup.workspaceId)
    )
      closeSessionTree();
  }
);
onBeforeUnmount(() => {
  if (treePopup.value) closeSessionTree();
});
const hostedConversationHeader = computed(() => {
  const workspace = props.page.hosted.hostedConversationWorkspace;
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
  const nodeId = props.page.selection.workspaceTarget?.nodeId;
  const workspace = props.page.resources.selectedWorkspace;
  if (nodeId === undefined || workspace === undefined) return;
  cleanupTarget.value = { nodeId, workspace };
  cleanupDialogOpen.value = true;
}

async function cleanupWorkspaceSessions(inactiveDays: number) {
  const target = cleanupTarget.value;
  if (target === undefined) return undefined;
  return props.page.sessionList.cleanupWorkspaceSessions(
    target.nodeId,
    target.workspace,
    inactiveDays
  );
}

function updateCleanupDialogOpen(value: boolean): void {
  cleanupDialogOpen.value = value;
  if (!value) cleanupTarget.value = undefined;
}

const mobileToolsFocus = createMobileSurfaceFocusService({
  isOpen: () =>
    props.page.layout.mobileViewport && props.page.layout.mobileWorkspaceSurface !== 'conversation',
  regions: () => [
    document.querySelector<HTMLElement>(
      props.page.layout.mobileWorkspaceSurface === 'sessions'
        ? '.workspace-grid.mobile-surface-sessions .conversation-sidebar'
        : '.workspace-grid .workspace-aside'
    ),
    document.querySelector<HTMLElement>('.activity-rail')
  ],
  close: () => props.page.layout.closeMobileWorkspaceSurface(),
  terminal: () => terminalVisible.value
});
onBeforeUnmount(mobileToolsFocus.dispose);
</script>

<template>
  <section
    :class="[
      'workbench',
      {
        settings: page.application.view !== 'nodes' && page.application.view !== 'conversations',
        standalone: page.application.view === 'conversations',
        compact: page.layout.sidebarCollapsed
      }
    ]"
  >
    <el-dialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="page.registration.workspaceRegistrationNodeId !== undefined"
      :model-value="true"
      :title="translate('generated.workbenchSurface.registerWorkspace')"
      width="min(980px, calc(100vw - 32px))"
      destroy-on-close
      @update:model-value="
        (value: boolean) => {
          if (!value) page.registration.closeWorkspaceRegistration();
        }
      "
      :close-icon="marIcon('close')"
    >
      <slot name="workspace-registration">
        <WorkspaceRegistrationPicker
          v-model="page.registration.openWorkspaceTools"
          v-model:preserve-git-config="page.registration.workspacePreserveGitConfig"
          :directory="page.registration.workspaceDirectory"
          :selected-path="page.resources.workspacePath"
          :pending-directory-name="page.registration.pendingWorkspaceDirectoryName"
          :loading-directory="page.registration.loadingWorkspaceDirectory"
          :loading="page.registration.registrationLoading"
          :node-ready="page.registration.workspaceRegistrationReady"
          :selected-path-valid="page.registration.selectedWorkspaceDirectorySelectable"
          @navigate="page.registration.loadWorkspaceDirectories"
          @select="page.registration.selectWorkspaceDirectory"
          @select-pending="page.registration.selectPendingWorkspaceDirectory"
          @discard-pending="page.registration.discardPendingWorkspaceDirectory"
          @register="page.registration.registerWorkspace"
        />
      </slot>
    </el-dialog>
    <WorkbenchHeader
      :mobile-viewport="page.layout.mobileViewport"
      :view="page.application.view"
      :sidebar-collapsed="page.layout.sidebarCollapsed"
      :settings-section="page.application.settingsSection"
      :management-section="page.application.managementSection"
      :settings-items="page.application.settingsItems"
      :management-items="page.application.managementItems"
      :conversation-title="
        hostedConversationHeader === undefined
          ? translate('hostedConversations.temporaryTitle')
          : hostedConversationTitle(hostedConversationHeader)
      "
      @toggle-sidebar="page.layout.sidebarCollapsed = !page.layout.sidebarCollapsed"
    >
      <template
        v-if="page.application.view === 'nodes' && !page.layout.mobileViewport"
        #workspace-tabs
      >
        <WorkspaceTabs
          placement="header"
          :tabs="page.selection.workspaceTabs"
          :active-tab-id="page.selection.activeWorkspaceTabId"
          :empty-label="
            page.resources.workspaceHost === undefined
              ? translate('workspaceTabs.newTab')
              : page.resources.nodeLabel(page.resources.workspaceHost)
          "
          :empty-context="translate('navigation.selectWorkspace')"
          :node-label="page.selection.workspaceTabNodeLabel"
          :direct-available="page.resources.workspaceDirectAvailable"
          :direct-description="page.resources.workspaceDirectDescription"
          :has-active-run="page.notifications.hasActiveWorkspaceRun"
          :has-unread="page.notifications.hasUnreadWorkspace"
          @activate="page.selection.activateWorkspaceTab"
          @close="page.selection.closeWorkspaceTab"
          @reorder="page.selection.moveWorkspaceTab"
          @pin="page.selection.pinWorkspaceTab"
        />
      </template>
    </WorkbenchHeader>
    <section v-show="page.application.view === 'nodes'" class="session-layout">
      <section
        v-if="page.application.view === 'nodes' && page.selection.workspaceTarget === undefined"
        class="welcome-panel compact-welcome"
      >
        <h1>{{ translate('generated.workbenchSurface.selectAWorkspace') }}</h1>
        <p>
          {{ translate('generated.workbenchSurface.selectANodeInTheResourceExplorer') }}
        </p>
        <p class="workspace-selection-hint">
          {{ translate('generated.workbenchSurface.noNodeConnectedYetCreateARegistration') }}
          <el-button link type="primary" @click="page.registration.openNodeRegistration">{{
            translate('generated.workbenchSurface.openNodeManagement')
          }}</el-button>
        </p>
      </section>
      <template
        v-else-if="
          page.application.view === 'nodes' && page.selection.workspaceTarget !== undefined
        "
      >
        <WorkspaceTabs
          v-if="page.layout.mobileViewport"
          placement="body"
          :tabs="page.selection.workspaceTabs"
          :active-tab-id="page.selection.activeWorkspaceTabId"
          :node-label="page.selection.workspaceTabNodeLabel"
          :direct-available="page.resources.workspaceDirectAvailable"
          :direct-description="page.resources.workspaceDirectDescription"
          :has-active-run="page.notifications.hasActiveWorkspaceRun"
          :has-unread="page.notifications.hasUnreadWorkspace"
          @activate="page.selection.activateWorkspaceTab"
          @close="page.selection.closeWorkspaceTab"
          @reorder="page.selection.moveWorkspaceTab"
          @pin="page.selection.pinWorkspaceTab"
        />
        <section
          v-if="
            !workspaceOffline &&
            !page.resources.nodeReady &&
            page.resources.selectedNodeStatus !== undefined
          "
          class="readonly-banner"
          role="status"
        >
          <MarIcon name="info" aria-hidden="true" />
          <span>{{ page.resources.selectedNodeStatus }}</span>
        </section>
        <section v-if="workspaceOffline" class="workspace-offline-placeholder" role="status">
          <div class="workspace-offline-message">
            <MarIcon name="connection-off" class="workspace-offline-icon" aria-hidden="true" />
            <p>
              {{
                translate(
                  page.application.networkUnavailable
                    ? 'generated.workbenchSurface.connectionOffline'
                    : 'generated.workbenchSurface.offlineWorkspace'
                )
              }}
            </p>
          </div>
        </section>
        <section
          v-if="
            !workspaceOffline &&
            page.selection.workspaceTarget !== undefined &&
            page.resources.selectedWorkspace === undefined
          "
          class="welcome-panel compact-welcome workspace-selection-panel workspace-recovery-panel"
        >
          <div
            v-if="page.selection.workspaceSelectionLoading"
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
            <el-button link size="small" @click="page.selection.retryWorkspaceSelection">
              {{ translate('common.loadFailedRetry') }}
            </el-button>
          </div>
        </section>
        <div
          ref="workspaceGrid"
          v-else-if="page.resources.selectedWorkspace !== undefined"
          v-show="!workspaceOffline"
          :class="['workspace-grid', `mobile-surface-${page.layout.mobileWorkspaceSurface}`]"
          :style="{ '--aside-width': `${asideWidth ?? 0}px` }"
        >
          <WorkspaceSessionList
            :aside-supported="page.aside.asideSupported"
            @open-aside="openAsideTarget"
            :session-group="page.sessionList.workspaceSessionGroup"
            @select-group="page.sessionList.selectWorkspaceSessionGroup"
            @open-tree="showSessionTree"
            :sessions="page.sessionList.visibleWorkspaceSessions"
            :selected-session-id="page.selection.selectedSessionId"
            :mobile-viewport="page.layout.mobileViewport"
            :can-load-more="page.sessionList.canLoadMoreWorkspaceSessions"
            :loading-more="page.sessionList.loadingMoreWorkspaceSessions"
            :load-more-error="page.sessionList.loadMoreWorkspaceSessionsError"
            :active="
              (!page.layout.mobileViewport || page.layout.mobileWorkspaceSurface === 'sessions') &&
              !workspaceOffline
            "
            :watch-status="page.application.workspaceWatchTopicStatus.sessions"
            :node-ready="page.resources.nodeReady"
            :loading="page.sessionList.mutationLoading"
            :workspace-kind="page.resources.selectedWorkspace?.kind"
            :workspace-kind-label="
              page.resources.workspaceKindLabel(page.resources.selectedWorkspace)
            "
            :workspace-branch="
              page.resources.workspaceBranchLabel(page.resources.selectedWorkspace)
            "
            :title="page.sessionList.sessionTitle"
            :runner-icon="page.application.runnerBrandIcon"
            :activity="page.sessionList.sessionActivity"
            :can-delete-session="page.sessionList.canDeleteSession"
            :activity-label="page.sessionList.sessionActivityLabel"
            :activity-date-time="page.sessionList.sessionActivityDateTime"
            :activity-title="page.sessionList.sessionActivityTitle"
            :relative-activity="page.sessionList.sessionRelativeActivity"
            :node-id="page.selection.workspaceTarget?.nodeId"
            :workspace-id="page.resources.selectedWorkspace.id"
            :skill-supported="true"
            :mcp-supported="true"
            :cleanup-sessions-supported="page.sessionList.cleanupSessionsEnabled"
            :search-supported="page.sessionList.workspaceSessionSearchEnabled"
            :search-query="page.sessionList.workspaceSessionSearchQuery"
            :searching="page.sessionList.searchingWorkspaceSessions"
            :refreshing="page.sessionList.refreshingWorkspaceSessions"
            :workspace-manageable="page.resources.selectedWorkspace.manageable !== false"
            :request="page.identity.request"
            :has-unread="
              (sessionId) =>
                page.notifications.hasUnreadSession(
                  page.selection.workspaceTarget?.nodeId!,
                  page.resources.selectedWorkspace!.id,
                  sessionId
                )
            "
            @create="page.selection.openNewSessionComposer"
            @open="page.selection.openSessionFromList"
            @rename="page.sessionList.renameSession"
            @pin="page.sessionList.setSessionPinned"
            @move-pin="page.sessionList.movePinnedSession"
            @move-pin-to="page.sessionList.movePinnedSessionTo"
            @delete-session="page.sessionList.deleteSession"
            @cleanup-sessions="openWorkspaceSessionCleanupDialog"
            @load-more="page.sessionList.loadMoreWorkspaceSessions"
            @search="page.sessionList.searchWorkspaceSessions"
            @refresh="page.sessionList.refreshWorkspaceSessions"
          />
          <WorkspaceSessionCleanupDialog
            v-if="cleanupDialogOpen && cleanupTarget !== undefined"
            :model-value="cleanupDialogOpen"
            :cleanup="cleanupWorkspaceSessions"
            @update:model-value="updateCleanupDialogOpen"
          />
          <WorkspaceSessionPane
            :controller="page.mainPaneController"
            :aside-ready="page.aside.asideState?.active !== undefined"
            :tree-supported="page.aside.asideSupported"
            :tree-open-session-id="treePopup?.sessionId"
            :tree-summaries="page.sessionList.sessionNavigationSnapshot?.summaries"
            :tree-status="treeStatus"
            @open-tree="showSessionTree"
            @open-surface="openPaneSurface"
            @preview-attachment="page.interactions.openAttachmentPreview"
            @reload="page.sessionList.reloadSelectedSession"
          />
          <WorkspaceFileWorkbench
            :quote-target-for="page.files.quoteTargetFor"
            :key="`${page.selection.workspaceTarget?.nodeId}:${page.selection.workspaceTarget?.workspaceId}`"
            :ref="(instance) => (page.files.workspaceFileWorkbench = instance as never)"
            :node-id="page.selection.workspaceTarget?.nodeId"
            :workspace-id="page.selection.workspaceTarget?.workspaceId"
            :controller="page.files.fileWorkbench"
            :register-page="page.files.setWorkspaceFilePage"
            :adjacent-diff="page.files.adjacentWorkspaceDiff"
            :load-diff="page.files.loadWorkspaceDiff"
            :open-external="page.files.openWorkspaceFileExternal"
            :enabled="page.files.filesReady"
            :prediction-enabled="page.application.workPromptCompletion.enabled"
            :code-navigation-enabled="page.application.codeNavigationReady"
            :file-write-enabled="page.files.fileWriteReady"
            :standalone-file-mode="page.files.standaloneFileMode"
            @open-html-preview="page.aside.openHtmlAside"
            @notice="page.application.notice"
          />
          <Transition
            name="workspace-aside"
            :css="
              page.layout.mobileViewport &&
              page.selection.workspaceTarget !== undefined &&
              !workspaceOffline
            "
          >
            <div
              v-if="page.aside.asideState"
              v-show="asideVisible"
              class="workspace-aside"
              tabindex="-1"
              :aria-hidden="!asideVisible"
            >
              <WorkbenchAside
                :inert="!asideVisible"
                :workspace="page.selection.workspaceTarget!"
                :state="page.aside.asideState"
                :tools="asideTools"
                :browser-label="translate('htmlPreview.browser')"
                :sessions="asideSessions"
                :tab-label="translate('generated.workbenchAside.tabs')"
                :close-label="
                  (title) => translate('generated.workbenchAside.close', { value0: title })
                "
                :resize-label="translate('generated.workbenchAside.resize')"
                :width="asideWidth ?? WORKBENCH_PANEL_LIMITS[asideMode].min"
                :mobile="page.layout.mobileViewport"
                :close-surface-label="translate('workbench.closeWorkspaceTools')"
                :min-width="WORKBENCH_PANEL_LIMITS[asideMode].min"
                :max-width="
                  Math.max(
                    WORKBENCH_PANEL_LIMITS[asideMode].min,
                    Math.min(WORKBENCH_PANEL_LIMITS[asideMode].max, asideAvailableWidth - 360)
                  )
                "
                :mode="asideMode"
                @select-tool="page.aside.selectAsideTool"
                @select-browser="page.aside.selectAsideBrowser"
                @close-browser="page.aside.closeAsideBrowser"
                @select-session="page.aside.openAsideSession"
                @close-session="page.aside.closeAsideSession"
                @resize="page.layout.setPanelWidth(asideMode, $event)"
                @close-surface="page.layout.closeMobileWorkspaceSurface"
              >
                <template #browser>
                  <WorkspaceHtmlBrowser
                    v-if="
                      asideVisible &&
                      page.selection.workspaceTarget &&
                      page.aside.asideState.htmlPath !== undefined &&
                      page.aside.asideState.active?.kind === 'browser'
                    "
                    :node-id="page.selection.workspaceTarget.nodeId"
                    :workspace-id="page.selection.workspaceTarget.workspaceId"
                    :path="page.aside.asideState.htmlPath"
                    :csrf-token="page.identity.csrfToken"
                    :renew-csrf-token="page.identity.renewCsrfToken"
                    @source="page.files.fileWorkbench.openFile($event)"
                    @external="page.application.openHtmlExternal($event)"
                  />
                </template>
                <template #tool="{ tool }">
                  <WorkspaceFilesPanel
                    v-if="tool === 'files' && page.selection.workspaceTarget !== undefined"
                    v-show="filesVisible"
                    :key="`${page.selection.workspaceTarget.nodeId}:${page.selection.workspaceTarget.workspaceId}`"
                    :ref="(instance) => page.files.setWorkspaceFilesPanel(instance as never)"
                    :service="page.files.workspaceFiles"
                    :visible="filesVisible"
                    :watch-status="page.application.workspaceWatchTopicStatus.files"
                    :workspace-path="page.resources.selectedWorkspace?.path"
                    :local-file-manager-enabled="page.resources.workspaceLocalFileManagerAvailable"
                    :mobile-viewport="page.layout.mobileViewport"
                    @refresh="page.files.workspaceFiles.requestRefresh()"
                    @open="
                      (path, external) =>
                        external
                          ? page.files.openWorkspaceFileExternal(path)
                          : page.files.fileWorkbench.openFile(path)
                    "
                    @html="page.aside.openHtmlAside"
                    @download="page.files.downloadWorkspaceFile($event)"
                    @failure="
                      (error, action) => page.files.reportWorkspaceFileFailure(error, action)
                    "
                    @notice="(message, type) => page.application.notice(message, type)"
                    @retry-watch="page.application.retryWorkspaceWatch"
                  />
                  <WorkspaceContentSearch
                    v-if="tool === 'search' && page.selection.workspaceTarget !== undefined"
                    :key="`${page.selection.workspaceTarget.nodeId}:${page.selection.workspaceTarget.workspaceId}`"
                    :ref="(instance) => page.files.setWorkspaceSearchPanel(instance as never)"
                    v-show="searchVisible"
                    :service="page.files.workspaceSearch"
                    :enabled="page.files.contentSearchReady"
                    :node-id="page.selection.workspaceTarget?.nodeId"
                    :workspace-id="page.selection.workspaceTarget?.workspaceId"
                    @open="
                      (path, line, column, external) =>
                        external
                          ? page.files.openWorkspaceFileExternal(path, line, column)
                          : page.files.fileWorkbench.openFile(path, line, column)
                    "
                  />
                  <p
                    v-if="
                      (activeTool(tool) === 'files' || activeTool(tool) === 'search') &&
                      !page.files.filesReady &&
                      (workspaceCapabilitiesLoading || workspaceFilesRestriction !== undefined)
                    "
                    class="workspace-tool-unavailable"
                    :class="{
                      'workspace-tool-loading': workspaceCapabilitiesLoading
                    }"
                    :role="workspaceCapabilitiesLoading ? 'status' : undefined"
                  >
                    <MarIcon v-if="workspaceCapabilitiesLoading" name="loading-action" />
                    {{
                      workspaceCapabilitiesLoading
                        ? translate('generated.workspaceInspector.loading')
                        : workspaceFilesRestriction
                    }}
                  </p>
                  <section
                    v-if="activeTool(tool) === 'changes' || activeTool(tool) === 'history'"
                    :key="
                      JSON.stringify([
                        page.selection.workspaceTarget?.nodeId,
                        page.selection.workspaceTarget?.workspaceId
                      ])
                    "
                    class="workspace-git-panel"
                  >
                    <p
                      v-if="
                        !page.files.filesReady &&
                        (workspaceCapabilitiesLoading || workspaceFilesRestriction !== undefined)
                      "
                      class="empty"
                      :class="{
                        'workspace-tool-loading': workspaceCapabilitiesLoading
                      }"
                      :role="workspaceCapabilitiesLoading ? 'status' : undefined"
                    >
                      <MarIcon v-if="workspaceCapabilitiesLoading" name="loading-action" />
                      {{
                        workspaceCapabilitiesLoading
                          ? translate('generated.workspaceInspector.loading')
                          : workspaceFilesRestriction
                      }}
                    </p>
                    <template v-else-if="page.files.filesReady">
                      <WorkspaceGitChanges
                        v-if="activeTool(tool) === 'changes'"
                        :service="page.files.workspaceGit"
                        :target="page.selection.workspaceTarget"
                        :watch-status="page.application.workspaceWatchTopicStatus.changes"
                        @retry-watch="page.application.retryWorkspaceWatch()"
                        @open="page.files.openWorkspaceGitChange"
                        @notice="page.application.notice"
                      />
                      <WorkspaceGitHistory
                        v-else
                        :service="page.files.workspaceGit"
                        @open="page.files.openWorkspaceHistoryDiff"
                        @notice="page.application.notice"
                      />
                    </template>
                  </section>
                </template>
                <template #session>
                  <WorkspaceSessionPane
                    :controller="page.aside.asidePaneController"
                    :aside-ready="page.aside.asideState?.active !== undefined"
                    :tree-supported="page.aside.asideSupported"
                    :tree-open-session-id="treePopup?.sessionId"
                    :tree-summaries="page.sessionList.sessionNavigationSnapshot?.summaries"
                    :tree-status="treeStatus"
                    @open-tree="showSessionTree"
                    @open-surface="openPaneSurface"
                    @preview-attachment="page.interactions.openAttachmentPreview"
                    @reload="page.aside.reloadAsideSession"
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
          v-for="tab in page.selection.workspaceTabs"
          :key="tab.id"
          v-show="
            terminalVisible &&
            tab.id === page.selection.activeWorkspaceTabId &&
            page.terminal.terminalReady
          "
          tabindex="-1"
          :inert="!terminalVisible"
          class="terminal-dock"
        >
          <TerminalDock
            :error-message="errorMessage"
            embedded
            :ref="
              (instance) => {
                if (instance === null) page.terminal.terminalDocks.delete(tab.id);
                else
                  page.terminal.terminalDocks.set(
                    tab.id,
                    instance as unknown as {
                      release(): Promise<void>;
                      toggle(): Promise<void>;
                    }
                  );
              }
            "
            :node-id="tab.nodeId"
            :direct="page.terminal.terminalDirectClient"
            :workspace-id="tab.workspaceId"
            :csrf-token="page.identity.csrfToken"
            :renew-csrf-token="page.identity.renewCsrfToken"
            :enabled="
              page.application.view === 'nodes' &&
              tab.id === page.selection.activeWorkspaceTabId &&
              page.terminal.terminalReady
            "
            :capability="page.resources.nodeManifest?.terminal"
            :node-os-release="
              page.resources.nodes.find((node) => node.id === tab.nodeId)?.metadata?.osRelease
            "
            :visible="
              page.application.view === 'nodes' &&
              tab.id === page.selection.activeWorkspaceTabId &&
              page.terminal.terminalReady &&
              terminalVisible
            "
            :mobile-mode="page.layout.mobileViewport"
            :active="
              page.application.view === 'nodes' && tab.id === page.selection.activeWorkspaceTabId
            "
            @collapse="page.layout.mobileViewport && page.layout.closeMobileWorkspaceSurface()"
            @notice="page.application.notice"
          />
        </div>
      </Teleport>
    </section>
    <HostedConversationWorkspacePage
      v-if="page.application.view === 'conversations'"
      :connected="page.application.liveConnected"
      :workspace="page.hosted.hostedConversationWorkspace"
      :request="page.identity.request"
      :mobile-viewport="page.layout.mobileViewport"
      :mobile-history-open="page.hosted.hostedConversationMobileHistoryOpen"
      v-model:mobile-files-open="page.hosted.hostedConversationMobileFilesOpen"
      :sidebar-collapsed="page.layout.sidebarCollapsed"
      :select-conversation="page.hosted.selectHostedConversation"
      :route-target="page.hosted.hostedConversationRoute"
      :restoring-route="page.hosted.restoringHostedConversationRoute"
      :clear-conversation="page.hosted.clearHostedConversation"
      :has-unread-conversation="page.notifications.hasUnreadConversation"
      @close-mobile-history="page.hosted.closeHostedConversationMobileHistory"
    />
    <template v-else-if="page.application.view === 'settings'">
      <slot name="settings">
        <SettingsContent
          :web-version="page.application.webVersion"
          :pwa-state="page.application.pwaState"
          :checking-for-updates="page.application.checkingForUpdates"
          v-model:new-password="page.identity.newPassword"
          :section="page.application.settingsSection"
          :sessions="page.identity.adminSessions"
          :password-validation-error="page.identity.passwordValidationError"
          :registration-token="page.settings.registrationToken"
          :registration-loading="page.settings.registrationLoading"
          :loading="page.identity.loading"
          :format-session-time="page.identity.formatSessionTime"
          :request="page.identity.request"
          :quick-prompts="page.settings.quickPrompts"
          :quick-prompts-loading="page.settings.quickPromptsLoading"
          :quick-prompts-failed="page.settings.quickPromptsFailed"
          :refresh-quick-prompts="page.settings.refreshQuickPrompts"
          :system-notifications="page.notifications.systemNotifications"
          @clear-password-error="page.identity.passwordValidationError = ''"
          @refresh-sessions="page.identity.refreshAdminSessions"
          @logout-session="page.identity.logoutAdminSession"
          :change-password="page.identity.changePassword"
          @logout="page.identity.logout"
          @create-registration-token="page.settings.createRegistrationToken"
          @check-for-updates="page.application.checkForUpdates"
          @apply-web-update="page.application.applyWebUpdate"
        />
      </slot>
    </template>
    <template v-else-if="page.application.view === 'management'">
      <slot name="management-notice" />
      <component
        :is="managementPage.component"
        :key="managementPage.id"
        v-bind="
          managementPage.props({
            admin: page.identity.admin,
            request: page.identity.request,
            nodes: page.resources.nodes,
            nodeUpgradeProgress: page.resources.nodeUpgradeProgress,
            onlineNodeCount: page.resources.onlineNodeCount,
            serverVersion: page.resources.serverVersion
          })
        "
        @changed="page.resources.refreshNodes"
        @extension-changed="page.identity.refreshAdmin"
      />
    </template>
    <WorkspaceSessionTreePopover
      v-if="treePopup"
      :key="treePopup.sessionId"
      :anchor="treePopup.anchor"
      :session-id="treePopup.sessionId"
      :title="treePopup.title"
      :tree="page.sessionList.sessionNavigationSnapshot?.tree"
      :status="treeStatus"
      :main-session-id="
        page.selection.draftSessionOpen ? undefined : page.selection.selectedSessionId
      "
      :aside-session-ids="page.aside.asideState?.sessions ?? []"
      :active-aside-id="
        page.aside.asideState?.active?.kind === 'session'
          ? page.aside.asideState.active.sessionId
          : undefined
      "
      @close="closeSessionTree"
      @open="openSessionFromTree"
      @retry="page.application.retryWorkspaceWatch"
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
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0.5rem 0.75rem 0;
  border: 1px solid var(--mar-border-subtle);
  border-radius: var(--mar-radius-control);
  padding: 0.5rem 0.625rem;
  color: var(--mar-text-secondary);
  background: var(--mar-bg-panel);
  font-size: var(--mar-font-size-meta);
  line-height: 1.5;
}

.readonly-banner .mar-icon {
  flex: 0 0 auto;
  margin-top: 0.1em;
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
.workspace-tool-loading {
  margin: 0.2rem 0.55rem;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
}

.workspace-git-panel {
  display: flex;
  height: 100%;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  padding: 0 0.7rem 0.7rem;
}

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
