/**
 * Application behavior for one ordinary Workspace Session Pane, shared by Main and Aside.
 * PaneState owns local mutable projections; domain services own protocol, cache and Run rules.
 * This module connects narrow capabilities and exposes Pane presentation/actions to the View.
 * Location-specific opening/visibility policy belongs in createWorkspaceSessionPane below.
 * Connect domain capabilities, then the shared Watch coordinator, before activating the page.
 * Do not add page-wide selection state, file HTTP protocols or a second Watch lifecycle here.
 */
import { computed, getCurrentScope, onScopeDispose, ref, watch as watchRef, type Ref } from 'vue';
import { ElMessageBox } from 'element-plus';
import { sessionSubmissionContext } from './workbench-submission-service.js';
import { errorCode } from '../util/api-error.js';
import { agentSessionPathId } from '../util/workbench-presentation.js';
import { temporarySessionTitle } from '../util/session-presentation.js';
import {
  CONVERSATION_RECENT_SEGMENT_LIMIT,
  CONVERSATION_SEGMENT_PAGE_SIZE
} from '../util/conversation-history.js';
import {
  runnerLabel,
  effortPresentation,
  contextPercentageLabel,
  tokenCountLabel
} from '../util/workbench-presentation.js';
import { displayConversationItem } from '../util/conversation-domain.js';
import { createWorkbenchComposerController } from './workbench-composer-controller.js';
import { createComposerAttachmentInputService } from './composer-attachment-input-service.js';
import { createConversationImageService } from './conversation-image-service.js';
import { filePreviewErrorMessage } from '../util/error-presentation.js';
import { copyConversationMessage } from './workbench-conversation-copy-service.js';
import { createWorkbenchEventProjectionService } from './workbench-event-projection-service.js';
import {
  contextUsageAfterCompaction,
  isCompletedContextCompaction,
  type SessionContextUsage
} from './conversation-state-service.js';
import { toolChangeOpenIntent } from './tool-change-review-service.js';
import type { FileChangeEntry } from '../util/conversation-presentation.js';
import type { ComposerAttachmentFile } from '@myagentroam/protocol';
import type { PromptCompletionClientService } from './prompt-completion-client-service.js';
import {
  promptCompletionAutomaticKey,
  promptCompletionAutomaticTerminalKey
} from './prompt-completion-service.js';
import { createWorkbenchRunnerCommandService } from './workbench-runner-command-service.js';
import {
  activePlanContinuation as findPlanContinuation,
  localizedRunnerCommandState
} from '../util/conversation-domain.js';
import { showMessage } from './message-feedback-service.js';
import { translate } from './locale-preference-service.js';
import { marIcon } from '../util/mar-icons.js';
import type { ConversationItem, ConversationTurn, Session } from '../model/workbench.js';
import { createWorkspaceSessionPaneState } from './workspace-session-pane-state.js';
import {
  createWorkspaceSessionPaneLifecycle,
  createWorkspaceSessionPaneRenderLifecycle,
  createWorkspaceSessionPaneWatchGate
} from './workspace-session-pane-loader.js';

type PaneState = ReturnType<typeof createWorkspaceSessionPaneState>;
type PresentationOptions = Parameters<PaneState['createPresentation']>[0];
type QueueOptions = Parameters<PaneState['createQueueActions']>[0];
type WatchOptions = Parameters<PaneState['createWatch']>[0];
type CommandOptions = Parameters<typeof createWorkbenchRunnerCommandService>[0];
type MessageOptions = Parameters<PaneState['createMessaging']>[0];
type HistoryOptions = Parameters<PaneState['createHistoryMutation']>[0];
type EventOptions = Parameters<typeof createWorkbenchEventProjectionService>[0];

export interface WorkspacePaneOpenOptions {
  readonly throwOnFailure?: boolean;
  readonly preserveMobileWorkspaceSurface?: boolean;
  readonly deferInitialScroll?: boolean;
  readonly skipSaveCurrent?: boolean;
  readonly markReadAfterOpen?: boolean;
  readonly onSessionResolved?: (session: Session) => void;
}

interface PaneOpeningPorts {
  readonly navigate: (
    sessionId: string,
    nodeId: string,
    options: WorkspacePaneOpenOptions
  ) => {
    readonly switching: boolean;
    readonly session: Session | undefined;
  };
  readonly setSession: (sessionId: string | undefined) => void;
  readonly sessions: Readonly<Ref<readonly Session[]>>;
  readonly draftOpen: Readonly<Ref<boolean>>;
  readonly closeMobile: () => void;
  readonly saveCurrent: () => void;
  readonly markActive: (session: Session) => void;
  readonly markRead: (
    nodeId: string,
    workspaceId: string,
    sessionId: string
  ) => void | Promise<void>;
}
interface SecondaryPanePorts {
  readonly target: Parameters<typeof createWorkspaceSessionPaneLifecycle>[0]['target'];
  readonly visible: Readonly<Ref<boolean>>;
  readonly maxDetails: number;
  readonly markRead: PaneOpeningPorts['markRead'];
  readonly replaceAsideSession: (
    target: { nodeId: string; workspaceId: string; sessionId: string },
    nextId: string
  ) => boolean;
}

