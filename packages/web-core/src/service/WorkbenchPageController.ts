import type { WorkspaceTarget } from '../model/workbench.js';
import { isComposerAttachmentResourcePath } from '@myagentroam/protocol';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { createHostedConversationSelectionService } from '@myagentroam/web-core/hosted-selection';
import { createAdminAuthService } from './AdminAuthService.js';
import { createRunnerUsageService } from './RunnerUsageService.js';
import { createRunnerProfileService } from './RunnerProfileService.js';
import { createWorkspaceRegistrationService } from './WorkspaceRegistrationService.js';
import { createWorkspaceSessionService } from './WorkspaceSessionService.js';
import { createConversationImageService } from './ConversationImageService.js';
import { filePreviewErrorMessage } from '../util/error-presentation.js';
import { createWorkspaceQueueService } from './WorkspaceQueueService.js';
import {
  absoluteSessionTime as formatSessionTime,
  agentSessionPathId,
  contextPercentageLabel as formatContextPercentage,
  errorMessage as message,
  currentChangesBranch,
  effortPresentation as effortLabel,
  nodePresentation as nodeLabel,
  noticePresentation as noticeType,
  runnerLabel,
  sessionActivityDateTime,
  tokenCountLabel as formatTokenCount,
  preciseElapsedDurationLabel as formatGoalDuration,
  workspaceBranchLabel,
  workspaceKindLabel,
  workspaceTabId,
  workspaceTabLabel
} from '../util/workbench-presentation.js';
import { createWorkbenchRouteService } from './WorkbenchRouteService.js';
import { createConversationProjectionService } from './ConversationProjectionService.js';
import { createWorkbenchEntityService } from './WorkbenchEntityService.js';
import { createWorkbenchEventProjectionService } from './WorkbenchEventProjectionService.js';
import { createWorkbenchPerformanceService } from './WorkbenchPerformanceService.js';
import { createWorkspaceUploadService } from './WorkspaceUploadService.js';
import { createWorkbenchLiveService } from './WorkbenchLiveService.js';
import { createWorkbenchDirectTransportCoordinator } from './WorkbenchDirectTransportCoordinator.js';
import { createWorkspaceDirectObjectUrlSink } from './WorkspaceDirectObjectUrlService.js';
import {
  createWorkspaceDirectDownloadStream,
  type WorkspaceDirectDownloadResult
} from './WorkspaceDirectDownloadStreamService.js';
import {
  readWorkspaceDirectFileRange,
  type WorkspaceDirectFileIdentity
} from './WorkspaceDirectFileReadService.js';
import { createWebPerformanceDiagnostics } from './WebPerformanceDiagnosticService.js';
import { createWorkbenchLayoutService } from './WorkbenchLayoutService.js';
import { createWorkbenchCapabilityService } from './WorkbenchCapabilityService.js';
import type { ManagementComposition } from './ManagementComposition.js';
import type { WorkbenchNavigationService } from './WorkbenchNavigationService.js';
import type { WorkspaceRegistrationInput } from './WorkspaceRegistrationService.js';
import type { SettingsSection } from '../model/settings.js';
import type { WorkbenchView } from '../util/workbench-route.js';
import type { WorkbenchNotification } from './WorkbenchNotificationService.js';
import { navigateWorkbenchNotification } from './WorkbenchNotificationNavigationService.js';
import { createComposerQueueService } from './ComposerQueueService.js';
import { createConversationScrollService } from './ConversationScrollService.js';
import { createComposerConfigurationService } from './ComposerConfigurationService.js';
import { createSessionSnapshotRefreshService } from './SessionSnapshotRefreshService.js';
import { createComposerAttachmentService } from './ComposerAttachmentService.js';
import { createWorkspaceViewCacheService } from './WorkspaceViewCacheService.js';
import { createWorkspaceWatchService } from './WorkspaceWatchService.js';
import { createWorkbenchViewWatchService as createWorkbenchNavigationWatchService } from './WorkbenchViewWatchService.js';
import { createHostedConversationWatchCoordinator as createWorkbenchWatchCoordinator } from './HostedConversationWatchCoordinator.js';
import {
  contextUsageAfterCompaction,
  isCompletedContextCompaction,
  type SessionContextUsage
} from './ConversationStateService.js';
import {
  createWorkspaceRuntimeStateService,
  mergeWorkspaceWatchSnapshot
} from './WorkspaceRuntimeStateService.js';
import { createWorkbenchSessionSelectionService } from './WorkbenchSessionSelectionService.js';
import { createWorkbenchSessionMessageService } from './WorkbenchSessionMessageService.js';
import {
  createWorkbenchSubmissionService,
  sessionSubmissionContext
} from './WorkbenchSubmissionService.js';
import { createWorkbenchWorkspaceSelectionService } from './WorkbenchWorkspaceSelectionService.js';
import { createWorkbenchComposerController } from './WorkbenchComposerController.js';
import { createWorkbenchWorkspaceCacheController } from './WorkbenchWorkspaceCacheController.js';
import { createWorkbenchWorkspaceTreeController } from './WorkbenchWorkspaceTreeController.js';
import { createWorkbenchRunControlService } from './WorkbenchRunControlService.js';
import { createWorkbenchContextCommandService } from './WorkbenchContextCommandService.js';
import { createWorkbenchPlanService } from './WorkbenchPlanService.js';
import { createWorkbenchPresentationStateService } from './WorkbenchPresentationStateService.js';
import { createWorkbenchRunnerChannelService } from './WorkbenchRunnerChannelService.js';
import { createWorkbenchApprovalService } from './WorkbenchApprovalService.js';
import { createWorkbenchSessionWatchController } from './WorkbenchSessionWatchController.js';
import { createWorkbenchConversationRealtimeService } from './WorkbenchConversationRealtimeService.js';
import { createWorkbenchConversationSnapshotService } from './WorkbenchConversationSnapshotService.js';
import { createWorkbenchConversationPagingService } from './WorkbenchConversationPagingService.js';
import { createWorkbenchEntityController } from './WorkbenchEntityController.js';
import { createWorkbenchPageStateService } from './WorkbenchBaseStateService.js';
import { createWorkbenchPageInteractionService } from './WorkbenchPageInteractionService.js';
import { createWebVersionUpdateService } from './WebVersionUpdateService.js';
import { createWorkbenchNewSessionController } from './WorkbenchNewSessionController.js';
import { createWorkbenchComposerInteractionController } from './WorkbenchComposerInteractionController.js';
import { installWorkbenchPageLifecycle } from './WorkbenchPageLifecycleService.js';
import { newestRunSnapshot } from './RunService.js';
import type { GoalExitSummary } from '../model/workbench.js';
import {
  reconcileWorkspaceQueueSnapshot,
  type WorkspaceQueueSnapshotSource
} from './WorkspaceQueueProjectionService.js';
import { createRunnerInteractionService } from './RunnerInteractionService.js';
import { createComposerSkillService } from './ComposerSkillService.js';
import { createComposerSkillTokenService } from './ComposerSkillTokenService.js';
import { createQuickPromptService } from './QuickPromptService.js';
import type { EffectiveWorkspaceSkill } from './EffectiveWorkspaceSkillService.js';
import { createFileReferenceService } from './FileReferenceService.js';
import { createConversationUserInputService } from './ConversationUserInputService.js';
import { createHostedConversationWorkspaceService } from './HostedConversationWorkspaceService.js';
import {
  promptCompletionAutomaticKey,
  promptCompletionAutomaticTerminalKey
} from './PromptCompletionService.js';
import { promptCompletionPreferenceService } from './PromptCompletionPreferenceService.js';
import { PromptCompletionClientService } from './PromptCompletionClientService.js';
import { supportsNodeFeature } from '../util/node-features.js';
import { errorCode } from '../util/api-error.js';
import {
  CONVERSATION_RECENT_SEGMENT_LIMIT,
  CONVERSATION_SEGMENT_PAGE_SIZE,
  limitConversationHistory
} from '../util/conversation-history.js';
import { conversationItemText, userInputQuestions } from '../util/conversation-presentation.js';
import { createWorkspaceTabService } from './WorkspaceTabService.js';
import {
  STANDALONE_FILE_OPEN_EVENT,
  standaloneFileOpenIntent,
  type StandaloneFileOpenIntent
} from './StandaloneFileWindowService.js';
import { createWorkspaceTreeService } from './WorkspaceTreeService.js';
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
import { translate, currentLocale, localePreferenceService } from './LocalePreferenceService.js';
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
  readonly webBuildHash: string;
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

  const baseState = createWorkbenchPageStateService({
    navigation: options.navigation,
    sessionPageSize: WORKSPACE_SESSION_PAGE_SIZE,
    onUnauthenticated: () => returnToLogin(),
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

  watch(mobileViewport, (mobile) => {
    if (!mobile) hostedConversationMobileHistoryOpen.value = false;
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

  const notice = baseState.notice;
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
  const webVersionUpdateService = createWebVersionUpdateService({
    currentVersion: options.webVersion,
    currentHash: options.webBuildHash,
    fetchVersion: async () => {
      const response = await fetch(`/web-version.json?t=${Date.now()}`, {
        cache: 'no-store',
        credentials: 'same-origin'
      });
      if (!response.ok) return undefined;
      return response.json();
    },
    onUpdateAvailable: (version, hash) =>
      workbenchNotificationService.notify({
        id: `web-update:${version}:${hash}`,
        kind: 'web-update',
        source: 'local',
        title: translate('webUpdate.title'),
        message: translate('webUpdate.message', { value0: version }),
        action: 'RELOAD_PAGE'
      }),
    onVersionCurrent: () => workbenchNotificationService.clearWebUpdate()
  });
  let removeWebVersionFocusListener: (() => void) | undefined;

  function startWebVersionUpdateCheck(): void {
    if (removeWebVersionFocusListener !== undefined) return;
    const check = () => void webVersionUpdateService.check().catch(() => undefined);
    window.addEventListener('focus', check);
    removeWebVersionFocusListener = () => {
      window.removeEventListener('focus', check);
      removeWebVersionFocusListener = undefined;
    };
    check();
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

  let recoverMissingConversationRun: (runId: string) => void = () => undefined;
  const conversationUserInputService = createConversationUserInputService({
    workspaceTarget,
    notice,
    request,
    errorMessage: message,
    missingRunError: (error) => errorCode(error) === 'RUN_NOT_FOUND',
    recoverMissingRun: (runId) => recoverMissingConversationRun(runId),
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
    notice: (value) => (notice.value = value),
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
    clear: clearNewSessionAttachments,
    clearAll: clearAllNewSessionAttachments,
    openPreview: openAttachmentPreview
  } = composerAttachmentService;

  const conversationImageService = createConversationImageService(workspaceNodeId, {
    fileAttachments: {
      target: computed(() => {
        const target = workspaceTarget.value;
        return target === undefined
          ? undefined
          : JSON.stringify([target.nodeId, target.workspaceId]);
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
      onError: (error, path) => ElMessage.error(filePreviewErrorMessage(error, path))
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
    supportsAuto: (nodeId) =>
      supportsNodeFeature(
        nodes.value.find((node) => node.id === nodeId)?.nodeAppVersion ?? '',
        'MAR_AGENT_AUTO'
      ),
    profiles: runnerProfiles,
    loading: runnerProfilesLoading,
    failed: runnerProfilesFailed,
    request,
    notice: (value) => (notice.value = value),
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

  let refreshRecentConversationWindow = async (): Promise<void> => undefined;
  const conversationProjectionService = createConversationProjectionService({
    turns: conversationTurns,
    nextCursor: conversationNextCursor,
    onRecentWindowOverflow: () => void refreshRecentConversationWindow(),
    limitHistory: limitConversationHistory
  });

  const {
    resetHistory: resetConversationProjection,
    restore: restoreConversationProjection,
    clearSession: clearConversationProjectionSession,
    markLive: markLiveConversationTurn,
    mergeItem: mergeLiveConversationItem,
    mergeTextDelta: mergeLiveConversationTextDelta,
    mergeLatest: mergeLatestConversationTurns,
    replaceRecent: replaceRecentConversationTurns,
    replaceAuthoritative: replaceAuthoritativeConversationTurns
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

  const workspaceViewCaches = workspaceViewCacheService.caches;

  const activeWorkspaceViewCache = workspaceViewCacheService.active;

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
    { id: 'usage', label: translate('modelUsage.title') },
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
    if (mobileViewport.value && nextView === 'conversations') {
      hostedConversationMobileHistoryOpen.value = true;
      if (previousView === nextView) return;
    } else hostedConversationMobileHistoryOpen.value = false;
    if (
      nextView === 'management' &&
      !managementItems.value.some((item) => item.id === managementSection.value)
    )
      managementSection.value = managementItems.value[0]?.id ?? options.systemManagementSection;
    selectWorkbenchView(nextView);
    if (previousView !== nextView && (nextView === 'nodes' || nextView === 'conversations'))
      void workbenchNotificationService.recover().catch(() => undefined);
    navigationWatchService.transition(previousView, nextView);
  }

  function closeHostedConversationMobileHistory(): void {
    hostedConversationMobileHistoryOpen.value = false;
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
    model: newSessionModel,
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
    selectQuickPrompt: selectQuickPromptFromPicker,
    activeCommandStates,
    clearCommand: clearRunnerCommand,
    stageDraftCommand
  } = runnerInteractionService;

  const composerCommandReady = computed(() => selectedRunnerCommand.value !== undefined);

  const fileReferenceService = createFileReferenceService(
    sessionInput,
    {
      nodeId: workspaceNodeId,
      workspaceId: activeWorkspaceId,
      ready: () => filesReady.value,
      request
    },
    composerFileReferences
  );

  const {
    open: fileReferencePickerOpen,
    entries: fileReferenceEntries,
    activeIndex: activeFileReferenceIndex,
    loading: fileReferenceLoading,
    match: activeFileReferenceMatch
  } = fileReferenceService;

  const {
    activeComposerRun,
    workspaceHost,
    nodeReady,
    mustSteerCurrentTurn,
    canStartTurn,
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
    draggingQueueItemId,
    editingContent: editingQueueContent,
    serializeEditedContent: composerQueueService.serializeEditedContent,
    request,
    finishEditing: composerQueueService.finishEditing,
    notice: (value) => (notice.value = value),
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
    notice: (value) => (notice.value = value),
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
    notice: (value) => (notice.value = value),
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

  async function openWorkbenchNotification(notification: WorkbenchNotification): Promise<void> {
    if (notification.action === 'RELOAD_PAGE') {
      window.location.reload();
      return;
    }
    const target = notification.target;
    if (target === undefined) return;
    try {
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
        activateWorkspace: (target) => selectWorkspace(target),
        synchronizeSessions: syncWorkspaceSessions,
        openSession,
        openHostedConversation: openHostedConversationTarget
      });
    } catch (error) {
      notice.value = translate('generated.workbenchPageController.unableToOpenTheSessionLinkedTo', {
        value0: message(error)
      });
    }
  }

  async function openRecentRun(
    run: import('./WorkbenchNotificationService.js').RecentRun
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

  async function openSessionFromList(sessionId: string): Promise<void> {
    const nodeId = workspaceNodeId.value;
    const workspaceId = activeWorkspaceId.value;
    if (nodeId !== undefined && workspaceId !== undefined)
      workbenchNotificationService.markSessionRead(nodeId, workspaceId, sessionId);
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
    cachedSessionDetail,
    cacheRunSnapshotFor,
    cacheRunSnapshot,
    cacheConversationTurn,
    replaceConversationTurns
  } = createWorkbenchWorkspaceCacheController({
    cacheService: workspaceViewCacheService,
    paging: workspaceSessionPaging,
    activeCache: activeWorkspaceViewCache,
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
    model: newSessionModel,
    effort: newSessionEffort,
    access: newSessionAccess,
    workspaceTarget,
    selectedSessionId,
    inspector: workspaceInspector,
    normalizeDraft: () => normalizeNewSessionOptions(),
    persistDraft: persistSessionDraft,
    tabId: workspaceTabId,
    maximumDetails: MAX_CACHED_SESSION_DETAILS
  });

  const { apply: applyConversationSnapshot } = createWorkbenchConversationSnapshotService({
    selectedSessionId,
    replaceCurrent: replaceAuthoritativeConversationTurns,
    mergeCurrent: mergeLatestConversationTurns,
    currentWindow: () => ({
      turns: conversationTurns.value,
      nextCursor: conversationNextCursor.value
    }),
    replaceCached: (sessionId, page) =>
      replaceConversationTurns(sessionId, page.turns, page.nextCursor)
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
      if (sessionId !== undefined) {
        const detail = cachedSessionDetail(sessionId);
        if (detail !== undefined) detail.contextUsage = contextUsage;
      }
    }
    return true;
  }

  const workbenchEventProjection = createWorkbenchEventProjectionService({
    nodes,
    sessions,
    runs,
    workspaceTarget,
    selectedSessionId,
    conversationNextCursor,
    workspaceCache: (nodeId, workspaceId) =>
      workspaceViewCaches.get(workspaceTabId(nodeId, workspaceId)),
    mergeQueue: mergeWorkspaceQueue,
    // Realtime frames can precede the Workspace sessions snapshot. Preserve visibility until the
    // next authoritative snapshot places the session in its stable list order.
    mergeSessions: (values) => mergeSessions(values),
    settleSessionRuns: runService.settleSessionRuns,
    observeManagedSessionActive: runService.observeManagedSessionActive,
    updateContext: (sessionId, context) => {
      const value = context as SessionContextUsage | null;
      const detail = cachedSessionDetail(sessionId);
      if (detail !== undefined) detail.contextUsage = value;
      if (sessionId === selectedSessionId.value) sessionContextUsage.value = value;
    },
    syncTurnStatus: syncConversationTurnStatus,
    cacheRun: (run) => cacheRunSnapshot(run),
    newestRun: newestRunSnapshot,
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
      notice.value = translate('hostedConversations.watchExpired');
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

  const workbenchLiveConnection = createWorkbenchLiveService({
    diagnostics: webPerformanceDiagnostics,
    canConnect: () => admin.value.authenticated && !admin.value.mustChangePassword,
    onEvent: (event) => {
      if (workbenchNotificationService.project(event)) return;
      applyWorkbenchEvent(event);
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
    onNodeReplaced: (nodeId) => {
      directTransport.nodeInvalidated(nodeId);
      if (nodeId !== workspaceNodeId.value) return;
      ElMessage.warning({
        message: translate('generated.workbenchPageController.aNewerInstanceWithTheSameIdentity'),
        duration: 5_000
      });
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
      (notice.value = translate('generated.workbenchPageController.receivedAnUnreadableLiveUpdate'))
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

  async function workspaceDirectMetadata(
    path: string,
    worktreePath?: string,
    repositoryPath?: string
  ) {
    if (isComposerAttachmentResourcePath(path)) return undefined;
    const nodeId = workspaceNodeId.value;
    const workspaceId = activeWorkspaceId.value;
    const nodeGeneration = nodeManifest.value?.nodeGeneration;
    if (
      nodeId === undefined ||
      workspaceId === undefined ||
      nodeGeneration === undefined ||
      nodeManifest.value?.directTransfer?.download !== true ||
      !workspaceDirectAvailable(nodeId)
    )
      return undefined;
    const parameters = new URLSearchParams({ nodeId, path });
    if (worktreePath !== undefined) parameters.set('worktreePath', worktreePath);
    if (repositoryPath !== undefined) parameters.set('repositoryPath', repositoryPath);
    const result = await request<{
      readonly file?: {
        size?: unknown;
        revision?: unknown;
      };
    }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/files/direct-metadata?${parameters.toString()}`
    );
    return typeof result.file?.size === 'number' && typeof result.file.revision === 'string'
      ? {
          nodeId,
          workspaceId,
          nodeGeneration,
          size: result.file.size,
          revision: result.file.revision
        }
      : undefined;
  }

  async function directWorkspaceFileReadRange(
    path: string,
    offset: number,
    length: number,
    worktreePath?: string,
    identity?: WorkspaceDirectFileIdentity,
    repositoryPath?: string
  ) {
    if (isComposerAttachmentResourcePath(path)) return undefined;
    const nodeId = workspaceNodeId.value;
    const workspaceId = activeWorkspaceId.value;
    const nodeGeneration = nodeManifest.value?.nodeGeneration;
    if (
      nodeId === undefined ||
      workspaceId === undefined ||
      nodeGeneration === undefined ||
      nodeManifest.value?.directTransfer?.range !== true ||
      !workspaceDirectAvailable(nodeId)
    )
      return undefined;
    return readWorkspaceDirectFileRange({
      direct: workspaceDirectTransfer,
      nodeId,
      nodeGeneration,
      resource: {
        kind: 'WORKSPACE_FILE',
        workspaceId,
        path,
        ...(repositoryPath === undefined ? {} : { repositoryPath }),
        ...(worktreePath === undefined ? {} : { worktreePath })
      },
      fileName: path.split('/').at(-1) ?? 'file',
      offset,
      length,
      ...(identity === undefined ? {} : { identity }),
      metadata: () => workspaceDirectMetadata(path, worktreePath, repositoryPath)
    }).catch(() => undefined);
  }

  async function gitDirectMetadata(
    commit: string,
    path: string,
    repositoryPath: string,
    refs: readonly string[]
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
    const parameters = new URLSearchParams({ nodeId, path });
    if (repositoryPath.length > 0) parameters.set('repositoryPath', repositoryPath);
    for (const ref of refs) parameters.append('refs', ref);
    const result = await request<{
      readonly file?: {
        size?: unknown;
        revision?: unknown;
      };
    }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/git/commits/${encodeURIComponent(commit)}/files/direct-metadata?${parameters.toString()}`
    );
    return typeof result.file?.size === 'number' && typeof result.file.revision === 'string'
      ? {
          nodeId,
          workspaceId,
          nodeGeneration,
          size: result.file.size,
          revision: result.file.revision
        }
      : undefined;
  }

  async function directGitFileReadRange(
    commit: string,
    path: string,
    repositoryPath: string,
    refs: readonly string[],
    offset: number,
    length: number,
    identity?: WorkspaceDirectFileIdentity
  ) {
    const nodeId = workspaceNodeId.value;
    const workspaceId = activeWorkspaceId.value;
    const nodeGeneration = nodeManifest.value?.nodeGeneration;
    if (
      nodeId === undefined ||
      workspaceId === undefined ||
      nodeGeneration === undefined ||
      nodeManifest.value?.directTransfer?.range !== true ||
      nodeManifest.value.directTransfer.gitCommitBlob !== true ||
      !workspaceDirectAvailable(nodeId)
    )
      return undefined;
    return readWorkspaceDirectFileRange({
      direct: workspaceDirectTransfer,
      nodeId,
      nodeGeneration,
      resource: {
        kind: 'GIT_COMMIT_BLOB',
        workspaceId,
        commit,
        path,
        ...(repositoryPath.length === 0 ? {} : { repositoryPath })
      },
      fileName: path.split('/').at(-1) ?? 'file',
      offset,
      length,
      ...(identity === undefined ? {} : { identity }),
      metadata: () => gitDirectMetadata(commit, path, repositoryPath, refs)
    }).catch(() => undefined);
  }

  async function directWorkspaceFileObjectUrl(
    path: string,
    worktreePath?: string,
    repositoryPath?: string
  ): Promise<string | undefined> {
    const metadata = await workspaceDirectMetadata(path, worktreePath, repositoryPath).catch(
      () => undefined
    );
    if (metadata === undefined) return undefined;
    try {
      const target = await createWorkspaceDirectObjectUrlSink(path.split('/').at(-1) ?? 'file');
      await workspaceDirectTransfer.download({
        nodeId: metadata.nodeId,
        nodeGeneration: metadata.nodeGeneration,
        descriptor: {
          direction: 'DOWNLOAD',
          resource: {
            kind: 'WORKSPACE_FILE',
            workspaceId: metadata.workspaceId,
            path,
            ...(repositoryPath === undefined ? {} : { repositoryPath }),
            ...(worktreePath === undefined ? {} : { worktreePath })
          },
          fileName: path.split('/').at(-1) ?? 'file',
          revision: metadata.revision,
          size: metadata.size
        },
        sink: target.sink
      });
      return target.objectUrl();
    } catch {
      return undefined;
    }
  }

  async function directWorkspaceFileDownload(
    path: string,
    worktreePath?: string,
    repositoryPath?: string
  ): Promise<WorkspaceDirectDownloadResult> {
    const nodeId = workspaceNodeId.value;
    if (
      nodeId === undefined ||
      activeWorkspaceId.value === undefined ||
      nodeManifest.value?.nodeGeneration === undefined ||
      nodeManifest.value.directTransfer?.download !== true ||
      !workspaceDirectAvailable(nodeId)
    )
      return 'UNAVAILABLE';
    const metadata = await workspaceDirectMetadata(path, worktreePath, repositoryPath).catch(
      () => undefined
    );
    if (metadata === undefined) return 'UNAVAILABLE';
    const fileName = path.split('/').at(-1) ?? 'download';
    let target: Awaited<ReturnType<typeof createWorkspaceDirectDownloadStream>> | undefined;
    try {
      target = await createWorkspaceDirectDownloadStream(fileName, metadata.size);
      await workspaceDirectTransfer.download({
        nodeId: metadata.nodeId,
        nodeGeneration: metadata.nodeGeneration,
        descriptor: {
          direction: 'DOWNLOAD',
          resource: {
            kind: 'WORKSPACE_FILE',
            workspaceId: metadata.workspaceId,
            path,
            ...(repositoryPath === undefined ? {} : { repositoryPath }),
            ...(worktreePath === undefined ? {} : { worktreePath })
          },
          fileName,
          revision: metadata.revision,
          size: metadata.size
        },
        sink: target.sink,
        signal: target.signal
      });
      return 'COMPLETED';
    } catch {
      if (target?.cancelled() === true) return 'CANCELLED';
      return target?.started() === true ? 'FAILED' : 'UNAVAILABLE';
    }
  }

  async function directGitFileObjectUrl(
    commit: string,
    path: string,
    repositoryPath: string,
    refs: readonly string[]
  ): Promise<string | undefined> {
    const metadata = await gitDirectMetadata(commit, path, repositoryPath, refs).catch(
      () => undefined
    );
    if (metadata === undefined) return undefined;
    try {
      const target = await createWorkspaceDirectObjectUrlSink(path.split('/').at(-1) ?? 'file');
      await workspaceDirectTransfer.download({
        nodeId: metadata.nodeId,
        nodeGeneration: metadata.nodeGeneration,
        descriptor: {
          direction: 'DOWNLOAD',
          resource: {
            kind: 'GIT_COMMIT_BLOB',
            workspaceId: metadata.workspaceId,
            commit,
            path,
            ...(repositoryPath.length === 0 ? {} : { repositoryPath })
          },
          fileName: path.split('/').at(-1) ?? 'file',
          revision: metadata.revision,
          size: metadata.size
        },
        sink: target.sink
      });
      return target.objectUrl();
    } catch {
      return undefined;
    }
  }

  async function directGitFileDownload(
    commit: string,
    path: string,
    repositoryPath: string,
    refs: readonly string[]
  ): Promise<WorkspaceDirectDownloadResult> {
    const nodeId = workspaceNodeId.value;
    if (
      nodeId === undefined ||
      activeWorkspaceId.value === undefined ||
      nodeManifest.value?.nodeGeneration === undefined ||
      nodeManifest.value.directTransfer?.download !== true ||
      nodeManifest.value.directTransfer.gitCommitBlob !== true ||
      !workspaceDirectAvailable(nodeId)
    )
      return 'UNAVAILABLE';
    const metadata = await gitDirectMetadata(commit, path, repositoryPath, refs).catch(
      () => undefined
    );
    if (metadata === undefined) return 'UNAVAILABLE';
    const fileName = path.split('/').at(-1) ?? 'download';
    let target: Awaited<ReturnType<typeof createWorkspaceDirectDownloadStream>> | undefined;
    try {
      target = await createWorkspaceDirectDownloadStream(fileName, metadata.size);
      await workspaceDirectTransfer.download({
        nodeId: metadata.nodeId,
        nodeGeneration: metadata.nodeGeneration,
        descriptor: {
          direction: 'DOWNLOAD',
          resource: {
            kind: 'GIT_COMMIT_BLOB',
            workspaceId: metadata.workspaceId,
            commit,
            path,
            ...(repositoryPath.length === 0 ? {} : { repositoryPath })
          },
          fileName,
          revision: metadata.revision,
          size: metadata.size
        },
        sink: target.sink,
        signal: target.signal
      });
      return 'COMPLETED';
    } catch {
      if (target?.cancelled() === true) return 'CANCELLED';
      return target?.started() === true ? 'FAILED' : 'UNAVAILABLE';
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
    invalidateRequests: workbenchHttpService.invalidateAuthentication,
    onSignedOut: handleSignedOut,
    notice: (value) => (notice.value = value),
    errorMessage: message
  });

  const {
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
    error: (value) => ElMessage.error(value),
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
    notice: (value) => (notice.value = value),
    error: (value) => ElMessage.error(value),
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
    sessions,
    runs,
    workspaceTarget,
    selectedSessionId,
    paging: workspaceSessionPaging,
    pageSize: WORKSPACE_SESSION_PAGE_SIZE,
    tabId: workspaceTabId,
    request,
    notice: (value) => (notice.value = value),
    errorMessage: message
  });

  const {
    refreshing: refreshingWorkspaceSessions,
    searchQuery: workspaceSessionSearchQuery,
    searchResults: workspaceSessionSearchResults,
    searchNextCursor: workspaceSessionSearchNextCursor,
    searching: searchingWorkspaceSessions,
    loadingMoreSearchResults: loadingMoreWorkspaceSessionSearchResults,
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
    workspaceSessionSearchQuery.value.length > 0
      ? workspaceSessionSearchResults.value
      : unfilteredWorkspaceSessions.value
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
    authenticationRestoreGeneration += 1;
    void workbenchNotificationService.systemNotifications.invalidatePush();
    disposeWorkbenchNotifications();
    removeWebVersionFocusListener?.();
    watchCoordinator.current?.dispose();
    hostedConversationWorkspace.clearSelectedConversation();
    directTransport.reset();
    closeWorkbenchLive();
    nodes.value = [];
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
    openWorkspaceTabSession: (sessionId) =>
      workbenchSessionSelectionService.openWorkspaceTabSession(sessionId),
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
    model: newSessionModel,
    effort: newSessionEffort,
    access: newSessionAccess,
    modelEffortSelection: composerModelEffortSelection,
    codexFastEnabled,
    profileService: runnerProfileService,
    normalize: normalizeComposerConfiguration,
    apply: applyComposerDefaultConfiguration,
    ensureDraftSupported: (profiles) => ensureDraftRunnerSupported(profiles),
    clearRunnerCommand,
    request,
    sessionPathId: agentSessionPathId,
    notice: (value) => (notice.value = value),
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
        { readonly sessions?: readonly Session[]; readonly nextCursor?: string | null } | undefined;
      if (Array.isArray(sessionPage?.sessions)) {
        const selectedSession = sessions.value.find(
          (session) => session.id === selectedSessionId.value
        );
        applyWorkspaceSessionSnapshot(nodeId, workspaceId, {
          sessions: [...sessionPage.sessions],
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
    activeCache: activeWorkspaceViewCache,
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
      runs.value = [];
      conversationTurns.value = [];
      conversationNextCursor.value = null;
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
    notice: (value) => (notice.value = value),
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
    openDraft: () => openNewSessionComposer(),
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
        if (nextUrl.origin === location.origin && nextUrl.pathname === location.pathname)
          history.replaceState(history.state, '', nextUrl);
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
    nextCursor: conversationNextCursor,
    loadingInitial: loadingInitialConversation,
    initialLoadFailed: initialConversationLoadFailed,
    contextUsage: sessionContextUsage,
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
      workspaceViewCache(nodeId, workspaceId).queues.get(sessionId) ?? {
        version: 0,
        paused: false,
        items: []
      },
    restoreProjection: restoreConversationProjection,
    resetProjection: resetConversationProjection,
    openRun,
    scrollLatest: scrollConversationToLatestAfterLayout,
    beginInitialRender: beginConversationInitialRender,
    request,
    sessionPathId: agentSessionPathId,
    replaceSession,
    canWatch: canWatchSessionHistory,
    beginWatch: async (sessionId) => {
      const coordinator = watchCoordinator.current;
      if (coordinator === undefined) return false;
      await coordinator.restartSession(sessionId);
      return sessionWatchController.hasInitialSessionSnapshot(sessionId);
    },
    applySnapshot: applyConversationSnapshot,
    mergeTurns: mergeLatestConversationTurns,
    notice: (value) => (notice.value = value),
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
    openDraft: () => openNewSessionComposer(),
    notice: (error) => (notice.value = message(error)),
    currentSelectionRevision: () =>
      currentDetailRequest() + workbenchWorkspaceSelectionService.currentSelectionRevision(),
    rememberSession: workspaceTabService.rememberSession
  });

  const {
    restore: restoreWorkbenchRoute,
    sync: syncWorkbenchRoute,
    hostedConversationRoute
  } = workbenchRouteService;
  const restoringHostedConversationRoute = ref(hostedConversationRoute !== undefined);

  const {
    renameNode,
    renameSession,
    setSessionPinned,
    movePinnedSession,
    movePinnedSessionTo,
    deleteSession,
    deleteNode
  } = createWorkbenchEntityController({
    actions: workbenchEntityActions,
    nodes,
    sessions,
    runs,
    turns: conversationTurns,
    nextCursor: conversationNextCursor,
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
    openDraft: () => openNewSessionComposer(),
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
    openNewSessionComposer
  } = createWorkbenchNewSessionController({
    workspaceTarget,
    selectedSessionId,
    selectedRunId,
    selectedWorkspace,
    sessions,
    runs,
    conversationTurns,
    conversationNextCursor,
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
  openNewSessionComposerShortcut = openNewSessionComposer;

  async function createRegistrationToken(context?: NodeRegistrationContext): Promise<void> {
    loading.value = true;
    notice.value = '';
    try {
      registrationToken.value = (
        await (options.submitNodeRegistration === undefined
          ? request<{ token: string }>('/api/node-registration-tokens', { method: 'POST' })
          : options.submitNodeRegistration(request, context))
      ).token;
    } catch (error) {
      notice.value = translate(
        'generated.workbenchPageController.unableToCreateARegistrationToken',
        { value0: message(error) }
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
    options: {
      readonly preserveMobileWorkspaceSurface?: boolean;
      readonly deferInitialScroll?: boolean;
      readonly skipSaveCurrent?: boolean;
    } = {}
  ): Promise<void> {
    return workbenchSessionSelectionService.openSession(sessionId, options);
  }

  function reloadSelectedSession(): void {
    if (selectedSessionId.value !== undefined) void openSession(selectedSessionId.value);
  }

  async function rewindConversation(turn: ConversationTurn, item: ConversationItem): Promise<void> {
    const nodeId = workspaceNodeId.value;
    const session = selectedSession.value;
    if (
      nodeId === undefined ||
      session === undefined ||
      turn.rewind === undefined ||
      !rewindConversationEnabled.value
    )
      return;
    const before = item.kind === 'user_message';
    const previousSessionId = session.id;
    const sourceSelected = () =>
      workspaceNodeId.value === nodeId && selectedSessionId.value === session.id;
    try {
      await ElMessageBox.confirm(
        before
          ? translate('generated.workbenchPageController.createANewSessionBranchBeforeThis')
          : translate('generated.workbenchPageController.createANewSessionBranchThatRetains'),
        translate('generated.workbenchPageController.createFallbackBranch'),
        {
          confirmButtonText: translate('generated.workbenchPageController.createBranch'),
          cancelButtonText: translate('generated.workbenchPageController.cancel'),
          type: 'warning'
        }
      );
    } catch {
      return;
    }
    if (
      workspaceNodeId.value !== nodeId ||
      selectedSessionId.value !== session.id ||
      !rewindConversationEnabled.value
    )
      return;
    const finishSubmission = submissionService.begin(`session:${session.id}`);
    if (finishSubmission === undefined) return;
    const previousInput = sessionInput.value;
    let createdSessionId: string | undefined;
    loading.value = true;
    try {
      const result = await request<{ session: Session }>(
        `/api/agent-sessions/${agentSessionPathId(session.id)}/rewind`,
        {
          method: 'POST',
          body: JSON.stringify({
            nodeId,
            turnId: turn.turnId ?? turn.id,
            position: before ? 'BEFORE' : 'AFTER',
            boundary: before ? turn.rewind.before : turn.rewind.after
          })
        }
      );
      if (!sourceSelected()) return;
      createdSessionId = result.session.id;
      replaceSession(result.session.id, result.session);
      await openSession(result.session.id);
      if (workspaceNodeId.value !== nodeId || selectedSessionId.value !== result.session.id) return;
      sessionInput.value = before ? conversationItemText(item.kind, item.payload) : '';
      focusComposerInputAt(sessionInput.value.length);
      ElMessage.success(translate('generated.workbenchPageController.fallbackBranchCreated'));
    } catch (error) {
      if (
        createdSessionId !== undefined &&
        workspaceNodeId.value === nodeId &&
        selectedSessionId.value === createdSessionId
      ) {
        await openSession(previousSessionId).catch(() => undefined);
        if (sourceSelected()) sessionInput.value = previousInput;
      }
      ElMessage.error(
        translate('generated.workbenchPageController.unableToCreateAFallbackBranch', {
          value0: message(error)
        })
      );
    } finally {
      finishSubmission();
      loading.value = false;
    }
  }

  async function rollbackConversation(
    turn: ConversationTurn,
    item: ConversationItem
  ): Promise<void> {
    const nodeId = workspaceNodeId.value;
    const session = selectedSession.value;
    if (
      nodeId === undefined ||
      session === undefined ||
      !rollbackConversationEnabled.value ||
      item.kind !== 'user_message' ||
      item.status !== 'COMPLETED' ||
      turn.rewind === undefined ||
      !['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'LOST'].includes(turn.status)
    )
      return;
    const sourceSelected = () =>
      workspaceNodeId.value === nodeId && selectedSessionId.value === session.id;
    try {
      await ElMessageBox.confirm(
        translate('generated.workbenchPageController.rollbackConversationWarning'),
        translate('generated.workbenchPageController.rollbackConversation'),
        {
          confirmButtonText: translate(
            'generated.workbenchPageController.confirmRollbackConversation'
          ),
          cancelButtonText: translate('generated.workbenchPageController.cancel'),
          type: 'warning'
        }
      );
    } catch {
      return;
    }
    if (
      workspaceNodeId.value !== nodeId ||
      selectedSessionId.value !== session.id ||
      !rollbackConversationEnabled.value
    )
      return;
    const finishSubmission = submissionService.begin(`session:${session.id}`);
    if (finishSubmission === undefined) return;
    loading.value = true;
    try {
      const result = await request<{ session: Session }>(
        `/api/agent-sessions/${agentSessionPathId(session.id)}/rollback`,
        {
          method: 'POST',
          body: JSON.stringify({
            nodeId,
            turnId: turn.turnId ?? turn.id,
            boundary: turn.rewind.before
          })
        }
      );
      workspaceViewCache(nodeId, session.workspaceId).sessionDetails.delete(session.id);
      if (!sourceSelected()) return;
      replaceSession(session.id, result.session);
      clearConversationProjectionSession(
        session.id,
        runs.value.map((run) => run.id)
      );
      conversationTurns.value = [];
      conversationNextCursor.value = null;
      runs.value = [];
      resetConversationProjection();
      watchCoordinator.current?.stopSession();
      await openSession(session.id, {
        preserveMobileWorkspaceSurface: true,
        deferInitialScroll: true
      });
      if (!sourceSelected()) return;
      sessionInput.value = conversationItemText(item.kind, item.payload);
      saveCurrentWorkspaceView();
      focusComposerInputAt(sessionInput.value.length);
    } catch (error) {
      ElMessage.error(
        translate('generated.workbenchPageController.unableToRollbackConversation', {
          value0: message(error)
        })
      );
    } finally {
      finishSubmission();
      loading.value = false;
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
    const current = sessions.value.find((session) => session.id === previousId);
    const value = preserveManagedActiveSession(current, next);
    const wasSelected = selectedSessionId.value === previousId;
    mergeSessions([value]);
    if (previousId !== value.id && sessions.value.some((session) => session.id === previousId))
      sessions.value = sessions.value.filter((session) => session.id !== previousId);
    if (wasSelected) selectedSessionId.value = value.id;
  }

  function stageComposerDraftCommand(command: RunnerCommand, input: string): void {
    const goalAlreadyActive =
      command.id === 'goal' &&
      deferredDraftCommands.value.some((candidate) => candidate.command.id === 'goal');
    stageDraftCommand(command, input);
    if (command.id !== 'goal') return;
    if (goalAlreadyActive) {
      ElMessage.info(translate('goal.alreadyActive'));
      return;
    }
    if (command.runner === 'mar-agent') return;
    newSessionAccess.value =
      command.runner === 'codex'
        ? 'full-access'
        : command.runner === 'claude-code'
          ? 'bypass'
          : 'auto';
  }

  const sessionMessageService = createWorkbenchSessionMessageService({
    workspaceTarget,
    selectedSessionId,
    selectedWorkspace,
    selectedSession,
    sessions,
    runs,
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
    clearAttachments: clearNewSessionAttachments,
    clearSkillTokens: composerSkillTokenService.clear,
    newestRun: newestRunSnapshot,
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

  function sendSessionMessage(): void {
    void sendSessionMessageWithIntent();
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
    const cursor = selectQuickPromptFromPicker(prompt);
    if (cursor !== undefined) focusComposerInputAt(cursor);
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

  async function executeRunnerCommandById(
    session: Session,
    commandId: string,
    input: string,
    destructive = false
  ): Promise<{
    session?: Session;
    run?: AgentRun;
    goalAccessChanged?: boolean;
    goalAlreadyActive?: boolean;
    goalExit?: GoalExitSummary;
  }> {
    const nodeId = workspaceNodeId.value;
    const result = await request<{
      session?: Session;
      run?: AgentRun;
      goalAccessChanged?: boolean;
      goalAlreadyActive?: boolean;
      goalExit?: GoalExitSummary;
    }>(`/api/agent-sessions/${agentSessionPathId(session.id)}/commands`, {
      method: 'POST',
      body: JSON.stringify({
        nodeId: workspaceNodeId.value,
        workspaceId: session.workspaceId,
        commandId,
        input,
        ...(session.runner === 'mar-agent' && session.model ? { model: session.model } : {})
      })
    });
    const stillSelected =
      nodeId !== undefined &&
      workspaceNodeId.value === nodeId &&
      selectedSessionId.value === session.id;
    if (result.session !== undefined && workspaceNodeId.value === nodeId) {
      replaceSession(session.id, result.session);
      if (stillSelected) applyComposerConfiguration(result.session);
    }
    if (destructive && stillSelected) {
      workspaceViewCache(nodeId, session.workspaceId).sessionDetails.delete(session.id);
      clearConversationProjectionSession(
        session.id,
        runs.value.map((run) => run.id)
      );
      conversationTurns.value = [];
      conversationNextCursor.value = null;
      runs.value = [];
      resetConversationProjection();
      watchCoordinator.current?.stopSession();
      await openSession(session.id, {
        preserveMobileWorkspaceSurface: true,
        deferInitialScroll: true
      });
    }
    if (commandId === 'goal' && result.goalAlreadyActive === true)
      ElMessage.info(translate('goal.alreadyActive'));
    if (result.run !== undefined) {
      if (stillSelected) {
        const current = runs.value.find((candidate) => candidate.id === result.run?.id);
        runs.value = [
          newestRunSnapshot(current, result.run),
          ...runs.value.filter((candidate) => candidate.id !== result.run?.id)
        ];
        openRun(result.run.id);
      } else if (nodeId !== undefined) cacheRunSnapshotFor(nodeId, session.workspaceId, result.run);
    }
    return result;
  }

  const contextCommands = createWorkbenchContextCommandService({
    workspaceTarget,
    selectedSession,
    compactCommand,
    canCompact: canCompactContext,
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
    if (session === undefined) return;
    const nodeId = workspaceNodeId.value;
    const result = await executeRunnerCommandById(session, 'goal', '/goal --clear');
    if (
      result.goalExit !== undefined &&
      workspaceNodeId.value === nodeId &&
      selectedSessionId.value === session.id
    )
      showGoalExit(result.goalExit);
  }

  function showGoalExit(summary: GoalExitSummary): void {
    if (
      (summary.status !== 'removed' && summary.status !== 'stopped') ||
      !Number.isSafeInteger(summary.elapsedWallMs) ||
      summary.elapsedWallMs < 0 ||
      !Number.isSafeInteger(summary.turns) ||
      summary.turns < 0
    )
      return;
    ElMessage.info(
      translate(summary.status === 'removed' ? 'goal.removedSummary' : 'goal.stoppedSummary', {
        value0: formatGoalDuration(summary.elapsedWallMs),
        value1: String(summary.turns)
      })
    );
  }

  function onComposerKeydown(event: KeyboardEvent): void {
    composerInteractions.onComposerKeydown(event);
  }

  function selectFileReference(entry: Parameters<typeof fileReferenceService.select>[0]): void {
    composerInteractions.selectFileReference(entry);
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
    turns: conversationTurns,
    channelToken,
    refreshChannelToken: refreshClaudeChannelToken,
    cachedDetail: cachedSessionDetail
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

  const conversationPagingService = createWorkbenchConversationPagingService({
    workspaceTarget,
    selectedSessionId,
    nextCursor: conversationNextCursor,
    loadingOlder: loadingOlderConversation,
    turns: conversationTurns,
    scrollElement: conversationScroll,
    pageSize: CONVERSATION_SEGMENT_PAGE_SIZE,
    recentSegmentWindowSize: CONVERSATION_RECENT_SEGMENT_LIMIT,
    replaceRecent: replaceRecentConversationTurns,
    request,
    sessionPathId: agentSessionPathId,
    notice,
    errorMessage: message
  });
  const { loadOlderConversationTurns, olderHistoryError } = conversationPagingService;
  refreshRecentConversationWindow = conversationPagingService.refreshRecentConversationTurns;

  const { decideApproval } = createWorkbenchApprovalService({
    workspaceTarget,
    notice,
    request,
    errorMessage: message,
    beginSubmission: submissionService.begin
  });

  const { stopActiveRun, recoverMissingRun } = createWorkbenchRunControlService({
    workspaceTarget,
    selectedSessionId,
    selectedRunId,
    activeRun: activeComposerRun,
    runs,
    notice,
    runService,
    request,
    sessionPathId: agentSessionPathId,
    errorMessage: message,
    beginSubmission: submissionService.begin,
    onGoalExit: showGoalExit
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
  recoverMissingConversationRun = recoverMissingRun;

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
      workspaceHost.value?.capabilities.promptCompletion?.contextVersion === 3 &&
      supportsNodeFeature(workspaceHost.value?.nodeAppVersion ?? '', 'prompt-completion'),
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
    fileReferences: fileReferenceService,
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
    focusInputAt: (cursor) => focusComposerInputAt(cursor)
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
    notice,
    conversationTurns,
    conversationScroll,
    followConversation,
    noticeType,
    persistWorkbenchState,
    persistSessionDraft,
    syncWorkbenchRoute,
    normalizeNewSessionOptions,
    clearRunnerCommand,
    clearComposerModelEffort: () => (composerModelEffortSelection.value = undefined),
    closeFileReferences: () => {
      fileReferenceService.cancelSearch();
      fileReferenceService.close();
    },
    saveCurrentWorkspaceView,
    scrollConversationToLatest,
    stopSelectedSessionWatch,
    restoreWorkbenchState,
    restoreWorkbenchEventCursors,
    restoreWorkspaceUploads,
    startNavigation,
    handleSessionWatchVisibility,
    onGlobalKeydown,
    refreshAdmin,
    cancelFileReferenceSearch: fileReferenceService.cancelSearch,
    disposeNavigation,
    disposeWorkspaceUploads,
    disposeWorkbenchNotifications,
    disposeWebVersionUpdateCheck: () => removeWebVersionFocusListener?.(),
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
    activeFileReferenceMatch,
    activePlanContinuation,
    activeRunnerCommandIndex,
    activeWorkspaceTabId,
    addNewSessionFiles,
    addWorkspaceForNode,
    admin,
    adminLoaded,
    adminSessions,
    attachmentPreview,
    attachmentPreviewOpen,
    canCompactContext,
    canInterruptTurn,
    canLoadMoreWorkspaceSessions,
    canUseComposer,
    cancelWorkspaceUpload,
    changeWorkspaceWatchDirectory,
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
    composerSkillsSupported,
    composerSkillsLoading: composerSkillTargets.loading,
    composerSkillsFailed: composerSkillTargets.failed,
    composerSkillTokens,
    removeComposerSkillToken: composerSkillTokenService.remove,
    composerFileReferences,
    removeComposerFileReference: fileReferenceService.remove,
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
    fileReferenceEntries,
    fileReferenceLoading,
    fileReferencePickerOpen,
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
    loadingInitialConversation,
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
    notice,
    onComposerAttachmentDragEnter,
    onComposerAttachmentDragLeave,
    onComposerAttachmentDrop,
    onComposerCursor,
    onComposerInput,
    onComposerKeydown,
    onComposerScroll,
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
    selectFileReference,
    setComposerInputFocus: (focus: (cursor: number) => void) => (focusComposerInputAt = focus),
    selectManagementSection,
    selectNavigation,
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
