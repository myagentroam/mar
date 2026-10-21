import {
  conversationFileProjectionSchema,
  hostedConversationDeleteResultSchema,
  hostedConversationDirectoryPageSchema,
  hostedConversationActivityMessageSchema,
  hostedConversationFileDeleteResultSchema,
  hostedConversationFileReadResultSchema,
  hostedConversationHistoryPageSchema,
  hostedConversationSnapshotSchema,
  hostedConversationSummarySchema,
  hostedConversationUploadPreflightResultSchema,
  hostedConversationUploadSchema,
  watchAcceptedSchema,
  type ConversationFileProjection,
  type HostedConversationFileDeleteResult,
  type HostedConversationFileReadResult,
  type HostedConversationSnapshot,
  type HostedConversationSummary,
  type HostedConversationUpload,
  type HostedConversationActivity
} from '@myagentroam/protocol';
import { ref, type Ref } from 'vue';
import type {
  ConversationItem as WorkbenchConversationItem,
  ConversationTurn as WorkbenchConversationTurn
} from '../model/workbench.js';
import { limitConversationHistory } from '../util/conversation-history.js';
import { errorCode } from '../util/api-error.js';
import { createConversationProjectionService } from './ConversationProjectionService.js';
import { createWatchLeaseLifecycleService } from './WatchLeaseLifecycleService.js';
import { createWorkbenchSubmissionService } from './WorkbenchSubmissionService.js';

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

interface PendingInitialSnapshot {
  readonly nodeId: string;
  readonly conversationId: string;
  readonly watchId: string;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly removeAbortListener: () => void;
}

