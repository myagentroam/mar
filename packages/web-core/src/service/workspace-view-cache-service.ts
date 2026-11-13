import {
  mergeConversationProjectionUnits,
  syncConversationRunStatus
} from '../util/conversation-segments.js';
import { shallowRef } from 'vue';
import type { WorkspaceContentSearchSnapshot } from './workspace-content-search-service.js';
import type { WorkspaceFileTreeSnapshot } from './workspace-file-tree-service.js';
import type { WorkspaceGitSnapshot } from './workspace-git-service.js';
import type { WorkspaceSessionListSnapshot } from './workspace-session-service.js';
import type { WorkspaceFileWorkbenchSnapshot } from '../model/workspace-file-workbench.js';
import type {
  AgentRun,
  CachedSessionDetail,
  ConversationTurn,
  Session,
  WorkspaceQueue
} from '../model/workbench.js';
import { newestRunSnapshot } from '../util/run-state.js';
import {
  newestWorkspaceQueueSnapshot,
  reconcileWorkspaceQueueSnapshot,
  type WorkspaceQueueSnapshotSource
} from './workspace-queue-projection-service.js';
import { sessionHasNativeIdentity } from '../util/session-presentation.js';
import {
  limitConversationHistory,
  limitRecentConversationSegments
} from '../util/conversation-history.js';

export interface WorkspaceCacheDraft {
  readonly runner: Session['runner'];
  readonly modelId: string;
  readonly effort: string;
  readonly access: string;
}

export interface WorkspaceCacheView {
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly sessions: readonly Session[];
  readonly sessionList?: WorkspaceSessionListSnapshot;
  readonly selectedSessionId?: string;
  readonly draft?: WorkspaceCacheDraft;
  readonly fileWorkbench?: WorkspaceFileWorkbenchSnapshot | undefined;
  readonly search?: WorkspaceContentSearchSnapshot;
  readonly files?: WorkspaceFileTreeSnapshot;
  readonly git?: WorkspaceGitSnapshot;
}

export interface WorkspaceCacheCapture {
  readonly sessions: readonly Session[];
  readonly sessionList?: WorkspaceSessionListSnapshot;
  readonly fileWorkbench?: WorkspaceFileWorkbenchSnapshot | undefined;
  readonly search?: WorkspaceContentSearchSnapshot;
  readonly files?: WorkspaceFileTreeSnapshot;
  readonly git?: WorkspaceGitSnapshot;
  readonly draft?: WorkspaceCacheDraft;
  readonly selectedSessionId?: string;
  readonly queue?: WorkspaceQueue;
  readonly detail?: Readonly<CachedSessionDetail>;
  /** The Conversation projection already applied its byte limit to this immutable window. */
  readonly detailHistoryAlreadyBounded?: boolean;
}

interface WorkspaceViewCache {
  readonly nodeId: string;
  readonly workspaceId: string;
  sessions: readonly Session[];
  sessionList?: WorkspaceSessionListSnapshot;
  selectedSessionId?: string;
  /** Workspace draft Runner configuration; editable content belongs to the draft owner. */
  draft?: WorkspaceCacheDraft;
  /** Only safely restorable file workbench state, excluding file bodies and incomplete uploads. */
  fileWorkbench?: WorkspaceFileWorkbenchSnapshot | undefined;
  search?: WorkspaceContentSearchSnapshot;
  files?: WorkspaceFileTreeSnapshot;
  git?: WorkspaceGitSnapshot;
  readonly queues: Map<string, WorkspaceQueue>;
  readonly sessionDetails: Map<string, CachedSessionDetail>;
}

