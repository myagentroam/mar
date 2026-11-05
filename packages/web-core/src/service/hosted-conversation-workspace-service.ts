import {
  createHostedConversationDirectoryService,
  mergeConversationSummary,
  targetKey
} from './hosted-conversation-directory-service.js';
import {
  conversationFileProjectionSchema,
  hostedConversationDeleteResultSchema,
  hostedConversationHistoryPageSchema,
  hostedConversationSnapshotSchema,
  hostedConversationSummarySchema,
  hostedConversationTemplateSwitchResultSchema,
  type ConversationFileProjection,
  type HostedConversationSnapshot,
  type HostedConversationSummary
} from '@myagentroam/protocol';
import { computed, ref, type Ref } from 'vue';
import type {
  ConversationItem as WorkbenchConversationItem,
  ConversationTurn as WorkbenchConversationTurn
} from '../model/workbench.js';
import type { HostedConversationView } from '../model/hosted-conversation-view.js';
import { limitConversationHistory } from '../util/conversation-history.js';
import { errorCode } from '../util/api-error.js';
import { listAvailableConversationTemplates } from './hosted-conversation-template-client.js';
import { createConversationProjectionState } from './conversation-projection-service.js';
import { createHostedConversationFileService } from './hosted-conversation-file-service.js';
import { createHostedConversationWatchService } from './hosted-conversation-watch-service.js';
import { createWorkbenchSubmissionService } from './workbench-submission-service.js';

export type HostedConversationRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export function hostedConversationFileForPath(
  files: readonly ConversationFileProjection[],
  path: string
): ConversationFileProjection | undefined {
  const slashNormalized = path.replaceAll('\\', '/');
  const absolute = slashNormalized.startsWith('/');
  const normalized = slashNormalized.replace(/^\/+/u, '');
  const parts = normalized.split('/');
  if (
    parts.length === 0 ||
    parts.some((part) => part.length === 0 || part === '.' || part === '..')
  )
    return undefined;
  if (absolute) {
    if (parts[0] !== 'workspace') return undefined;
    parts.shift();
  }
  const prefix = parts[0];
  const category = prefix === 'output' ? 'OUTPUT' : prefix === 'inbox' ? 'UPLOAD' : undefined;
  if (category !== undefined) {
    const relativePath = parts.slice(1).join('/');
    if (relativePath.length === 0) return undefined;
    return files.find((file) => file.category === category && file.relativePath === relativePath);
  }
  if (absolute) return undefined;
  const relativePath = parts.join('/');
  const matches = files.filter((file) => file.relativePath === relativePath);
  return matches.length === 1 ? matches[0] : undefined;
}

interface HostedConversationWorkspaceServiceOptions {
  readonly request: HostedConversationRequest;
  readonly workbenchConnectionId: () => string | undefined;
  readonly selectedNodeId?: Ref<string | undefined>;
  readonly selectedConversationId?: Ref<string | undefined>;
  readonly heartbeatMs: number;
  readonly requestTimeoutMs: number;
  readonly confirmationTimeoutMs: number;
  readonly pageSize?: number;
  readonly onWatchExpired?: () => void;
}

