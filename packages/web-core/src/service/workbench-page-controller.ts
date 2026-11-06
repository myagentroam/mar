/**
 * Workbench application composition root.
 * Creates domain owners, connects narrow cross-domain ports, and wires the page lifecycle.
 * Domain state, loading/cache/Watch rules, and resource lifetimes belong to their owners.
 * Resource context is created before file/Panes; Watch collaboration is connected afterwards.
 * Lifecycle activation follows all connections. Forward callbacks are event/action ports only;
 * constructors must not invoke them or read state from a later application aggregate.
 * Do not add shared writable state, flat forwarding APIs, or domain workflows here.
 * Views consume explicit view contracts, not this factory's inferred return type.
 */
import { createWorkbenchWatchRecovery } from './workbench-watch-coordinator.js';
import type { WorkbenchShellView, WorkbenchSurfaceView } from '../view/workbench-contract.js';
import { clearMessages, showMessage } from './message-feedback-service.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import { computed, nextTick, onBeforeUnmount, proxyRefs, ref, shallowRef, watch } from 'vue';
import { createHostedConversationSelectionService } from '@myagentroam/web-core/hosted-selection';
import { createAdminAuthService } from './admin-auth-service.js';
import { createNodeRegistrationService } from './node-registration-service.js';
import { createRunnerUsageService } from './runner-usage-service.js';
import { createRunnerProfileService } from './runner-profile-service.js';
import { createWorkspaceRegistrationService } from './workspace-registration-service.js';
import { createWorkspaceSessionService } from './workspace-session-service.js';
import {
  absoluteSessionTime as formatSessionTime,
  agentSessionPathId,
  errorMessage as message,
  nodePresentation as nodeLabel,
  sessionActivityDateTime,
  workspaceBranchLabel,
  workspaceKindLabel,
  workspaceTabId,
  workspaceTabLabel
} from '../util/workbench-presentation.js';
import { createWorkbenchRouteService } from './workbench-route-service.js';
import { createMobileMenuHistoryService } from './mobile-menu-history-service.js';
import { captureMobileLayerRoute } from './mobile-layer-history-service.js';
import { createWorkbenchEntityService } from './workbench-entity-service.js';
import { parseNodeUpgradeProgress } from '../model/node-upgrade.js';
import { createWorkspaceUploadService } from './workspace-upload-service.js';
import { createWorkbenchLiveService } from './workbench-live-service.js';
import { createWorkbenchDirectTransportCoordinator } from './workbench-direct-transport-coordinator.js';
import { createWebPerformanceDiagnostics } from './web-performance-diagnostic-service.js';
import { createWorkbenchLayoutService } from './workbench-layout-service.js';
import {
  createWorkspaceSessionPane,
  type WorkspaceSessionPaneServices
} from './workspace-session-pane-controller.js';
import {
  createWorkbenchCapabilityService,
  createSelectedNodeStatus
} from './workbench-capability-service.js';
import type { ManagementComposition } from './management-composition.js';
import {
  createWorkbenchNavigationPresentation,
  type WorkbenchNavigationService
} from './workbench-navigation-service.js';
import type { WorkspaceRegistrationInput } from './workspace-registration-service.js';
import type { SettingsSection } from '../model/settings.js';
import type { WorkbenchView } from '../util/workbench-route.js';
import {
  createWorkbenchWebUpdateService,
  createWorkbenchVisibleSessions,
  type WorkbenchNotification
} from './workbench-notification-service.js';
import { createWorkbenchTargetNavigation } from './workbench-notification-navigation-service.js';
import { createSessionSnapshotRefreshService } from './session-snapshot-refresh-service.js';
import { createComposerAttachmentService } from './composer-attachment-service.js';
import { createWorkspaceWatchService } from './workspace-watch-service.js';
import { createWorkspaceWatchProjection } from './workspace-watch-projection.js';
import { createWorkbenchWorkspaceContext } from './workspace-context-service.js';
import { createWorkbenchViewWatchService as createWorkbenchNavigationWatchService } from './workbench-view-watch-service.js';
import { createHostedConversationWatchCoordinator as createWorkbenchWatchCoordinator } from './hosted-conversation-watch-coordinator.js';
import { createWorkspaceFileToolsController } from './workspace-file-tools-controller.js';
import { createWorkspaceFileWorkbenchController } from './workspace-file-workbench-controller.js';
import { createWorkspaceFileAccessService } from './workspace-file-access-service.js';
import { filePreviewErrorMessage } from '../util/error-presentation.js';
import { createWorkbenchSessionSelection } from './workbench-session-selection-service.js';
import { createSessionDraftService } from './session-draft-service.js';
import { asideViewMode, createWorkbenchAsideService } from './workbench-aside-service.js';
import {
  createSessionNavigationProjection,
  sessionNavigationQuery
} from './session-navigation-projection.js';
import { supportsSessionAside } from '../util/node-features.js';
import { createWorkbenchSessionIdentity } from './workbench-session-identity.js';
import { createWorkbenchSubmissionOwner } from './workbench-submission-service.js';
import { createScopedHttpService } from './scoped-http-service.js';
import type { WorkspaceFileWorkbenchHandle } from '../model/workspace-file-workbench.js';

import type { TerminalDockHandle } from './terminal-direct-client.js';
import { createWorkbenchWorkspaceSelection } from './workbench-workspace-selection-service.js';
import { createWorkbenchWorkspaceCache } from './workbench-workspace-cache-controller.js';
import { createWorkbenchWorkspaceTreeController } from './workbench-workspace-tree-controller.js';
import { createWorkbenchPresentationStateService } from './workbench-presentation-state-service.js';
import { createWorkbenchEntityController } from './workbench-entity-controller.js';
import { createWorkbenchPageStateService } from './workbench-base-state-service.js';
import { createWorkbenchPageInteractionService } from './workbench-page-interaction-service.js';
import type { PwaApplicationService } from './pwa-application-service.js';
import { createWorkbenchNewSessionController } from './workbench-new-session-controller.js';
import { installWorkbenchPageLifecycle } from './workbench-page-lifecycle-service.js';
import { createComposerSkillService } from './composer-skill-service.js';
import { createQuickPromptService } from './quick-prompt-service.js';

import { createHostedConversationWorkspaceService } from './hosted-conversation-workspace-service.js';
import { promptCompletionPreferenceService } from './prompt-completion-preference-service.js';
import { PromptCompletionClientService } from './prompt-completion-client-service.js';

import { createWorkspaceTabService } from './workspace-tab-service.js';
import { createWorkspaceTreeService } from './workspace-tree-service.js';
import type { Session, Workspace, NodeWorkbenchManifest } from '../model/workbench.js';
import { WORKSPACE_SESSION_PAGE_SIZE } from '../util/session-list.js';
import { translate, currentLocale, localePreferenceService } from './locale-preference-service.js';
import {
  sessionActivity,
  sessionActivityLabel,
  sessionTitle
} from '../util/session-presentation.js';

const MAX_WORKSPACE_TABS = 8;

const MAX_CACHED_SESSION_DETAILS = 5;

const WORKSPACE_WATCH_HEARTBEAT_MS = 15_000;

const SESSION_WATCH_HEARTBEAT_MS = 15_000;

const SESSION_WATCH_CONFIRMATION_TIMEOUT_MS = 45_000;

const SESSION_WATCH_REQUEST_TIMEOUT_MS = 10_000;

export function createWorkbenchPageController<
  ManagementSection extends string,
  RegistrationContext = void,
  NodeRegistrationContext = void
