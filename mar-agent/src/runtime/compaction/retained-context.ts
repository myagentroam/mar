import type { SessionModelMessage as ModelMessage } from '../../session/model-request.js';

import { parseModelInputMetadata } from '../../session/record-projection.js';
import { providerToolCallId, restoreModelContext } from '../context/projection.js';
import type { CompactSnapshotAnchor } from '../events.js';
import { parseModelImages } from '../../model/image.js';
import { completedNativeThinkingIdentity } from '../../model/native-context.js';

/** Keep the live suffix intact, extending into the snapshot only to fill three native blocks. */
export function compactRetainedStart(
  messages: readonly ModelMessage[],
  snapshotLength: number,
  model: { readonly id: string; readonly protocol: ModelMessage['provider'] }
): number {
  let start = snapshotLength;
  const thinking = new Set<string>();
  for (let index = messages.length - 1; index >= 0 && thinking.size < 3; index--) {
    const message = messages[index]!;
    if (
      message.provider !== model.protocol ||
      (message.providerModelId !== undefined && message.providerModelId !== model.id)
    )
      continue;
    const identity = completedNativeThinkingIdentity(message, `message:${index}`);
    if (identity === undefined || thinking.has(identity)) continue;
    thinking.add(identity);
    start = Math.min(start, index);
  }
  // The existing snapshot boundary already closes tool groups.
  if (start === snapshotLength) return start;
  // A native item can follow text or tool calls within the same assistant response.
  while (start > 0 && messages[start - 1]!.role !== 'user' && messages[start - 1]!.role !== 'tool')
    start--;

  // Resolve any retained result back to its call's assistant group in two linear passes.
  const calls = new Map<string, number>();
  let responseStart = 0;
  for (let index = 0; index < start; index++) {
    const message = messages[index]!;
    if (message.role === 'user' || message.role === 'tool') responseStart = index + 1;
    const callId = message.role === 'tool_call' ? message.callId : providerToolCallId(message);
    if (callId !== undefined && !calls.has(callId)) calls.set(callId, responseStart);
  }
  for (let index = messages.length - 1; index >= start; index--) {
    const message = messages[index]!;
    if (message.role !== 'tool' || message.callId === undefined) continue;
    const callStart = calls.get(message.callId);
    if (callStart !== undefined) start = Math.min(start, callStart);
  }
  return start;
}

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
