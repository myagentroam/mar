import type { MessageFeedback } from '../model/message-feedback.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import { nextTick, ref, watch, type Ref } from 'vue';
import type { ConversationSegmentPage, ConversationTurnPage } from '../model/workbench.js';
import { translate } from './locale-preference-service.js';
import { segmentPageAsTurnPage } from '../util/conversation-segments.js';
import { errorCode } from '../util/api-error.js';

/** Owns older-turn pagination and scroll-position preservation. */
export function createWorkbenchConversationPagingService(options: {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Ref<string | undefined>;
  readonly nextCursor: Readonly<Ref<string | null>>;
  readonly loadingOlder: Ref<boolean>;
  readonly capturePrependAnchor: () => () => void;
  readonly pageSize: number;
  readonly recentSegmentWindowSize: number;
  readonly replaceRecent: (page: ConversationTurnPage) => boolean | void;
  readonly mergeOlderPage: (page: ConversationTurnPage) => void;
  readonly recoverWindow: (page: ConversationTurnPage) => void;
  readonly clearCursor: () => void;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly sessionPathId: (sessionId: string) => string;
  readonly notice: MessageFeedback;
  readonly errorMessage: (error: unknown) => string;
}) {
  let refreshingRecent = false;
  let refreshQueued = false;
  let windowRevision = 0;
  const olderHistoryError = ref('');
  watch(
    [options.workspaceTarget, options.selectedSessionId],
    () => {
      windowRevision += 1;
      refreshingRecent = false;
      refreshQueued = false;
      options.loadingOlder.value = false;
      olderHistoryError.value = '';
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
    options.loadingOlder.value = true;
    olderHistoryError.value = '';
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
        if (
          recoveredCursor === undefined ||
          options.workspaceTarget.value?.nodeId !== nodeId ||
          options.selectedSessionId.value !== sessionId ||
          windowRevision !== revision ||
          options.nextCursor.value !== (recoveredCursor ?? requestCursor)
        )
          return;
        if (recoveredCursor === null) {
          const restoreAnchor = options.capturePrependAnchor();
          options.clearCursor();
          await nextTick();
          if (
            windowRevision === revision &&
            options.workspaceTarget.value?.nodeId === nodeId &&
            options.selectedSessionId.value === sessionId &&
            options.nextCursor.value === null
          )
            restoreAnchor();
          return;
        }
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
      const restoreAnchor = options.capturePrependAnchor();
      options.mergeOlderPage(page);
      await nextTick();
      if (
        windowRevision === revision &&
        options.workspaceTarget.value?.nodeId === nodeId &&
        options.selectedSessionId.value === sessionId
      )
        restoreAnchor();
    } catch (error) {
      if (
        options.workspaceTarget.value?.nodeId === nodeId &&
        options.selectedSessionId.value === sessionId &&
        windowRevision === revision &&
        options.nextCursor.value === requestCursor
      )
        olderHistoryError.value = translate(
          'generated.workbenchConversationPagingService.unableToLoadEarlierConversationHistory',
          { value0: options.errorMessage(error) }
        );
    } finally {
      if (windowRevision === revision) options.loadingOlder.value = false;
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
    // Render recovered content before removing an exhausted history boundary so that
    // its anchor compensation excludes any newly appended recent content.
    const recoveryPage = page.nextCursor === null ? { ...page, nextCursor: expiredCursor } : page;
    options.recoverWindow(recoveryPage);
    await nextTick();
    if (
      options.workspaceTarget.value?.nodeId !== nodeId ||
      options.selectedSessionId.value !== sessionId ||
      windowRevision !== revision ||
      options.nextCursor.value !== recoveryPage.nextCursor
    )
      return undefined;
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
    let revision = windowRevision;
    try {
      do {
        refreshQueued = false;
        revision = ++windowRevision;
        options.loadingOlder.value = false;
        olderHistoryError.value = '';
        const response = await options.request<ConversationTurnPage | ConversationSegmentPage>(
          `/api/agent-sessions/${options.sessionPathId(sessionId)}/turns?nodeId=${encodeURIComponent(nodeId)}&limit=${options.recentSegmentWindowSize}&unit=SEGMENT`
        );
        const page = segmentPageAsTurnPage(response);
        if (
          windowRevision !== revision ||
          options.workspaceTarget.value?.nodeId !== nodeId ||
          options.selectedSessionId.value !== sessionId
        )
          return;
        if (!refreshQueued) options.replaceRecent(page);
      } while (refreshQueued);
    } catch {
      // Keep the expanded window and its cursor intact; retry on a later new Turn or session open.
    } finally {
      if (windowRevision === revision) refreshingRecent = false;
    }
  }

  return {
    olderHistoryError,
    loadOlderConversationTurns,
    refreshRecentConversationTurns
  };
}