>(options: {
  readonly navigation: WorkbenchNavigationService<
    WorkbenchView,
    SettingsSection,
    ManagementSection
  >;
  readonly management: Pick<ManagementComposition<ManagementSection>, 'items'>;
  readonly systemManagementSection: ManagementSection;
  readonly nodeManagementSection: ManagementSection;
  readonly webVersion: string;
  readonly pwaApplication?: PwaApplicationService;
  readonly submitWorkspaceRegistration?: (
    request: <T>(path: string, init?: RequestInit) => Promise<T>,
    input: WorkspaceRegistrationInput,
    context: RegistrationContext | undefined
  ) => Promise<unknown>;
  readonly submitNodeRegistration?: (
    request: <T>(path: string, init?: RequestInit) => Promise<T>,
    context: NodeRegistrationContext | undefined
  ) => Promise<{ token: string }>;
}) {
  const managementComposition = options.management;

  function refreshRecentConversationWindow(): Promise<void> {
    return conversationPagingService.refreshRecentConversationTurns();
  }
  const baseState = createWorkbenchPageStateService({
    navigation: options.navigation,
    sessionPageSize: WORKSPACE_SESSION_PAGE_SIZE,
    onUnauthenticated: () => returnToLogin(),
    onWorkspaceRunCompleted: refreshCurrentVisibleTool,
    onNotificationClick: openWorkbenchNotification,
    visibleWorkspaceTargets: () => visibleWorkspaceNotificationTargets(),
    visibleHostedTarget: () => {
      const nodeId = hostedConversationWorkspace.selectedNodeId.value;
      const conversationId = hostedConversationWorkspace.selectedConversationId.value;
      return nodeId === undefined || conversationId === undefined
        ? undefined
        : { nodeId, conversationId };
    }
  });

  const navigationService = baseState.navigation;

  let openNewSessionComposerShortcut = (): void => undefined;
  const {
    view,
    settingsSection,
    managementSection,
    mobileViewport,
    sidebarCollapsed,
    mobileSidebarOpen,
    mobileWorkspaceSurface,
    start: startNavigation,
    dispose: disposeNavigation,
    closeMobileSidebar,
    selectSettings: selectSettingsSection,
    selectManagement: selectManagementSection,
    openMobileWorkspaceSurface,
    closeMobileWorkspaceSurface
  } = navigationService;
  const adminState = baseState.admin;

  const {
    admin,
    loaded: adminLoaded,
    loading,
    sessions: adminSessions,
    newPassword,
    passwordValidationError,
    csrfToken
  } = adminState;

  const workbenchHttpService = baseState.http;

  const { request, renewCsrfToken } = workbenchHttpService;
  const workspaceToolsHttp = createScopedHttpService({
    csrfToken: () => csrfToken.value,
    renewCsrfToken
  });

  const notice = showMessage;
  onBeforeUnmount(clearMessages);
  const submissionOwner = createWorkbenchSubmissionOwner();
  const workspaceSelection = createWorkbenchWorkspaceSelection();
  const workspaceTarget = workspaceSelection.target;
  const sessionSelection = createWorkbenchSessionSelection(workspaceTarget);
  const selectedSessionId = sessionSelection.sessionId;
  const draftSessionOpen = sessionSelection.draftOpen;
  const draftTarget = sessionSelection.draftTarget;
  const drafts = createSessionDraftService({ target: draftTarget });
  const workbenchCapabilityService = createWorkbenchCapabilityService({
    workspaceTarget,
    onNodeConnected: (nodeId) => handleNodeConnected(nodeId, false),
    request,
    notice,
    errorMessage: message
  });

  const {
    nodes,
    serverVersion,
    workspaces,
    manifest: nodeManifest,
    manifestLoading: nodeManifestLoading
  } = workbenchCapabilityService;
  const workspaceContext = createWorkbenchWorkspaceContext({
    workspaceTarget,
    nodes,
    workspaces,
    nodeManifest
  });
  const { selectedWorkspace, workspaceHost, nodeReady, filesReady, terminalReady } =
    workspaceContext;
  const contentSearchReady = computed(() => filesReady.value);
  const codeNavigationReady = computed(() => filesReady.value);
  const codeNavigationPrewarmReady = computed(() => codeNavigationReady.value);
  const fileWriteReady = computed(() => filesReady.value);
  const workspaceNodeId = computed(() => workspaceTarget.value?.nodeId);
  const activeWorkspaceId = computed(() => workspaceTarget.value?.workspaceId);
  const mainSurfaceVisible = computed(
    () => !mobileViewport.value || mobileWorkspaceSurface.value === 'conversation'
  );
  const workbenchConnectionId = ref<string>();
  const watchCoordinator: { current?: ReturnType<typeof createWorkbenchWatchCoordinator> } = {};
  const hostedConversationWorkspace = createHostedConversationWorkspaceService({
    request,
    workbenchConnectionId: () => workbenchConnectionId.value,
    heartbeatMs: SESSION_WATCH_HEARTBEAT_MS,
    requestTimeoutMs: SESSION_WATCH_REQUEST_TIMEOUT_MS,
    confirmationTimeoutMs: SESSION_WATCH_CONFIRMATION_TIMEOUT_MS
  });

  const webPerformanceDiagnostics = createWebPerformanceDiagnostics({
    enabled: () => !mobileViewport.value,
    context: () => ({
      view: view.value,
      ...(workspaceNodeId.value === undefined ? {} : { nodeId: workspaceNodeId.value }),
      ...(activeWorkspaceId.value === undefined ? {} : { workspaceId: activeWorkspaceId.value }),
      ...(selectedSessionId.value === undefined ? {} : { sessionId: selectedSessionId.value })
    })
  });
  const workbenchLiveConnection = createWorkbenchLiveService({
    diagnostics: webPerformanceDiagnostics,
    canConnect: () => admin.value.authenticated && !admin.value.mustChangePassword,
    onEvent: (event) => {
      if (workbenchNotificationService.project(event)) return;
      mainPaneController.events.applyBroadcast(event);
    },
    onNotificationMessage: (message) =>
      workbenchNotificationService.projectServerMessage(message) ||
      hostedConversationWorkspace.projectActivityMessage(message),
    onResyncRequired: handleWorkbenchResync,
    onNodeConnection: (nodeId, connected) => {
      updateNodeConnection(nodeId, connected);
      if (!connected) directTransport.nodeInvalidated(nodeId);
      else void refreshNodes().then(() => directTransport.refresh(nodeId, true));
    },
    onNodeUpgrade: (nodeId, snapshot) => {
      const progress = snapshot === null ? null : parseNodeUpgradeProgress(snapshot);
      if (progress === undefined) return;
      workbenchCapabilityService.applyUpgrade(nodeId, progress);
    },
    onNodeReplaced: (nodeId) => {
      directTransport.nodeInvalidated(nodeId);
      if (nodeId !== workspaceNodeId.value) return;
      showMessage(
        translate('generated.workbenchPageController.aNewerInstanceWithTheSameIdentity'),
        'warning'
      );
    },
    onReconnect: () => {
      if (
        view.value === 'conversations' &&
        hostedConversationWorkspace.selectedConversationId.value !== undefined
      ) {
        void watchCoordinator.current?.restartHostedConversation().catch(() => undefined);
        return;
      }
      if (view.value !== 'nodes') return;
      if (activeWorkspaceId.value !== undefined)
        void watchCoordinator.current?.restartWorkspace(activeWorkspaceId.value);
      if (selectedSessionId.value !== undefined) refreshSelectedSessionSnapshot(0, true);
      asidePaneController.restoreVisibleWatch();
    },
    onConnectionRestored: () => {
      workbenchCapabilityService.clearUpgradeProgress();
      void refreshNodes();
      void workbenchNotificationService.recover().catch(() => undefined);
    },
    onDisconnected: () => {
      watchCoordinator.current?.pause();
      directTransport.connectionLost();
    },
    onReady: (connectionId, resumed) => {
      workbenchConnectionId.value = connectionId;
      directTransport.connectionReady(connectionId, resumed);
      if (
        !resumed &&
        view.value === 'conversations' &&
        hostedConversationWorkspace.selectedConversationId.value !== undefined
      ) {
        void watchCoordinator.current?.beginHostedConversation().catch(() => undefined);
        return;
      }
      if (view.value !== 'nodes') return;
      if (!resumed && activeWorkspaceId.value !== undefined)
        void watchCoordinator.current?.startWorkspace(activeWorkspaceId.value);
      if (!resumed && selectedSessionId.value !== undefined)
        refreshSelectedSessionSnapshot(0, true);
      if (!resumed) asidePaneController.restoreVisibleWatch();
    },
    onWatchEvent: (event) => {
      watchCoordinator.current?.handleEvent(event);
    },
    onDirectMessage: (message) => directTransport.handleDirect(message),
    onTerminalDirectMessage: (message) => directTransport.handleTerminalDirect(message),
    onUnauthenticated: () => returnToLogin(),
    onInvalidMessage: () =>
      notice(translate('generated.workbenchPageController.receivedAnUnreadableLiveUpdate'), 'error')
  });

  const {
    restore: restoreWorkbenchEventCursors,
    connect: connectWorkbenchLive,
    close: closeWorkbenchSocket
  } = workbenchLiveConnection;

  const directTransport = createWorkbenchDirectTransportCoordinator({
    nodes: () => nodes.value,
    selectedNode: () => workspaceNodeId.value,
    discover: async (nodeId) =>
      (
        await request<{ readonly manifest?: NodeWorkbenchManifest }>(
          '/api/nodes/' + encodeURIComponent(nodeId) + '/workbench-capabilities'
        )
      ).manifest,
    sendDirect: (message): boolean => workbenchLiveConnection.sendDirect(message),
    sendTerminalDirect: (message): boolean => workbenchLiveConnection.sendTerminalDirect(message)
  });
  const { workspace: workspaceDirectTransfer, terminal: terminalDirectClient } = directTransport;

  const {
    workspaceDirectAvailable,
    workspaceDirectDescription,
    workspaceLocalFileManagerAvailable
  } = directTransport;

  const fileAccess = createWorkspaceFileAccessService({
    request,
    http: workspaceToolsHttp,
    manifest: (nodeId) => workbenchCapabilityService.restoreNodeManifest(nodeId),
    available: (nodeId) => workspaceDirectAvailable(nodeId),
    direct: workspaceDirectTransfer,
    ...(options.pwaApplication === undefined
      ? {}
      : { activeWorker: options.pwaApplication.activeWorker })
  });

  const workspaceSessionPaging = baseState.paging;

  const { visibleLimits: workspaceSessionVisibleLimits, nextCursors: workspaceSessionNextCursors } =
    workspaceSessionPaging;

  const workbenchNotificationService = baseState.notifications;

  const { start: startWorkbenchNotifications, dispose: disposeWorkbenchNotifications } =
    workbenchNotificationService;
  const webUpdates = createWorkbenchWebUpdateService({
    application: options.pwaApplication,
    notifications: workbenchNotificationService,
    message: showMessage
  });
  const {
    state: pwaState,
    checking: checkingForUpdates,
    start: startWebVersionUpdateCheck,
    check: checkForUpdates,
    apply: applyWebUpdate
  } = webUpdates;

  const composerAttachmentService = createComposerAttachmentService({
    context: () => draftTarget.value,
    notice,
    request,
    csrfToken,
    renewCsrfToken,
    direct: {
      generation: (nodeId) =>
        nodeId === workspaceNodeId.value && nodeManifest.value?.directTransfer?.upload === true
          ? nodeManifest.value.nodeGeneration
          : undefined,
      upload: (input) => {
        return workspaceDirectTransfer.upload(input);
      }
    },
    onUnauthenticated: () => returnToLogin()
  });

  const workbenchAsideService = createWorkbenchAsideService();
  function openHtmlAside(path: string): void {
    const target = workspaceTarget.value;
    if (target === undefined || !workbenchAsideService.current(target).tools.includes('files')) {
      notice(
        translate('generated.workbenchPageInteractionService.filePreviewIsCurrentlyUnavailable'),
        'error'
      );
      return;
    }
    if (workbenchAsideService.current(target).active?.kind === 'session') saveAsideContext();
    if (workbenchAsideService.openHtml(target, path) && mobileViewport.value)
      openMobileWorkspaceSurface('inspector');
  }
  const asideTarget = computed(() => {
    const workspace = workspaceTarget.value;
    if (workspace === undefined) return undefined;
    const active = workbenchAsideService.current(workspace).active;
    return active?.kind === 'session'
      ? { kind: 'session' as const, ...workspace, sessionId: active.sessionId }
      : undefined;
  });
  const mainPaneOwner = createWorkspaceSessionPane({
    draftTarget: draftTarget,
    drafts: drafts,
    attachments: composerAttachmentService,
    submissions: submissionOwner,
    onConversationOverflow: () => void refreshRecentConversationWindow()
  });
  const asidePaneOwner = createWorkspaceSessionPane({
    pane: 'aside',
    draftTarget: asideTarget,
    drafts: drafts,
    attachments: composerAttachmentService,
    submissions: submissionOwner,
    onConversationOverflow: () => reloadAsideSession()
  });
  const mainPane = mainPaneOwner.state;
  const asidePane = asidePaneOwner.state;
  const submissionService = mainPane.submission;

  const {
    skillTokens: composerSkillTokens,
    references: composerFileReferences,
    persist: persistSessionDraft
  } = mainPane.draft;
  const composerSkillTokenService = mainPane.skillTokens;

  // Node has not returned the real Run ID when the first message is sent. Retain the prior activity
  // so the new session appears managed immediately and can recover losslessly if Node rejects it.
  const runService = mainPane.run;

  const { runs } = runService;

  const workspaceSessionDiscovery = createWorkspaceSessionService({
    groupingSupported: () => nodeManifest.value?.sessionGroups?.apiVersion === 1,
    runs,
    workspaceTarget,
    selectedSessionId,
    setSelectedSessionId: sessionSelection.setSession,
    paging: workspaceSessionPaging,
    pageSize: WORKSPACE_SESSION_PAGE_SIZE,
    tabId: workspaceTabId,
    request,
    notice,
    errorMessage: message
  });
  const sessionProjection = workspaceSessionDiscovery.projection;
  const sessions = sessionProjection.sessions;

  const conversationState = mainPane.conversation;

  const {
    turns: conversationTurns,
    contextUsage: sessionContextUsage,
    currentDetailRequest
  } = conversationState;

  const workspaceFileWorkbench = ref<WorkspaceFileWorkbenchHandle | null>();
  const terminalDocks = new Map<string, TerminalDockHandle>();

  const {
    preview: attachmentPreview,
    previewOpen: attachmentPreviewOpen,
    clearAll: clearAllNewSessionAttachments,
    openPreview: openAttachmentPreview
  } = composerAttachmentService;

  const runnerProfileService = createRunnerProfileService({
    workspaceTarget,
    request,
    notice,
    errorMessage: message
  });

  const { profiles: runnerProfiles, loading: runnerProfilesLoading } = runnerProfileService;

  const queueProjection = mainPane.queueProjection;
  const workspaceQueue = queueProjection.queue;

  const conversationProjectionService = conversationState.projection;

  const conversationScrollService = mainPane.scroll;

  const { element: conversationScroll, following: followConversation } = conversationScrollService;

  const workspaceCache = createWorkbenchWorkspaceCache(workspaceTabId);
  const workspaceViewCacheService = workspaceCache.cache;

  const workspaceTreeService = createWorkspaceTreeService({
    persist: persistWorkbenchState
  });

  const { expandedNodeIds, nodeOrder, workspacesByNode, workspaceOrderByNode, draggingWorkspace } =
    workspaceTreeService;
  const orderedNodes = computed(() => workspaceTreeService.orderedNodes(nodes.value));
  function moveNode(nodeId: string, targetIndex: number): void {
    workspaceTreeService.moveNode(nodes.value, nodeId, targetIndex);
  }

  const workspaceTabService = createWorkspaceTabService({
    maxTabs: MAX_WORKSPACE_TABS,
    tabId: workspaceTabId,
    workspaceLabel: workspaceTabLabel,
    nodeLabel,
    onEvict: (tab) => {
      discardWorkspaceViewCache(tab.nodeId, tab.workspaceId);
      workbenchAsideService.clearHtmlWorkspace(tab);
      void terminalDocks.get(tab.id)?.release();
    },
    onChange: persistWorkbenchState
  });

  const workspaceTabs = workspaceTabService.tabs;

  const workbenchLayoutService = createWorkbenchLayoutService({
    sidebarCollapsed,
    expandedNodeIds,
    nodeOrder,
    workspaceOrderByNode,
    workspaceTabs,
    maxWorkspaceTabs: MAX_WORKSPACE_TABS,
    restoreTree: workspaceTreeService.restore,
    restoreTabs: workspaceTabService.restore
  });

  const navigationPresentation = createWorkbenchNavigationPresentation({
    navigation: navigationService,
    management: managementComposition,
    admin,
    defaultManagement: options.systemManagementSection,
    layout: workbenchLayoutService,
    transition: (previous, next) => navigationWatchService.transition(previous, next),
    recoverNotifications: () => workbenchNotificationService.recover()
  });
  const {
    navigationItems,
    settingsItems,
    managementItems,
    selectNavigation,
    hostedConversationMobileFilesOpen,
    hostedConversationMobileHistoryOpen,
    closeHostedConversationMobileHistory,
    closeHostedConversationMobileFiles
  } = navigationPresentation;

  const locked = computed(() => admin.value.authenticated && admin.value.mustChangePassword);

  const composerSkillService = createComposerSkillService({ workspaceTarget, request });
  const composerSkillTargets = composerSkillService;
  const quickPromptService = createQuickPromptService({ request });
  const quickPromptTargets = quickPromptService;
  const completionPreferences = promptCompletionPreferenceService();
  const completionClient = new PromptCompletionClientService({
    request,
    connectionId: () => workbenchConnectionId.value
  });

  const asideSurfaceVisible = ref(false);
  const fileWorkbench: ReturnType<typeof createWorkspaceFileWorkbenchController> =
    createWorkspaceFileWorkbenchController({
      page: () => undefined,
      externalTarget: () => workspaceTarget.value,
      target: () => (filesReady.value ? workspaceTarget.value : undefined),
      fileWriteEnabled: () => fileWriteReady.value,
      prewarmEnabled: () => codeNavigationPrewarmReady.value,
      onPopupBlocked: () =>
        notice(
          translate('generated.workspaceInspector.theBrowserBlockedTheFilePreviewWindow'),
          'error'
        ),
      resolveRepositoryPath: (repositoryPath, worktreePath) =>
        fileTools.git.resolveRepositoryPath(repositoryPath, worktreePath),
      reveal: (path, current) => fileTools.revealFileTree(path, current),
      comparison: (path) => fileTools.git.comparison(path),
      onOpenFailure: (error, path) => notice(filePreviewErrorMessage(error, path), 'error', error),
      onDownloadFailure: (error, path) => fileTools.reportFailure(error, path),
      onRevealFailure: (error) => notice(message(error), 'error', error),
      access: (target) => fileAccess.forWorkspace(target),
      preview: {
        onWritten: (target) => {
          if (
            workspaceTarget.value?.nodeId === target.nodeId &&
            workspaceTarget.value.workspaceId === target.workspaceId
          )
            fileTools.refreshAfterWrite();
        }
      },
      navigation: {
        http: workspaceToolsHttp,
        onFailure: (error) => fileTools.reportFailure(error, translate('fileEditor.definitions')),
        onFileTarget: (target, pageId) => fileWorkbench.openNavigationTarget(target, pageId)
      },
      lifecycle: {
        ready: () => filesReady.value,
        workspaceKind: () => selectedWorkspace.value?.kind,
        isReloadingForUpdate: () => options.pwaApplication?.isReloadingForUpdate() === true,
        bootstrap: {
          authenticated: () => admin.value.authenticated,
          hasNodes: () => nodes.value.length > 0,
          manifestLoading: () => nodeManifestLoading.value,
          selectWorkspace,
          captureRoute: captureMobileLayerRoute
        }
      }
    });
  const fileTools: ReturnType<typeof createWorkspaceFileToolsController> =
    createWorkspaceFileToolsController({
      target: workspaceTarget,
      http: workspaceToolsHttp,
      workspacePath: () => selectedWorkspace.value?.path,
      workspaceKind: () => selectedWorkspace.value?.kind,
      workbench: fileWorkbench,
      updateBranch: (workspaceId, branch) =>
        updateWorkspaceBranch(workspaceTarget.value?.nodeId ?? '', workspaceId, branch),
      queueUploads: (uploads) => queueWorkspaceUploads(uploads),
      notice,
      errorMessage: message,
      cache: () => workspaceViewCacheService,
      ready: () => filesReady.value,
      visible: () => asideSurfaceVisible.value,
      activeTool: () => {
        const target = workspaceTarget.value;
        const active =
          target === undefined ? undefined : workbenchAsideService.current(target).active;
        return active?.kind === 'tool' ? active.id : undefined;
      },
      searchReady: () => contentSearchReady.value,
      historySupported: () => nodeManifest.value?.git?.supportsHistory === true,
      isGit: () => selectedWorkspace.value?.kind === 'GIT_WORKSPACE',
      workspace: () => selectedWorkspace.value,
      updateWorkspace: updateWorkspaceMetadata
    });
  const { files: workspaceFiles, git: workspaceGit, search: workspaceSearch } = fileTools;
  const openWorkspaceGitChange = fileTools.openGitChange;
  const openWorkspaceHistoryDiff = fileTools.openHistoryDiff;
  const adjacentWorkspaceDiff = workspaceGit.adjacentDiff;
  const reportWorkspaceFileFailure = fileTools.reportFailure;
  const loadWorkspaceDiff = fileTools.loadDiff;
  const downloadWorkspaceFile = fileWorkbench.downloadPath;
  const openWorkspaceFileExternal = fileWorkbench.openExternal;
  const openHtmlExternal = fileWorkbench.openHtmlExternal;
  onBeforeUnmount(() => {
    fileTools.dispose();
    fileWorkbench.dispose();
  });

  const sessionPaneServices: WorkspaceSessionPaneServices = {
    view,
    cache: workspaceViewCacheService,
    capabilities: workbenchCapabilityService,
    profiles: runnerProfileService,
    skills: composerSkillService,
    prompts: quickPromptService,
    discovery: workspaceSessionDiscovery,
    mobileViewport,
    selectedWorkspace,
    request,
    notice,
    errorMessage: message,
    ensureDraftSupported: (profiles) => ensureDraftRunnerSupported(profiles),
    connectionId: () => workbenchConnectionId.value,
    workspaceRevision: workspaceSelection.currentSelectionRevision,
    completion: {
      client: completionClient,
      enabled: completionPreferences.enabled,
      ready: nodeReady,
      host: workspaceHost,
      attention: () => workspaceFileWorkbench.value?.predictionAttention?.() ?? []
    },
    files: {
      attachments: (target) => fileAccess.forWorkspace(target).attachments,
      openChange: (intent) => fileWorkbench.openTab(intent),
      openFile: (...args) => openAgentWorkspaceFile(...args)
    },
    identity: { replace: replaceSessionForTarget, transfer: transferSessionSubmission },
    events: {
      invalidateWorkspace: fileTools.invalidateWorkspace,
      onNodeConnected: handleNodeConnected
    },
    watchConnection: {
      waitReady: workbenchLiveConnection.waitForReady,
      connected: () => workbenchLiveConnection.connected.value
    }
  };
  const mainPaneController = mainPaneOwner.connect(sessionPaneServices, {
    kind: 'main',
    visible: mainSurfaceVisible,
    refresh: () => refreshSelectedSessionSnapshot(),
    open: openSession,
    markRead: markVisibleSessionRead,
    navigation: () => workbenchSessionSelectionService,
    selection: sessionSelection,
    saveCurrent: saveCurrentWorkspaceView,
    closeMobile: closeMobileWorkspaceSurface,
    createDraft: (title) => createDraftSession(title),
    beginWatch: (id) => navigationWatchService.requestSessionWatch(id),
    replaceSession
  });
  const asideLoading = asidePane.conversation.loadingInitial;
  const asideVisible = computed(
    () =>
      asideSurfaceVisible.value &&
      asideTarget.value !== undefined &&
      view.value === 'nodes' &&
      (!mobileViewport.value || mobileWorkspaceSurface.value === 'inspector') &&
      supportsSessionAside(
        nodes.value.find((node) => node.id === asideTarget.value?.nodeId)?.nodeAppVersion,
        nodeManifest.value?.sessionAside
      )
  );
  const visibleSessions = createWorkbenchVisibleSessions({
    workspaceTarget,
    selectedWorkspace,
    workspaceHost: computed(() => workspaceHost.value),
    view,
    mainSurfaceVisible,
    draftSessionOpen,
    selectedSessionId,
    mainLoading: mainPane.conversation.loadingInitial,
    asideVisible,
    asideTarget,
    asideLoading,
    markSessionRead: workbenchNotificationService.markSessionRead
  });
  function visibleWorkspaceNotificationTargets() {
    return visibleSessions.targets();
  }
  function markVisibleSessionRead(nodeId: string, workspaceId: string, sessionId: string) {
    return visibleSessions.markRead(nodeId, workspaceId, sessionId);
  }
  const asidePaneController = asidePaneOwner.connect(sessionPaneServices, {
    kind: 'aside',
    target: asideTarget,
    visible: asideVisible,
    refresh: reloadAsideSession,
    open: openAsideTarget,
    markRead: markVisibleSessionRead,
    replaceSession: (target, id) => workbenchSessionSelectionService.replaceAsideSession(target, id)
  });
  const conversationImageService = mainPaneController.images;
  const imagePreviewOwner = shallowRef(conversationImageService);
  for (const images of [mainPaneController.images, asidePaneController.images])
    watch(
      images.previewOpen,
      (open) => {
        if (!open || imagePreviewOwner.value === images) return;
        imagePreviewOwner.value.previewOpen.value = false;
        imagePreviewOwner.value = images;
      },
      { flush: 'sync' }
    );
  const conversationImagePreview = computed({
    get: () => imagePreviewOwner.value.preview.value,
    set: (value) => (imagePreviewOwner.value.preview.value = value)
  });
  const conversationImagePreviewOpen = computed({
    get: () => imagePreviewOwner.value.previewOpen.value,
    set: (value) => (imagePreviewOwner.value.previewOpen.value = value)
  });
  const { retain: retainRunImagePreviews } = conversationImageService;

  const composerConfigurationService = mainPaneController.configuration;
  const { selectedSession } = composerConfigurationService;

  const {
    runner: newSessionRunner,
    modelId: newSessionModel,
    effort: newSessionEffort,
    access: newSessionAccess,
    apply: applyComposerDefaultConfiguration
  } = composerConfigurationService;

  const runnerInteractionService = mainPaneController.runner;

  const composerReferenceService = mainPaneController.references;

  const mainPanePresentation = mainPaneController.presentation;
  const {
    canUseComposer,
    canDeleteSession,
    composerWorking: authoritativeComposerWorking,
    sessionActivityClockNow,
    composerWorkingLabel: authoritativeComposerWorkingLabel,
    documentTitle,
    visibleWorkspaceSessions: unfilteredWorkspaceSessions,
    canLoadMoreWorkspaceSessions: canLoadMoreUnfilteredWorkspaceSessions,
    onlineNodeCount
  } = createWorkbenchPresentationStateService({
    context: workspaceContext,
    workspaceTarget,
    sessions,
    nodes,
    visibleLimits: workspaceSessionVisibleLimits,
    nextCursors: workspaceSessionNextCursors,
    pageSize: WORKSPACE_SESSION_PAGE_SIZE,
    tabId: workspaceTabId,
    workspaceLabel: workspaceTabLabel,
    pane: mainPanePresentation
  });

  const cleanupSessionsEnabled = true;
  const workspaceGitPolicySupported = true;
  const workspaceSessionSearchEnabled = true;

  const { ensureFresh: ensureComposerSkills } = composerSkillService;
  watch(composerSkillTargets.skills, composerSkillTokenService.reconcile);
  watch(
    composerSkillTokens,
    (tokens) => {
      if (tokens.length > 0) ensureComposerSkills();
    },
    { immediate: true }
  );

  const {
    refreshNodes,
    refreshServerCapabilities,
    refreshNodeManifest,
    invalidateNodeManifest,
    retainNodeManifests
  } = workbenchCapabilityService;
  watch(
    [workspaceTabs, workspaceNodeId],
    ([tabs, selected]) =>
      retainNodeManifests(
        new Set([...tabs.map((tab) => tab.nodeId), ...(selected === undefined ? [] : [selected])])
      ),
    { flush: 'sync' }
  );

  const activeWorkspaceTabId = computed(() =>
    workspaceNodeId.value === undefined || activeWorkspaceId.value === undefined
      ? undefined
      : workspaceTabId(workspaceNodeId.value, activeWorkspaceId.value)
  );

  const selectedNodeStatus = createSelectedNodeStatus({
    host: workspaceHost,
    manifest: nodeManifest,
    loading: nodeManifestLoading
  });

  const workbenchEntityActions = createWorkbenchEntityService({
    canDeleteSession,
    beginSubmission: submissionService.begin,
    workspaceTarget,
    request,
    renewCsrfToken,
    sessionPathId: agentSessionPathId,
    nodeLabel,
    sessionTitle,
    notice,
    errorMessage: message
  });

  const workspaceUploadService = createWorkspaceUploadService({
    workspaceTarget,
    csrfToken,
    request,
    renewCsrfToken,
    direct: {
      generation: (nodeId) =>
        nodeId === workspaceNodeId.value && nodeManifest.value?.directTransfer?.upload === true
          ? nodeManifest.value.nodeGeneration
          : undefined,
      upload: (input) => {
        return workspaceDirectTransfer.upload(input);
      }
    },
    onFilesChanged: () => fileTools.invalidate('files'),
    onTaskChanged: workbenchNotificationService.recordUpload
  });

  const {
    tasks: workspaceUploadTasks,
    recoveryInput: workspaceUploadRecoveryInput,
    restore: restoreWorkspaceUploads,
    statusLabel: workspaceUploadStatusLabel,
    queue: queueWorkspaceUploads,
    cancel: cancelWorkspaceUpload,
    retry: retryWorkspaceUpload,
    recover: recoverWorkspaceUpload,
    remove: deleteWorkspaceUpload,
    dispose: disposeWorkspaceUploads
  } = workspaceUploadService;
  const targetNavigation = createWorkbenchTargetNavigation({
    workspaceTarget,
    selectedSessionId,
    sessions,
    selectView: (target) => navigationService.selectView(target, 'preserve-layout'),
    applyWebUpdate,
    closeMobileSidebar,
    selectWorkspace,
    syncWorkspaceSessions: (...args) => workspaceSessionDiscovery.synchronize(...args),
    openHostedConversationTarget: (...args) => openHostedConversationTarget(...args),
    discovery: workspaceSessionDiscovery,
    selection: () => workbenchSessionSelectionService,
    openSession,
    notice
  });
  function openWorkbenchNotification(notification: WorkbenchNotification): Promise<void> {
    return targetNavigation.openWorkbenchNotification(notification);
  }
  const { openRecentRun, openSessionGroupTarget, openNavigatedSession } = targetNavigation;

  async function openSessionFromList(sessionId: string): Promise<void> {
    await workbenchSessionSelectionService.selectSession(sessionId);
  }

  const {
    workspaceViewCache,
    discardWorkspaceViewCache,
    discardNodeViewCaches,
    saveCurrentWorkspaceView: saveMainWorkspaceView,
    restoreWorkspaceView,
    restoreWorkspaceDraft
  } = workspaceCache.connect({
    paging: workspaceSessionPaging,
    sessions,
    captureDetail: mainPane.captureDetail,
    queue: workspaceQueue,
    runner: newSessionRunner,
    modelId: newSessionModel,
    effort: newSessionEffort,
    access: newSessionAccess,
    workspaceTarget,
    selectedSessionId,
    fileWorkbench,
    files: {
      snapshot: () => workspaceFiles.tree.snapshot(),
      restore: fileTools.restoreFiles
    },
    git: {
      snapshot: () => workspaceGit.snapshot(),
      restore: fileTools.restoreGit
    },
    search: { snapshot: fileTools.searchSnapshot, restore: fileTools.restoreSearch },
    restoreDraftConfiguration: applyComposerDefaultConfiguration,
    persistDraft: persistSessionDraft,
    flushConversation: conversationProjectionService.flushPendingTextDeltas,
    maximumDetails: MAX_CACHED_SESSION_DETAILS,
    otherVisibleSessionId: () =>
      view.value === 'nodes' &&
      (!mobileViewport.value || mobileWorkspaceSurface.value === 'inspector')
        ? asideTarget.value?.sessionId
        : undefined
  });
  function saveCurrentWorkspaceView(): void {
    saveAsideContext();
    saveMainWorkspaceView();
  }

  const { paging: conversationPagingService } = mainPaneController.conversationWindow;

  let reactivateConnectedWorkspace = (_nodeId: string): boolean => false;

  function refreshCurrentVisibleTool(nodeId: string, workspaceId: string): void {
    if (
      view.value !== 'nodes' ||
      workspaceNodeId.value !== nodeId ||
      activeWorkspaceId.value !== workspaceId
    )
      return;
    const active = workbenchAsideService.current({ nodeId, workspaceId }).active;
    if (!asideSurfaceVisible.value || active?.kind !== 'tool') return;
    if (active.id === 'changes' || active.id === 'files') fileTools.refreshVisible(active.id);
  }

  const { updateNodeConnection } = mainPaneController.events;

  const navigationWatchService = createWorkbenchNavigationWatchService({
    coordinator: () => watchCoordinator.current,
    currentView: () => view.value,
    workspaceTarget: () => workspaceTarget.value,
    selectedSessionId: () => selectedSessionId.value,
    selectedHostedConversationId: () => hostedConversationWorkspace.selectedConversationId.value
  });

  const hostedConversationSelection = createHostedConversationSelectionService({
    workspace: hostedConversationWorkspace,
    markRead: (nodeId, conversationId) =>
      workbenchNotificationService.markConversationRead(nodeId, conversationId),
    coordinator: () => watchCoordinator.current
  });
  const selectHostedConversation = hostedConversationSelection.select;
  const openHostedConversationTarget = hostedConversationSelection.openTarget;
  const clearHostedConversation = hostedConversationSelection.clear;

  async function restoreHostedConversationRoute(): Promise<void> {
    const target = hostedConversationRoute;
    if (target === undefined || view.value !== 'conversations') return;
    try {
      await hostedConversationSelection.restoreTarget(target, syncWorkbenchRoute);
    } finally {
      restoringHostedConversationRoute.value = false;
    }
  }

  const adminAuthService = createAdminAuthService({
    presentation: {
      translate,
      currentLocale,
      setLocale: (locale) => localePreferenceService().setLocale(locale)
    },
    admin,
    loaded: adminLoaded,
    sessions: adminSessions,
    password: newPassword,
    passwordError: passwordValidationError,
    csrfToken,
    loading,
    request,
    renewCsrfToken,
    onAuthenticated: handleAuthenticated,
    invalidateRequests: () => {
      clearMessages();
      workbenchHttpService.invalidateAuthentication();
    },
    onSignedOut: handleSignedOut,
    notice,
    errorMessage: message
  });

  const {
    authenticationUnknown,
    restoring: authenticationRestoring,
    returnToLogin,
    refresh: refreshAdmin,
    refreshSessions: refreshAdminSessions
  } = adminAuthService;

  const runnerUsageService = createRunnerUsageService({
    request,
    error: (value, cause) => showMessage(value, 'error', cause),
    errorMessage: message
  });

  const {
    nodeDetails,
    detailsOpen: nodeDetailsDialogOpen,
    loading: runnerUsageLoading,
    details: runnerUsageDetails,
    usageOpen: runnerUsageDialogOpen,
    openNode: showNodeDetails,
    disabledReason: runnerUsageDisabledReason,
    show: showRunnerUsage,
    clearNode: clearNodeDetails
  } = runnerUsageService;

  const workspaceRegistrationNodeId = ref<string>();
  const workspaceRegistrationNode = computed(() =>
    nodes.value.find((node) => node.id === workspaceRegistrationNodeId.value)
  );
  const workspaceRegistrationReady = computed(
    () =>
      workspaceRegistrationNode.value?.connected === true &&
      workspaceRegistrationNode.value.disabled !== true
  );

  const workspaceRegistrationService = createWorkspaceRegistrationService<RegistrationContext>({
    ...(options.submitWorkspaceRegistration === undefined
      ? {}
      : {
          submit: (input: WorkspaceRegistrationInput, context: RegistrationContext | undefined) =>
            options.submitWorkspaceRegistration!(request, input, context)
        }),
    targetNodeId: workspaceRegistrationNodeId,
    request,
    onRegistered: async (nodeId, workspaceId) => {
      closeWorkspaceRegistration();
      await selectWorkspace({ nodeId, workspaceId });
    },
    notice,
    error: (value, cause) => showMessage(value, 'error', cause),
    errorMessage: message
  });

  const {
    path: workspacePath,
    preserveGitConfig: workspacePreserveGitConfig,
    pendingDirectoryName: pendingWorkspaceDirectoryName,
    directory: workspaceDirectory,
    loadingDirectory: loadingWorkspaceDirectory,
    openTools: openWorkspaceTools,
    selectedPathValid: selectedWorkspaceDirectorySelectable,
    reset: resetWorkspaceRegistration,
    load: loadWorkspaceDirectories,
    select: selectWorkspaceDirectory,
    selectPendingDirectory: selectPendingWorkspaceDirectory,
    discardPendingDirectory: discardPendingWorkspaceDirectory,
    register: registerWorkspace
  } = workspaceRegistrationService;

  const {
    currentGroup: workspaceSessionGroup,
    selectGroup: selectWorkspaceSessionGroup,
    refreshing: refreshingWorkspaceSessions,
    searchQuery: workspaceSessionSearchQuery,
    searching: searchingWorkspaceSessions,
    preserveManagedActive: preserveManagedActiveSession,
    merge: mergeSessions,
    applySnapshot: applyWorkspaceSessionSnapshot,
    loadMore: loadMoreWorkspaceSessions,
    search: searchWorkspaceSessions,
    synchronize: syncWorkspaceSessions,
    refresh: refreshWorkspaceSessions
  } = workspaceSessionDiscovery;
  const {
    visible: visibleWorkspaceSessions,
    canLoadMore: canLoadMoreWorkspaceSessions,
    loadingMore: loadingMoreVisibleWorkspaceSessions,
    loadMoreError: loadMoreWorkspaceSessionsError,
    loadMore: loadMoreVisibleWorkspaceSessions
  } = workspaceSessionDiscovery.createVisibleList({
    unfiltered: unfilteredWorkspaceSessions,
    canLoadMore: canLoadMoreUnfilteredWorkspaceSessions
  });

  let authenticationRestoreGeneration = 0;

  async function restoreAuthenticatedRoute(generation: number): Promise<void> {
    await refreshNodes();
    if (generation !== authenticationRestoreGeneration) return;
    connectWorkbenchLive();
    if (
      !(await workbenchLiveConnection.waitForReady()) ||
      generation !== authenticationRestoreGeneration
    )
      return;
    await restoreWorkbenchRoute();
    if (generation !== authenticationRestoreGeneration) return;
    await restoreHostedConversationRoute();
  }

  async function handleAuthenticated(): Promise<void> {
    const generation = ++authenticationRestoreGeneration;
    startWebVersionUpdateCheck();
    void refreshServerCapabilities();
    // Notification snapshots and version display must not delay the active session.
    // Keep notification navigation/read reconciliation after both initial reads finish.
    await Promise.all([startWorkbenchNotifications(), restoreAuthenticatedRoute(generation)]);
    if (generation !== authenticationRestoreGeneration) return;
    const openedSystemNotification =
      await workbenchNotificationService.openPendingSystemNotification();
    if (generation !== authenticationRestoreGeneration) return;
    if (!openedSystemNotification && view.value === 'nodes')
      void workbenchNotificationService.markVisibleRead();
  }

  function handleSignedOut(): void {
    workbenchAsideService.clearHtml();
    clearMessages();
    authenticationRestoreGeneration += 1;
    void workbenchNotificationService.systemNotifications.invalidatePush();
    disposeWorkbenchNotifications();
    webUpdates.stop();
    watchCoordinator.current?.dispose();
    hostedConversationWorkspace.clearSelectedConversation();
    directTransport.reset();
    closeWorkbenchLive();
    workbenchCapabilityService.resetResources();
    workbenchWorkspaceSelectionService.clear();
    retainNodeManifests(new Set());
  }

  function persistWorkbenchState(): void {
    workbenchLayoutService.persist();
  }

  function restoreWorkbenchState(): void {
    workbenchLayoutService.restore();
  }

  const {
    loading: workspaceTreeLoading,
    updateWorkspaceBranch,
    updateWorkspaceMetadata: updateWorkspaceMetadataCache,
    rememberWorkspace,
    closeWorkspaceTab,
    closeUnpinnedWorkspaceTabs,
    activateWorkspaceTab,
    openWorkspaceTab,
    orderedWorkspaces,
    toggleNodeExpansion,
    refreshNodeWorkspaces,
    refreshWorkspaceTree,
    openWorkspaceFromTree,
    startWorkspaceDrag,
    reorderWorkspace,
    moveWorkspaceToGroup,
    moveWorkspaceGroup,
    renameWorkspace,
    cleanupWorkspaceSessions,
    removeWorkspace
  } = createWorkbenchWorkspaceTreeController({
    nodes,
    workspaces,
    replaceWorkspaces: workbenchCapabilityService.replaceWorkspaces,
    sessions,
    removeWorkspaceSessions: sessionProjection.removeWorkspace,
    workspaceTarget,
    selectedSessionId,
    activeTabId: activeWorkspaceTabId,
    showWorkbench: () => {
      navigationService.selectView('nodes', 'preserve-layout');
    },
    notice,
    workspacesByNode,
    tabs: workspaceTabService,
    tree: workspaceTreeService,
    releaseTerminalDock: (tabId) => void terminalDocks.get(tabId)?.release(),
    deleteTerminalDock: (tabId) => terminalDocks.delete(tabId),
    request,
    saveCurrent: saveCurrentWorkspaceView,
    discardCache: (nodeId, workspaceId) => {
      discardWorkspaceViewCache(nodeId, workspaceId);
      workbenchAsideService.clearHtmlWorkspace({ nodeId, workspaceId });
    },
    activateWorkspace: (target, restoreSession) => selectWorkspace(target, restoreSession),
    workspaceTabSession: workbenchNotificationService.workspaceTabSession,
    openWorkspaceTabSession: (sessionId) => openNavigatedSession(sessionId, true),
    clearWorkspace: () => workbenchWorkspaceSelectionService.clear(),
    currentSelectionRevision: () => workbenchWorkspaceSelectionService.currentSelectionRevision(),
    cleanupSessionsEnabled: () => cleanupSessionsEnabled,
    refreshWorkspaceSessions: syncWorkspaceSessions,
    refreshNodes,
    closeMobileSidebar,
    closeMobileWorkspaceSurface,
    errorMessage: message,
    tabLabel: workspaceTabLabel
  });
  function updateWorkspaceMetadata(nodeId: string, value: Workspace): void {
    const previous = (
      nodeId === workspaceNodeId.value ? workspaces.value : (workspacesByNode.value[nodeId] ?? [])
    ).find((workspace) => workspace.id === value.id);
    updateWorkspaceMetadataCache(nodeId, value);
    if (
      nodeId === workspaceNodeId.value &&
      value.id === activeWorkspaceId.value &&
      previous?.kind !== value.kind
    )
      void watchCoordinator.current?.restartWorkspace(value.id);
  }

  const {
    closeQuickOpenFile,
    quickOpenFileVisible,
    workspaceShortcuts,
    openAgentWorkspaceFile,
    openQuickWorkspaceFile,
    runnerBrandIcon,
    sessionActivityTitle,
    sessionRelativeActivity,
    workspaceTabNodeLabel
  } = createWorkbenchPageInteractionService({
    selectedSessionId,
    view,
    nodes,
    workspaceTabs,
    activeWorkspaceTabId,
    activateWorkspaceTab,
    closeWorkspaceTab,
    closeUnpinnedWorkspaceTabs,
    workspaceTarget,
    selectedWorkspace,
    nodeReady,
    openNewSessionComposer: () => openNewSessionComposerShortcut(),
    filesReady,
    contentSearchReady,
    terminalReady,
    workspaceFileWorkbench,
    fileWorkbench,
    openWorkspaceFileExternal,
    showAsideTool: (tool) => {
      const target = workspaceTarget.value;
      if (target === undefined) return;
      const active = workbenchAsideService.current(target).active;
      const refreshChanges =
        tool === 'changes' &&
        asideSurfaceVisible.value &&
        active?.kind === 'tool' &&
        active.id === 'changes';
      selectAsideTool({ ...target, id: tool });
      // Entering Changes loads via the surface lifecycle; reselecting needs an explicit refresh.
      if (refreshChanges) void fileTools.git.loadChanges(true);
      void nextTick(() => {
        if (tool === 'search') fileTools.focusSearch();
      });
    },
    openAttachmentImage: conversationImageService.openFileAttachment,
    openHtml: openHtmlAside,
    openHtmlExternal,
    toggleTerminal: () => toggleAsideTerminal(),
    sessionActivityClockNow,
    notice,
    formatSessionTime
  });

  async function openQuickWorkspace(nodeId: string, workspaceId: string): Promise<boolean> {
    const existing = workspaceTabs.value.find(
      (tab) => tab.nodeId === nodeId && tab.workspaceId === workspaceId
    );
    if (existing !== undefined) return activateWorkspaceTab(existing);
    return selectWorkspace({ nodeId, workspaceId });
  }

  const composerController = mainPaneController.composer;

  const {
    loadProfiles: loadRunnerProfiles,
    applyDefaults: applyRunnerDefaults,
    normalize: normalizeNewSessionOptions
  } = composerController;

  const sessionTreeAnchor = ref<string>();
  const sessionNavigation = createSessionNavigationProjection((workspace, missing) => {
    workbenchSessionSelectionService.removeMissingAside(workspace, missing);
  });
  const navigationQuery = computed(() => {
    const target = workspaceTarget.value;
    if (target === undefined) return undefined;
    const aside = workbenchAsideService.current(target);
    const visibleTreeAnchors: string[] = [];
    if (
      (!mobileViewport.value || mobileWorkspaceSurface.value === 'conversation') &&
      !draftSessionOpen.value &&
      selectedSessionId.value !== undefined
    )
      visibleTreeAnchors.push(selectedSessionId.value);
    if (
      (!mobileViewport.value || mobileWorkspaceSurface.value === 'inspector') &&
      aside.active?.kind === 'session'
    )
      visibleTreeAnchors.push(aside.active.sessionId);
    return sessionNavigationQuery({
      enabled: supportsSessionAside(
        nodes.value.find((node) => node.id === target.nodeId)?.nodeAppVersion,
        nodeManifest.value?.sessionAside
      ),
      asideSessionIds: aside.sessions,
      visibleTreeAnchors,
      treeAnchor: sessionTreeAnchor.value
    });
  });

  const workspaceWatchProjection = createWorkspaceWatchProjection({
    workspaceTarget,
    navigation: { query: () => navigationQuery.value, accept: sessionNavigation.accept },
    files: fileTools,
    updateBranch: updateWorkspaceBranch,
    sessions: {
      current: sessions,
      selectedId: selectedSessionId,
      applySnapshot: applyWorkspaceSessionSnapshot,
      reconcile: mainPaneController.watch.reconcileWorkspaceSnapshot
    }
  });
  const workspaceWatchService = createWorkspaceWatchService({
    sessionGroup: () => workspaceSessionGroup.value,
    sessionNavigation: () => navigationQuery.value,
    workspaceTarget,
    workspaces,
    heartbeatMs: WORKSPACE_WATCH_HEARTBEAT_MS,
    enabled: () => true,
    workbenchConnectionId: () => workbenchConnectionId.value,
    request,
    onSnapshot: workspaceWatchProjection.accept
  });

  watch(
    [workspaceTarget, workspaceSessionGroup] as const,
    ([target, group], [previousTarget, previousGroup]) => {
      if (
        target !== undefined &&
        target.nodeId === previousTarget?.nodeId &&
        target.workspaceId === previousTarget?.workspaceId &&
        group !== previousGroup
      )
        void watchCoordinator.current?.startWorkspace(target.workspaceId);
    }
  );

  function selectWorkspace(target: WorkspaceTarget, openDraft = true): Promise<boolean> {
    return workbenchWorkspaceSelectionService.select(target, openDraft);
  }

  const workbenchWorkspaceSelectionService = workspaceSelection.connect({
    selectedSessionId,
    setSelectedSessionId: sessionSelection.setSession,
    workspaces,
    replaceWorkspaces: workbenchCapabilityService.replaceWorkspaces,
    sessions,
    replaceSessions: workspaceSessionDiscovery.replaceSessions,
    draftOpen: draftSessionOpen,
    setDraftOpen: sessionSelection.setDraftOpen,
    profilesLoading: runnerProfilesLoading,
    isCacheActive: workspaceViewCacheService.isActive,
    hasNode: (nodeId) => nodes.value.some((node) => node.id === nodeId),
    isHostAvailable: (nodeId) =>
      nodes.value.some((node) => node.id === nodeId && node.connected && !node.disabled),
    cachedWorkspaces: workspaceTreeService.workspacesForNode,
    cacheWorkspaces: workspaceTreeService.cacheWorkspaces,
    rememberTarget: (target) =>
      workspaceTabService.rememberTarget(
        target,
        nodes.value.find((node) => node.id === target.nodeId)
      ),
    invalidateWorkspace: (target) => {
      const tab = workspaceTabs.value.find(
        (candidate) =>
          candidate.nodeId === target.nodeId && candidate.workspaceId === target.workspaceId
      );
      if (
        workspaceTarget.value?.nodeId === target.nodeId &&
        workspaceTarget.value.workspaceId === target.workspaceId
      ) {
        workspaceViewCacheService.deactivate();
        watchCoordinator.current?.stopWorkspace();
        watchCoordinator.current?.stopSession();
      }
      discardWorkspaceViewCache(target.nodeId, target.workspaceId);
      workbenchAsideService.clearHtmlWorkspace(target);
      if (tab !== undefined) closeWorkspaceTab(tab, true);
      else if (
        workspaceTarget.value?.nodeId === target.nodeId &&
        workspaceTarget.value.workspaceId === target.workspaceId
      )
        workbenchWorkspaceSelectionService.clear();
    },
    deactivateCache: workspaceViewCacheService.deactivate,
    clearContent: mainPane.clearSelection,
    showWorkbench: () => {
      navigationService.selectView('nodes', 'preserve-layout');
    },
    closeSidebar: closeMobileSidebar,
    restoreProfiles: runnerProfileService.restore,
    selectManifestNode: workbenchCapabilityService.selectNode,
    refreshManifest: refreshNodeManifest,
    refreshTransport: (nodeId) => void directTransport.refresh(nodeId, true),
    request,
    notice,
    errorMessage: message,
    stopWatch: () => {
      watchCoordinator.current?.stopWorkspace();
      watchCoordinator.current?.stopSession();
    },
    startWatch: (workspaceId: string) =>
      watchCoordinator.current?.startWorkspace(workspaceId) ?? Promise.resolve(),
    saveCurrent: saveCurrentWorkspaceView,
    activateCache: workspaceViewCacheService.activate,
    restoreWorkspaceView,
    refreshVisibleTool: (nodeId, workspaceId) => {
      void nextTick(() => {
        refreshCurrentVisibleTool(nodeId, workspaceId);
      });
    },
    initializePaging: workspaceSessionPaging.initialize,
    tabId: workspaceTabId,
    rememberWorkspace,
    viewCache: workspaceViewCache,
    resetQueue: queueProjection.reset,
    openSession,
    openDraft: () => openDraftSessionComposer(),
    restoreDraft: (cache) => {
      restoreWorkspaceDraft(cache);
    },
    hasProfiles: runnerProfileService.has,
    loadProfiles: loadRunnerProfiles,
    takeRestoredSelection: workspaceTabService.takeRestoredSelection,
    restoreSession: (workspaceId, sessionId) =>
      workbenchRouteService.restoreSession(workspaceId, sessionId)
  });

  reactivateConnectedWorkspace = (nodeId) => {
    const target = workspaceTarget.value;
    if (target?.nodeId !== nodeId) return false;
    void selectWorkspace(target);
    return true;
  };

  const { standaloneFileMode, standaloneFileLoading, standaloneFileError } =
    fileWorkbench.standalone!;

  const workbenchSessionSelectionService = sessionSelection.connect({
    secondaryPane: {
      target: asideTarget,
      reloadChecked: () => asidePaneController.secondary!.reloadChecked()
    },
    pane: mainPaneController.opening!,
    aside: workbenchAsideService,
    canOpenAside: () =>
      supportsSessionAside(
        nodes.value.find((node) => node.id === workspaceNodeId.value)?.nodeAppVersion,
        nodeManifest.value?.sessionAside
      ),
    saveAside: () => saveAsideContext(),
    sessions,
    closeMobileSurface: closeMobileWorkspaceSurface,
    workspaceTabId,
    ensureSessionVisible: workspaceSessionPaging.ensureVisible,
    markSessionRead: markVisibleSessionRead,
    saveCurrent: saveCurrentWorkspaceView,
    selectWorkspace
  });

  const workbenchRouteService = createWorkbenchRouteService({
    nodes,
    sessions,
    workspaceTarget,
    selectedSessionId,
    setSelectedSessionId: sessionSelection.setSession,
    selectedHostedNodeId: hostedConversationWorkspace.selectedNodeId,
    selectedHostedConversationId: hostedConversationWorkspace.selectedConversationId,
    view,
    managementSection,
    activateWorkspace: (target) => selectWorkspace(target, false),
    synchronizeSessions: async (workspaceId) =>
      (await syncWorkspaceSessions(workspaceId, true))?.sessions,
    openSession,
    lookupSession: async (nodeId, sessionId) => {
      const result = await request<{ session: Session }>(
        `/api/agent-sessions/${agentSessionPathId(sessionId)}?nodeId=${encodeURIComponent(nodeId)}`
      );
      return result.session;
    },
    openDraft: () => openDraftSessionComposer(),
    notice: (error) => notice(message(error), 'error', error),
    currentSelectionRevision: () =>
      currentDetailRequest() + workbenchWorkspaceSelectionService.currentSelectionRevision(),
    rememberSession: workspaceTabService.rememberSession
  });

  const {
    restore: restoreWorkbenchRoute,
    sync: syncWorkbenchRoute,
    hostedConversationRoute
  } = workbenchRouteService;
  const mobileMenuHistory = createMobileMenuHistoryService({
    isOpen: () =>
      mobileViewport.value &&
      (mobileSidebarOpen.value ||
        hostedConversationMobileHistoryOpen.value ||
        hostedConversationMobileFilesOpen.value ||
        mobileWorkspaceSurface.value !== 'conversation'),
    close: () => {
      closeMobileSidebar();
      closeHostedConversationMobileHistory();
      closeHostedConversationMobileFiles();
      closeMobileWorkspaceSurface();
    },
    syncRoute: syncWorkbenchRoute
  });
  const restoringHostedConversationRoute = ref(hostedConversationRoute !== undefined);

  const { renameSession, setSessionPinned, movePinnedSession, movePinnedSessionTo, deleteSession } =
    createWorkbenchEntityController({
      actions: workbenchEntityActions,
      replaceNode: workbenchCapabilityService.replaceNode,
      removeNode: workbenchCapabilityService.removeNode,
      sessions,
      removeSessionId: sessionProjection.removeId,
      clearSessions: () => sessionProjection.replaceAll([]),
      clearActiveSelection: mainPane.clearSelection,
      clearRuns: mainPane.clearRuns,
      workspaceTarget,
      selectedSessionId,
      setSelectedSessionId: sessionSelection.setSession,
      workspaces,
      replaceWorkspaces: workbenchCapabilityService.replaceWorkspaces,
      clearWorkspace: () => workbenchWorkspaceSelectionService.clear(),
      caches: workspaceViewCacheService,
      tabs: workspaceTabService,
      tree: workspaceTreeService,
      replaceSession,
      refreshSessions: refreshWorkspaceSessions,
      discardNodeCaches: (nodeId) => {
        discardNodeViewCaches(nodeId);
        workbenchAsideService.clearHtmlNode(nodeId);
      },
      openDraft: () => openDraftSessionComposer(),
      replaceUrl: syncWorkbenchRoute,
      clearNodeDetails
    });

  function openNodeRegistration(): void {
    navigationService.selectView('management', 'preserve-layout');
    selectManagementSection(options.nodeManagementSection);
  }

  function closeWorkspaceRegistration(): void {
    workspaceRegistrationNodeId.value = undefined;
    resetWorkspaceRegistration();
  }

  async function addWorkspaceForNode(nodeId: string): Promise<void> {
    closeMobileSidebar();
    navigationService.selectView('nodes', 'preserve-layout');
    workspaceRegistrationNodeId.value = nodeId;
    resetWorkspaceRegistration(true);
    await loadWorkspaceDirectories();
  }

  const {
    createDraftSession,
    ensureDraftRunnerSupported,
    openNewSessionComposer: openDraftSessionComposer
  } = createWorkbenchNewSessionController({
    workspaceTarget,
    selectedSessionId,
    setSelectedSessionId: sessionSelection.setSession,
    selectedWorkspace,
    sessions,
    prependSession: sessionProjection.prepend,
    prepareDraft: mainPaneController.prepareDraft,
    focusDraft: mainPaneController.focusDraft,
    draftSessionOpen,
    setDraftOpen: sessionSelection.setDraftOpen,
    newSessionRunner,
    newSessionModel,
    newSessionEffort,
    newSessionAccess,
    runnerProfiles,
    canUseComposer,
    closeMobileWorkspaceSurface,
    saveCurrent: saveCurrentWorkspaceView,
    stopSelectedSessionWatch,
    applyRunnerDefaults
  });
  function openNewSessionComposer(): void {
    // Explicit New starts a main session; restoring an empty Workspace keeps its group.
    selectWorkspaceSessionGroup('MAIN');
    openDraftSessionComposer();
  }
  openNewSessionComposerShortcut = openNewSessionComposer;

  const nodeRegistration = createNodeRegistrationService<NodeRegistrationContext>({
    request,
    ...(options.submitNodeRegistration === undefined
      ? {}
      : { submit: options.submitNodeRegistration }),
    notice,
    errorMessage: message
  });
  const registrationToken = nodeRegistration.token;
  const registrationLoading = nodeRegistration.pending;
  const createRegistrationToken = nodeRegistration.create;

  watch(
    [view, settingsSection, () => admin.value.authenticated, () => admin.value.mustChangePassword],
    ([currentView, currentSection, authenticated, mustChangePassword]) => {
      if (
        currentView === 'settings' &&
        currentSection === 'account' &&
        authenticated &&
        !mustChangePassword
      )
        void refreshAdminSessions();
    },
    { immediate: true }
  );

  async function openSession(
    sessionId: string,
    options: Parameters<typeof workbenchSessionSelectionService.openSession>[1] = {}
  ): Promise<void> {
    return workbenchSessionSelectionService.openSession(sessionId, options);
  }

  function reloadSelectedSession(): void {
    if (selectedSessionId.value !== undefined) void openSession(selectedSessionId.value);
  }

  const sessionHistoryMutation = mainPaneController.history;

  const sessionWatchController = mainPaneController.watch;
  watchCoordinator.current = createWorkbenchWatchCoordinator({
    workspace: workspaceWatchService,
    session: sessionWatchController,
    secondary: asidePaneController.watch,
    hosted: hostedConversationWorkspace
  });
  mainPaneOwner.connectWatchCoordinator(watchCoordinator.current);
  asidePaneOwner.connectWatchCoordinator(watchCoordinator.current);
  function saveAsideContext(): void {
    asidePaneController.secondary!.save();
  }
  const asideLifecycle = asidePaneController.secondary!;
  function reloadAsideSession(): void {
    void asideLifecycle.reload();
  }
  function openAsideTarget(sessionId: string): Promise<void> {
    return workbenchSessionSelectionService.openAsideTarget(sessionId);
  }
  workbenchAsideService.observeCapabilities({
    workspace: workspaceTarget,
    manifest: nodeManifest,
    selectedWorkspace
  });
  const {
    select: selectAsideTool,
    openBrowser: selectAsideBrowser,
    closeBrowser: closeAsideBrowser,
    toggleTerminal: toggleAsideTerminal
  } = workbenchAsideService.createInteraction({
    workspace: workspaceTarget,
    mobile: mobileViewport,
    mobileSurface: mobileWorkspaceSurface,
    saveSession: saveAsideContext,
    openMobile: openMobileWorkspaceSurface
  });

  watch(
    navigationQuery,
    () => {
      const target = workspaceTarget.value;
      if (
        target !== undefined &&
        view.value === 'nodes' &&
        workbenchLiveConnection.connected.value &&
        workbenchConnectionId.value !== undefined
      )
        void watchCoordinator.current?.startWorkspace(target.workspaceId);
    },
    { deep: true }
  );

  function canWatchSessionHistory(session: Session): boolean {
    return sessionWatchController.canWatchSessionHistory(session);
  }

  function stopSelectedSessionWatch(): void {
    watchCoordinator.current?.stopSession();
  }

  function handleSessionWatchVisibility(): void {
    watchRecovery.handleVisibility();
  }

  const sessionIdentity = createWorkbenchSessionIdentity({
    workspaceTarget,
    submissions: submissionOwner,
    projection: {
      sessions,
      selectedSessionId,
      setSelectedSessionId: sessionSelection.setSession,
      removeSessionExact: sessionProjection.removeExact,
      currentSelectionRevision: currentDetailRequest,
      preserveManagedActive: preserveManagedActiveSession,
      mergeSessions
    }
  });
  function transferSessionSubmission(
    nodeId: string,
    workspaceId: string,
    previousId: string,
    nextId: string
  ): void {
    sessionIdentity.transfer(nodeId, workspaceId, previousId, nextId);
  }
  function replaceSessionForTarget(
    nodeId: string,
    workspaceId: string,
    previousId: string,
    next: Session
  ): void {
    sessionIdentity.replace(nodeId, workspaceId, previousId, next);
  }
  function replaceSession(previousId: string, next: Session): void {
    sessionIdentity.replaceCurrent(previousId, next);
  }

  function scrollConversationToLatest(): void {
    composerInteractions.scrollConversationToLatest();
  }

  const conversationRealtime = mainPaneController.realtime;

  function openRun(runId: string): void {
    conversationRealtime.openRun(runId);
  }

  // Realtime backfill covers only the event-log window. If the active session ended while offline,
  // converge Run, Session, and final Turn from the Node snapshot instead of leaving stale Working UI.
  const sessionSnapshotRefreshService = createSessionSnapshotRefreshService({
    workspaceTarget,
    selectedSessionId,
    refresh: (sessionId, deferInitialScroll) =>
      openSession(sessionId, { preserveMobileWorkspaceSurface: true, deferInitialScroll })
  });

  function refreshSelectedSessionSnapshot(delayMs = 0, deferInitialScroll = false): void {
    sessionSnapshotRefreshService.schedule(delayMs, deferInitialScroll);
  }

  function closeWorkbenchLive(): void {
    sessionSnapshotRefreshService.clear();
    directTransport.connectionLost();
    closeWorkbenchSocket();
  }

  const watchRecovery = createWorkbenchWatchRecovery({
    view,
    workspaceTarget,
    selectedWorkspace,
    selectedSessionId,
    hostedNodeId: hostedConversationWorkspace.selectedNodeId,
    coordinator: () => watchCoordinator.current,
    invalidateManifest: invalidateNodeManifest,
    refreshManifest: refreshNodeManifest,
    reactivate: (id) => reactivateConnectedWorkspace(id),
    discardNodeCache: discardNodeViewCaches,
    resetSession: mainPane.resetRealtime,
    refreshSession: refreshSelectedSessionSnapshot,
    direct: directTransport,
    live: workbenchLiveConnection
  });
  function handleNodeConnected(nodeId: string, restartWatch = true): void {
    watchRecovery.connected(nodeId, restartWatch);
  }
  function handleWorkbenchResync(nodeId: string): void {
    watchRecovery.resync(nodeId);
  }

  const workPromptCompletion = mainPaneController.completion;
  const composerInteractions = mainPaneController.interactions;

  watch(openWorkspaceTools, (openItems) => {
    if (!openItems.includes('register')) {
      discardPendingWorkspaceDirectory();
      return;
    }
    if (workspaceDirectory.value === undefined && !loadingWorkspaceDirectory.value) {
      void loadWorkspaceDirectories();
    }
  });

  installWorkbenchPageLifecycle({
    persistenceSources: [
      sidebarCollapsed,
      workspaceTabs,
      expandedNodeIds,
      nodeOrder,
      workspaceOrderByNode
    ],
    cacheSources: [
      runs,
      conversationTurns,
      workspaceQueue,
      sessionContextUsage,
      composerSkillTokens,
      composerFileReferences
    ],
    routeSources: [
      view,
      managementSection,
      workspaceNodeId,
      activeWorkspaceId,
      selectedSessionId,
      () => selectedSession.value?.externalSessionId,
      hostedConversationWorkspace.selectedNodeId,
      hostedConversationWorkspace.selectedConversationId
    ],
    documentTitle,
    newSessionRunner,
    newSessionModel,
    workspaceTarget,
    selectedSessionId,
    conversationTurns,
    conversationScroll,
    followConversation,
    persistWorkbenchState,
    syncWorkbenchRoute,
    normalizeNewSessionOptions,
    clearRunnerCommand: runnerInteractionService.reset,
    clearComposerModelEffort: composerConfigurationService.clearModelEffortSelection,
    closeFileReferences: () => {
      composerReferenceService.cancelSearch();
      composerReferenceService.close();
    },
    saveCurrentWorkspaceView,
    scrollConversationToLatest,
    stopSelectedSessionWatch,
    restoreWorkbenchState,
    restoreWorkbenchEventCursors,
    restoreWorkspaceUploads,
    startNavigation: () => {
      startNavigation();
      mobileMenuHistory.start();
    },
    handleSessionWatchVisibility,
    workspaceShortcuts,
    refreshAdmin,
    recoverAuthentication: () => {
      if (authenticationUnknown.value && !authenticationRestoring.value) void refreshAdmin();
    },
    cancelFileReferenceSearch: composerReferenceService.cancelSearch,
    disposeNavigation: () => {
      mobileMenuHistory.dispose();
      disposeNavigation();
    },
    disposeWorkspaceUploads,
    disposeWorkbenchNotifications,
    disposeWebVersionUpdateCheck: webUpdates.stop,
    stopWorkspaceWatch: () => watchCoordinator.current?.stopWorkspace(),
    closeWorkbenchLive,
    disposeDirectTransport: directTransport.dispose,
    clearNewSessionAttachments: clearAllNewSessionAttachments,
    releaseRunImagePreviews: () => retainRunImagePreviews([])
  });

  return {
    layout: navigationPresentation.layoutView,
    tree: proxyRefs({
      draggingWorkspace,
      expandedNodeIds,
      workspaceTreeRevealTarget: workspaceTreeService.revealTarget,
      moveTreeWorkspace: workspaceTreeService.moveWorkspace,
      endWorkspaceDrag: workspaceTreeService.endDrag,
      orderedNodes,
      moveNode,
      refreshNodeWorkspaces,
      refreshWorkspaceTree,
      orderedWorkspaces,
      toggleNodeExpansion,
      addWorkspaceForNode,
      openWorkspaceFromTree,
      reorderWorkspace,
      moveWorkspaceToGroup,
      moveWorkspaceGroup,
      renameWorkspace,
      removeWorkspace,
      startWorkspaceDrag
    }),
    terminal: proxyRefs({
      terminalDocks,
      terminalDirectClient,
      terminalReady
    }),
    hosted: proxyRefs({
      clearHostedConversation,
      closeHostedConversationMobileHistory,
      hostedConversationMobileHistoryOpen,
      hostedConversationMobileFilesOpen,
      hostedConversationRoute,
      hostedConversationWorkspace,
      restoringHostedConversationRoute,
      selectHostedConversation
    }),
    sessionList: proxyRefs({
      mutationLoading: computed(
        () => workbenchEntityActions.loading.value || workspaceTreeLoading.value
      ),
      sessions,
      visibleWorkspaceSessions,
      canLoadMoreWorkspaceSessions,
      loadMoreWorkspaceSessionsError,
      loadMoreWorkspaceSessions: loadMoreVisibleWorkspaceSessions,
      loadingMoreWorkspaceSessions: loadingMoreVisibleWorkspaceSessions,
      refreshWorkspaceSessions,
      refreshingWorkspaceSessions,
      searchingWorkspaceSessions,
      searchWorkspaceSessions,
      workspaceSessionSearchEnabled,
      workspaceSessionSearchQuery,
      workspaceSessionGroup,
      selectWorkspaceSessionGroup,
      deleteSession,
      canDeleteSession,
      cleanupWorkspaceSessions,
      cleanupSessionsEnabled,
      renameSession,
      movePinnedSession,
      movePinnedSessionTo,
      setSessionPinned,
      setSessionTreeAnchor: (sessionId: string | undefined) => {
        sessionTreeAnchor.value = sessionId;
      },
      sessionNavigationSnapshot: computed(() => {
        return sessionNavigation.current(workspaceTarget.value, navigationQuery.value);
      }),
      sessionActivity,
      sessionActivityDateTime,
      sessionActivityLabel,
      sessionActivityTitle,
      sessionRelativeActivity,
      sessionTitle,
      reloadSelectedSession
    }),
    selection: proxyRefs({
      activateWorkspaceTab: openWorkspaceTab,
      activeWorkspaceTabId,
      closeWorkspaceTab,
      workspaceTarget,
      workspaceTabs,
      workspaceTabLabel,
      workspaceTabNodeLabel,
      moveWorkspaceTab: workspaceTabService.move,
      pinWorkspaceTab: workspaceTabService.setPinned,
      workspaceSelectionLoading: workbenchWorkspaceSelectionService.loading,
      retryWorkspaceSelection: () => {
        if (workspaceTarget.value !== undefined) void selectWorkspace(workspaceTarget.value);
      },
      selectedSessionId,
      openSessionFromList,
      openSessionGroupTarget,
      openNewSessionComposer,
      draftSessionOpen
    }),
    aside: proxyRefs({
      asidePaneController: asidePaneController.view,
      asideSessionMetadata: computed(() => {
        const workspace = workspaceTarget.value;
        return navigationQuery.value === undefined || workspace === undefined
          ? []
          : sessionNavigation.knownSessions(
              workspace,
              workbenchAsideService.current(workspace).sessions
            );
      }),
      asideState: computed(() => {
        const target = workspaceTarget.value;
        return target === undefined ? undefined : workbenchAsideService.current(target);
      }),
      asideSupported: computed(() =>
        supportsSessionAside(
          nodes.value.find((node) => node.id === workspaceNodeId.value)?.nodeAppVersion,
          nodeManifest.value?.sessionAside
        )
      ),
      asideViewMode,
      asideWidth: workbenchLayoutService.asideWidth,
      closeAsideBrowser,
      closeAsideSession: workbenchSessionSelectionService.closeAsideSession,
      openAsideSession: workbenchSessionSelectionService.openAsideSession,
      openHtmlAside,
      reloadAsideSession,
      selectAsideBrowser,
      selectAsideTool,
      setAsideSurfaceVisible: (visible: boolean) => {
        asideSurfaceVisible.value = visible;
      },
      toggleAsideTerminal
    }),
    files: proxyRefs({
      fileWorkbench,
      workspaceFileWorkbench,
      mountSurface: fileTools.mountSurface,
      unmountSurface: fileTools.unmountSurface,
      workspaceFiles,
      workspaceGit,
      workspaceSearch,
      setWorkspaceFilePage: fileWorkbench.setPage,
      setWorkspaceFilesPanel: fileTools.setFilesPanel,
      setWorkspaceSearchPanel: fileTools.setSearchPanel,
      downloadWorkspaceFile,
      openWorkspaceFileExternal,
      openWorkspaceGitChange,
      openWorkspaceHistoryDiff,
      loadWorkspaceDiff,
      adjacentWorkspaceDiff,
      reportWorkspaceFileFailure,
      fileWriteReady,
      contentSearchReady,
      filesReady,
      standaloneFileMode,
      standaloneFileLoading,
      standaloneFileError
    }),
    mainPaneController: mainPaneController.view,
    notifications: workbenchNotificationService,
    identity: adminAuthService.view,
    application: proxyRefs({
      workPromptCompletion,
      webVersion: options.webVersion,
      pwaState,
      checkingForUpdates,
      checkForUpdates,
      applyWebUpdate,
      retryWorkspaceWatch: () => workspaceWatchService.retryFailed(),
      liveConnected: workbenchLiveConnection.connected,
      codeNavigationReady,
      managementItems,
      managementSection,
      navigationItems,
      notice,
      openHtmlExternal,
      openWorkbenchNotification: workbenchNotificationService.openNotification,
      openRecentRun,
      runnerBrandIcon,
      selectManagementSection,
      selectNavigation,
      selectSettingsSection,
      settingsItems,
      settingsSection,
      view,
      webPerformanceDiagnostics,
      workspaceWatchTopicStatus: workspaceWatchService.topicStatus
    }),
    resources: proxyRefs({
      onlineNodeCount,
      serverVersion,
      nodeUpgradeProgress: workbenchCapabilityService.upgradeProgress,
      nodeDetails,
      nodeDetailsDialogOpen,
      nodeLabel,
      nodeManifest,
      nodeManifestLoading,
      nodeReady,
      nodes,
      refreshNodes,
      runnerUsageDetails,
      runnerUsageDialogOpen,
      runnerUsageDisabledReason,
      runnerUsageLoading,
      workspaceHost,
      selectedNodeStatus,
      selectedWorkspace,
      showNodeDetails,
      showRunnerUsage,
      workspaceBranchLabel,
      workspaceDirectAvailable,
      workspaceDirectDescription,
      workspaceLocalFileManagerAvailable,
      workspaceKindLabel,
      workspacePath
    }),
    registration: proxyRefs({
      loadWorkspaceDirectories,
      loadingWorkspaceDirectory,
      registrationLoading: workspaceRegistrationService.loading,
      pendingWorkspaceDirectoryName,
      openNodeRegistration,
      openWorkspaceTools,
      registerWorkspace,
      workspacePreserveGitConfig,
      workspaceGitPolicySupported,
      selectWorkspaceDirectory,
      selectPendingWorkspaceDirectory,
      discardPendingWorkspaceDirectory,
      selectedWorkspaceDirectorySelectable,
      workspaceDirectory,
      workspaceRegistrationNodeId,
      workspaceRegistrationNode,
      workspaceRegistrationReady,
      closeWorkspaceRegistration
    }),
    settings: proxyRefs({
      quickPrompts: quickPromptTargets.prompts,
      quickPromptsLoading: quickPromptTargets.loading,
      quickPromptsFailed: quickPromptTargets.failed,
      refreshQuickPrompts: quickPromptService.refresh,
      createRegistrationToken,
      registrationToken,
      registrationLoading
    }),
    interactions: proxyRefs({
      attachmentPreview,
      attachmentPreviewOpen,
      closeQuickOpenFile,
      conversationImagePreview,
      conversationImagePreviewOpen,
      handleConversationImagePreviewError: (url: string) =>
        imagePreviewOwner.value.previewFailed(url),
      openQuickWorkspaceFile,
      openQuickWorkspace,
      openAttachmentPreview,
      quickOpenFileVisible
    }),
    uploads: proxyRefs({
      cancelWorkspaceUpload,
      deleteWorkspaceUpload,
      recoverWorkspaceUpload,
      retryWorkspaceUpload,
      workspaceUploadRecoveryInput,
      workspaceUploadStatusLabel,
      workspaceUploadTasks
    })
  } satisfies WorkbenchShellView<ManagementSection, RegistrationContext, NodeRegistrationContext> &
    WorkbenchSurfaceView<ManagementSection, RegistrationContext, NodeRegistrationContext>;
}

/** Domain contracts consumed independently by the shell and work surface. */
