import { createUuid } from '../util/uuid.js';
import {
  hostedConversationSnapshotSchema,
  watchAcceptedSchema,
  type HostedConversationSnapshot
} from '@myagentroam/protocol';
import { ref, shallowRef, type Ref } from 'vue';
import { apiErrorFromResponse, errorCode } from '../util/api-error.js';
import { targetKey } from './hosted-conversation-directory-service.js';
import { createWatchLeaseLifecycleService } from './watch-lease-lifecycle-service.js';

interface PendingInitialSnapshot {
  readonly nodeId: string;
  readonly conversationId: string;
  readonly watchId: string;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly removeAbortListener: () => void;
}

export function createHostedConversationWatchService(options: {
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly workbenchConnectionId: () => string | undefined;
  readonly selectedNodeId: Ref<string | undefined>;
  readonly selectedConversationId: Ref<string | undefined>;
  readonly heartbeatMs: number;
  readonly requestTimeoutMs: number;
  readonly confirmationTimeoutMs: number;
  readonly onWatchExpired?: () => void;
  readonly installSnapshot: (
    nodeId: string,
    conversationId: string,
    value: HostedConversationSnapshot
  ) => void;
  readonly applyHostedPayload: (payload: Record<string, unknown>, sequence: number) => void;
}) {
  const { selectedNodeId, selectedConversationId } = options;
  const watchReady = ref(false);
  const watchFailureCode = ref<string>();
  const watchFailure = shallowRef<unknown>();
  const watchLoading = ref(false);
  let watchId: string | undefined;
  let acceptingWatchEvents = false;
  let watchedNodeId: string | undefined;
  let watchedConversationId: string | undefined;
  let watchedConnectionId: string | undefined;
  let nodeGeneration: string | undefined;
  let lastSnapshotSequence = 0;
  let lastEventSequence = 0;
  let pendingInitial: PendingInitialSnapshot | undefined;

  function cancelPendingInitial(
    code = 'HOSTED_CONVERSATION_WATCH_INITIAL_FAILED',
    error = new Error(code)
  ): void {
    const pending = pendingInitial;
    if (pending === undefined) return;
    pendingInitial = undefined;
    clearTimeout(pending.timer);
    pending.removeAbortListener();
    pending.reject(error);
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
      watchReady.value = false;
      watchLoading.value = true;
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
        if (pendingInitial?.watchId === currentWatchId) cancelPendingInitial();
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
      if (
        watchId === currentWatchId &&
        watchedConnectionId === connectionId &&
        selectedTarget() === target &&
        eligible(target) &&
        (!signal.aborted || errorCode(signal.reason) !== undefined)
      )
        markRestartFailure(signal.aborted ? signal.reason : error);
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
            'HOSTED_CONVERSATION_TEMPLATE_CONFLICT',
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
        watchLoading.value = true;
        watchFailure.value = error;
        watchFailureCode.value = errorCode(error) ?? 'HOSTED_CONVERSATION_WATCH_EXPIRED';
      }
    },
    onExpired: () => {
      watchLoading.value = false;
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

  function stopSelectedConversationWatch(): void {
    watchReady.value = false;
    watchLoading.value = false;
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
    watchReady.value = false;
    watchLoading.value = false;
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
        markRestartFailure(responseInvalid());
        return true;
      }
      lastSnapshotSequence = value.snapshotSequence as number;
      options.installSnapshot(watchedNodeId!, watchedConversationId!, parsed.data);
      if (!matchesWatchIdentity(value)) return true;
      watchReady.value = true;
      if (!matchesWatchIdentity(value)) return true;
      watchFailureCode.value = undefined;
      watchFailure.value = undefined;
      watchLoading.value = false;
      if (!matchesWatchIdentity(value)) return true;
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
    options.applyHostedPayload(payload, event.sequence as number);
    if (!matchesWatchIdentity(value)) return true;
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
    const failure = apiErrorFromResponse({ error: event }, 500);
    watchFailure.value = failure;
    watchLoading.value = false;
    acceptingWatchEvents = false;
    cancelPendingInitial(event.code, failure);
    watchLifecycle.pause();
    return true;
  }

  function markRestartFailure(error: unknown): void {
    watchReady.value = false;
    watchLoading.value = false;
    watchFailure.value = error;
    watchFailureCode.value = errorCode(error) ?? 'HOSTED_CONVERSATION_WATCH_EXPIRED';
  }

  return {
    watchReady: watchReady as Readonly<Ref<boolean>>,
    watchFailureCode: watchFailureCode as Readonly<Ref<string | undefined>>,
    watchFailure: watchFailure as Readonly<Ref<unknown>>,
    watchLoading: watchLoading as Readonly<Ref<boolean>>,
    clearFailure: () => {
      watchFailureCode.value = undefined;
      watchFailure.value = undefined;
    },
    selectedWatchId: () => watchId,
    beginSelectedConversationWatch,
    restartSelectedConversationWatch,
    pauseSelectedConversationWatch,
    stopSelectedConversationWatch,
    handleVisibility,
    handleWatchEvent,
    markRestartFailure
  };
}

function responseInvalid(): Error {
  return new Error('HOSTED_CONVERSATION_RESPONSE_INVALID');
}
function randomWatchId(): string {
  return createUuid().replace(/-/g, '');
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
