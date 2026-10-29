import { homedir } from 'node:os';
import { join } from 'node:path';
import { forEachJsonlRecord, type JsonlBackwardWindow } from '../../native-jsonl-reader.js';
import type {
  NativeTranscriptAdapter,
  ParsedNativeTranscript,
  NativeTranscriptItem,
  NativeTranscriptMessage,
  NativeTranscriptToolCall,
  NativeTranscriptImageAttachment,
  NativeTranscriptUnknown,
  NativeTranscriptReasoningSummary
} from '../../native-transcript-model.js';
import { compactRunnerValue as compactValue } from '../normalization.js';
import { isPlainRecord } from '../../util/records.js';
import { stripGoalStartPrompt, publicGoalHistoryText } from '../../service/goal-runtime.js';
import { readdir } from 'node:fs/promises';
import { stripClaudePlanTag } from '../../runner-command-engine.js';
import {
  claudeAssistantBlocks,
  extractClaudeThinkingText,
  claudePlanText,
  claudeUserInputQuestions
} from './conversation-parser.js';
import {
  extractClaudeToolResults,
  claudeNativeToolResultMetadata,
  normalizeClaudeTool,
  restoreClaudeSubagentTitles,
  type ClaudeToolResultMetadata
} from './tool-normalizer.js';
function parse(_path: string, window: JsonlBackwardWindow): ParsedNativeTranscript | undefined {
  const { content, truncated } = window;
  let cwd: string | undefined;
  let id: string | undefined;
  let derivedSession = false;
  const items: NativeTranscriptItem[] = [];
  const toolIndexes = new Map<string, number>();
  const metaRecordIds = new Set<string>();
  const claudeCompactCommandIds = new Set<string>();
  forEachJsonlRecord(content, (value) => {
    if (derivedTranscriptRecord(value)) derivedSession = true;
    cwd ??= workspacePath(value);
    id ??= sessionId(value);
    if (typeof value['uuid'] === 'string' && isClaudeCompactCommand(value))
      claudeCompactCommandIds.add(value['uuid']);
  });
  forEachJsonlRecord(truncated ? window.pageContent : content, (value) => {
    const recordId = typeof value['uuid'] === 'string' ? value['uuid'] : undefined;
    const parentId = typeof value['parentUuid'] === 'string' ? value['parentUuid'] : undefined;
    if (value['isMeta'] === true && recordId !== undefined) metaRecordIds.add(recordId);
    if (
      parentId !== undefined &&
      claudeCompactCommandIds.has(parentId) &&
      isClaudeCompactSuccess(value)
    ) {
      items.push({
        kind: 'context_compaction',
        phase: 'COMPLETED',
        summary: null,
        createdAt: timestampOf(value),
        nativeId: parentId,
        rewindAfter: parentId
      });
      return;
    }
    if (
      isHiddenTranscriptRecord(value) ||
      (parentId !== undefined && metaRecordIds.has(parentId))
    ) {
      return;
    }
    for (const parsedItem of transcriptItems(value)) {
      const item = {
        ...parsedItem,
        ...(recordId === undefined ? {} : { nativeId: recordId, rewindAfter: recordId })
      };
      if (item.kind === 'tool_result') {
        const toolIndex = toolIndexes.get(item.toolUseId);
        if (toolIndex !== undefined)
          items[toolIndex] = withToolResult(items[toolIndex] as NativeTranscriptToolCall, item);
        continue;
      }
      if (item.kind === 'tool_call') {
        toolIndexes.set(item.toolUseId, items.length);
        items.push(item);
        continue;
      }
      items.push(item);
    }
  });
  if (derivedSession) return undefined;
  if (cwd === undefined) return undefined;
  const title = items.find(
    (item): item is NativeTranscriptMessage => item.kind === 'message' && item.role === 'USER'
  )?.text;
  // Tagged Plan Mode instruction labels do not form a session title.
  const strippedTitle =
    title === undefined ? undefined : stripClaudePlanTag(stripGoalStartPrompt(title));
  return {
    ...(id === undefined ? {} : { externalSessionId: id }),
    cwd,
    ...(strippedTitle === undefined || strippedTitle.length === 0
      ? {}
      : { title: compact(strippedTitle) }),
    items
  };
}
type NativeToolResult = {
  readonly kind: 'tool_result';
  readonly toolUseId: string;
  readonly output: string;
  readonly failed: boolean;
  readonly truncated: boolean;
  readonly claudeResult?: ClaudeToolResultMetadata;
  readonly imageAttachments?: readonly NativeTranscriptImageAttachment[];
  readonly createdAt: number | null;
  readonly nativeId?: string;
};