/** Owns immutable Workspace snapshots; queue and detail retention are bounded independently. */
export function createWorkspaceViewCacheService(
  tabId: (nodeId: string, workspaceId: string) => string
) {
  const caches = new Map<string, WorkspaceViewCache>();
  const active = shallowRef<WorkspaceViewCache>();

  function get(nodeId: string, workspaceId: string): WorkspaceViewCache {
    const id = tabId(nodeId, workspaceId);
    const current = caches.get(id);
    if (current !== undefined) return current;
    const created: WorkspaceViewCache = {
      nodeId,
      workspaceId,
      sessions: [],
      queues: new Map(),
      sessionDetails: new Map()
    };
    caches.set(id, created);
    return created;
  }

  function remove(nodeId: string, workspaceId: string): void {
    const id = tabId(nodeId, workspaceId);
    if (active.value?.nodeId === nodeId && active.value.workspaceId === workspaceId)
      active.value = undefined;
    caches.delete(id);
  }

  function removeSession(nodeId: string, workspaceId: string, sessionId: string): void {
    const cache = caches.get(tabId(nodeId, workspaceId));
    if (cache === undefined) return;
    cache.sessions = cache.sessions.filter((session) => session.id !== sessionId);
    cache.sessionDetails.delete(sessionId);
    cache.queues.delete(sessionId);
    if (cache.selectedSessionId === sessionId) delete cache.selectedSessionId;
  }

  function queueFor(
    nodeId: string,
    workspaceId: string,
    sessionId: string
  ): WorkspaceQueue | undefined {
    return caches.get(tabId(nodeId, workspaceId))?.queues.get(sessionId);
  }

  function invalidateDetail(nodeId: string, workspaceId: string, sessionId: string): void {
    caches.get(tabId(nodeId, workspaceId))?.sessionDetails.delete(sessionId);
  }

  function replaceSession(
    nodeId: string,
    workspaceId: string,
    previousId: string,
    session: Session
  ): void {
    if (previousId !== session.id) {
      migrateSession(nodeId, workspaceId, previousId, session.id, session);
      return;
    }
    const cache = caches.get(tabId(nodeId, workspaceId));
    if (cache === undefined) return;
    cache.sessions = cache.sessions.map((item) => (item.id === previousId ? session : item));
  }

  function removeNode(nodeId: string): void {
    if (active.value?.nodeId === nodeId) active.value = undefined;
    for (const id of caches.keys()) if (id.startsWith(`${nodeId}:`)) caches.delete(id);
  }

  function activate(nodeId: string, workspaceId: string): void {
    active.value = get(nodeId, workspaceId);
  }

  function deactivate(): void {
    active.value = undefined;
  }

  function view(nodeId: string, workspaceId: string): WorkspaceCacheView {
    const cache = get(nodeId, workspaceId);
    return {
      nodeId: cache.nodeId,
      workspaceId: cache.workspaceId,
      sessions: cache.sessions,
      ...(cache.sessionList === undefined ? {} : { sessionList: cache.sessionList }),
      ...(cache.selectedSessionId === undefined
        ? {}
        : { selectedSessionId: cache.selectedSessionId }),
      ...(cache.draft === undefined ? {} : { draft: cache.draft }),
      ...(cache.fileWorkbench === undefined ? {} : { fileWorkbench: cache.fileWorkbench }),
      ...(cache.search === undefined ? {} : { search: cache.search }),
      ...(cache.files === undefined ? {} : { files: cache.files }),
      ...(cache.git === undefined ? {} : { git: cache.git })
    };
  }

  function isActive(nodeId: string, workspaceId: string): boolean {
    return active.value?.nodeId === nodeId && active.value.workspaceId === workspaceId;
  }

  function hasActive(): boolean {
    return active.value !== undefined;
  }

  function has(nodeId: string, workspaceId: string): boolean {
    return caches.has(tabId(nodeId, workspaceId));
  }

  function updateSearch(
    nodeId: string,
    workspaceId: string,
    snapshot: WorkspaceContentSearchSnapshot
  ): void {
    const cache = caches.get(tabId(nodeId, workspaceId));
    if (cache !== undefined) cache.search = snapshot;
  }

  function captureCommandTarget(nodeId: string, workspaceId: string) {
    const key = tabId(nodeId, workspaceId);
    const cache = caches.get(key);
    if (cache === undefined) return undefined;
    return {
      isCurrent: () => caches.get(key) === cache,
      replaceSession(previousId: string, session: Session): void {
        if (caches.get(key) === cache) replaceSession(nodeId, workspaceId, previousId, session);
      },
      cacheRun(run: AgentRun): void {
        if (caches.get(key) === cache) cacheRun(nodeId, workspaceId, run);
      }
    };
  }

  function cacheQueue(
    nodeId: string,
    workspaceId: string,
    sessionId: string,
    queue: WorkspaceQueue,
    source: WorkspaceQueueSnapshotSource
  ): void {
    const cache = caches.get(tabId(nodeId, workspaceId));
    if (cache === undefined) return;
    cache.queues.set(
      sessionId,
      reconcileWorkspaceQueueSnapshot(cache.queues.get(sessionId), queue, source)
    );
    trimQueues(cache, sessionId);
  }

  function trimQueues(cache: WorkspaceViewCache, newestSessionId?: string): void {
    for (const sessionId of cache.queues.keys()) {
      if (cache.queues.size <= 32) break;
      if (
        sessionId !== newestSessionId &&
        sessionId !== cache.selectedSessionId &&
        !cache.sessionDetails.has(sessionId)
      )
        cache.queues.delete(sessionId);
    }
  }

  function saveDetail(
    cache: WorkspaceViewCache,
    detail: Readonly<CachedSessionDetail>,
    maximum: number,
    protectedSessionIds: ReadonlySet<string>,
    historyAlreadyBounded = false
  ): void {
    const historyLimited = historyAlreadyBounded
      ? detail.turns
      : limitConversationHistory(detail.turns);
    const turns = limitRecentConversationSegments(historyLimited);
    cache.sessionDetails.set(detail.sessionId, {
      ...detail,
      turns,
      nextCursor: turns.length < historyLimited.length ? null : detail.nextCursor
    });
    while (cache.sessionDetails.size > maximum) {
      const leastRecentlyUsed = [...cache.sessionDetails.values()]
        .filter((candidate) => !protectedSessionIds.has(candidate.sessionId))
        .reduce<CachedSessionDetail | undefined>(
          (oldest, candidate) =>
            oldest === undefined || candidate.lastAccessedAt < oldest.lastAccessedAt
              ? candidate
              : oldest,
          undefined
        );
      if (leastRecentlyUsed === undefined) break;
      cache.sessionDetails.delete(leastRecentlyUsed.sessionId);
    }
  }

  function capture(
    cache: WorkspaceViewCache,
    input: WorkspaceCacheCapture,
    maximumDetails: number,
    otherVisibleSessionId?: string
  ): void {
    cache.sessions = input.sessions.filter(
      (session) => session.workspaceId === cache.workspaceId && sessionHasNativeIdentity(session)
    );
    cache.fileWorkbench = input.fileWorkbench;
    if ('sessionList' in input) {
      if (input.sessionList === undefined) delete cache.sessionList;
      else cache.sessionList = input.sessionList;
    }
    if ('search' in input) {
      if (input.search === undefined) delete cache.search;
      else cache.search = input.search;
    }
    if ('files' in input) {
      if (input.files === undefined) delete cache.files;
      else cache.files = input.files;
    }
    if ('git' in input) {
      if (input.git === undefined) delete cache.git;
      else cache.git = input.git;
    }
    if (input.draft === undefined) delete cache.draft;
    else cache.draft = input.draft;
    const selected = input.sessions.find((session) => session.id === input.selectedSessionId);
    if (!sessionHasNativeIdentity(selected)) {
      delete cache.selectedSessionId;
      if (input.selectedSessionId !== undefined) {
        cache.queues.delete(input.selectedSessionId);
        cache.sessionDetails.delete(input.selectedSessionId);
      }
      return;
    }
    cache.selectedSessionId = selected.id;
    if (input.queue !== undefined)
      cache.queues.set(
        selected.id,
        newestWorkspaceQueueSnapshot(cache.queues.get(selected.id), input.queue)
      );
    if (input.detail !== undefined)
      saveDetail(
        cache,
        input.detail,
        maximumDetails,
        new Set(
          otherVisibleSessionId === undefined ? [selected.id] : [selected.id, otherVisibleSessionId]
        ),
        input.detailHistoryAlreadyBounded === true
      );
    trimQueues(cache, selected.id);
  }

  /** Save another visible session without changing the Workspace's main selection. */
  function captureSession(
    nodeId: string,
    workspaceId: string,
    session: Session,
    queue: WorkspaceQueue,
    detail: Readonly<CachedSessionDetail>,
    maximumDetails: number
  ): void {
    const cache = caches.get(tabId(nodeId, workspaceId));
    if (
      cache === undefined ||
      session.workspaceId !== workspaceId ||
      session.id !== detail.sessionId ||
      !sessionHasNativeIdentity(session)
    )
      return;
    cache.queues.set(session.id, newestWorkspaceQueueSnapshot(cache.queues.get(session.id), queue));
    const protectedIds = new Set([session.id]);
    if (cache.selectedSessionId !== undefined) protectedIds.add(cache.selectedSessionId);
    saveDetail(cache, detail, maximumDetails, protectedIds, true);
    trimQueues(cache, session.id);
  }

  function captureActive(
    input: WorkspaceCacheCapture,
    maximumDetails: number,
    otherVisibleSessionId?: string
  ): void {
    const cache = active.value;
    if (cache === undefined) return;
    capture(
      cache,
      {
        ...input,
        fileWorkbench: 'fileWorkbench' in input ? input.fileWorkbench : cache.fileWorkbench
      },
      maximumDetails,
      otherVisibleSessionId
    );
  }

  function touchDetail(
    nodeId: string,
    workspaceId: string,
    sessionId: string,
    accessedAt = Date.now()
  ): Readonly<CachedSessionDetail> | undefined {
    const detail = caches.get(tabId(nodeId, workspaceId))?.sessionDetails.get(sessionId);
    if (detail !== undefined) detail.lastAccessedAt = accessedAt;
    return detail;
  }

  function mutableDetail(
    nodeId: string,
    workspaceId: string,
    sessionId: string
  ): CachedSessionDetail | undefined {
    return caches.get(tabId(nodeId, workspaceId))?.sessionDetails.get(sessionId);
  }

  function detail(
    nodeId: string,
    workspaceId: string,
    sessionId: string
  ): Readonly<CachedSessionDetail> | undefined {
    return mutableDetail(nodeId, workspaceId, sessionId);
  }

  function updateContext(
    nodeId: string,
    workspaceId: string,
    sessionId: string,
    context: CachedSessionDetail['contextUsage']
  ): void {
    const cached = mutableDetail(nodeId, workspaceId, sessionId);
    if (cached !== undefined) cached.contextUsage = context;
  }

  function syncRunStatus(
    nodeId: string,
    workspaceId: string,
    sessionId: string,
    runId: string,
    status: ConversationTurn['status']
  ): void {
    const cached = mutableDetail(nodeId, workspaceId, sessionId);
    if (cached !== undefined) cached.turns = syncConversationRunStatus(cached.turns, runId, status);
  }

  function migrateSession(
    nodeId: string,
    workspaceId: string,
    previousId: string,
    nextId: string,
    nextSession?: Session
  ) {
    if (previousId === nextId || !sessionHasNativeIdentity(nextSession)) return;
    const cache = caches.get(tabId(nodeId, workspaceId));
    if (cache === undefined) return;
    if (nextSession !== undefined)
      cache.sessions = cache.sessions.map((session) =>
        session.id === previousId ? nextSession : session
      );
    const detail = cache.sessionDetails.get(previousId);
    if (detail !== undefined) {
      cache.sessionDetails.delete(previousId);
      cache.sessionDetails.set(nextId, {
        ...detail,
        sessionId: nextId,
        turns: detail.turns.map((turn) =>
          turn.sessionId === previousId ? { ...turn, sessionId: nextId } : turn
        )
      });
    }
    const queue = cache.queues.get(previousId);
    if (queue !== undefined) {
      cache.queues.delete(previousId);
      cache.queues.set(nextId, newestWorkspaceQueueSnapshot(cache.queues.get(nextId), queue));
    }
    if (cache.selectedSessionId === previousId) cache.selectedSessionId = nextId;
  }

  function cacheRun(nodeId: string, workspaceId: string, run: AgentRun): void {
    if (run.sessionId === undefined) return;
    const cached = mutableDetail(nodeId, workspaceId, run.sessionId);
    if (cached === undefined) return;
    const current = cached.runs.find((candidate) => candidate.id === run.id);
    const next = newestRunSnapshot(current, run);
    cached.runs = [next, ...cached.runs.filter((candidate) => candidate.id !== run.id)];
  }

  function cacheTurn(nodeId: string, workspaceId: string, turn: ConversationTurn): void {
    const cached = mutableDetail(nodeId, workspaceId, turn.sessionId);
    if (cached === undefined) return;
    const historyLimited = limitConversationHistory(
      mergeConversationProjectionUnits(cached.turns, [turn])
    );
    cached.turns = limitRecentConversationSegments(historyLimited);
    if (cached.turns.length < historyLimited.length) cached.nextCursor = null;
  }

  function replaceTurns(
    nodeId: string,
    workspaceId: string,
    sessionId: string,
    turns: readonly ConversationTurn[],
    nextCursor: string | null
  ): void {
    const cached = mutableDetail(nodeId, workspaceId, sessionId);
    if (cached === undefined) return;
    cached.turns = limitRecentConversationSegments(limitConversationHistory(turns));
    cached.nextCursor = nextCursor;
  }

  return {
    view,
    isActive,
    hasActive,
    has,
    updateSearch,
    captureCommandTarget,
    captureActive,
    captureSession,
    activate,
    deactivate,
    remove,
    removeSession,
    queueFor,
    invalidateDetail,
    replaceSession,
    removeNode,
    detail,
    updateContext,
    syncRunStatus,
    touchDetail,
    migrateSession,
    cacheRun,
    cacheTurn,
    cacheQueue,
    replaceTurns,
    clear: () => {
      active.value = undefined;
      caches.clear();
    }
  };
}
