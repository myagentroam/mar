import { computed, getCurrentScope, onScopeDispose, watch as watchRef, type Ref } from 'vue';
import { ElMessageBox } from 'element-plus';
import { sessionSubmissionContext } from './workbench-submission-service.js';
import { errorCode } from '../util/api-error.js';
import {
  CONVERSATION_RECENT_SEGMENT_LIMIT,
  CONVERSATION_SEGMENT_PAGE_SIZE
} from '../util/conversation-history.js';
import { runnerLabel } from '../util/workbench-presentation.js';
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
import type { createWorkspaceSessionPaneState } from './workspace-session-pane-state.js';

type PaneState = ReturnType<typeof createWorkspaceSessionPaneState>;
type ConfigurationOptions = Parameters<PaneState['createConfiguration']>[0];
type RunnerOptions = Parameters<PaneState['createRunnerInteraction']>[0];
type ReferenceOptions = Parameters<PaneState['createReferences']>[0];
type PresentationOptions = Parameters<PaneState['createPresentation']>[0];
type InteractionOptions = Parameters<PaneState['createInteractions']>[0];
type QueueOptions = Parameters<PaneState['createQueueActions']>[0];
type WatchOptions = Parameters<PaneState['createWatch']>[0];
type CommandOptions = Parameters<typeof createWorkbenchRunnerCommandService>[0];
type MessageOptions = Parameters<PaneState['createMessaging']>[0];
type HistoryOptions = Parameters<PaneState['createHistoryMutation']>[0];
type EventOptions = Parameters<typeof createWorkbenchEventProjectionService>[0];

