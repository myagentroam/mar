<script
  setup
  lang="ts"
  generic="ManagementSection extends string, RegistrationContext, NodeRegistrationContext"
>
import { MarButton } from '@myagentroam/mar-ui/button';
import { createMobileSurfaceFocusService } from '../../service/mobile-surface-focus-service.js';
import { shortcutTooltip, workspaceKeys } from '../../service/console-shortcut-keys.js';
import { errorSummary } from '../../util/error-presentation.js';
import { ApiError } from '../../util/api-error.js';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import { MarLoadingPanel } from '@myagentroam/mar-ui/loading-panel';

import {
  computed,
  defineAsyncComponent,
  h,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
  watch
} from 'vue';
import type { Session, Workspace } from '../../model/workbench.js';
import type { WorkbenchSurfaceView } from '../workbench-contract.js';
import { errorMessage, hostedConversationTitle } from '../../util/workbench-presentation.js';
import WorkspaceFileWorkbench from '../workspace/WorkspaceFileWorkbench.vue';
import WorkspaceGitChanges from '../workspace/WorkspaceGitChanges.vue';
import WorkspaceGitHistory from '../workspace/WorkspaceGitHistory.vue';
import WorkspaceContentSearch from '../workspace/WorkspaceContentSearch.vue';
import WorkspaceFilesPanel from '../workspace/WorkspaceFilesPanel.vue';
import WorkspaceNodeBrowser from './WorkspaceNodeBrowser.vue';
import BrowserClearDialog from '../settings/BrowserClearDialog.vue';
import BrowserSettings from '../settings/BrowserSettings.vue';
import BrowserHistoryDialog from './BrowserHistoryDialog.vue';
import WorkspaceSessionList from '../../view/workspace/WorkspaceSessionList.vue';
import WorkspaceSessionActionsMenu from '../workspace/WorkspaceSessionActionsMenu.vue';
import SessionPromptDialog from '../workspace/SessionPromptDialog.vue';
import ScheduledTasksPanel from '../schedule/ScheduledTasksPanel.vue';
import type { ScheduleSessionScope } from '../../service/scheduled-task-client.js';
import type {
  ScheduleSessionContext,
  ScheduledTasksLocation,
  ScheduleSection
} from '../schedule/scheduled-task-navigation.js';
import SessionShareDialog from '../workspace/SessionShareDialog.vue';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
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
import WorkspaceCollaborationDialog from '../workspace/WorkspaceCollaborationDialog.vue';
import type { AsideTool, AsideWorkspace } from '../../service/workbench-aside-service.js';
import {
  readBrowserLinkPreferences,
  routeWorkbenchBrowserLink,
  type WorkbenchBrowserLink
} from '../../service/browser-link-routing.js';
import { WORKBENCH_PANEL_LIMITS } from '../../service/workbench-layout-service.js';

const loadingComponent = {
  render: () =>
    h(MarLoadingPanel, {
      loading: true,
      variant: 'page',
      'aria-label': translate('common.loading')
    })
};

const SettingsContent = defineAsyncComponent({
  loader: () => import('../settings/SettingsContent.vue'),
  loadingComponent,
  delay: 0
});

