import { createConversationProjectionService } from '../../../src/service/conversation-projection-service.js';
import { createConversationScrollService } from '../../../src/service/conversation-scroll-service.js';
import { limitConversationHistory } from '../../../src/util/conversation-history.js';

export function conversationProjectionFixture(turns: unknown, nextCursor: unknown) {
  return createConversationProjectionService({
    turns: turns as never,
    nextCursor: nextCursor as never,
    onRecentWindowOverflow: () => undefined,
    limitHistory: limitConversationHistory
  });
}

export function pagingAnchor(element?: HTMLElement): () => () => void {
  const scroll = createConversationScrollService();
  scroll.setElement(element);
  return scroll.capturePrependAnchor;
}