function derivedTranscriptRecord(value: Record<string, unknown>): boolean {
  return value['isSidechain'] === true;
}
function transcriptItems(
  record: Record<string, unknown>
): readonly (NativeTranscriptItem | NativeToolResult)[] {
  if (record.type === 'assistant') {
    return claudeAssistantBlocks(record).flatMap(
      ({ record: blockRecord, blockIndex, sourceItemId }) => {
        const block = contentBlocks(blockRecord)[0];
        if (block?.type === 'thinking') {
          const text = extractClaudeThinkingText(blockRecord)[0] ?? '';
          return text.length === 0
            ? []
            : [
                {
                  kind: 'reasoning_summary' as const,
                  representation: 'visible_thinking' as const,
                  sections: [{ index: blockIndex, text }],
                  createdAt: timestampOf(record),
                  ...(sourceItemId === undefined ? {} : { sourceItemId })
                }
              ];
        }
        return transcriptRecordItems(blockRecord).map((item) => ({
          ...item,
          ...(sourceItemId === undefined ? {} : { sourceItemId })
        }));
      }
    );
  }
  return transcriptRecordItems(record);
}
function transcriptRecordItems(
  record: Record<string, unknown>
): readonly (NativeTranscriptItem | NativeToolResult)[] {
  const createdAt = timestampOf(record);
  const results = toolResultsOf(record, createdAt);
  if (results.length > 0) return results;
  const values: NativeTranscriptItem[] = [
    ...toolUsesOf(record, createdAt),
    ...unsupportedTranscriptItems(record, createdAt)
  ];
  const role = roleOf(record);
  if (role === undefined) return values;
  const rawText = messageText(textOf(record) ?? '');
  if (rawText.length === 0) return values;
  values.unshift({ kind: 'message', role, text: rawText, createdAt });
  return values;
}
function toolUsesOf(
  record: Record<string, unknown>,
  createdAt: number | null
): readonly NativeTranscriptToolCall[] {
  return contentBlocks(record).flatMap((block) => {
    if (
      block['type'] !== 'tool_use' ||
      typeof block['id'] !== 'string' ||
      typeof block['name'] !== 'string'
    )
      return [];
    const input = block['input'];
    const summary = compactValue(input, 10_000);
    return [
      {
        kind: 'tool_call' as const,
        toolUseId: block['id'],
        toolName: compact(block['name']).slice(0, 128),
        input,
        inputSummary: summary.text || null,
        inputTruncated: summary.truncated,
        outputSummary: null,
        outputTruncated: false,
        failed: false,
        createdAt
      }
    ];
  });
}

function toolResultsOf(
  record: Record<string, unknown>,
  createdAt: number | null
): readonly NativeToolResult[] {
  return extractClaudeToolResults(record).map((result) => ({
    ...result,
    kind: 'tool_result' as const,
    createdAt
  }));
}

function isClaudeCompactCommand(record: Record<string, unknown>): boolean {
  return textOf(record)?.trim() === '<command-name>/compact</command-name>';
}

function isClaudeCompactSuccess(record: Record<string, unknown>): boolean {
  return textOf(record)?.trim() === '<local-command-stdout>Compacted</local-command-stdout>';
}
function withToolResult(
  call: NativeTranscriptToolCall,
  result: NativeToolResult
): NativeTranscriptToolCall {
  return {
    ...call,
    outputSummary: result.output,
    outputTruncated: result.truncated,
    failed: result.failed,
    ...(result.claudeResult === undefined
      ? {}
      : {
          subagentResult: {
            ...(result.claudeResult.agentId === undefined
              ? {}
              : { agentId: result.claudeResult.agentId }),
            ...(result.claudeResult.task_id === undefined
              ? {}
              : { taskId: result.claudeResult.task_id }),
            ...(result.claudeResult.task_type === undefined
              ? {}
              : { taskType: result.claudeResult.task_type })
          }
        })
  };
}
function workspacePath(record: Record<string, unknown>): string | undefined {
  return (
    firstString(record, ['cwd', 'working_directory', 'workspacePath']) ??
    nestedString(record, ['payload', 'cwd']) ??
    nestedString(record, ['message', 'cwd'])
  );
}

function sessionId(record: Record<string, unknown>): string | undefined {
  return (
    firstString(record, ['sessionId', 'session_id', 'thread_id', 'conversationId']) ??
    nestedString(record, ['payload', 'id']) ??
    nestedString(record, ['payload', 'session_id']) ??
    nestedString(record, ['payload', 'thread_id'])
  );
}

function timestampOf(record: Record<string, unknown>): number | null {
  const raw = record['timestamp'] ?? record['created_at'] ?? record['createdAt'];
  if (typeof raw === 'number' && Number.isFinite(raw))
    return raw < 10_000_000_000 ? raw * 1_000 : raw;
  if (typeof raw === 'string') {
    const value = Date.parse(raw);
    return Number.isNaN(value) ? null : value;
  }
  return null;
}

