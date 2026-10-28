import type { Ref } from 'vue';
import type { ConversationTurn } from '../model/workbench.js';
import type { createConversationProjectionService } from './conversation-projection-service.js';
import { createWorkbenchConversationPagingService } from './workbench-conversation-paging-service.js';
import { createWorkbenchConversationSnapshotService } from './workbench-conversation-snapshot-service.js';

type PagingOptions = Parameters<typeof createWorkbenchConversationPagingService>[0];

export function createWorkbenchConversationComposition(
  options: Pick<
    PagingOptions,
    | 'workspaceTarget'
    | 'selectedSessionId'
    | 'nextCursor'
    | 'loadingOlder'
    | 'capturePrependAnchor'
    | 'pageSize'
    | 'recentSegmentWindowSize'
    | 'request'
    | 'sessionPathId'
    | 'notice'
    | 'errorMessage'
  > & {
    readonly turns: Readonly<Ref<readonly ConversationTurn[]>>;
    readonly projection: ReturnType<typeof createConversationProjectionService>;
    readonly replaceCached: (
      sessionId: string,
      turns: readonly ConversationTurn[],
      nextCursor: string | null
    ) => void;
  }
) {
  const { projection, turns, replaceCached, ...pagingOptions } = options;
  const snapshots = createWorkbenchConversationSnapshotService({
    selectedSessionId: options.selectedSessionId,
    replaceCurrent: projection.replaceAuthoritative,
    mergeCurrent: projection.mergeLatest,
    currentWindow: () => ({ turns: turns.value, nextCursor: options.nextCursor.value }),
    replaceCached: (sessionId, page) => replaceCached(sessionId, page.turns, page.nextCursor)
  });
  const paging = createWorkbenchConversationPagingService({
    ...pagingOptions,
    replaceRecent: projection.replaceRecent,
    mergeOlderPage: projection.mergeOlderPage,
    recoverWindow: projection.recoverWindow,
    clearCursor: projection.clearCursor
  });
  return { applySnapshot: snapshots.apply, paging };
}
