import type { WorkspaceDirectFileIdentity } from '../model/workspace-direct-file.js';
import { clearMessages, showMessage } from './message-feedback-service.js';
import { marIcon } from '../util/mar-icons.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import { isComposerAttachmentResourcePath } from '@myagentroam/protocol';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessageBox } from './message-box-service.js';
import { createHostedConversationSelectionService } from '@myagentroam/web-core/hosted-selection';
import { createAdminAuthService } from './admin-auth-service.js';
import { createRunnerUsageService } from './runner-usage-service.js';
import { createRunnerProfileService } from './runner-profile-service.js';
import { createWorkspaceRegistrationService } from './workspace-registration-service.js';
import { createWorkspaceSessionService } from './workspace-session-service.js';
import { createConversationImageService } from './conversation-image-service.js';
import { filePreviewErrorMessage } from '../util/error-presentation.js';
import { createWorkspaceQueueService } from './workspace-queue-service.js';
import { createWorkbenchRunnerCommandService } from './workbench-runner-command-service.js';
import {
  absoluteSessionTime as formatSessionTime,
  agentSessionPathId,
  contextPercentageLabel as formatContextPercentage,
  errorMessage as message,
  currentChangesBranch,
  effortPresentation as effortLabel,
  nodePresentation as nodeLabel,
  runnerLabel,
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
import { createWorkbenchEventProjectionService } from './workbench-event-projection-service.js';
import { parseNodeUpgradeProgress, type NodeUpgradeProgress } from '../model/node-upgrade.js';
import { createWorkbenchPerformanceService } from './workbench-performance-service.js';
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
import { createWorkbenchCapabilityService } from './workbench-capability-service.js';
import type { ManagementComposition } from './management-composition.js';
import type { WorkbenchNavigationService } from './workbench-navigation-service.js';
import type { WorkspaceRegistrationInput } from './workspace-registration-service.js';
import type { SettingsSection } from '../model/settings.js';
import type { WorkbenchView } from '../util/workbench-route.js';
import type { WorkbenchNotification } from './workbench-notification-service.js';
import { navigateWorkbenchNotification } from './workbench-notification-navigation-service.js';
import { createComposerQueueService } from './composer-queue-service.js';
import { createConversationScrollService } from './conversation-scroll-service.js';
import { createComposerConfigurationService } from './composer-configuration-service.js';
import { createSessionSnapshotRefreshService } from './session-snapshot-refresh-service.js';
import { createComposerAttachmentService } from './composer-attachment-service.js';
import { createWorkspaceViewCacheService } from './workspace-view-cache-service.js';
import { createWorkspaceWatchService } from './workspace-watch-service.js';
import { createWorkbenchViewWatchService as createWorkbenchNavigationWatchService } from './workbench-view-watch-service.js';
import { createHostedConversationWatchCoordinator as createWorkbenchWatchCoordinator } from './hosted-conversation-watch-coordinator.js';
import {
  contextUsageAfterCompaction,
  isCompletedContextCompaction,
  type SessionContextUsage
} from './conversation-state-service.js';
import {
  createWorkspaceRuntimeStateService,
  mergeWorkspaceWatchSnapshot
} from './workspace-runtime-state-service.js';
import { createWorkbenchSessionSelectionService } from './workbench-session-selection-service.js';
import { createWorkbenchSessionHistoryMutationService } from './workbench-session-history-mutation-service.js';
import { createWorkbenchSessionMessageService } from './workbench-session-message-service.js';
import { replaceSessionIdentity } from './workbench-session-identity.js';
import {
  createWorkbenchSubmissionService,
  sessionSubmissionContext
} from './workbench-submission-service.js';
import { createWorkbenchWorkspaceSelectionService } from './workbench-workspace-selection-service.js';
import { createWorkbenchComposerController } from './workbench-composer-controller.js';
import { createWorkbenchWorkspaceCacheController } from './workbench-workspace-cache-controller.js';
import { createWorkbenchWorkspaceTreeController } from './workbench-workspace-tree-controller.js';
import { createWorkbenchRunControlService } from './workbench-run-control-service.js';
import { createWorkbenchContextCommandService } from './workbench-context-command-service.js';
import { createWorkbenchPlanService } from './workbench-plan-service.js';
import { createWorkbenchPresentationStateService } from './workbench-presentation-state-service.js';
import { createWorkbenchRunnerChannelService } from './workbench-runner-channel-service.js';
import { createWorkbenchApprovalService } from './workbench-approval-service.js';
import { createWorkbenchSessionWatchController } from './workbench-session-watch-controller.js';
import { createWorkbenchConversationRealtimeService } from './workbench-conversation-realtime-service.js';
import { createWorkbenchConversationComposition } from './workbench-conversation-composition.js';
import { createWorkbenchEntityController } from './workbench-entity-controller.js';
import { createWorkbenchPageStateService } from './workbench-base-state-service.js';
import { createWorkbenchPageInteractionService } from './workbench-page-interaction-service.js';
import type { PwaApplicationService } from './pwa-application-service.js';
import { createWorkbenchNewSessionController } from './workbench-new-session-controller.js';
import { createWorkbenchComposerInteractionController } from './workbench-composer-interaction-controller.js';
import { installWorkbenchPageLifecycle } from './workbench-page-lifecycle-service.js';
import {
  reconcileWorkspaceQueueSnapshot,
  type WorkspaceQueueSnapshotSource
} from './workspace-queue-projection-service.js';
import { createRunnerInteractionService } from './runner-interaction-service.js';
import { createComposerSkillService } from './composer-skill-service.js';
import { createComposerSkillTokenService } from './composer-skill-token-service.js';
import { createQuickPromptService } from './quick-prompt-service.js';
import type { EffectiveWorkspaceSkill } from './effective-workspace-skill-service.js';
import { createComposerReferenceService } from './composer-reference-service.js';
import { createConversationUserInputService } from './conversation-user-input-service.js';
import { createHostedConversationWorkspaceService } from './hosted-conversation-workspace-service.js';
import {
  promptCompletionAutomaticKey,
  promptCompletionAutomaticTerminalKey
} from './prompt-completion-service.js';
import { promptCompletionPreferenceService } from './prompt-completion-preference-service.js';
import { PromptCompletionClientService } from './prompt-completion-client-service.js';
import { ApiError, errorCode } from '../util/api-error.js';
import {
  CONVERSATION_RECENT_SEGMENT_LIMIT,
  CONVERSATION_SEGMENT_PAGE_SIZE
} from '../util/conversation-history.js';
import { userInputQuestions } from '../util/conversation-presentation.js';
import { createWorkspaceTabService } from './workspace-tab-service.js';
import {
  STANDALONE_FILE_OPEN_EVENT,
  standaloneFileOpenIntent,
  type StandaloneFileOpenIntent
} from './standalone-file-window-service.js';
import { createWorkspaceTreeService } from './workspace-tree-service.js';
import type {
  AgentRun,
  ConversationItem,
  ConversationTurn,
  RunnerCommandState,
  RunnerCommand,
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
import {
  activePlanContinuation as findPlanContinuation,
  displayConversationItem,
  localizedRunnerCommandState
} from '../util/conversation-domain.js';

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
  let focusComposerInputAt: (cursor: number) => void = () => undefined;
  let editComposerRange: (start: number, end: number, text: string) => boolean = () => false;

  function refreshRecentConversationWindow(): Promise<void> {
    return conversationPagingService.refreshRecentConversationTurns();
  }
  const baseState = createWorkbenchPageStateService({
    navigation: options.navigation,
    sessionPageSize: WORKSPACE_SESSION_PAGE_SIZE,
    onUnauthenticated: () => returnToLogin(),
    onConversationOverflow: () => void refreshRecentConversationWindow(),
    onWorkspaceRunCompleted: refreshCurrentWorkspaceInspector,
    onNotificationClick: openWorkbenchNotification
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

  const notice = showMessage;
  onBeforeUnmount(clearMessages);
  const submissionService = createWorkbenchSubmissionService();
  const { pending: submissionPending } = submissionService;

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

  const sessionDraftService = baseState.draft;

  const {
    input: sessionInput,
    skillTokens: composerSkillTokens,
    references: composerFileReferences,
    restore: restoreSessionDraft,
    persist: persistSessionDraft
  } = sessionDraftService;
  const composerSkillTokenService = createComposerSkillTokenService(composerSkillTokens);
  watch(composerSkillTokens, persistSessionDraft, { deep: true });
  watch(composerFileReferences, persistSessionDraft, { deep: true });

  // Node has not returned the real Run ID when the first message is sent. Retain the prior activity
  // so the new session appears managed immediately and can recover losslessly if Node rejects it.
  const runService = baseState.run;

  const { runs, selectedRunId } = runService;

  const conversationState = baseState.conversation;

  const {
    turns: conversationTurns,
    nextCursor: conversationNextCursor,
    loadingInitial: loadingInitialConversation,
    initialLoadFailed: initialConversationLoadFailed,
    loadingOlder: loadingOlderConversation,
    channelInput,
    channelToken,
    contextUsage: sessionContextUsage,
    initialRenderVersion: conversationInitialRenderVersion,
    beginInitialRender: beginConversationInitialRender,
    confirmInitialRender: confirmConversationInitialRender,
    nextDetailRequest,
    currentDetailRequest
  } = conversationState;

  const conversationUserInputService = createConversationUserInputService({
    workspaceTarget,
    notice,
    request,
    errorMessage: message,
    missingRunError: (error) => errorCode(error) === 'RUN_NOT_FOUND',
    beginSubmission: submissionService.begin
  });

  const surfaceState = baseState.surface;

  const {
    quickOpenFileVisible,
    workspaceInspector,
    terminalDocks,
    draftSessionOpen,
    registrationToken,
    nodeManifestLoading
  } = surfaceState;

  const composerAttachmentService = createComposerAttachmentService({
    context: () =>
      workspaceNodeId.value === undefined || activeWorkspaceId.value === undefined
        ? undefined
        : { nodeId: workspaceNodeId.value, workspaceId: activeWorkspaceId.value },
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

  const {
    attachments: newSessionAttachments,
    dragging: draggingComposerAttachments,
    preview: attachmentPreview,
    previewOpen: attachmentPreviewOpen,
    add: addNewSessionFiles,
    remove: removeNewSessionAttachment,
    clearAll: clearAllNewSessionAttachments,
    openPreview: openAttachmentPreview
  } = composerAttachmentService;

  const conversationImageService = createConversationImageService(workspaceNodeId, {
    fileAttachments: {
      target: computed(() => {
        const target = workspaceTarget.value;
        return target === undefined
          ? undefined
          : JSON.stringify([target.nodeId, target.workspaceId, selectedSessionId.value]);
      }),
      revalidate: (file) => {
        const target = workspaceTarget.value!;
        const parameters = new URLSearchParams({
          nodeId: target.nodeId,
          path: file.path,
          offset: '0',
          limit: '1'
        });
        return request(
          `/api/workspaces/${encodeURIComponent(target.workspaceId)}/files/read?${parameters}`,
          { cache: 'no-store' }
        );
      },
      sourceUrl: (file, revision) => {
        const target = workspaceTarget.value!;
        const parameters = new URLSearchParams({
          nodeId: target.nodeId,
          path: file.path,
          preview: String(revision)
        });
        return `/api/workspaces/${encodeURIComponent(target.workspaceId)}/files/content?${parameters}`;
      },
      onError: (error, path) => showMessage(filePreviewErrorMessage(error, path), 'error', error)
    }
  });
  onBeforeUnmount(conversationImageService.dispose);

  const {
    preview: conversationImagePreview,
    previewOpen: conversationImagePreviewOpen,
    attachments: userMessageImageAttachments,
    retain: retainRunImagePreviews,
    markUnavailable: markRunImageUnavailable,
    open: openConversationImagePreview
  } = conversationImageService;

  watch(conversationTurns, (turns) => retainRunImagePreviews(turns), { immediate: true });

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
    const activeClientMessageIds = new Set(
      runs.value
        .filter((run) => ['STARTING', 'RUNNING', 'CANCELLING'].includes(run.status))
        .map((run) => run.clientMessageId)
    );
    const next = reconcileWorkspaceQueueSnapshot(workspaceQueue.value, queue, source);
    workspaceQueue.value = {
      ...next,
      items: next.items.filter((item) => !activeClientMessageIds.has(item.clientMessageId))
    };
  };

  const conversationProjectionService = conversationState.projection;

  const {
    restoreWindow: restoreConversationWindow,
    clearSession: clearConversationProjectionSession,
    markLive: markLiveConversationTurn,
    mergeItem: mergeLiveConversationItem,
    mergeTextDelta: mergeLiveConversationTextDelta,
    mergeLatest: mergeLatestConversationTurns
  } = conversationProjectionService;

  const composerQueueService = createComposerQueueService();

  const {
    draggingQueueItemId,
    editingQueueItemId,
    editingContent: editingQueueContent
  } = composerQueueService;

  const conversationScrollService = createConversationScrollService();

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

  const selectedSession = computed(() =>
    sessions.value.find((session) => session.id === selectedSessionId.value)
  );
  const composerConfigurationService = createComposerConfigurationService({
    selectedSession,
    profiles: runnerProfiles,
    effortLabel
  });

  const composerRunnerOptions = computed(() =>
    runnerProfiles.value
      .filter((profile) => profile.capabilities.includes('turn.start'))
      .map((profile) => ({
        value: profile.runner,
        label: runnerLabel(profile.runner)
      }))
  );

  const {
    runner: newSessionRunner,
    modelId: newSessionModel,
    effort: newSessionEffort,
    access: newSessionAccess,
    modelEffortSelection: composerModelEffortSelection,
    activeRunner: composerRunner,
    profile: composerProfile,
    models: composerModels,
    efforts: composerEfforts,
    accessOptions: composerAccessOptions,
    modelEffortLabel: composerModelEffortLabel,
    runnerLabel: composerRunnerLabel,
    accessLabel: composerAccessLabel,
    normalize: normalizeComposerConfiguration,
    apply: applyComposerDefaultConfiguration
  } = composerConfigurationService;

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

  const runnerInteractionService = createRunnerInteractionService({
    input: sessionInput,
    draftSessionOpen,
    selectedSession,
    profile: composerProfile,
    commandAvailable: (command) => canExecuteRunnerCommand(command),
    skills: composerSkillTargets.skills,
    quickPrompts: quickPromptTargets.prompts
  });

  const {
    selectedCommand: selectedRunnerCommand,
    deferredDraftCommands,
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

  const composerReferenceService = createComposerReferenceService(
    sessionInput,
    {
      nodeId: workspaceNodeId,
      workspaceId: activeWorkspaceId,
      ready: () => filesReady.value,
      sessions: { ready: () => nodeReady.value, currentSessionId: selectedSessionId },
      request
    },
    composerFileReferences
  );

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

  const {
    activeComposerRun,
    workspaceHost,
    nodeReady,
    mustSteerCurrentTurn,
    canStartTurn,
    composerDraftOpen,
    canUseComposer,
    composerSessionOpen,
    composerConfigurationDisabled,
    composerAccessDisabled,
    composerInputDisabled,
    composerAttachmentsPending,
    displayedConversationTurns,
    currentSessionQueue,
    composerSessionBusy,
    sessionControlsBusy,
    rewindConversationEnabled,
    rollbackConversationEnabled,
    canExecuteRunnerCommand,
    canDeleteSession,
    compactCommand,
    canCompactContext,
    contextUsageLabel,
    composerWorking: authoritativeComposerWorking,
    sessionActivityClockNow,
    composerWorkingLabel: authoritativeComposerWorkingLabel,
    composerWorkingBusy,
    workingElapsedLabel: composerElapsedLabel,
    interruptVisible,
    canInterruptTurn: authoritativeCanInterruptTurn,
    selectedWorkspace,
    documentTitle,
    visibleWorkspaceSessions: unfilteredWorkspaceSessions,
    canLoadMoreWorkspaceSessions: canLoadMoreUnfilteredWorkspaceSessions,
    onlineNodeCount,
    terminalReady,
    filesReady
  } = createWorkbenchPresentationStateService({
    workspaceTarget,
    selectedSessionId,
    selectedRunId,
    selectedSession,
    sessions,
    runs,
    turns: conversationTurns,
    attachments: newSessionAttachments,
    draftOpen: draftSessionOpen,
    runnerProfilesLoading,
    runnerProfilesFailed,
    composerProfile,
    composerModels,
    composerAccessOptions,
    workspaceQueue,
    sessionContextUsage,
    channelToken,
    loading,
    submissionPending,
    nodes,
    workspaces,
    nodeManifest,
    visibleLimits: workspaceSessionVisibleLimits,
    nextCursors: workspaceSessionNextCursors,
    pageSize: WORKSPACE_SESSION_PAGE_SIZE,
    tabId: workspaceTabId,
    workspaceLabel: workspaceTabLabel,
    shouldDisplayItem: (item, runId) => shouldDisplayConversationItem(item, runId),
    runService,
    formatTokenCount,
    formatPercentage: formatContextPercentage
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

  const workspaceQueueActions = createWorkspaceQueueService({
    queue: workspaceQueue,
    currentSessionQueue,
    workspaceTarget,
    selectedSessionId,
    currentSelectionRevision: () =>
      currentDetailRequest() + workbenchWorkspaceSelectionService.currentSelectionRevision(),
    draggingQueueItemId,
    editingContent: editingQueueContent,
    serializeEditedContent: composerQueueService.serializeEditedContent,
    request,
    finishEditing: composerQueueService.finishEditing,
    notice,
    errorMessage: message,
    missingQueueItemError: (error) => errorCode(error) === 'QUEUE_ITEM_INVALID',
    beginSubmission: submissionService.begin
  });

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
    await navigateWorkbenchTarget(target);
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

  const {
    workspaceViewCache,
    discardWorkspaceViewCache,
    discardNodeViewCaches,
    saveCurrentWorkspaceView,
    restoreWorkspaceInspector,
    restoreWorkspaceDraft,
    restoreCachedSessionDetail,
    updateCachedContext,
    syncCachedRunStatus,
    cacheRunSnapshotFor,
    cacheRunSnapshot,
    cacheConversationTurn,
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
    draftOpen: draftSessionOpen,
    input: sessionInput,
    skillTokens: composerSkillTokens,
    references: composerFileReferences,
    runner: newSessionRunner,
    modelId: newSessionModel,
    effort: newSessionEffort,
    access: newSessionAccess,
    workspaceTarget,
    selectedSessionId,
    inspector: workspaceInspector,
    restoreDraftConfiguration: applyComposerDefaultConfiguration,
    persistDraft: persistSessionDraft,
    flushConversation: conversationProjectionService.flushPendingTextDeltas,
    tabId: workspaceTabId,
    maximumDetails: MAX_CACHED_SESSION_DETAILS
  });

  const { applySnapshot: applyConversationSnapshot, paging: conversationPagingService } =
    createWorkbenchConversationComposition({
      workspaceTarget,
      selectedSessionId,
      turns: conversationTurns,
      nextCursor: conversationNextCursor,
      loadingOlder: loadingOlderConversation,
      capturePrependAnchor: conversationScrollService.capturePrependAnchor,
      pageSize: CONVERSATION_SEGMENT_PAGE_SIZE,
      recentSegmentWindowSize: CONVERSATION_RECENT_SEGMENT_LIMIT,
      projection: conversationProjectionService,
      replaceCached: replaceConversationTurns,
      request,
      sessionPathId: agentSessionPathId,
      notice,
      errorMessage: message
    });

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

  const sessionPerformance = createWorkbenchPerformanceService({
    view,
    nodeId: workspaceNodeId,
    workspaceId: activeWorkspaceId,
    sessionId: selectedSessionId
  });
  onBeforeUnmount(sessionPerformance.dispose);
  function refreshCurrentWorkspaceInspector(nodeId: string, workspaceId: string): void {
    if (
      view.value !== 'nodes' ||
      workspaceNodeId.value !== nodeId ||
      activeWorkspaceId.value !== workspaceId
    )
      return;
    workspaceInspector.value?.refreshVisibleSection(nodeId, workspaceId);
  }

  function mergeConversationItem(
    runId: string,
    payload: unknown,
    sequence?: number,
    createdAt?: number
  ): boolean {
    const merged = mergeLiveConversationItem(runId, payload, sequence, createdAt);
    if (!merged) return false;
    if (isCompletedContextCompaction(payload)) {
      const contextUsage = contextUsageAfterCompaction(payload, sessionContextUsage.value);
      sessionContextUsage.value = contextUsage;
      const sessionId = selectedSessionId.value;
      if (sessionId !== undefined) updateCachedContext(sessionId, contextUsage);
    }
    return true;
  }

  const workbenchEventProjection = createWorkbenchEventProjectionService({
    nodes,
    sessions,
    workspaceTarget,
    selectedSessionId,
    conversationNextCursor,
    cacheQueue: workspaceViewCacheService.cacheQueue,
    mergeQueue: mergeWorkspaceQueue,
    // Realtime frames can precede the Workspace sessions snapshot. Preserve visibility until the
    // next authoritative snapshot places the session in its stable list order.
    mergeSessions: (values) => mergeSessions(values),
    settleSessionRuns: runService.settleSessionRuns,
    observeManagedSessionActive: runService.observeManagedSessionActive,
    updateContext: (sessionId, context) => {
      const value = context as SessionContextUsage | null;
      updateCachedContext(sessionId, value);
      if (sessionId === selectedSessionId.value) sessionContextUsage.value = value;
    },
    syncTurnStatus: syncConversationTurnStatus,
    cacheRun: (run) => cacheRunSnapshot(run),
    acceptRun: runService.acceptRun,
    openRun,
    markLiveTurn: markLiveConversationTurn,
    cacheTurn: (turn) => cacheConversationTurn(turn),
    mergeTurns: mergeLatestConversationTurns,
    applyConversationSnapshot,
    mergeItem: mergeConversationItem,
    mergeTextDelta: mergeLiveConversationTextDelta,
    receivePerformance: sessionPerformance.receive,
    invalidateWorkspace: (nodeId, workspaceId, topic) => {
      if (nodeId !== workspaceNodeId.value || workspaceId !== activeWorkspaceId.value) return;
      if (topic === 'files') workspaceFilesRevision.value += 1;
      else if (topic === 'changes') workspaceChangesRevision.value += 1;
    },
    onNodeConnected: handleNodeConnected
  });

  const { apply: applyWorkbenchEvent, updateNodeConnection } = workbenchEventProjection;

  const workbenchConnectionId = ref<string>();
  const completionPreferences = promptCompletionPreferenceService();
  const completionClient = new PromptCompletionClientService({
    request,
    connectionId: () => workbenchConnectionId.value
  });
  const watchCoordinator: { current?: ReturnType<typeof createWorkbenchWatchCoordinator> } = {};
  const hostedConversationWorkspace = createHostedConversationWorkspaceService({
    request,
    workbenchConnectionId: () => workbenchConnectionId.value,
    selectedNodeId: baseState.hostedSelection.selectedNodeId,
    selectedConversationId: baseState.hostedSelection.selectedConversationId,
    heartbeatMs: SESSION_WATCH_HEARTBEAT_MS,
    requestTimeoutMs: SESSION_WATCH_REQUEST_TIMEOUT_MS,
    confirmationTimeoutMs: SESSION_WATCH_CONFIRMATION_TIMEOUT_MS,
    onWatchExpired: () => {
      notice(translate('hostedConversations.watchExpired'), 'warning');
    }
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
      workbenchEventProjection.applyBroadcast(event);
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
    if (
      !openedSystemNotification &&
      view.value === 'nodes' &&
      workspaceNodeId.value !== undefined &&
      activeWorkspaceId.value !== undefined &&
      selectedSessionId.value !== undefined
    )
      workbenchNotificationService.markSessionRead(
        workspaceNodeId.value,
        activeWorkspaceId.value,
        selectedSessionId.value
      );
  }

  function handleSignedOut(): void {
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
    discardCache: discardWorkspaceViewCache,
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
    onGlobalKeydown,
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
    workspaceInspector,
    openAttachmentImage: conversationImageService.openFileAttachment,
    toggleTerminal: () => {
      if (mobileViewport.value) {
        if (mobileWorkspaceSurface.value === 'terminal') closeMobileWorkspaceSurface();
        else {
          openMobileWorkspaceSurface('terminal');
          void nextTick(() => terminalDocks.get(activeWorkspaceTabId.value ?? '')?.toggle());
        }
        return;
      }
      void terminalDocks.get(activeWorkspaceTabId.value ?? '')?.toggle();
    },
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

  function planContinuation(
    item: ConversationTurn['items'][number]
  ): RunnerCommandState | undefined {
    return findPlanContinuation({
      item,
      turns: displayedConversationTurns.value,
      commandStates: selectedSession.value?.commandStates,
      steering: mustSteerCurrentTurn.value,
      canStartTurn: canStartTurn.value
    });
  }

  const activePlanContinuation = computed<RunnerCommandState | undefined>(() =>
    mustSteerCurrentTurn.value
      ? undefined
      : selectedSession.value?.commandStates
          ?.filter(
            (state) =>
              state.active && state.continuation !== null && state.continuation !== undefined
          )
          .map(localizedRunnerCommandState)[0]
  );

  const activeGoal = computed<RunnerCommandState | undefined>(() =>
    selectedSession.value?.commandStates?.find(
      (state) => state.commandId === 'goal' && state.active && state.goal?.status === 'active'
    )
  );

  const { implementPlan } = createWorkbenchPlanService({
    workspaceTarget,
    selectedSessionId,
    selectedSession,
    input: sessionInput,
    selectedCommand: selectedRunnerCommand,
    commandPickerOpen,
    notice,
    continuationFor: planContinuation,
    execute: executeRunnerCommandById,
    send: sendSessionMessageWithIntent,
    errorMessage: message,
    beginSubmission: submissionService.begin
  });

  const composerController = createWorkbenchComposerController({
    workspaceTarget,
    configurationAvailable: () => !sessionControlsBusy.value,
    selectedSession,
    sessions,
    profiles: runnerProfiles,
    draftOpen: draftSessionOpen,
    loading,
    runner: newSessionRunner,
    modelId: newSessionModel,
    effort: newSessionEffort,
    access: newSessionAccess,
    setModel: composerConfigurationService.selectModel,
    setEffort: composerConfigurationService.selectEffort,
    setAccess: composerConfigurationService.selectAccess,
    clearModelEffortSelection: composerConfigurationService.clearModelEffortSelection,
    codexFastEnabled,
    profileService: runnerProfileService,
    normalize: normalizeComposerConfiguration,
    apply: applyComposerDefaultConfiguration,
    ensureDraftSupported: (profiles) => ensureDraftRunnerSupported(profiles),
    clearRunnerCommand,
    request,
    sessionPathId: agentSessionPathId,
    notice,
    errorMessage: message
  });

  const {
    loadProfiles: loadRunnerProfiles,
    applyDefaults: applyRunnerDefaults,
    normalize: normalizeNewSessionOptions,
    applyConfiguration: applyComposerConfiguration,
    selectRunner: selectComposerRunner
  } = composerController;

  function selectComposerEffort(value: string): void {
    if (composerConfigurationDisabled.value) return;
    composerController.selectEffort(value, composerEfforts.value);
  }

  function selectComposerModel(value: string): void {
    if (composerConfigurationDisabled.value) return;
    composerController.selectModel(value, composerModels.value);
  }

  function selectComposerAccess(value: string): void {
    if (composerAccessDisabled.value) return;
    composerController.selectAccess(value, composerAccessOptions.value);
  }

  function selectComposerModelEffort(value: unknown): void {
    composerController.selectModelEffort(value, selectComposerEffort, selectComposerModel);
  }

  const workspaceWatchService = createWorkspaceWatchService({
    sessionGroup: () => workspaceSessionGroup.value,
    workspaceTarget,
    workspaces,
    heartbeatMs: WORKSPACE_WATCH_HEARTBEAT_MS,
    enabled: () => true,
    workbenchConnectionId: () => workbenchConnectionId.value,
    request,
    onSnapshot: (nodeId, workspaceId, snapshot, topic, revision) => {
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
    restoreInspector: restoreWorkspaceInspector,
    refreshInspector: (nodeId, workspaceId) => {
      void nextTick(() => {
        refreshCurrentWorkspaceInspector(nodeId, workspaceId);
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
      if (cache?.draft === undefined) restoreSessionDraft();
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
      if (workspaceInspector.value == null) return;
      if (pendingStandaloneFileIntent.value !== intent) return;
      pendingStandaloneFileIntent.value = undefined;
      consumedStandaloneFileIntent = true;
      if (intent.tab !== undefined) workspaceInspector.value.openWorkspaceFileTab(intent.tab);
      else if (intent.worktreePath === undefined && intent.repositoryPath === undefined)
        await workspaceInspector.value.openFile(intent.path, intent.line, intent.column);
      else
        await workspaceInspector.value.openWorkspaceFile(
          intent.path,
          intent.line,
          intent.worktreePath,
          false,
          intent.column,
          intent.repositoryPath
        );
      if (
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
      if (pendingStandaloneFileIntent.value === intent)
        pendingStandaloneFileIntent.value = undefined;
      consumedStandaloneFileIntent = true;
      standaloneFileError.value = true;
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
      nodeManifestLoading,
      workspaceInspector
    ],
    () => void openPendingStandaloneFileIntent(),
    { immediate: true, flush: 'post' }
  );

  const workbenchSessionSelectionService = createWorkbenchSessionSelectionService({
    workspaceTarget,
    selectedSessionId,
    selectedRunId,
    sessions,
    runs,
    turns: conversationTurns,
    loadingInitial: loadingInitialConversation,
    initialLoadFailed: initialConversationLoadFailed,
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
    markSessionRead: (nodeId, workspaceId, sessionId) =>
      workbenchNotificationService.markSessionRead(nodeId, workspaceId, sessionId),
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
    request,
    sessionPathId: agentSessionPathId,
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
      await coordinator.restartSession(sessionId);
      return sessionWatchController.hasInitialSessionSnapshot(sessionId);
    },
    applySnapshot: applyConversationSnapshot,
    mergeTurns: mergeLatestConversationTurns,
    notice,
    errorMessage: message
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
    discardNodeCaches: discardNodeViewCaches,
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
    onComposerAttachmentDragEnter,
    onComposerAttachmentDragLeave,
    onComposerAttachmentDrop,
    onNewSessionPaste,
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
    draggingComposerAttachments,
    canUseComposer,
    notice,
    closeMobileWorkspaceSurface,
    stopSelectedSessionWatch,
    nextDetailRequest,
    applyRunnerDefaults,
    resetRunnerInteraction: runnerInteractionService.reset,
    addNewSessionFiles,
    focusInputAt: (cursor) => focusComposerInputAt(cursor)
  });
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

  const sessionHistoryMutation = createWorkbenchSessionHistoryMutationService({
    current: () => {
      const nodeId = workspaceNodeId.value;
      const session = selectedSession.value;
      return nodeId === undefined || session === undefined ? undefined : { nodeId, session };
    },
    canRewind: () => rewindConversationEnabled.value,
    canRollback: () => rollbackConversationEnabled.value,
    confirmRewind: async (before) => {
      try {
        await ElMessageBox.confirm(
          before
            ? translate('generated.workbenchPageController.createANewSessionBranchBeforeThis')
            : translate('generated.workbenchPageController.createANewSessionBranchThatRetains'),
          translate('generated.workbenchPageController.createFallbackBranch'),
          {
            closeIcon: marIcon('close'),
            icon: marIcon('warning'),
            confirmButtonText: translate('generated.workbenchPageController.createBranch'),
            cancelButtonText: translate('generated.workbenchPageController.cancel'),
            type: 'warning'
          }
        );
        return true;
      } catch {
        return false;
      }
    },
    confirmRollback: async () => {
      try {
        await ElMessageBox.confirm(
          translate('generated.workbenchPageController.rollbackConversationWarning'),
          translate('generated.workbenchPageController.rollbackConversation'),
          {
            closeIcon: marIcon('close'),
            icon: marIcon('warning'),
            confirmButtonText: translate(
              'generated.workbenchPageController.confirmRollbackConversation'
            ),
            cancelButtonText: translate('generated.workbenchPageController.cancel'),
            type: 'warning'
          }
        );
        return true;
      } catch {
        return false;
      }
    },
    request,
    sessionPathId: agentSessionPathId,
    // History mutations retain the existing shared admission until navigation/recovery settles.
    beginSubmission: (context) => submissionService.begin(context, undefined, null),
    draft: {
      read: () => sessionInput.value,
      restore: (text) => {
        sessionInput.value = text;
      },
      fill: (text, operation) => {
        sessionInput.value = text;
        if (operation === 'rollback') saveCurrentWorkspaceView();
        focusComposerInputAt(text.length);
      }
    },
    replaceSession,
    openSession: (id, options) => openSession(id, { ...options, throwOnFailure: true }),
    invalidateDetail: (nodeId, session) => {
      workspaceViewCacheService.invalidateDetail(nodeId, session.workspaceId, session.id);
    },
    clearHistory: (sessionId) => {
      clearConversationProjectionSession(
        sessionId,
        runs.value.map((run) => run.id)
      );
      restoreConversationWindow([], null);
      runService.replaceRuns([]);
      watchCoordinator.current?.stopSession();
    }
  });
  watch(
    sessionHistoryMutation.pending,
    (pending) => {
      loading.value = pending;
    },
    { flush: 'sync' }
  );

  async function rewindConversation(turn: ConversationTurn, item: ConversationItem): Promise<void> {
    const result = await sessionHistoryMutation.rewind(turn, item);
    if (result.status === 'APPLIED') {
      showMessage(translate('generated.workbenchPageController.fallbackBranchCreated'), 'success');
    } else if (result.status === 'FAILED') {
      showMessage(
        translate(
          result.phase === 'REQUEST'
            ? 'generated.workbenchPageController.unableToCreateAFallbackBranch'
            : 'generated.workbenchPageController.fallbackBranchCreatedButLoadFailed',
          {
            value0: message(result.error)
          }
        ),
        'error',
        result.error
      );
    }
  }

  async function rollbackConversation(
    turn: ConversationTurn,
    item: ConversationItem
  ): Promise<void> {
    const result = await sessionHistoryMutation.rollback(turn, item);
    if (result.status === 'FAILED') {
      showMessage(
        translate(
          result.phase === 'REQUEST'
            ? 'generated.workbenchPageController.unableToRollbackConversation'
            : 'generated.workbenchPageController.rollbackCompletedButLoadFailed',
          {
            value0: message(result.error)
          }
        ),
        'error',
        result.error
      );
    }
  }

  const sessionWatchController = createWorkbenchSessionWatchController({
    workspaceTarget,
    selectedSessionId,
    sessions,
    followConversation,
    heartbeatMs: SESSION_WATCH_HEARTBEAT_MS,
    enabled: () => true,
    workbenchConnectionId: () => workbenchConnectionId.value,
    requestTimeoutMs: SESSION_WATCH_REQUEST_TIMEOUT_MS,
    confirmationTimeoutMs: SESSION_WATCH_CONFIRMATION_TIMEOUT_MS,
    request,
    sessionPathId: agentSessionPathId,
    mergeSessions,
    applyRunsSnapshot: (values) => {
      const snapshots = values as AgentRun[];
      runService.mergeAuthoritativeSnapshot(snapshots, [...runs.value]);
      const active = snapshots.find(
        (run) =>
          run.sessionId === selectedSessionId.value &&
          ['STARTING', 'RUNNING', 'CANCELLING'].includes(run.status)
      );
      if (active !== undefined) openRun(active.id);
    },
    applySnapshot: applyConversationSnapshot,
    applyEvent: applyWorkbenchEvent,
    scrollAfterLayout: scrollConversationToLatestAfterLayout,
    refreshSnapshot: refreshSelectedSessionSnapshot,
    openSession: (sessionId) => openSession(sessionId)
  });
  watchCoordinator.current = createWorkbenchWatchCoordinator({
    workspace: workspaceWatchService,
    session: sessionWatchController,
    hosted: hostedConversationWorkspace
  });

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

  function replaceSession(previousId: string, next: Session): void {
    replaceSessionIdentity(
      {
        sessions,
        selectedSessionId,
        currentSelectionRevision: currentDetailRequest,
        preserveManagedActive: preserveManagedActiveSession,
        mergeSessions,
        transferSubmission: submissionService.transferSession
      },
      previousId,
      next
    );
  }

  function stageComposerDraftCommand(command: RunnerCommand, input: string): void {
    const result = runnerInteractionService.prepareDraftCommand(command, input);
    if (result.goalAlreadyActive) {
      showMessage(translate('goal.alreadyActive'), 'info');
      return;
    }
    if (result.access !== undefined) composerConfigurationService.selectAccess(result.access);
  }

  const runnerCommandService = createWorkbenchRunnerCommandService({
    workspaceTarget,
    selectedSessionId,
    currentSelectionRevision: currentDetailRequest,
    acceptRun: runService.acceptRun,
    captureCacheTarget: workspaceViewCacheService.captureCommandTarget,
    request,
    sessionPathId: agentSessionPathId,
    acceptSession: (nodeId, workspaceId, previousId, session, applyToSelected) => {
      if (
        workspaceTarget.value?.nodeId === nodeId &&
        workspaceTarget.value.workspaceId === workspaceId &&
        (selectedSessionId.value !== previousId || applyToSelected)
      )
        replaceSession(previousId, session);
    },
    configure: applyComposerConfiguration,
    resetHistory: async (nodeId, session) => {
      workspaceViewCacheService.invalidateDetail(nodeId, session.workspaceId, session.id);
      clearConversationProjectionSession(
        session.id,
        runs.value.map((run) => run.id)
      );
      restoreConversationWindow([], null);
      runService.replaceRuns([]);
      watchCoordinator.current?.stopSession();
      await openSession(session.id, {
        preserveMobileWorkspaceSurface: true,
        deferInitialScroll: true
      });
    },
    openRun,
    notifyGoalAlreadyActive: () => showMessage(translate('goal.alreadyActive'), 'info')
  });

  const sessionMessageService = createWorkbenchSessionMessageService({
    workspaceTarget,
    selectedSessionId,
    selectedWorkspace,
    selectedSession,
    sessions,
    input: sessionInput,
    skillTokens: composerSkillTokens,
    references: composerFileReferences,
    attachments: newSessionAttachments,
    attachmentsPending: composerAttachmentsPending,
    composerOpen: composerSessionOpen,
    composerBusy: composerSessionBusy,
    commandAvailable: canExecuteRunnerCommand,
    submissionAvailable: () => !loading.value,
    draftOpen: draftSessionOpen,
    selectedCommand: selectedRunnerCommand,
    commandPickerOpen,
    deferredCommands: deferredDraftCommands,
    fastEnabled: codexFastEnabled,
    notice,
    request,
    stageDraftCommand: stageComposerDraftCommand,
    createDraftSession,
    executeCommand: executeRunnerCommand,
    replaceSession,
    sessionPathId: agentSessionPathId,
    temporaryTitle: temporarySessionTitle,
    consumeAttachments: composerAttachmentService.consume,
    retainAttachments: composerAttachmentService.retainForSubmission,
    clearSkillTokens: composerSkillTokenService.clear,
    acceptRun: runService.acceptRun,
    migrateSessionCache: (nodeId, workspaceId, previousId, nextId, session) =>
      workspaceViewCacheService.migrateSession(nodeId, workspaceId, previousId, nextId, session),
    openRun,
    cacheRun: cacheRunSnapshotFor,
    beginSessionWatch: navigationWatchService.requestSessionWatch,
    scrollToLatest: conversationScrollService.scrollToLatest,
    scrollToLatestAfterLayout: conversationScrollService.scrollToLatestAfterLayout,
    errorMessage: message,
    beginSubmission: submissionService.begin
  });

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

  function selectRunnerCommand(command: RunnerCommand): void {
    runnerInteractionService.selectCommand(
      command,
      (preserveDraft) => void sendSessionMessageWithIntent(undefined, preserveDraft)
    );
  }

  function insertComposerSkill(skill: EffectiveWorkspaceSkill, cursor: number): void {
    composerSkillTokenService.select(skill);
    focusComposerInputAt(cursor);
  }

  function selectComposerSkill(skill: EffectiveWorkspaceSkill): void {
    runnerInteractionService.selectSkill(skill, insertComposerSkill);
  }

  function selectComposerQuickPrompt(prompt: QuickPrompt): void {
    composerInteractions.selectQuickPrompt(prompt);
  }

  async function executeRunnerCommand(
    session: Session,
    command: RunnerCommand,
    input: string
  ): Promise<{ session?: Session; run?: AgentRun }> {
    return executeRunnerCommandById(
      session,
      command.id,
      input,
      command.interaction === 'DESTRUCTIVE_ACTION'
    );
  }

  function executeRunnerCommandById(
    session: Session,
    commandId: string,
    input: string,
    destructive = false
  ) {
    return runnerCommandService.execute(session, commandId, input, destructive);
  }

  const contextCommands = createWorkbenchContextCommandService({
    workspaceTarget,
    selectedSession,
    compactCommand,
    canCompact: canCompactContext,
    contextUsageLabel,
    notice,
    request,
    execute: executeRunnerCommand,
    errorMessage: message,
    beginSubmission: submissionService.begin
  });

  function compactCurrentContext(): Promise<void> {
    return contextCommands.compactCurrentContext();
  }

  function closeCommandState(state: RunnerCommandState): void {
    runnerInteractionService.closeCommandState(
      state,
      (command, input) =>
        void sessionMessageService.send(undefined, true, undefined, { command, input })
    );
  }

  async function editGoal(objective: string): Promise<void> {
    const session = selectedSession.value;
    if (session === undefined || objective.trim().length === 0) return;
    await executeRunnerCommandById(session, 'goal', `/goal ${objective.trim()}`);
  }

  async function clearGoal(): Promise<void> {
    const session = selectedSession.value;
    if (session !== undefined) await executeRunnerCommandById(session, 'goal', '/goal --clear');
  }

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

  function scrollConversationToLatestAfterLayout(): Promise<void> {
    return composerInteractions.scrollConversationToLatestAfterLayout();
  }

  const { refreshClaudeChannelToken } = createWorkbenchRunnerChannelService({
    workspaceTarget,
    selectedSession,
    token: channelToken,
    input: channelInput,
    loading,
    notice,
    request,
    sessionPathId: agentSessionPathId,
    errorMessage: message
  });

  const conversationRealtime = createWorkbenchConversationRealtimeService({
    workspaceTarget,
    selectedSessionId,
    selectedRunId,
    runs,
    syncTurnStatus: conversationProjectionService.syncRunStatus,
    channelToken,
    refreshChannelToken: refreshClaudeChannelToken,
    syncCachedRunStatus
  });

  function openRun(runId: string): void {
    conversationRealtime.openRun(runId);
  }

  function syncConversationTurnStatus(runId: string, status: string, sessionId?: string): void {
    conversationRealtime.syncConversationTurnStatus(runId, status, sessionId);
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

  const { decideApproval } = createWorkbenchApprovalService({
    workspaceTarget,
    notice,
    request,
    errorMessage: message,
    beginSubmission: submissionService.begin
  });

  const { stopActiveRun } = createWorkbenchRunControlService({
    workspaceTarget,
    selectedSessionId,
    selectedRunId,
    activeRun: activeComposerRun,
    notice,
    runService,
    request,
    sessionPathId: agentSessionPathId,
    errorMessage: message,
    beginSubmission: submissionService.begin
  });
  const selectedSubmissionContext = computed(() =>
    sessionSubmissionContext(selectedSessionId.value)
  );
  const composerSubmitting = computed(
    () =>
      submissionPending.value && submissionService.context.value === selectedSubmissionContext.value
  );
  const composerWorking = authoritativeComposerWorking;
  const composerWorkingLabel = authoritativeComposerWorkingLabel;
  const canInterruptTurn = computed(
    () => authoritativeCanInterruptTurn.value && !composerSubmitting.value
  );

  const workPromptAutomaticEnabled = computed(() =>
    Boolean(
      workspaceHost.value?.capabilities.promptCompletion?.automaticTriggers === true &&
      !draftSessionOpen.value &&
      selectedSessionId.value &&
      !loadingInitialConversation.value &&
      !initialConversationLoadFailed.value
    )
  );
  const workPromptCompletion = completionClient.bind({
    automaticKey: () =>
      workPromptAutomaticEnabled.value
        ? promptCompletionAutomaticKey(conversationTurns.value)
        : undefined,
    automaticTerminalKey: () =>
      workPromptAutomaticEnabled.value
        ? promptCompletionAutomaticTerminalKey(conversationTurns.value)
        : undefined,
    // Read lazily on focus/request: browsing and task updates are context, not new triggers.
    readContextRevision: () => {
      const turn = conversationTurns.value.at(-1);
      return JSON.stringify([
        turn?.status,
        turn?.items.length,
        turn?.items.slice(-32).map((item) => [item.id, item.status, item.completedAt]),
        workspaceQueue.value.version,
        selectedSession.value?.commandStates?.map((state) => [
          state.commandId,
          state.active,
          state.detail,
          state.goal?.id,
          state.goal?.revision,
          state.goal?.status
        ]),
        workspaceInspector.value?.predictionAttention?.() ?? []
      ]);
    },
    attention: () =>
      workspaceHost.value?.capabilities.promptCompletion?.contextVersion === 3
        ? (workspaceInspector.value?.predictionAttention?.() ?? [])
        : [],
    enabled: () =>
      completionPreferences.enabled.value &&
      nodeReady.value &&
      workspaceHost.value?.capabilities.promptCompletion?.apiVersion === 1 &&
      workspaceHost.value?.capabilities.promptCompletion?.contextVersion === 3,
    target: () =>
      workspaceNodeId.value && activeWorkspaceId.value
        ? {
            nodeId: workspaceNodeId.value,
            target: { kind: 'WORKSPACE', workspaceId: activeWorkspaceId.value },
            runner: composerRunner.value,
            sessionId: draftSessionOpen.value ? null : (selectedSessionId.value ?? null)
          }
        : undefined
  });
  const composerInteractions = createWorkbenchComposerInteractionController({
    input: sessionInput,
    workspaceTarget,
    filesReady,
    mobileViewport,
    canInterruptTurn,
    runnerProfilesLoading,
    runnerProfilesFailed,
    commandPickerOpen,
    fileReferences: composerReferenceService,
    runnerInteractions: runnerInteractionService,
    hasRunnerProfile: (nodeId) => runnerProfileService.has(nodeId),
    loadRunnerProfiles,
    ensureComposerSkills,
    ensureQuickPrompts: () => void quickPromptService.refresh(),
    selectSkill: insertComposerSkill,
    stopActiveRun,
    sendMessage: (replaceCurrent, preserveDraft, contentOverride) =>
      void sendSessionMessageWithIntent(
        replaceCurrent ? 'REPLACE_CURRENT' : undefined,
        preserveDraft,
        contentOverride
      ),
    loadOlderConversationTurns,
    handleConversationScroll: (loadOlder) =>
      conversationScrollService.handleScroll(() => {
        if (!olderHistoryError.value) loadOlder();
      }),
    scrollToLatest: conversationScrollService.scrollToLatest,
    scrollToLatestAfterLayout: conversationScrollService.scrollToLatestAfterLayout,
    editRange: (start, end, text) => editComposerRange(start, end, text)
  });

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
    sessionInput,
    documentTitle,
    newSessionRunner,
    newSessionModel,
    workspaceTarget,
    selectedSessionId,
    conversationTurns,
    conversationScroll,
    followConversation,
    persistWorkbenchState,
    persistSessionDraft,
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
    onGlobalKeydown,
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
    conversationSyncPending: computed(
      () =>
        selectedSession.value !== undefined &&
        !initialConversationLoadFailed.value &&
        sessionWatchController.canWatchSessionHistory(selectedSession.value) &&
        !sessionWatchController.hasInitialSessionSnapshot(selectedSession.value.id)
    ),
    olderHistoryError,
    conversationRuns: computed(() =>
      runs.value.filter((run) => run.sessionId === selectedSessionId.value)
    ),
    contextUsageLabel,
    conversationImagePreview,
    conversationImagePreviewOpen,
    handleConversationImagePreviewError: conversationImageService.previewFailed,
    conversationInitialRenderVersion,
    conversationNextCursor,
    conversationScroll,
    conversationTurns,
    confirmConversationInitialRender,
    copyConversationMessage,
    createRegistrationToken,
    csrfToken,
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
    openAgentFileChange,
    openQuickWorkspaceFile,
    openQuickWorkspace,
    openAttachmentPreview,
    openConversationImagePreview,
    markRunImageUnavailable,
    openMobileWorkspaceSurface,
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
    setComposerInputFocus: (focus: (cursor: number) => void) => (focusComposerInputAt = focus),
    setComposerRangeEditor: (edit: typeof editComposerRange) => (editComposerRange = edit),
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
    workspaceInspector,
    workspaceKindLabel,
    workspacePath,
    workspaceTabLabel,
    workspaceTabNodeLabel,
    workspaceTabService,
    workspaceTabs,
    workspaceTarget,
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