/** Compose the target-bound session services once for each visible work surface. */
export function createWorkspaceSessionPaneController(options: {
  readonly state: PaneState;
  readonly view: Readonly<Ref<string>>;
  readonly sessionPathId: (sessionId: string) => string;
  readonly replaceCachedConversation: Parameters<
    PaneState['createConversationWindow']
  >[0]['replaceCached'];
  readonly syncCachedRunStatus: Parameters<PaneState['createRealtime']>[0]['syncCachedRunStatus'];
  readonly watch: Omit<
    WatchOptions,
    'request' | 'sessionPathId' | 'openRun' | 'applySnapshot' | 'applyEvent'
  >;
  readonly commands: Pick<CommandOptions, 'captureCacheTarget' | 'acceptSession'> & {
    readonly invalidateDetail: (nodeId: string, workspaceId: string, sessionId: string) => void;
    readonly stopWatch: () => void;
    readonly reopen: (sessionId: string) => Promise<void>;
  };
  readonly messaging: Pick<
    MessageOptions,
    | 'selectedWorkspace'
    | 'sessions'
    | 'restoreDraft'
    | 'createDraftSession'
    | 'replaceSession'
    | 'temporaryTitle'
    | 'migrateSessionCache'
    | 'cacheRun'
    | 'beginSessionWatch'
  >;
  readonly history: Pick<
    HistoryOptions,
    'onDraftFilled' | 'replaceSession' | 'openSession' | 'invalidateDetail'
  > & {
    readonly stopWatch: () => void;
  };
  readonly completion: {
    readonly client: PromptCompletionClientService;
    readonly enabled: () => boolean;
    readonly automaticSupported: () => boolean;
    readonly attention: () => readonly import('@myagentroam/protocol').PromptCompletionAttention[];
  };
  readonly files: {
    readonly openChange: (intent: NonNullable<ReturnType<typeof toolChangeOpenIntent>>) => void;
    readonly openFile: (path: string, line?: number, column?: number, external?: boolean) => void;
  };
  readonly status: {
    readonly connected: () => boolean;
    readonly initialContentLoading: () => boolean;
    readonly manifestLoading: Readonly<Ref<boolean>>;
    readonly skillsLoading: Readonly<Ref<boolean>>;
    readonly skillsFailed: Readonly<Ref<boolean>>;
    readonly promptsLoading: Readonly<Ref<boolean>>;
    readonly promptsFailed: Readonly<Ref<boolean>>;
  };
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
  > & {
    readonly cacheContext: (
      nodeId: string,
      workspaceId: string,
      sessionId: string,
      value: SessionContextUsage | null | undefined
    ) => void;
    readonly cacheRun: (
      nodeId: string,
      workspaceId: string,
      run: import('../model/workbench.js').AgentRun
    ) => void;
    readonly cacheTurn: (
      nodeId: string,
      workspaceId: string,
      turn: import('../model/workbench.js').ConversationTurn
    ) => void;
  };
  readonly configuration: Omit<ConfigurationOptions, 'sessions'> & {
    readonly sessions: Ref<Session[]>;
  };
  readonly profileService: Parameters<
    typeof createWorkbenchComposerController
  >[0]['profileService'];
  readonly ensureDraftSupported: Parameters<
    typeof createWorkbenchComposerController
  >[0]['ensureDraftSupported'];
  readonly runner: Omit<RunnerOptions, 'selectedSession' | 'profile' | 'commandAvailable'>;
  readonly references: Pick<ReferenceOptions, 'request'>;
  readonly presentation: Omit<
    PresentationOptions,
    | 'selectedSession'
    | 'composerProfile'
    | 'composerModels'
    | 'composerAccessOptions'
    | 'currentSessionQueue'
  >;
  readonly queue: Omit<
    QueueOptions,
    'currentSessionQueue' | 'currentSelectionRevision' | 'beginSubmission'
  > & {
    readonly currentWorkspaceRevision: () => number;
  };
  readonly interaction: Omit<
    InteractionOptions,
    | 'workspaceTarget'
    | 'filesReady'
    | 'canInterruptTurn'
    | 'commandPickerOpen'
    | 'fileReferences'
    | 'runnerInteractions'
    | 'selectSkill'
    | 'stopActiveRun'
    | 'loadOlderConversationTurns'
    | 'canLoadOlder'
    | 'loadRunnerProfiles'
    | 'sendMessage'
  >;
}) {
  const { state } = options;
  const configuration = state.createConfiguration(options.configuration);
  const runner = state.createRunnerInteraction({
    ...options.runner,
    selectedSession: configuration.selectedSession,
    profile: configuration.profile,
    commandAvailable: (command) => presentation.canExecuteRunnerCommand(command)
  });
  const currentSessionQueue = state.projectQueue(options.queue.queue);
  const presentation = state.createPresentation({
    ...options.presentation,
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
        revalidate: (file) => {
          const target = state.workspaceTarget.value!;
          const parameters = new URLSearchParams({
            nodeId: target.nodeId,
            path: file.path,
            offset: '0',
            limit: '1'
          });
          return common.request(
            `/api/workspaces/${encodeURIComponent(target.workspaceId)}/files/read?${parameters}`,
            { cache: 'no-store' }
          );
        },
        sourceUrl: (file, revision) => {
          const target = state.workspaceTarget.value!;
          const parameters = new URLSearchParams({
            nodeId: target.nodeId,
            path: file.path,
            preview: String(revision)
          });
          return `/api/workspaces/${encodeURIComponent(target.workspaceId)}/files/content?${parameters}`;
        },
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
    currentSessionQueue,
    currentSelectionRevision: () =>
      state.conversation.currentDetailRequest() + currentWorkspaceRevision(),
    beginSubmission: state.submission.begin
  });
  const composer = createWorkbenchComposerController({
    workspaceTarget: state.workspaceTarget,
    configurationAvailable: () => !presentation.sessionControlsBusy.value,
    selectedSession: configuration.selectedSession,
    sessions: options.configuration.sessions,
    profiles: options.configuration.profiles,
    draftOpen: options.presentation.draftOpen,
    loading: options.presentation.loading,
    runner: configuration.runner,
    modelId: configuration.modelId,
    effort: configuration.effort,
    access: configuration.access,
    setModel: configuration.selectModel,
    setEffort: configuration.selectEffort,
    setAccess: configuration.selectAccess,
    clearModelEffortSelection: configuration.clearModelEffortSelection,
    codexFastEnabled: runner.codexFastEnabled,
    profileService: options.profileService,
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
    options.configuration.profiles.value
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
    replaceCached: options.replaceCachedConversation,
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
    replaceSession: options.history.replaceSession,
    openSession: options.history.openSession,
    invalidateDetail: options.history.invalidateDetail,
    clearHistory: (sessionId) => {
      state.conversation.projection.clearSession(
        sessionId,
        state.run.runs.value.map((run) => run.id)
      );
      state.conversation.projection.restoreWindow([], null);
      state.run.replaceRuns([]);
      options.history.stopWatch();
    }
  });
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
    loading: options.presentation.loading,
    notice: common.notice,
    request: common.request,
    sessionPathId: options.sessionPathId,
    errorMessage: common.errorMessage
  });
  const realtime = state.createRealtime({
    syncTurnStatus: state.conversation.projection.syncRunStatus,
    refreshChannelToken: channel.refreshClaudeChannelToken,
    syncCachedRunStatus: options.syncCachedRunStatus
  });
  const events = createWorkbenchEventProjectionService({
    ...options.events,
    workspaceTarget: state.workspaceTarget,
    selectedSessionId: state.sessionId,
    selectedSession: configuration.selectedSession,
    conversationNextCursor: state.conversation.nextCursor,
    mergeSessions: (sessions) => {
      const nodeId = state.workspaceTarget.value?.nodeId;
      if (nodeId !== undefined)
        for (const session of sessions) state.acceptResolvedSession(nodeId, session);
      options.events.mergeSessions(sessions);
    },
    settleSessionRuns: state.run.settleSessionRuns,
    observeManagedSessionActive: state.run.observeManagedSessionActive,
    updateContext: (sessionId, value) => {
      const target = state.workspaceTarget.value;
      if (target !== undefined)
        options.events.cacheContext(
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
        options.events.cacheRun(target.nodeId, run.workspaceId ?? target.workspaceId, run);
    },
    acceptRun: state.run.acceptRun,
    openRun: realtime.openRun,
    markLiveTurn: state.conversation.projection.markLive,
    cacheTurn: (turn) => {
      const target = state.workspaceTarget.value;
      if (target !== undefined) options.events.cacheTurn(target.nodeId, target.workspaceId, turn);
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
          options.events.cacheContext(target.nodeId, target.workspaceId, sessionId, context);
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
  const commands = createWorkbenchRunnerCommandService({
    workspaceTarget: state.workspaceTarget,
    selectedSessionId: state.sessionId,
    currentSelectionRevision: state.conversation.currentDetailRequest,
    acceptRun: state.run.acceptRun,
    captureCacheTarget: options.commands.captureCacheTarget,
    request: common.request,
    sessionPathId: options.sessionPathId,
    acceptSession: options.commands.acceptSession,
    configure: composer.applyConfiguration,
    resetHistory: async (nodeId, session) => {
      options.commands.invalidateDetail(nodeId, session.workspaceId, session.id);
      state.conversation.projection.clearSession(
        session.id,
        state.run.runs.value.map((run) => run.id)
      );
      state.conversation.projection.restoreWindow([], null);
      state.run.replaceRuns([]);
      options.commands.stopWatch();
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
    ...options.messaging,
    provisionalSessionId: computed(() => {
      const value = options.presentation.provisionalSessionId.value;
      return value?.startsWith('draft:') ? value : undefined;
    }),
    selectedSession: configuration.selectedSession,
    composerOpen: presentation.composerSessionOpen,
    composerBusy: presentation.composerSessionBusy,
    commandAvailable: presentation.canExecuteRunnerCommand,
    submissionAvailable: () => !options.presentation.loading.value,
    draftOpen: options.presentation.draftOpen,
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
      options.presentation.nodeManifest.value?.files?.available === true
  );
  const references = state.createReferences({
    ...options.references,
    ready: () => filesReady.value,
    sessionsReady: () => presentation.nodeReady.value
  });
  const selectedSessionId = computed(
    () => state.sessionId.value ?? options.presentation.provisionalSessionId.value
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
        options.queue.queue.value.version,
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
    ...options.interaction,
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
  return {
    state,
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
    status: options.status,
    copyMessage: (text: string, onSuccess: () => void) =>
      copyConversationMessage(text, onSuccess, common.notice),
    openFileChange,
    openAgentFile,
    terminalReady: computed(
      () =>
        presentation.nodeReady.value &&
        options.presentation.nodeManifest.value?.terminal?.available === true &&
        options.presentation.nodeManifest.value.terminal.supportsReplay === true
    ),
    effortLabel: options.configuration.effortLabel,
    request: common.request,
    loading: options.presentation.loading,
    draftOpen: options.presentation.draftOpen,
    nodeManifest: options.presentation.nodeManifest,
    runnerProfilesLoading: options.presentation.runnerProfilesLoading,
    runnerProfilesFailed: options.presentation.runnerProfilesFailed,
    mobileViewport: options.interaction.mobileViewport,
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
}
