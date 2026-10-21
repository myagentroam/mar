import { MarAgentError } from '../error.js';
import type { ModelTextBlock } from './contracts.js';

/** Preserve explicit blocks only while their complete texts still match the actual prefix. */
export function resolveModelTextBlocks(
  text: string,
  blocks: readonly ModelTextBlock[]
): readonly ModelTextBlock[] {
  if (typeof text !== 'string' || !Array.isArray(blocks)) throw invalid();
  const copied = blocks.map((block) => {
    if (
      !block ||
      typeof block !== 'object' ||
      typeof block.text !== 'string' ||
      (block.cache !== undefined && block.cache !== true)
    )
      throw invalid();
    return { text: block.text, ...(block.cache === true ? { cache: true as const } : {}) };
  });
  let offset = 0;
  const result: ModelTextBlock[] = [];
  for (const block of copied) {
    if (!text.startsWith(block.text, offset)) break;
    result.push(block);
    offset += block.text.length;
  }
  if (offset < text.length) result.push({ text: text.slice(offset) });
  return result;
}

export function modelTextInput(value: string | readonly ModelTextBlock[]): {
  text: string;
  blocks?: readonly ModelTextBlock[];
} {
  if (typeof value === 'string') return { text: value };
  if (!Array.isArray(value)) throw invalid();
  for (const block of value) {
    if (!block || typeof block !== 'object' || typeof block.text !== 'string') throw invalid();
  }
  const text = value.map((block) => block.text).join('');
  return { text, blocks: resolveModelTextBlocks(text, value) };
}

function invalid(): MarAgentError {
  return new MarAgentError('MAR_AGENT_MODEL_TEXT_BLOCK_INVALID', 'Model text blocks are invalid.');
}