function firstString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys)
    if (typeof value[key] === 'string' && (value[key] as string).length > 0)
      return value[key] as string;
  return undefined;
}

function nestedString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === 'string' && current.length > 0 ? current : undefined;
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 16_000);
}

function messageText(value: string): string {
  return value.trim().slice(0, 16_000);
}

function roleOf(record: Record<string, unknown>): NativeTranscriptMessage['role'] | undefined {
  const candidates = [
    firstString(record, ['role']),
    nestedString(record, ['message', 'role']),
    nestedString(record, ['payload', 'role']),
    firstString(record, ['type']),
    nestedString(record, ['payload', 'type'])
  ];
  if (candidates.some((value) => value === 'user' || value === 'human' || value === 'input'))
    return 'USER';
  if (candidates.some((value) => value === 'assistant' || value === 'agent' || value === 'output'))
    return 'ASSISTANT';
  return undefined;
}

function textOf(record: Record<string, unknown>): string | undefined {
  return (
    firstString(record, ['content', 'text']) ??
    nestedText(record['message']) ??
    nestedText(record['payload'])
  );
}

function nestedText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  const direct = firstString(value, ['content', 'text', 'message']);
  if (direct !== undefined) return direct;
  if (Array.isArray(value['content'])) {
    const parts = value['content'].flatMap((part) => {
      if (typeof part === 'string') return [part];
      if (!isRecord(part)) return [];
      return [firstString(part, ['text', 'content'])].filter(
        (text): text is string => text !== undefined
      );
    });
    return parts.join('\n');
  }
  return undefined;
}

function contentBlocks(record: Record<string, unknown>): readonly Record<string, unknown>[] {
  const values = [record['message'], record['payload']];
  for (const value of values)
    if (isRecord(value) && Array.isArray(value['content']))
      return value['content'].filter(isRecord);
  return [];
}

function isHiddenTranscriptRecord(record: Record<string, unknown>): boolean {
  if (contentBlocks(record).some((block) => block['type'] === 'tool_result')) return false;
  if (
    record['interruptedByShutdown'] === true ||
    record['isMeta'] === true ||
    record['isVisibleInTranscriptOnly'] === true ||
    record['isCompactSummary'] === true
  )
    return true;
  const text = textOf(record)?.trim() ?? '';
  return (
    text.startsWith('<local-command-') ||
    text.startsWith('<command-name>') ||
    text.startsWith('<command-message>')
  );
}

function unsupportedTranscriptItems(
  record: Record<string, unknown>,
  createdAt: number | null
): readonly NativeTranscriptUnknown[] {
  return contentBlocks(record).flatMap((block) => {
    const type = typeof block.type === 'string' ? block.type : undefined;
    if (
      type === undefined ||
      type === 'text' ||
      type === 'input_text' ||
      type === 'output_text' ||
      type === 'image' ||
      type === 'input_image' ||
      type === 'thinking' ||
      type === 'redacted_thinking' ||
      type === 'encrypted_thinking' ||
      type === 'tool_use' ||
      type === 'tool_result'
    )
      return [];
    return [
      {
        kind: 'unknown' as const,
        sourceEventType: `transcript:${type}`,
        label: `Agent ${compact(type).slice(0, 128)}`,
        createdAt
      }
    ];
  });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export const claudeNativeTranscriptAdapter: NativeTranscriptAdapter = {
  runner: 'claude-code',
  transcriptRoot: () => join(homedir(), '.claude', 'projects'),
  includesPath: (path) => !path.split(/[\\/]/u).includes('subagents'),
  async locateCandidates(externalSessionId) {
    try {
      const root = this.transcriptRoot();
      return (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name, `${externalSessionId}.jsonl`));
    } catch {
      return [];
    }
  },
  parse,
  createProjection(precedingItems) {
    const titles = restoreClaudeSubagentTitles(
      precedingItems.filter((entry) => entry.kind === 'tool_call')
    );
    return {
      userText: (text) => publicGoalHistoryText(stripClaudePlanTag(text)),
      planText: claudePlanText,
      normalizeTool: (entry) =>
        normalizeClaudeTool(
          entry.toolName,
          entry.input,
          entry.outputSummary,
          entry.failed,
          entry.inputTruncated || entry.outputTruncated,
          titles,
          claudeNativeToolResultMetadata(entry.subagentResult),
          entry.outputTruncated
        ),
      userInputQuestions: (entry) =>
        entry.toolName === 'AskUserQuestion' && isPlainRecord(entry.input)
          ? claudeUserInputQuestions(entry.input)
          : []
    };
  }
};