const props = defineProps<{
  page: WorkbenchSurfaceView<ManagementSection, RegistrationContext, NodeRegistrationContext>;
  schedules?: ScheduledTasksLocation | undefined;
}>();
const emit = defineEmits<{
  openSchedules: [session: ScheduleSessionContext];
  closeSchedules: [];
  selectScheduleSection: [section: ScheduleSection];
}>();
async function openScheduledTarget(
  target: ScheduleSessionScope & { runId?: string }
): Promise<void> {
  const source = props.schedules;
  const { selection } = props.page;
  await selection.openSessionGroupTarget(target);
  if (props.schedules !== source) return;
  const selected = selection.workspaceTarget;
  const pane = props.page.mainPaneController;
  if (
    selected?.nodeId === target.nodeId &&
    selected.workspaceId === target.workspaceId &&
    pane.selectedSessionId.value === target.sessionId
  ) {
    if (target.runId !== undefined) pane.selectRun(target.runId);
    emit('closeSchedules');
  }
}
const browserSource = ref<AsideWorkspace & { browserId: string }>();
const browserReturn = ref<AsideWorkspace & { browserId: string }>();
const browserData = ref<AsideWorkspace & { browserId: string; kind: 'cache' | 'history' }>();
const browserScopeLabel = computed(
  () =>
    props.page.resources.selectedWorkspace?.displayName ??
    props.page.resources.selectedWorkspace?.path ??
    browserData.value?.workspaceId ??
    ''
);
const browserDestination = props.page.browser.destination;
const browserCapability = computed(() => props.page.browserCapability());
function atBrowserScope(scope: AsideWorkspace | undefined): boolean {
  const current = props.page.selection.workspaceTarget;
  return (
    scope !== undefined &&
    current?.nodeId === scope.nodeId &&
    current.workspaceId === scope.workspaceId
  );
}
function openBrowserSettings(browserId: string | undefined): void {
  const scope = props.page.selection.workspaceTarget;
  browserSource.value = scope && browserId ? { ...scope, browserId } : undefined;
  props.page.application.selectNavigation('settings');
  props.page.application.selectSettingsSection('browser');
}
function openBrowserData(kind: 'cache' | 'history', browserId: string): void {
  const scope = props.page.selection.workspaceTarget;
  if (scope) browserData.value = { ...scope, browserId, kind };
}
function openInNodeBrowser(scope: AsideWorkspace | undefined, url: string): void {
  if (!scope || !atBrowserScope(scope)) return;
  if (!browserCapability.value) {
    props.page.application.notice(translate('browser.unavailable'), 'error');
    return;
  }
  props.page.application.selectNavigation('nodes');
  props.page.aside.selectAsideTool({ ...scope, id: 'node-browser' });
  props.page.browser.openDestination(scope, { url });
}
function openBrowserHistory(url: string): void {
  const scope = browserData.value;
  browserData.value = undefined;
  openInNodeBrowser(scope, url);
}
function routeBrowserLink(link: WorkbenchBrowserLink, alternate: boolean): boolean {
  if (!atBrowserScope(link.source)) return true;
  const route = routeWorkbenchBrowserLink(
    link,
    readBrowserLinkPreferences(props.page.identity.admin.userId),
    alternate
  );
  if (!route) return false;
  if (link.kind === 'html') {
    if (route.destination === 'external') props.page.application.openHtmlExternal(link.path);
    else props.page.aside.openHtmlAside(link.path);
  } else if (route.destination === 'mar') openInNodeBrowser(link.source, link.url);
  else window.open(link.url, '_blank', 'noopener,noreferrer');
  return true;
}
watch(
  () => props.page.application.view,
  (view, from) => {
    if (from === 'settings' && browserSource.value) {
      browserReturn.value =
        view === 'nodes' && atBrowserScope(browserSource.value) ? browserSource.value : undefined;
      browserSource.value = undefined;
    }
    if (view !== 'nodes') browserData.value = undefined;
  }
);
watch(
  () => [
    props.page.selection.workspaceTarget?.nodeId,
    props.page.selection.workspaceTarget?.workspaceId,
    props.page.identity.admin.userId
  ],
  () => {
    browserSource.value = browserReturn.value = browserData.value = undefined;
    props.page.browser.clearDestination();
  }
);
const workContent = ref<HTMLElement>();
const startupRetry = ref<InstanceType<typeof MarButton>>();
const workStartupBlocked = computed(
  () =>
    props.page.selection.workspaceStartupStatus === 'loading' ||
    props.page.selection.workspaceStartupStatus === 'failed'
);
let restoreRetryFocus = false;
function retryWorkspaceStartup(event: MouseEvent): void {
  const button = event.currentTarget;
  restoreRetryFocus = event.detail === 0 && button === document.activeElement;
  if (restoreRetryFocus) workContent.value?.focus({ preventScroll: true });
  props.page.selection.retryWorkspaceStartup();
}
watch(
  [() => props.page.application.view, () => props.page.selection.workspaceStartupStatus],
  ([view, status]) => {
    if (view === 'nodes' && status === 'loading') return;
    if (
      restoreRetryFocus &&
      view === 'nodes' &&
      status === 'failed' &&
      document.activeElement === workContent.value
    )
      startupRetry.value?.focus({ preventScroll: true });
    restoreRetryFocus = false;
  },
  { flush: 'post' }
);
const managementComposition = useManagementComposition<ManagementSection>();
const managementPage = computed(() =>
  managementComposition.resolve(props.page.application.managementSection, props.page.identity.admin)
);
const cleanupDialogOpen = ref(false);
const workspaceGrid = ref<HTMLElement>();
const terminalMount = ref<HTMLElement>();
const workspaceTerminalTabs = computed(() =>
  props.page.selection.workspaceTabs.filter(props.page.aside.terminalTabOpen)
);
const asideSurfaceId = `workspace-aside-${useId()}`;
const asideAvailableWidth = ref(0);
const mainMinWidth = 360;
watch(
  workspaceGrid,
  (element, _previous, onCleanup) => {
    if (element == null) {
      asideAvailableWidth.value = 0;
      return;
    }
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
const asideMode = computed(() => {
  const active = props.page.aside.asideState?.active;
  if (
    active?.kind === 'tool' &&
    active.id === 'node-browser' &&
    desktopAsideWidth('content') === undefined
  )
    return 'compact';
  return props.page.aside.asideViewMode(active);
});
const workspaceCapabilitiesLoading = computed(
  () => props.page.resources.nodeManifestLoading && props.page.resources.nodeManifest === undefined
);
const workspaceOffline = computed(
  () =>
    props.page.application.networkUnavailable ||
    props.page.resources.workspaceHost?.connected === false
);
const workspaceRecoveryRetrying = ref(false);
watch(
  [
    () => props.page.application.view,
    () => props.page.selection.workspaceTarget,
    () => props.page.selection.workspaceSelectionLoading,
    workspaceOffline
  ],
  ([view, target, loading, offline], [, previousTarget]) => {
    if (view !== 'nodes' || target !== previousTarget || !loading || offline)
      workspaceRecoveryRetrying.value = false;
  }
);
async function retryWorkspaceRecovery(): Promise<void> {
  if (workspaceRecoveryRetrying.value || props.page.selection.workspaceSelectionLoading) return;
  workspaceRecoveryRetrying.value = true;
  props.page.selection.retryWorkspaceSelection();
  await nextTick();
  if (!props.page.selection.workspaceSelectionLoading) workspaceRecoveryRetrying.value = false;
}
function canShowWorkspaceTabMarkers(nodeId: string): boolean {
  return (
    !props.page.application.networkUnavailable &&
    props.page.resources.nodes.some((node) => node.id === nodeId && node.connected)
  );
}
function workspaceTabRunActivity(nodeId: string, workspaceId: string) {
  return canShowWorkspaceTabMarkers(nodeId)
    ? props.page.notifications.workspaceRunActivity(nodeId, workspaceId)
    : undefined;
}
function workspaceTabHasUnread(nodeId: string, workspaceId: string): boolean {
  return (
    canShowWorkspaceTabMarkers(nodeId) &&
    props.page.notifications.hasUnreadWorkspace(nodeId, workspaceId)
  );
}
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
  props.page.layout.mobileViewport ? asideAvailableWidth.value : desktopAsideWidth(asideMode.value)
);
function desktopAsideWidth(mode: 'compact' | 'content'): number | undefined {
  return props.page.aside.asideWidth(mode, asideAvailableWidth.value, mainMinWidth);
}
watch(
  () => (asideAvailableWidth.value > 0 ? desktopAsideWidth('content') !== undefined : undefined),
  (fits) => props.page.aside.setAsideSessionFits(fits),
  { immediate: true }
);
const treeStatus = computed(() =>
  workspaceOffline.value
    ? 'failed'
    : props.page.application.workspaceWatchTopicStatus.sessionNavigation
);
const collaborationEnabled = computed(
  () => props.page.resources.nodeManifest?.sessionCollaboration === true
);
const asideVisible = computed(
  () =>
    props.page.application.view === 'nodes' &&
    props.page.selection.workspaceTarget !== undefined &&
    props.page.aside.asideState !== undefined &&
    asideWidth.value !== undefined &&
    asideWidth.value > 0 &&
    (props.page.layout.mobileViewport
      ? props.page.layout.mobileWorkspaceSurface === 'inspector' ||
        props.page.layout.mobileWorkspaceSurface === 'terminal'
      : !props.page.aside.asideState.collapsed)
);
watch(asideVisible, (visible) => props.page.aside.setAsideSurfaceVisible(visible), {
  immediate: true
});
onBeforeUnmount(() => {
  props.page.aside.setAsideSurfaceVisible(false);
  props.page.aside.setAsideSessionFits(undefined);
});
const terminalVisible = computed(
  () =>
    asideVisible.value &&
    props.page.aside.asideState?.active?.kind === 'tool' &&
    props.page.aside.asideState.active.id === 'terminal'
);
function openPaneSurface(surface: 'sessions' | 'inspector' | 'terminal'): void {
  if (surface === 'terminal') props.page.aside.toggleAsideTerminal();
  else if (props.page.layout.mobileViewport) props.page.layout.openMobileWorkspaceSurface(surface);
  else if (surface === 'inspector') {
    const target = props.page.selection.workspaceTarget;
    if (target) props.page.aside.setAsideCollapsed(target, asideVisible.value);
  }
}
const asideTools = computed(() => [
  { id: 'node-browser' as const, label: translate('browser.title') },
  { id: 'files' as const, label: translate('generated.workspaceInspector.files3') },
  {
    id: 'search' as const,
    label: translate('generated.workspaceInspector.search'),
    tooltip: props.page.files.contentSearchReady
      ? shortcutTooltip(translate('keyboardShortcuts.focusContentSearch'), workspaceKeys.search)
      : undefined
  },
  {
    id: 'changes' as const,
    label: translate('generated.workspaceInspector.gitChanges'),
    tooltip:
      props.page.files.filesReady &&
      props.page.resources.selectedWorkspace?.kind === 'GIT_WORKSPACE'
        ? shortcutTooltip(translate('keyboardShortcuts.refreshGitChanges'), workspaceKeys.changes)
        : undefined
  },
  { id: 'history' as const, label: translate('generated.workspaceInspector.gitHistory') },
  {
    id: 'terminal' as const,
    label: translate('generated.terminalDock.workspaceTerminal'),
    tooltip: props.page.terminal.terminalReady
      ? shortcutTooltip(translate('keyboardShortcuts.toggleTerminal'), workspaceKeys.terminal)
      : undefined
  }
]);
const asideSessions = computed(() =>
  (props.page.aside.asideState?.sessions ?? []).map((sessionId) => {
    const session = props.page.aside.asideSessionMetadata.find((item) => item.id === sessionId);
    return {
      sessionId,
      title: session?.title ?? sessionId,
      active: session?.activity === 'RUNNING'
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
function readSessionTree() {
  return { tree: props.page.sessionList.sessionNavigationSnapshot?.tree, status: treeStatus.value };
}
const treePopup = ref<{
  nodeId: string;
  workspaceId: string;
  sessionId: string;
  anchor: HTMLElement;
  title: string;
  placement: 'bottom-start' | 'bottom-end';
  collaboration: boolean;
  closing?: ReturnType<typeof readSessionTree>;
}>();
const openTreeSessionId = computed(() =>
  treePopup.value?.closing === undefined ? treePopup.value?.sessionId : undefined
);
const treePopupContent = computed(() => treePopup.value?.closing ?? readSessionTree());
function closeSessionTree(restoreFocus = false): void {
  const previous = treePopup.value;
  if (!previous || previous.closing) return;
  if (previous.collaboration) {
    treePopup.value = undefined;
    props.page.sessionList.setSessionTreeAnchor(undefined);
    return;
  }
  // Keep only the last rendered tree while the Popover fades out.
  previous.closing = readSessionTree();
  props.page.sessionList.setSessionTreeAnchor(undefined);
  if (restoreFocus)
    void nextTick(() => {
      if (!openTreeSessionId.value && previous.anchor.isConnected) previous.anchor.focus();
    });
}
function finishSessionTreeLeave(): void {
  if (treePopup.value?.closing) treePopup.value = undefined;
}
function showSessionTree(
  sessionId: string,
  anchor: HTMLElement,
  title: string,
  placement: 'bottom-start' | 'bottom-end' = 'bottom-start'
): void {
  const target = props.page.selection.workspaceTarget;
  if (!target || !props.page.aside.asideSupported) return;
  if (treePopup.value?.anchor === anchor && !treePopup.value.closing) {
    closeSessionTree(true);
    return;
  }
  treePopup.value = {
    ...target,
    sessionId,
    anchor,
    title,
    placement,
    collaboration: collaborationEnabled.value
  };
  props.page.sessionList.setSessionTreeAnchor(sessionId, treePopup.value.collaboration);
}
function openAsideTarget(target: {
  nodeId: string;
  workspaceId: string;
  sessionId: string;
}): boolean {
  return props.page.aside.openAsideSession(target);
}
function openSessionInPane(sessionId: string, destination: 'aside' | 'main'): boolean {
  const workspace = props.page.selection.workspaceTarget;
  if (!workspace || !props.page.aside.asideSupported) return false;
  const target = { ...workspace, sessionId };
  if (destination === 'aside') return openAsideTarget(target);
  void props.page.selection.openSessionGroupTarget(target);
  return true;
}

// The workbench owns dialogs opened from either Chats or a conversation pane.
const sessionDialog = ref<{
  kind: 'share' | 'prompt';
  session: Session;
  nodeId: string;
  workspaceId: string;
}>();
function openSessionDialog(kind: 'share' | 'prompt' | 'schedule', session: Session): void {
  const target = props.page.selection.workspaceTarget;
  if (target?.workspaceId !== session.workspaceId) return;
  if (kind === 'schedule') {
    emit('openSchedules', {
      scope: { ...target, sessionId: session.externalSessionId ?? session.id },
      title: props.page.sessionList.sessionTitle(session)
    });
    return;
  }
  sessionDialog.value = { kind, session, ...target };
}
watch(
  () => [
    props.page.selection.workspaceTarget?.nodeId,
    props.page.selection.workspaceTarget?.workspaceId,
    props.page.application.view
  ],
  () => (sessionDialog.value = undefined)
);

function titleMenuBindings(session: Session) {
  const { sessionList, aside, resources } = props.page;
  return {
    session,
    canNavigate: aside.asideSupported,
    collaborationEnabled: collaborationEnabled.value,
    navigationDisabled: sessionList.mutationLoading || !resources.nodeReady,
    mutating: sessionList.mutationLoading,
    onRename: () => sessionList.renameSession(session),
    onDialog: (kind: 'share' | 'prompt' | 'schedule') => openSessionDialog(kind, session)
  };
}

function openSessionFromTree(sessionId: string, destination: 'aside' | 'main'): void {
  const popup = treePopup.value;
  const current = props.page.selection.workspaceTarget;
  if (
    !popup ||
    popup.closing ||
    !current ||
    popup.nodeId !== current.nodeId ||
    popup.workspaceId !== current.workspaceId
  )
    return;
  if (openSessionInPane(sessionId, destination)) closeSessionTree(false);
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
    ) {
      closeSessionTree();
      finishSessionTreeLeave();
    }
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
    document.querySelector<HTMLElement>('.workbench-brand'),
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
        settings:
          schedules === undefined &&
          page.application.view !== 'nodes' &&
          page.application.view !== 'conversations',
        standalone: schedules === undefined && page.application.view === 'conversations',
        compact: page.layout.sidebarCollapsed
      }
    ]"
  >
    <template v-if="page.registration.workspaceRegistrationNodeId !== undefined">
      <slot name="workspace-registration">
        <WorkspaceRegistrationPicker
          open
          v-model:preserve-git-config="page.registration.workspacePreserveGitConfig"
          :directory="page.registration.workspaceDirectory"
          :selected-path="page.registration.selectedWorkspaceDirectoryPath"
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
          @close="page.registration.closeWorkspaceRegistration"
        />
      </slot>
    </template>
    <WorkbenchHeader
      :mobile-viewport="page.layout.mobileViewport"
      :view="page.application.view"
      :schedule-section="schedules?.section"
      :schedule-session-scoped="schedules?.session !== undefined"
      :sidebar-collapsed="page.layout.sidebarCollapsed"
      :workspace-startup-blocked="workStartupBlocked"
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
        v-if="
          schedules === undefined &&
          page.application.view === 'nodes' &&
          !page.layout.mobileViewport &&
          !workStartupBlocked
        "
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
          :run-activity="workspaceTabRunActivity"
          :has-unread="workspaceTabHasUnread"
          @activate="page.selection.activateWorkspaceTab"
          @close="page.selection.closeWorkspaceTab"
          @reorder="page.selection.moveWorkspaceTab"
          @pin="page.selection.pinWorkspaceTab"
        />
      </template>
    </WorkbenchHeader>
    <ScheduledTasksPanel
      v-if="schedules !== undefined"
      :key="JSON.stringify([page.identity.admin.userId, schedules.session?.scope])"
      :section="schedules.section"
      :mobile="page.layout.mobileViewport"
      :session="schedules.session"
      :linked-task="schedules.link"
      :request="page.identity.request"
      :invalidation="page.application.scheduleInvalidation"
      @open-target="openScheduledTarget"
      @back-to-all="emit('selectScheduleSection', 'all')"
    />
    <section
      v-show="schedules === undefined && page.application.view === 'nodes'"
      ref="workContent"
      class="session-layout"
      tabindex="-1"
    >
      <div
        v-if="
          page.application.view === 'nodes' && page.selection.workspaceStartupStatus === 'loading'
        "
        class="mar-page-loading-state"
        role="progressbar"
        :aria-label="translate('generated.workbenchSurface.restoringWorkspace')"
      >
        <MarBusyIndicator />
      </div>
      <section
        v-else-if="
          page.application.view === 'nodes' && page.selection.workspaceStartupStatus === 'failed'
        "
        class="welcome-panel compact-welcome workspace-recovery-panel"
      >
        <div class="workspace-recovery-state">
          <p role="status">
            {{ translate('generated.workbenchSurface.nodeListUnavailable') }}
          </p>
          <MarButton ref="startupRetry" @click="retryWorkspaceStartup">
            {{ translate('common.retry') }}
          </MarButton>
        </div>
      </section>
      <section
        v-else-if="
          page.application.view === 'nodes' && page.selection.workspaceTarget === undefined
        "
        class="welcome-panel compact-welcome"
      >
        <h1>{{ translate('generated.workbenchSurface.selectAWorkspace') }}</h1>
        <p>
          {{ translate('generated.workbenchSurface.selectANodeInTheResourceExplorer') }}
        </p>
        <p class="workspace-selection-hint">
          {{ translate('generated.workbenchSurface.noNodeConnectedYetCreateARegistration') }}
          <MarButton link type="primary" @click="page.registration.openNodeRegistration">{{
            translate('generated.workbenchSurface.openNodeManagement')
          }}</MarButton>
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
          :run-activity="workspaceTabRunActivity"
          :has-unread="workspaceTabHasUnread"
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
            v-if="page.selection.workspaceSelectionLoading && !workspaceRecoveryRetrying"
            class="mar-page-loading-state"
            role="status"
            :aria-label="translate('common.loading')"
          >
            <MarBusyIndicator />
          </div>
          <div
            v-else
            class="workspace-recovery-state"
            :class="{ 'is-retrying': workspaceRecoveryRetrying }"
          >
            <p role="status" :aria-hidden="workspaceRecoveryRetrying || undefined">
              {{ translate('generated.workbenchSurface.workspaceMetadataUnavailable') }}
            </p>
            <MarButton
              class="workspace-recovery-retry"
              link
              :aria-busy="workspaceRecoveryRetrying || undefined"
              :aria-disabled="workspaceRecoveryRetrying || undefined"
              :aria-label="workspaceRecoveryRetrying ? translate('common.loading') : undefined"
              @click="retryWorkspaceRecovery"
            >
              <MarBusyIndicator
                v-if="workspaceRecoveryRetrying"
                class="mar-read-loading-indicator"
              />
              <span class="workspace-recovery-retry-label">{{
                translate('common.loadFailedRetry')
              }}</span>
            </MarButton>
          </div>
        </section>
        <div
          ref="workspaceGrid"
          v-else-if="page.resources.selectedWorkspace !== undefined"
          v-show="!workspaceOffline"
          :class="['workspace-grid', `mobile-surface-${page.layout.mobileWorkspaceSurface}`]"
          :style="{ '--aside-width': `${asideVisible ? (asideWidth ?? 0) : 0}px` }"
        >
          <WorkspaceSessionList
            :aside-supported="page.aside.asideSupported"
            :collaboration-enabled="collaborationEnabled"
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
            :search-ready="page.sessionList.workspaceSessionSearchReady"
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
            @open-main="(id) => openSessionInPane(id, 'main')"
            @open-dialog="openSessionDialog"
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
          <SessionShareDialog
            v-if="sessionDialog?.kind === 'share'"
            :key="sessionDialog.session.id"
            :target="{
              nodeId: sessionDialog.nodeId,
              workspaceId: sessionDialog.workspaceId,
              sessionId: sessionDialog.session.id
            }"
            :request="page.identity.request"
            @close="sessionDialog = undefined"
          />
          <SessionPromptDialog
            v-else-if="sessionDialog?.kind === 'prompt'"
            :key="sessionDialog.session.id"
            :node-id="sessionDialog.nodeId"
            :session-id="sessionDialog.session.id"
            :request="page.identity.request"
            @close="sessionDialog = undefined"
          />
          <WorkspaceSessionPane
            :controller="page.mainPaneController"
            :open-browser-link="routeBrowserLink"
            :aside-ready="page.aside.asideState?.active !== undefined"
            :aside-controls="asideSurfaceId"
            :aside-expanded="asideVisible"
            :aside-disabled="!page.layout.mobileViewport && asideWidth === undefined"
            :tree-supported="page.aside.asideSupported"
            :collaboration-enabled="collaborationEnabled"
            :tree-open-session-id="openTreeSessionId"
            :tree-summaries="page.sessionList.sessionNavigationSnapshot?.summaries"
            :tree-status="treeStatus"
            @open-tree="(id, anchor, title) => showSessionTree(id, anchor, title, 'bottom-end')"
            @session-menu-open="closeSessionTree()"
            @open-surface="openPaneSurface"
            @preview-attachment="page.interactions.openAttachmentPreview"
            @reload="page.sessionList.reloadSelectedSession"
          >
            <template #session-menu="{ session }">
              <WorkspaceSessionActionsMenu v-bind="titleMenuBindings(session)" />
            </template>
          </WorkspaceSessionPane>
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
              :id="asideSurfaceId"
              class="workspace-aside"
              tabindex="-1"
              :aria-hidden="!asideVisible"
            >
              <WorkbenchAside
                :inert="!asideVisible"
                :session-location="page.aside.asideSessionLocation"
                :workspace="page.selection.workspaceTarget!"
                :state="page.aside.asideState"
                :tools="asideTools"
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
                    Math.min(
                      WORKBENCH_PANEL_LIMITS[asideMode].max,
                      asideAvailableWidth - mainMinWidth
                    )
                  )
                "
                :mode="asideMode"
                @select-tool="page.aside.selectAsideTool"
                @select-session="page.aside.openAsideSession"
                @close-session="page.aside.closeAsideSession"
                @close-browser="page.aside.closeAsideBrowser"
                @close-terminal="page.aside.closeAsideTerminal"
                @resize="page.layout.setPanelWidth(asideMode, $event)"
                @close-surface="page.layout.closeMobileWorkspaceSurface"
              >
                <template #tool="{ tool, visible }">
                  <WorkspaceNodeBrowser
                    v-if="
                      tool === 'node-browser' &&
                      visible &&
                      asideVisible &&
                      browserCapability &&
                      page.selection.workspaceTarget
                    "
                    :key="
                      JSON.stringify([
                        page.selection.workspaceTarget.nodeId,
                        page.selection.workspaceTarget.workspaceId,
                        browserCapability.nodeGeneration
                      ])
                    "
                    :scope="page.selection.workspaceTarget"
                    :capability="browserCapability"
                    :connected="page.browserConnectionReady()"
                    :direct-description="
                      page.resources.workspaceDirectDescription(
                        page.selection.workspaceTarget.nodeId
                      )
                    "
                    :browser="page.browser"
                    :requested="
                      atBrowserScope(browserDestination?.scope)
                        ? browserDestination?.target
                        : undefined
                    "
                    :restore-id="
                      atBrowserScope(browserReturn) ? browserReturn?.browserId : undefined
                    "
                    @consumed="page.browser.clearDestination"
                    @restored="browserReturn = undefined"
                    @closed="page.aside.closeAsideBrowser"
                    @settings="openBrowserSettings"
                    @data="openBrowserData"
                  />
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
                      class="mar-empty"
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
                    :open-browser-link="routeBrowserLink"
                    :aside-ready="page.aside.asideState?.active !== undefined"
                    :tree-supported="page.aside.asideSupported"
                    :collaboration-enabled="collaborationEnabled"
                    :tree-open-session-id="openTreeSessionId"
                    :tree-summaries="page.sessionList.sessionNavigationSnapshot?.summaries"
                    :tree-status="treeStatus"
                    @open-tree="
                      (id, anchor, title) => showSessionTree(id, anchor, title, 'bottom-end')
                    "
                    @session-menu-open="closeSessionTree()"
                    @open-surface="openPaneSurface"
                    @preview-attachment="page.interactions.openAttachmentPreview"
                    @reload="page.aside.reloadAsideSession"
                  >
                    <template #session-menu="{ session }">
                      <WorkspaceSessionActionsMenu v-bind="titleMenuBindings(session)" />
                    </template>
                  </WorkspaceSessionPane>
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
          v-for="tab in workspaceTerminalTabs"
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
            :open-browser-link="routeBrowserLink"
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
                      closeAll(): Promise<boolean>;
                    }
                  );
              }
            "
            :node-id="tab.nodeId"
            :open-stream="page.terminal.openNodeStream"
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
            @collapse="page.aside.terminalSessionsEnded(tab)"
            @notice="page.application.notice"
          />
        </div>
      </Teleport>
    </section>
    <HostedConversationWorkspacePage
      v-if="schedules === undefined && page.application.view === 'conversations'"
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
    <template v-else-if="schedules === undefined && page.application.view === 'settings'">
      <BrowserSettings
        v-if="page.application.settingsSection === 'browser'"
        :user-id="page.identity.admin.userId"
        :request="page.identity.request"
      />
      <slot v-else name="settings">
        <SettingsContent
          :web-version="page.application.webVersion"
          :pwa-state="page.application.pwaState"
          :checking-for-updates="page.application.checkingForUpdates"
          v-model:new-password="page.identity.newPassword"
          :section="page.application.settingsSection"
          :sessions="page.identity.adminSessions"
          :sessions-refreshing="page.identity.adminSessionsRefreshing"
          :sessions-manual-refresh="page.identity.adminSessionsManualRefresh"
          :sessions-read-state="page.identity.adminSessionsReadState"
          :session-revoking="page.identity.adminSessionRevoking"
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
    <template v-else-if="schedules === undefined && page.application.view === 'management'">
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
            serverVersion: page.resources.serverVersion,
            openNodeRegistrationOnEntry: page.registration.openNodeRegistrationOnEntry === true
          })
        "
        @changed="page.resources.refreshNodes"
        @extension-changed="page.identity.refreshAdmin"
      />
    </template>
    <WorkspaceCollaborationDialog
      v-if="treePopup?.collaboration"
      :key="treePopup.sessionId"
      :anchor="treePopup.sessionId"
      :title="treePopup.title"
      :snapshot="page.sessionList.sessionNavigationSnapshot"
      :status="treeStatus"
      :can-retry="!workspaceOffline && treeStatus === 'failed'"
      @close="closeSessionTree()"
      @open="openSessionFromTree"
      @board="page.sessionList.setCollaborationBoard"
      @retry="page.application.retryWorkspaceWatch"
    />
    <WorkspaceSessionTreePopover
      v-else-if="treePopup"
      :key="treePopup.sessionId"
      :visible="!treePopup.closing"
      :anchor="treePopup.anchor"
      :placement="treePopup.placement"
      :session-id="treePopup.sessionId"
      :title="treePopup.title"
      :tree="treePopupContent.tree"
      :status="treePopupContent.status"
      :can-retry="
        !workspaceOffline &&
        page.application.workspaceWatchTopicStatus.sessionNavigation === 'failed'
      "
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
      @after-leave="finishSessionTreeLeave"
      @open="openSessionFromTree"
      @retry="page.application.retryWorkspaceWatch"
    />
    <BrowserClearDialog
      v-if="browserData?.kind === 'cache' && atBrowserScope(browserData)"
      :browser="page.browser"
      :scope="browserData"
      :expected-live-id="browserData.browserId"
      :scope-label="browserScopeLabel"
      :connected="page.browserConnectionReady()"
      @close="browserData = undefined"
      @cleared="page.application.notice(translate('browser.cleared'), 'success')"
    />
    <BrowserHistoryDialog
      v-if="browserData?.kind === 'history' && atBrowserScope(browserData)"
      :browser="page.browser"
      :scope="browserData"
      :expected-live-id="browserData.browserId"
      :scope-label="browserScopeLabel"
      :connected="page.browserConnectionReady()"
      @close="browserData = undefined"
      @open="openBrowserHistory"
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

