import type { SessionModelMessage as ModelMessage } from '../../session/model-request.js';

import { parseModelInputMetadata } from '../../session/record-projection.js';
import { restoreModelContext } from '../context/projection.js';
import type { CompactSnapshotAnchor } from '../events.js';
import { parseModelImages } from '../../model/image.js';

/** Use a public native identity, never private context text, as the visible boundary. */
export function compactSnapshotAnchor(
  messages: readonly ModelMessage[],
  sources: WeakMap<ModelMessage, import('../../session/record-contract.js').SessionRecord>
): CompactSnapshotAnchor | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'tool' && message.callId) return { kind: 'tool', id: message.callId };
    const record = sources.get(message);
    const payload = record?.payload as Record<string, unknown> | undefined;
    if (record?.type === 'message.completed' && typeof payload?.itemId === 'string')
      return { kind: 'message', id: payload.itemId };
  }
  return undefined;
}

/** Decode the SDK-owned checkpoint suffix without promoting contextual text to real input. */
export function restoreCompactTail(value: unknown): ModelMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (
    (input.contextKind === 'private' && input.role !== 'provider') ||
    input.contextKind === 'compact_control'
  )
    return undefined;
  if ((input.role === 'assistant' || input.role === 'user') && typeof input.content === 'string') {
    if (input.inputRef !== undefined) return restoreModelContext(input);
    const projected = restoreModelContext(input);
    const metadata = parseModelInputMetadata(input.metadata);
    const images = parseModelImages(input.images);
    const contextKind = ['environment', 'contextual', 'summary'].includes(String(input.contextKind))
      ? (input.contextKind as ModelMessage['contextKind'])
      : undefined;
    return {
      role: input.role,
      content: input.content,
      ...(contextKind
        ? { contextKind }
        : input.role === 'user' && !metadata
          ? { contextKind: 'contextual' as const }
          : {}),
      ...(metadata ? { metadata } : {}),
      ...(projected?.textBlocks ? { textBlocks: projected.textBlocks } : {}),
      ...(images?.length ? { images } : {})
    };
  }
  return restoreModelContext(input);
}
