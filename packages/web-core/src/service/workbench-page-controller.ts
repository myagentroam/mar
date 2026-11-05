import type { WorkspaceDirectFileIdentity } from '../model/workspace-direct-file.js';
import { clearMessages, showMessage } from './message-feedback-service.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import { isComposerAttachmentResourcePath } from '@myagentroam/protocol';
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { createHostedConversationSelectionService } from '@myagentroam/web-core/hosted-selection';
import { createAdminAuthService } from './admin-auth-service.js';
import { createRunnerUsageService } from './runner-usage-service.js';
import { createRunnerProfileService } from './runner-profile-service.js';
import { createWorkspaceRegistrationService } from './workspace-registration-service.js';
import { createWorkspaceSessionService } from './workspace-session-service.js';
import {
  absoluteSessionTime as formatSessionTime,
  agentSessionPathId,
  contextPercentageLabel as formatContextPercentage,
  errorMessage as message,
  currentChangesBranch,
  effortPresentation as effortLabel,
  nodePresentation as nodeLabel,
  sessionActivityDateTime,
  tokenCountLabel as formatTokenCount,
  workspaceBranchLabel,
  workspaceKindLabel,
  workspaceTabId,
  workspaceTabLabel
} from '../util/workbench-presentation.js';
import { createWorkbenchRouteService } from './workbench-route-service.js';
import { createMobileMenuHistoryService } from './mobile-menu-history-service.js';
import { captureMobileLayerRoute } from './mobile-layer-history-service.js';
import { createWorkbenchEntityService } from './workbench-entity-service.js';
import { parseNodeUpgradeProgress, type NodeUpgradeProgress } from '../model/node-upgrade.js';
import { createWorkspaceUploadService } from './workspace-upload-service.js';
import { createWorkbenchLiveService } from './workbench-live-service.js';
import { createWorkbenchDirectTransportCoordinator } from './workbench-direct-transport-coordinator.js';
import { readWorkspaceDirectObjectUrl } from './workspace-direct-object-url-service.js';
import {
  downloadWorkspaceDirectFile,
  type WorkspaceDirectDownloadResult
} from './workspace-direct-download-stream-service.js';
import {
  readWorkspaceDirectFileMetadata,
  readGitDirectFileMetadata,
  readWorkspaceDirectFileRange
} from './workspace-direct-file-read-service.js';
import { createWebPerformanceDiagnostics } from './web-performance-diagnostic-service.js';
import { createWorkbenchLayoutService } from './workbench-layout-service.js';
import { createWorkspaceSessionPaneController } from './workspace-session-pane-controller.js';
import { createWorkspaceSessionPaneLifecycle } from './workspace-session-pane-loader.js';
import { createWorkbenchCapabilityService } from './workbench-capability-service.js';
import type { ManagementComposition } from './management-composition.js';
import type { WorkbenchNavigationService } from './workbench-navigation-service.js';
import type { WorkspaceRegistrationInput } from './workspace-registration-service.js';
import type { SettingsSection } from '../model/settings.js';
import type { WorkbenchView } from '../util/workbench-route.js';
import type { WorkbenchNotification } from './workbench-notification-service.js';
import { navigateWorkbenchNotification } from './workbench-notification-navigation-service.js';
import { createSessionSnapshotRefreshService } from './session-snapshot-refresh-service.js';
import { createComposerAttachmentService } from './composer-attachment-service.js';
import { createWorkspaceViewCacheService } from './workspace-view-cache-service.js';
import { createWorkspaceWatchService, sameNavigation } from './workspace-watch-service.js';
import { createWorkbenchViewWatchService as createWorkbenchNavigationWatchService } from './workbench-view-watch-service.js';
import { createHostedConversationWatchCoordinator as createWorkbenchWatchCoordinator } from './hosted-conversation-watch-coordinator.js';
import {
  createWorkspaceRuntimeStateService,
  mergeWorkspaceWatchSnapshot
} from './workspace-runtime-state-service.js';
import { createWorkbenchSessionSelectionService } from './workbench-session-selection-service.js';
import {
  asideViewMode,
  createWorkbenchAsideService,
  type AsideTool,
  type AsideWorkspace
} from './workbench-aside-service.js';
import {
  createSessionNavigationProjection,
  sessionNavigationQuery
} from './session-navigation-projection.js';
import { supportsSessionAside } from '../util/node-features.js';
import { replaceSessionIdentity } from './workbench-session-identity.js';
import { createWorkbenchSubmissionOwner } from './workbench-submission-service.js';
import { createScopedHttpService } from './scoped-http-service.js';
import { createWorkspaceGitService } from './workspace-git-service.js';
import { createWorkspaceContentSearchService } from './workspace-content-search-service.js';
import {
  createWorkspaceFileOperationService,
  filePageWorkspace,
  isFilePage
} from './workspace-file-operation-service.js';
import {
  createWorkspaceFilesController,
  workspaceFileTreeRootName
} from './workspace-files-controller.js';
import type { WorkspaceGitSnapshot } from './workspace-git-service.js';
import type { ChangeEntry, HistoryCommit, HistoryFile } from '../model/workspace-git.js';
import type { WorkspaceFileTab } from '../util/workspace-file-tab.js';
import { loadToolChangeDiff } from './tool-change-review-service.js';
import { createWorkspaceFileWorkbenchController } from './workspace-file-workbench-controller.js';
import type { WorkspaceFilePagePort } from '../model/workspace-file-workbench.js';
import { filePreviewErrorMessage } from '../util/error-presentation.js';
import type {
  WorkspaceFilesPanelHandle,
  WorkspaceSearchPanelHandle
} from './workbench-surface-state-service.js';
import { createWorkbenchWorkspaceSelectionService } from './workbench-workspace-selection-service.js';
import { createWorkbenchWorkspaceCacheController } from './workbench-workspace-cache-controller.js';
import { createWorkbenchWorkspaceTreeController } from './workbench-workspace-tree-controller.js';
import { createWorkbenchPresentationStateService } from './workbench-presentation-state-service.js';
import { createWorkbenchEntityController } from './workbench-entity-controller.js';
import { createWorkbenchPageStateService } from './workbench-base-state-service.js';
import { createWorkspaceSessionPaneState } from './workspace-session-pane-state.js';
import { createWorkbenchPageInteractionService } from './workbench-page-interaction-service.js';
import type { PwaApplicationService } from './pwa-application-service.js';
import { createWorkbenchNewSessionController } from './workbench-new-session-controller.js';
import { installWorkbenchPageLifecycle } from './workbench-page-lifecycle-service.js';
import {
  projectSessionQueue,
  type WorkspaceQueueSnapshotSource
} from './workspace-queue-projection-service.js';
import { createComposerSkillService } from './composer-skill-service.js';
import { createQuickPromptService } from './quick-prompt-service.js';
import type { EffectiveWorkspaceSkill } from './effective-workspace-skill-service.js';
import { createHostedConversationWorkspaceService } from './hosted-conversation-workspace-service.js';
import { promptCompletionPreferenceService } from './prompt-completion-preference-service.js';
import { PromptCompletionClientService } from './prompt-completion-client-service.js';
import { ApiError, errorCode } from '../util/api-error.js';
import { userInputQuestions } from '../util/conversation-presentation.js';
import { createWorkspaceTabService } from './workspace-tab-service.js';
import {
  STANDALONE_FILE_OPEN_EVENT,
  standaloneFileOpenIntent,
  type StandaloneFileOpenIntent
} from './standalone-file-window-service.js';
import { createWorkspaceTreeService } from './workspace-tree-service.js';
import type {
  ConversationTurn,
  QuickPrompt,
  Session,
  Workspace,
  NodeWorkbenchManifest,
  WorkspaceQueue
} from '../model/workbench.js';
import { WORKSPACE_SESSION_PAGE_SIZE } from '../util/session-list.js';
import { translate, currentLocale, localePreferenceService } from './locale-preference-service.js';
import {
  sessionActivity,
  sessionActivityLabel,
  sessionTitle,
  temporarySessionTitle
} from '../util/session-presentation.js';
import { displayConversationItem } from '../util/conversation-domain.js';

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
    visibleWorkspaceTargets: () => visibleWorkspaceNotificationTargets()
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
    mobileUtilityPanel,
    start: startNavigation,
    dispose: disposeNavigation,
    selectView: selectWorkbenchView,
    closeMobileSidebar,
    selectSettings: selectSettingsSection,
    selectManagement: selectManagementSection,
    openMobileWorkspaceSurface,
    closeMobileWorkspaceSurface
  } = navigationService;
  const hostedConversationMobileHistoryOpen = ref(false);
  const hostedConversationMobileFilesOpen = ref(false);

  watch(mobileViewport, (mobile) => {
    if (!mobile) {
      hostedConversationMobileHistoryOpen.value = false;
      hostedConversationMobileFilesOpen.value = false;
    }
  });

  const adminState = baseState.admin;

  const {
    admin,
    loaded: adminLoaded,
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
  const selectionState = baseState.selection;

  const {
    nodes,
    serverVersion,
    workspaces,
    sessions,
    workspaceTarget,
    selectedSessionId,
    nodeManifest,
    loading
  } = selectionState;
  const workspaceNodeId = computed(() => workspaceTarget.value?.nodeId);
  const activeWorkspaceId = computed(() => workspaceTarget.value?.workspaceId);
  const mainSurfaceVisible = computed(
    () => !mobileViewport.value || mobileWorkspaceSurface.value === 'conversation'
  );
  const webPerformanceDiagnostics = createWebPerformanceDiagnostics({
    enabled: () => !mobileViewport.value,
    context: () => ({
      view: view.value,
      ...(workspaceNodeId.value === undefined ? {} : { nodeId: workspaceNodeId.value }),
      ...(activeWorkspaceId.value === undefined ? {} : { workspaceId: activeWorkspaceId.value }),
      ...(selectedSessionId.value === undefined ? {} : { sessionId: selectedSessionId.value })
    })
  });
  const workspaceDirectProbeRevision = ref(0);
  const directTransport = createWorkbenchDirectTransportCoordinator({
    nodes: () => nodes.value,
    discover: async (nodeId) =>
      (
        await request<{ readonly manifest?: NodeWorkbenchManifest }>(
          '/api/nodes/' + encodeURIComponent(nodeId) + '/workbench-capabilities'
        )
      ).manifest,
    sendDirect: (message): boolean => workbenchLiveConnection.sendDirect(message),
    sendTerminalDirect: (message): boolean => workbenchLiveConnection.sendTerminalDirect(message),
    onChange: () => {
      workspaceDirectProbeRevision.value += 1;
    }
  });
  const { workspace: workspaceDirectTransfer, terminal: terminalDirectClient } = directTransport;
  const serverVersionLabel = computed(() =>
    serverVersion.value === ''
      ? translate('generated.workbenchSelectionStateService.unknown')
      : serverVersion.value
  );

  const workspaceSessionPaging = baseState.paging;

  const { visibleLimits: workspaceSessionVisibleLimits, nextCursors: workspaceSessionNextCursors } =
    workspaceSessionPaging;

  const workbenchNotificationService = baseState.notifications;

  const { start: startWorkbenchNotifications, dispose: disposeWorkbenchNotifications } =
    workbenchNotificationService;
  let removeWebVersionSubscription: (() => void) | undefined;
  const pwaState =
    options.pwaApplication?.state ?? ref({ offline: 'online' as const, checked: false });
  const checkingForUpdates = ref(false);

  function startWebVersionUpdateCheck(): void {
    if (removeWebVersionSubscription !== undefined || options.pwaApplication === undefined) return;
    removeWebVersionSubscription = options.pwaApplication.subscribe((state) => {
      if (!state.checked) return;
      const hasUpdateNotice = workbenchNotificationService.notifications.value.some(
        (item) => item.kind === 'web-update'
      );
      const update = state.update ?? (hasUpdateNotice ? state.reload : undefined);
      if (update === undefined) {
        if (state.reload === undefined) workbenchNotificationService.clearWebUpdate();
      } else {
        workbenchNotificationService.notify({
          id: `web-update:${update.version}:${update.buildId}`,
          kind: 'web-update',
          source: 'local',
          title: translate('webUpdate.title'),
          message: translate('webUpdate.message', { value0: update.version }),
          action: 'RELOAD_PAGE'
        });
      }
    });
  }

  const composerAttachmentService = createComposerAttachmentService({
    context: () => baseState.draftTarget.value,
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
  const mainPane = createWorkspaceSessionPaneState({
    draftTarget: baseState.draftTarget,
    drafts: baseState.draft,
    attachments: composerAttachmentService,
    submissions: submissionOwner,
    onConversationOverflow: () => void refreshRecentConversationWindow()
  });
  let reloadAsideSession = () => {};
  let saveAsideContext = () => {};
  const asidePane = createWorkspaceSessionPaneState({
    pane: 'aside',
    draftTarget: asideTarget,
    drafts: baseState.draft,
    attachments: composerAttachmentService,
    submissions: submissionOwner,
    onConversationOverflow: () => reloadAsideSession()
  });
  const submissionService = mainPane.submission;
  const focusComposerInputAt = mainPane.focusInput;

  const {
    input: sessionInput,
    skillTokens: composerSkillTokens,
    references: composerFileReferences,
    persist: persistSessionDraft
  } = mainPane.draft;
  const composerSkillTokenService = mainPane.skillTokens;

  // Node has not returned the real Run ID when the first message is sent. Retain the prior activity
  // so the new session appears managed immediately and can recover losslessly if Node rejects it.
  const runService = mainPane.run;

  const { runs, selectedRunId } = runService;

  const conversationState = mainPane.conversation;

  const {
    turns: conversationTurns,
    nextCursor: conversationNextCursor,
    loadingInitial: loadingInitialConversation,
    initialLoadFailed: initialConversationLoadFailed,
    loadingOlder: loadingOlderConversation,
    contextUsage: sessionContextUsage,
    initialRenderVersion: conversationInitialRenderVersion,
    beginInitialRender: beginConversationInitialRender,
    confirmInitialRender: confirmConversationInitialRender,
    nextDetailRequest,
    currentDetailRequest
  } = conversationState;

  const surfaceState = baseState.surface;

  const {
    quickOpenFileVisible,
    workspaceFileWorkbench,
    terminalDocks,
    draftSessionOpen,
    registrationToken,
    nodeManifestLoading
  } = surfaceState;

  const {
    preview: attachmentPreview,
    previewOpen: attachmentPreviewOpen,
    clearAll: clearAllNewSessionAttachments,
    openPreview: openAttachmentPreview
  } = composerAttachmentService;
  const {
    attachments: newSessionAttachments,
    add: addNewSessionFiles,
    remove: removeNewSessionAttachment
  } = mainPane.attachments;
  const draggingComposerAttachments = mainPane.draggingAttachments;

  const workspaceRuntimeState = createWorkspaceRuntimeStateService();

  const {
    filesRevision: workspaceFilesRevision,
    changesRevision: workspaceChangesRevision,
    watchSnapshot: workspaceWatchSnapshot,
    runnerProfiles,
    runnerProfilesLoading,
    runnerProfilesFailed,
    queue: workspaceQueue
  } = workspaceRuntimeState;

  const runnerProfileService = createRunnerProfileService({
    workspaceTarget,
    profiles: runnerProfiles,
    loading: runnerProfilesLoading,
    failed: runnerProfilesFailed,
    request,
    notice,
    errorMessage: message
  });

  const mergeWorkspaceQueue = (
    queue: WorkspaceQueue,
    source: WorkspaceQueueSnapshotSource = 'event'
  ): void => {
    workspaceQueue.value = projectSessionQueue(workspaceQueue.value, queue, runs.value, source);
  };

  const conversationProjectionService = conversationState.projection;

  const {
    restoreWindow: restoreConversationWindow,
    clearSession: clearConversationProjectionSession,
    mergeLatest: mergeLatestConversationTurns
  } = conversationProjectionService;

  const composerQueueService = mainPane.queue;

  const {
    draggingQueueItemId,
    editingQueueItemId,
    editingContent: editingQueueContent
  } = composerQueueService;

  const conversationScrollService = mainPane.scroll;

  const {
    element: conversationScroll,
    following: followConversation,
    positioningInitialConversation
  } = conversationScrollService;

  const workspaceViewCacheService = createWorkspaceViewCacheService(workspaceTabId);

  const workspaceTreeService = createWorkspaceTreeService({
    persist: persistWorkbenchState
  });

  const { expandedNodeIds, nodeOrder, workspacesByNode, workspaceOrderByNode, draggingWorkspace } =
    workspaceTreeService;
  const orderedNodes = computed(() => workspaceTreeService.orderedNodes(nodes.value));
  function moveNode(nodeId: string, targetIndex: number): void {
    workspaceTreeService.moveNode(nodes.value, nodeId, targetIndex);
  }

  const MAX_WORKSPACE_TABS = 8;

  const MAX_CACHED_SESSION_DETAILS = 5;

  const WORKSPACE_WATCH_HEARTBEAT_MS = 15_000;

  const SESSION_WATCH_HEARTBEAT_MS = 15_000;

  const SESSION_WATCH_CONFIRMATION_TIMEOUT_MS = 45_000;

  const SESSION_WATCH_REQUEST_TIMEOUT_MS = 10_000;

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

  const navigationItems = computed<
    readonly {
      readonly id: WorkbenchView;
      readonly label: string;
      readonly icon: string;
    }[]
  >(() => [
    { id: 'nodes', label: translate('navigation.nodes'), icon: '◫' },
    { id: 'conversations', label: translate('navigation.conversations'), icon: '◉' },
    { id: 'management' as const, label: translate('navigation.management'), icon: '☷' },
    { id: 'settings', label: translate('navigation.settings'), icon: '⚙' }
  ]);

  const sidebarContentVisible = computed(() => !sidebarCollapsed.value || mobileSidebarOpen.value);

  const settingsItems = computed<
    readonly { readonly id: SettingsSection; readonly label: string }[]
  >(() => [
    { id: 'account', label: translate('navigation.account') },
    { id: 'usage', label: translate('usageStatistics.title') },
    { id: 'appearance', label: translate('settings.appearance') },
    { id: 'custom-themes', label: translate('customThemes.title') },
    {
      id: 'notifications',
      label: translate('workbenchNotificationCenter.systemNotifications.title')
    },
    { id: 'quick-prompts', label: translate('quickPrompts.title') },
    { id: 'personal-instructions', label: translate('navigation.personalInstructions') },
    { id: 'git', label: translate('personalGit.title') },
    { id: 'shortcuts', label: translate('navigation.shortcuts') },
    { id: 'about', label: translate('navigation.about') }
  ]);

  const managementItems = computed(() =>
    managementComposition.items(admin.value).map(({ id, labelKey }) => ({
      id,
      label: translate(labelKey)
    }))
  );

  function selectNavigation(nextView: WorkbenchView): void {
    const previousView = view.value;
    hostedConversationMobileFilesOpen.value = false;
    const collapseSidebar =
      mobileViewport.value &&
      previousView === nextView &&
      mobileSidebarOpen.value &&
      mobileUtilityPanel.value === undefined;
    if (mobileViewport.value && nextView === 'conversations') {
      const historyWasOpen = hostedConversationMobileHistoryOpen.value;
      hostedConversationMobileHistoryOpen.value = previousView === nextView && !historyWasOpen;
      if (previousView === nextView) {
        navigationService.selectMobileUtilityPanel(undefined);
        closeMobileSidebar();
        closeMobileWorkspaceSurface();
        return;
      }
    } else hostedConversationMobileHistoryOpen.value = false;
    if (
      nextView === 'management' &&
      !managementItems.value.some((item) => item.id === managementSection.value)
    )
      managementSection.value = managementItems.value[0]?.id ?? options.systemManagementSection;
    selectWorkbenchView(nextView);
    if (
      collapseSidebar ||
      (mobileViewport.value &&
        previousView !== nextView &&
        (nextView === 'nodes' || nextView === 'conversations'))
    )
      closeMobileSidebar();
    if (previousView !== nextView && (nextView === 'nodes' || nextView === 'conversations'))
      void workbenchNotificationService.recover().catch(() => undefined);
    navigationWatchService.transition(previousView, nextView);
  }

  function closeHostedConversationMobileHistory(): void {
    hostedConversationMobileHistoryOpen.value = false;
  }

  function selectMobileUtilityPanel(panel: typeof mobileUtilityPanel.value): void {
    if (!mobileViewport.value) return;
    if (panel !== undefined) {
      closeHostedConversationMobileHistory();
      hostedConversationMobileFilesOpen.value = false;
    }
    navigationService.selectMobileUtilityPanel(panel);
  }

  const locked = computed(() => admin.value.authenticated && admin.value.mustChangePassword);

  const composerSkillTargets = {
    skills: ref<readonly EffectiveWorkspaceSkill[]>([]),
    loading: ref(false),
    failed: ref(false)
  };
  const quickPromptTargets = {
    prompts: ref<readonly QuickPrompt[]>([]),
    loading: ref(false),
    failed: ref(false)
  };
  const quickPromptService = createQuickPromptService({ ...quickPromptTargets, request });
  const workbenchConnectionId = ref<string>();
  const completionPreferences = promptCompletionPreferenceService();
  const completionClient = new PromptCompletionClientService({
    request,
    connectionId: () => workbenchConnectionId.value
  });

  const mainPaneOptions: Parameters<typeof createWorkspaceSessionPaneController>[0] = {
    state: mainPane,
    view,
    sessionPathId: agentSessionPathId,
    replaceCachedConversation: (sessionId, turns, nextCursor) =>
      replaceConversationTurns(sessionId, turns, nextCursor),
    syncCachedRunStatus: (...args) => syncCachedRunStatus(...args),
    watch: {
      heartbeatMs: SESSION_WATCH_HEARTBEAT_MS,
      enabled: () => mainSurfaceVisible.value,
      workbenchConnectionId: () => workbenchConnectionId.value,
      requestTimeoutMs: SESSION_WATCH_REQUEST_TIMEOUT_MS,
      confirmationTimeoutMs: SESSION_WATCH_CONFIRMATION_TIMEOUT_MS,
      refreshSnapshot: () => refreshSelectedSessionSnapshot(),
      openSession: (sessionId) => openSession(sessionId)
    },
    events: {
      nodes,
      sessions,
      cacheQueue: workspaceViewCacheService.cacheQueue,
      mergeQueue: mergeWorkspaceQueue,
      mergeSessions: (values) => mergeSessions(values),
      cacheContext: workspaceViewCacheService.updateContext,
      cacheRun: workspaceViewCacheService.cacheRun,
      cacheTurn: workspaceViewCacheService.cacheTurn,
      invalidateWorkspace: (nodeId, workspaceId, topic) => {
        if (nodeId !== workspaceNodeId.value || workspaceId !== activeWorkspaceId.value) return;
        if (topic === 'files') workspaceFilesRevision.value += 1;
        else if (topic === 'changes') workspaceChangesRevision.value += 1;
      },
      onNodeConnected: handleNodeConnected
    },
    commands: {
      captureCacheTarget: (nodeId, workspaceId) =>
        workspaceViewCacheService.captureCommandTarget(nodeId, workspaceId),
      acceptSession: (nodeId, workspaceId, previousId, session, applyToSelected) => {
        if (
          workspaceTarget.value?.nodeId === nodeId &&
          workspaceTarget.value.workspaceId === workspaceId &&
          (selectedSessionId.value !== previousId || applyToSelected)
        )
          replaceSessionForTarget(nodeId, workspaceId, previousId, session);
        else transferSessionSubmission(nodeId, workspaceId, previousId, session.id);
      },
      invalidateDetail: (nodeId, workspaceId, sessionId) =>
        workspaceViewCacheService.invalidateDetail(nodeId, workspaceId, sessionId),
      stopWatch: () => watchCoordinator.current?.stopSession(),
      reopen: async (sessionId) => {
        await openSession(sessionId, {
          preserveMobileWorkspaceSurface: true,
          deferInitialScroll: true
        });
      }
    },
    messaging: {
      selectedWorkspace: computed(() => selectedWorkspace.value),
      sessions,
      restoreDraft: () => {
        draftSessionOpen.value = true;
        selectedSessionId.value = undefined;
      },
      createDraftSession: (title) => createDraftSession(title),
      replaceSession: (previousId, session) => replaceSession(previousId, session),
      temporaryTitle: temporarySessionTitle,
      migrateSessionCache: (nodeId, workspaceId, previousId, nextId, session) => {
        transferSessionSubmission(nodeId, workspaceId, previousId, nextId);
        workspaceViewCacheService.migrateSession(nodeId, workspaceId, previousId, nextId, session);
      },
      cacheRun: (...args) => cacheRunSnapshotFor(...args),
      beginSessionWatch: (sessionId) => navigationWatchService.requestSessionWatch(sessionId)
    },
    history: {
      onDraftFilled: (text, operation) => {
        if (operation === 'rollback') saveCurrentWorkspaceView();
        focusComposerInputAt(text.length);
      },
      replaceSession: (previousId, session) => replaceSession(previousId, session),
      openSession: (id, options) => openSession(id, { ...options, throwOnFailure: true }),
      invalidateDetail: (nodeId, session) =>
        workspaceViewCacheService.invalidateDetail(nodeId, session.workspaceId, session.id),
      stopWatch: () => watchCoordinator.current?.stopSession()
    },
    completion: {
      client: completionClient,
      enabled: () =>
        completionPreferences.enabled.value &&
        nodeReady.value &&
        workspaceHost.value?.capabilities.promptCompletion?.apiVersion === 1 &&
        workspaceHost.value?.capabilities.promptCompletion?.contextVersion === 3,
      automaticSupported: () =>
        workspaceHost.value?.capabilities.promptCompletion?.automaticTriggers === true,
      attention: () =>
        workspaceHost.value?.capabilities.promptCompletion?.contextVersion === 3
          ? (workspaceFileWorkbench.value?.predictionAttention?.() ?? [])
          : []
    },
    files: {
      openChange: (intent) => fileWorkbench.openTab(intent),
      openFile: (path, line, column, external) =>
        openAgentWorkspaceFile(path, line, column, external)
    },
    status: {
      connected: () => workbenchLiveConnection.connected.value,
      initialContentLoading: () => workbenchSessionSelectionService.loadingInitialContent.value,
      manifestLoading: nodeManifestLoading,
      skillsLoading: composerSkillTargets.loading,
      skillsFailed: composerSkillTargets.failed,
      promptsLoading: quickPromptTargets.loading,
      promptsFailed: quickPromptTargets.failed
    },
    configuration: { sessions, profiles: runnerProfiles, effortLabel },
    profileService: runnerProfileService,
    ensureDraftSupported: (profiles) => ensureDraftRunnerSupported(profiles),
    runner: { skills: composerSkillTargets.skills, quickPrompts: quickPromptTargets.prompts },
    references: { request },
    presentation: {
      provisionalSessionId: selectedSessionId,
      sessions,
      draftOpen: draftSessionOpen,
      runnerProfilesLoading,
      runnerProfilesFailed,
      loading,
      nodes,
      nodeManifest,
      shouldDisplayItem: (item, runId) => shouldDisplayConversationItem(item, runId),
      formatTokenCount,
      formatPercentage: formatContextPercentage
    },
    queue: {
      queue: workspaceQueue,
      currentWorkspaceRevision: () => workbenchWorkspaceSelectionService.currentSelectionRevision(),
      request,
      notice,
      errorMessage: message,
      missingQueueItemError: (error) => errorCode(error) === 'QUEUE_ITEM_INVALID'
    },
    interaction: {
      mobileViewport,
      runnerProfilesLoading,
      runnerProfilesFailed,
      hasRunnerProfile: (nodeId) => runnerProfileService.has(nodeId),
      ensureComposerSkills: () => ensureComposerSkills(),
      ensureQuickPrompts: () => void quickPromptService.refresh()
    }
  };
  const mainPaneController = createWorkspaceSessionPaneController(mainPaneOptions);
  const asideQueue = ref<WorkspaceQueue>({ version: 0, paused: false, items: [] });
  const asideSurfaceVisible = ref(false);
  const asideLoading = asidePane.conversation.loadingInitial;
  const asideOperationLoading = ref(false);
  const asideBusy = computed(() => asideLoading.value || asideOperationLoading.value);
  const asideInitialContentLoading = ref(false);
  const asideDraftOpen = ref(false);
  const asideProvisionalSession = ref<string>();
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
  function restoreVisibleAsideWatch(): void {
    const target = asideTarget.value;
    if (
      !asideVisible.value ||
      asideDraftOpen.value ||
      target === undefined ||
      (typeof document !== 'undefined' && document.visibilityState !== 'visible')
    )
      return;
    void Promise.resolve(watchCoordinator.current?.restartSecondarySession(target.sessionId)).catch(
      () => undefined
    );
  }
  function visibleWorkspaceNotificationTargets(includeLoading = false): readonly {
    nodeId: string;
    workspaceId: string;
    sessionId: string;
  }[] {
    const workspace = workspaceTarget.value;
    if (
      view.value !== 'nodes' ||
      workspace === undefined ||
      selectedWorkspace.value === undefined ||
      workspaceHost.value?.connected === false
    )
      return [];
    const targets: { nodeId: string; workspaceId: string; sessionId: string }[] = [];
    if (
      mainSurfaceVisible.value &&
      !draftSessionOpen.value &&
      selectedSessionId.value !== undefined &&
      (includeLoading || !mainPane.conversation.loadingInitial.value)
    )
      targets.push({ ...workspace, sessionId: selectedSessionId.value });
    if (
      asideVisible.value &&
      !asideDraftOpen.value &&
      asideTarget.value !== undefined &&
      (includeLoading || !asideLoading.value) &&
      !targets.some((target) => target.sessionId === asideTarget.value?.sessionId)
    )
      targets.push({
        nodeId: asideTarget.value.nodeId,
        workspaceId: asideTarget.value.workspaceId,
        sessionId: asideTarget.value.sessionId
      });
    return targets;
  }
  function markVisibleSessionRead(
    nodeId: string,
    workspaceId: string,
    sessionId: string
  ): void | Promise<void> {
    if (
      visibleWorkspaceNotificationTargets(true).some(
        (target) =>
          target.nodeId === nodeId &&
          target.workspaceId === workspaceId &&
          target.sessionId === sessionId
      )
    )
      return workbenchNotificationService.markSessionRead(nodeId, workspaceId, sessionId);
  }
  let openAsideTarget = async (_sessionId: string): Promise<void> => {};
  function acceptAsideSession(
    nodeId: string,
    workspaceId: string,
    previousId: string,
    session: Session
  ): void {
    const target = asideTarget.value;
    if (
      target?.nodeId !== nodeId ||
      target.workspaceId !== workspaceId ||
      target.sessionId !== previousId ||
      session.workspaceId !== workspaceId
    )
      return;
    const existing = sessions.value.some(
      (item) => item.id === previousId && item.workspaceId === workspaceId
    );
    if (previousId !== session.id) {
      if (!existing) transferSessionSubmission(nodeId, workspaceId, previousId, session.id);
      if (!workbenchSessionSelectionService.replaceAsideSession(target, session.id)) return;
    }
    asidePane.acceptResolvedSession(nodeId, session);
    if (existing) replaceSessionForTarget(nodeId, workspaceId, previousId, session);
  }
  const asidePaneController = createWorkspaceSessionPaneController({
    ...mainPaneOptions,
    state: asidePane,
    replaceCachedConversation: (sessionId, turns, nextCursor) => {
      const target = asideTarget.value;
      if (target?.sessionId === sessionId)
        workspaceViewCacheService.replaceTurns(
          target.nodeId,
          target.workspaceId,
          sessionId,
          turns,
          nextCursor
        );
    },
    syncCachedRunStatus: (sessionId, runId, status) => {
      const target = asideTarget.value;
      if (target?.sessionId === sessionId)
        workspaceViewCacheService.syncRunStatus(
          target.nodeId,
          target.workspaceId,
          sessionId,
          runId,
          status
        );
    },
    watch: {
      ...mainPaneOptions.watch,
      position: 'secondary',
      enabled: () => asideVisible.value,
      refreshSnapshot: () => reloadAsideSession(),
      openSession: (sessionId) => openAsideTarget(sessionId)
    },
    events: {
      ...mainPaneOptions.events,
      mergeQueue: (queue, source) => {
        asideQueue.value = projectSessionQueue(
          asideQueue.value,
          queue,
          asidePane.run.runs.value,
          source
        );
      },
      mergeSessions: (values) => {
        const known = values.filter((session) =>
          sessions.value.some(
            (candidate) =>
              candidate.id === session.id && candidate.workspaceId === session.workspaceId
          )
        );
        if (known.length > 0) mergeSessions(known);
      }
    },
    commands: {
      ...mainPaneOptions.commands,
      acceptSession: (nodeId, workspaceId, previousId, session, selected) => {
        if (selected) acceptAsideSession(nodeId, workspaceId, previousId, session);
        else transferSessionSubmission(nodeId, workspaceId, previousId, session.id);
      },
      stopWatch: () => watchCoordinator.current?.stopSecondarySession(),
      reopen: (sessionId) => openAsideTarget(sessionId)
    },
    messaging: {
      ...mainPaneOptions.messaging,
      restoreDraft: () => {},
      createDraftSession: async () => {
        throw new Error('ASIDE_SESSION_REQUIRED');
      },
      replaceSession: (previousId, session) => {
        const target = asideTarget.value;
        if (target) acceptAsideSession(target.nodeId, target.workspaceId, previousId, session);
      },
      beginSessionWatch: (sessionId) => {
        void watchCoordinator.current?.restartSecondarySession(sessionId);
      }
    },
    history: {
      ...mainPaneOptions.history,
      onDraftFilled: (text) => {
        asidePane.draft.persist();
        asidePane.focusInput(text.length);
      },
      replaceSession: (previousId, session) => {
        const target = asideTarget.value;
        if (target) acceptAsideSession(target.nodeId, target.workspaceId, previousId, session);
      },
      openSession: (sessionId) => openAsideTarget(sessionId),
      stopWatch: () => watchCoordinator.current?.stopSecondarySession()
    },
    status: {
      ...mainPaneOptions.status,
      initialContentLoading: () => asideInitialContentLoading.value
    },
    presentation: {
      ...mainPaneOptions.presentation,
      provisionalSessionId: asideProvisionalSession,
      draftOpen: asideDraftOpen,
      loading: asideBusy
    },
    queue: { ...mainPaneOptions.queue, queue: asideQueue }
  });
  watch(
    asidePaneController.history.pending,
    (pending) => {
      asideOperationLoading.value = pending;
    },
    { flush: 'sync' }
  );
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
  const {
    attachments: userMessageImageAttachments,
    retain: retainRunImagePreviews,
    markUnavailable: markRunImageUnavailable,
    open: openConversationImagePreview
  } = conversationImageService;
  const conversationUserInputService = mainPaneController.userInput;
  const currentSessionQueue = mainPaneController.currentSessionQueue;
  const composerConfigurationService = mainPaneController.configuration;
  const { selectedSession } = composerConfigurationService;

  const composerRunnerOptions = mainPaneController.runnerOptions;

  const {
    runner: newSessionRunner,
    modelId: newSessionModel,
    effort: newSessionEffort,
    access: newSessionAccess,
    modelEffortSelection: composerModelEffortSelection,
    activeRunner: composerRunner,
    models: composerModels,
    efforts: composerEfforts,
    accessOptions: composerAccessOptions,
    modelEffortLabel: composerModelEffortLabel,
    runnerLabel: composerRunnerLabel,
    accessLabel: composerAccessLabel,
    apply: applyComposerDefaultConfiguration
  } = composerConfigurationService;

  const runnerInteractionService = mainPaneController.runner;

  const {
    selectedCommand: selectedRunnerCommand,
    codexFastEnabled,
    commandPickerOpen,
    activeCommandIndex: activeRunnerCommandIndex,
    composerMode,
    visibleCommands: visibleRunnerCommands,
    visibleSkills: visibleComposerSkills,
    visibleQuickPrompts,
    pickerKind: composerPickerKind,
    activeCommandStates,
    clearCommand: clearRunnerCommand
  } = runnerInteractionService;

  const composerCommandReady = computed(() => selectedRunnerCommand.value !== undefined);

  const composerReferenceService = mainPaneController.references;

  const {
    open: referencePickerOpen,
    entries: fileReferenceEntries,
    activeIndex: activeFileReferenceIndex,
    loading: fileReferenceLoading,
    candidates: referenceCandidates,
    sessionLoading: referenceSessionLoading,
    fileError: referenceFileError,
    sessionError: referenceSessionError,
    fileMore: referenceFileMore,
    sessionMore: referenceSessionMore,
    match: activeReferenceMatch
  } = composerReferenceService;

  const mainPanePresentation = mainPaneController.presentation;
  const {
    activeComposerRun,
    workspaceHost,
    nodeReady,
    composerDraftOpen,
    canUseComposer,
    composerSessionOpen,
    composerConfigurationDisabled,
    composerAccessDisabled,
    composerInputDisabled,
    composerAttachmentsPending,
    displayedConversationTurns,
    rewindConversationEnabled,
    rollbackConversationEnabled,
    canDeleteSession,
    canCompactContext,
    contextUsageLabel,
    composerWorking: authoritativeComposerWorking,
    sessionActivityClockNow,
    composerWorkingLabel: authoritativeComposerWorkingLabel,
    composerWorkingBusy,
    workingElapsedLabel: composerElapsedLabel,
    interruptVisible,
    selectedWorkspace,
    documentTitle,
    visibleWorkspaceSessions: unfilteredWorkspaceSessions,
    canLoadMoreWorkspaceSessions: canLoadMoreUnfilteredWorkspaceSessions,
    onlineNodeCount,
    terminalReady,
    filesReady
  } = createWorkbenchPresentationStateService({
    workspaceTarget,
    sessions,
    nodes,
    workspaces,
    nodeManifest,
    visibleLimits: workspaceSessionVisibleLimits,
    nextCursors: workspaceSessionNextCursors,
    pageSize: WORKSPACE_SESSION_PAGE_SIZE,
    tabId: workspaceTabId,
    workspaceLabel: workspaceTabLabel,
    pane: mainPanePresentation
  });

  const contentSearchReady = computed(() => filesReady.value);
  const codeNavigationReady = computed(() => filesReady.value);
  const codeNavigationPrewarmReady = computed(() => codeNavigationReady.value);
  const fileWriteReady = computed(() => filesReady.value);
  const cleanupSessionsEnabled = true;
  const workspaceGitPolicySupported = true;
  const workspaceSessionSearchEnabled = true;

  const composerSkillService = createComposerSkillService({
    workspaceTarget,
    skills: composerSkillTargets.skills,
    loading: composerSkillTargets.loading,
    failed: composerSkillTargets.failed,
    request
  });
  const composerSkillsSupported = true;
  const { ensureFresh: ensureComposerSkills } = composerSkillService;
  watch(composerSkillTargets.skills, composerSkillTokenService.reconcile);
  watch(
    composerSkillTokens,
    (tokens) => {
      if (tokens.length > 0) ensureComposerSkills();
    },
    { immediate: true }
  );

  const workspaceQueueActions = mainPaneController.queueActions;

  const {
    reorder: reorderWorkspaceQueue,
    save: saveQueuedMessage,
    remove: deleteQueuedMessage,
    execute: executeQueuedMessage
  } = workspaceQueueActions;

  const workbenchCapabilityService = createWorkbenchCapabilityService({
    nodes,
    serverVersion,
    manifest: nodeManifest,
    manifestLoading: nodeManifestLoading,
    workspaceTarget,
    onNodeConnected: (nodeId) => handleNodeConnected(nodeId, false),
    request,
    notice,
    errorMessage: message
  });

  const {
    refreshNodes,
    refreshServerCapabilities,
    refreshNodeManifest,
    restoreNodeManifest,
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

  const selectedNodeStatus = computed<string | undefined>(() => {
    if (workspaceHost.value === undefined)
      return translate('generated.workbenchPageController.noNodeSelected');
    if (workspaceHost.value.disabled)
      return translate('generated.workbenchPageController.theNodeIsDisabledOnlyTheCurrent');
    if (!workspaceHost.value.connected)
      return translate('generated.workbenchPageController.theNodeIsOfflineLoadedContentIs');
    if (nodeManifestLoading.value) return undefined;
    if (nodeManifest.value === undefined)
      return translate(
        'generated.workbenchPageController.nodeWorkbenchCapabilitiesAreUnknownTheWorkspace'
      );
    if (nodeManifest.value.manifestVersion !== 1 || !nodeManifest.value.conversation.available)
      return translate(
        'generated.workbenchPageController.nodeWorkbenchCapabilitiesAreUnavailable',
        { value0: nodeManifest.value.conversation.reasonCode ?? 'INCOMPATIBLE_VERSION' }
      );
    return undefined;
  });

  const workbenchEntityActions = createWorkbenchEntityService({
    canDeleteSession,
    beginSubmission: submissionService.begin,
    loading,
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
    onFilesChanged: () => (workspaceFilesRevision.value += 1),
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
  async function checkForUpdates(): Promise<void> {
    if (checkingForUpdates.value || options.pwaApplication === undefined) return;
    checkingForUpdates.value = true;
    try {
      await options.pwaApplication.checkForUpdate();
      const state = options.pwaApplication.state.value;
      showMessage(
        translate(
          state.update
            ? 'webUpdate.available'
            : state.reload
              ? 'webUpdate.reloadAvailable'
              : 'webUpdate.upToDate'
        ),
        'info'
      );
    } catch (error) {
      showMessage(translate('webUpdate.checkFailed'), 'error', error);
    } finally {
      checkingForUpdates.value = false;
    }
  }

  async function applyWebUpdate(): Promise<void> {
    const result = await options.pwaApplication?.applyUpdate();
    if (result !== 'APPLIED') {
      showMessage(translate('webUpdate.unavailable'), 'warning');
    }
  }

  async function openWorkbenchNotification(notification: WorkbenchNotification): Promise<void> {
    if (notification.action === 'RELOAD_PAGE') {
      await applyWebUpdate();
      return;
    }
    const target = notification.target;
    if (target === undefined) return;
    await navigateWorkbenchTarget(target, true);
  }

  async function navigateWorkbenchTarget(
    target: NonNullable<WorkbenchNotification['target']>,
    markSessionReadAfterOpen = false
  ): Promise<void> {
    try {
      let groupRevision: number | undefined;
      await navigateWorkbenchNotification(target, {
        workspaceTarget: () => workspaceTarget.value,
        hasSession: (sessionId) =>
          sessions.value.some(
            (session) =>
              session.id === sessionId &&
              (!('workspaceId' in target) ||
                target.workspaceId === undefined ||
                session.workspaceId === target.workspaceId)
          ),
        showNodes: () => (view.value = 'nodes'),
        showConversations: () => (view.value = 'conversations'),
        activateWorkspace: async (workspace) => {
          const current = workspaceTarget.value;
          const hasSessionTarget = 'sessionId' in target && target.sessionId !== undefined;
          if (
            hasSessionTarget &&
            current?.nodeId === workspace.nodeId &&
            current.workspaceId === workspace.workspaceId
          ) {
            closeMobileSidebar();
            groupRevision = workspaceSessionDiscovery.groupSelectionRevision();
            return true;
          }
          const activated = await selectWorkspace(workspace, !hasSessionTarget);
          if (activated) groupRevision = workspaceSessionDiscovery.groupSelectionRevision();
          return activated;
        },
        synchronizeSessions: syncWorkspaceSessions,
        openSession: (sessionId) =>
          openNavigatedSession(sessionId, markSessionReadAfterOpen, groupRevision),
        openHostedConversation: openHostedConversationTarget
      });
    } catch (error) {
      notice(
        translate('generated.workbenchPageController.unableToOpenTheSessionLinkedTo', {
          value0: message(error)
        }),
        'error',
        error
      );
    }
  }

  async function openRecentRun(
    run: import('./workbench-notification-service.js').RecentRun
  ): Promise<void> {
    await openWorkbenchNotification({
      id: `recent-run:${run.nodeId}:${run.runId}`,
      source: 'server',
      kind: 'run',
      title: run.sessionTitle,
      message: '',
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      expiresAt: Number.MAX_SAFE_INTEGER,
      read: true,
      target: {
        targetType: 'WORKSPACE_SESSION',
        nodeId: run.nodeId,
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        sessionName: run.sessionTitle
      }
    });
  }

  async function openSessionGroupTarget(target: {
    nodeId: string;
    workspaceId: string;
    sessionId: string;
  }): Promise<void> {
    await navigateWorkbenchTarget({ targetType: 'WORKSPACE_SESSION', ...target }, true);
  }

  function openNavigatedSession(
    sessionId: string,
    markReadAfterOpen: boolean,
    groupRevision = workspaceSessionDiscovery.groupSelectionRevision()
  ): Promise<void> {
    const target = workspaceTarget.value;
    const onSessionResolved = (session: Session) => {
      if (
        target !== undefined &&
        workspaceTarget.value?.nodeId === target.nodeId &&
        workspaceTarget.value.workspaceId === target.workspaceId &&
        session.workspaceId === target.workspaceId &&
        selectedSessionId.value === session.id &&
        workspaceSessionDiscovery.groupSelectionRevision() === groupRevision
      )
        selectWorkspaceSessionGroup(session.sessionGroup ?? 'MAIN', true);
    };
    return markReadAfterOpen
      ? workbenchSessionSelectionService.openWorkspaceTabSession(sessionId, onSessionResolved)
      : openSession(sessionId, { onSessionResolved });
  }

  async function openSessionFromList(sessionId: string): Promise<void> {
    await workbenchSessionSelectionService.selectSession(sessionId);
  }

  const workspaceGit = createWorkspaceGitService({
    http: workspaceToolsHttp,
    target: () => (filesReady.value ? workspaceTarget.value : undefined),
    gitEnabled: () => selectedWorkspace.value?.kind === 'GIT_WORKSPACE',
    workspacePath: () => selectedWorkspace.value?.path,
    historyEnabled: () =>
      selectedWorkspace.value?.kind === 'GIT_WORKSPACE' &&
      nodeManifest.value?.git?.supportsHistory === true,
    onWorkspace: (workspace) =>
      updateWorkspaceMetadata(workspaceTarget.value?.nodeId ?? '', workspace),
    onBranch: (workspaceId, branch) =>
      updateWorkspaceBranch(workspaceTarget.value?.nodeId ?? '', workspaceId, branch),
    onFailure: (error, operation) => {
      if (operation === 'RESTORE')
        notice(
          translate('generated.workspaceInspector.unableToLoad', {
            value0: translate('generated.workspaceInspector.revertingChanges'),
            value1: message(error)
          }),
          'error',
          error
        );
    }
  });
  onBeforeUnmount(() => workspaceGit.reset());

  function openWorkspaceGitChange(entry: ChangeEntry, external = false): void {
    const target = workspaceTarget.value;
    if (!filesReady.value || target === undefined) return;
    const location = workspaceGit.changeLocation(entry);
    const intent = entry.diffAvailable ? workspaceGit.changeIntent(entry) : undefined;
    if (external) {
      if (intent !== undefined) openGitDiffExternal(intent);
      else
        openWorkspaceFileExternal(
          location.path,
          undefined,
          undefined,
          undefined,
          location.worktreePath,
          location.repositoryPath
        );
    } else if (intent !== undefined) void fileWorkbench.openTab(intent);
    else
      void fileWorkbench.openWorkspaceFile(
        location.path,
        undefined,
        location.worktreePath,
        false,
        undefined,
        location.repositoryPath
      );
  }
  function openWorkspaceHistoryDiff(
    commit: HistoryCommit,
    file: HistoryFile,
    external = false
  ): void {
    const target = workspaceTarget.value;
    if (!filesReady.value || target === undefined) return;
    const intent = workspaceGit.historyIntent(commit, file);
    if (intent === undefined) return;
    if (external) openGitDiffExternal(intent);
    else void fileWorkbench.openTab(intent);
  }

  const resolveWorkspaceGitRepositoryPath = workspaceGit.resolveRepositoryPath;
  const workspaceComparison = workspaceGit.comparison;
  const adjacentWorkspaceDiff = workspaceGit.adjacentDiff;
  function loadWorkspaceDiff(tab: WorkspaceFileTab, signal?: AbortSignal): Promise<unknown> {
    return tab.kind === 'TOOL_CHANGE_DIFF'
      ? loadToolChangeDiff(tab, (path) => workspaceToolsHttp.request(path), signal)
      : workspaceGit.loadDiff(tab, signal);
  }

  const workspaceFileTreeName = computed(() => {
    const workspace = selectedWorkspace.value;
    return workspaceFileTreeRootName(
      workspace?.path,
      workspace === undefined ? '' : workspaceTabLabel(workspace)
    );
  });
  function reportWorkspaceFileFailure(error: unknown, action: string): void {
    notice(
      translate('generated.workspaceInspector.unableToLoad', {
        value0: action,
        value1: message(error)
      }),
      'error',
      error
    );
  }
  const workspaceFileOperations = createWorkspaceFileOperationService({
    http: workspaceToolsHttp,
    onWritten: async (_target, current) => {
      if (current?.() === false) return;
      await workspaceFiles.refresh();
      if (current?.() !== false && selectedWorkspace.value?.kind === 'GIT_WORKSPACE')
        await workspaceGit.loadChanges();
    }
  });
  const workspaceFilesPanel = shallowRef<WorkspaceFilesPanelHandle>();
  const workspaceFiles = createWorkspaceFilesController({
    target: () => (filesReady.value ? workspaceTarget.value : undefined),
    workspaceName: () => workspaceFileTreeName.value,
    list: (target, path, cursor) => workspaceFileOperations.list(target, path, cursor),
    onWorkspace: (workspace) =>
      updateWorkspaceMetadata(workspaceTarget.value?.nodeId ?? '', workspace),
    onDeletedSelection: () => fileWorkbench.invalidateDeletedSelection(),
    onRevealSelection: async (path, current) => {
      await workspaceFilesPanel.value?.reveal(path, current);
    },
    onMutationFailure: (error, context, target, path) =>
      reportWorkspaceFileFailure(
        error,
        `${translate(
          context === 'move'
            ? 'generated.workspaceInspector.movingFile'
            : 'generated.workspaceInspector.fileOperation'
        )} (${target.nodeId}/${target.workspaceId}: ${path})`
      ),
    mutate: (target, action, path, destination, current) =>
      workspaceFileOperations.mutate(target, action, path, destination, current),
    revealLocal: (target, path) => workspaceFileOperations.reveal(target, path),
    preflight: (target, directory, names) =>
      workspaceFileOperations.preflight(target, directory, names),
    queue: (uploads) => queueWorkspaceUploads(uploads),
    onFailure: (error) =>
      reportWorkspaceFileFailure(error, translate('generated.workspaceInspector.uploadPreflight'))
  });
  const workspaceFilePage = shallowRef<WorkspaceFilePagePort>();
  async function revealWorkspaceFileTree(
    path: string,
    current: () => boolean = () => true
  ): Promise<void> {
    const scope = workspaceFiles.captureTarget();
    const needed = () => scope !== undefined && workspaceFiles.isCurrentTarget(scope) && current();
    if (!needed()) return;
    await workspaceFiles.tree.reveal(path, needed);
    if (!needed()) return;
    workspaceFiles.tree.selectPath(path);
    await workspaceFilesPanel.value?.reveal(path, needed);
  }
  async function downloadWorkspaceFile(path: string): Promise<void> {
    const target = workspaceTarget.value;
    if (target === undefined) return;
    try {
      await fileWorkbench.downloadTarget({ ...target, path });
    } catch (error) {
      reportWorkspaceFileFailure(error, path);
    }
  }
  const fileWorkbench = createWorkspaceFileWorkbenchController({
    externalTarget: () => workspaceTarget.value,
    fileWriteEnabled: () => fileWriteReady.value,
    onPopupBlocked: () =>
      notice(
        translate('generated.workspaceInspector.theBrowserBlockedTheFilePreviewWindow'),
        'error'
      ),
    page: () => workspaceFilePage.value,
    target: () => (filesReady.value ? workspaceTarget.value : undefined),
    prewarmEnabled: () => codeNavigationPrewarmReady.value,
    resolveRepositoryPath: resolveWorkspaceGitRepositoryPath,
    reveal: revealWorkspaceFileTree,
    comparison: workspaceComparison,
    onOpenFailure: (error, path) => notice(filePreviewErrorMessage(error, path), 'error', error),
    onRevealFailure: (error) => notice(message(error), 'error', error),
    preview: {
      http: workspaceToolsHttp,
      transfers: () => ({
        directFileReadRange: directWorkspaceFileReadRange,
        directFileObjectUrl: directWorkspaceFileObjectUrl,
        directFileDownload: directWorkspaceFileDownload,
        directGitFileReadRange,
        directGitFileObjectUrl,
        directGitFileDownload
      }),
      onWritten: (target) => {
        if (
          workspaceTarget.value?.nodeId !== target.nodeId ||
          workspaceTarget.value.workspaceId !== target.workspaceId
        )
          return;
        void workspaceFiles.requestRefresh();
        if (selectedWorkspace.value?.kind === 'GIT_WORKSPACE') void workspaceGit.loadChanges();
      }
    },
    navigation: {
      http: workspaceToolsHttp,
      onFailure: (error) => reportWorkspaceFileFailure(error, translate('fileEditor.definitions')),
      onFileTarget: (target, pageId) => fileWorkbench.openNavigationTarget(target, pageId)
    }
  });
  const openWorkspaceFileExternal = fileWorkbench.openExternal;
  const openGitDiffExternal = fileWorkbench.openDiffExternal;
  const openHtmlExternal = fileWorkbench.openHtmlExternal;
  function protectSuspendedFileDrafts(event: BeforeUnloadEvent): void {
    if (!fileWorkbench.hasSuspendedDrafts() || options.pwaApplication?.isReloadingForUpdate())
      return;
    event.preventDefault();
    event.returnValue = '';
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', protectSuspendedFileDrafts);
    onBeforeUnmount(() => window.removeEventListener('beforeunload', protectSuspendedFileDrafts));
  }
  onBeforeUnmount(() => fileWorkbench.dispose());
  let appliedFilesWatchRevision = -1;
  let pendingGitRestore: WorkspaceGitSnapshot | undefined;
  function applyWorkspaceToolWatch(): void {
    const snapshot = workspaceWatchSnapshot.value;
    const target = workspaceTarget.value;
    if (
      snapshot === undefined ||
      target === undefined ||
      snapshot.nodeId !== target.nodeId ||
      snapshot.workspaceId !== target.workspaceId
    )
      return;
    const revision = snapshot.filesWatchRevision;
    if (
      isFilePage(snapshot.files) &&
      (revision === undefined
        ? appliedFilesWatchRevision < 0
        : Number.isInteger(revision) && revision > appliedFilesWatchRevision)
    ) {
      workspaceFiles.tree.applyRootPage(snapshot.files.files);
      const workspace = filePageWorkspace(snapshot.files.workspace);
      if (workspace !== undefined) updateWorkspaceMetadata(target.nodeId, workspace);
      appliedFilesWatchRevision =
        revision === undefined || !Number.isInteger(revision) ? 0 : revision;
    }
    if (snapshot.changes !== undefined)
      workspaceGit.applyWatch(snapshot.changes, snapshot.changesWatchRevision);
  }
  function restorePendingGit(): void {
    if (pendingGitRestore === undefined || !filesReady.value) return;
    if (selectedWorkspace.value?.kind !== 'GIT_WORKSPACE') return;
    const snapshot = pendingGitRestore;
    pendingGitRestore = undefined;
    applyWorkspaceToolWatch();
    workspaceGit.restore(snapshot);
  }
  watch(workspaceWatchSnapshot, applyWorkspaceToolWatch);
  watch(workspaceFileTreeName, (name) => workspaceFiles.tree.setRootName(name));
  watch(
    () => [workspaceTarget.value?.nodeId, workspaceTarget.value?.workspaceId] as const,
    ([nodeId, workspaceId], [previousNodeId, previousWorkspaceId]) => {
      if (nodeId === previousNodeId && workspaceId === previousWorkspaceId) return;
      pendingGitRestore = undefined;
      appliedFilesWatchRevision = -1;
      workspaceFilePage.value = undefined;
      fileWorkbench.reset();
      workspaceFiles.invalidate();
      workspaceFiles.resetTree();
      workspaceGit.reset();
    },
    { flush: 'sync' }
  );
  watch(
    [filesReady, () => selectedWorkspace.value?.kind],
    ([ready, kind], [wasReady, oldKind]) => {
      if (oldKind === 'GIT_WORKSPACE' && kind !== undefined && kind !== 'GIT_WORKSPACE') {
        pendingGitRestore = undefined;
        workspaceGit.reset(true);
        fileWorkbench.removeGitTabs();
      }
      if (wasReady && !ready) {
        workspaceFiles.invalidate();
        workspaceFiles.invalidateTree();
      }
      if (ready) {
        fileWorkbench.resumeRestoration();
        applyWorkspaceToolWatch();
        restorePendingGit();
      }
    },
    { flush: 'sync' }
  );
  onBeforeUnmount(() => {
    workspaceFiles.invalidate();
    workspaceFiles.resetTree();
  });

  const workspaceSearch = createWorkspaceContentSearchService({
    http: workspaceToolsHttp,
    onFailure: (error) => {
      if (errorCode(error) === 'CAPABILITY_UNAVAILABLE')
        notice(
          translate('generated.workspaceInspector.unableToLoad', {
            value0: translate('generated.workspaceInspector.contentSearch'),
            value1: message(error)
          }),
          'error',
          error
        );
    }
  });
  const workspaceSearchPanel = shallowRef<WorkspaceSearchPanelHandle>();
  watch(
    () => [workspaceTarget.value?.nodeId, workspaceTarget.value?.workspaceId] as const,
    ([nodeId, workspaceId], [previousNodeId, previousWorkspaceId]) => {
      if (nodeId === previousNodeId && workspaceId === previousWorkspaceId) return;
      workspaceSearch.reset();
      workspaceSearchPanel.value?.restore({});
    },
    { flush: 'sync' }
  );
  function setWorkspaceSearchPanel(panel: WorkspaceSearchPanelHandle | null): void {
    const previous = workspaceSearchPanel.value;
    if (previous === panel) return;
    const target = workspaceTarget.value;
    if (
      previous !== undefined &&
      target !== undefined &&
      workspaceViewCacheService.isActive(target.nodeId, target.workspaceId)
    )
      workspaceViewCacheService.updateSearch(target.nodeId, target.workspaceId, {
        ...workspaceSearch.snapshot(),
        ...previous.snapshot()
      });
    workspaceSearchPanel.value = panel ?? undefined;
    if (panel !== null && target !== undefined)
      panel.restore(workspaceViewCacheService.view(target.nodeId, target.workspaceId).search ?? {});
  }
  onBeforeUnmount(() => workspaceSearch.reset());

  const {
    workspaceViewCache,
    discardWorkspaceViewCache,
    discardNodeViewCaches,
    saveCurrentWorkspaceView: saveMainWorkspaceView,
    restoreWorkspaceView,
    restoreWorkspaceDraft,
    restoreCachedSessionDetail,
    syncCachedRunStatus,
    cacheRunSnapshotFor,
    replaceConversationTurns
  } = createWorkbenchWorkspaceCacheController({
    cacheService: workspaceViewCacheService,
    paging: workspaceSessionPaging,
    sessions,
    runs,
    turns: conversationTurns,
    nextCursor: conversationNextCursor,
    contextUsage: sessionContextUsage,
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
      restore: (snapshot) => {
        if (snapshot === undefined) workspaceFiles.resetTree();
        else workspaceFiles.restoreTree(snapshot);
        workspaceFiles.tree.setRootName(workspaceFileTreeName.value);
        appliedFilesWatchRevision = -1;
        applyWorkspaceToolWatch();
      }
    },
    git: {
      snapshot: () => workspaceGit.snapshot(),
      restore: (snapshot) => {
        pendingGitRestore = snapshot;
        if (snapshot !== undefined) restorePendingGit();
      }
    },
    search: {
      snapshot: (previous) => ({
        ...workspaceSearch.snapshot(),
        ...(workspaceSearchPanel.value?.snapshot() ??
          (previous === undefined
            ? {}
            : {
                ...(previous.contentQuery === undefined
                  ? {}
                  : { contentQuery: previous.contentQuery }),
                ...(previous.contentUseRegex === undefined
                  ? {}
                  : { contentUseRegex: previous.contentUseRegex })
              }))
      }),
      restore: (snapshot) => {
        workspaceSearch.restore(snapshot ?? {});
        workspaceSearchPanel.value?.restore(snapshot ?? {});
      }
    },
    restoreDraftConfiguration: applyComposerDefaultConfiguration,
    persistDraft: persistSessionDraft,
    flushConversation: conversationProjectionService.flushPendingTextDeltas,
    tabId: workspaceTabId,
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

  const { applySnapshot: applyConversationSnapshot, paging: conversationPagingService } =
    mainPaneController.conversationWindow;

  let reactivateConnectedWorkspace = (_nodeId: string): boolean => false;

  function handleNodeConnected(nodeId: string, restartWatch = true): void {
    invalidateNodeManifest(nodeId);
    if (
      view.value === 'conversations' &&
      hostedConversationWorkspace.selectedNodeId.value === nodeId
    ) {
      if (restartWatch)
        void watchCoordinator.current?.restartHostedConversation().catch(() => undefined);
      return;
    }
    if (view.value !== 'nodes' || workspaceNodeId.value !== nodeId) return;
    if (
      activeWorkspaceId.value !== undefined &&
      selectedWorkspace.value === undefined &&
      reactivateConnectedWorkspace(nodeId)
    )
      return;
    void refreshNodeManifest(nodeId);
    if (!restartWatch) return;
    if (activeWorkspaceId.value !== undefined)
      void watchCoordinator.current?.restartWorkspace(activeWorkspaceId.value);
    if (selectedSessionId.value !== undefined) refreshSelectedSessionSnapshot();
  }

  const sessionPerformance = mainPaneController.performance;
  function refreshCurrentVisibleTool(nodeId: string, workspaceId: string): void {
    if (
      view.value !== 'nodes' ||
      workspaceNodeId.value !== nodeId ||
      activeWorkspaceId.value !== workspaceId
    )
      return;
    const active = workbenchAsideService.current({ nodeId, workspaceId }).active;
    if (!asideSurfaceVisible.value || active?.kind !== 'tool') return;
    if (active.id === 'changes') void workspaceGit.loadChanges();
    else if (active.id === 'files') void workspaceFiles.requestRefresh();
  }

  const { updateNodeConnection } = mainPaneController.events;

  const watchCoordinator: { current?: ReturnType<typeof createWorkbenchWatchCoordinator> } = {};
  const hostedConversationWorkspace = createHostedConversationWorkspaceService({
    request,
    workbenchConnectionId: () => workbenchConnectionId.value,
    selectedNodeId: baseState.hostedSelection.selectedNodeId,
    selectedConversationId: baseState.hostedSelection.selectedConversationId,
    heartbeatMs: SESSION_WATCH_HEARTBEAT_MS,
    requestTimeoutMs: SESSION_WATCH_REQUEST_TIMEOUT_MS,
    confirmationTimeoutMs: SESSION_WATCH_CONFIRMATION_TIMEOUT_MS
  });
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

  const nodeUpgradeProgress = ref<Readonly<Record<string, NodeUpgradeProgress | null>>>({});
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
      nodeUpgradeProgress.value = { ...nodeUpgradeProgress.value, [nodeId]: progress };
      nodes.value = nodes.value.map((node) =>
        node.id === nodeId ? { ...node, upgradeProgress: progress } : node
      );
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
      restoreVisibleAsideWatch();
    },
    onConnectionRestored: () => {
      nodeUpgradeProgress.value = {};
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
      if (!resumed) restoreVisibleAsideWatch();
    },
    onWatchEvent: (event) => {
      watchCoordinator.current?.handleEvent(event);
    },
    onDirectMessage: directTransport.handleDirect,
    onTerminalDirectMessage: directTransport.handleTerminalDirect,
    onUnauthenticated: () => returnToLogin(),
    onInvalidMessage: () =>
      notice(translate('generated.workbenchPageController.receivedAnUnreadableLiveUpdate'), 'error')
  });

  const {
    restore: restoreWorkbenchEventCursors,
    connect: connectWorkbenchLive,
    close: closeWorkbenchSocket
  } = workbenchLiveConnection;

  const directTransportEligibilityKey = computed(() =>
    nodes.value
      .map(
        (node) =>
          `${node.id}\0${node.connected ? '1' : '0'}\0${node.disabled ? '1' : '0'}\0${node.nodeAppVersion}`
      )
      .join('\n')
  );
  watch(directTransportEligibilityKey, () => void directTransport.reconcileNodes());
  watch(
    workspaceNodeId,
    (nodeId) => {
      directTransport.selectNode(nodeId);
    },
    { immediate: true, flush: 'sync' }
  );

  const workspaceDirectAvailable = (nodeId: string): boolean => {
    void workspaceDirectProbeRevision.value;
    return directTransport.isConnected(nodeId);
  };

  const workspaceDirectDescription = (nodeId: string): string | undefined => {
    if (!workspaceDirectAvailable(nodeId)) return undefined;
    const info = directTransport.networkInfo(nodeId);
    if (info === undefined) return translate('workspaceTabs.directAvailable');
    const scope = translate(
      `workspaceTabs.networkScope.${info.scope.toLowerCase()}` as
        | 'workspaceTabs.networkScope.loopback'
        | 'workspaceTabs.networkScope.private'
        | 'workspaceTabs.networkScope.public'
        | 'workspaceTabs.networkScope.vpn_tun'
        | 'workspaceTabs.networkScope.unknown'
    );
    const ipVersion =
      info.ipVersion === 'UNKNOWN'
        ? ''
        : translate(
            `workspaceTabs.ipVersion.${info.ipVersion.toLowerCase()}` as
              'workspaceTabs.ipVersion.ipv4' | 'workspaceTabs.ipVersion.ipv6'
          );
    const protocol = info.protocol === 'UNKNOWN' ? '' : info.protocol;
    const interfaceType =
      info.interfaceType === 'UNKNOWN' ||
      (info.scope === 'VPN_TUN' && info.interfaceType === 'VPN') ||
      (info.scope === 'LOOPBACK' && info.interfaceType === 'LOOPBACK')
        ? ''
        : translate(
            `workspaceTabs.interfaceType.${info.interfaceType.toLowerCase()}` as
              | 'workspaceTabs.interfaceType.ethernet'
              | 'workspaceTabs.interfaceType.wifi'
              | 'workspaceTabs.interfaceType.cellular'
              | 'workspaceTabs.interfaceType.vpn'
              | 'workspaceTabs.interfaceType.loopback'
          );
    return translate('workspaceTabs.directAvailableWithNetwork', {
      network: [scope, ipVersion, protocol, interfaceType].filter(Boolean).join(' ')
    });
  };

  const workspaceLocalFileManagerAvailable = computed(() => {
    void workspaceDirectProbeRevision.value;
    const nodeId = workspaceNodeId.value;
    return nodeId !== undefined && directTransport.networkInfo(nodeId)?.scope === 'LOOPBACK';
  });

  function workspaceDirectFile(
    path: string,
    worktreePath?: string,
    repositoryPath?: string,
    signal?: AbortSignal
  ) {
    if (isComposerAttachmentResourcePath(path)) return undefined;
    const nodeId = workspaceNodeId.value;
    const workspaceId = activeWorkspaceId.value;
    const manifest = nodeManifest.value;
    const nodeGeneration = manifest?.nodeGeneration;
    if (
      nodeId === undefined ||
      workspaceId === undefined ||
      nodeGeneration === undefined ||
      !workspaceDirectAvailable(nodeId)
    )
      return undefined;
    const resource = {
      kind: 'WORKSPACE_FILE' as const,
      workspaceId,
      path,
      ...(repositoryPath === undefined ? {} : { repositoryPath }),
      ...(worktreePath === undefined ? {} : { worktreePath })
    };
    return {
      direct: workspaceDirectTransfer,
      nodeId,
      nodeGeneration,
      resource,
      metadata: () =>
        manifest?.directTransfer?.download === true
          ? readWorkspaceDirectFileMetadata({
              request,
              nodeId,
              resource,
              ...(signal === undefined ? {} : { signal })
            })
          : Promise.resolve(undefined)
    };
  }

  function gitDirectFile(
    commit: string,
    path: string,
    repositoryPath: string,
    refs: readonly string[],
    signal?: AbortSignal
  ) {
    const nodeId = workspaceNodeId.value;
    const workspaceId = activeWorkspaceId.value;
    const nodeGeneration = nodeManifest.value?.nodeGeneration;
    if (
      nodeId === undefined ||
      workspaceId === undefined ||
      nodeGeneration === undefined ||
      nodeManifest.value?.directTransfer?.gitCommitBlob !== true ||
      !workspaceDirectAvailable(nodeId)
    )
      return undefined;
    const resource = {
      kind: 'GIT_COMMIT_BLOB' as const,
      workspaceId,
      commit,
      path,
      ...(repositoryPath.length === 0 ? {} : { repositoryPath })
    };
    const capturedRefs = [...refs];
    return {
      direct: workspaceDirectTransfer,
      nodeId,
      nodeGeneration,
      resource,
      metadata: () =>
        readGitDirectFileMetadata({
          request,
          nodeId,
          resource,
          refs: capturedRefs,
          ...(signal === undefined ? {} : { signal })
        })
    };
  }

  async function directWorkspaceFileReadRange(
    path: string,
    offset: number,
    length: number,
    worktreePath?: string,
    identity?: WorkspaceDirectFileIdentity,
    repositoryPath?: string,
    signal?: AbortSignal
  ) {
    if (nodeManifest.value?.directTransfer?.range !== true) return undefined;
    const target = workspaceDirectFile(path, worktreePath, repositoryPath, signal);
    if (target === undefined) return undefined;
    return readWorkspaceDirectFileRange({
      ...target,
      fileName: path.split('/').at(-1) ?? 'file',
      offset,
      length,
      ...(signal === undefined ? {} : { signal }),
      ...(identity === undefined ? {} : { identity })
    }).catch(() => undefined);
  }

  async function directGitFileReadRange(
    commit: string,
    path: string,
    repositoryPath: string,
    refs: readonly string[],
    offset: number,
    length: number,
    identity?: WorkspaceDirectFileIdentity,
    signal?: AbortSignal
  ) {
    if (nodeManifest.value?.directTransfer?.range !== true) return undefined;
    const target = gitDirectFile(commit, path, repositoryPath, refs, signal);
    if (target === undefined) return undefined;
    return readWorkspaceDirectFileRange({
      ...target,
      fileName: path.split('/').at(-1) ?? 'file',
      offset,
      length,
      ...(signal === undefined ? {} : { signal }),
      ...(identity === undefined ? {} : { identity })
    }).catch(() => undefined);
  }

  async function directWorkspaceFileObjectUrl(
    path: string,
    worktreePath?: string,
    repositoryPath?: string,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const target = workspaceDirectFile(path, worktreePath, repositoryPath, signal);
    return target === undefined
      ? undefined
      : (
          await readWorkspaceDirectObjectUrl({
            ...target,
            ...(signal === undefined ? {} : { signal })
          })
        )?.url;
  }

  async function directWorkspaceFileDownload(
    path: string,
    worktreePath?: string,
    repositoryPath?: string
  ): Promise<WorkspaceDirectDownloadResult> {
    if (nodeManifest.value?.directTransfer?.download !== true) return 'UNAVAILABLE';
    const target = workspaceDirectFile(path, worktreePath, repositoryPath);
    return target === undefined || options.pwaApplication === undefined
      ? 'UNAVAILABLE'
      : downloadWorkspaceDirectFile({
          ...target,
          activeWorker: options.pwaApplication.activeWorker
        });
  }

  async function directGitFileObjectUrl(
    commit: string,
    path: string,
    repositoryPath: string,
    refs: readonly string[],
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const target = gitDirectFile(commit, path, repositoryPath, refs, signal);
    return target === undefined
      ? undefined
      : (
          await readWorkspaceDirectObjectUrl({
            ...target,
            ...(signal === undefined ? {} : { signal })
          })
        )?.url;
  }

  async function directGitFileDownload(
    commit: string,
    path: string,
    repositoryPath: string,
    refs: readonly string[]
  ): Promise<WorkspaceDirectDownloadResult> {
    if (nodeManifest.value?.directTransfer?.download !== true) return 'UNAVAILABLE';
    const target = gitDirectFile(commit, path, repositoryPath, refs);
    return target === undefined || options.pwaApplication === undefined
      ? 'UNAVAILABLE'
      : downloadWorkspaceDirectFile({
          ...target,
          activeWorker: options.pwaApplication.activeWorker
        });
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
    refreshSessions: refreshAdminSessions,
    logoutSession: logoutAdminSession,
    login,
    changePassword,
    logout
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
    title: runnerUsageTitle,
    formatTimestamp: formatUsageTimestamp,
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
    globalLoading: loading,
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

  const workspaceSessionDiscovery = createWorkspaceSessionService({
    groupingSupported: () => nodeManifest.value?.sessionGroups?.apiVersion === 1,
    sessions,
    runs,
    workspaceTarget,
    selectedSessionId,
    paging: workspaceSessionPaging,
    pageSize: WORKSPACE_SESSION_PAGE_SIZE,
    tabId: workspaceTabId,
    request,
    notice,
    errorMessage: message
  });

  const {
    currentGroup: workspaceSessionGroup,
    selectGroup: selectWorkspaceSessionGroup,
    refreshing: refreshingWorkspaceSessions,
    searchQuery: workspaceSessionSearchQuery,
    searchResults: workspaceSessionSearchResults,
    searchNextCursor: workspaceSessionSearchNextCursor,
    searching: searchingWorkspaceSessions,
    loadingMoreSearchResults: loadingMoreWorkspaceSessionSearchResults,
    loadMoreSearchResultsError: loadMoreWorkspaceSessionSearchResultsError,
    preserveManagedActive: preserveManagedActiveSession,
    merge: mergeSessions,
    applySnapshot: applyWorkspaceSessionSnapshot,
    loadMore: loadMoreWorkspaceSessions,
    search: searchWorkspaceSessions,
    loadMoreSearchResults: loadMoreWorkspaceSessionSearchResults,
    synchronize: syncWorkspaceSessions,
    refresh: refreshWorkspaceSessions
  } = workspaceSessionDiscovery;
  const visibleWorkspaceSessions = computed(() =>
    (workspaceSessionSearchQuery.value.length > 0
      ? workspaceSessionSearchResults.value
      : unfilteredWorkspaceSessions.value
    ).filter(
      (session) =>
        workspaceSessionGroup.value === undefined ||
        ((session.sessionGroup ?? 'MAIN') === workspaceSessionGroup.value &&
          (workspaceSessionSearchQuery.value.length > 0 ||
            workspaceSessionDiscovery.listedSessionIds.value.has(session.id)))
    )
  );
  const canLoadMoreWorkspaceSessions = computed(() =>
    workspaceSessionSearchQuery.value.length > 0
      ? workspaceSessionSearchNextCursor.value !== null
      : canLoadMoreUnfilteredWorkspaceSessions.value
  );
  const loadingMoreVisibleWorkspaceSessions = computed(() =>
    workspaceSessionSearchQuery.value.length > 0
      ? loadingMoreWorkspaceSessionSearchResults.value
      : workspaceSessionPaging.loadingMore.value
  );
  const loadMoreWorkspaceSessionsError = computed(() => {
    if (workspaceSessionSearchQuery.value.length > 0)
      return loadMoreWorkspaceSessionSearchResultsError.value;
    const target = workspaceTarget.value;
    return target === undefined
      ? undefined
      : workspaceSessionPaging.loadMoreErrors.value.get(
          workspaceTabId(target.nodeId, target.workspaceId)
        );
  });
  function loadMoreVisibleWorkspaceSessions(): Promise<void> {
    return workspaceSessionSearchQuery.value.length > 0
      ? loadMoreWorkspaceSessionSearchResults()
      : loadMoreWorkspaceSessions();
  }

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
    removeWebVersionSubscription?.();
    removeWebVersionSubscription = undefined;
    watchCoordinator.current?.dispose();
    hostedConversationWorkspace.clearSelectedConversation();
    directTransport.reset();
    closeWorkbenchLive();
    nodes.value = [];
    nodeUpgradeProgress.value = {};
    serverVersion.value = '';
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
    sessions,
    workspaceTarget,
    selectedSessionId,
    selectedRunId,
    activeTabId: activeWorkspaceTabId,
    showWorkbench: () => {
      view.value = 'nodes';
    },
    loading,
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
    copyConversationMessage,
    workspaceShortcuts,
    openAgentWorkspaceFile,
    openAgentFileChange,
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
    quickOpenFileVisible,
    workspaceFileWorkbench,
    fileWorkbench,
    openWorkspaceFileExternal,
    showAsideTool: (tool) => {
      const target = workspaceTarget.value;
      if (target === undefined) return;
      selectAsideTool({ ...target, id: tool });
      void nextTick(() => {
        if (tool === 'search') void workspaceSearchPanel.value?.focus();
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

  const shouldDisplayConversationItem = displayConversationItem;

  const userInputAnswer = conversationUserInputService.answer;

  const userInputSubmitted = conversationUserInputService.submitted;

  const setUserInputAnswer = conversationUserInputService.setAnswer;

  async function submitUserInput(
    turn: ConversationTurn,
    item: ConversationTurn['items'][number]
  ): Promise<void> {
    await conversationUserInputService.submit(turn, item);
  }

  const activePlanContinuation = mainPaneController.activePlanContinuation;
  const activeGoal = mainPaneController.activeGoal;
  const { implementPlan } = mainPaneController.plan;

  const composerController = mainPaneController.composer;

  const {
    loadProfiles: loadRunnerProfiles,
    applyDefaults: applyRunnerDefaults,
    normalize: normalizeNewSessionOptions,
    applyConfiguration: applyComposerConfiguration,
    selectRunner: selectComposerRunner
  } = composerController;

  const selectComposerAccess = mainPaneController.selectAccess;
  const selectComposerModelEffort = mainPaneController.selectModelEffort;

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

  const workspaceWatchService = createWorkspaceWatchService({
    sessionGroup: () => workspaceSessionGroup.value,
    sessionNavigation: () => navigationQuery.value,
    workspaceTarget,
    workspaces,
    heartbeatMs: WORKSPACE_WATCH_HEARTBEAT_MS,
    enabled: () => true,
    workbenchConnectionId: () => workbenchConnectionId.value,
    request,
    onSnapshot: (nodeId, workspaceId, snapshot, topic, revision, capturedQuery) => {
      if (topic === 'sessionNavigation') {
        if (
          workspaceTarget.value?.nodeId === nodeId &&
          workspaceTarget.value.workspaceId === workspaceId &&
          capturedQuery !== undefined &&
          sameNavigation(navigationQuery.value, capturedQuery)
        )
          sessionNavigation.accept(
            { nodeId, workspaceId },
            capturedQuery,
            snapshot.sessionNavigation
          );
        return;
      }
      workspaceWatchSnapshot.value = mergeWorkspaceWatchSnapshot(
        workspaceWatchSnapshot.value,
        nodeId,
        workspaceId,
        snapshot,
        { topic, revision }
      );
      const branch = currentChangesBranch(snapshot.changes);
      if (branch !== undefined) updateWorkspaceBranch(nodeId, workspaceId, branch);
      const sessionPage = snapshot.sessions as
        | {
            readonly sessions?: readonly Session[];
            readonly nextCursor?: string | null;
            readonly runningCounts?: import('@myagentroam/protocol').SessionRunningCounts;
          }
        | undefined;
      if (Array.isArray(sessionPage?.sessions)) {
        const selectedSession = sessions.value.find(
          (session) => session.id === selectedSessionId.value
        );
        applyWorkspaceSessionSnapshot(nodeId, workspaceId, {
          sessions: [...sessionPage.sessions],
          ...(sessionPage.runningCounts === undefined
            ? {}
            : { runningCounts: sessionPage.runningCounts }),
          nextCursor: sessionPage.nextCursor ?? null
        });
        const refreshedSelectedSession = sessions.value.find(
          (session) => session.id === selectedSessionId.value
        );
        sessionWatchController.reconcileWorkspaceSnapshot(
          selectedSession,
          refreshedSelectedSession
        );
      }
    }
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

  const workbenchWorkspaceSelectionService = createWorkbenchWorkspaceSelectionService({
    workspaceTarget,
    selectedSessionId,
    workspaces,
    sessions,
    draftOpen: draftSessionOpen,
    profilesLoading: runnerProfilesLoading,
    selectedRunId,
    isCacheActive: workspaceViewCacheService.isActive,
    manifest: nodeManifest,
    manifestLoading: nodeManifestLoading,
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
    clearContent: () => {
      nextDetailRequest();
      runService.replaceRuns([]);
      restoreConversationWindow([], null);
      sessionContextUsage.value = undefined;
    },
    showWorkbench: () => {
      view.value = 'nodes';
    },
    closeSidebar: closeMobileSidebar,
    restoreProfiles: runnerProfileService.restore,
    restoreManifest: restoreNodeManifest,
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
    resetQueue: () => (workspaceQueue.value = { version: 0, paused: false, items: [] }),
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

  const initialStandaloneFileIntent =
    typeof location === 'undefined' ? undefined : standaloneFileOpenIntent(location.href);
  const standaloneFileMode = ref(initialStandaloneFileIntent !== undefined);
  const standaloneFileLoading = ref(initialStandaloneFileIntent !== undefined);
  const standaloneFileError = ref(false);
  const pendingStandaloneFileIntent = ref<StandaloneFileOpenIntent | undefined>(
    initialStandaloneFileIntent
  );
  let pendingStandaloneFileUrl = typeof location === 'undefined' ? undefined : location.href;
  let openingStandaloneFileIntent = false;

  function receiveStandaloneFileIntent(event: Event): void {
    const url = (event as Event & { readonly detail?: { readonly url?: unknown } }).detail?.url;
    if (typeof url !== 'string') return;
    const intent = standaloneFileOpenIntent(url);
    if (intent === undefined) return;
    event.preventDefault();
    standaloneFileMode.value = true;
    standaloneFileLoading.value = true;
    standaloneFileError.value = false;
    pendingStandaloneFileIntent.value = intent;
    pendingStandaloneFileUrl = url;
  }

  async function openPendingStandaloneFileIntent(): Promise<void> {
    const intent = pendingStandaloneFileIntent.value;
    const intentUrl = pendingStandaloneFileUrl;
    if (
      intent === undefined ||
      openingStandaloneFileIntent ||
      !admin.value.authenticated ||
      nodes.value.length === 0
    )
      return;
    openingStandaloneFileIntent = true;
    standaloneFileError.value = false;
    let consumedStandaloneFileIntent = false;
    try {
      if (
        workspaceNodeId.value !== intent.nodeId ||
        activeWorkspaceId.value !== intent.workspaceId
      ) {
        await selectWorkspace({ nodeId: intent.nodeId, workspaceId: intent.workspaceId });
        if (pendingStandaloneFileIntent.value !== intent) return;
        if (
          workspaceNodeId.value !== intent.nodeId ||
          activeWorkspaceId.value !== intent.workspaceId
        ) {
          pendingStandaloneFileIntent.value = undefined;
          consumedStandaloneFileIntent = true;
          standaloneFileError.value = true;
          return;
        }
      }
      if (!filesReady.value) {
        if (nodeManifestLoading.value) return;
        pendingStandaloneFileIntent.value = undefined;
        consumedStandaloneFileIntent = true;
        standaloneFileError.value = true;
        return;
      }
      if (pendingStandaloneFileIntent.value !== intent) return;
      pendingStandaloneFileIntent.value = undefined;
      consumedStandaloneFileIntent = true;
      if (intent.tab !== undefined) await fileWorkbench.openTab(intent.tab);
      else if (intent.worktreePath === undefined && intent.repositoryPath === undefined)
        await fileWorkbench.openFile(intent.path, intent.line, intent.column);
      else
        await fileWorkbench.openWorkspaceFile(
          intent.path,
          intent.line,
          intent.worktreePath,
          false,
          intent.column,
          intent.repositoryPath
        );
      if (
        pendingStandaloneFileIntent.value === undefined &&
        workspaceNodeId.value === intent.nodeId &&
        activeWorkspaceId.value === intent.workspaceId &&
        intentUrl !== undefined &&
        typeof location !== 'undefined' &&
        typeof history !== 'undefined'
      ) {
        const nextUrl = new URL(intentUrl, location.href);
        if (nextUrl.origin === location.origin && nextUrl.pathname === location.pathname) {
          history.replaceState(history.state, '', nextUrl);
          captureMobileLayerRoute();
        }
      }
    } catch {
      if (pendingStandaloneFileIntent.value === intent) {
        pendingStandaloneFileIntent.value = undefined;
        standaloneFileError.value = true;
      } else if (
        consumedStandaloneFileIntent &&
        pendingStandaloneFileIntent.value === undefined &&
        workspaceNodeId.value === intent.nodeId &&
        activeWorkspaceId.value === intent.workspaceId
      ) {
        standaloneFileError.value = true;
      }
      consumedStandaloneFileIntent = true;
    } finally {
      if (consumedStandaloneFileIntent && pendingStandaloneFileIntent.value === undefined)
        standaloneFileLoading.value = false;
      openingStandaloneFileIntent = false;
      if (
        pendingStandaloneFileIntent.value !== undefined &&
        pendingStandaloneFileIntent.value !== intent
      )
        void Promise.resolve().then(openPendingStandaloneFileIntent);
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener(STANDALONE_FILE_OPEN_EVENT, receiveStandaloneFileIntent);
    onBeforeUnmount(() =>
      window.removeEventListener(STANDALONE_FILE_OPEN_EVENT, receiveStandaloneFileIntent)
    );
  }
  watch(
    [
      pendingStandaloneFileIntent,
      () => admin.value.authenticated,
      workspaceNodeId,
      activeWorkspaceId,
      filesReady,
      nodeManifestLoading
    ],
    () => void openPendingStandaloneFileIntent(),
    { immediate: true, flush: 'post' }
  );

  const workbenchSessionSelectionService = createWorkbenchSessionSelectionService({
    createPaneLoader: (projection) =>
      mainPane.createLoader({
        ...projection,
        request,
        sessionPathId: agentSessionPathId
      }),
    aside: workbenchAsideService,
    canOpenAside: () =>
      supportsSessionAside(
        nodes.value.find((node) => node.id === workspaceNodeId.value)?.nodeAppVersion,
        nodeManifest.value?.sessionAside
      ),
    saveAside: () => saveAsideContext(),
    workspaceTarget,
    selectedSessionId,
    selectedRunId,
    sessions,
    runs,
    turns: conversationTurns,
    loadingInitial: loadingInitialConversation,
    initialLoadFailed: initialConversationLoadFailed,
    initialFailureCause: mainPane.conversation.initialFailureCause,
    queue: workspaceQueue,
    positioning: positioningInitialConversation,
    draftOpen: draftSessionOpen,
    composerMode,
    selectedCommand: selectedRunnerCommand,
    commandPickerOpen,
    nextRequest: nextDetailRequest,
    currentRequest: currentDetailRequest,
    closeMobileSurface: closeMobileWorkspaceSurface,
    workspaceTabId,
    ensureSessionVisible: workspaceSessionPaging.ensureVisible,
    markSessionRead: markVisibleSessionRead,
    saveCurrent: saveCurrentWorkspaceView,
    selectWorkspace,
    applyComposerConfiguration,
    restoreCachedDetail: restoreCachedSessionDetail,
    cachedQueue: (nodeId, workspaceId, sessionId) =>
      workspaceViewCacheService.queueFor(nodeId, workspaceId, sessionId) ?? {
        version: 0,
        paused: false,
        items: []
      },
    installCachedDetail: (detail) => {
      runService.replaceRuns(detail.runs);
      restoreConversationWindow(detail.turns, detail.nextCursor);
      sessionContextUsage.value = detail.contextUsage ?? null;
    },
    clearActiveContent: () => {
      runService.replaceRuns([]);
      restoreConversationWindow([], null);
      sessionContextUsage.value = undefined;
    },
    openRun,
    scrollLatest: () => {
      const requestId = currentDetailRequest();
      return conversationScrollService.scrollToLatestAfterLayout(
        () => currentDetailRequest() === requestId
      );
    },
    beginInitialRender: beginConversationInitialRender,
    replaceSession,
    canWatch: canWatchSessionHistory,
    hasInitialSnapshot: (sessionId) => sessionWatchController.hasInitialSessionSnapshot(sessionId),
    beginWatch: async (sessionId) => {
      const requestId = currentDetailRequest();
      const target = workspaceTarget.value;
      if (
        !(await workbenchLiveConnection.waitForReady()) ||
        requestId !== currentDetailRequest() ||
        target !== workspaceTarget.value ||
        selectedSessionId.value !== sessionId ||
        view.value !== 'nodes' ||
        document.visibilityState !== 'visible'
      )
        throw new ApiError('WATCH_CANCELLED', 'The session selection was stopped or replaced.');
      const coordinator = watchCoordinator.current;
      if (coordinator === undefined) return false;
      await coordinator.beginSession(sessionId);
      return sessionWatchController.hasInitialSessionSnapshot(sessionId);
    },
    applySnapshot: applyConversationSnapshot,
    mergeTurns: mergeLatestConversationTurns
  });

  const workbenchRouteService = createWorkbenchRouteService({
    nodes,
    sessions,
    workspaceTarget,
    selectedSessionId,
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
      hostedConversationMobileFilesOpen.value = false;
      closeMobileWorkspaceSurface();
    },
    syncRoute: syncWorkbenchRoute
  });
  const restoringHostedConversationRoute = ref(hostedConversationRoute !== undefined);

  const {
    renameNode,
    renameSession,
    moveSessionToMain,
    setSessionPinned,
    movePinnedSession,
    movePinnedSessionTo,
    deleteSession,
    deleteNode
  } = createWorkbenchEntityController({
    actions: workbenchEntityActions,
    nodes,
    sessions,
    clearActiveContent: () => {
      runService.replaceRuns([]);
      restoreConversationWindow([], null);
    },
    clearRuns: () => runService.replaceRuns([]),
    workspaceTarget,
    selectedSessionId,
    selectedRunId,
    nodeManifest,
    workspaces,
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
    closeMobileSidebar();
    view.value = 'management';
    managementSection.value = options.nodeManagementSection;
  }

  function closeWorkspaceRegistration(): void {
    workspaceRegistrationNodeId.value = undefined;
    resetWorkspaceRegistration();
  }

  async function addWorkspaceForNode(nodeId: string): Promise<void> {
    closeMobileSidebar();
    view.value = 'nodes';
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
    selectedRunId,
    selectedWorkspace,
    sessions,
    clearActiveContent: () => {
      runService.replaceRuns([]);
      restoreConversationWindow([], null);
    },
    loadingOlderConversation,
    loadingInitialConversation,
    initialLoadFailed: initialConversationLoadFailed,
    sessionContextUsage,
    sessionInput,
    draftSessionOpen,
    newSessionRunner,
    newSessionModel,
    newSessionEffort,
    newSessionAccess,
    runnerProfiles,
    canUseComposer,
    closeMobileWorkspaceSurface,
    saveCurrent: saveCurrentWorkspaceView,
    stopSelectedSessionWatch,
    nextDetailRequest,
    applyRunnerDefaults,
    resetRunnerInteraction: runnerInteractionService.reset,
    focusInputAt: (cursor) => focusComposerInputAt(cursor)
  });
  const {
    onDragEnter: onComposerAttachmentDragEnter,
    onDragLeave: onComposerAttachmentDragLeave,
    onDrop: onComposerAttachmentDrop,
    onPaste: onNewSessionPaste
  } = mainPaneController.attachmentInput;
  function openNewSessionComposer(): void {
    // Explicit New starts a main session; restoring an empty Workspace keeps its group.
    selectWorkspaceSessionGroup('MAIN');
    openDraftSessionComposer();
  }
  openNewSessionComposerShortcut = openNewSessionComposer;

  async function createRegistrationToken(context?: NodeRegistrationContext): Promise<void> {
    loading.value = true;

    try {
      registrationToken.value = (
        await (options.submitNodeRegistration === undefined
          ? request<{ token: string }>('/api/node-registration-tokens', { method: 'POST' })
          : options.submitNodeRegistration(request, context))
      ).token;
    } catch (error) {
      notice(
        translate('generated.workbenchPageController.unableToCreateARegistrationToken', {
          value0: message(error)
        }),
        'error',
        error
      );
    } finally {
      loading.value = false;
    }
  }

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
  watch(
    sessionHistoryMutation.pending,
    (pending) => {
      loading.value = pending;
    },
    { flush: 'sync' }
  );
  const rewindConversation = mainPaneController.rewindConversation;
  const rollbackConversation = mainPaneController.rollbackConversation;

  const sessionWatchController = mainPaneController.watch;
  watchCoordinator.current = createWorkbenchWatchCoordinator({
    workspace: workspaceWatchService,
    session: sessionWatchController,
    secondary: asidePaneController.watch,
    hosted: hostedConversationWorkspace
  });
  watch(
    mainSurfaceVisible,
    (visible) => {
      const coordinator = watchCoordinator.current;
      if (!visible) {
        coordinator?.stopSession();
        return;
      }
      const sessionId = selectedSessionId.value;
      if (
        view.value === 'nodes' &&
        workspaceTarget.value !== undefined &&
        !draftSessionOpen.value &&
        sessionId !== undefined &&
        (typeof document === 'undefined' || document.visibilityState === 'visible')
      )
        void Promise.resolve(coordinator?.restartSession(sessionId)).catch(() => undefined);
    },
    { flush: 'sync' }
  );

  saveAsideContext = () => {
    const target = asideTarget.value;
    const session = asidePaneController.configuration.selectedSession.value;
    if (target === undefined || session === undefined || session.id !== target.sessionId) return;
    asidePane.draft.persist();
    asidePane.conversation.projection.flushPendingTextDeltas();
    workspaceViewCacheService.captureSession(
      target.nodeId,
      target.workspaceId,
      session,
      asideQueue.value,
      {
        sessionId: target.sessionId,
        runs: asidePane.run.runs.value,
        turns: asidePane.conversation.turns.value,
        nextCursor: asidePane.conversation.nextCursor.value,
        contextUsage: asidePane.conversation.contextUsage.value ?? null,
        lastAccessedAt: Date.now()
      },
      MAX_CACHED_SESSION_DETAILS
    );
  };
  const asideLoader = asidePane.createLoader({
    request,
    sessionPathId: agentSessionPathId,
    replaceSession: (previousId, session) => {
      const target = asideTarget.value;
      if (target) acceptAsideSession(target.nodeId, target.workspaceId, previousId, session);
    },
    applyComposerConfiguration: asidePaneController.composer.applyConfiguration,
    markActive: (session) => {
      const target = asideTarget.value;
      if (target)
        asidePane.acceptResolvedSession(target.nodeId, { ...session, activity: 'MANAGED_ACTIVE' });
    },
    openRun: asidePaneController.realtime.openRun,
    canWatch: asidePaneController.watch.canWatchSessionHistory,
    beginWatch: async (sessionId) => {
      const target = asideTarget.value;
      const revision = asidePane.conversation.currentDetailRequest();
      if (
        !(await workbenchLiveConnection.waitForReady()) ||
        target === undefined ||
        target !== asideTarget.value ||
        target.sessionId !== sessionId ||
        revision !== asidePane.conversation.currentDetailRequest() ||
        !asideVisible.value ||
        document.visibilityState !== 'visible'
      )
        throw new ApiError('WATCH_CANCELLED', 'The session selection was stopped or replaced.');
      const coordinator = watchCoordinator.current;
      if (coordinator === undefined) return false;
      await coordinator.beginSecondarySession(sessionId);
      return asidePaneController.watch.hasInitialSessionSnapshot(sessionId);
    },
    applySnapshot: asidePaneController.conversationWindow.applySnapshot,
    mergeTurns: asidePane.conversation.projection.mergeLatest,
    saveCurrent: () => saveAsideContext()
  });
  const asideLifecycle = createWorkspaceSessionPaneLifecycle({
    target: asideTarget,
    visible: asideVisible,
    loading: asideLoading,
    loadingContent: asideInitialContentLoading,
    failed: asidePane.conversation.initialLoadFailed,
    failureCause: asidePane.conversation.initialFailureCause,
    currentRequest: asidePane.conversation.currentDetailRequest,
    loader: asideLoader,
    restore: (target) => {
      const detail = workspaceViewCacheService.touchDetail(
        target.nodeId,
        target.workspaceId,
        target.sessionId
      );
      asideQueue.value = workspaceViewCacheService.queueFor(
        target.nodeId,
        target.workspaceId,
        target.sessionId
      ) ?? { version: 0, paused: false, items: [] };
      asidePane.run.replaceRuns(detail?.runs ?? []);
      asidePane.conversation.projection.restoreWindow(
        detail?.turns ?? [],
        detail?.nextCursor ?? null
      );
      asidePane.conversation.contextUsage.value = detail?.contextUsage ?? null;
      return detail !== undefined;
    },
    save: () => saveAsideContext(),
    cancel: () => {
      asidePane.cancelRead();
      asidePane.conversation.cancelInitialRender();
    },
    stopWatch: () => watchCoordinator.current?.stopSecondarySession(),
    beginInitialRender: asidePane.conversation.beginInitialRender,
    scrollElement: () => asidePane.scroll.element.value,
    scrollLatest: (isCurrent) => asidePane.scroll.scrollToLatestAfterLayout(isCurrent),
    markRead: markVisibleSessionRead
  });
  reloadAsideSession = () => {
    void asideLifecycle.reload();
  };
  openAsideTarget = async (sessionId) => {
    const target = asideTarget.value;
    if (target === undefined) return;
    if (
      target.sessionId !== sessionId &&
      !workbenchSessionSelectionService.openAsideSession({ ...target, sessionId })
    )
      return;
    await asideLifecycle.reload();
    if (asidePane.conversation.initialLoadFailed.value)
      throw new ApiError(
        'SESSION_HISTORY_INITIAL_FAILED',
        'The initial session snapshot has not been applied.'
      );
  };
  watch(
    [workspaceTarget, nodeManifest, () => selectedWorkspace.value?.kind],
    ([target, manifest, kind]) => {
      if (target === undefined || manifest === undefined) return;
      const tools: AsideTool[] = [];
      if (manifest.files?.available === true) tools.push('files', 'search');
      if (kind === 'GIT_WORKSPACE') {
        tools.push('changes');
        if (manifest.git?.supportsHistory === true) tools.push('history');
      }
      if (manifest.terminal?.available === true && manifest.terminal.supportsReplay === true)
        tools.push('terminal');
      workbenchAsideService.ensure(target, tools);
    },
    { immediate: true }
  );
  function selectAsideTool(target: AsideWorkspace & { readonly id: AsideTool }): void {
    const current = workspaceTarget.value;
    if (current?.nodeId !== target.nodeId || current.workspaceId !== target.workspaceId) return;
    if (workbenchAsideService.current(current).active?.kind === 'session') saveAsideContext();
    workbenchAsideService.selectTool(target, target.id);
    if (mobileViewport.value)
      openMobileWorkspaceSurface(target.id === 'terminal' ? 'terminal' : 'inspector');
  }

  function selectAsideBrowser(target: AsideWorkspace): void {
    const current = workspaceTarget.value;
    if (current?.nodeId !== target.nodeId || current.workspaceId !== target.workspaceId) return;
    if (workbenchAsideService.current(target).active?.kind === 'session') saveAsideContext();
    if (workbenchAsideService.activateHtml(target) && mobileViewport.value)
      openMobileWorkspaceSurface('inspector');
  }
  function closeAsideBrowser(target: AsideWorkspace): void {
    const current = workspaceTarget.value;
    if (current?.nodeId !== target.nodeId || current.workspaceId !== target.workspaceId) return;
    workbenchAsideService.clearHtmlWorkspace(target);
  }

  function toggleAsideTerminal(): void {
    const target = workspaceTarget.value;
    if (target === undefined) return;
    if (
      mobileViewport.value &&
      mobileWorkspaceSurface.value !== 'inspector' &&
      mobileWorkspaceSurface.value !== 'terminal'
    ) {
      if (workbenchAsideService.current(target).active?.kind === 'session') saveAsideContext();
      if (workbenchAsideService.selectTool(target, 'terminal'))
        openMobileWorkspaceSurface('terminal');
      return;
    }
    if (workbenchAsideService.current(target).active?.kind === 'session') saveAsideContext();
    if (!workbenchAsideService.toggleTerminal(target)) return;
    if (mobileViewport.value) {
      const active = workbenchAsideService.current(target).active;
      openMobileWorkspaceSurface(
        active?.kind === 'tool' && active.id === 'terminal' ? 'terminal' : 'inspector'
      );
    }
  }

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

  function changeWorkspaceWatchDirectory(directory: string): void {
    const workspaceId = activeWorkspaceId.value;
    if (workspaceId === undefined) return;
    void watchCoordinator.current?.startWorkspace(workspaceId, directory);
  }

  function canWatchSessionHistory(session: Session): boolean {
    return sessionWatchController.canWatchSessionHistory(session);
  }

  function stopSelectedSessionWatch(): void {
    watchCoordinator.current?.stopSession();
  }

  function handleSessionWatchVisibility(): void {
    if (document.visibilityState === 'visible') {
      directTransport.connectionLost();
      workbenchLiveConnection.reconnect();
      return;
    }
    watchCoordinator.current?.handleVisibility();
  }

  function transferSessionSubmission(
    nodeId: string,
    workspaceId: string,
    previousId: string,
    nextId: string
  ): void {
    if (previousId === nextId) return;
    const target = { kind: 'session' as const, nodeId, workspaceId };
    submissionOwner.transfer(
      submissionOwner.forTarget({ ...target, sessionId: previousId }),
      submissionOwner.forTarget({ ...target, sessionId: nextId }),
      previousId,
      nextId
    );
  }

  function replaceSessionForTarget(
    nodeId: string,
    workspaceId: string,
    previousId: string,
    next: Session
  ): void {
    replaceSessionIdentity(
      {
        sessions,
        selectedSessionId,
        currentSelectionRevision: currentDetailRequest,
        preserveManagedActive: preserveManagedActiveSession,
        mergeSessions,
        transferSubmission: (oldId, nextId) =>
          transferSessionSubmission(nodeId, workspaceId, oldId, nextId)
      },
      previousId,
      next
    );
  }

  function replaceSession(previousId: string, next: Session): void {
    const nodeId = workspaceTarget.value?.nodeId;
    if (nodeId !== undefined) replaceSessionForTarget(nodeId, next.workspaceId, previousId, next);
  }

  const sessionMessageService = mainPaneController.messaging;

  function sendSessionMessage(intentOverride?: 'REPLACE_CURRENT'): void {
    void sendSessionMessageWithIntent(intentOverride);
  }

  async function sendSessionMessageWithIntent(
    intentOverride?: 'REPLACE_CURRENT',
    preserveDraft = false,
    contentOverride?: string
  ): Promise<void> {
    await sessionMessageService.send(intentOverride, preserveDraft, contentOverride);
  }

  const selectRunnerCommand = mainPaneController.selectCommand;
  const selectComposerSkill = mainPaneController.selectSkill;
  const selectComposerQuickPrompt = mainPaneController.selectQuickPrompt;

  const compactCurrentContext = mainPaneController.context.compactCurrentContext;
  const closeCommandState = mainPaneController.closeCommandState;
  const editGoal = mainPaneController.editGoal;
  const clearGoal = mainPaneController.clearGoal;

  function onComposerKeydown(event: KeyboardEvent): void {
    composerInteractions.onComposerKeydown(event);
  }

  function selectReference(
    entry: Parameters<typeof composerReferenceService.selectCandidate>[0]
  ): void {
    composerInteractions.selectReference(entry);
  }

  function onComposerScroll(): void {
    composerInteractions.onComposerScroll();
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

  function handleWorkbenchResync(nodeId: string): void {
    invalidateNodeManifest(nodeId);
    if (
      view.value === 'conversations' &&
      hostedConversationWorkspace.selectedNodeId.value === nodeId
    ) {
      void watchCoordinator.current?.restartHostedConversation().catch(() => undefined);
      return;
    }
    if (view.value !== 'nodes') return;
    discardNodeViewCaches(nodeId);
    if (workspaceNodeId.value === nodeId) void refreshNodeManifest(nodeId);
    if (workspaceNodeId.value === nodeId) {
      workspaceQueue.value = { version: 0, paused: false, items: [] };
    }
    if (workspaceNodeId.value === nodeId && selectedSessionId.value !== undefined) {
      clearConversationProjectionSession(
        selectedSessionId.value,
        runs.value.map((run) => run.id)
      );
    }
    if (workspaceNodeId.value === nodeId && activeWorkspaceId.value !== undefined)
      void watchCoordinator.current?.restartWorkspace(activeWorkspaceId.value);
    if (workspaceNodeId.value === nodeId && selectedSessionId.value !== undefined)
      refreshSelectedSessionSnapshot();
  }

  const { loadOlderConversationTurns, olderHistoryError } = conversationPagingService;

  const { decideApproval } = mainPaneController.approvals;
  const { stopActiveRun } = mainPaneController.runControl;
  const composerSubmitting = mainPaneController.submitting;
  const composerWorking = authoritativeComposerWorking;
  const composerWorkingLabel = authoritativeComposerWorkingLabel;
  const canInterruptTurn = mainPaneController.canInterrupt;

  const workPromptCompletion = mainPaneController.completion;
  const composerInteractions = mainPaneController.interactions;

  const { onComposerCursor, onComposerInput } = composerInteractions;

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
    clearRunnerCommand,
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
    disposeWebVersionUpdateCheck: () => removeWebVersionSubscription?.(),
    stopWorkspaceWatch: () => watchCoordinator.current?.stopWorkspace(),
    closeWorkbenchLive,
    disposeDirectTransport: directTransport.dispose,
    clearNewSessionAttachments: clearAllNewSessionAttachments,
    releaseRunImagePreviews: () => retainRunImagePreviews([])
  });

  return {
    mainPane,
    mainPaneController,
    workPromptCompletion,
    webVersion: options.webVersion,
    activeGoal,
    activateWorkspaceTab: openWorkspaceTab,
    activeCommandStates,
    activeComposerRun,
    activeFileReferenceIndex,
    activeReferenceMatch,
    referenceCandidates,
    referenceSessionLoading,
    referenceFileError,
    referenceSessionError,
    referenceFileMore,
    referenceSessionMore,
    referenceSessionAvailable: composerReferenceService.sessionAvailable,
    activePlanContinuation,
    activeRunnerCommandIndex,
    activeWorkspaceTabId,
    addNewSessionFiles,
    addWorkspaceForNode,
    admin,
    adminLoaded,
    authenticationUnknown,
    authenticationRestoring,
    pwaState,
    checkingForUpdates,
    checkForUpdates,
    applyWebUpdate,
    adminSessions,
    attachmentPreview,
    attachmentPreviewOpen,
    canCompactContext,
    canInterruptTurn,
    canLoadMoreWorkspaceSessions,
    loadMoreWorkspaceSessionsError,
    canUseComposer,
    cancelWorkspaceUpload,
    changeWorkspaceWatchDirectory,
    retryWorkspaceWatch: () => workspaceWatchService.retryFailed(),
    changePassword,
    closeCommandState,
    clearHostedConversation,
    closeHostedConversationMobileHistory,
    closeMobileSidebar,
    closeMobileWorkspaceSurface,
    closeQuickOpenFile,
    closeWorkspaceTab,
    codexFastEnabled,
    commandPickerOpen,
    quickPrompts: quickPromptTargets.prompts,
    quickPromptsLoading: quickPromptTargets.loading,
    quickPromptsFailed: quickPromptTargets.failed,
    refreshQuickPrompts: quickPromptService.refresh,
    composerPickerKind,
    compactCurrentContext,
    clearGoal,
    composerAccessDisabled,
    composerAccessLabel,
    composerAccessOptions,
    composerAttachmentsPending,
    composerCommandReady,
    composerConfigurationDisabled,
    composerEfforts,
    composerInputDisabled,
    composerModelEffortLabel,
    composerModelEffortSelection,
    composerModels,
    composerQueueService,
    composerRunner,
    composerRunnerLabel,
    composerRunnerOptions,
    composerSessionOpen,
    composerSubmitting,
    composerDraftOpen,
    composerSkillsSupported,
    composerSkillsLoading: composerSkillTargets.loading,
    composerSkillsFailed: composerSkillTargets.failed,
    composerSkillTokens,
    removeComposerSkillToken: composerSkillTokenService.remove,
    composerFileReferences,
    removeComposerFileReference: composerReferenceService.remove,
    composerWorking,
    composerWorkingLabel,
    composerWorkingBusy,
    composerElapsedLabel,
    liveConnected: workbenchLiveConnection.connected,
    conversationSyncPending: mainPaneController.conversationSyncPending,
    olderHistoryError,
    conversationRuns: mainPaneController.conversationRuns,
    contextUsageLabel,
    conversationImagePreview,
    conversationImagePreviewOpen,
    handleConversationImagePreviewError: (url: string) =>
      imagePreviewOwner.value.previewFailed(url),
    conversationInitialRenderVersion,
    conversationNextCursor,
    conversationScroll,
    conversationTurns,
    confirmConversationInitialRender,
    copyConversationMessage,
    createRegistrationToken,
    csrfToken,
    workspaceToolsHttp,
    fileWorkbench,
    setWorkspaceFilePage: (
      page: WorkspaceFilePagePort | undefined,
      previous?: WorkspaceFilePagePort
    ) => {
      if (page !== undefined) {
        workspaceFilePage.value = page;
        fileWorkbench.pageReady();
      } else if (workspaceFilePage.value === previous) workspaceFilePage.value = undefined;
    },
    resolveWorkspaceGitRepositoryPath,
    workspaceComparison,
    adjacentWorkspaceDiff,
    loadWorkspaceDiff,
    openWorkspaceFileExternal,
    downloadWorkspaceFile,
    workspaceGit,
    openWorkspaceGitChange,
    openWorkspaceHistoryDiff,
    workspaceFiles,
    setWorkspaceFilesPanel: (panel: WorkspaceFilesPanelHandle | null) => {
      workspaceFilesPanel.value = panel ?? undefined;
    },
    revealWorkspaceFileTree,
    refreshAfterFileWrite: () => {
      void workspaceFiles.requestRefresh();
      if (selectedWorkspace.value?.kind === 'GIT_WORKSPACE') void workspaceGit.loadChanges();
    },
    reportWorkspaceFileFailure,
    workspaceSearch,
    setWorkspaceSearchPanel,
    currentSessionQueue,
    decideApproval,
    deleteNode,
    deleteQueuedMessage,
    deleteSession,
    deleteWorkspaceUpload,
    displayedConversationTurns,
    draftSessionOpen,
    draggingComposerAttachments,
    draggingQueueItemId,
    draggingWorkspace,
    editingQueueContent,
    editingQueueItemId,
    editGoal,
    effortLabel,
    executeQueuedMessage,
    expandedNodeIds,
    workspaceTreeRevealTarget: workspaceTreeService.revealTarget,
    fileReferenceEntries,
    fileReferenceLoading,
    referencePickerOpen,
    filesReady,
    contentSearchReady,
    codeNavigationReady,
    codeNavigationPrewarmReady,
    fileWriteReady,
    followConversation,
    formatContextPercentage,
    formatSessionTime,
    formatUsageTimestamp,
    hostedConversationMobileHistoryOpen,
    hostedConversationMobileFilesOpen,
    hostedConversationRoute,
    hostedConversationWorkspace,
    implementPlan,
    interruptVisible,
    loadMoreWorkspaceSessions: loadMoreVisibleWorkspaceSessions,
    loadOlderConversationTurns,
    reloadSelectedSession,
    restoringHostedConversationRoute,
    loadWorkspaceDirectories,
    loading,
    loadingMoreWorkspaceSessions: loadingMoreVisibleWorkspaceSessions,
    loadingOlderConversation,
    loadingInitialConversation: workbenchSessionSelectionService.loadingInitialContent,
    synchronizingInitialConversation: loadingInitialConversation,
    initialConversationLoadFailed,
    loadingWorkspaceDirectory,
    pendingWorkspaceDirectoryName,
    locked,
    login,
    logout,
    logoutAdminSession,
    managementItems,
    managementSection,
    message,
    mobileSidebarOpen,
    mobileUtilityPanel,
    mobileViewport,
    mobileWorkspaceSurface,
    movePinnedSession,
    movePinnedSessionTo,
    navigationItems,
    newPassword,
    newSessionAccess,
    newSessionAttachments,
    newSessionEffort,
    newSessionModel,
    newSessionRunner,
    nodeDetails,
    nodeDetailsDialogOpen,
    nodeLabel,
    nodeManifest,
    nodeManifestLoading,
    nodeReady,
    nodes,
    nodeUpgradeProgress,
    notice,
    onComposerAttachmentDragEnter,
    onComposerAttachmentDragLeave,
    onComposerAttachmentDrop,
    onComposerCursor,
    onComposerInput,
    onComposerKeydown,
    onComposerScroll,
    stopFollowingConversation: conversationScrollService.stopFollowing,
    captureConversationRenderAnchor: conversationScrollService.captureRenderAnchor,
    onNewSessionPaste,
    onlineNodeCount,
    openAgentWorkspaceFile,
    openHtmlExternal,
    openHtmlAside,
    openAgentFileChange,
    openQuickWorkspaceFile,
    openQuickWorkspace,
    openAttachmentPreview,
    openConversationImagePreview,
    markRunImageUnavailable,
    openMobileWorkspaceSurface,
    toggleAsideTerminal,
    openNewSessionComposer,
    openNodeRegistration,
    openSession,
    openSessionFromList,
    openWorkbenchNotification: workbenchNotificationService.openNotification,
    openRecentRun,
    openSessionGroupTarget,
    openWorkspaceFromTree,
    openWorkspaceTools,
    orderedWorkspaces,
    passwordValidationError,
    queueWorkspaceUploads,
    quickOpenFileVisible,
    recoverWorkspaceUpload,
    ref,
    refreshAdmin,
    refreshAdminSessions,
    refreshNodes,
    refreshWorkspaceSessions,
    refreshingWorkspaceSessions,
    searchingWorkspaceSessions,
    searchWorkspaceSessions,
    workspaceSessionSearchEnabled,
    workspaceSessionSearchQuery,
    registerWorkspace,
    workspacePreserveGitConfig,
    workspaceGitPolicySupported,
    registrationToken,
    removeNewSessionAttachment,
    removeWorkspace,
    cleanupWorkspaceSessions,
    cleanupSessionsEnabled,
    renameNode,
    renameSession,
    moveSessionToMain,
    workspaceSessionGroup,
    selectWorkspaceSessionGroup,
    rollbackConversation,
    rollbackConversationEnabled,
    rewindConversationEnabled,
    canDeleteSession,
    rewindConversation,
    renewCsrfToken,
    reorderWorkspace,
    moveWorkspaceToGroup,
    moveWorkspaceGroup,
    renameWorkspace,
    reorderWorkspaceQueue,
    request,
    retryWorkspaceUpload,
    runnerBrandIcon,
    runnerProfilesFailed,
    runnerProfilesLoading,
    runnerUsageDetails,
    runnerUsageDialogOpen,
    runnerUsageDisabledReason,
    runnerUsageLoading,
    runnerUsageTitle,
    saveQueuedMessage,
    scrollConversationToLatest,
    selectComposerAccess,
    selectHostedConversation,
    selectComposerModelEffort,
    selectComposerRunner,
    selectReference,
    selectManagementSection,
    selectNavigation,
    selectMobileUtilityPanel,
    selectRunnerCommand,
    selectComposerSkill,
    selectComposerQuickPrompt,
    selectSettingsSection,
    selectWorkspaceDirectory,
    selectPendingWorkspaceDirectory,
    discardPendingWorkspaceDirectory,
    workspaceHost,
    selectedNodeStatus,
    selectedRunnerCommand,
    selectedSession,
    selectedSessionId,
    selectedWorkspace,
    selectedWorkspaceDirectorySelectable,
    sendSessionMessage,
    serverVersion: serverVersionLabel,
    sessionActivity,
    sessionActivityDateTime,
    sessionActivityLabel,
    sessionActivityTitle,
    sessionContextUsage,
    sessionPerformance: sessionPerformance.current,
    sessionInput,
    sessionRelativeActivity,
    sessionTitle,
    sessions,
    setSessionPinned,
    setUserInputAnswer,
    settingsItems,
    settingsSection,
    showNodeDetails,
    showRunnerUsage,
    sidebarCollapsed,
    sidebarContentVisible,
    panelWidths: workbenchLayoutService.panelWidths,
    setPanelWidth: workbenchLayoutService.setPanelWidth,
    startWorkspaceDrag,
    stopActiveRun,
    standaloneFileError,
    standaloneFileLoading,
    standaloneFileMode,
    submitUserInput,
    terminalDocks,
    terminalDirectClient,
    terminalReady,
    toggleNodeExpansion,
    updateWorkspaceBranch,
    updateWorkspaceMetadata,
    userInputAnswer,
    userInputQuestions,
    userInputSubmitted,
    userMessageImageAttachments,
    view,
    visibleRunnerCommands,
    visibleComposerSkills,
    visibleQuickPrompts,
    visibleWorkspaceSessions,
    workbenchNotificationService,
    webPerformanceDiagnostics,
    workspaceBranchLabel,
    workspaceChangesRevision,
    workspaceDirectory,
    workspaceRegistrationNodeId,
    workspaceRegistrationNode,
    workspaceRegistrationReady,
    closeWorkspaceRegistration,
    directWorkspaceFileDownload,
    directWorkspaceFileReadRange,
    directWorkspaceFileObjectUrl,
    directGitFileDownload,
    directGitFileObjectUrl,
    directGitFileReadRange,
    workspaceDirectAvailable,
    workspaceDirectDescription,
    workspaceLocalFileManagerAvailable,
    workspaceFilesRevision,
    workspaceFileWorkbench,
    workspaceKindLabel,
    workspacePath,
    workspaceTabLabel,
    workspaceTabNodeLabel,
    workspaceTabService,
    workspaceTabs,
    workspaceTarget,
    asideState: computed(() => {
      const target = workspaceTarget.value;
      return target === undefined ? undefined : workbenchAsideService.current(target);
    }),
    asidePaneController,
    asideSupported: computed(() =>
      supportsSessionAside(
        nodes.value.find((node) => node.id === workspaceNodeId.value)?.nodeAppVersion,
        nodeManifest.value?.sessionAside
      )
    ),
    asideViewMode,
    asideWidth: workbenchLayoutService.asideWidth,
    setAsideSurfaceVisible: (visible: boolean) => {
      asideSurfaceVisible.value = visible;
    },
    selectAsideTool,
    selectAsideBrowser,
    closeAsideBrowser,
    reloadAsideSession,
    openAsideSession: workbenchSessionSelectionService.openAsideSession,
    closeAsideSession: workbenchSessionSelectionService.closeAsideSession,
    setSessionTreeAnchor: (sessionId: string | undefined) => {
      sessionTreeAnchor.value = sessionId;
    },
    sessionNavigationSnapshot: computed(() => {
      return sessionNavigation.current(workspaceTarget.value, navigationQuery.value);
    }),
    asideSessionMetadata: computed(() => {
      const workspace = workspaceTarget.value;
      return navigationQuery.value === undefined || workspace === undefined
        ? []
        : sessionNavigation.knownSessions(
            workspace,
            workbenchAsideService.current(workspace).sessions
          );
    }),
    workspaceSelectionLoading: workbenchWorkspaceSelectionService.loading,
    retryWorkspaceSelection: () => {
      if (workspaceTarget.value !== undefined) void selectWorkspace(workspaceTarget.value);
    },
    workspaceTreeService,
    orderedNodes,
    moveNode,
    refreshNodeWorkspaces,
    refreshWorkspaceTree,
    workspaceUploadRecoveryInput,
    workspaceUploadStatusLabel,
    workspaceUploadTasks,
    workspaceWatchTopicStatus: workspaceWatchService.topicStatus,
    workspaceWatchSnapshot,
    workspaces
  };
}