.workspace-recovery-state.is-retrying :is(p, .workspace-recovery-retry-label) {
  visibility: hidden;
}

.workspace-recovery-retry {
  position: relative;
}

.workspace-recovery-retry .mar-read-loading-indicator {
  position: absolute;
  inset: 0;
  margin: auto;
}

.workspace-selection-hint {
  color: var(--mar-text-secondary) !important;
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
  color: var(--mar-text-secondary);
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
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}

.workspace-git-panel {
  display: flex;
  height: 100%;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  padding-block-end: 0.7rem;
}

.workbench {
  --workbench-leading-offset: var(--mar-workbench-sidebar-total-width);
  display: flex;
  height: 100vh;
  min-height: 100vh;
  flex-direction: column;
  margin-left: var(--workbench-leading-offset);
  overflow: clip;
  background: var(--mar-bg-panel);
}

.workbench.compact {
  --workbench-leading-offset: var(--mar-activity-rail-width);
}

@media (min-width: 768px) and (prefers-reduced-motion: no-preference) {
  .workspace-grid {
    transition: grid-template-columns var(--mar-motion-duration-collapse)
      var(--mar-motion-easing-collapse);
  }
  .workspace-grid:has(.workbench-aside-resize:active),
  .workspace-grid:has(.workbench-aside-resize.dragging) {
    transition: none;
  }
  .workbench {
    transition: margin-left var(--mar-motion-duration-collapse) var(--mar-motion-easing-collapse);
  }

  .console-shell:has(.workbench-sidebar-resize.dragging) .workbench {
    transition: none;
  }
}

