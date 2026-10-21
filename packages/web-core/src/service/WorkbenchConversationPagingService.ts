import type { WorkspaceTarget } from '../model/workbench.js';
import { nextTick, watch, type Ref } from 'vue';
import type {
  ConversationSegmentPage,
  ConversationTurn,
  ConversationTurnPage
} from '../model/workbench.js';
import { translate } from './LocalePreferenceService.js';
import { limitConversationHistory } from '../util/conversation-history.js';
import {
  segmentPageAsTurnPage,
  mergeConversationProjectionUnits
} from '../util/conversation-segments.js';
import { errorCode } from '../util/api-error.js';

/** Owns older-turn pagination and scroll-position preservation. */
export function createWorkbenchConversationPagingService(options: {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Ref<string | undefined>;
  readonly nextCursor: Ref<string | null>;
  readonly loadingOlder: Ref<boolean>;
  readonly turns: Ref<ConversationTurn[]>;
  readonly scrollElement: Ref<HTMLElement | undefined>;
  readonly pageSize: number;
  readonly recentSegmentWindowSize: number;
  readonly replaceRecent: (page: ConversationTurnPage) => boolean | void;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly sessionPathId: (sessionId: string) => string;
  readonly notice: Ref<string>;
  readonly errorMessage: (error: unknown) => string;
}) {
  let refreshingRecent = false;
  let refreshQueued = false;
  let windowRevision = 0;
  watch(
    options.workspaceTarget,
    () => {
      windowRevision += 1;
      refreshingRecent = false;
      refreshQueued = false;
      options.loadingOlder.value = false;
    },
    { flush: 'sync' }
  );
  async function loadOlderConversationTurns(): Promise<void> {
    await loadOlderPage(options.pageSize);
  }

  async function loadOlderPage(limit: number): Promise<void> {
    const nodeId = options.workspaceTarget.value?.nodeId;
    const sessionId = options.selectedSessionId.value;
    const cursor = options.nextCursor.value;
    if (
      nodeId === undefined ||
      sessionId === undefined ||
      cursor === null ||
      options.loadingOlder.value ||
      refreshingRecent
    )
      return;
    const revision = windowRevision;
    const element = options.scrollElement.value;
    let previousHeight = element?.scrollHeight ?? 0;
    options.loadingOlder.value = true;
    let requestCursor = cursor;
    try {
      let page: ConversationTurnPage;
      try {
        page = await requestOlderPage(nodeId, sessionId, limit, requestCursor);
      } catch (error) {
        if (errorCode(error) !== 'EVENT_CURSOR_INVALID') throw error;
        if (
          options.workspaceTarget.value?.nodeId !== nodeId ||
          options.selectedSessionId.value !== sessionId ||
          windowRevision !== revision ||
          options.nextCursor.value !== requestCursor
        )
          return;
        const recoveredCursor = await recoverPaginationCursor(
          nodeId,
          sessionId,
          requestCursor,
          revision
        );
        if (recoveredCursor === undefined) return;
        if (recoveredCursor === null) {
          options.nextCursor.value = null;
          return;
        }
        await nextTick();
        previousHeight = element?.scrollHeight ?? previousHeight;
        requestCursor = recoveredCursor;
        page = await requestOlderPage(nodeId, sessionId, limit, requestCursor);
      }
      if (
        options.workspaceTarget.value?.nodeId !== nodeId ||
        options.selectedSessionId.value !== sessionId ||
        windowRevision !== revision ||
        options.nextCursor.value !== requestCursor
      )
        return;
      const known = new Set(options.turns.value.map((turn) => turn.id));
      options.turns.value = limitConversationHistory([
        ...page.turns.filter((turn) => !known.has(turn.id)),
        ...options.turns.value
      ]);
      options.nextCursor.value = page.nextCursor;
      await nextTick();
      if (element !== undefined) element.scrollTop += element.scrollHeight - previousHeight;
    } catch (error) {
      if (
        options.workspaceTarget.value?.nodeId === nodeId &&
        options.selectedSessionId.value === sessionId &&
        windowRevision === revision &&
        options.nextCursor.value === requestCursor
      )
        options.notice.value = translate(
          'generated.workbenchConversationPagingService.unableToLoadEarlierConversationHistory',
          { value0: options.errorMessage(error) }
        );
    } finally {
      options.loadingOlder.value = false;
    }
  }

  async function requestOlderPage(
    nodeId: string,
    sessionId: string,
    limit: number,
    cursor: string
  ): Promise<ConversationTurnPage> {
    const response = await options.request<ConversationTurnPage | ConversationSegmentPage>(
      `/api/agent-sessions/${options.sessionPathId(sessionId)}/turns?nodeId=${encodeURIComponent(nodeId)}&limit=${limit}&cursor=${encodeURIComponent(cursor)}&unit=SEGMENT`
    );
    return segmentPageAsTurnPage(response);
  }

  async function recoverPaginationCursor(
    nodeId: string,
    sessionId: string,
    expiredCursor: string,
    revision: number
  ): Promise<string | null | undefined> {
    const response = await options.request<ConversationTurnPage | ConversationSegmentPage>(
      `/api/agent-sessions/${options.sessionPathId(sessionId)}/turns?nodeId=${encodeURIComponent(nodeId)}&limit=${options.recentSegmentWindowSize}&unit=SEGMENT`
    );
    const page = segmentPageAsTurnPage(response);
    if (
      options.workspaceTarget.value?.nodeId !== nodeId ||
      options.selectedSessionId.value !== sessionId ||
      windowRevision !== revision ||
      options.nextCursor.value !== expiredCursor
    )
      return undefined;
    options.turns.value = limitConversationHistory(
      mergeConversationProjectionUnits(options.turns.value, page.turns)
    );
    options.nextCursor.value = page.nextCursor;
    return page.nextCursor;
  }

  async function refreshRecentConversationTurns(): Promise<void> {
    const nodeId = options.workspaceTarget.value?.nodeId;
    const sessionId = options.selectedSessionId.value;
    if (nodeId === undefined || sessionId === undefined) return;
    if (refreshingRecent) {
      refreshQueued = true;
      return;
    }
    refreshingRecent = true;
    try {
      do {
        refreshQueued = false;
        windowRevision += 1;
        const response = await options.request<ConversationTurnPage | ConversationSegmentPage>(
          `/api/agent-sessions/${options.sessionPathId(sessionId)}/turns?nodeId=${encodeURIComponent(nodeId)}&limit=${options.recentSegmentWindowSize}&unit=SEGMENT`
        );
        const page = segmentPageAsTurnPage(response);
        if (
          options.workspaceTarget.value?.nodeId !== nodeId ||
          options.selectedSessionId.value !== sessionId
        )
          return;
        if (!refreshQueued) options.replaceRecent(page);
      } while (refreshQueued);
    } catch {
      // Keep the expanded window and its cursor intact; retry on a later new Turn or session open.
    } finally {
      refreshingRecent = false;
    }
  }

  return {
    loadOlderConversationTurns,
    refreshRecentConversationTurns
  };
}
