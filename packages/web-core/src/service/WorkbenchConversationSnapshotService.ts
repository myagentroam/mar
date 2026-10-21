import type { Ref } from 'vue';
import type { ConversationTurnPage } from '../model/workbench.js';

export function createWorkbenchConversationSnapshotService(options: {
  readonly selectedSessionId: Ref<string | undefined>;
  readonly replaceCurrent: (page: ConversationTurnPage) => boolean;
  readonly mergeCurrent: (page: ConversationTurnPage) => boolean;
  readonly currentWindow: () => Pick<ConversationTurnPage, 'turns' | 'nextCursor'>;
  readonly replaceCached: (sessionId: string, page: ConversationTurnPage) => void;
}) {
  function apply(
    sessionId: string,
    page: ConversationTurnPage,
    mode: 'initial' | 'refresh' = 'initial'
  ): boolean {
    if (sessionId !== options.selectedSessionId.value) {
      options.replaceCached(sessionId, page);
      return false;
    }
    const changed = mode === 'initial' ? options.replaceCurrent(page) : options.mergeCurrent(page);
    options.replaceCached(sessionId, { ...page, ...options.currentWindow() });
    return changed;
  }

  return { apply };
}
