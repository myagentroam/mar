import type { NativeTranscriptToolCall } from '../../native-transcript-model.js';
import {
  compactRunnerText,
  compactRunnerValue,
  isPlainRecord
} from '../../util/node-operation-parsers.js';
export function extractClaudeText(message: Record<string, unknown>): string {
  return claudeContentBlocks(message)
    .flatMap((block) =>
      block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
    )
    .join('');
}

export function extractClaudeToolUses(message: Record<string, unknown>): readonly {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly command?: string;
  readonly inputTruncated: boolean;
}[] {
  return claudeContentBlocks(message).flatMap((block) => {
    if (block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string')
      return [];
    const input = block.input;
    const command =
      isPlainRecord(input) && typeof input.command === 'string' ? input.command : undefined;
    return [
      {
        id: block.id,
        name: block.name,
        input,
        ...(command === undefined ? {} : { command }),
        inputTruncated: compactRunnerValue(input, 10_000).truncated
      }
    ];
  });
}

export function claudeContentBlocks(
  message: Record<string, unknown>
): readonly Record<string, unknown>[] {
  const content = message.message;
  if (!isPlainRecord(content) || !Array.isArray(content.content)) return [];
  return content.content.filter(isPlainRecord);
}

export function isClaudeCommandTool(name: string): boolean {
  return name === 'Bash' || name === 'bash' || name === 'Shell';
}

export function nativeClaudeCommand(entry: NativeTranscriptToolCall): string {
  if (isPlainRecord(entry.input) && typeof entry.input.command === 'string')
    return compactRunnerText(entry.input.command, 10_000);
  return entry.inputSummary ?? entry.toolName;
}