/** Owns the Node directory, selected hosted conversation, and its single page Watch lease. */
export function createHostedConversationWorkspaceService(
  options: HostedConversationWorkspaceServiceOptions
) {
  const pageSize = options.pageSize ?? 20;
  const conversations = ref<HostedConversationSummary[]>([]);
  const hasMoreConversations = ref(false);
  const loadingConversations = ref(false);
  const loadingMoreConversations = ref(false);
  const selectedNodeId = options.selectedNodeId ?? ref<string>();
  const selectedConversationId = options.selectedConversationId ?? ref<string>();
  const snapshot = ref<HostedConversationSnapshot>();
  const loadingOlderHistory = ref(false);
  const watchFailureCode = ref<string>();
  const projectedTurns = ref<WorkbenchConversationTurn[]>([]);
  const projectionNextCursor = ref<string | null>(null);
  const conversationProjection = createConversationProjectionService({
    turns: projectedTurns,
    nextCursor: projectionNextCursor,
    onRecentWindowOverflow: () => {
      historyWindowRevision += 1;
      loadingOlderHistory.value = false;
      historyExpanded = false;
      recentHistoryRefresh = undefined;
      void refreshRecentHistoryWindow();
    },
    limitHistory: limitConversationHistory
  });
  const messageSubmission = createWorkbenchSubmissionService();
  let listSequence = 0;
  let loadMoreOperation = 0;
  let watchId: string | undefined;
  let acceptingWatchEvents = false;
  let watchedNodeId: string | undefined;
  let watchedConversationId: string | undefined;
  let watchedConnectionId: string | undefined;
  let nodeGeneration: string | undefined;
  let lastSnapshotSequence = 0;
  let lastEventSequence = 0;
  let historyRevision = 0;
  let historyExpanded = false;
  let historyWindowRevision = 0;
  let directoryCursor: string | null = null;
  let pendingInitial: PendingInitialSnapshot | undefined;
  const activityProjections = new Map<
    string,
    { readonly activity: HostedConversationActivity; readonly revision: number }
  >();
  let activityMessageRevision = 0;
  let recentHistoryRefresh: Promise<void> | undefined;

  function responseInvalid(): Error {
    return new Error('HOSTED_CONVERSATION_RESPONSE_INVALID');
  }

  function parseListPage(value: unknown) {
    const parsed = hostedConversationDirectoryPageSchema.safeParse(value);
    if (!parsed.success) throw responseInvalid();
    return parsed.data;
  }

  function mergeProjectedActivity(
    conversation: HostedConversationSummary,
    requestActivityRevision: number
  ): HostedConversationSummary {
    const key = targetKey(conversation.nodeId, conversation.id);
    const projected = activityProjections.get(key);
    if (
      projected !== undefined &&
      projected.revision > requestActivityRevision &&
      projected.activity.version > conversation.activity.version
    )
      return { ...conversation, activity: projected.activity };
    activityProjections.set(key, {
      activity: conversation.activity,
      revision: requestActivityRevision
    });
    return conversation;
  }

  function projectActivityMessage(value: unknown): boolean {
    const parsed = hostedConversationActivityMessageSchema.safeParse(value);
    if (!parsed.success) return false;
    const message = parsed.data;
    const key = targetKey(message.nodeId, message.conversationId);
    const current = activityProjections.get(key);
    if (current !== undefined && message.activity.version <= current.activity.version) return true;
    activityProjections.set(key, {
      activity: message.activity,
      revision: ++activityMessageRevision
    });
    conversations.value = conversations.value.map((conversation) =>
      conversation.nodeId === message.nodeId && conversation.id === message.conversationId
        ? { ...conversation, activity: message.activity }
        : conversation
    );
    const currentSnapshot = snapshot.value;
    if (
      currentSnapshot?.conversation.nodeId === message.nodeId &&
      currentSnapshot.conversation.id === message.conversationId &&
      message.activity.version > currentSnapshot.conversation.activity.version
    )
      replaceSnapshot({
        ...currentSnapshot,
        conversation: {
          ...currentSnapshot.conversation,
          activity: message.activity
        }
      });
    return true;
  }

  function conversationIsRunning(conversation: HostedConversationSummary): boolean {
    return ['STARTING', 'RUNNING', 'CANCELLING'].includes(conversation.activity.status);
  }

  async function loadConversations(): Promise<void> {
    const sequence = ++listSequence;
    const requestActivityRevision = activityMessageRevision;
    loadMoreOperation += 1;
    directoryCursor = null;
    hasMoreConversations.value = false;
    loadingConversations.value = true;
    loadingMoreConversations.value = false;
    try {
      const page = parseListPage(
        await options.request<unknown>(`/api/hosted-conversations?limit=${pageSize}`)
      );
      if (sequence !== listSequence) return;
      const currentConversations = conversations.value;
      const currentByKey = new Map(
        currentConversations.map((conversation) => [
          targetKey(conversation.nodeId, conversation.id),
          conversation
        ])
      );
      const selectedConversation = currentConversations.find(
        (conversation) =>
          conversation.nodeId === selectedNodeId.value &&
          conversation.id === selectedConversationId.value
      );
      const items = page.items.map((conversation) => {
        conversation = mergeProjectedActivity(conversation, requestActivityRevision);
        const current = currentByKey.get(targetKey(conversation.nodeId, conversation.id));
        if (current === undefined) return conversation;
        const merged = mergeConversationSummary(conversation, current);
        return merged.activity === conversation.activity
          ? merged
          : { ...merged, activity: conversation.activity };
      });
      if (
        page.items.length > 0 &&
        selectedConversation !== undefined &&
        !page.items.some(
          (conversation) =>
            conversation.nodeId === selectedConversation.nodeId &&
            conversation.id === selectedConversation.id
        )
      )
        items.push(selectedConversation);
      conversations.value = deduplicateConversations(items);
      directoryCursor = page.nextCursor;
      hasMoreConversations.value = directoryCursor !== null;
    } finally {
      if (sequence === listSequence) loadingConversations.value = false;
    }
  }

  async function loadMoreConversations(): Promise<void> {
    const cursor = directoryCursor;
    if (cursor === null || loadingMoreConversations.value) return;
    const sequence = listSequence;
    const operation = ++loadMoreOperation;
    const requestActivityRevision = activityMessageRevision;
    loadingMoreConversations.value = true;
    try {
      const page = parseListPage(
        await options.request<unknown>(
          `/api/hosted-conversations?limit=${pageSize}&cursor=${encodeURIComponent(cursor)}`
        )
      );
      if (sequence !== listSequence) return;
      conversations.value = deduplicateConversations([
        ...conversations.value,
        ...page.items.map((conversation) =>
          mergeProjectedActivity(conversation, requestActivityRevision)
        )
      ]);
      directoryCursor = page.nextCursor;
      hasMoreConversations.value = directoryCursor !== null;
    } finally {
      if (operation === loadMoreOperation) loadingMoreConversations.value = false;
    }
  }

  function cancelPendingInitial(code = 'HOSTED_CONVERSATION_WATCH_INITIAL_FAILED'): void {
    const pending = pendingInitial;
    if (pending === undefined) return;
    pendingInitial = undefined;
    clearTimeout(pending.timer);
    pending.removeAbortListener();
    pending.reject(new Error(code));
  }

  function waitForInitialSnapshot(
    nodeId: string,
    conversationId: string,
    currentWatchId: string,
    signal: AbortSignal
  ): Promise<void> {
    cancelPendingInitial();
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (pendingInitial?.watchId !== currentWatchId) return;
        cancelPendingInitial();
      };
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, options.requestTimeoutMs);
      pendingInitial = {
        nodeId,
        conversationId,
        watchId: currentWatchId,
        resolve,
        reject,
        timer,
        removeAbortListener: () => signal.removeEventListener('abort', abort)
      };
      if (signal.aborted) abort();
    });
  }

  function eligible(target: string): boolean {
    const nodeId = selectedNodeId.value;
    return (
      target === selectedTarget() &&
      nodeId !== undefined &&
      options.workbenchConnectionId() !== undefined &&
      (typeof document === 'undefined' || document.visibilityState === 'visible')
    );
  }

  async function requestWatch(
    target: string,
    signal: AbortSignal,
    mode: 'initial' | 'renew'
  ): Promise<void> {
    const nodeId = selectedNodeId.value;
    const conversationId = selectedConversationId.value;
    const connectionId = options.workbenchConnectionId();
    if (
      nodeId === undefined ||
      conversationId === undefined ||
      connectionId === undefined ||
      target !== targetKey(nodeId, conversationId)
    )
      return;
    if (mode === 'initial') {
      acceptingWatchEvents = true;
      watchId = randomWatchId();
      watchedNodeId = nodeId;
      watchedConversationId = conversationId;
      watchedConnectionId = connectionId;
      nodeGeneration = undefined;
      lastSnapshotSequence = 0;
      lastEventSequence = 0;
    }
    const currentWatchId = watchId ?? randomWatchId();
    watchId = currentWatchId;
    const initialSnapshot =
      mode === 'initial'
        ? waitForInitialSnapshot(nodeId, conversationId, currentWatchId, signal)
        : undefined;
    void initialSnapshot?.catch(() => undefined);
    try {
      const response = await options.request<unknown>(
        `/api/nodes/${encodeURIComponent(nodeId)}/hosted-conversations/${encodeURIComponent(conversationId)}/watch`,
        {
          method: 'POST',
          body: JSON.stringify({
            mode,
            workbenchConnectionId: connectionId,
            watchId: currentWatchId
          }),
          signal
        }
      );
      if (
        selectedTarget() !== target ||
        watchedConnectionId !== connectionId ||
        watchId !== currentWatchId
      ) {
        cancelPendingInitial();
        return;
      }
      if (mode === 'initial') {
        const accepted = watchAcceptedSchema.safeParse(response);
        if (
          !accepted.success ||
          accepted.data.watchId !== currentWatchId ||
          (nodeGeneration !== undefined && accepted.data.nodeGeneration !== nodeGeneration)
        ) {
          cancelPendingInitial('HOSTED_CONVERSATION_RESPONSE_INVALID');
          throw responseInvalid();
        }
        nodeGeneration = accepted.data.nodeGeneration;
      }
      await initialSnapshot;
    } catch (error) {
      if (pendingInitial?.watchId === currentWatchId) cancelPendingInitial();
      await initialSnapshot?.catch(() => undefined);
      throw error;
    }
  }

  const watchLifecycle = createWatchLeaseLifecycleService({
    heartbeatMs: options.heartbeatMs,
    requestTimeoutMs: options.requestTimeoutMs,
    confirmationTimeoutMs: options.confirmationTimeoutMs,
    maxFailures: 3,
    eligible,
    renew: requestWatch,
    recovery: {
      retryable: (error) => {
        const code = errorCode(error);
        if (code !== undefined)
          return [
            'SESSION_WATCH_NOT_FOUND',
            'HOSTED_CONVERSATION_WATCH_INITIAL_FAILED',
            'NODE_OFFLINE',
            'NODE_REQUEST_TIMEOUT',
            'WATCH_REQUEST_TIMEOUT',
            'REQUEST_FAILED_408',
            'REQUEST_FAILED_429',
            'REQUEST_FAILED_502',
            'REQUEST_FAILED_503',
            'REQUEST_FAILED_504'
          ].includes(code);
        return (
          error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')
        );
      },
      onFailure: (error) => {
        acceptingWatchEvents = false;
        watchFailureCode.value = errorCode(error) ?? 'HOSTED_CONVERSATION_WATCH_EXPIRED';
      }
    },
    onExpired: () => {
      watchFailureCode.value ??= 'HOSTED_CONVERSATION_WATCH_EXPIRED';
      options.onWatchExpired?.();
    }
  });

  function selectedTarget(): string | undefined {
    const nodeId = selectedNodeId.value;
    const conversationId = selectedConversationId.value;
    return nodeId === undefined || conversationId === undefined
      ? undefined
      : targetKey(nodeId, conversationId);
  }

  function beginSelectedConversationWatch(): Promise<void> {
    const target = selectedTarget();
    if (target === undefined) return Promise.reject(new Error('HOSTED_CONVERSATION_REQUIRED'));
    const operation = watchLifecycle.start(target);
    if (operation === undefined) return Promise.resolve();
    void operation.catch(() => undefined);
    return operation;
  }

  function selectConversation(
    nodeId: string,
    conversationId: string,
    initialSnapshot?: HostedConversationSnapshot
  ): void {
    if (selectedNodeId.value === nodeId && selectedConversationId.value === conversationId) {
      if (initialSnapshot !== undefined) installSnapshot(nodeId, conversationId, initialSnapshot);
      return;
    }
    stopSelectedConversationWatch();
    selectedNodeId.value = nodeId;
    selectedConversationId.value = conversationId;
    snapshot.value = undefined;
    projectedTurns.value = [];
    projectionNextCursor.value = null;
    loadingOlderHistory.value = false;
    historyExpanded = false;
    historyWindowRevision += 1;
    recentHistoryRefresh = undefined;
    conversationProjection.resetHistory();
    watchFailureCode.value = undefined;
    if (initialSnapshot !== undefined) installSnapshot(nodeId, conversationId, initialSnapshot);
  }

  function clearSelectedConversation(): void {
    stopSelectedConversationWatch();
    selectedNodeId.value = undefined;
    selectedConversationId.value = undefined;
    snapshot.value = undefined;
    projectedTurns.value = [];
    projectionNextCursor.value = null;
    loadingOlderHistory.value = false;
    historyExpanded = false;
    historyWindowRevision += 1;
    recentHistoryRefresh = undefined;
    conversationProjection.resetHistory();
    watchFailureCode.value = undefined;
  }

  function stopSelectedConversationWatch(): void {
    cancelPendingInitial();
    watchLifecycle.stop();
    const nodeId = watchedNodeId;
    const conversationId = watchedConversationId;
    const connectionId = watchedConnectionId;
    const currentWatchId = watchId;
    watchedNodeId = undefined;
    watchedConversationId = undefined;
    watchedConnectionId = undefined;
    watchId = undefined;
    acceptingWatchEvents = false;
    nodeGeneration = undefined;
    lastSnapshotSequence = 0;
    lastEventSequence = 0;
    if (
      nodeId === undefined ||
      conversationId === undefined ||
      connectionId === undefined ||
      currentWatchId === undefined
    )
      return;
    void options
      .request(
        `/api/nodes/${encodeURIComponent(nodeId)}/hosted-conversations/${encodeURIComponent(conversationId)}/watch`,
        {
          method: 'DELETE',
          body: JSON.stringify({
            workbenchConnectionId: connectionId,
            watchId: currentWatchId
          })
        }
      )
      .catch(() => undefined);
  }

  function restartSelectedConversationWatch(): Promise<void> {
    stopSelectedConversationWatch();
    return beginSelectedConversationWatch();
  }

  function pauseSelectedConversationWatch(): void {
    watchLifecycle.pause();
  }

  function handleVisibility(): void {
    if (document.visibilityState !== 'visible') stopSelectedConversationWatch();
  }

  function handleWatchEvent(value: unknown): boolean {
    if (!record(value)) return false;
    if (value.type === 'watch.failed') return handleWatchFailure(value);
    if (
      (value.type !== 'watch.hosted-conversation.snapshot' &&
        value.type !== 'watch.hosted-conversation.event') ||
      !matchesWatchIdentity(value)
    )
      return false;
    nodeGeneration ??= value.nodeGeneration as string;
    if (value.type === 'watch.hosted-conversation.snapshot') {
      if (
        !Number.isInteger(value.snapshotSequence) ||
        (value.snapshotSequence as number) <= lastSnapshotSequence
      )
        return false;
      const parsed = hostedConversationSnapshotSchema.safeParse(value.payload);
      if (
        !parsed.success ||
        parsed.data.conversation.id !== watchedConversationId ||
        parsed.data.conversation.nodeId !== watchedNodeId
      ) {
        cancelPendingInitial('HOSTED_CONVERSATION_RESPONSE_INVALID');
        watchFailureCode.value = 'HOSTED_CONVERSATION_RESPONSE_INVALID';
        return true;
      }
      lastSnapshotSequence = value.snapshotSequence as number;
      installSnapshot(watchedNodeId!, watchedConversationId!, parsed.data);
      watchFailureCode.value = undefined;
      const pending = pendingInitial;
      if (
        pending?.nodeId === watchedNodeId &&
        pending.conversationId === watchedConversationId &&
        pending.watchId === watchId
      ) {
        pendingInitial = undefined;
        clearTimeout(pending.timer);
        pending.removeAbortListener();
        pending.resolve();
      }
      watchLifecycle.confirm(targetKey(watchedNodeId!, watchedConversationId!));
      return true;
    }
    const event = record(value.event) ? value.event : undefined;
    if (
      event === undefined ||
      event.category !== 'hosted-conversation' ||
      !Number.isInteger(event.sequence) ||
      (event.sequence as number) <= lastEventSequence
    )
      return false;
    const payload = record(event.payload) ? event.payload : undefined;
    if (payload === undefined || payload.conversationId !== watchedConversationId) return false;
    lastEventSequence = event.sequence as number;
    applyHostedPayload(payload, event.sequence as number);
    watchLifecycle.confirm(targetKey(watchedNodeId!, watchedConversationId!));
    return true;
  }

  function matchesWatchIdentity(event: Record<string, unknown>): boolean {
    return (
      acceptingWatchEvents &&
      event.workbenchConnectionId === options.workbenchConnectionId() &&
      event.workbenchConnectionId === watchedConnectionId &&
      event.watchId === watchId &&
      event.nodeId === watchedNodeId &&
      event.conversationId === watchedConversationId &&
      typeof event.nodeGeneration === 'string' &&
      (nodeGeneration === undefined || event.nodeGeneration === nodeGeneration) &&
      selectedNodeId.value === watchedNodeId &&
      selectedConversationId.value === watchedConversationId
    );
  }

  function handleWatchFailure(event: Record<string, unknown>): boolean {
    if (
      event.watchType !== 'hosted-conversation' ||
      !matchesWatchIdentity(event) ||
      typeof event.code !== 'string'
    )
      return false;
    nodeGeneration ??= event.nodeGeneration as string;
    watchFailureCode.value = event.code;
    acceptingWatchEvents = false;
    cancelPendingInitial(event.code);
    watchLifecycle.pause();
    return true;
  }

  function installSnapshot(
    nodeId: string,
    conversationId: string,
    value: HostedConversationSnapshot,
    replaceHistory = snapshot.value === undefined
  ): void {
    const parsed = hostedConversationSnapshotSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.conversation.nodeId !== nodeId ||
      parsed.data.conversation.id !== conversationId
    )
      throw responseInvalid();
    const page = {
      turns: projectHostedTurns(parsed.data.turns),
      nextCursor: parsed.data.historyNextCursor,
      source: 'official' as const,
      snapshotSequence: parsed.data.snapshotSequence,
      readAt: Date.now()
    };
    if (replaceHistory) {
      historyWindowRevision += 1;
      historyExpanded = false;
      conversationProjection.replaceAuthoritative(page);
    } else
      conversationProjection.mergeLatest({
        ...page,
        nextCursor: historyExpanded ? projectionNextCursor.value : page.nextCursor
      });
    commitProjectedTurns(
      { ...parsed.data, historyNextCursor: projectionNextCursor.value },
      parsed.data.snapshotSequence > 0 ? parsed.data.snapshotSequence : null,
      0
    );
    upsertConversation(parsed.data.conversation);
  }

  async function loadOlderHistory(): Promise<void> {
    const context = requireSelectedContext();
    const cursor = projectionNextCursor.value;
    const revision = historyWindowRevision;
    if (cursor === null || loadingOlderHistory.value) return;
    loadingOlderHistory.value = true;
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
      const known = new Set(projectedTurns.value.map((turn) => turn.id));
      projectedTurns.value = limitConversationHistory([
        ...older.filter((turn) => !known.has(turn.id)),
        ...projectedTurns.value
      ]);
      projectionNextCursor.value = parsed.data.nextCursor;
      historyExpanded = true;
      conversationProjection.restore(projectedTurns.value);
      commitProjectedTurns(
        { ...snapshot.value, historyNextCursor: parsed.data.nextCursor },
        null,
        0
      );
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
      commitProjectedTurns(
        { ...snapshot.value, historyNextCursor: parsed.data.nextCursor },
        null,
        0
      );
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
      replaceSnapshot({ ...current, run: normalizeRun(payload.run, current.run) }, true);
    }
  }

  function applyRuntimeEvent(
    current: HostedConversationSnapshot,
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
        commitProjectedTurns(current, sourceSequence, runtime.sequence as number);
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
        commitProjectedTurns(current, sourceSequence, runtime.sequence as number);
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
    commitProjectedTurns(current, sourceSequence, runtime.sequence as number);
  }

  function ensureRuntimeTurn(
    current: HostedConversationSnapshot,
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

  function commitProjectedTurns(
    current: HostedConversationSnapshot,
    sourceSequence: number | null,
    revision: number
  ): void {
    replaceSnapshot(
      {
        ...current,
        turns: projectedTurns.value.map((turn) => {
          const currentTurn = current.turns.find(
            (candidate) =>
              candidate.id === turn.id || (turn.runId !== null && candidate.runId === turn.runId)
          );
          return {
            ...turn,
            userItemId:
              currentTurn?.userItemId ??
              turn.items.find((item) => item.kind === 'user_message')?.id ??
              null,
            model: currentTurn?.model ?? current.conversation.modelId,
            effort: currentTurn?.effort ?? null,
            access: currentTurn?.access ?? 'full-access',
            items: turn.items.map((item) => {
              const raw = item as unknown as Record<string, unknown>;
              const currentItem = currentTurn?.items.find((candidate) => candidate.id === item.id);
              return {
                ...item,
                sessionId:
                  typeof raw.sessionId === 'string'
                    ? raw.sessionId
                    : current.conversation.sessionId,
                turnId:
                  typeof raw.turnId === 'string' ? raw.turnId : (currentItem?.turnId ?? turn.id),
                runId: typeof raw.runId === 'string' || raw.runId === null ? raw.runId : turn.runId,
                parentItemId:
                  typeof raw.parentItemId === 'string' || raw.parentItemId === null
                    ? raw.parentItemId
                    : (currentItem?.parentItemId ?? null),
                sourceSequence:
                  typeof raw.sourceSequence === 'number' || raw.sourceSequence === null
                    ? raw.sourceSequence
                    : sourceSequence,
                revision: typeof raw.revision === 'number' ? raw.revision : revision,
                startedAt:
                  typeof raw.startedAt === 'number' || raw.startedAt === null
                    ? raw.startedAt
                    : null,
                completedAt:
                  typeof raw.completedAt === 'number' || raw.completedAt === null
                    ? raw.completedAt
                    : null
              };
            })
          };
        })
      },
      true
    );
  }

  function replaceSnapshot(value: unknown, historyChanged = false): void {
    const parsed = hostedConversationSnapshotSchema.safeParse(value);
    if (parsed.success) {
      snapshot.value = parsed.data;
      if (historyChanged) historyRevision += 1;
    }
  }

  function upsertConversation(value: HostedConversationSummary): void {
    const index = conversations.value.findIndex(
      (candidate) => candidate.nodeId === value.nodeId && candidate.id === value.id
    );
    if (index < 0) conversations.value = sortConversations([value, ...conversations.value]);
    else {
      const next = [...conversations.value];
      next.splice(index, 1, mergeConversationSummary(value, next[index]!));
      conversations.value = sortConversations(next);
    }
  }

  function requireSelectedContext(): {
    readonly nodeId: string;
    readonly conversationId: string;
    readonly snapshot: HostedConversationSnapshot;
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
      readonly snapshot: HostedConversationSnapshot;
    },
    includeRun: boolean
  ): HostedConversationSnapshot {
    if (
      !record(value) ||
      !exactKeys(value, includeRun ? ['conversation', 'run'] : ['conversation'])
    )
      throw responseInvalid();
    const candidate = hostedConversationSnapshotSchema.safeParse({
      ...context.snapshot,
      conversation: value.conversation,
      ...(includeRun ? { run: value.run } : {})
    });
    if (
      !candidate.success ||
      candidate.data.conversation.nodeId !== context.nodeId ||
      candidate.data.conversation.id !== context.conversationId
    )
      throw responseInvalid();
    return candidate.data;
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
        updateOptimisticUserMessage(input.clientMessageId, 'ACCEPTED', snapshot.value);
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
        removeOptimisticUserMessage(input.clientMessageId, snapshot.value);
      throw error;
    } finally {
      finishSubmission();
    }
  }

  function projectOptimisticUserMessage(
    current: HostedConversationSnapshot,
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
    commitProjectedTurns(current, null, 0);
  }

  function updateOptimisticUserMessage(
    clientMessageId: string,
    delivery: 'ACCEPTED',
    current: HostedConversationSnapshot
  ): void {
    let changed = false;
    projectedTurns.value = projectedTurns.value.map((turn) => {
      if (!isOptimisticUserTurn(turn, clientMessageId)) return turn;
      let turnChanged = false;
      const items = turn.items.map((item) => {
        if (
          item.id !== clientMessageId ||
          item.kind !== 'user_message' ||
          !record(item.payload) ||
          item.payload.clientMessageId !== clientMessageId
        )
          return item;
        turnChanged = true;
        changed = true;
        return {
          ...item,
          payload: {
            ...item.payload,
            delivery
          }
        };
      });
      return turnChanged ? { ...turn, items } : turn;
    });
    if (changed) commitProjectedTurns(current, null, 0);
  }

  function removeOptimisticUserMessage(
    clientMessageId: string,
    current: HostedConversationSnapshot
  ): void {
    const next = projectedTurns.value.filter(
      (turn) => !isOptimisticUserTurn(turn, clientMessageId)
    );
    if (next.length === projectedTurns.value.length) return;
    projectedTurns.value = next;
    commitProjectedTurns(current, null, 0);
  }

  function isOptimisticUserTurn(turn: WorkbenchConversationTurn, clientMessageId: string): boolean {
    return (
      turn.id === clientMessageId &&
      turn.runId === null &&
      turn.items.some(
        (item) =>
          item.id === clientMessageId &&
          item.kind === 'user_message' &&
          record(item.payload) &&
          item.payload.clientMessageId === clientMessageId
      )
    );
  }

  async function updateConfiguration(input: {
    readonly modelId: string;
  }): Promise<HostedConversationSummary> {
    const context = requireSelectedContext();
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
    boundary: string | null
  ): Promise<HostedConversationSnapshot> {
    const context = requireSelectedContext();
    const parsed = hostedConversationSnapshotSchema.safeParse(
      await options.request<unknown>(`${conversationBasePath(context)}/rollback`, {
        method: 'POST',
        body: JSON.stringify({ turnId, boundary })
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
    const restartWatchOnFailure = sameSelectedContext(target) && watchId !== undefined;
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
    conversations.value = conversations.value.filter(
      (conversation) =>
        conversation.nodeId !== targetNodeId || conversation.id !== targetConversationId
    );
    if (sameSelectedContext(target)) clearSelectedConversation();
    return { deletedConversationId };
  }

  async function deleteFile(fileId: string): Promise<HostedConversationFileDeleteResult> {
    const context = requireSelectedContext();
    const parsed = hostedConversationFileDeleteResultSchema.safeParse(
      await options.request<unknown>(
        `${conversationBasePath(context)}/files/${encodeURIComponent(fileId)}`,
        {
          method: 'DELETE',
          body: '{}'
        }
      )
    );
    if (
      !parsed.success ||
      parsed.data.deletedFileId !== fileId ||
      parsed.data.files.some((file) => file.conversationId !== context.conversationId)
    )
      throw responseInvalid();
    if (sameSelectedContext(context) && snapshot.value !== undefined) {
      replaceSnapshot({ ...snapshot.value, files: parsed.data.files });
    }
    return parsed.data;
  }

  async function readFile(
    fileId: string,
    offset = 0,
    limit = 512 * 1024
  ): Promise<HostedConversationFileReadResult> {
    const context = requireSelectedContext();
    const response = await options.request<unknown>(
      `${conversationBasePath(context)}/files/${encodeURIComponent(fileId)}?offset=${offset}&limit=${limit}`
    );
    const parsed = hostedConversationFileReadResultSchema.safeParse(response);
    if (
      !parsed.success ||
      parsed.data.file.id !== fileId ||
      parsed.data.file.conversationId !== context.conversationId ||
      parsed.data.offset !== offset
    )
      throw responseInvalid();
    const contentBytes = base64DecodedByteLength(parsed.data.content);
    const nextOffset = offset + contentBytes;
    if (
      contentBytes > limit ||
      nextOffset > parsed.data.file.size ||
      (parsed.data.eof
        ? parsed.data.nextOffset !== null || nextOffset !== parsed.data.file.size
        : parsed.data.nextOffset !== nextOffset)
    )
      throw responseInvalid();
    return parsed.data;
  }

  function contentUrl(file: ConversationFileProjection, download = false): string {
    const context = requireSelectedContext();
    if (file.conversationId !== context.conversationId) throw responseInvalid();
    return `${conversationBasePath(context)}/files/${encodeURIComponent(file.id)}/content${
      download ? '?download=1' : ''
    }`;
  }

  async function uploadFile(
    file: File,
    clientRequestId: string,
    onProgress?: (upload: HostedConversationUpload) => void,
    signal?: AbortSignal
  ): Promise<HostedConversationUpload> {
    const context = requireSelectedContext();
    const mimeType = file.type.trim() || 'application/octet-stream';
    signal?.throwIfAborted();
    const preflight = hostedConversationUploadPreflightResultSchema.safeParse(
      await options.request<unknown>(`${conversationBasePath(context)}/uploads/preflight`, {
        method: 'POST',
        body: JSON.stringify({
          files: [{ name: file.name, size: file.size, mimeType }]
        }),
        ...(signal === undefined ? {} : { signal })
      })
    );
    if (
      !preflight.success ||
      preflight.data.files.length !== 1 ||
      preflight.data.files[0]?.name !== file.name
    )
      throw responseInvalid();
    if (preflight.data.files[0].status !== 'READY')
      throw new Error(`HOSTED_CONVERSATION_UPLOAD_${preflight.data.files[0].status}`);

    let upload = parseUploadResponse(
      await options.request<unknown>(`${conversationBasePath(context)}/uploads`, {
        method: 'POST',
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          mimeType,
          clientRequestId
        }),
        ...(signal === undefined ? {} : { signal })
      }),
      context.conversationId
    );
    onProgress?.(upload);
    const chunkSize = 512 * 1024;
    try {
      for (let offset = upload.receivedBytes; offset < file.size; offset += chunkSize) {
        const end = Math.min(file.size, offset + chunkSize);
        const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
        signal?.throwIfAborted();
        if (chunk.byteLength !== end - offset) throw responseInvalid();
        upload = parseUploadResponse(
          await options.request<unknown>(
            `${conversationBasePath(context)}/uploads/${encodeURIComponent(upload.uploadId)}/chunks`,
            {
              method: 'POST',
              body: JSON.stringify({
                offset,
                dataBase64: bytesToBase64(chunk)
              }),
              ...(signal === undefined ? {} : { signal })
            }
          ),
          context.conversationId
        );
        if (upload.receivedBytes !== end) throw responseInvalid();
        onProgress?.(upload);
      }
      upload = parseUploadResponse(
        await options.request<unknown>(
          `${conversationBasePath(context)}/uploads/${encodeURIComponent(upload.uploadId)}/complete`,
          {
            method: 'POST',
            body: '{}',
            ...(signal === undefined ? {} : { signal })
          }
        ),
        context.conversationId
      );
      if (upload.status !== 'COMPLETED' || upload.file === undefined) throw responseInvalid();
    } catch (error) {
      await options
        .request(
          `${conversationBasePath(context)}/uploads/${encodeURIComponent(upload.uploadId)}/cancel`,
          { method: 'POST', body: '{}' }
        )
        .catch(() => undefined);
      throw error;
    }
    if (sameSelectedContext(context) && snapshot.value !== undefined) {
      const files = new Map(snapshot.value.files.map((candidate) => [candidate.id, candidate]));
      files.set(upload.file.id, upload.file);
      replaceSnapshot({ ...snapshot.value, files: [...files.values()] });
    }
    onProgress?.(upload);
    return upload;
  }

  return {
    conversations,
    hasMoreConversations,
    loadingConversations,
    loadingMoreConversations,
    selectedNodeId,
    selectedConversationId,
    snapshot,
    turns: projectedTurns,
    historyNextCursor: projectionNextCursor,
    loadingOlderHistory,
    watchFailureCode,
    messageSubmitting: messageSubmission.pending,
    messageSubmissionContext: messageSubmission.context,
    loadConversations,
    loadMoreConversations,
    projectActivityMessage,
    conversationIsRunning,
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
  return turns.map((turn) => ({
    id: turn.id,
    sessionId: turn.sessionId,
    runId: turn.runId,
    status: turn.status,
    ...(turn.rewind === undefined ? {} : { rewind: turn.rewind }),
    items: turn.items.map((item) => {
      const projected: WorkbenchConversationItem = {
        id: item.id,
        kind: item.kind,
        status: item.status,
        payload: item.payload,
        startedAt: item.startedAt,
        completedAt: item.completedAt,
        ...(item.segmentId === undefined ? {} : { segmentId: item.segmentId }),
        ...(item.segmentIndex === undefined ? {} : { segmentIndex: item.segmentIndex })
      };
      return Object.assign(projected, {
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
  }));
}

function runtimeStatus(value: unknown): WorkbenchConversationTurn['status'] | undefined {
  if (value === 'RUNNING' || value === 'SUCCEEDED' || value === 'FAILED' || value === 'INTERRUPTED')
    return value;
  return undefined;
}

function terminalTurnStatus(status: WorkbenchConversationTurn['status']): boolean {
  return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'LOST'].includes(status);
}

function mergeConversationSummary(
  incoming: HostedConversationSummary,
  current: HostedConversationSummary
): HostedConversationSummary {
  const summary =
    incoming.updatedAt < current.updatedAt || incoming.lastActivityAt < current.lastActivityAt
      ? current
      : incoming;
  const incomingActivity = conversationActivity(incoming);
  const currentActivity = conversationActivity(current);
  const activity =
    incomingActivity.version > currentActivity.version ? incomingActivity : currentActivity;
  return summary.activity === activity ? summary : { ...summary, activity };
}

function conversationActivity(conversation: HostedConversationSummary): HostedConversationActivity {
  return (
    (conversation as Partial<HostedConversationSummary>).activity ?? {
      status: 'IDLE',
      version: 0,
      updatedAt: 0
    }
  );
}

function deduplicateConversations(
  values: readonly HostedConversationSummary[]
): HostedConversationSummary[] {
  const items = new Map<string, HostedConversationSummary>();
  for (const value of values) {
    const key = targetKey(value.nodeId, value.id);
    const current = items.get(key);
    items.set(key, current === undefined ? value : mergeConversationSummary(value, current));
  }
  return sortConversations([...items.values()]);
}

function sortConversations(
  values: readonly HostedConversationSummary[]
): HostedConversationSummary[] {
  return [...values].sort(
    (left, right) =>
      Number(right.pinnedAt !== null) - Number(left.pinnedAt !== null) ||
      right.lastActivityAt - left.lastActivityAt ||
      left.nodeId.localeCompare(right.nodeId, 'en-US') ||
      left.id.localeCompare(right.id, 'en-US')
  );
}

function parseUploadResponse(value: unknown, conversationId: string): HostedConversationUpload {
  if (!record(value) || !exactKeys(value, ['upload']))
    throw new Error('HOSTED_CONVERSATION_RESPONSE_INVALID');
  const parsed = hostedConversationUploadSchema.safeParse(value.upload);
  if (!parsed.success || parsed.data.conversationId !== conversationId)
    throw new Error('HOSTED_CONVERSATION_RESPONSE_INVALID');
  return parsed.data;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const stride = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += stride)
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(bytes.length, offset + stride))
    );
  return btoa(binary);
}

function base64DecodedByteLength(value: string): number {
  if (value.length === 0) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length * 3) / 4 - padding;
}

function targetKey(nodeId: string, conversationId: string): string {
  return `${nodeId}\0${conversationId}`;
}

export function hostedConversationSubmissionContext(
  nodeId: string,
  conversationId: string
): string {
  return targetKey(nodeId, conversationId);
}

function randomWatchId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