@media (min-width: 768px) {
  .workbench {
    box-sizing: border-box;
    height: calc(100vh - 18px);
    height: calc(100dvh - 18px);
    min-height: 0;
    margin: 9px 9px 9px var(--workbench-leading-offset);
    border: 0;
    border-radius: 0 calc(var(--mar-radius-surface) - 1px) calc(var(--mar-radius-surface) - 1px) 0;
  }

  .workbench.compact {
    --workbench-leading-offset: calc(var(--mar-activity-rail-width) + 9px);
    border-radius: calc(var(--mar-radius-surface) - 1px);
  }

  .session-layout {
    height: auto;
    flex: 1 1 auto;
  }

  .workspace-grid {
    border-bottom: 0;
  }

  .workspace-grid > .conversation-panel {
    padding-block-end: 8px;
  }

  .workbench :deep(.workbench-header),
  .workbench :deep(.conversation-sidebar),
  .workbench :deep(.workbench-aside),
  .inspector-column {
    background: var(--mar-bg-panel);
  }
}

.workbench.settings :deep(.settings-content) {
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
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
  }

  .workspace-grid > .conversation-panel {
    grid-area: 1 / 1;
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
    inset: var(--mar-sidebar-header-height) auto 0 0;
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
    inset: var(--mar-sidebar-header-height) 0 0;
    width: 100% !important;
    min-width: 0;
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
:global(.workspace-selection-hint .mar-ui-button) {
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
