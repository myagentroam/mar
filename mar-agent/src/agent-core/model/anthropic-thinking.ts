import { MarAgentError } from '../error.js';

export const ANTHROPIC_THINKING_LIMITS = {
  blockBytes: 512 * 1024,
  contextBytes: 8 * 1024 * 1024
} as const;

/** Whitelist opaque protocol state without interpreting or rewriting signed fields. */
export function anthropicThinkingBlock(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const block = value as Record<string, unknown>;
  const keys = Object.keys(block);
  let result: Record<string, unknown>;
  if (
    block.type === 'thinking' &&
    typeof block.thinking === 'string' &&
    typeof block.signature === 'string' &&
    block.signature.length > 0 &&
    keys.every((key) => ['type', 'thinking', 'signature'].includes(key))
  )
    result = { type: 'thinking', thinking: block.thinking, signature: block.signature };
  else if (
    block.type === 'redacted_thinking' &&
    typeof block.data === 'string' &&
    block.data.length > 0 &&
    keys.every((key) => ['type', 'data'].includes(key))
  )
    result = { type: 'redacted_thinking', data: block.data };
  else return undefined;
  return Buffer.byteLength(JSON.stringify(result)) <= ANTHROPIC_THINKING_LIMITS.blockBytes
    ? result
    : undefined;
}

export function assertAnthropicThinkingBudget(bytes: number): void {
  if (bytes > ANTHROPIC_THINKING_LIMITS.contextBytes)
    throw new MarAgentError(
      'MAR_AGENT_CONTEXT_LIMIT',
      'Anthropic native thinking context exceeds its bounded context limit.'
    );
}
