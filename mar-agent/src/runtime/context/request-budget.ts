import type { ClientToolDefinition } from '../../tools/contracts.js';
import type { SessionModelMessage as ModelMessage } from '../../session/model-request.js';

import { AGENT_EXECUTION_POLICY } from '../execution-policy.js';
import { countModelTokens } from '../token-budget.js';
import { observationModelText } from '../../session/code-observation-projection.js';
import type { ModelImage } from '../../model/image.js';
export function estimatedRequestTokens(
  system: string,
  messages: readonly ModelMessage[],
  tools: readonly ClientToolDefinition[],
  images?: readonly ModelImage[]
) {
  const transientImageCount = messages.reduce(
    (total, message) => total + (message.images?.length ?? 0),
    images?.length ?? 0
  );
  const textMessages = messages.map((message) => {
    const {
      images: _images,
      observations: _observations,
      observationId: _observationId,
      metadata: _metadata,
      contextKind: _contextKind,
      contextualBlock: _contextualBlock,
      ...textMessage
    } = message;
    const content = message.role === 'tool' ? observationModelText(message) : undefined;
    if (content !== undefined) textMessage.content = content;
    return textMessage;
  });
  return (
    countModelTokens(`${system}${stableJson(textMessages)}${stableJson(tools)}`) +
    transientImageCount * AGENT_EXECUTION_POLICY.estimatedTokensPerImage
  );
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
