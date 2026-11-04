import type { MessageFeedback } from '../model/message-feedback.js';
import { computed, nextTick, ref, watch } from 'vue';
import {
  sessionShareVisitorSchema,
  type ComposerReference,
  type SessionShareVisitor
} from '@myagentroam/protocol';
import type {
  Session,
  RunnerCommand,
  RunnerProfile,
  ComposerSkillToken,
  WorkspaceQueue,
  ConversationTurnPage
} from '../model/workbench.js';
import { createSessionShareClientService } from './session-share-client-service.js';
import type { createSessionShareAccessService } from './session-share-access-service.js';
import { createWorkbenchLiveService } from './workbench-live-service.js';
import { createWorkbenchSessionWatchController } from './workbench-session-watch-controller.js';
import { createConversationStateService } from './conversation-state-service.js';
import { createWorkbenchEventProjectionService } from './workbench-event-projection-service.js';
import { createWorkbenchConversationPagingService } from './workbench-conversation-paging-service.js';
import { createConversationScrollService } from './conversation-scroll-service.js';
import { createWorkbenchSubmissionService } from './workbench-submission-service.js';
import { createWorkbenchSessionMessageService } from './workbench-session-message-service.js';
import { createWorkbenchRunControlService } from './workbench-run-control-service.js';
import { createComposerAttachmentService } from './composer-attachment-service.js';
import { createRunService } from './run-service.js';
import { createComposerQueueService } from './composer-queue-service.js';
import { createWorkspaceQueueService } from './workspace-queue-service.js';
import { reconcileWorkspaceQueueSnapshot } from './workspace-queue-projection-service.js';
import { createConversationUserInputService } from './conversation-user-input-service.js';
import { errorMessage } from '../util/error-presentation.js';
import { errorCode } from '../util/api-error.js';
import { isAgentRun, isSession } from '../util/workbench-guards.js';
import { createRunnerInteractionService } from './runner-interaction-service.js';
import { createComposerReferenceService } from './composer-reference-service.js';
import { createComposerSkillService } from './composer-skill-service.js';
import { createComposerSkillTokenService } from './composer-skill-token-service.js';
import type { EffectiveWorkspaceSkill } from './effective-workspace-skill-service.js';
import { createWorkbenchApprovalService } from './workbench-approval-service.js';

