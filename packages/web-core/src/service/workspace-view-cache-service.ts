import { mergeConversationProjectionUnits } from '../util/conversation-segments.js';
import { shallowRef } from 'vue';
import type {
  AgentRun,
  CachedSessionDetail,
  ConversationTurn,
  Session,
  WorkspaceViewCache
} from '../model/workbench.js';
import { newestRunSnapshot } from './run-service.js';
import { newestWorkspaceQueueSnapshot } from './workspace-queue-projection-service.js';
import { sessionHasNativeIdentity } from '../util/session-presentation.js';
import {
  limitConversationHistory,
  limitRecentConversationSegments
} from '../util/conversation-history.js';

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

  function removeNode(nodeId: string): void {
    if (active.value?.nodeId === nodeId) active.value = undefined;
    for (const id of caches.keys()) if (id.startsWith(`${nodeId}:`)) caches.delete(id);
  }

  function activate(nodeId: string, workspaceId: string): WorkspaceViewCache {
    const cache = get(nodeId, workspaceId);
    active.value = cache;
    return cache;
  }

  function deactivate(): void {
    active.value = undefined;
  }

  function saveDetail(
    cache: WorkspaceViewCache,
    detail: CachedSessionDetail,
    maximum: number,
    protectedSessionId: string,
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
        .filter((candidate) => candidate.sessionId !== protectedSessionId)
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
    input: {
      readonly sessions: readonly Session[];
      readonly inspector?: unknown;
      readonly draft?: WorkspaceViewCache['draft'];
      readonly selectedSessionId?: string;
      readonly queue?: WorkspaceViewCache['queues'] extends Map<string, infer T> ? T : never;
      readonly detail?: CachedSessionDetail;
      /** The Conversation projection already applied its byte limit to this immutable window. */
      readonly detailHistoryAlreadyBounded?: boolean;
    },
    maximumDetails: number
  ): void {
    cache.sessions = input.sessions.filter(
      (session) => session.workspaceId === cache.workspaceId && sessionHasNativeIdentity(session)
    );
    cache.inspector = input.inspector;
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
        selected.id,
        input.detailHistoryAlreadyBounded === true
      );
  }

  function touchDetail(
    nodeId: string,
    workspaceId: string,
    sessionId: string,
    accessedAt = Date.now()
  ): CachedSessionDetail | undefined {
    const detail = get(nodeId, workspaceId).sessionDetails.get(sessionId);
    if (detail !== undefined) detail.lastAccessedAt = accessedAt;
    return detail;
  }

  function detail(
    nodeId: string,
    workspaceId: string,
    sessionId: string
  ): CachedSessionDetail | undefined {
    return caches.get(tabId(nodeId, workspaceId))?.sessionDetails.get(sessionId);
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
    const cached = detail(nodeId, workspaceId, run.sessionId);
    if (cached === undefined) return;
    const current = cached.runs.find((candidate) => candidate.id === run.id);
    const next = newestRunSnapshot(current, run);
    cached.runs = [next, ...cached.runs.filter((candidate) => candidate.id !== run.id)];
  }

  function cacheTurn(nodeId: string, workspaceId: string, turn: ConversationTurn): void {
    const cached = detail(nodeId, workspaceId, turn.sessionId);
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
    const cached = detail(nodeId, workspaceId, sessionId);
    if (cached === undefined) return;
    cached.turns = limitRecentConversationSegments(limitConversationHistory(turns));
    cached.nextCursor = nextCursor;
  }

  return {
    caches,
    active,
    get,
    activate,
    deactivate,
    remove,
    removeNode,
    saveDetail,
    capture,
    detail,
    touchDetail,
    migrateSession,
    cacheRun,
    cacheTurn,
    replaceTurns
  };
}
