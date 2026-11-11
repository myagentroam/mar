/**
 * Pane-scoped state owner and factories that inject that state into domain services.
 * Drafts, attachments and submission identities remain owned by the supplied target-bound owners;
 * conversation, Run, queue and scroll projections live for this Pane's Vue scope.
 * Application capabilities and Main/Aside coordination belong to the Pane controller, not here.
 * Quote callbacks bind the existing draft slot and recheck the supplied editing admission; they own no separate quote store.
 * Do not duplicate global selection, transport protocols or shared Watch subscriptions.
 */
import { computed, getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue';
import type { ComposerQuoteTarget } from '../model/composer-quote.js';
import { appendComposerQuote } from '../util/composer-quote.js';
import { createComposerQueueService } from './composer-queue-service.js';
import { createConversationScrollService } from './conversation-scroll-service.js';
import { createConversationStateService } from './conversation-state-service.js';
import { createRunService } from './run-service.js';
import { createWorkspaceQueueService } from './workspace-queue-service.js';
import { createWorkspaceQueueProjection } from './workspace-queue-projection-service.js';
import { consoleKeyboardShortcutService } from './console-keyboard-shortcut-service.js';
import { createWorkbenchComposerInteractionController } from './workbench-composer-interaction-controller.js';
import { createWorkbenchApprovalService } from './workbench-approval-service.js';
import { createConversationUserInputService } from './conversation-user-input-service.js';
import { createWorkbenchConversationRealtimeService } from './workbench-conversation-realtime-service.js';
import { createWorkbenchRunnerChannelService } from './workbench-runner-channel-service.js';
import { createWorkbenchPlanService } from './workbench-plan-service.js';
import { createWorkbenchContextCommandService } from './workbench-context-command-service.js';
import { createWorkbenchSessionHistoryMutationService } from './workbench-session-history-mutation-service.js';
import { createWorkbenchRunControlService } from './workbench-run-control-service.js';
import { createComposerConfigurationService } from './composer-configuration-service.js';
import { createComposerReferenceService } from './composer-reference-service.js';
import { createWorkspaceSessionPaneLoader } from './workspace-session-pane-loader.js';
import { createWorkspaceSessionPresentationStateService } from './workbench-presentation-state-service.js';
import { createWorkbenchPerformanceService } from './workbench-performance-service.js';
import { createComposerSkillTokenService } from './composer-skill-token-service.js';
import { createRunnerInteractionService } from './runner-interaction-service.js';
import { createWorkbenchConversationComposition } from './workbench-conversation-composition.js';
import type { createWorkbenchSubmissionOwner } from './workbench-submission-service.js';
import type { createWorkspaceViewCacheService } from './workspace-view-cache-service.js';
import { createWorkbenchSessionWatchController } from './workbench-session-watch-controller.js';
import type {
  AgentRun,
  CachedSessionDetail,
  ConversationSegmentPage,
  ConversationTurnPage,
  WorkspaceQueue,
  WorkspaceTarget
} from '../model/workbench.js';
import { CONVERSATION_INITIAL_SEGMENT_LIMIT } from '../util/conversation-history.js';
import {
  parseConversationSegmentPage,
  segmentPageAsTurnPage
} from '../util/conversation-segments.js';
import { ApiError } from '../util/api-error.js';
import { composerModelKeys } from './console-shortcut-keys.js';
import type { DraftPane, DraftTarget, createSessionDraftService } from './session-draft-service.js';
import type { Session } from '../model/workbench.js';
import type { createComposerAttachmentService } from './composer-attachment-service.js';
import {
  createWorkbenchSessionMessageService,
  type WorkbenchSessionMessageOptions
} from './workbench-session-message-service.js';

export function registerWorkspacePaneShortcuts(
  owner: () => Element | undefined,
  openModelMenu: () => boolean
): () => void {
  return consoleKeyboardShortcutService.register({
    command: 'composer.openModelMenu',
    scope: 'pane',
    priority: 100,
    owner,
    keys: composerModelKeys,
    when: () => true,
    execute: () => (openModelMenu() ? 'HANDLED' : 'IGNORED')
  });
}

export function createWorkspaceSessionPaneReader() {
  let sessionRead: AbortController | undefined;
  function cancel(): void {
    sessionRead?.abort();
    sessionRead = undefined;
  }
  async function readWithSignal<T>(load: (signal: AbortSignal) => Promise<T>): Promise<T> {
    cancel();
    const controller = new AbortController();
    sessionRead = controller;
    try {
      const result = await load(controller.signal);
      if (!controller.signal.aborted) return result;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (sessionRead === controller) sessionRead = undefined;
    }
    throw new ApiError('WATCH_CANCELLED', 'The session read was stopped or replaced.');
  }
  function read(
    nodeId: string,
    id: string,
    request: <T>(path: string, init?: RequestInit) => Promise<T>,
    sessionPathId: (id: string) => string
  ): Promise<{ session: Session }> {
    return readWithSignal((signal) =>
      request<{ session: Session }>(
        `/api/agent-sessions/${sessionPathId(id)}?nodeId=${encodeURIComponent(nodeId)}`,
        { signal }
      )
    );
  }
  async function readInitialHistory(
    nodeId: string,
    id: string,
    request: <T>(path: string, init?: RequestInit) => Promise<T>,
    sessionPathId: (id: string) => string
  ): Promise<ConversationTurnPage> {
    const page = await readWithSignal((signal) =>
      request<ConversationSegmentPage | ConversationTurnPage>(
        `/api/agent-sessions/${sessionPathId(id)}/turns?nodeId=${encodeURIComponent(nodeId)}&limit=${CONVERSATION_INITIAL_SEGMENT_LIMIT}&unit=SEGMENT`,
        { signal }
      )
    );
    return parseConversationSegmentPage(page) ?? segmentPageAsTurnPage(page);
  }
  return { read, readInitialHistory, cancel };
}

/** State local to one visible session surface; durable drafts and attachments remain shared owners. */
export function createWorkspaceSessionPaneState(options: {
  readonly pane?: DraftPane;
  readonly draftTarget: Readonly<Ref<DraftTarget | undefined>>;
  readonly drafts: Pick<ReturnType<typeof createSessionDraftService>, 'bindTarget' | 'forTarget'>;
  readonly attachments: Pick<
    ReturnType<typeof createComposerAttachmentService>,
    'forTarget' | 'moveDraft' | 'consume' | 'retainForSubmission'
  >;
  readonly submissions: ReturnType<typeof createWorkbenchSubmissionOwner>;
  readonly onConversationOverflow: () => void;
}) {
  const scope = getCurrentScope();
  let focusInput: (cursor: number) => void = () => undefined;
  let editRange: (start: number, end: number, text: string) => boolean = () => false;
  const sessionId = computed(() => {
    const target = options.draftTarget.value;
    return target?.kind === 'session' ? target.sessionId : undefined;
  });
  const workspaceTarget = computed<WorkspaceTarget | undefined>((previous) => {
    const target = options.draftTarget.value;
    if (target === undefined) return undefined;
    if (previous?.nodeId === target.nodeId && previous.workspaceId === target.workspaceId)
      return previous;
    return { nodeId: target.nodeId, workspaceId: target.workspaceId };
  });
  const attachments = options.attachments.forTarget(() => options.draftTarget.value);
  const draft = options.drafts.bindTarget(options.draftTarget, options.pane);
  const skillTokens = createComposerSkillTokenService(draft.skillTokens);
  watch(draft.input, draft.persist);
  watch(draft.skillTokens, draft.persist, { deep: true });
  watch(draft.references, draft.persist, { deep: true });
  const submission = options.submissions.bind(() => {
    const target = options.draftTarget.value;
    return target === undefined ? undefined : options.submissions.forTarget(target);
  });
  const scroll = createConversationScrollService();
  const run = createRunService(sessionId);
  const queueProjection = createWorkspaceQueueProjection(run.runs);
  const reader = createWorkspaceSessionPaneReader();
  const conversation = createConversationStateService(options.onConversationOverflow);
  function captureDetail(sessionId: string): CachedSessionDetail {
    conversation.projection.flushPendingTextDeltas();
    return {
      sessionId,
      runs: run.runs.value,
      turns: conversation.turns.value,
      nextCursor: conversation.nextCursor.value,
      contextUsage: conversation.contextUsage.value ?? null,
      lastAccessedAt: Date.now()
    };
  }
  function restoreDetail(
    detail: Readonly<CachedSessionDetail> | undefined,
    emptyContext: null | undefined = undefined
  ): void {
    run.replaceRuns(detail?.runs ?? []);
    conversation.projection.restoreWindow(detail?.turns ?? [], detail?.nextCursor ?? null);
    conversation.contextUsage.value =
      detail === undefined ? emptyContext : (detail.contextUsage ?? null);
  }
  function clearContent(): void {
    conversation.nextDetailRequest();
    restoreDetail(undefined);
  }
  function clearSelection(): void {
    run.selectedRunId.value = undefined;
    clearContent();
  }
  function prepareDraft(): void {
    clearSelection();
    conversation.loadingOlder.value = false;
    conversation.loadingInitial.value = false;
    conversation.initialLoadFailed.value = false;
  }
  function saveCachedSession(
    session: Session | undefined,
    queue: WorkspaceQueue,
    cache: Pick<ReturnType<typeof createWorkspaceViewCacheService>, 'captureSession'>,
    maximumDetails: number
  ): void {
    const target = options.draftTarget.value;
    if (target?.kind !== 'session' || session === undefined || session.id !== target.sessionId)
      return;
    draft.persist();
    cache.captureSession(
      target.nodeId,
      target.workspaceId,
      session,
      queue,
      captureDetail(target.sessionId),
      maximumDetails
    );
  }
  function restoreCachedSession(
    target: WorkspaceTarget & { readonly sessionId: string },
    cache: Pick<ReturnType<typeof createWorkspaceViewCacheService>, 'touchDetail' | 'queueFor'>,
    restoreQueue: (queue: WorkspaceQueue) => void
  ): boolean {
    return restoreSessionProjection(target, cache, restoreQueue, undefined, false, null).restored;
  }
  function restoreSessionProjection(
    target: (WorkspaceTarget & { readonly sessionId: string }) | undefined,
    cache: Pick<ReturnType<typeof createWorkspaceViewCacheService>, 'touchDetail' | 'queueFor'>,
    restoreQueue: (queue: WorkspaceQueue) => void,
    configure: (() => void) | undefined,
    resetSelection: boolean,
    emptyContext: null | undefined
  ): { restored: boolean; activeRunId: string | undefined } {
    const cachedAside =
      !resetSelection && target !== undefined
        ? cache.touchDetail(target.nodeId, target.workspaceId, target.sessionId)
        : undefined;
    restoreQueue(
      target === undefined
        ? { version: 0, paused: false, items: [] }
        : (cache.queueFor(target.nodeId, target.workspaceId, target.sessionId) ?? {
            version: 0,
            paused: false,
            items: []
          })
    );
    configure?.();
    const detail =
      !resetSelection || target === undefined
        ? cachedAside
        : cache.touchDetail(target.nodeId, target.workspaceId, target.sessionId);
    if (resetSelection) run.selectedRunId.value = undefined;
    restoreDetail(detail, emptyContext);
    const active =
      target === undefined
        ? undefined
        : run.runs.value.find(
            (candidate) =>
              candidate.sessionId === target.sessionId &&
              ['STARTING', 'RUNNING', 'CANCELLING'].includes(candidate.status)
          );
    return { restored: detail !== undefined, activeRunId: active?.id };
  }
  function prepareSession(
    target: (WorkspaceTarget & { readonly sessionId: string }) | undefined,
    cache: Pick<ReturnType<typeof createWorkspaceViewCacheService>, 'touchDetail' | 'queueFor'>,
    restoreQueue: (queue: WorkspaceQueue) => void,
    configure: () => void
  ): { restored: boolean; activeRunId: string | undefined } {
    return restoreSessionProjection(target, cache, restoreQueue, configure, true, undefined);
  }
  // A visible session may be absent from the paginated Workspace list (for example, a child).
  // This is a target-scoped projection of the loaded session, not another durable session store.
  const resolvedSession = ref<Session>();
  function acceptResolvedSession(nodeId: string, session: Session): void {
    const target = workspaceTarget.value;
    if (
      target?.nodeId === nodeId &&
      target.workspaceId === session.workspaceId &&
      sessionId.value === session.id
    )
      resolvedSession.value = session;
  }
  const queue = createComposerQueueService({ draft: draft.queueEdit, persist: draft.persist });
  queue.rebind();
  watch(
    () => draft.queueEdit.value?.queueItemId,
    (id) => {
      queue.editingQueueItemId.value = id;
    },
    { flush: 'sync' }
  );
  function releasePending(): void {
    reader.cancel();
    conversation.cancelInitialRender();
    queue.rebind();
  }
  watch(
    [
      () => options.draftTarget.value?.kind,
      () => options.draftTarget.value?.nodeId,
      () => options.draftTarget.value?.workspaceId,
      () =>
        options.draftTarget.value?.kind === 'session'
          ? options.draftTarget.value.sessionId
          : undefined
    ],
    () => {
      conversation.nextDetailRequest();
      resolvedSession.value = undefined;
      releasePending();
    },
    { flush: 'sync' }
  );
  if (getCurrentScope() !== undefined) onScopeDispose(releasePending);
  const captureDraft = () => {
    const target = options.draftTarget.value;
    if (target === undefined) return undefined;
    const slot = options.drafts.forTarget(target, options.pane);
    const submissionSlot = options.submissions.forTarget(target);
    let created = false;
    return {
      ...slot,
      createdSession: (session: { readonly id: string; readonly workspaceId: string }) => {
        if (created || target.kind !== 'workspace' || target.workspaceId !== session.workspaceId)
          return;
        created = true;
        if (options.submissions.forTarget(target) !== submissionSlot) return;
        const next = { ...target, kind: 'session' as const, sessionId: session.id };
        options.submissions.transfer(
          submissionSlot,
          options.submissions.forTarget(next),
          'draft:',
          session.id,
          true
        );
        options.attachments.moveDraft(target, next);
      }
    };
  };
  function resetRealtime(): void {
    queueProjection.reset();
    if (sessionId.value !== undefined)
      conversation.projection.clearSession(
        sessionId.value,
        run.runs.value.map((item) => item.id)
      );
  }
  return {
    resetRealtime,
    clearContent,
    clearSelection,
    prepareDraft,
    clearRuns: () => run.replaceRuns([]),
    workspaceTarget,
    sessionId,
    acceptResolvedSession,
    run,
    queueProjection,
    conversation,
    draft,
    captureQuote: (
      enabled: () => boolean,
      rejected: () => void
    ): ReturnType<ComposerQuoteTarget['capture']> => {
      const target = options.draftTarget.value;
      if (!target || !enabled()) return undefined;
      const slot = options.drafts.forTarget(target, options.pane);
      return (quote) => {
        if (options.draftTarget.value !== target || !enabled()) return;
        try {
          slot.references.value = appendComposerQuote(
            slot.references.value,
            quote,
            slot.input.value
          );
          slot.persist();
        } catch {
          rejected();
        }
      };
    },
    attachments,
    skillTokens,
    createReferences: (search: {
      readonly ready: () => boolean;
      readonly sessionsReady: () => boolean;
      readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
    }) => {
      const references = createComposerReferenceService(
        draft.input,
        {
          nodeId: computed(() => workspaceTarget.value?.nodeId),
          workspaceId: computed(() => workspaceTarget.value?.workspaceId),
          ready: search.ready,
          request: search.request,
          sessions: { ready: search.sessionsReady, currentSessionId: sessionId }
        },
        draft.references
      );
      if (getCurrentScope() !== undefined) onScopeDispose(references.cancelSearch);
      return references;
    },
    captureDraft,
    createPerformance: (view: Readonly<Ref<string>>) => {
      const performance = createWorkbenchPerformanceService({
        view,
        nodeId: computed(() => workspaceTarget.value?.nodeId),
        workspaceId: computed(() => workspaceTarget.value?.workspaceId),
        sessionId
      });
      if (getCurrentScope() !== undefined) onScopeDispose(performance.dispose);
      return performance;
    },
    cancelRead: reader.cancel,
    readSession: reader.read,
    readInitialHistory: reader.readInitialHistory,
    createPresentation: (
      presentation: Omit<
        Parameters<typeof createWorkspaceSessionPresentationStateService>[0],
        | 'workspaceTarget'
        | 'selectedSessionId'
        | 'selectedRunId'
        | 'runs'
        | 'turns'
        | 'attachments'
        | 'sessionContextUsage'
        | 'channelToken'
        | 'submissionPending'
        | 'runService'
      > & { readonly provisionalSessionId: Readonly<Ref<string | undefined>> }
    ) => {
      const { provisionalSessionId, ...projection } = presentation;
      return createWorkspaceSessionPresentationStateService({
        ...projection,
        workspaceTarget,
        selectedSessionId: computed(
          () =>
            sessionId.value ??
            (options.draftTarget.value?.kind === 'workspace'
              ? provisionalSessionId.value
              : undefined)
        ),
        selectedRunId: run.selectedRunId,
        runs: run.runs,
        turns: conversation.turns,
        attachments: attachments.attachments,
        sessionContextUsage: conversation.contextUsage,
        channelToken: conversation.channelToken,
        submissionPending: submission.pending,
        runService: run
      });
    },
    createLoader: (
      loader: Omit<
        Parameters<typeof createWorkspaceSessionPaneLoader>[0],
        'runs' | 'readSession' | 'readInitialHistory'
      > & {
        readonly request: Parameters<typeof reader.read>[2];
        readonly sessionPathId: Parameters<typeof reader.read>[3];
      }
    ) => {
      const { request, sessionPathId, ...projection } = loader;
      return createWorkspaceSessionPaneLoader({
        ...projection,
        runs: run.runs,
        replaceSession: (previousId, session) => {
          const nodeId = workspaceTarget.value?.nodeId;
          if (nodeId !== undefined) acceptResolvedSession(nodeId, session);
          projection.replaceSession(previousId, session);
        },
        readSession: (nodeId, id) => reader.read(nodeId, id, request, sessionPathId),
        readInitialHistory: (nodeId, id) =>
          reader.readInitialHistory(nodeId, id, request, sessionPathId)
      });
    },
    registerShortcuts: registerWorkspacePaneShortcuts,
    createMessaging: ({
      provisionalSessionId,
      ...message
    }: Omit<
      WorkbenchSessionMessageOptions,
      | 'workspaceTarget'
      | 'attachments'
      | 'attachmentsPending'
      | 'captureDraft'
      | 'consumeAttachments'
      | 'retainAttachments'
      | 'acceptRun'
      | 'beginSubmission'
      | 'scrollToLatest'
      | 'scrollToLatestAfterLayout'
      | 'selectedSessionId'
    > & {
      readonly provisionalSessionId: Readonly<Ref<string | undefined>>;
    }) =>
      createWorkbenchSessionMessageService({
        ...message,
        workspaceTarget,
        selectedSessionId: computed(
          () =>
            sessionId.value ??
            (options.draftTarget.value?.kind === 'workspace'
              ? provisionalSessionId.value
              : undefined)
        ),
        attachments: attachments.attachments,
        attachmentsPending: computed(() =>
          attachments.attachments.value.some((item) => item.status !== 'COMPLETED')
        ),
        captureDraft,
        consumeAttachments: options.attachments.consume,
        retainAttachments: options.attachments.retainForSubmission,
        acceptRun: run.acceptRun,
        beginSubmission: submission.begin,
        scrollToLatest: scroll.scrollToLatest,
        scrollToLatestAfterLayout: scroll.scrollToLatestAfterLayout
      }),
    createInteractions: (
      interaction: Omit<
        Parameters<typeof createWorkbenchComposerInteractionController>[0],
        | 'input'
        | 'editRange'
        | 'handleConversationScroll'
        | 'scrollToLatest'
        | 'scrollToLatestAfterLayout'
      > & { readonly canLoadOlder: () => boolean }
    ) =>
      createWorkbenchComposerInteractionController({
        ...interaction,
        input: draft.input,
        editRange: (start, end, text) => editRange(start, end, text),
        handleConversationScroll: (loadOlder) =>
          scroll.handleScroll(() => {
            if (interaction.canLoadOlder()) loadOlder();
          }),
        scrollToLatest: scroll.scrollToLatest,
        scrollToLatestAfterLayout: scroll.scrollToLatestAfterLayout
      }),
    createWatch: (
      watch: Omit<
        Parameters<typeof createWorkbenchSessionWatchController>[0],
        | 'workspaceTarget'
        | 'selectedSessionId'
        | 'followConversation'
        | 'scrollAfterLayout'
        | 'applyRunsSnapshot'
      > & { readonly openRun: (runId: string) => void }
    ) =>
      createWorkbenchSessionWatchController({
        ...watch,
        workspaceTarget,
        selectedSessionId: sessionId,
        followConversation: scroll.following,
        scrollAfterLayout: scroll.scrollToLatestAfterLayout,
        applyRunsSnapshot: (values) => {
          const snapshots = values as AgentRun[];
          run.mergeAuthoritativeSnapshot(snapshots, [...run.runs.value]);
          const active = snapshots.find(
            (candidate) =>
              candidate.sessionId === sessionId.value &&
              ['STARTING', 'RUNNING', 'CANCELLING'].includes(candidate.status)
          );
          if (active !== undefined) watch.openRun(active.id);
        }
      }),
    createQueueActions: (
      actions: Omit<
        Parameters<typeof createWorkspaceQueueService>[0],
        | 'workspaceTarget'
        | 'selectedSessionId'
        | 'draggingQueueItemId'
        | 'editingContent'
        | 'serializeEditedContent'
        | 'finishEditing'
        | 'captureEditing'
      >
    ) =>
      createWorkspaceQueueService({
        ...actions,
        workspaceTarget,
        selectedSessionId: sessionId,
        draggingQueueItemId: queue.draggingQueueItemId,
        editingContent: queue.editingContent,
        serializeEditedContent: queue.serializeEditedContent,
        finishEditing: queue.finishEditing,
        captureEditing: (queueItemId) => {
          const target = options.draftTarget.value;
          const slot =
            target === undefined ? undefined : options.drafts.forTarget(target, options.pane);
          const captured = slot?.queueEdit.value;
          return () => {
            if (
              slot === undefined ||
              captured?.queueItemId !== queueItemId ||
              slot.queueEdit.value !== captured
            )
              return;
            slot.queueEdit.value = undefined;
            slot.persist();
          };
        }
      }),
    projectQueue: (queue: Readonly<Ref<WorkspaceQueue>>) =>
      computed<WorkspaceQueue>(() => ({
        ...queue.value,
        items:
          sessionId.value === undefined
            ? []
            : queue.value.items.filter((item) => item.sessionId === sessionId.value)
      })),
    createApprovals: (
      approval: Omit<Parameters<typeof createWorkbenchApprovalService>[0], 'workspaceTarget'>
    ) => createWorkbenchApprovalService({ ...approval, workspaceTarget }),
    createConfiguration: (
      configuration: Omit<
        Parameters<typeof createComposerConfigurationService>[0],
        'selectedSession'
      > & {
        readonly sessions: Readonly<Ref<readonly Session[]>>;
        readonly provisionalSessionId?: Readonly<Ref<string | undefined>>;
      }
    ) => {
      const { sessions, provisionalSessionId, ...shared } = configuration;
      const selectedSession = computed(() => {
        const id =
          sessionId.value ??
          (options.draftTarget.value?.kind === 'workspace'
            ? provisionalSessionId?.value
            : undefined);
        return (
          sessions.value.find(
            (candidate) =>
              candidate.id === id && candidate.workspaceId === workspaceTarget.value?.workspaceId
          ) ?? resolvedSession.value
        );
      });
      return {
        selectedSession,
        ...createComposerConfigurationService({ ...shared, selectedSession })
      };
    },
    createRunnerInteraction: (
      interaction: Omit<
        Parameters<typeof createRunnerInteractionService>[0],
        'input' | 'draftSessionOpen'
      >
    ) =>
      createRunnerInteractionService({
        ...interaction,
        input: draft.input,
        draftSessionOpen: computed(() => options.draftTarget.value?.kind === 'workspace')
      }),
    createUserInput: (
      input: Omit<
        NonNullable<Parameters<typeof createConversationUserInputService>[0]>,
        'workspaceTarget'
      >
    ) => createConversationUserInputService({ ...input, workspaceTarget }),
    createRealtime: (
      realtime: Omit<
        Parameters<typeof createWorkbenchConversationRealtimeService>[0],
        'workspaceTarget' | 'selectedSessionId' | 'selectedRunId' | 'runs' | 'channelToken'
      >
    ) =>
      createWorkbenchConversationRealtimeService({
        ...realtime,
        workspaceTarget,
        selectedSessionId: sessionId,
        selectedRunId: run.selectedRunId,
        runs: run.runs,
        channelToken: conversation.channelToken
      }),
    createRunnerChannel: (
      channel: Omit<
        Parameters<typeof createWorkbenchRunnerChannelService>[0],
        'workspaceTarget' | 'token' | 'input' | 'currentRevision'
      >
    ) =>
      createWorkbenchRunnerChannelService({
        ...channel,
        workspaceTarget,
        token: conversation.channelToken,
        input: conversation.channelInput,
        currentRevision: conversation.currentDetailRequest
      }),
    createPlan: (
      plan: Omit<
        Parameters<typeof createWorkbenchPlanService>[0],
        'workspaceTarget' | 'selectedSessionId' | 'input' | 'beginSubmission' | 'currentRevision'
      >
    ) =>
      createWorkbenchPlanService({
        ...plan,
        workspaceTarget,
        selectedSessionId: sessionId,
        input: draft.input,
        beginSubmission: submission.begin,
        currentRevision: conversation.currentDetailRequest
      }),
    createContextCommands: (
      commands: Omit<
        Parameters<typeof createWorkbenchContextCommandService>[0],
        'workspaceTarget' | 'beginSubmission' | 'currentRevision'
      >
    ) =>
      createWorkbenchContextCommandService({
        ...commands,
        workspaceTarget,
        beginSubmission: submission.begin,
        currentRevision: conversation.currentDetailRequest
      }),
    createHistoryMutation: (
      history: Omit<
        Parameters<typeof createWorkbenchSessionHistoryMutationService>[0],
        'current' | 'currentRevision' | 'beginSubmission' | 'draft'
      > & {
        readonly selectedSession: Readonly<Ref<Session | undefined>>;
        readonly onDraftFilled: (text: string, operation: 'rewind' | 'rollback') => void;
      }
    ) => {
      const { selectedSession, onDraftFilled, ...shared } = history;
      return createWorkbenchSessionHistoryMutationService({
        ...shared,
        current: () => {
          const target = workspaceTarget.value;
          const session = selectedSession.value;
          return scope?.active === false ||
            target === undefined ||
            session === undefined ||
            session.id !== sessionId.value ||
            session.workspaceId !== target.workspaceId
            ? undefined
            : { nodeId: target.nodeId, session };
        },
        currentRevision: conversation.currentDetailRequest,
        beginSubmission: (context) => submission.begin(context, undefined, null),
        draft: {
          read: () => draft.input.value,
          restore: (text) => {
            draft.input.value = text;
          },
          fill: (text, operation) => {
            draft.input.value = text;
            onDraftFilled(text, operation);
          }
        }
      });
    },
    createRunControl: (
      control: Omit<
        Parameters<typeof createWorkbenchRunControlService>[0],
        'workspaceTarget' | 'selectedSessionId' | 'selectedRunId' | 'runService' | 'currentRevision'
      >
    ) =>
      createWorkbenchRunControlService({
        ...control,
        workspaceTarget,
        selectedSessionId: sessionId,
        selectedRunId: run.selectedRunId,
        runService: run,
        currentRevision: conversation.currentDetailRequest
      }),
    createConversationWindow: (
      window: Omit<
        Parameters<typeof createWorkbenchConversationComposition>[0],
        | 'workspaceTarget'
        | 'selectedSessionId'
        | 'turns'
        | 'nextCursor'
        | 'loadingOlder'
        | 'capturePrependAnchor'
        | 'projection'
      >
    ) =>
      createWorkbenchConversationComposition({
        ...window,
        workspaceTarget,
        selectedSessionId: sessionId,
        turns: conversation.turns,
        nextCursor: conversation.nextCursor,
        loadingOlder: conversation.loadingOlder,
        capturePrependAnchor: scroll.capturePrependAnchor,
        projection: conversation.projection
      }),
    draggingAttachments: ref(false),
    captureDetail,
    restoreDetail,
    saveCachedSession,
    restoreCachedSession,
    prepareSession,
    hasContent: () => conversation.turns.value.some((turn) => turn.items.length > 0),
    queue,
    submission,
    scroll,
    setInputFocus: (focus: typeof focusInput) => (focusInput = focus),
    focusInput: (cursor: number) => focusInput(cursor),
    setRangeEditor: (edit: typeof editRange) => (editRange = edit),
    editRange: (start: number, end: number, text: string) => editRange(start, end, text)
  };
}
