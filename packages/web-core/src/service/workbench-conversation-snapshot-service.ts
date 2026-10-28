import type { Ref } from 'vue';
import type { ConversationTurn, ConversationTurnPage } from '../model/workbench.js';

interface ConversationWindow {
  readonly turns: readonly ConversationTurn[];
  readonly nextCursor: string | null;
}

export function createWorkbenchConversationSnapshotService(options: {
  readonly selectedSessionId: Ref<string | undefined>;
  readonly replaceCurrent: (page: ConversationTurnPage) => boolean;
  readonly mergeCurrent: (page: ConversationTurnPage) => boolean;
  readonly currentWindow: () => ConversationWindow;
  readonly replaceCached: (sessionId: string, page: ConversationWindow) => void;
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
