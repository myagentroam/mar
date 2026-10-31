import { anthropicThinkingBlock } from './anthropic-thinking.js';
import type { ModelMessage } from './contracts.js';

/** Adapters persist native items at completion; GC needs only their type and identity. */
export function completedNativeThinkingIdentity(
  payload: Record<string, unknown>,
  recordId: string
): string | undefined {
  if (payload.role !== 'provider') return undefined;
  const item = payload.item;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  const block = item as Record<string, unknown>;
  if (payload.provider === 'ANTHROPIC_MESSAGES') {
    return block.type === 'thinking' || block.type === 'redacted_thinking' ? recordId : undefined;
  }
  if (payload.provider !== 'OPENAI_RESPONSES' || block.type !== 'reasoning') return undefined;
  return typeof block.id === 'string' ? block.id : recordId;
}

/** Interpret only the existing native context record shapes and their model ownership. */
export function restoreNativeModelContext(
  payload: Record<string, unknown>,
  activeModelId?: string
): ModelMessage | undefined {
  const modelId =
    typeof payload.providerModelId === 'string' && payload.providerModelId.length > 0
      ? payload.providerModelId
      : undefined;
  const contextKind = nativeContextKind(payload.contextKind);
  if (payload.provider === 'ANTHROPIC_MESSAGES') {
    const item = anthropicThinkingBlock(payload.item);
    return item && modelId
      ? {
          role: 'provider',
          content: '',
          provider: 'ANTHROPIC_MESSAGES',
          providerModelId: modelId,
          contextKind: contextKind ?? 'private',
          item
        }
      : undefined;
  }
  if (
    payload.provider !== 'OPENAI_RESPONSES' ||
    !payload.item ||
    typeof payload.item !== 'object' ||
    Array.isArray(payload.item)
  )
    return undefined;
  const restoredModelId = modelId ?? activeModelId;
  return {
    role: 'provider',
    content: '',
    provider: 'OPENAI_RESPONSES',
    ...(restoredModelId === undefined ? {} : { providerModelId: restoredModelId }),
    ...(contextKind === undefined ? {} : { contextKind }),
    item: payload.item as Record<string, unknown>
  };
}

function nativeContextKind(value: unknown): ModelMessage['contextKind'] {
  return value === 'environment' ||
    value === 'private' ||
    value === 'contextual' ||
    value === 'summary' ||
    value === 'compact_control'
    ? value
    : undefined;
}
