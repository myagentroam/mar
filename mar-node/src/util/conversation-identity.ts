import type { NodeConversationTurn } from '../runtime-model.js';
import { isPlainRecord } from './node-operation-parsers.js';

export function conversationClientMessageId(turn: NodeConversationTurn): string | null {
  for (const item of turn.items) {
    if (item.kind !== 'user_message' || !isPlainRecord(item.payload)) continue;
    const value = item.payload.clientMessageId;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}
