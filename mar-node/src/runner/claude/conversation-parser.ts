import {
  boundedConversationItemId,
  isPlainRecord,
  claudeContentBlocks,
  compactRunnerText
} from '../../util/node-operation-parsers.js';

export function extractClaudeThinkingText(record: Record<string, unknown>): readonly string[] {
  return claudeContentBlocks(record).flatMap((block) => {
    // Completed public blocks only; signatures and redacted/encrypted data are never read.
    if (block.type !== 'thinking' || typeof block.thinking !== 'string') return [];
    const text = compactRunnerText(block.thinking.trim(), 10_000);
    return text.length === 0 ? [] : [text];
  });
}

/** Preserve native block order and identity across SDK callbacks and transcript reads. */
export function claudeAssistantBlocks(record: Record<string, unknown>): readonly {
  readonly record: Record<string, unknown>;
  readonly blockIndex: number;
  readonly sourceItemId?: string;
}[] {
  const message = isPlainRecord(record.message) ? record.message : undefined;
  if (message === undefined) return [];
  const content =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : Array.isArray(message.content)
        ? message.content
        : [];
  const messageId =
    typeof record.uuid === 'string'
      ? record.uuid
      : typeof message.id === 'string'
        ? message.id
        : undefined;
  return content.flatMap((block, blockIndex) => {
    if (!isPlainRecord(block)) return [];
    const sourceItemId =
      block.type === 'tool_use' && typeof block.id === 'string'
        ? boundedConversationItemId('claude-tool', block.id)
        : messageId === undefined
          ? undefined
          : JSON.stringify(['claude', messageId, blockIndex]);
    return [
      {
        record: { ...record, message: { ...message, content: [block] } },
        blockIndex,
        ...(sourceItemId === undefined ? {} : { sourceItemId })
      }
    ];
  });
}