/** Owns the Node directory, selected hosted conversation, and its single page Watch lease. */
export function createHostedConversationWorkspaceService(
  options: HostedConversationWorkspaceServiceOptions
) {
  const selectedNodeId = options.selectedNodeId ?? ref<string>();
  const selectedConversationId = options.selectedConversationId ?? ref<string>();
  const snapshotMetadata = ref<Omit<HostedConversationSnapshot, 'turns'>>();
  const loadingOlderHistory = ref(false);
  const olderHistoryError = ref<unknown>();
  const {
    turns: projectedTurns,
    nextCursor: projectionNextCursor,
    projection: conversationProjection
  } = createConversationProjectionState({
    onRecentWindowOverflow: () => {
      historyWindowRevision += 1;
      olderHistoryError.value = undefined;
      loadingOlderHistory.value = false;
      historyExpanded = false;
      recentHistoryRefresh = undefined;
      void refreshRecentHistoryWindow();
    },
    limitHistory: limitConversationHistory
  });
  const snapshot = computed<HostedConversationView | undefined>(() =>
    snapshotMetadata.value === undefined
      ? undefined
      : { ...snapshotMetadata.value, turns: projectedTurns.value }
  );
  const directory = createHostedConversationDirectoryService({
    request: options.request,
    selectedNodeId,
    selectedConversationId,
    pageSize: options.pageSize ?? 20,
    onActivity: (nodeId, conversationId, activity) => {
      const current = snapshot.value;
      if (
        current?.conversation.nodeId === nodeId &&
        current.conversation.id === conversationId &&
        activity.version > current.conversation.activity.version
      )
        replaceSnapshot({ ...current, conversation: { ...current.conversation, activity } });
    }
  });
  const {
    conversations,
    hasMoreConversations,
    loadingConversations,
    loadingMoreConversations,
    loadMoreConversationsError,
    conversationsLoaded,
    loadConversations,
    loadMoreConversations,
    projectActivityMessage,
    conversationIsRunning,
    upsertConversation
  } = directory;

  const watch = createHostedConversationWatchService({
    request: options.request,
    workbenchConnectionId: options.workbenchConnectionId,
    selectedNodeId,
    selectedConversationId,
    heartbeatMs: options.heartbeatMs,
    requestTimeoutMs: options.requestTimeoutMs,
    confirmationTimeoutMs: options.confirmationTimeoutMs,
    ...(options.onWatchExpired === undefined ? {} : { onWatchExpired: options.onWatchExpired }),
    installSnapshot,
    applyHostedPayload
  });
  const {
    watchReady,
    watchFailureCode,
    watchFailure,
    watchLoading,
    selectedWatchId,
    beginSelectedConversationWatch,
    restartSelectedConversationWatch,
    pauseSelectedConversationWatch,
    stopSelectedConversationWatch,
    handleVisibility,
    handleWatchEvent
  } = watch;

  const messageSubmission = createWorkbenchSubmissionService();
  const templateChanges = ref(new Set<string>());
  const templateChanging = computed(() => {
    const target = selectedTarget();
    return target !== undefined && templateChanges.value.has(target);
  });
  let historyRevision = 0;
  let historyExpanded = false;
  let historyWindowRevision = 0;
  let recentHistoryRefresh: Promise<void> | undefined;

  function responseInvalid(): Error {
    return new Error('HOSTED_CONVERSATION_RESPONSE_INVALID');
  }

  function selectedTarget(): string | undefined {
    const nodeId = selectedNodeId.value;
    const conversationId = selectedConversationId.value;
    return nodeId === undefined || conversationId === undefined
      ? undefined
      : targetKey(nodeId, conversationId);
  }

  function selectConversation(
    nodeId: string,
    conversationId: string,
    initialSnapshot?: HostedConversationSnapshot
  ): void {
    if (
      initialSnapshot !== undefined &&
      (initialSnapshot.conversation.nodeId !== nodeId ||
        initialSnapshot.conversation.id !== conversationId)
    )
      throw responseInvalid();
    if (selectedNodeId.value === nodeId && selectedConversationId.value === conversationId) {
      if (initialSnapshot !== undefined) installSnapshot(nodeId, conversationId, initialSnapshot);
      return;
    }
    stopSelectedConversationWatch();
    selectedConversationId.value = undefined;
    snapshotMetadata.value = undefined;
    conversationProjection.restoreWindow([], null);
    loadingOlderHistory.value = false;
    historyExpanded = false;
    historyWindowRevision += 1;
    olderHistoryError.value = undefined;
    recentHistoryRefresh = undefined;
    watch.clearFailure();
    if (initialSnapshot !== undefined) installSnapshot(nodeId, conversationId, initialSnapshot);
    selectedNodeId.value = nodeId;
    selectedConversationId.value = conversationId;
  }

  function clearSelectedConversation(): void {
    stopSelectedConversationWatch();
    selectedConversationId.value = undefined;
    selectedNodeId.value = undefined;
    snapshotMetadata.value = undefined;
    conversationProjection.restoreWindow([], null);
    loadingOlderHistory.value = false;
    historyExpanded = false;
    historyWindowRevision += 1;
    olderHistoryError.value = undefined;
    recentHistoryRefresh = undefined;
    watch.clearFailure();
  }

  function installSnapshot(
    nodeId: string,
    conversationId: string,
    value: HostedConversationSnapshot,
    replaceHistory = snapshot.value === undefined
  ): void {
    if (value.conversation.nodeId !== nodeId || value.conversation.id !== conversationId)
      throw responseInvalid();
    const page = {
      turns: projectHostedTurns(value.turns),
      nextCursor: value.historyNextCursor,
      source: 'official' as const,
      snapshotSequence: value.snapshotSequence,
      readAt: Date.now()
    };
    if (replaceHistory) {
      historyWindowRevision += 1;
      loadingOlderHistory.value = false;
      olderHistoryError.value = undefined;
      historyExpanded = false;
      conversationProjection.replaceAuthoritative(page);
    } else
      conversationProjection.mergeLatest({
        ...page,
        nextCursor: historyExpanded ? projectionNextCursor.value : page.nextCursor
      });
    replaceSnapshot(
      { ...value, turns: projectedTurns.value, historyNextCursor: projectionNextCursor.value },
      true
    );
    upsertConversation(value.conversation);
  }

  async function loadOlderHistory(): Promise<void> {
    const context = requireSelectedContext();
    const cursor = projectionNextCursor.value;
    const revision = historyWindowRevision;
    if (cursor === null || loadingOlderHistory.value) return;
    loadingOlderHistory.value = true;
    olderHistoryError.value = undefined;
    try {
      const parsed = hostedConversationHistoryPageSchema.safeParse(
        await options.request<unknown>(
          `${conversationBasePath(context)}/history?limit=10&cursor=${encodeURIComponent(cursor)}`
        )
      );
      if (!parsed.success) throw responseInvalid();
      if (
        !sameSelectedContext(context) ||
        historyWindowRevision !== revision ||
        snapshot.value === undefined ||
        projectionNextCursor.value !== cursor
      )
        return;
      const older = projectHostedTurns(parsed.data.turns);
      conversationProjection.mergeOlderPage({
        turns: older,
        nextCursor: parsed.data.nextCursor
      });
      historyExpanded = true;
      conversationProjection.restore(projectedTurns.value);
      commitHistoryMetadata({ ...snapshot.value, historyNextCursor: parsed.data.nextCursor });
    } catch (error) {
      if (
        sameSelectedContext(context) &&
        historyWindowRevision === revision &&
        projectionNextCursor.value === cursor
      )
        olderHistoryError.value = error;
    } finally {
      if (historyWindowRevision === revision) loadingOlderHistory.value = false;
    }
  }

  function refreshRecentHistoryWindow(): Promise<void> {
    if (recentHistoryRefresh !== undefined) return recentHistoryRefresh;
    const revision = historyWindowRevision;
    const operation = (async () => {
      const context = requireSelectedContext();
      const parsed = hostedConversationHistoryPageSchema.safeParse(
        await options.request<unknown>(`${conversationBasePath(context)}/history?limit=10`)
      );
      if (
        !parsed.success ||
        !sameSelectedContext(context) ||
        historyWindowRevision !== revision ||
        snapshot.value === undefined
      )
        return;
      conversationProjection.replaceAuthoritative({
        turns: projectHostedTurns(parsed.data.turns),
        nextCursor: parsed.data.nextCursor,
        source: 'official',
        readAt: Date.now()
      });
      commitHistoryMetadata({ ...snapshot.value, historyNextCursor: parsed.data.nextCursor });
    })()
      .catch(() => undefined)
      .finally(() => {
        if (recentHistoryRefresh === operation) recentHistoryRefresh = undefined;
      });
    recentHistoryRefresh = operation;
    return operation;
  }

  function applyHostedPayload(payload: Record<string, unknown>, sourceSequence: number): void {
    const current = snapshot.value;
    if (current === undefined) return;
    if (payload.kind === 'template-changed' && payload.conversationId === current.conversation.id) {
      void refreshTemplateBinding(requireSelectedContext(), selectedWatchId());
      return;
    }
    if (payload.kind === 'runtime' && record(payload.runtimeEvent)) {
      applyRuntimeEvent(current, payload.runtimeEvent, sourceSequence);
      return;
    }
    if (payload.kind === 'files' && Array.isArray(payload.files)) {
      const files = new Map<string, ConversationFileProjection>();
      for (const raw of payload.files) {
        const parsed = conversationFileProjectionSchema.safeParse(raw);
        if (!parsed.success || parsed.data.conversationId !== current.conversation.id) return;
        files.set(parsed.data.id, parsed.data);
      }
      if (payload.error !== null && !validSnapshotError(payload.error)) return;
      replaceSnapshot({
        ...current,
        files: [...files.values()],
        error: payload.error as HostedConversationSnapshot['error']
      });
      return;
    }
    if (
      (payload.kind === 'configuration' || payload.kind === 'conversation') &&
      payload.conversation !== undefined
    ) {
      const parsed = hostedConversationSummarySchema.safeParse(payload.conversation);
      if (
        !parsed.success ||
        parsed.data.id !== current.conversation.id ||
        parsed.data.nodeId !== current.conversation.nodeId
      )
        return;
      replaceSnapshot({ ...current, conversation: parsed.data });
      upsertConversation(parsed.data);
      return;
    }
    if (payload.kind === 'upgrade' && record(payload.upgrade)) {
      const parsed = hostedConversationSummarySchema.safeParse(payload.upgrade.conversation);
      if (
        !parsed.success ||
        parsed.data.id !== current.conversation.id ||
        parsed.data.nodeId !== current.conversation.nodeId
      )
        return;
      if (payload.upgrade.error !== null && !validSnapshotError(payload.upgrade.error)) return;
      replaceSnapshot({
        ...current,
        conversation: parsed.data,
        error: payload.upgrade.error as HostedConversationSnapshot['error']
      });
      upsertConversation(parsed.data);
      return;
    }
    if (payload.kind === 'run') {
      const run = hostedConversationSnapshotSchema
        .innerType()
        .shape.run.safeParse(normalizeRun(payload.run, current.run));
      if (run.success) replaceSnapshot({ ...current, run: run.data }, true);
    }
  }

  function applyRuntimeEvent(
    current: HostedConversationView,
    runtime: Record<string, unknown>,
    sourceSequence: number
  ): void {
    if (
      (runtime.kind !== 'RUN' && runtime.kind !== 'ITEM' && runtime.kind !== 'DELTA') ||
      typeof runtime.executionId !== 'string' ||
      runtime.executionId.length === 0 ||
      !Number.isInteger(runtime.sequence) ||
      (runtime.sequence as number) < 0 ||
      !Number.isInteger(runtime.createdAt) ||
      !record(runtime.payload)
    )
      return;
    const executionId = runtime.executionId;
    const turnId =
      typeof runtime.turnId === 'string' && runtime.turnId.length > 0
        ? runtime.turnId
        : executionId;
    const createdAt = Math.max(0, runtime.createdAt as number);
    ensureRuntimeTurn(current, executionId, turnId, createdAt, sourceSequence);
    const turn = projectedTurns.value.findLast(
      (candidate) => candidate.id === turnId || candidate.runId === executionId
    );
    if (turn === undefined) return;
    if (runtime.kind === 'ITEM') {
      if (
        conversationProjection.mergeItem(
          executionId,
          runtime.payload.item,
          sourceSequence,
          createdAt
        )
      ) {
        const item = record(runtime.payload.item) ? runtime.payload.item : undefined;
        const payload = item === undefined || !record(item.payload) ? undefined : item.payload;
        if (
          item?.kind === 'user_message' &&
          typeof payload?.clientMessageId === 'string' &&
          payload.clientMessageId.length > 0
        ) {
          const authoritativeTurn = projectedTurns.value.findLast(
            (candidate) => candidate.id === turnId || candidate.runId === executionId
          );
          if (authoritativeTurn !== undefined)
            conversationProjection.mergeLatest({
              turns: [authoritativeTurn],
              nextCursor: null,
              source: 'runtime',
              snapshotSequence: sourceSequence,
              readAt: createdAt
            });
        }
        commitHistoryMetadata(current);
      }
      return;
    }
    if (runtime.kind === 'DELTA') {
      if (
        conversationProjection.mergeTextDelta(
          executionId,
          runtime.payload,
          sourceSequence,
          createdAt
        )
      )
        commitHistoryMetadata(current);
      return;
    }
    const status = runtimeStatus(runtime.payload.status);
    if (status === undefined) return;
    const terminal = terminalTurnStatus(status);
    conversationProjection.mergeLatest({
      turns: [
        {
          ...turn,
          status,
          items: terminal
            ? turn.items.map((item) =>
                item.kind === 'assistant_message' && item.status === 'IN_PROGRESS'
                  ? { ...item, status: 'COMPLETED', completedAt: createdAt }
                  : item
              )
            : turn.items,
          completedAt: terminal ? createdAt : null
        }
      ],
      nextCursor: null,
      source: 'runtime',
      snapshotSequence: sourceSequence,
      readAt: createdAt
    });
    commitHistoryMetadata(current);
  }

  function ensureRuntimeTurn(
    current: HostedConversationView,
    executionId: string,
    turnId: string,
    createdAt: number,
    sourceSequence: number
  ): void {
    if (
      projectedTurns.value.some(
        (turn) => turn.id === turnId || (turn.runId === executionId && turn.id === turnId)
      )
    )
      return;
    conversationProjection.mergeLatest({
      turns: [
        {
          id: turnId,
          sessionId: current.conversation.sessionId,
          runId: executionId,
          status: 'RUNNING',
          items: [],
          startedAt: createdAt,
          completedAt: null
        }
      ],
      nextCursor: null,
      source: 'runtime',
      snapshotSequence: sourceSequence,
      readAt: createdAt
    });
  }

  function commitHistoryMetadata(current: HostedConversationView): void {
    replaceSnapshot({ ...current, historyNextCursor: projectionNextCursor.value }, true);
  }

  function replaceSnapshot(value: HostedConversationView, historyChanged = false): void {
    const { turns: _turns, ...metadata } = value;
    snapshotMetadata.value = metadata;
    if (historyChanged) historyRevision += 1;
  }

  function requireSelectedContext(): {
    readonly nodeId: string;
    readonly conversationId: string;
    readonly snapshot: HostedConversationView;
    readonly historyRevision: number;
  } {
    const nodeId = selectedNodeId.value;
    const conversationId = selectedConversationId.value;
    const current = snapshot.value;
    if (
      nodeId === undefined ||
      conversationId === undefined ||
      current === undefined ||
      current.conversation.nodeId !== nodeId ||
      current.conversation.id !== conversationId
    )
      throw new Error('HOSTED_CONVERSATION_REQUIRED');
    return { nodeId, conversationId, snapshot: current, historyRevision };
  }

  function sameSelectedContext(context: {
    readonly nodeId: string;
    readonly conversationId: string;
  }): boolean {
    return (
      selectedNodeId.value === context.nodeId &&
      selectedConversationId.value === context.conversationId
    );
  }

  function conversationBasePath(context: {
    readonly nodeId: string;
    readonly conversationId: string;
  }): string {
    return `/api/nodes/${encodeURIComponent(context.nodeId)}/hosted-conversations/${encodeURIComponent(context.conversationId)}`;
  }

  function parseConversationResponse(
    value: unknown,
    context: {
      readonly nodeId: string;
      readonly conversationId: string;
      readonly snapshot: HostedConversationView;
    },
    includeRun: boolean
  ): Pick<HostedConversationSnapshot, 'conversation' | 'run'> {
    if (
      !record(value) ||
      !exactKeys(value, includeRun ? ['conversation', 'run'] : ['conversation'])
    )
      throw responseInvalid();
    const conversation = hostedConversationSummarySchema.safeParse(value.conversation);
    const run = hostedConversationSnapshotSchema
      .innerType()
      .shape.run.safeParse(includeRun ? value.run : context.snapshot.run);
    if (
      !conversation.success ||
      !run.success ||
      conversation.data.nodeId !== context.nodeId ||
      conversation.data.id !== context.conversationId
    )
      throw responseInvalid();
    return { conversation: conversation.data, run: run.data };
  }

  function parseConversationSummaryResponse(
    value: unknown,
    nodeId: string,
    conversationId: string
  ): HostedConversationSummary {
    if (!record(value) || !exactKeys(value, ['conversation'])) throw responseInvalid();
    const parsed = hostedConversationSummarySchema.safeParse(value.conversation);
    if (!parsed.success || parsed.data.nodeId !== nodeId || parsed.data.id !== conversationId)
      throw responseInvalid();
    return parsed.data;
  }

  async function sendMessage(input: {
    readonly prompt: string;
    readonly attachmentIds: readonly string[];
    readonly clientMessageId: string;
    readonly modelId?: string;
    readonly deliveryIntent?: 'REPLACE_CURRENT';
  }): Promise<NonNullable<HostedConversationSnapshot['run']>> {
    const context = requireSelectedContext();
    if (templateChanging.value) throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    if (!watchReady.value) throw new Error('HOSTED_CONVERSATION_WATCH_NOT_READY');
    const finishSubmission = messageSubmission.begin(
      hostedConversationSubmissionContext(context.nodeId, context.conversationId)
    );
    if (finishSubmission === undefined)
      throw new Error('HOSTED_CONVERSATION_MESSAGE_SUBMISSION_ACTIVE');
    projectOptimisticUserMessage(context.snapshot, input);
    try {
      const response = await options.request<unknown>(`${conversationBasePath(context)}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          clientMessageId: input.clientMessageId,
          prompt: input.prompt,
          attachmentIds: [...input.attachmentIds],
          ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
          ...(input.deliveryIntent === undefined ? {} : { deliveryIntent: input.deliveryIntent })
        })
      });
      const next = parseConversationResponse(response, context, true);
      if (next.run === null) throw responseInvalid();
      if (sameSelectedContext(context) && snapshot.value !== undefined) {
        if (conversationProjection.updateOptimisticUserMessage(input.clientMessageId))
          commitHistoryMetadata(snapshot.value);
        const conversation = mergeConversationSummary(
          next.conversation,
          snapshot.value.conversation
        );
        replaceSnapshot(
          {
            ...snapshot.value,
            conversation,
            run: normalizeRun(next.run, snapshot.value.run)
          },
          true
        );
        upsertConversation(conversation);
      }
      return next.run;
    } catch (error) {
      if (sameSelectedContext(context) && snapshot.value !== undefined)
        if (conversationProjection.removeOptimisticUserMessage(input.clientMessageId))
          commitHistoryMetadata(snapshot.value);
      throw error;
    } finally {
      finishSubmission();
    }
  }

  function projectOptimisticUserMessage(
    current: HostedConversationView,
    input: {
      readonly prompt: string;
      readonly clientMessageId: string;
    }
  ): void {
    const createdAt = Date.now();
    conversationProjection.mergeLatest({
      turns: [
        {
          id: input.clientMessageId,
          sessionId: current.conversation.sessionId,
          runId: null,
          status: 'PREPARING',
          items: [
            {
              id: input.clientMessageId,
              kind: 'user_message',
              status: 'COMPLETED',
              payload: {
                clientMessageId: input.clientMessageId,
                text: input.prompt,
                contexts: [],
                delivery: 'PENDING'
              },
              startedAt: createdAt,
              completedAt: createdAt
            }
          ],
          startedAt: createdAt,
          completedAt: null
        }
      ],
      nextCursor: null,
      source: 'runtime',
      readAt: createdAt
    });
    commitHistoryMetadata(current);
  }

  async function updateConfiguration(input: {
    readonly modelId: string;
  }): Promise<HostedConversationSummary> {
    const context = requireSelectedContext();
    if (templateChanging.value) throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    const response = await options.request<unknown>(`${conversationBasePath(context)}/config`, {
      method: 'PATCH',
      body: JSON.stringify({ modelId: input.modelId })
    });
    const next = parseConversationResponse(response, context, false);
    if (sameSelectedContext(context) && snapshot.value !== undefined) {
      const conversation = mergeConversationSummary(next.conversation, snapshot.value.conversation);
      replaceSnapshot({ ...snapshot.value, conversation });
      upsertConversation(conversation);
    }
    return next.conversation;
  }

  async function rollback(
    turnId: string,
    boundary: string | null,
    itemId?: string
  ): Promise<HostedConversationSnapshot> {
    const context = requireSelectedContext();
    if (templateChanging.value) throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    const parsed = hostedConversationSnapshotSchema.safeParse(
      await options.request<unknown>(`${conversationBasePath(context)}/rollback`, {
        method: 'POST',
        body: JSON.stringify({ turnId, boundary, ...(itemId === undefined ? {} : { itemId }) })
      })
    );
    if (
      !parsed.success ||
      parsed.data.conversation.nodeId !== context.nodeId ||
      parsed.data.conversation.id !== context.conversationId ||
      parsed.data.conversation.sessionId !== context.snapshot.conversation.sessionId ||
      parsed.data.conversation.templateId !== context.snapshot.conversation.templateId ||
      parsed.data.template.id !== context.snapshot.template.id ||
      parsed.data.template.nodeId !== context.nodeId
    )
      throw responseInvalid();
    const current = snapshot.value;
    if (sameSelectedContext(context) && current !== undefined) {
      if (current === context.snapshot)
        installSnapshot(context.nodeId, context.conversationId, parsed.data, true);
      else if (
        current.conversation.nodeId === context.nodeId &&
        current.conversation.id === context.conversationId &&
        historyRevision === context.historyRevision
      )
        installSnapshot(
          context.nodeId,
          context.conversationId,
          {
            ...parsed.data,
            nodeAppVersion: current.nodeAppVersion ?? parsed.data.nodeAppVersion,
            conversation: mergeConversationSummary(parsed.data.conversation, current.conversation),
            template: current.template,
            files: current.files,
            models: current.models,
            error: current.error
          },
          true
        );
    }
    return parsed.data;
  }

  async function updateMetadata(
    input: {
      readonly title?: string;
      readonly pinned?: boolean;
    },
    targetNodeId = selectedNodeId.value,
    targetConversationId = selectedConversationId.value
  ): Promise<HostedConversationSummary> {
    if (targetNodeId === undefined || targetConversationId === undefined)
      throw new Error('HOSTED_CONVERSATION_REQUIRED');
    const target = { nodeId: targetNodeId, conversationId: targetConversationId };
    const response = await options.request<unknown>(conversationBasePath(target), {
      method: 'PATCH',
      body: JSON.stringify({
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.pinned === undefined ? {} : { pinned: input.pinned })
      })
    });
    const conversation = parseConversationSummaryResponse(
      response,
      targetNodeId,
      targetConversationId
    );
    if (sameSelectedContext(target) && snapshot.value !== undefined) {
      const merged = mergeConversationSummary(conversation, snapshot.value.conversation);
      replaceSnapshot({ ...snapshot.value, conversation: merged });
      upsertConversation(merged);
      return merged;
    }
    upsertConversation(conversation);
    return conversation;
  }

  async function interrupt(): Promise<boolean> {
    const context = requireSelectedContext();
    const response = await options.request<unknown>(`${conversationBasePath(context)}/interrupt`, {
      method: 'POST',
      body: '{}'
    });
    if (
      !record(response) ||
      !exactKeys(response, ['interrupted']) ||
      typeof response.interrupted !== 'boolean'
    )
      throw responseInvalid();
    return response.interrupted;
  }

  async function deleteConversation(
    targetNodeId = selectedNodeId.value,
    targetConversationId = selectedConversationId.value
  ): Promise<{ readonly deletedConversationId: string }> {
    if (targetNodeId === undefined || targetConversationId === undefined)
      throw new Error('HOSTED_CONVERSATION_REQUIRED');
    const target = { nodeId: targetNodeId, conversationId: targetConversationId };
    const restartWatchOnFailure = sameSelectedContext(target) && selectedWatchId() !== undefined;
    if (sameSelectedContext(target)) stopSelectedConversationWatch();
    let deletedConversationId: string;
    try {
      const parsed = hostedConversationDeleteResultSchema.safeParse(
        await options.request<unknown>(conversationBasePath(target), {
          method: 'DELETE',
          body: '{}'
        })
      );
      if (!parsed.success || parsed.data.deletedConversationId !== targetConversationId)
        throw responseInvalid();
      deletedConversationId = parsed.data.deletedConversationId;
    } catch (error) {
      if (restartWatchOnFailure && sameSelectedContext(target)) {
        void restartSelectedConversationWatch().catch(() => undefined);
      }
      throw error;
    }
    directory.remove(targetNodeId, targetConversationId);
    if (sameSelectedContext(target)) clearSelectedConversation();
    return { deletedConversationId };
  }

  async function listTemplateOptions() {
    const context = requireSelectedContext();
    const templates = await listAvailableConversationTemplates(options.request);
    return templates.filter((template) => template.nodeId === context.nodeId && template.available);
  }

  async function refreshTemplateBinding(
    context: { readonly nodeId: string; readonly conversationId: string },
    originalWatchId: string | undefined
  ): Promise<void> {
    if (!sameSelectedContext(context) || selectedWatchId() !== originalWatchId) return;
    try {
      await restartSelectedConversationWatch();
    } catch (error) {
      if (sameSelectedContext(context)) {
        watch.markRestartFailure(error);
      }
    }
  }

  async function switchTemplate(templateId: string, expectedTemplateId: string): Promise<void> {
    const context = requireSelectedContext();
    const conversation = context.snapshot.conversation;
    if (conversation.templateId === templateId) return;
    if (conversation.templateId !== expectedTemplateId)
      throw new Error('HOSTED_CONVERSATION_TEMPLATE_CONFLICT');
    if (
      conversation.status !== 'ACTIVE' ||
      !watchReady.value ||
      context.snapshot.run !== null ||
      conversation.activity.status !== 'IDLE' ||
      templateChanging.value ||
      (messageSubmission.pending.value &&
        messageSubmission.context.value ===
          hostedConversationSubmissionContext(context.nodeId, context.conversationId))
    )
      throw new Error('HOSTED_CONVERSATION_STATE_INVALID');
    const key = targetKey(context.nodeId, context.conversationId);
    const originalWatchId = selectedWatchId();
    templateChanges.value.add(key);
    try {
      const parsed = hostedConversationTemplateSwitchResultSchema.safeParse(
        await options.request<unknown>(`${conversationBasePath(context)}/template`, {
          method: 'POST',
          body: JSON.stringify({ templateId, expectedTemplateId })
        })
      );
      if (
        !parsed.success ||
        parsed.data.conversation.id !== context.conversationId ||
        parsed.data.conversation.nodeId !== context.nodeId ||
        parsed.data.conversation.sessionId !== conversation.sessionId ||
        parsed.data.template.id !== templateId
      )
        throw responseInvalid();
      await refreshTemplateBinding(context, originalWatchId);
    } catch (error) {
      const code = errorCode(error);
      if (
        code === undefined ||
        [
          'HOSTED_CONVERSATION_TEMPLATE_CONFLICT',
          'HOSTED_CONVERSATION_RESPONSE_INVALID',
          'NODE_REQUEST_TIMEOUT',
          'NODE_OFFLINE',
          'NODE_SEND_FAILED',
          'NODE_CONTROL_CLOSED',
          'NODE_RESPONSE_INVALID',
          'INTERNAL_ERROR',
          'REQUEST_FAILED_500',
          'REQUEST_FAILED_502',
          'REQUEST_FAILED_503',
          'REQUEST_FAILED_504'
        ].includes(code)
      )
        await refreshTemplateBinding(context, originalWatchId);
      throw error;
    } finally {
      templateChanges.value.delete(key);
    }
  }

  const { deleteFile, readFile, contentUrl, uploadFile } = createHostedConversationFileService({
    request: options.request,
    requireContext: requireSelectedContext,
    templateChanging: () => templateChanging.value,
    removeFile: (context, fileId) => {
      if (sameSelectedContext(context) && snapshot.value !== undefined)
        replaceSnapshot({
          ...snapshot.value,
          files: snapshot.value.files.filter((file) => file.id !== fileId)
        });
    },
    acceptFile: (context, file) => {
      if (sameSelectedContext(context) && snapshot.value !== undefined) {
        const files = new Map(snapshot.value.files.map((candidate) => [candidate.id, candidate]));
        files.set(file.id, file);
        replaceSnapshot({ ...snapshot.value, files: [...files.values()] });
      }
    }
  });

  return {
    conversations,
    hasMoreConversations,
    loadingConversations,
    loadingMoreConversations,
    loadMoreConversationsError,
    conversationsLoaded,
    selectedNodeId,
    selectedConversationId,
    snapshot,
    turns: projectedTurns,
    historyNextCursor: projectionNextCursor,
    loadingOlderHistory,
    olderHistoryError,
    watchReady,
    watchFailureCode,
    selectedWatchId,
    watchFailure,
    watchLoading,
    messageSubmitting: messageSubmission.pending,
    messageSubmissionContext: messageSubmission.context,
    templateChanging,
    listTemplateOptions,
    switchTemplate,
    loadConversations,
    loadMoreConversations,
    projectActivityMessage,
    conversationIsRunning,
    rememberConversation: upsertConversation,
    selectConversation,
    clearSelectedConversation,
    beginSelectedConversationWatch,
    restartSelectedConversationWatch,
    pauseSelectedConversationWatch,
    stopSelectedConversationWatch,
    handleWatchEvent,
    handleVisibility,
    loadOlderHistory,
    sendMessage,
    rollback,
    updateConfiguration,
    updateMetadata,
    interrupt,
    deleteConversation,
    deleteFile,
    readFile,
    contentUrl,
    uploadFile
  };
}

function normalizeRun(
  value: unknown,
  previous: HostedConversationSnapshot['run']
): HostedConversationSnapshot['run'] {
  if (!record(value) || typeof value.id !== 'string') return previous;
  const status = hostedRunStatus(value.status);
  if (status === undefined) return previous;
  if (previous?.id === value.id) {
    const previousRank = hostedRunStatusRank(previous.status);
    if (previousRank === 3 || hostedRunStatusRank(status) < previousRank) return previous;
  }
  const startedAt =
    value.startedAt === null ||
    (Number.isInteger(value.startedAt) && (value.startedAt as number) >= 0)
      ? (value.startedAt as number | null)
      : (previous?.startedAt ?? null);
  const completedAt =
    value.completedAt === null ||
    (Number.isInteger(value.completedAt) && (value.completedAt as number) >= 0)
      ? (value.completedAt as number | null)
      : (previous?.completedAt ?? null);
  return { id: value.id, status, startedAt, completedAt };
}

function hostedRunStatusRank(
  status: NonNullable<HostedConversationSnapshot['run']>['status']
): number {
  if (status === 'STARTING') return 0;
  if (status === 'RUNNING') return 1;
  if (status === 'CANCELLING') return 2;
  return 3;
}

function hostedRunStatus(
  value: unknown
): NonNullable<HostedConversationSnapshot['run']>['status'] | undefined {
  if (
    value === 'STARTING' ||
    value === 'RUNNING' ||
    value === 'CANCELLING' ||
    value === 'SUCCEEDED' ||
    value === 'FAILED' ||
    value === 'CANCELLED' ||
    value === 'INTERRUPTED'
  )
    return value;
  return undefined;
}

function validSnapshotError(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, ['code', 'message']) &&
    typeof value.code === 'string' &&
    /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code) &&
    typeof value.message === 'string' &&
    value.message.length > 0 &&
    value.message.length <= 1000
  );
}

function projectHostedTurns(
  turns: HostedConversationSnapshot['turns']
): WorkbenchConversationTurn[] {
  return turns.map((turn) => {
    const projected: WorkbenchConversationTurn = {
      id: turn.id,
      sessionId: turn.sessionId,
      runId: turn.runId,
      status: turn.status,
      ...(turn.rewind === undefined ? {} : { rewind: turn.rewind }),
      items: turn.items.map((item) => {
        const projectedItem: WorkbenchConversationItem = {
          id: item.id,
          kind: item.kind,
          status: item.status,
          payload: item.payload,
          startedAt: item.startedAt,
          completedAt: item.completedAt,
          ...(item.processGroup === undefined ? {} : { processGroup: item.processGroup }),
          ...(item.segmentId === undefined ? {} : { segmentId: item.segmentId }),
          ...(item.segmentIndex === undefined ? {} : { segmentIndex: item.segmentIndex })
        };
        return Object.assign(projectedItem, {
          sessionId: item.sessionId,
          turnId: item.turnId,
          runId: item.runId,
          parentItemId: item.parentItemId,
          sourceSequence: item.sourceSequence,
          revision: item.revision
        });
      }),
      startedAt: turn.startedAt,
      completedAt: turn.completedAt
    };
    return Object.assign(projected, {
      userItemId: turn.userItemId,
      model: turn.model,
      effort: turn.effort,
      access: turn.access
    });
  });
}

function runtimeStatus(value: unknown): WorkbenchConversationTurn['status'] | undefined {
  if (value === 'RUNNING' || value === 'SUCCEEDED' || value === 'FAILED' || value === 'INTERRUPTED')
    return value;
  return undefined;
}

function terminalTurnStatus(status: WorkbenchConversationTurn['status']): boolean {
  return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'LOST'].includes(status);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function hostedConversationSubmissionContext(
  nodeId: string,
  conversationId: string
): string {
  return targetKey(nodeId, conversationId);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
