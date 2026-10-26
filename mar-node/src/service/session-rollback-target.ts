import type { NodeConversationItem } from '../runtime-model.js';

/** A missing message selector is unambiguous only when the Turn has one user input. */
export function resolveSessionRollbackTarget(
  turn: {
    readonly items: readonly Pick<NodeConversationItem, 'id' | 'kind' | 'status' | 'payload'>[];
  },
  itemId: string | undefined
): { readonly clientMessageId?: string } | undefined {
  const inputs = turn.items.filter((item) => item.kind === 'user_message');
  const selected =
    itemId === undefined
      ? inputs.length === 1
        ? inputs[0]
        : undefined
      : inputs.find((item) => item.id === itemId);
  if (selected?.status !== 'COMPLETED') return undefined;
  if (selected === inputs[0]) return {};
  const payload = selected.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const clientMessageId = (payload as Record<string, unknown>)['clientMessageId'];
  return typeof clientMessageId === 'string' &&
    clientMessageId.trim() &&
    clientMessageId.length <= 512
    ? { clientMessageId }
    : undefined;
}
