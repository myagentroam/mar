import { anthropicThinkingBlock } from './anthropic-thinking.js';
import type { ModelMessage } from './contracts.js';

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
