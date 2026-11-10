import type { Ref } from 'vue';
import type { ConversationTurn, ConversationTurnPage } from '../model/workbench.js';

interface ConversationWindow {
  readonly turns: readonly ConversationTurn[];
  readonly nextCursor: string | null;
}

export function createWorkbenchConversationSnapshotService(options: {
  readonly selectedSessionId: Readonly<Ref<string | undefined>>;
  readonly replaceCurrent: (page: ConversationTurnPage) => boolean;
  readonly mergeCurrent: (page: ConversationTurnPage) => boolean;
  readonly resetCurrent?: (mode: 'initial' | 'reset') => void;
  readonly currentWindow: () => ConversationWindow;
  readonly replaceCached: (sessionId: string, page: ConversationWindow) => void;
}) {
  function apply(
    sessionId: string,
    page: ConversationTurnPage,
    mode: 'initial' | 'refresh' | 'reset' = 'initial'
  ): boolean {
    if (sessionId !== options.selectedSessionId.value) {
      options.replaceCached(sessionId, page);
      return false;
    }
    if (mode !== 'refresh') options.resetCurrent?.(mode);
    const changed = mode === 'refresh' ? options.mergeCurrent(page) : options.replaceCurrent(page);
    options.replaceCached(sessionId, { ...page, ...options.currentWindow() });
    return changed;
  }

  return { apply };
}