/** Compose the target-bound session services once for each visible work surface. */
export function createWorkspaceSessionPaneController(
  options: {
    readonly state: PaneState;
    readonly view: Readonly<Ref<string>>;
    readonly watchConnection: {
      readonly waitReady: () => Promise<boolean>;
      readonly connected: () => boolean;
      readonly coordinator: () =>
        | Pick<
            ReturnType<
              typeof import('./workbench-watch-coordinator.js').createWorkbenchWatchCoordinator
            >,
            | 'beginSession'
            | 'beginSecondarySession'
            | 'stopSession'
            | 'stopSecondarySession'
            | 'restartSession'
            | 'restartSecondarySession'
          >
        | undefined;
    };
    readonly sessionPathId: (sessionId: string) => string;
    readonly cache: Pick<
      ReturnType<
        typeof import('./workspace-view-cache-service.js').createWorkspaceViewCacheService
      >,
      | 'replaceTurns'
      | 'syncRunStatus'
      | 'cacheQueue'
      | 'updateContext'
      | 'cacheRun'
      | 'cacheTurn'
      | 'captureCommandTarget'
      | 'invalidateDetail'
      | 'touchDetail'
      | 'queueFor'
      | 'captureSession'
      | 'migrateSession'
    >;
    readonly identity: {
      readonly replace: (
        nodeId: string,
        workspaceId: string,
        previousId: string,
        session: Session
      ) => void;
      readonly transfer: (
        nodeId: string,
        workspaceId: string,
        previousId: string,
        nextId: string
      ) => void;
    };
    readonly watch: Omit<
      WatchOptions,
      'request' | 'sessionPathId' | 'openRun' | 'applySnapshot' | 'applyEvent'
    >;
    readonly commands: {
      readonly reopen: (sessionId: string) => Promise<void>;
    };
    readonly messaging: Pick<
      MessageOptions,
      'selectedWorkspace' | 'draft' | 'temporaryTitle' | 'beginSessionWatch'
    > &
      Partial<Pick<MessageOptions, 'replaceSession'>>;
    readonly history: Pick<HistoryOptions, 'onDraftFilled' | 'openSession'> &
      Partial<Pick<HistoryOptions, 'replaceSession'>>;
    readonly completion: {
      readonly client: PromptCompletionClientService;
      readonly enabled: () => boolean;
      readonly automaticSupported: () => boolean;
      readonly attention: () => readonly import('@myagentroam/protocol').PromptCompletionAttention[];
    };
    readonly files: {
      readonly openChange: (intent: NonNullable<ReturnType<typeof toolChangeOpenIntent>>) => void;
      readonly openFile: (path: string, line?: number, column?: number, external?: boolean) => void;
      readonly attachments: (
        target: import('../model/workbench.js').WorkspaceTarget
      ) => import('./workspace-file-access-service.js').WorkspaceFileAttachmentAccess;
    };
    readonly capabilities: Pick<
      ReturnType<
        typeof import('./workbench-capability-service.js').createWorkbenchCapabilityService
      >,
      'nodes' | 'manifest' | 'manifestLoading' | 'setNodeConnection'
    >;
    readonly profiles: Pick<
      ReturnType<typeof import('./runner-profile-service.js').createRunnerProfileService>,
      'profiles' | 'loading' | 'failed' | 'has' | 'load' | 'defaultFor' | 'save'
    >;
    readonly skills: Pick<
      ReturnType<typeof import('./composer-skill-service.js').createComposerSkillService>,
      'skills' | 'loading' | 'failed' | 'ensureFresh'
    >;
    readonly prompts: Pick<
      ReturnType<typeof import('./quick-prompt-service.js').createQuickPromptService>,
      'prompts' | 'loading' | 'failed' | 'refresh'
    >;
    readonly discovery: Pick<
      ReturnType<typeof import('./workspace-session-service.js').createWorkspaceSessionService>,
      'merge' | 'markManagedActive'
    > & {
      readonly projection: Pick<
        ReturnType<
          typeof import('./workspace-session-service.js').createWorkspaceSessionService
        >['projection'],
        'sessions' | 'replaceExisting' | 'removeExact'
      >;
    };
    readonly mobileViewport: Readonly<Ref<boolean>>;
    readonly events: Omit<
      EventOptions,
      | 'workspaceTarget'
      | 'selectedSessionId'
      | 'selectedSession'
      | 'conversationNextCursor'
      | 'settleSessionRuns'
      | 'observeManagedSessionActive'
      | 'updateContext'
      | 'syncTurnStatus'
      | 'cacheRun'
      | 'acceptRun'
      | 'openRun'
      | 'markLiveTurn'
      | 'cacheTurn'
      | 'mergeTurns'
      | 'applyConversationSnapshot'
      | 'mergeItem'
      | 'mergeTextDelta'
      | 'receivePerformance'
      | 'cacheQueue'
      | 'mergeQueue'
      | 'sessions'
      | 'setNodeConnection'
      | 'mergeSessions'
    >;
    readonly ensureDraftSupported: Parameters<
      typeof createWorkbenchComposerController
    >[0]['ensureDraftSupported'];
    readonly queue: Omit<
      QueueOptions,
      'queue' | 'currentSessionQueue' | 'currentSelectionRevision' | 'beginSubmission'
    > & {
      readonly currentWorkspaceRevision: () => number;
    };
  } & (
    | {
        readonly opening: PaneOpeningPorts;
        readonly secondary?: never;
        readonly position: Pick<PresentationOptions, 'provisionalSessionId' | 'draftOpen'>;
      }
    | {
        readonly secondary: SecondaryPanePorts;
        readonly opening?: never;
        readonly position?: never;
      }
  )
) {
  const { state } = options;
  const secondaryInitialLoading = ref(false);
  const operationLoading = ref(false);
  const secondaryDraftOpen = ref(false);
  const secondaryProvisionalSession = ref<string>();
  let opening: ReturnType<typeof createWorkspaceSessionPaneOpening> | undefined;
  const paneLoading = computed(
    () => state.conversation.loadingInitial.value || operationLoading.value
  );
  const position =
    options.secondary === undefined
      ? {
          ...options.position,
          loading: paneLoading,
          initialContentLoading: () =>
            opening?.loadingContent.value ?? state.conversation.loadingInitial.value
        }
      : {
          provisionalSessionId: secondaryProvisionalSession,
          draftOpen: secondaryDraftOpen,
          loading: paneLoading,
          initialContentLoading: () => secondaryInitialLoading.value
        };
  function stopWatch(): void {
    const coordinator = options.watchConnection.coordinator();
    if (options.secondary === undefined) coordinator?.stopSession();
    else coordinator?.stopSecondarySession();
  }
  async function startWatch(sessionId: string): Promise<boolean> {
    const coordinator = options.watchConnection.coordinator();
    if (coordinator === undefined) return false;
    await (options.secondary === undefined
      ? coordinator.beginSession(sessionId)
      : coordinator.beginSecondarySession(sessionId));
    return true;
  }
  function watchVisible(): boolean {
    return (
      (options.secondary === undefined
        ? options.view.value === 'nodes'
        : options.secondary.visible.value) &&
      (typeof document === 'undefined' || document.visibilityState === 'visible')
    );
  }
  function restoreVisibleWatch(): void {
    const target = options.secondary?.target.value;
    if (target?.kind !== 'session' || !watchVisible() || position.draftOpen.value) return;
    void Promise.resolve(
      options.watchConnection.coordinator()?.restartSecondarySession(target.sessionId)
    ).catch(() => undefined);
  }
  const sessions = options.discovery.projection.sessions;
  const environment = {
    connected: options.watchConnection.connected,
    nodes: options.capabilities.nodes,
    nodeManifest: options.capabilities.manifest,
    manifestLoading: options.capabilities.manifestLoading,
    skillsLoading: options.skills.loading,
    skillsFailed: options.skills.failed,
    promptsLoading: options.prompts.loading,
    promptsFailed: options.prompts.failed,
    runnerProfilesLoading: options.profiles.loading,
    runnerProfilesFailed: options.profiles.failed,
    shouldDisplayItem: displayConversationItem,
    formatTokenCount: tokenCountLabel,
    formatPercentage: contextPercentageLabel
  };
  const presentationOptions = { ...environment, ...position, sessions };
  const status = { ...environment, initialContentLoading: position.initialContentLoading };
  function acceptSecondarySession(
    nodeId: string,
    workspaceId: string,
    previousId: string,
    session: Session
  ): void {
    const ports = options.secondary;
    const target = ports?.target.value;
    if (
      ports === undefined ||
      target?.kind !== 'session' ||
      target.nodeId !== nodeId ||
      target.workspaceId !== workspaceId ||
      target.sessionId !== previousId ||
      session.workspaceId !== workspaceId
    )
      return;
    const existing = sessions.value.some(
      (item) => item.id === previousId && item.workspaceId === workspaceId
    );
    if (previousId !== session.id) {
      if (!existing) options.identity.transfer(nodeId, workspaceId, previousId, session.id);
      if (!ports.replaceAsideSession(target, session.id)) return;
    }
    state.acceptResolvedSession(nodeId, session);
    if (existing) options.identity.replace(nodeId, workspaceId, previousId, session);
  }
  function replaceSecondarySession(previousId: string, session: Session): void {
    const target = options.secondary?.target.value;
    if (target?.kind === 'session')
      acceptSecondarySession(target.nodeId, target.workspaceId, previousId, session);
  }
  function cachedTarget(sessionId: string): { nodeId: string; workspaceId: string } | undefined {
    const target = state.workspaceTarget.value;
    if (target === undefined) return undefined;
    if (options.secondary !== undefined)
      return state.sessionId.value === sessionId ? target : undefined;
    const session = sessions.value.find((item) => item.id === sessionId);
    return session === undefined
      ? undefined
      : { nodeId: target.nodeId, workspaceId: session.workspaceId };
  }
  const configuration = state.createConfiguration({
    sessions,
    profiles: options.profiles.profiles,
    effortLabel: effortPresentation,
    provisionalSessionId: presentationOptions.provisionalSessionId
  });
  const runner = state.createRunnerInteraction({
    skills: options.skills.skills,
    quickPrompts: options.prompts.prompts,
    selectedSession: configuration.selectedSession,
    profile: configuration.profile,
    commandAvailable: (command) => presentation.canExecuteRunnerCommand(command)
  });
  function prepareDraft(): void {
    state.prepareDraft();
    runner.reset();
  }
  const currentSessionQueue = state.projectQueue(state.queueProjection.queue);
  const presentation = state.createPresentation({
    ...presentationOptions,
    selectedSession: configuration.selectedSession,
    composerProfile: configuration.profile,
    composerModels: configuration.models,
    composerAccessOptions: configuration.accessOptions,
    currentSessionQueue
  });
  const { currentWorkspaceRevision, ...queueOptions } = options.queue;
  const common = {
    notice: queueOptions.notice,
    request: queueOptions.request,
    errorMessage: queueOptions.errorMessage,
    beginSubmission: state.submission.begin
  };
  const images = createConversationImageService(
    computed(() => state.workspaceTarget.value?.nodeId),
    {
      fileAttachments: {
        target: computed(() => {
          const target = state.workspaceTarget.value;
          return target === undefined
            ? undefined
            : JSON.stringify([target.nodeId, target.workspaceId, state.sessionId.value]);
        }),
        revalidate: (file) =>
          options.files.attachments(state.workspaceTarget.value!).revalidate(file),
        sourceUrl: (file, revision) =>
          options.files.attachments(state.workspaceTarget.value!).sourceUrl(file, revision),
        onError: (error, path) => showMessage(filePreviewErrorMessage(error, path), 'error', error)
      }
    }
  );
  watchRef(state.conversation.turns, (turns) => images.retain(turns), { immediate: true });
  if (getCurrentScope() !== undefined) onScopeDispose(images.dispose);
  const attachmentInput = createComposerAttachmentInputService({
    canAcceptFiles: () => true,
    addFiles: state.attachments.add,
    rejectDirectory: () =>
      common.notice(
        translate(
          'generated.workbenchNewSessionController.foldersCannotBeAttachedCompressTheFolder'
        ),
        'warning'
      ),
    setDragging: (dragging) => {
      state.draggingAttachments.value = dragging;
    }
  });
  const queueActions = state.createQueueActions({
    ...queueOptions,
    queue: state.queueProjection.queue,
    currentSessionQueue,
    currentSelectionRevision: () =>
      state.conversation.currentDetailRequest() + currentWorkspaceRevision(),
    beginSubmission: state.submission.begin
  });
  const composer = createWorkbenchComposerController({
    workspaceTarget: state.workspaceTarget,
    configurationAvailable: () => !presentation.sessionControlsBusy.value,
    selectedSession: configuration.selectedSession,
    sessions: sessions,
    replaceSessionProjection: options.discovery.projection.replaceExisting,
    profiles: options.profiles.profiles,
    draftOpen: presentationOptions.draftOpen,
    loading: presentationOptions.loading,
    runner: configuration.runner,
    modelId: configuration.modelId,
    effort: configuration.effort,
    access: configuration.access,
    setModel: configuration.selectModel,
    setEffort: configuration.selectEffort,
    setAccess: configuration.selectAccess,
    clearModelEffortSelection: configuration.clearModelEffortSelection,
    codexFastEnabled: runner.codexFastEnabled,
    profileService: options.profiles,
    normalize: configuration.normalize,
    apply: configuration.apply,
    ensureDraftSupported: options.ensureDraftSupported,
    clearRunnerCommand: runner.clearCommand,
    request: common.request,
    notice: common.notice,
    errorMessage: common.errorMessage,
    sessionPathId: options.sessionPathId
  });
  const runnerOptions = computed(() =>
    options.profiles.profiles.value
      .filter((profile) => profile.capabilities.includes('turn.start'))
      .map((profile) => ({ value: profile.runner, label: runnerLabel(profile.runner) }))
  );
  function selectEffort(value: string): void {
    if (!presentation.composerConfigurationDisabled.value)
      composer.selectEffort(value, configuration.efforts.value);
  }
  function selectModel(value: string): void {
    if (!presentation.composerConfigurationDisabled.value)
      composer.selectModel(value, configuration.models.value);
  }
  function selectAccess(value: string): void {
    if (!presentation.composerAccessDisabled.value)
      composer.selectAccess(value, configuration.accessOptions.value);
  }
  function selectModelEffort(value: unknown): void {
    composer.selectModelEffort(value, selectEffort, selectModel);
  }
  const performance = state.createPerformance(options.view);
  const userInput = state.createUserInput({
    ...common,
    missingRunError: (error) => errorCode(error) === 'RUN_NOT_FOUND'
  });
  const approvals = state.createApprovals(common);
  const runControl = state.createRunControl({
    ...common,
    activeRun: presentation.activeComposerRun,
    sessionPathId: options.sessionPathId
  });
  const conversationWindow = state.createConversationWindow({
    pageSize: CONVERSATION_SEGMENT_PAGE_SIZE,
    recentSegmentWindowSize: CONVERSATION_RECENT_SEGMENT_LIMIT,
    replaceCached: (sessionId, turns, cursor) => {
      const target = cachedTarget(sessionId);
      if (target !== undefined)
        options.cache.replaceTurns(target.nodeId, target.workspaceId, sessionId, turns, cursor);
    },
    request: common.request,
    sessionPathId: options.sessionPathId,
    notice: common.notice,
    errorMessage: common.errorMessage
  });
  const history = state.createHistoryMutation({
    selectedSession: configuration.selectedSession,
    canRewind: () => presentation.rewindConversationEnabled.value,
    canRollback: () => presentation.rollbackConversationEnabled.value,
    confirmRewind: async (before) => {
      try {
        await ElMessageBox.confirm(
          translate(
            before
              ? 'generated.workbenchPageController.createANewSessionBranchBeforeThis'
              : 'generated.workbenchPageController.createANewSessionBranchThatRetains'
          ),
          translate('generated.workbenchPageController.createSessionBranch'),
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
    request: common.request,
    sessionPathId: options.sessionPathId,
    onDraftFilled: options.history.onDraftFilled,
    replaceSession:
      options.secondary === undefined ? options.history.replaceSession! : replaceSecondarySession,
    openSession: options.history.openSession,
    invalidateDetail: (nodeId, session) =>
      options.cache.invalidateDetail(nodeId, session.workspaceId, session.id),
    clearHistory: (sessionId) => {
      state.conversation.projection.clearSession(
        sessionId,
        state.run.runs.value.map((run) => run.id)
      );
      state.conversation.projection.restoreWindow([], null);
      state.run.replaceRuns([]);
      stopWatch();
    }
  });
  watchRef(
    history.pending,
    (pending) => {
      operationLoading.value = pending;
    },
    { flush: 'sync' }
  );
  async function rewindConversation(turn: ConversationTurn, item: ConversationItem): Promise<void> {
    const result = await history.rewind(turn, item);
    if (result.status === 'APPLIED')
      showMessage(translate('generated.workbenchPageController.sessionBranchCreated'), 'success');
    else if (result.status === 'FAILED')
      showMessage(
        translate(
          result.phase === 'REQUEST'
            ? 'generated.workbenchPageController.unableToCreateSessionBranch'
            : 'generated.workbenchPageController.sessionBranchCreatedButLoadFailed',
          { value0: common.errorMessage(result.error) }
        ),
        'error',
        result.error
      );
  }
  async function rollbackConversation(
    turn: ConversationTurn,
    item: ConversationItem
  ): Promise<void> {
    const result = await history.rollback(turn, item);
    if (result.status === 'FAILED')
      showMessage(
        translate(
          result.phase === 'REQUEST'
            ? 'generated.workbenchPageController.unableToRollbackConversation'
            : 'generated.workbenchPageController.rollbackCompletedButLoadFailed',
          { value0: common.errorMessage(result.error) }
        ),
        'error',
        result.error
      );
  }
  const channel = state.createRunnerChannel({
    selectedSession: configuration.selectedSession,
    loading: presentationOptions.loading,
    notice: common.notice,
    request: common.request,
    sessionPathId: options.sessionPathId,
    errorMessage: common.errorMessage
  });
  const realtime = state.createRealtime({
    syncTurnStatus: state.conversation.projection.syncRunStatus,
    refreshChannelToken: channel.refreshClaudeChannelToken,
    syncCachedRunStatus: (sessionId, runId, status) => {
      const target = cachedTarget(sessionId);
      if (target !== undefined)
        options.cache.syncRunStatus(target.nodeId, target.workspaceId, sessionId, runId, status);
    }
  });
  const events = createWorkbenchEventProjectionService({
    ...options.events,
    setNodeConnection: options.capabilities.setNodeConnection,
    cacheQueue: options.cache.cacheQueue,
    mergeQueue: state.queueProjection.merge,
    sessions: sessions,
    workspaceTarget: state.workspaceTarget,
    selectedSessionId: state.sessionId,
    selectedSession: configuration.selectedSession,
    conversationNextCursor: state.conversation.nextCursor,
    mergeSessions: (incoming) => {
      const nodeId = state.workspaceTarget.value?.nodeId;
      if (nodeId !== undefined)
        for (const session of incoming) state.acceptResolvedSession(nodeId, session);
      const projected =
        options.secondary === undefined
          ? incoming
          : incoming.filter((session) =>
              sessions.value.some(
                (candidate) =>
                  candidate.id === session.id && candidate.workspaceId === session.workspaceId
              )
            );
      if (projected.length > 0) options.discovery.merge(projected);
    },
    settleSessionRuns: state.run.settleSessionRuns,
    observeManagedSessionActive: state.run.observeManagedSessionActive,
    updateContext: (sessionId, value) => {
      const target = state.workspaceTarget.value;
      if (target !== undefined)
        options.cache.updateContext(
          target.nodeId,
          target.workspaceId,
          sessionId,
          value as SessionContextUsage | null
        );
      if (sessionId === state.sessionId.value)
        state.conversation.contextUsage.value = value as SessionContextUsage | null;
    },
    syncTurnStatus: realtime.syncConversationTurnStatus,
    cacheRun: (run) => {
      const target = state.workspaceTarget.value;
      if (target !== undefined)
        options.cache.cacheRun(target.nodeId, run.workspaceId ?? target.workspaceId, run);
    },
    acceptRun: state.run.acceptRun,
    openRun: realtime.openRun,
    markLiveTurn: state.conversation.projection.markLive,
    cacheTurn: (turn) => {
      const target = state.workspaceTarget.value;
      if (target !== undefined) options.cache.cacheTurn(target.nodeId, target.workspaceId, turn);
    },
    mergeTurns: state.conversation.projection.mergeLatest,
    applyConversationSnapshot: conversationWindow.applySnapshot,
    mergeItem: (runId, payload, sequence, createdAt) => {
      const merged = state.conversation.projection.mergeItem(runId, payload, sequence, createdAt);
      if (merged && isCompletedContextCompaction(payload)) {
        const context = contextUsageAfterCompaction(payload, state.conversation.contextUsage.value);
        state.conversation.contextUsage.value = context;
        const target = state.workspaceTarget.value;
        const sessionId = state.sessionId.value;
        if (target !== undefined && sessionId !== undefined)
          options.cache.updateContext(target.nodeId, target.workspaceId, sessionId, context);
      }
      return merged;
    },
    mergeTextDelta: state.conversation.projection.mergeTextDelta,
    receivePerformance: performance.receive
  });
  const watch = state.createWatch({
    ...options.watch,
    applyEvent: events.apply,
    request: common.request,
    sessionPathId: options.sessionPathId,
    openRun: realtime.openRun,
    applySnapshot: conversationWindow.applySnapshot
  });
  function createWatchGate() {
    const watchTarget = computed(() => {
      const target = state.workspaceTarget.value;
      const sessionId = state.sessionId.value;
      return target === undefined || sessionId === undefined ? undefined : { ...target, sessionId };
    });
    return createWorkspaceSessionPaneWatchGate({
      target: () => watchTarget.value,
      revision: state.conversation.currentDetailRequest,
      visible: watchVisible,
      waitReady: options.watchConnection.waitReady,
      begin: async (sessionId) =>
        (await startWatch(sessionId)) && watch.hasInitialSessionSnapshot(sessionId)
    });
  }
  function createOpening(ports: PaneOpeningPorts) {
    const loader = state.createLoader({
      request: common.request,
      sessionPathId: options.sessionPathId,
      applyComposerConfiguration: composer.applyConfiguration,
      replaceSession:
        options.secondary === undefined
          ? options.messaging.replaceSession!
          : replaceSecondarySession,
      markActive: ports.markActive,
      openRun: realtime.openRun,
      canWatch: watch.canWatchSessionHistory,
      beginWatch: createWatchGate(),
      applySnapshot: conversationWindow.applySnapshot,
      mergeTurns: state.conversation.projection.mergeLatest,
      saveCurrent: ports.saveCurrent
    });
    const renderer = createWorkspaceSessionPaneRenderLifecycle({
      content: { hasContent: state.hasContent, openRun: realtime.openRun },
      loading: state.conversation.loadingInitial,
      failed: state.conversation.initialLoadFailed,
      failureCause: state.conversation.initialFailureCause,
      positioning: state.scroll.positioningInitialConversation,
      beginInitialRender: state.conversation.beginInitialRender,
      scrollLatest: () => {
        const revision = state.conversation.currentDetailRequest();
        return state.scroll.scrollToLatestAfterLayout(
          () => state.conversation.currentDetailRequest() === revision
        );
      }
    });
    return createWorkspaceSessionPaneOpening({
      workspaceTarget: state.workspaceTarget,
      sessionId: state.sessionId,
      currentRequest: state.conversation.currentDetailRequest,
      nextRequest: state.conversation.nextDetailRequest,
      loading: state.conversation.loadingInitial,
      failed: state.conversation.initialLoadFailed,
      hasInitialSnapshot: watch.hasInitialSessionSnapshot,
      prepareSession: (nodeId, workspaceId, sessionId, session) =>
        state.prepareSession(
          workspaceId === undefined ? undefined : { nodeId, workspaceId, sessionId },
          options.cache,
          state.queueProjection.restore,
          () => composer.applyConfiguration(session, false)
        ),
      resetInteraction: () => {
        runner.composerMode.value = 'message';
        runner.selectedCommand.value = undefined;
        runner.commandPickerOpen.value = false;
      },
      loader,
      renderer,
      ports
    });
  }
  opening = options.opening === undefined ? undefined : createOpening(options.opening);
  function createSecondary(ports: SecondaryPanePorts) {
    const save = () =>
      state.saveCachedSession(
        configuration.selectedSession.value,
        state.queueProjection.queue.value,
        options.cache,
        ports.maxDetails
      );
    const loader = state.createLoader({
      request: common.request,
      sessionPathId: options.sessionPathId,
      replaceSession: replaceSecondarySession,
      applyComposerConfiguration: composer.applyConfiguration,
      markActive: (session) => {
        const target = ports.target.value;
        if (target !== undefined)
          state.acceptResolvedSession(target.nodeId, { ...session, activity: 'MANAGED_ACTIVE' });
      },
      openRun: realtime.openRun,
      canWatch: watch.canWatchSessionHistory,
      beginWatch: createWatchGate(),
      applySnapshot: conversationWindow.applySnapshot,
      mergeTurns: state.conversation.projection.mergeLatest,
      saveCurrent: save
    });
    const lifecycle = createWorkspaceSessionPaneLifecycle({
      target: ports.target,
      visible: ports.visible,
      loading: state.conversation.loadingInitial,
      loadingContent: secondaryInitialLoading,
      failed: state.conversation.initialLoadFailed,
      failureCause: state.conversation.initialFailureCause,
      currentRequest: state.conversation.currentDetailRequest,
      loader,
      restore: (target) =>
        state.restoreCachedSession(target, options.cache, state.queueProjection.restore),
      save,
      cancel: () => {
        state.cancelRead();
        state.conversation.cancelInitialRender();
      },
      stopWatch,
      beginInitialRender: state.conversation.beginInitialRender,
      scrollElement: () => state.scroll.element.value,
      scrollLatest: (isCurrent) => state.scroll.scrollToLatestAfterLayout(isCurrent),
      markRead: ports.markRead
    });
    return { ...lifecycle, save };
  }
  const secondary =
    options.secondary === undefined ? undefined : createSecondary(options.secondary);
  const commands = createWorkbenchRunnerCommandService({
    workspaceTarget: state.workspaceTarget,
    selectedSessionId: state.sessionId,
    currentSelectionRevision: state.conversation.currentDetailRequest,
    acceptRun: state.run.acceptRun,
    captureCacheTarget: options.cache.captureCommandTarget,
    request: common.request,
    sessionPathId: options.sessionPathId,
    acceptSession: (nodeId, workspaceId, previousId, session, selected) => {
      if (options.secondary !== undefined && selected)
        acceptSecondarySession(nodeId, workspaceId, previousId, session);
      else if (
        options.secondary === undefined &&
        state.workspaceTarget.value?.nodeId === nodeId &&
        state.workspaceTarget.value.workspaceId === workspaceId &&
        (state.sessionId.value !== previousId || selected)
      )
        options.identity.replace(nodeId, workspaceId, previousId, session);
      else options.identity.transfer(nodeId, workspaceId, previousId, session.id);
    },
    configure: composer.applyConfiguration,
    resetHistory: async (nodeId, session) => {
      options.cache.invalidateDetail(nodeId, session.workspaceId, session.id);
      state.conversation.projection.clearSession(
        session.id,
        state.run.runs.value.map((run) => run.id)
      );
      state.conversation.projection.restoreWindow([], null);
      state.run.replaceRuns([]);
      stopWatch();
      await options.commands.reopen(session.id);
    },
    openRun: realtime.openRun,
    notifyGoalAlreadyActive: () => showMessage(translate('goal.alreadyActive'), 'info')
  });
  const executeCommand = (
    session: Session,
    command: Parameters<typeof runner.selectCommand>[0],
    input: string
  ) => commands.execute(session, command.id, input, command.interaction === 'DESTRUCTIVE_ACTION');
  const messaging = state.createMessaging({
    removeSessionExact: options.discovery.projection.removeExact,
    ...options.messaging,
    sessions: sessions,
    migrateSessionCache: (nodeId, workspaceId, previousId, nextId, session) => {
      options.identity.transfer(nodeId, workspaceId, previousId, nextId);
      options.cache.migrateSession(nodeId, workspaceId, previousId, nextId, session);
    },
    cacheRun: options.cache.cacheRun,
    replaceSession:
      options.secondary === undefined ? options.messaging.replaceSession! : replaceSecondarySession,
    provisionalSessionId: computed(() => {
      const value = presentationOptions.provisionalSessionId.value;
      return value?.startsWith('draft:') ? value : undefined;
    }),
    selectedSession: configuration.selectedSession,
    composerOpen: presentation.composerSessionOpen,
    composerBusy: presentation.composerSessionBusy,
    commandAvailable: presentation.canExecuteRunnerCommand,
    submissionAvailable: () => !presentationOptions.loading.value,
    draftOpen: presentationOptions.draftOpen,
    selectedCommand: runner.selectedCommand,
    commandPickerOpen: runner.commandPickerOpen,
    deferredCommands: runner.deferredDraftCommands,
    fastEnabled: runner.codexFastEnabled,
    notice: common.notice,
    request: common.request,
    stageDraftCommand: (command, input) => {
      const result = runner.prepareDraftCommand(command, input);
      if (result.goalAlreadyActive) showMessage(translate('goal.alreadyActive'), 'info');
      else if (result.access !== undefined) configuration.selectAccess(result.access);
    },
    executeCommand,
    sessionPathId: options.sessionPathId,
    openRun: realtime.openRun,
    errorMessage: common.errorMessage
  });
  const sendMessage = (
    intent?: 'REPLACE_CURRENT',
    preserveDraft = false,
    contentOverride?: string
  ) => messaging.send(intent, preserveDraft, contentOverride);
  const continuationFor = (item: Parameters<typeof findPlanContinuation>[0]['item']) =>
    findPlanContinuation({
      item,
      turns: presentation.displayedConversationTurns.value,
      commandStates: configuration.selectedSession.value?.commandStates,
      steering: presentation.mustSteerCurrentTurn.value,
      canStartTurn: presentation.canStartTurn.value
    });
  const activePlanContinuation = computed(() =>
    presentation.mustSteerCurrentTurn.value
      ? undefined
      : configuration.selectedSession.value?.commandStates
          ?.filter(
            (item) => item.active && item.continuation !== null && item.continuation !== undefined
          )
          .map(localizedRunnerCommandState)[0]
  );
  const activeGoal = computed(() =>
    configuration.selectedSession.value?.commandStates?.find(
      (item) => item.commandId === 'goal' && item.active && item.goal?.status === 'active'
    )
  );
  const plan = state.createPlan({
    selectedSession: configuration.selectedSession,
    selectedCommand: runner.selectedCommand,
    commandPickerOpen: runner.commandPickerOpen,
    notice: common.notice,
    continuationFor,
    execute: commands.execute,
    send: sendMessage,
    errorMessage: common.errorMessage
  });
  const context = state.createContextCommands({
    selectedSession: configuration.selectedSession,
    compactCommand: presentation.compactCommand,
    canCompact: presentation.canCompactContext,
    contextUsageLabel: presentation.contextUsageLabel,
    notice: common.notice,
    request: common.request,
    execute: executeCommand,
    errorMessage: common.errorMessage
  });
  const filesReady = computed(
    () =>
      presentation.nodeReady.value &&
      presentationOptions.nodeManifest.value?.files?.available === true
  );
  const references = state.createReferences({
    request: common.request,
    ready: () => filesReady.value,
    sessionsReady: () => presentation.nodeReady.value
  });
  const selectedSessionId = computed(
    () => state.sessionId.value ?? presentationOptions.provisionalSessionId.value
  );
  const automaticCompletion = computed(() =>
    Boolean(
      options.completion.automaticSupported() &&
      state.sessionId.value &&
      !state.conversation.loadingInitial.value &&
      !state.conversation.initialLoadFailed.value
    )
  );
  const completion = options.completion.client.bind({
    automaticKey: () =>
      automaticCompletion.value
        ? promptCompletionAutomaticKey(state.conversation.turns.value)
        : undefined,
    automaticTerminalKey: () =>
      automaticCompletion.value
        ? promptCompletionAutomaticTerminalKey(state.conversation.turns.value)
        : undefined,
    readContextRevision: () => {
      const turn = state.conversation.turns.value.at(-1);
      return JSON.stringify([
        turn?.status,
        turn?.items.length,
        turn?.items.slice(-32).map((item) => [item.id, item.status, item.completedAt]),
        state.queueProjection.queue.value.version,
        configuration.selectedSession.value?.commandStates?.map((command) => [
          command.commandId,
          command.active,
          command.detail,
          command.goal?.id,
          command.goal?.revision,
          command.goal?.status
        ]),
        options.completion.attention()
      ]);
    },
    attention: options.completion.attention,
    enabled: options.completion.enabled,
    target: () => {
      const target = state.workspaceTarget.value;
      return target === undefined
        ? undefined
        : {
            nodeId: target.nodeId,
            target: { kind: 'WORKSPACE', workspaceId: target.workspaceId },
            runner: configuration.runner.value,
            sessionId: state.sessionId.value ?? null
          };
    }
  });
  const conversationRuns = computed(() =>
    state.run.runs.value.filter((run) => run.sessionId === selectedSessionId.value)
  );
  const conversationSyncPending = computed(() => {
    const session = configuration.selectedSession.value;
    return (
      session !== undefined &&
      !state.conversation.initialLoadFailed.value &&
      watch.canWatchSessionHistory(session) &&
      !watch.hasInitialSessionSnapshot(session.id)
    );
  });
  const submitting = computed(
    () =>
      state.submission.pending.value &&
      state.submission.context.value === sessionSubmissionContext(selectedSessionId.value)
  );
  const canInterrupt = computed(() => presentation.canInterruptTurn.value && !submitting.value);
  const stageSkill = (skill: Parameters<typeof state.skillTokens.select>[0], cursor: number) => {
    state.skillTokens.select(skill);
    state.focusInput(cursor);
  };
  const interactions = state.createInteractions({
    mobileViewport: options.mobileViewport,
    runnerProfilesLoading: options.profiles.loading,
    runnerProfilesFailed: options.profiles.failed,
    hasRunnerProfile: options.profiles.has,
    ensureComposerSkills: options.skills.ensureFresh,
    ensureQuickPrompts: () => void options.prompts.refresh(),
    workspaceTarget: state.workspaceTarget,
    filesReady,
    canInterruptTurn: canInterrupt,
    commandPickerOpen: runner.commandPickerOpen,
    fileReferences: references,
    runnerInteractions: runner,
    selectSkill: stageSkill,
    stopActiveRun: runControl.stopActiveRun,
    sendMessage: (replaceCurrent, preserveDraft, contentOverride) =>
      void sendMessage(
        replaceCurrent ? 'REPLACE_CURRENT' : undefined,
        preserveDraft,
        contentOverride
      ),
    loadRunnerProfiles: composer.loadProfiles,
    loadOlderConversationTurns: conversationWindow.paging.loadOlderConversationTurns,
    canLoadOlder: () => !conversationWindow.paging.olderHistoryError.value
  });
  function selectCommand(command: Parameters<typeof runner.selectCommand>[0]): void {
    runner.selectCommand(command, (preserve) => void sendMessage(undefined, preserve));
  }
  function selectSkill(skill: Parameters<typeof runner.selectSkill>[0]): void {
    runner.selectSkill(skill, stageSkill);
  }
  function closeCommandState(item: Parameters<typeof runner.closeCommandState>[0]): void {
    runner.closeCommandState(
      item,
      (command, input) => void messaging.send(undefined, true, undefined, { command, input })
    );
  }
  async function editGoal(objective: string): Promise<void> {
    const session = configuration.selectedSession.value;
    if (session !== undefined && objective.trim().length > 0)
      await commands.execute(session, 'goal', `/goal ${objective.trim()}`);
  }
  async function clearGoal(): Promise<void> {
    const session = configuration.selectedSession.value;
    if (session !== undefined) await commands.execute(session, 'goal', '/goal --clear');
  }
  function openFileChange(entry: FileChangeEntry): void {
    const target = state.workspaceTarget.value;
    const sessionId = state.sessionId.value;
    if (target === undefined || sessionId === undefined || !presentation.nodeReady.value) return;
    const intent = toolChangeOpenIntent(entry, { ...target, sessionId, scope: 'SESSION' });
    if (intent !== undefined) options.files.openChange(intent);
  }
  function openAgentFile(
    path: string,
    line?: number,
    column?: number,
    external = false,
    attachment?: ComposerAttachmentFile
  ): void {
    if (!external && attachment?.mime.startsWith('image/')) {
      void images.openFileAttachment(attachment);
      return;
    }
    options.files.openFile(path, line, column, external);
  }
  const controller = {
    state,
    opening,
    secondary,
    configuration,
    runner,
    presentation,
    references,
    interactions,
    attachmentInput,
    images,
    completion,
    events,
    submitting,
    canInterrupt,
    filesReady,
    status,
    copyMessage: (text: string, onSuccess: () => void) =>
      copyConversationMessage(text, onSuccess, common.notice),
    openFileChange,
    openAgentFile,
    terminalReady: computed(
      () =>
        presentation.nodeReady.value &&
        presentationOptions.nodeManifest.value?.terminal?.available === true &&
        presentationOptions.nodeManifest.value.terminal.supportsReplay === true
    ),
    effortLabel: effortPresentation,
    request: common.request,
    loading: presentationOptions.loading,
    draftOpen: presentationOptions.draftOpen,
    nodeManifest: presentationOptions.nodeManifest,
    runnerProfilesLoading: presentationOptions.runnerProfilesLoading,
    runnerProfilesFailed: presentationOptions.runnerProfilesFailed,
    mobileViewport: options.mobileViewport,
    selectedWorkspace: options.messaging.selectedWorkspace,
    selectedSessionId,
    conversationRuns,
    conversationSyncPending,
    composer,
    runnerOptions,
    selectEffort,
    selectModel,
    selectAccess,
    selectModelEffort,
    currentSessionQueue,
    queueActions,
    performance,
    userInput,
    approvals,
    runControl,
    conversationWindow,
    history,
    rewindConversation,
    rollbackConversation,
    channel,
    realtime,
    watch,
    commands,
    messaging,
    sendMessage,
    plan,
    context,
    activePlanContinuation,
    activeGoal,
    selectCommand,
    selectSkill,
    selectQuickPrompt: interactions.selectQuickPrompt,
    closeCommandState,
    editGoal,
    clearGoal
  };
  const view = {
    imageResourceUrl: computed(() => {
      const target = state.workspaceTarget.value;
      if (target === undefined) return undefined;
      const access = options.files.attachments(target);
      return (path: string) => access.sourceUrl({ path });
    }),
    state: {
      attachments: state.attachments,
      conversation: state.conversation,
      draft: state.draft,
      draggingAttachments: state.draggingAttachments,
      queue: state.queue,
      registerShortcuts: state.registerShortcuts,
      scroll: state.scroll,
      setInputFocus: state.setInputFocus,
      setRangeEditor: state.setRangeEditor,
      skillTokens: state.skillTokens,
      workspaceTarget: state.workspaceTarget
    },
    activeGoal: controller.activeGoal,
    activePlanContinuation: controller.activePlanContinuation,
    approvals: controller.approvals,
    attachmentInput: controller.attachmentInput,
    canInterrupt: controller.canInterrupt,
    clearGoal: controller.clearGoal,
    closeCommandState: controller.closeCommandState,
    completion: controller.completion,
    composer: controller.composer,
    configuration: controller.configuration,
    context: controller.context,
    conversationRuns: controller.conversationRuns,
    conversationSyncPending: controller.conversationSyncPending,
    conversationWindow: controller.conversationWindow,
    copyMessage: controller.copyMessage,
    currentSessionQueue: controller.currentSessionQueue,
    draftOpen: controller.draftOpen,
    editGoal: controller.editGoal,
    effortLabel: controller.effortLabel,
    filesReady: controller.filesReady,
    images: controller.images,
    interactions: controller.interactions,
    loading: controller.loading,
    mobileViewport: controller.mobileViewport,
    nodeManifest: controller.nodeManifest,
    openAgentFile: controller.openAgentFile,
    openFileChange: controller.openFileChange,
    performance: controller.performance,
    plan: controller.plan,
    presentation: controller.presentation,
    queueActions: controller.queueActions,
    references: controller.references,
    rewindConversation: controller.rewindConversation,
    rollbackConversation: controller.rollbackConversation,
    runControl: controller.runControl,
    runner: controller.runner,
    runnerOptions: controller.runnerOptions,
    runnerProfilesFailed: controller.runnerProfilesFailed,
    runnerProfilesLoading: controller.runnerProfilesLoading,
    selectAccess: controller.selectAccess,
    selectCommand: controller.selectCommand,
    selectModelEffort: controller.selectModelEffort,
    selectQuickPrompt: controller.selectQuickPrompt,
    selectSkill: controller.selectSkill,
    selectedSessionId: controller.selectedSessionId,
    selectedWorkspace: controller.selectedWorkspace,
    sendMessage: controller.sendMessage,
    status: controller.status,
    submitting: controller.submitting,
    terminalReady: controller.terminalReady,
    userInput: controller.userInput
  };
  return {
    ...controller,
    view,
    prepareDraft,
    restoreVisibleWatch,
    focusDraft: () => state.focusInput(state.draft.input.value.length)
  };
}

export type WorkspaceSessionPaneView = ReturnType<
  typeof createWorkspaceSessionPaneController
>['view'];

export function createWorkspaceSessionPaneOpening(input: {
  readonly workspaceTarget: Readonly<
    Ref<import('../model/workbench.js').WorkspaceTarget | undefined>
  >;
  readonly sessionId: Readonly<Ref<string | undefined>>;
  readonly currentRequest: () => number;
  readonly nextRequest: () => number;
  readonly loading: Readonly<Ref<boolean>>;
  readonly failed: Readonly<Ref<boolean>>;
  readonly hasInitialSnapshot: (sessionId: string) => boolean;
  readonly prepareSession: (
    nodeId: string,
    workspaceId: string | undefined,
    sessionId: string,
    session: Session | undefined
  ) => { readonly restored: boolean; readonly activeRunId: string | undefined };
  readonly loader: ReturnType<PaneState['createLoader']>;
  readonly renderer: ReturnType<typeof createWorkspaceSessionPaneRenderLifecycle>;
  readonly resetInteraction: () => void;
  readonly ports: Pick<
    PaneOpeningPorts,
    'navigate' | 'setSession' | 'draftOpen' | 'sessions' | 'closeMobile' | 'markRead'
  >;
}) {
  const scope = getCurrentScope();
  const { loader, renderer, ports } = input;
  let opening:
    | {
        requestId: number;
        preparing: boolean;
        readonly nodeId: string;
        readonly workspaceId: string | undefined;
        readonly sessionId: string;
        session?: Session;
        onSessionResolved?: (session: Session) => void;
        markRead: boolean;
      }
    | undefined;
  const current = (requestId: number, nodeId: string, sessionId: string, workspaceId?: string) =>
    (scope === undefined || scope.active) &&
    requestId === input.currentRequest() &&
    input.workspaceTarget.value?.nodeId === nodeId &&
    (workspaceId === undefined || input.workspaceTarget.value.workspaceId === workspaceId) &&
    input.sessionId.value === sessionId;
  async function open(
    sessionId: string,
    openOptions: WorkspacePaneOpenOptions = {}
  ): Promise<void> {
    const nodeId = input.workspaceTarget.value?.nodeId;
    const workspaceId = input.workspaceTarget.value?.workspaceId;
    if (nodeId === undefined) return;
    const operation: NonNullable<typeof opening> = {
      requestId: input.nextRequest(),
      preparing: true,
      nodeId,
      workspaceId,
      sessionId,
      markRead: false
    };
    opening = operation;
    renderer.begin();
    const { switching, session } = ports.navigate(sessionId, nodeId, openOptions);
    let restored = false;
    let activeRunId: string | undefined;
    if (switching) {
      input.resetInteraction();
      ports.setSession(undefined);
      const prepared = input.prepareSession(nodeId, workspaceId, sessionId, session);
      restored = prepared.restored;
      activeRunId = prepared.activeRunId;
    }
    ports.setSession(sessionId);
    operation.preparing = false;
    if (opening !== operation) return;
    if (input.workspaceTarget.value?.nodeId !== nodeId || input.sessionId.value !== sessionId) {
      opening = undefined;
      return;
    }
    const requestId = input.currentRequest();
    operation.requestId = requestId;
    const readWorkspaceId = input.workspaceTarget.value.workspaceId;
    await renderer.openRestored({
      loader,
      nodeId,
      workspaceId: readWorkspaceId,
      sessionId,
      requestId,
      switching,
      restored,
      activeRunId,
      deferInitialScroll: openOptions.deferInitialScroll === true,
      throwOnFailure: openOptions.throwOnFailure === true,
      isCurrent: () => current(requestId, nodeId, sessionId, readWorkspaceId),
      onResolved: (resolved) => {
        operation.session = resolved;
        openOptions.onSessionResolved?.(resolved);
        operation.onSessionResolved?.(resolved);
        delete operation.onSessionResolved;
      },
      onSettle: () => {
        if (opening === operation) opening = undefined;
      },
      onLoaded: (resolved) => {
        if (
          readWorkspaceId !== undefined &&
          (openOptions.markReadAfterOpen || operation.markRead) &&
          resolved.workspaceId === workspaceId &&
          current(requestId, nodeId, sessionId, workspaceId)
        )
          void Promise.resolve(ports.markRead(nodeId, workspaceId!, resolved.id)).catch(
            () => undefined
          );
      }
    });
  }
  async function openTab(
    sessionId: string,
    onSessionResolved?: (session: Session) => void
  ): Promise<void> {
    const target = input.workspaceTarget.value;
    if (target === undefined) return;
    if (input.sessionId.value === sessionId && !ports.draftOpen.value) {
      ports.closeMobile();
      if (input.loading.value) {
        if (
          (opening?.preparing === true || opening?.requestId === input.currentRequest()) &&
          opening.nodeId === target.nodeId &&
          opening.workspaceId === target.workspaceId &&
          opening.sessionId === sessionId
        ) {
          if (onSessionResolved !== undefined) {
            if (opening.session !== undefined) onSessionResolved(opening.session);
            else opening.onSessionResolved = onSessionResolved;
          }
          opening.markRead = true;
        }
        return;
      }
      if (!input.failed.value && input.hasInitialSnapshot(sessionId)) {
        const session = ports.sessions.value.find(
          (item) => item.id === sessionId && item.workspaceId === target.workspaceId
        );
        if (session === undefined && onSessionResolved !== undefined) {
          await open(sessionId, { markReadAfterOpen: true, onSessionResolved });
          return;
        }
        if (session !== undefined) onSessionResolved?.(session);
        void Promise.resolve(ports.markRead(target.nodeId, target.workspaceId, sessionId)).catch(
          () => undefined
        );
        return;
      }
    }
    await open(sessionId, {
      markReadAfterOpen: true,
      ...(onSessionResolved === undefined ? {} : { onSessionResolved })
    });
  }
  return { open, openTab, loadingContent: renderer.loadingContent };
}

type PaneControllerPorts = Parameters<typeof createWorkspaceSessionPaneController>[0];

/** Shared application capabilities; position state and collaboration stay inside the Pane. */
export type WorkspaceSessionPaneServices = Pick<
  PaneControllerPorts,
  | 'view'
  | 'cache'
  | 'files'
  | 'capabilities'
  | 'profiles'
  | 'skills'
  | 'prompts'
  | 'discovery'
  | 'mobileViewport'
  | 'ensureDraftSupported'
  | 'identity'
  | 'events'
> & {
  readonly watchConnection: Omit<PaneControllerPorts['watchConnection'], 'coordinator'>;
  readonly completion: {
    readonly client: PromptCompletionClientService;
    readonly enabled: Readonly<Ref<boolean>>;
    readonly ready: Readonly<Ref<boolean>>;
    readonly host: Readonly<Ref<import('../model/workbench.js').NodeSummary | undefined>>;
    readonly attention: () => readonly import('@myagentroam/protocol').PromptCompletionAttention[];
  };
  readonly connectionId: () => string | undefined;
  readonly selectedWorkspace: MessageOptions['selectedWorkspace'];
  readonly workspaceRevision: () => number;
  readonly request: QueueOptions['request'];
  readonly notice: QueueOptions['notice'];
  readonly errorMessage: QueueOptions['errorMessage'];
};

type SessionPaneLocation = {
  readonly visible: Readonly<Ref<boolean>>;
  readonly refresh: () => void;
  readonly open: (sessionId: string, options?: WorkspacePaneOpenOptions) => Promise<void>;
  readonly markRead: PaneOpeningPorts['markRead'];
} & (
  | {
      readonly kind: 'main';
      readonly navigation: () => Pick<
        ReturnType<
          typeof import('./workbench-session-selection-service.js').createWorkbenchSessionSelectionService
        >,
        'prepareTarget' | 'restoreDraftSelection'
      >;
      readonly selection: Pick<
        ReturnType<
          typeof import('./workbench-session-selection-service.js').createWorkbenchSessionSelection
        >,
        'setSession' | 'sessionId' | 'draftOpen'
      >;
      readonly saveCurrent: () => void;
      readonly closeMobile: () => void;
      readonly createDraft: (title: string) => Promise<Session | undefined>;
      readonly beginWatch: MessageOptions['beginSessionWatch'];
      readonly replaceSession: (previousId: string, session: Session) => void;
    }
  | {
      readonly kind: 'aside';
      readonly target: SecondaryPanePorts['target'];
      readonly replaceSession: SecondaryPanePorts['replaceAsideSession'];
    }
);

/** Owns Pane state and location policy; connects services before linking shared Watch actions. */
export function createWorkspaceSessionPane(
  options: Parameters<typeof createWorkspaceSessionPaneState>[0]
) {
  const state = createWorkspaceSessionPaneState(options);
  let coordinator: ReturnType<PaneControllerPorts['watchConnection']['coordinator']>;
  function connect(services: WorkspaceSessionPaneServices, location: SessionPaneLocation) {
    const completion = {
      client: services.completion.client,
      enabled: () =>
        services.completion.enabled.value &&
        services.completion.ready.value &&
        services.completion.host.value?.capabilities.promptCompletion?.apiVersion === 1 &&
        services.completion.host.value?.capabilities.promptCompletion?.contextVersion === 3,
      automaticSupported: () =>
        services.completion.host.value?.capabilities.promptCompletion?.automaticTriggers === true,
      attention: () =>
        services.completion.host.value?.capabilities.promptCompletion?.contextVersion === 3
          ? services.completion.attention()
          : []
    };
    const watch = {
      heartbeatMs: 15_000,
      requestTimeoutMs: 10_000,
      confirmationTimeoutMs: 45_000,
      enabled: () => location.visible.value,
      workbenchConnectionId: services.connectionId,
      refreshSnapshot: location.refresh,
      openSession: location.open
    };
    const queue = {
      currentWorkspaceRevision: services.workspaceRevision,
      request: services.request,
      notice: services.notice,
      errorMessage: services.errorMessage,
      missingQueueItemError: (error: unknown) => errorCode(error) === 'QUEUE_ITEM_INVALID'
    };
    const common = {
      ...services,
      watchConnection: { ...services.watchConnection, coordinator: () => coordinator },
      completion,
      state,
      queue,
      sessionPathId: agentSessionPathId
    };
    if (location.kind === 'main') {
      watchRef(
        location.visible,
        (visible) => {
          if (!visible) {
            coordinator?.stopSession();
            return;
          }
          const sessionId = location.selection.sessionId.value;
          // An opening already owns the next Watch; resuming here could restart the previous
          // session while mobile navigation is closing.
          if (
            services.view.value === 'nodes' &&
            state.workspaceTarget.value !== undefined &&
            !state.conversation.loadingInitial.value &&
            !location.selection.draftOpen.value &&
            sessionId !== undefined &&
            (typeof document === 'undefined' || document.visibilityState === 'visible')
          )
            void Promise.resolve(coordinator?.restartSession(sessionId)).catch(() => undefined);
        },
        { flush: 'sync' }
      );

      return createWorkspaceSessionPaneController({
        ...common,
        opening: {
          navigate: (...args) => location.navigation().prepareTarget(...args),
          setSession: location.selection.setSession,
          sessions: services.discovery.projection.sessions,
          draftOpen: location.selection.draftOpen,
          closeMobile: location.closeMobile,
          saveCurrent: location.saveCurrent,
          markActive: services.discovery.markManagedActive,
          markRead: location.markRead
        },
        position: {
          provisionalSessionId: location.selection.sessionId,
          draftOpen: location.selection.draftOpen
        },
        watch,
        commands: {
          reopen: (id) =>
            location.open(id, { preserveMobileWorkspaceSurface: true, deferInitialScroll: true })
        },
        messaging: {
          selectedWorkspace: services.selectedWorkspace,
          draft: {
            restore: () => location.navigation().restoreDraftSelection(),
            create: location.createDraft
          },
          replaceSession: location.replaceSession,
          temporaryTitle: temporarySessionTitle,
          beginSessionWatch: location.beginWatch
        },
        history: {
          onDraftFilled: (text, operation) => {
            if (operation === 'rollback') location.saveCurrent();
            state.focusInput(text.length);
          },
          replaceSession: location.replaceSession,
          openSession: (id, settings) => location.open(id, { ...settings, throwOnFailure: true })
        }
      });
    }
    return createWorkspaceSessionPaneController({
      ...common,
      secondary: {
        target: location.target,
        visible: location.visible,
        maxDetails: 5,
        markRead: location.markRead,
        replaceAsideSession: location.replaceSession
      },
      watch: { ...watch, position: 'secondary' },
      commands: { reopen: location.open },
      messaging: {
        selectedWorkspace: services.selectedWorkspace,
        temporaryTitle: temporarySessionTitle,
        beginSessionWatch: (id) => {
          void coordinator?.restartSecondarySession(id);
        }
      },
      history: {
        onDraftFilled: (text) => {
          state.draft.persist();
          state.focusInput(text.length);
        },
        openSession: location.open
      }
    });
  }
  return {
    state,
    connect,
    connectWatchCoordinator: (next: NonNullable<typeof coordinator>) => {
      coordinator = next;
    }
  };
}
