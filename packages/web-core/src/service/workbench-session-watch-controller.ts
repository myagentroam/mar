import { createUuid } from '../util/uuid.js';
import { isPublicErrorCode } from '@myagentroam/protocol';
import type { WorkspaceTarget } from '../model/workbench.js';
import { ApiError, errorCode } from '../util/api-error.js';
import { shallowRef, type Ref } from 'vue';
import type { ConversationSegmentPage, ConversationTurnPage, Session } from '../model/workbench.js';
import { sessionActivity } from '../util/session-presentation.js';
import {
  parseConversationSegmentPage,
  segmentPageAsTurnPage
} from '../util/conversation-segments.js';
import { createSessionWatchService } from './session-watch-service.js';
import type { WorkbenchLiveEvent } from './workbench-live-service.js';
import type { WorkspaceQueueSnapshotSource } from './workspace-queue-projection-service.js';

/** Owns one pane's Session Watch and its same-resource handoff until the replacement initial. */
export function createWorkbenchSessionWatchController(options: {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Ref<string | undefined>;
  readonly followConversation: Ref<boolean>;
  readonly heartbeatMs: number;
  readonly enabled?: () => boolean;
  readonly position?: 'secondary';
  readonly workbenchConnectionId?: () => string | undefined;
  readonly requestTimeoutMs: number;
  readonly confirmationTimeoutMs: number;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly sessionPathId: (sessionId: string) => string;
  readonly applyRunsSnapshot?: (runs: readonly unknown[]) => void;
  readonly applySnapshot: (
    sessionId: string,
    page: ConversationTurnPage,
    mode?: 'initial' | 'refresh' | 'reset'
  ) => boolean;
  readonly applyEvent?: (event: WorkbenchLiveEvent, source?: WorkspaceQueueSnapshotSource) => void;
  readonly scrollAfterLayout: () => Promise<void>;
  readonly refreshSnapshot: () => void;
  readonly openSession: (sessionId: string) => Promise<void>;
}) {
  const connectionId = () =>
    options.workbenchConnectionId === undefined
      ? 'local-test-connection'
      : options.workbenchConnectionId();
  const enabled = () =>
    options.position === 'secondary' ? options.enabled?.() === true : options.enabled?.() !== false;
  let watchId: string | undefined;
  let watchedSessionId: string | undefined;
  let watchedNodeId: string | undefined;
  let watchedWorkspaceId: string | undefined;
  let watchedConnectionId: string | undefined;
  let nodeGeneration: string | undefined;
  let previousWatch: { readonly id: string; readonly generation: string } | undefined;
  const appliedInitialSnapshot = shallowRef<{
    readonly watchId: string;
    readonly nodeId: string;
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly connectionId: string;
  }>();
  let failureRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let failureRetries = 0;
  let pendingInitial:
    | {
        readonly sessionId: string;
        readonly watchId: string;
        readonly resolve: () => void;
        readonly reject: (error: Error) => void;
        readonly removeAbortListener: () => void;
        readonly events: Array<{ readonly event: WorkbenchLiveEvent; readonly generation: string }>;
      }
    | undefined;

  function cancelPendingInitial(
    error: Error = new ApiError('WATCH_CANCELLED', 'The watch was stopped or replaced.')
  ): void {
    const pending = pendingInitial;
    if (pending === undefined) return;
    pendingInitial = undefined;
    previousWatch = undefined;
    pending.removeAbortListener();
    pending.reject(error);
  }

  function waitForInitialSnapshot(
    sessionId: string,
    currentWatchId: string,
    signal?: AbortSignal
  ): Promise<void> {
    cancelPendingInitial();
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (pendingInitial?.watchId !== currentWatchId) return;
        cancelPendingInitial(
          signal?.reason instanceof Error
            ? signal.reason
            : new ApiError('WATCH_CANCELLED', 'The watch was stopped or replaced.')
        );
      };
      signal?.addEventListener('abort', abort, { once: true });
      pendingInitial = {
        sessionId,
        watchId: currentWatchId,
        resolve,
        reject,
        removeAbortListener: () => signal?.removeEventListener('abort', abort),
        events: []
      };
      if (signal?.aborted === true) abort();
    });
  }
  function eligible(sessionId: string): boolean {
    return enabled() && options.selectedSessionId.value === sessionId && canWatchId(sessionId);
  }

  function canWatch(session: Session): boolean {
    return canWatchId(session.id);
  }

  function canWatchId(sessionId: string): boolean {
    return (
      !sessionId.startsWith('draft:') &&
      (typeof document === 'undefined' || document.visibilityState === 'visible')
    );
  }

  async function requestWatch(
    sessionId: string,
    signal?: AbortSignal,
    mode: 'initial' | 'renew' = 'renew'
  ): Promise<void> {
    if (!enabled()) return;
    const nodeId = options.workspaceTarget.value?.nodeId;
    const workspaceId = options.workspaceTarget.value?.workspaceId;
    const currentConnectionId = connectionId();
    if (
      nodeId === undefined ||
      workspaceId === undefined ||
      currentConnectionId === undefined ||
      options.selectedSessionId.value !== sessionId
    )
      return;
    if (mode === 'initial') {
      appliedInitialSnapshot.value = undefined;
      watchId = createUuid().replace(/-/g, '');
      nodeGeneration = undefined;
      watchedSessionId = sessionId;
      watchedNodeId = nodeId;
      watchedWorkspaceId = workspaceId;
    } else watchId ??= createUuid().replace(/-/g, '');
    const currentWatchId = watchId;
    const initialSnapshot =
      mode === 'initial' ? waitForInitialSnapshot(sessionId, currentWatchId, signal) : undefined;
    void initialSnapshot?.catch(() => undefined);
    let acknowledged = false;
    let accepted: { readonly nodeGeneration?: string } | undefined;
    try {
      accepted = await options.request<{ readonly nodeGeneration?: string } | undefined>(
        `/api/agent-sessions/${options.sessionPathId(sessionId)}/watch`,
        {
          method: 'POST',
          body: JSON.stringify({
            nodeId,
            workspaceId,
            workbenchConnectionId: currentConnectionId,
            watchId: currentWatchId,
            mode,
            ...(options.position === undefined ? {} : { position: options.position }),
            unit: 'SEGMENT'
          }),
          ...(signal === undefined ? {} : { signal })
        }
      );
      acknowledged = true;
      if (
        options.workspaceTarget.value?.nodeId !== nodeId ||
        options.workspaceTarget.value?.workspaceId !== workspaceId ||
        options.selectedSessionId.value !== sessionId ||
        connectionId() !== currentConnectionId ||
        watchId !== currentWatchId
      ) {
        if (pendingInitial?.watchId === currentWatchId) cancelPendingInitial();
        await initialSnapshot?.catch(() => undefined);
        return undefined;
      }
      if (typeof accepted?.nodeGeneration === 'string' && watchedSessionId === sessionId)
        nodeGeneration = accepted.nodeGeneration;
      await initialSnapshot;
    } catch (error) {
      if (pendingInitial?.watchId === currentWatchId) cancelPendingInitial();
      await initialSnapshot?.catch(() => undefined);
      if (acknowledged && errorCode(error) === 'WATCH_REQUEST_TIMEOUT')
        throw new ApiError(
          'SESSION_WATCH_SNAPSHOT_TIMEOUT',
          'The initial session snapshot did not arrive before the watch deadline.'
        );
      throw error;
    }
  }

  const lifecycle = createSessionWatchService({
    heartbeatMs: options.heartbeatMs,
    requestTimeoutMs: options.requestTimeoutMs,
    confirmationTimeoutMs: options.confirmationTimeoutMs,
    maxFailures: 3,
    eligible,
    renew: (sessionId, signal, mode) => requestWatch(sessionId, signal, mode),
    onExpired: options.refreshSnapshot
  });

  function begin(
    sessionId: string,
    input: { readonly skipImmediateRenew?: boolean; readonly preserveFailures?: boolean } = {}
  ): Promise<void> | undefined {
    if (!enabled()) return undefined;
    const currentConnectionId = connectionId();
    if (watchedSessionId === sessionId && watchedConnectionId !== currentConnectionId)
      return restart(sessionId, input.preserveFailures !== true);
    // Lifecycle.start returns the existing in-flight promise for the same target.
    // All callers must await snapshot confirmation, not just the first caller.
    if (watchedSessionId !== sessionId) {
      watchId = createUuid().replace(/-/g, '');
      nodeGeneration = undefined;
      if (input.preserveFailures !== true) failureRetries = 0;
      watchedSessionId = sessionId;
      watchedNodeId = options.workspaceTarget.value?.nodeId;
      watchedWorkspaceId = options.workspaceTarget.value?.workspaceId;
      watchedConnectionId = currentConnectionId;
    }
    const operation = lifecycle.start(sessionId, input.skipImmediateRenew === true);
    const currentWatchId = watchId;
    const completion = operation?.then(() => {
      // Background lease cancellation is silent, but initial callers must not mistake it for success.
      if (watchId !== currentWatchId || connectionId() !== currentConnectionId)
        throw new ApiError('WATCH_CANCELLED', 'The watch was stopped or replaced.');
    });
    void completion?.catch(() => undefined);
    return completion;
  }

  function stop(): void {
    previousWatch = undefined;
    appliedInitialSnapshot.value = undefined;
    cancelPendingInitial();
    const sessionId = watchedSessionId;
    const currentWatchId = watchId;
    const nodeId = watchedNodeId;
    const workspaceId = watchedWorkspaceId;
    const currentConnectionId = watchedConnectionId;
    watchedSessionId = undefined;
    watchedNodeId = undefined;
    watchedWorkspaceId = undefined;
    watchedConnectionId = undefined;
    watchId = undefined;
    nodeGeneration = undefined;
    failureRetries = 0;
    if (failureRetryTimer !== undefined) clearTimeout(failureRetryTimer);
    failureRetryTimer = undefined;
    lifecycle.stop();
    if (
      sessionId === undefined ||
      currentWatchId === undefined ||
      nodeId === undefined ||
      workspaceId === undefined ||
      currentConnectionId === undefined
    )
      return;
    void options
      .request(`/api/agent-sessions/${options.sessionPathId(sessionId)}/watch`, {
        method: 'DELETE',
        body: JSON.stringify({
          nodeId,
          workspaceId,
          workbenchConnectionId: currentConnectionId,
          watchId: currentWatchId,
          ...(options.position === undefined ? {} : { position: options.position })
        })
      })
      .catch(() => undefined);
  }

  function restart(sessionId: string, resetFailures = true): Promise<void> | undefined {
    const target = options.workspaceTarget.value;
    const predecessor =
      watchId !== undefined &&
      nodeGeneration !== undefined &&
      watchedConnectionId === connectionId() &&
      watchedNodeId === target?.nodeId &&
      watchedWorkspaceId === target?.workspaceId &&
      watchedSessionId === sessionId
        ? { id: watchId, generation: nodeGeneration }
        : undefined;
    appliedInitialSnapshot.value = undefined;
    if (failureRetryTimer !== undefined) clearTimeout(failureRetryTimer);
    failureRetryTimer = undefined;
    cancelPendingInitial();
    previousWatch = predecessor;
    lifecycle.stop();
    watchedSessionId = undefined;
    watchedNodeId = undefined;
    watchedWorkspaceId = undefined;
    watchedConnectionId = undefined;
    watchId = undefined;
    nodeGeneration = undefined;
    if (resetFailures) failureRetries = 0;
    return begin(sessionId, { preserveFailures: !resetFailures });
  }

  function initialize(sessionId: string): Promise<void> {
    return restart(sessionId) ?? Promise.resolve();
  }

  function pause(): void {
    if (failureRetryTimer !== undefined) clearTimeout(failureRetryTimer);
    failureRetryTimer = undefined;
    lifecycle.pause();
  }

  function handleEvent(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    const event = value as Record<string, unknown>;
    const target = options.workspaceTarget.value;
    // Old realtime can be in flight, but only the new lease may confirm the initial snapshot.
    const previous =
      event.type === 'watch.session.event' &&
      pendingInitial !== undefined &&
      previousWatch !== undefined &&
      event.watchId === previousWatch.id &&
      event.nodeGeneration === previousWatch.generation;
    if (
      (event.type !== 'watch.session.snapshot' && event.type !== 'watch.session.event') ||
      event.workbenchConnectionId !== connectionId() ||
      event.workbenchConnectionId !== watchedConnectionId ||
      event.nodeId !== target?.nodeId ||
      event.nodeId !== watchedNodeId ||
      event.workspaceId !== target?.workspaceId ||
      event.workspaceId !== watchedWorkspaceId ||
      event.sessionId !== options.selectedSessionId.value ||
      event.sessionId !== watchedSessionId ||
      watchId === undefined ||
      (event.watchId !== watchId && !previous) ||
      typeof event.nodeGeneration !== 'string' ||
      (nodeGeneration !== undefined && event.nodeGeneration !== nodeGeneration)
    )
      return false;
    if (!previous) nodeGeneration ??= event.nodeGeneration;
    failureRetries = 0;
    const sessionId = watchedSessionId;
    if (sessionId === undefined) return false;
    if (event.type === 'watch.session.event') {
      const realtime = event.event as Record<string, unknown> | undefined;
      if (
        realtime !== undefined &&
        typeof realtime.sequence === 'number' &&
        ['node', 'session', 'conversation', 'run', 'queue', 'workspace'].includes(
          String(realtime.category)
        ) &&
        'payload' in realtime
      ) {
        const projected = {
          nodeId: event.nodeId as string,
          sequence: realtime.sequence,
          category: realtime.category as WorkbenchLiveEvent['category'],
          payload: realtime.payload
        };
        if (pendingInitial?.sessionId === sessionId && pendingInitial.watchId === watchId)
          pendingInitial.events.push({ event: projected, generation: event.nodeGeneration });
        else options.applyEvent?.(projected);
      }
      return true;
    }
    if (event.payload === undefined) return false;
    const snapshot = event.payload as Record<string, unknown>;
    const runtimeSnapshot =
      snapshot.kind === 'session-watch-snapshot' &&
      typeof snapshot.sequence === 'number' &&
      typeof snapshot.session === 'object' &&
      snapshot.session !== null &&
      Array.isArray(snapshot.runs)
        ? snapshot
        : undefined;
    if (runtimeSnapshot !== undefined) {
      options.applyEvent?.({
        nodeId: event.nodeId as string,
        sequence: runtimeSnapshot.sequence as number,
        category: 'session',
        payload: { session: runtimeSnapshot.session }
      });
      const snapshotRuns = runtimeSnapshot.runs as unknown[];
      if (options.applyRunsSnapshot !== undefined) options.applyRunsSnapshot(snapshotRuns);
      else
        for (const run of snapshotRuns)
          options.applyEvent?.({
            nodeId: event.nodeId as string,
            sequence: runtimeSnapshot.sequence as number,
            category: 'run',
            payload: { run }
          });
      if (typeof runtimeSnapshot.queue === 'object' && runtimeSnapshot.queue !== null)
        options.applyEvent?.(
          {
            nodeId: event.nodeId as string,
            sequence: runtimeSnapshot.sequence as number,
            category: 'queue',
            payload: { sessionId, queue: runtimeSnapshot.queue }
          },
          'initial'
        );
      if ('context' in runtimeSnapshot)
        options.applyEvent?.({
          nodeId: event.nodeId as string,
          sequence: runtimeSnapshot.sequence as number,
          category: 'session',
          payload: { sessionId, context: runtimeSnapshot.context }
        });
      if (runtimeSnapshot.performance !== undefined)
        options.applyEvent?.({
          nodeId: event.nodeId as string,
          sequence: runtimeSnapshot.sequence as number,
          category: 'conversation',
          payload: { sessionId, performance: runtimeSnapshot.performance }
        });
    }
    const payload = (runtimeSnapshot?.conversation ?? event.payload) as
      ConversationTurnPage | ConversationSegmentPage;
    const page = parseConversationSegmentPage(payload) ?? segmentPageAsTurnPage(payload);
    if (pendingInitial?.sessionId === sessionId && pendingInitial.watchId === watchId) {
      const pending = pendingInitial;
      pendingInitial = undefined;
      previousWatch = undefined;
      pending.removeAbortListener();
      options.applySnapshot(sessionId, page, event.historyReset === true ? 'reset' : 'initial');
      appliedInitialSnapshot.value = {
        watchId: pending.watchId,
        nodeId: event.nodeId as string,
        workspaceId: event.workspaceId as string,
        sessionId,
        connectionId: event.workbenchConnectionId as string
      };
      const snapshotSequence =
        typeof runtimeSnapshot?.sequence === 'number'
          ? runtimeSnapshot.sequence
          : page.snapshotSequence;
      const snapshotIds = new Set(page.turns.map((turn) => turn.id));
      for (const { event: realtime, generation } of pending.events) {
        if (generation !== event.nodeGeneration) continue;
        const coveredSequence =
          realtime.category === 'conversation'
            ? (page.snapshotSequence ?? snapshotSequence)
            : snapshotSequence;
        if (coveredSequence !== undefined && realtime.sequence <= coveredSequence) {
          // Only replay complete, explicitly targeted Segments that the bounded window did not cover.
          if (event.historyReset === true || realtime.category !== 'conversation') continue;
          const payload = realtime.payload as
            { turn?: unknown; segments?: { id?: string }[] } | undefined;
          if (payload?.turn !== undefined || !Array.isArray(payload?.segments)) continue;
          const uncovered = payload.segments.filter(
            (segment) => typeof segment?.id === 'string' && !snapshotIds.has(segment.id)
          );
          if (uncovered.length > 0)
            options.applyEvent?.({ ...realtime, payload: { ...payload, segments: uncovered } });
          continue;
        }
        options.applyEvent?.(realtime);
      }
      pending.resolve();
      return true;
    }
    void Promise.resolve(
      options.applySnapshot(sessionId, page, event.historyReset === true ? 'reset' : 'refresh')
    ).then((changed) => {
      if (changed && options.followConversation.value) return options.scrollAfterLayout();
    });
    return true;
  }

  function handleFailure(event: Record<string, unknown>): boolean {
    if (
      event.type !== 'watch.failed' ||
      event.watchType !== 'session' ||
      event.watchId !== watchId ||
      event.workbenchConnectionId !== connectionId() ||
      event.sessionId !== watchedSessionId ||
      event.nodeId !== options.workspaceTarget.value?.nodeId ||
      event.workspaceId !== watchedWorkspaceId ||
      typeof event.nodeGeneration !== 'string' ||
      (nodeGeneration !== undefined && event.nodeGeneration !== nodeGeneration)
    )
      return false;
    nodeGeneration ??= event.nodeGeneration;
    const sessionId = watchedSessionId;
    if (sessionId === undefined) return true;
    if (pendingInitial?.sessionId === sessionId && pendingInitial.watchId === watchId) {
      cancelPendingInitial(
        new ApiError(
          isPublicErrorCode(event.code) ? event.code : 'SESSION_HISTORY_INITIAL_FAILED',
          typeof event.message === 'string' &&
            event.message.length > 0 &&
            event.message.length <= 1000
            ? event.message
            : 'Unable to load the initial session snapshot.'
        )
      );
      lifecycle.pause();
      return true;
    }
    if (failureRetries >= 3) {
      stop();
      options.refreshSnapshot();
      return true;
    }
    failureRetries += 1;
    lifecycle.pause();
    failureRetryTimer = setTimeout(
      () => {
        failureRetryTimer = undefined;
        if (options.selectedSessionId.value === sessionId) restart(sessionId, false);
      },
      Math.min(options.heartbeatMs, 1_000 * 2 ** (failureRetries - 1))
    );
    return true;
  }

  function handleVisibility(): void {
    if (document.visibilityState !== 'visible') stop();
  }

  function reconcileWorkspaceSnapshot(
    previous: Session | undefined,
    current: Session | undefined
  ): void {
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.id === options.selectedSessionId.value &&
      sessionActivity(previous) === 'RUNNING' &&
      current.id === previous.id &&
      canWatch(current)
    )
      begin(current.id);
  }

  return {
    hasInitialSessionSnapshot: (sessionId: string): boolean =>
      appliedInitialSnapshot.value !== undefined &&
      appliedInitialSnapshot.value.watchId === watchId &&
      appliedInitialSnapshot.value.nodeId === options.workspaceTarget.value?.nodeId &&
      appliedInitialSnapshot.value.workspaceId === options.workspaceTarget.value?.workspaceId &&
      appliedInitialSnapshot.value.sessionId === sessionId &&
      options.selectedSessionId.value === sessionId &&
      appliedInitialSnapshot.value.connectionId === connectionId(),
    canWatchSessionHistory: (session: Session) => enabled() && canWatch(session),
    initializeSelectedSessionWatch: initialize,
    beginSelectedSessionWatch: begin,
    restartSelectedSessionWatch: restart,
    pauseSelectedSessionWatch: pause,
    stopSelectedSessionWatch: stop,
    reconcileWorkspaceSnapshot,
    handleEvent(value: unknown): boolean {
      if (typeof value !== 'object' || value === null) return false;
      return handleFailure(value as Record<string, unknown>) || handleEvent(value);
    },
    handleSessionWatchVisibility: handleVisibility
  };
}