/** A fixed Session composition root: no account, workspace tree, navigation, or prediction services. */
export function createSessionShareConversationService(options: {
  access: ReturnType<typeof createSessionShareAccessService>;
  beforeSend: () => Promise<boolean>;
  notice: MessageFeedback;
}) {
  const access = options.access;
  const target = access.session.value!.share;
  const client = createSessionShareClientService(access, target);
  const request = client.request;
  const workspaceTarget = ref({ nodeId: target.nodeId, workspaceId: target.workspaceId });
  const selectedSessionId = ref<string | undefined>(target.sessionId);
  const sessions = ref<Session[]>([]);
  const selectedSession = computed(() =>
    sessions.value.find((value) => value.id === target.sessionId)
  );
  const profiles = ref<RunnerProfile[]>([]);
  const profilesLoading = ref(false);
  const profilesFailed = ref(false);
  const profile = computed(() =>
    profiles.value.find((value) => value.runner === selectedSession.value?.runner)
  );
  const connectionId = ref<string>();
  const connected = ref(false);
  const nodeConnected = ref(true);
  const participants = ref<SessionShareVisitor[]>([]);
  const sharerOnline = ref(false);
  const canRename = ref(false);
  const input = ref('');
  const notice = options.notice;
  const skillTokens = ref<readonly ComposerSkillToken[]>([]);
  const references = ref<readonly ComposerReference[]>([]);
  const skills = ref<readonly EffectiveWorkspaceSkill[]>([]);
  const skillsLoading = ref(false);
  const skillsFailed = ref(false);
  const skillService = createComposerSkillService({
    workspaceTarget,
    skills,
    loading: skillsLoading,
    failed: skillsFailed,
    request
  });
  const tokens = createComposerSkillTokenService(skillTokens);
  const state = createConversationStateService(() => void paging.refreshRecentConversationTurns());
  const scroll = createConversationScrollService();
  const runState = createRunService(selectedSessionId);
  const submission = createWorkbenchSubmissionService();
  const queue = ref<WorkspaceQueue>({ version: 0, paused: false, items: [] });
  const ready = computed(
    () =>
      connected.value &&
      nodeConnected.value &&
      !state.loadingInitial.value &&
      !state.initialLoadFailed.value &&
      selectedSession.value !== undefined &&
      access.session.value !== undefined
  );
  const activeRun = computed(() =>
    runState.runs.value.find((run) => ['STARTING', 'RUNNING', 'CANCELLING'].includes(run.status))
  );
  const busy = computed(
    () => activeRun.value !== undefined || selectedSession.value?.activity === 'MANAGED_ACTIVE'
  );
  const projection = state.projection;
  const mergeSessions = (values: readonly Session[]) => {
    sessions.value = values.filter((value) => value.id === target.sessionId);
  };
  const applySnapshot = (_id: string, page: ConversationTurnPage, mode?: 'initial' | 'refresh') => {
    const changed =
      mode === 'refresh' ? projection.mergeLatest(page) : projection.replaceRecent(page);
    state.loadingInitial.value = false;
    state.initialLoadFailed.value = false;
    if (scroll.following.value) void nextTick(scroll.scrollToLatestAfterLayout);
    return changed;
  };
  const events = createWorkbenchEventProjectionService({
    nodes: ref([]),
    sessions,
    workspaceTarget,
    selectedSessionId,
    conversationNextCursor: state.nextCursor,
    cacheQueue: () => undefined,
    mergeQueue: (value, source) => {
      queue.value = reconcileWorkspaceQueueSnapshot(queue.value, value, source);
    },
    mergeSessions,
    settleSessionRuns: runState.settleSessionRuns,
    observeManagedSessionActive: runState.observeManagedSessionActive,
    updateContext: (_id, value) => {
      state.contextUsage.value = value as typeof state.contextUsage.value;
    },
    syncTurnStatus: (id, status) => {
      projection.syncRunStatus(
        id,
        (['STARTING', 'RUNNING', 'CANCELLING'].includes(status)
          ? 'RUNNING'
          : status) as (typeof state.turns.value)[number]['status']
      );
    },
    cacheRun: () => undefined,
    acceptRun: runState.acceptRun,
    openRun: (id) => {
      runState.selectedRunId.value = id;
    },
    markLiveTurn: projection.markLive,
    cacheTurn: () => undefined,
    mergeTurns: projection.mergeLatest,
    applyConversationSnapshot: applySnapshot,
    mergeItem: projection.mergeItem,
    mergeTextDelta: projection.mergeTextDelta,
    invalidateWorkspace: () => undefined,
    onNodeConnected: () => undefined
  });
  const sessionWatch = createWorkbenchSessionWatchController({
    workspaceTarget,
    selectedSessionId,
    followConversation: scroll.following,
    enabled: () => connected.value && access.session.value !== undefined,
    heartbeatMs: 10_000,
    requestTimeoutMs: 15_000,
    confirmationTimeoutMs: 30_000,
    workbenchConnectionId: () => connectionId.value,
    request,
    sessionPathId: encodeURIComponent,
    applyRunsSnapshot: (runs) => runState.mergeSnapshots(runs.filter(isAgentRun)),
    applySnapshot,
    applyEvent: events.apply,
    scrollAfterLayout: scroll.scrollToLatestAfterLayout,
    refreshSnapshot: () => live.reconnect(),
    openSession: async () => restartWatch()
  });
  async function restartWatch(): Promise<void> {
    if (!connected.value || !nodeConnected.value) return;
    state.loadingInitial.value = true;
    state.initialLoadFailed.value = false;
    try {
      if (selectedSession.value === undefined) {
        const result = await access.request<{ session: unknown }>('/session');
        if (!isSession(result.session)) throw new Error('SESSION_NOT_FOUND');
        mergeSessions([result.session]);
      }
      await sessionWatch.restartSelectedSessionWatch(target.sessionId);
    } catch (error) {
      if (errorCode(error) === 'WATCH_CANCELLED') return;
      state.loadingInitial.value = false;
      state.initialLoadFailed.value = true;
      options.notice(errorMessage(error), 'error', error);
    }
  }
  let restartQueued = false;
  function queueWatchRestart(): void {
    if (restartQueued) return;
    restartQueued = true;
    // Live reports one Node recovery through multiple callbacks in the same frame.
    queueMicrotask(() => {
      restartQueued = false;
      void restartWatch();
    });
  }
  const live = createWorkbenchLiveService({
    endpoint: () =>
      `${access.base}/live?visitorId=${encodeURIComponent(access.visitor.value.visitorId)}`,
    canConnect: () => access.session.value !== undefined,
    onEvent: events.apply,
    onWatchEvent: sessionWatch.handleEvent,
    onReady: (id) => {
      connectionId.value = id;
      connected.value = true;
      // A Node-online frame may have been missed while this socket was disconnected.
      nodeConnected.value = true;
      live.updateShareVisitor(access.visitor.value);
      queueWatchRestart();
    },
    onNodeConnection: (_id, value) => {
      nodeConnected.value = value;
      if (value) queueWatchRestart();
      else sessionWatch.pauseSelectedSessionWatch();
    },
    onNodeReplaced: () => undefined,
    onResyncRequired: () => {
      queueWatchRestart();
    },
    onReconnect: () => undefined,
    onDisconnected: () => {
      connected.value = false;
      participants.value = [];
      sharerOnline.value = false;
      canRename.value = false;
      sessionWatch.pauseSelectedSessionWatch();
    },
    onUnauthenticated: () => access.invalidate('SESSION_SHARE_CREDENTIAL_INVALID'),
    onInvalidMessage: () => undefined,
    onNotificationMessage: (raw) => {
      const value = raw as Record<string, unknown>;
      if (value.type === 'session-share.invalidated' && typeof value.code === 'string') {
        access.invalidate(value.code);
        return true;
      }
      if (value.type === 'session-share.participants') {
        const parsed = sessionShareVisitorSchema.array().safeParse(value.participants);
        if (parsed.success) {
          participants.value = parsed.data;
          sharerOnline.value = value.sharerOnline === true;
          canRename.value = value.canRename === true;
        }
        return true;
      }
      return false;
    }
  });
  const paging = createWorkbenchConversationPagingService({
    workspaceTarget,
    selectedSessionId,
    nextCursor: state.nextCursor,
    loadingOlder: state.loadingOlder,
    capturePrependAnchor: scroll.capturePrependAnchor,
    pageSize: 20,
    recentSegmentWindowSize: 20,
    replaceRecent: projection.replaceRecent,
    mergeOlderPage: projection.mergeOlderPage,
    recoverWindow: projection.recoverWindow,
    clearCursor: projection.clearCursor,
    request,
    sessionPathId: encodeURIComponent,
    notice,
    errorMessage
  });
  const attachments = createComposerAttachmentService({
    context: () =>
      ready.value && workspaceTarget.value !== undefined
        ? { kind: 'session', ...workspaceTarget.value, sessionId: target.sessionId }
        : undefined,
    request,
    resourceUrl: client.resourceUrl,
    notice: options.notice,
    csrfToken: ref(''),
    renewCsrfToken: async () => '',
    onUnauthenticated: () => access.invalidate('SESSION_SHARE_CREDENTIAL_INVALID')
  });
  const attachmentsPending = computed(() =>
    attachments.attachments.value.some((value) => value.status !== 'COMPLETED')
  );
  const fileReferences = createComposerReferenceService(
    input,
    {
      nodeId: computed(() => target.nodeId),
      workspaceId: computed(() => target.workspaceId),
      ready: () => ready.value,
      request
    },
    references
  );
  const draftOpen = ref(false);
  const commandAvailable = (command: RunnerCommand) => command.id === 'compact';
  const interactions = createRunnerInteractionService({
    input,
    draftSessionOpen: draftOpen,
    selectedSession,
    profile,
    commandAvailable,
    skills
  });
  const { selectedCommand, commandPickerOpen, deferredDraftCommands, codexFastEnabled } =
    interactions;
  const message = createWorkbenchSessionMessageService({
    workspaceTarget,
    selectedSessionId,
    selectedWorkspace: computed(() => undefined),
    selectedSession,
    sessions,
    captureDraft: () => ({ input, skillTokens, references, persist: () => {} }),
    attachments: attachments.attachments,
    attachmentsPending,
    composerOpen: ready,
    composerBusy: busy,
    submissionAvailable: () => ready.value && !submission.pending.value,
    draftOpen,
    restoreDraft: () => {
      draftOpen.value = true;
      selectedSessionId.value = undefined;
    },
    selectedCommand,
    commandAvailable,
    commandPickerOpen,
    deferredCommands: deferredDraftCommands,
    fastEnabled: codexFastEnabled,
    notice,
    request,
    stageDraftCommand: () => undefined,
    createDraftSession: async () => undefined,
    executeCommand: async (session, command, value) =>
      request(`/api/agent-sessions/${encodeURIComponent(session.id)}/commands`, {
        method: 'POST',
        body: JSON.stringify({ commandId: command.id, input: value, modelId: session.modelId })
      }),
    replaceSession: (_previous, value) => mergeSessions([value]),
    sessionPathId: encodeURIComponent,
    temporaryTitle: (value) => value,
    consumeAttachments: attachments.consume,
    retainAttachments: attachments.retainForSubmission,
    acceptRun: runState.acceptRun,
    migrateSessionCache: () => undefined,
    openRun: (id) => {
      runState.selectedRunId.value = id;
    },
    cacheRun: () => undefined,
    beginSessionWatch: () => void restartWatch(),
    scrollToLatest: scroll.scrollToLatest,
    scrollToLatestAfterLayout: scroll.scrollToLatestAfterLayout,
    errorMessage,
    beginSubmission: submission.begin
  });
  const controls = createWorkbenchRunControlService({
    currentRevision: () => 0,
    workspaceTarget,
    selectedSessionId,
    selectedRunId: runState.selectedRunId,
    activeRun,
    notice,
    runService: runState,
    request,
    sessionPathId: encodeURIComponent,
    errorMessage,
    beginSubmission: submission.begin
  });
  const queueEditor = createComposerQueueService();
  const queueActions = createWorkspaceQueueService({
    queue,
    currentSessionQueue: computed(() => queue.value),
    workspaceTarget,
    selectedSessionId,
    currentSelectionRevision: () => 0,
    draggingQueueItemId: queueEditor.draggingQueueItemId,
    editingContent: queueEditor.editingContent,
    serializeEditedContent: queueEditor.serializeEditedContent,
    request,
    finishEditing: queueEditor.finishEditing,
    notice: options.notice,
    errorMessage,
    missingQueueItemError: (error) => errorCode(error) === 'QUEUE_ITEM_NOT_FOUND',
    beginSubmission: submission.begin
  });
  const questions = createConversationUserInputService({
    workspaceTarget,
    notice,
    request,
    errorMessage,
    missingRunError: (error) => errorCode(error) === 'RUN_NOT_FOUND',
    beginSubmission: submission.begin
  });
  const approvals = createWorkbenchApprovalService({
    workspaceTarget,
    notice,
    request,
    errorMessage,
    beginSubmission: submission.begin
  });
  const stopVisitor = watch(access.visitor, (value) => live.updateShareVisitor(value));
  const stopAccess = watch(
    access.session,
    (value) => {
      if (value === undefined) stop();
    },
    { flush: 'sync' }
  );
  async function send(
    intent?: 'REPLACE_CURRENT',
    preserveDraft = false,
    contentOverride?: string
  ): Promise<void> {
    if (
      !input.value.trim() &&
      !attachments.attachments.value.length &&
      !references.value.length &&
      !skillTokens.value.length &&
      !selectedCommand.value
    )
      return;
    if (!ready.value || !(await options.beforeSend()) || !ready.value) return;
    await message.send(intent, preserveDraft, contentOverride);
  }
  async function loadProfiles(): Promise<void> {
    if (profilesLoading.value) return;
    profilesLoading.value = true;
    profilesFailed.value = false;
    try {
      profiles.value = (await access.request<{ profiles: RunnerProfile[] }>('/profiles')).profiles;
    } catch (error) {
      profilesFailed.value = true;
      options.notice(errorMessage(error), 'error', error);
    } finally {
      profilesLoading.value = false;
    }
  }
  function visibility(): void {
    if (document.visibilityState === 'hidden') sessionWatch.stopSelectedSessionWatch();
    else live.reconnect();
  }
  async function start(): Promise<void> {
    document.addEventListener('visibilitychange', visibility);
    live.connect();
    await loadProfiles();
  }
  function stop(): void {
    document.removeEventListener('visibilitychange', visibility);
    sessionWatch.stopSelectedSessionWatch();
    live.close();
    connected.value = false;
  }
  function dispose(): void {
    stop();
    stopVisitor();
    stopAccess();
    fileReferences.close();
    attachments.clearAll();
    projection.resetHistory();
    state.cancelInitialRender();
  }
  return {
    access,
    target,
    client,
    input,
    skillTokens,
    references,
    selectedSession,
    profiles,
    profile,
    profilesLoading,
    profilesFailed,
    loadProfiles,
    skillsLoading,
    skillsFailed,
    skillService,
    tokens,
    interactions,
    fileReferences,
    state,
    scroll,
    runs: runState.runs,
    activeRun,
    busy,
    ready,
    connected: computed(() => connected.value && nodeConnected.value),
    watchReady: computed(
      () =>
        selectedSessionId.value !== undefined &&
        sessionWatch.hasInitialSessionSnapshot(selectedSessionId.value)
    ),
    participants,
    sharerOnline,
    canRename,
    submission,
    queue,
    queueEditor,
    queueActions,
    questions,
    approvals,
    attachments,
    attachmentsPending,
    send,
    controls,
    start,
    dispose,
    restartWatch,
    paging
  };
}
