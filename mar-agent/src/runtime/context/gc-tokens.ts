import type { ClientToolDefinition } from '../../tools/contracts.js';
import type { SessionModelMessage as ModelMessage } from '../../session/model-request.js';

import { openAiInput } from '../../model/openai-responses.js';
import { anthropicMessages } from '../../model/anthropic-messages.js';
import { projectCodeModeSearchResult } from '../../session/code-mode-search-projection.js';
import { countModelTokens } from '../token-budget.js';
import {
  observationModelParts,
  observationModelText
} from '../../session/code-observation-projection.js';

export { MODEL_TOKEN_ESTIMATOR as CONTEXT_GC_TOKEN_ESTIMATOR } from '../token-budget.js';

interface TokenContext {
  readonly modelId: string;
  readonly modelProtocol?: string;
  readonly responsesConfigurationUpdates?: boolean;
  readonly system: string;
  readonly tools: readonly ClientToolDefinition[];
  readonly messages?: readonly ModelMessage[];
  readonly tokenCache?: Map<string, number>;
}

/** Uses Responses lowering, including native alias and cross-model filtering. */
export function contextGcTokenEntries(input: TokenContext, messages: readonly ModelMessage[]) {
  return serializedEntries(input, messages).map((entry) => ({
    ...entry,
    tokens: tokensFor(input, entry.text)
  }));
}

function serializedEntries(input: TokenContext, messages: readonly ModelMessage[]) {
  // Media bytes have a separate budget. Keep identity for cache boundaries without
  // loading resources or counting base64 payloads as text tokens.
  messages = messages.map((message) =>
    message.images?.length
      ? {
          ...message,
          images: message.images.map((image) => ({
            mimeType: image.mimeType,
            url: image.resourceId
              ? `https://mar.invalid/resource/${image.resourceId}`
              : (image.url ?? 'https://mar.invalid/inline-image')
          }))
        }
      : message
  );
  const codeMode = input.tools.some((tool) => tool.name === 'code_exec');
  messages = messages.map((message) => projectCodeModeSearchResult(message, codeMode));
  const responses =
    input.modelProtocol === 'OPENAI_RESPONSES' ||
    (input.modelProtocol === undefined &&
      (input.messages ?? messages).some((message) => message.provider === 'OPENAI_RESPONSES'));
  const values: readonly unknown[] = responses
    ? openAiInput(
        messages.map((message) => {
          const contentParts = message.role === 'tool' ? observationModelParts(message) : undefined;
          return contentParts === undefined ? message : { ...message, contentParts };
        }),
        undefined,
        input.modelId,
        true,
        input.responsesConfigurationUpdates !== false
      )
    : input.modelProtocol === 'ANTHROPIC_MESSAGES'
      ? anthropicMessages(
          messages.map((message) => {
            const contentParts =
              message.role === 'tool' ? observationModelParts(message) : undefined;
            return contentParts === undefined ? message : { ...message, contentParts };
          }),
          undefined,
          input.tools,
          input.modelId,
          false
        )
      : messages
          .filter(
            (message) =>
              message.role !== 'provider' ||
              (message.provider === 'ANTHROPIC_MESSAGES' &&
                message.providerModelId === input.modelId)
          )
          .map((original) => {
            const {
              observations: _observations,
              observationId: _observationId,
              toolSearchTools: _toolSearchTools,
              ...message
            } = original;
            const content = original.role === 'tool' ? observationModelText(original) : undefined;
            return content === undefined ? message : { ...message, content };
          });
  return values.map((value, index) => {
    const item = value as Record<string, unknown>;
    const callId = item.call_id ?? item.callId;
    const output =
      item.role === 'tool' ||
      item.type === 'function_call_output' ||
      item.type === 'custom_tool_call_output';
    const key =
      typeof callId === 'string'
        ? `${output ? 'output' : 'input'}:${callId}`
        : typeof item.id === 'string'
          ? `id:${item.id}`
          : `index:${index}`;
    const text = stableJson(value);
    return { key, text };
  });
}

/** Cancel identical entries, including multiplicity, before estimating the difference. */
export function contextGcReclaimedTokens(
  input: TokenContext,
  before: readonly ModelMessage[],
  after: readonly ModelMessage[]
): number {
  const counts = new Map<string, number>();
  for (const entry of serializedEntries(input, before))
    counts.set(entry.text, (counts.get(entry.text) ?? 0) + 1);
  for (const entry of serializedEntries(input, after))
    counts.set(entry.text, (counts.get(entry.text) ?? 0) - 1);
  let reclaimed = 0;
  for (const [text, count] of counts) if (count !== 0) reclaimed += count * tokensFor(input, text);
  return Math.max(0, reclaimed);
}

export function contextGcPrefixTokens(input: TokenContext): number {
  return tokensFor(input, stableJson({ system: input.system, tools: input.tools }));
}

export function contextGcMessageTokens(
  input: TokenContext,
  messages: readonly ModelMessage[]
): number {
  return contextGcTokenEntries(input, messages).reduce((sum, entry) => sum + entry.tokens, 0);
}

function tokensFor(input: TokenContext, text: string): number {
  const cached = input.tokenCache?.get(text);
  if (cached !== undefined) return cached;
  const tokens = countModelTokens(text);
  input.tokenCache?.set(text, tokens);
  return tokens;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item
  );
}
