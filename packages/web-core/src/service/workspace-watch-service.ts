import { reactive, readonly } from 'vue';
import type { Ref } from 'vue';
import { createWatchLeaseLifecycleService } from './watch-lease-lifecycle-service.js';

export type WorkspaceWatchTopic = 'sessions' | 'files' | 'changes' | 'sessionNavigation';
export type WorkspaceWatchTopicStatus = 'idle' | 'loading' | 'ready' | 'failed';

interface WorkspaceWatchSnapshot {
  readonly sessions?: unknown;
  readonly files?: unknown;
  readonly changes?: unknown;
  readonly sessionNavigation?: unknown;
}

interface WatchContext {
  readonly sessionGroup?: import('@myagentroam/protocol').SessionGroup;
  readonly sessionNavigation?: import('@myagentroam/protocol').WorkspaceSessionNavigationQuery;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly directory: string;
  readonly watchId: string;
  readonly connectionId: string;
  readonly git: boolean;
  nodeGeneration?: string;
}

export function createWorkspaceWatchService(options: {
  readonly workspaceTarget: Readonly<Ref<Pick<WatchContext, 'nodeId' | 'workspaceId'> | undefined>>;
  readonly workspaces: Readonly<
    Ref<readonly { readonly id: string; readonly kind: 'DIRECTORY' | 'GIT_WORKSPACE' }[]>
  >;
  readonly heartbeatMs: number;
  readonly requestTimeoutMs?: number;
  readonly confirmationTimeoutMs?: number;
  readonly enabled?: () => boolean;
  readonly sessionGroup?: () => import('@myagentroam/protocol').SessionGroup | undefined;
  readonly sessionNavigation?: () =>
    import('@myagentroam/protocol').WorkspaceSessionNavigationQuery | undefined;
  readonly prepareFiles?: () => boolean;
  readonly workbenchConnectionId?: () => string | undefined;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly onSnapshot: (
    nodeId: string,
    workspaceId: string,
    snapshot: WorkspaceWatchSnapshot,
    topic: WorkspaceWatchTopic,
    revision: number,
    navigationQuery?: import('@myagentroam/protocol').WorkspaceSessionNavigationQuery
  ) => void;
}) {
  const topicStatus = reactive<Record<WorkspaceWatchTopic, WorkspaceWatchTopicStatus>>({
    sessions: 'idle',
    files: 'idle',
    changes: 'idle',
    sessionNavigation: 'idle'
  });
  const revisions: Record<WorkspaceWatchTopic, number> = {
    sessions: -1,
    files: -1,
    changes: -1,
    sessionNavigation: -1
  };
  let context: WatchContext | undefined;
  let topicRetryTimer: ReturnType<typeof setTimeout> | undefined;
  const topicFailures: Record<WorkspaceWatchTopic, number> = {
    sessions: 0,
    files: 0,
    changes: 0,
    sessionNavigation: 0
  };
  let leaseFailures = 0;
  let paused = false;

  const connectionId = () =>
    options.workbenchConnectionId === undefined
      ? 'local-test-connection'
      : options.workbenchConnectionId();

  function targetKey(value: WatchContext): string {
    return `${value.connectionId}:${value.nodeId}:${value.workspaceId}:${value.directory}:${value.git ? 'git' : 'directory'}:${value.sessionGroup ?? 'ALL'}`;
  }

  function eligible(key: string): boolean {
    const current = context;
    return (
      current !== undefined &&
      targetKey(current) === key &&
      options.enabled?.() !== false &&
      options.workspaceTarget.value?.nodeId === current.nodeId &&
      options.workspaceTarget.value?.workspaceId === current.workspaceId &&
      options.sessionGroup?.() === current.sessionGroup &&
      sameNavigation(options.sessionNavigation?.(), current.sessionNavigation) &&
      connectionId() === current.connectionId
    );
  }

  function resetTopicState(
    current: WatchContext,
    preserveReady: boolean,
    preserveResources = false,
    preserveSessions = false
  ): void {
    topicStatus.sessions =
      (preserveReady || preserveSessions) && topicStatus.sessions === 'ready' ? 'ready' : 'loading';
    const keepResources = preserveReady || preserveResources;
    topicStatus.files = keepResources && topicStatus.files === 'ready' ? 'ready' : 'loading';
    topicStatus.changes = current.git
      ? keepResources && topicStatus.changes === 'ready'
        ? 'ready'
        : 'loading'
      : 'idle';
    revisions.sessions = -1;
    revisions.files = -1;
    revisions.changes = -1;
    revisions.sessionNavigation = -1;
    topicStatus.sessionNavigation = current.sessionNavigation === undefined ? 'idle' : 'loading';
  }

  async function requestWatch(
    key: string,
    signal: AbortSignal,
    mode: 'initial' | 'renew'
  ): Promise<void> {
    const current = context;
    if (current === undefined || targetKey(current) !== key) return;
    const accepted = await options.request<{ readonly nodeGeneration?: string }>(
      `/api/workspaces/${encodeURIComponent(current.workspaceId)}/watch`,
      {
        method: 'POST',
        signal,
        body: JSON.stringify({
          nodeId: current.nodeId,
          workbenchConnectionId: current.connectionId,
          watchId: current.watchId,
          mode,
          ...(mode === 'renew'
            ? {}
            : {
                ...(options.prepareFiles?.() === true ? { prepareFiles: true } : {}),
                topics: {
                  sessions: true,
                  ...(current.sessionGroup === undefined
                    ? {}
                    : { sessionGroup: current.sessionGroup }),
                  files: { path: current.directory, limit: 200 },
                  ...(current.sessionNavigation === undefined
                    ? {}
                    : { sessionNavigation: current.sessionNavigation }),
                  ...(current.git ? { changes: true } : {})
                }
              })
        })
      }
    );
    if (!eligible(key) || context?.watchId !== current.watchId) return;
    if (
      typeof accepted.nodeGeneration === 'string' &&
      current.nodeGeneration !== undefined &&
      current.nodeGeneration !== accepted.nodeGeneration
    )
      throw new Error('WORKSPACE_WATCH_GENERATION_CHANGED');
    if (typeof accepted.nodeGeneration === 'string')
      current.nodeGeneration = accepted.nodeGeneration;
    leaseFailures = 0;
  }

  const lifecycle = createWatchLeaseLifecycleService({
    heartbeatMs: options.heartbeatMs,
    requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
    confirmationTimeoutMs: options.confirmationTimeoutMs ?? options.heartbeatMs * 3,
    maxFailures: 3,
    eligible,
    renew: requestWatch,
    onExpired: () => {
      const current = context;
      if (current !== undefined) void restart(current.workspaceId);
    }
  });

  async function establish(
    workspaceId: string,
    directory: string,
    resetFailures: boolean
  ): Promise<void> {
    if (options.enabled?.() === false) return;
    const nodeId = options.workspaceTarget.value?.nodeId;
    const workspace = options.workspaces.value.find((candidate) => candidate.id === workspaceId);
    const currentConnectionId = connectionId();
    if (nodeId === undefined || workspace === undefined || currentConnectionId === undefined)
      return;
    const sessionGroup = options.sessionGroup?.();
    const query = options.sessionNavigation?.();
    const sessionNavigation =
      query === undefined
        ? undefined
        : {
            ...query,
            sessionIds: [...query.sessionIds],
            summaryAnchors: [...query.summaryAnchors]
          };
    const nextKey = `${currentConnectionId}:${nodeId}:${workspaceId}:${directory}:${workspace.kind === 'GIT_WORKSPACE' ? 'git' : 'directory'}:${sessionGroup ?? 'ALL'}`;
    if (
      resetFailures &&
      !paused &&
      context !== undefined &&
      targetKey(context) === nextKey &&
      sameNavigation(context.sessionNavigation, sessionNavigation)
    )
      return;
    const groupOnly =
      !paused &&
      context !== undefined &&
      context.connectionId === currentConnectionId &&
      context.nodeId === nodeId &&
      context.workspaceId === workspaceId &&
      context.directory === directory &&
      context.git === (workspace.kind === 'GIT_WORKSPACE') &&
      context.sessionGroup !== sessionGroup;
    const navigationOnly =
      !paused &&
      context !== undefined &&
      targetKey(context) === nextKey &&
      !sameNavigation(context.sessionNavigation, sessionNavigation);
    replaceLocally();
    if (resetFailures) {
      leaseFailures = 0;
      topicFailures.sessions = 0;
      topicFailures.files = 0;
      topicFailures.changes = 0;
      topicFailures.sessionNavigation = 0;
    }
    const next: WatchContext = {
      nodeId,
      workspaceId,
      directory,
      watchId: crypto.randomUUID().replace(/-/g, ''),
      connectionId: currentConnectionId,
      git: workspace.kind === 'GIT_WORKSPACE',
      ...(sessionGroup === undefined ? {} : { sessionGroup }),
      ...(sessionNavigation === undefined ? {} : { sessionNavigation })
    };
    context = next;
    paused = false;
    resetTopicState(next, !resetFailures, groupOnly || navigationOnly, navigationOnly);
    try {
      await lifecycle.start(targetKey(next));
    } catch {
      if (context?.watchId !== next.watchId) return;
      if (topicStatus.sessions !== 'ready') topicStatus.sessions = 'failed';
      if (topicStatus.files !== 'ready') topicStatus.files = 'failed';
      if (next.git && topicStatus.changes !== 'ready') topicStatus.changes = 'failed';
      if (next.sessionNavigation !== undefined && topicStatus.sessionNavigation !== 'ready')
        topicStatus.sessionNavigation = 'failed';
      leaseFailures += 1;
      if (leaseFailures <= 3) {
        topicRetryTimer = setTimeout(
          () => {
            topicRetryTimer = undefined;
            void establish(workspaceId, directory, false);
          },
          Math.min(options.heartbeatMs, 1_000 * 2 ** (leaseFailures - 1))
        );
      }
    }
  }

  function start(workspaceId: string, directory?: string): Promise<void> {
    const currentDirectory =
      context?.workspaceId === workspaceId &&
      context.nodeId === options.workspaceTarget.value?.nodeId
        ? context.directory
        : '.';
    return establish(workspaceId, directory ?? currentDirectory, true);
  }

  async function restart(workspaceId: string): Promise<void> {
    const directory = context?.directory ?? '.';
    replaceLocally();
    await establish(workspaceId, directory, true);
  }

  function retryFailed(): Promise<void> {
    const current = context;
    if (current === undefined || !Object.values(topicStatus).includes('failed'))
      return Promise.resolve();
    topicFailures.sessions = 0;
    topicFailures.files = 0;
    topicFailures.changes = 0;
    topicFailures.sessionNavigation = 0;
    leaseFailures = 0;
    return establish(current.workspaceId, current.directory, false);
  }

  function pause(): void {
    paused = true;
    if (topicRetryTimer !== undefined) clearTimeout(topicRetryTimer);
    topicRetryTimer = undefined;
    lifecycle.pause();
  }

  function replaceLocally(): void {
    if (topicRetryTimer !== undefined) clearTimeout(topicRetryTimer);
    topicRetryTimer = undefined;
    lifecycle.stop();
    context = undefined;
  }

  function stop(): void {
    const previous = context;
    replaceLocally();
    paused = false;
    topicStatus.sessions = 'idle';
    topicStatus.files = 'idle';
    topicStatus.changes = 'idle';
    topicStatus.sessionNavigation = 'idle';
    if (previous === undefined) return;
    void options
      .request(`/api/workspaces/${encodeURIComponent(previous.workspaceId)}/watch`, {
        method: 'DELETE',
        body: JSON.stringify({
          nodeId: previous.nodeId,
          workbenchConnectionId: previous.connectionId,
          watchId: previous.watchId
        })
      })
      .catch(() => undefined);
  }

  function identity(event: Record<string, unknown>): WatchContext | undefined {
    const current = context;
    if (
      current === undefined ||
      event.workbenchConnectionId !== current.connectionId ||
      event.watchId !== current.watchId ||
      event.nodeId !== current.nodeId ||
      event.workspaceId !== current.workspaceId ||
      options.sessionGroup?.() !== current.sessionGroup ||
      !sameNavigation(options.sessionNavigation?.(), current.sessionNavigation) ||
      typeof event.nodeGeneration !== 'string' ||
      (current.nodeGeneration !== undefined && event.nodeGeneration !== current.nodeGeneration)
    )
      return undefined;
    current.nodeGeneration ??= event.nodeGeneration;
    lifecycle.confirm(targetKey(current));
    return current;
  }

  function applySnapshot(event: Record<string, unknown>): boolean {
    if (
      event.type !== 'watch.workspace.snapshot' ||
      !isTopic(event.topic) ||
      !Number.isInteger(event.revision) ||
      (event.revision as number) < 0
    )
      return false;
    const current = identity(event);
    if (current === undefined) return false;
    const revision = event.revision as number;
    if (revision <= revisions[event.topic]) return true;
    revisions[event.topic] = revision;
    topicFailures[event.topic] = 0;
    topicStatus[event.topic] = 'ready';
    if (event.topic === 'sessions')
      options.onSnapshot(
        current.nodeId,
        current.workspaceId,
        { sessions: event.payload },
        event.topic,
        revision
      );
    else if (event.topic === 'files')
      options.onSnapshot(
        current.nodeId,
        current.workspaceId,
        { files: event.payload },
        event.topic,
        revision
      );
    else if (event.topic === 'changes')
      options.onSnapshot(
        current.nodeId,
        current.workspaceId,
        { changes: event.payload },
        event.topic,
        revision
      );
    else
      options.onSnapshot(
        current.nodeId,
        current.workspaceId,
        { sessionNavigation: event.payload },
        event.topic,
        revision,
        current.sessionNavigation
      );
    return true;
  }

  function applyFailure(event: Record<string, unknown>): boolean {
    if (event.type !== 'watch.failed' || event.watchType !== 'workspace' || !isTopic(event.topic))
      return false;
    const current = identity(event);
    if (current === undefined) return false;
    topicStatus[event.topic] = 'failed';
    topicFailures[event.topic] += 1;
    if (topicFailures[event.topic] > 3) return true;
    if (topicRetryTimer !== undefined) clearTimeout(topicRetryTimer);
    const workspaceId = current.workspaceId;
    topicRetryTimer = setTimeout(
      () => {
        topicRetryTimer = undefined;
        void establish(workspaceId, current.directory, false);
      },
      Math.min(options.heartbeatMs, 1_000 * 2 ** (topicFailures[event.topic] - 1))
    );
    return true;
  }

  return {
    start,
    restart,
    retryFailed,
    pause,
    stop,
    topicStatus: readonly(topicStatus),
    handleEvent(value: unknown): boolean {
      if (typeof value !== 'object' || value === null) return false;
      const event = value as Record<string, unknown>;
      return applyFailure(event) || applySnapshot(event);
    }
  };
}

function isTopic(value: unknown): value is WorkspaceWatchTopic {
  return (
    value === 'sessions' ||
    value === 'files' ||
    value === 'changes' ||
    value === 'sessionNavigation'
  );
}

export function sameNavigation(
  left: import('@myagentroam/protocol').WorkspaceSessionNavigationQuery | undefined,
  right: import('@myagentroam/protocol').WorkspaceSessionNavigationQuery | undefined
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.limit === right.limit &&
      left.treeAnchor === right.treeAnchor &&
      left.sessionIds.length === right.sessionIds.length &&
      left.sessionIds.every((id, i) => id === right.sessionIds[i]) &&
      left.summaryAnchors.length === right.summaryAnchors.length &&
      left.summaryAnchors.every((id, i) => id === right.summaryAnchors[i]))
  );
}
