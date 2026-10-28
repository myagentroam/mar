import { homedir } from 'node:os';
import { basename, join } from 'node:path';
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
import { stripGoalStartPrompt, publicGoalHistoryText } from '../../service/goal-runtime.js';
import { parseCodexComposerImageMarkers } from './composer-image-markers.js';
import { codexTranscriptSourceItemId } from './conversation-parser.js';
import { normalizeCodexTool } from './tool-normalizer.js';
function parse(_path: string, window: JsonlBackwardWindow): ParsedNativeTranscript | undefined {
  const { content, truncated } = window;
  let cwd: string | undefined;
  let id: string | undefined;
  let derivedSession = false;
  const items: NativeTranscriptItem[] = [];
  const toolIndexes = new Map<string, number>();
  const metaRecordIds = new Set<string>();
  let codexTurnId: string | undefined;
  forEachJsonlRecord(content, (value) => {
    if (derivedTranscriptRecord(value)) derivedSession = true;
    cwd ??= workspacePath(value);
    id ??= sessionId(value);
  });
  forEachJsonlRecord(truncated ? window.pageContent : content, (value) => {
    if (value['type'] === 'event_msg' && isRecord(value['payload'])) {
      const payload = value['payload'];
      if (payload['type'] === 'task_started')
        codexTurnId = typeof payload['turn_id'] === 'string' ? payload['turn_id'] : undefined;
      else if (payload['type'] === 'task_complete') codexTurnId = undefined;
    }
    const recordId = typeof value['uuid'] === 'string' ? value['uuid'] : undefined;
    const parentId = typeof value['parentUuid'] === 'string' ? value['parentUuid'] : undefined;
    if (value['isMeta'] === true && recordId !== undefined) metaRecordIds.add(recordId);
    if (
      isHiddenTranscriptRecord(value) ||
      (parentId !== undefined && metaRecordIds.has(parentId))
    ) {
      return;
    }
    const generatedImage = codexGeneratedImageEvent(value);
    if (generatedImage !== undefined) items.push(generatedImage);
    const sourceItemId = codexTranscriptSourceItemId(value, codexTurnId);
    for (const parsedItem of transcriptItems(value)) {
      const item = {
        ...parsedItem,
        ...(sourceItemId === undefined ? {} : { sourceItemId }),
        ...(recordId === undefined ? {} : { nativeId: recordId }),
        ...(parsedItem.kind === 'message' && parsedItem.role === 'USER' && codexTurnId !== undefined
          ? { nativeTurnId: codexTurnId }
          : {})
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
  const strippedTitle = title === undefined ? undefined : stripGoalStartPrompt(title);
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
  readonly imageAttachments?: readonly NativeTranscriptImageAttachment[];
  readonly createdAt: number | null;
  readonly nativeId?: string;
};

function derivedTranscriptRecord(value: Record<string, unknown>): boolean {
  if (value['type'] !== 'session_meta') return false;
  const payload = isRecord(value['payload']) ? value['payload'] : undefined;
  if (payload === undefined) return false;
  if (payload['thread_source'] === 'subagent') return true;
  const source = payload['source'];
  return (
    source === 'subagent' ||
    (isRecord(source) && (source['kind'] === 'subagent' || isRecord(source['subagent'])))
  );
}
function transcriptItems(
  record: Record<string, unknown>
): readonly (NativeTranscriptItem | NativeToolResult)[] {
  return transcriptRecordItems(record);
}
function transcriptRecordItems(
  record: Record<string, unknown>
): readonly (NativeTranscriptItem | NativeToolResult)[] {
  const createdAt = timestampOf(record);
  const results = codexToolResultsOf(record, createdAt);
  if (results.length > 0) return results;
  const values: NativeTranscriptItem[] = [
    ...codexToolUsesOf(record, createdAt),
    ...codexReasoningSummariesOf(record, createdAt),
    ...unsupportedCodexResponseItems(record, createdAt),
    ...unsupportedTranscriptItems(record, createdAt)
  ];
  const role = roleOf(record);
  if (role === undefined) return values;
  const rawText = messageText(textOf(record) ?? '');
  if (rawText.length === 0) return values;
  // Codex transcripts can contain the host's injected AGENTS.md and runtime
  // context as a `user` item before the first actual prompt.  It is neither a
  // user-visible chat turn nor a meaningful session title.
  if (role === 'USER' && isInjectedContextPrompt(rawText)) return values;
  const message =
    role === 'USER' ? parseCodexComposerImageMarkers(rawText) : { text: rawText, images: [] };
  values.unshift({
    kind: 'message',
    role,
    text: message.text,
    ...(message.images.length === 0
      ? {}
      : {
          imageAttachments: message.images.map((image) => ({
            name: `Image #${image.index}`,
            mime: imageMime(image.localPath),
            localPath: image.localPath
          }))
        }),
    createdAt
  });
  return values;
}
function codexToolUsesOf(
  record: Record<string, unknown>,
  createdAt: number | null
): readonly NativeTranscriptToolCall[] {
  const payload = codexToolPayload(record);
  if (payload?.['type'] !== 'custom_tool_call' && payload?.['type'] !== 'function_call') return [];
  const toolUseId = firstString(payload, ['call_id', 'id']);
  const toolName = firstString(payload, ['name', 'tool']);
  if (toolUseId === undefined || toolName === undefined) return [];
  const input = payload['input'] ?? payload['arguments'];
  const summary = compactValue(input, 10_000);
  return [
    {
      kind: 'tool_call',
      toolUseId,
      toolName: compact(toolName).slice(0, 128),
      input,
      inputSummary: summary.text || null,
      inputTruncated: summary.truncated,
      outputSummary: null,
      outputTruncated: false,
      failed: false,
      createdAt
    }
  ];
}

function codexToolResultsOf(
  record: Record<string, unknown>,
  createdAt: number | null
): readonly NativeToolResult[] {
  const payload = codexToolPayload(record);
  if (
    payload?.['type'] !== 'custom_tool_call_output' &&
    payload?.['type'] !== 'function_call_output'
  )
    return [];
  const toolUseId = firstString(payload, ['call_id', 'id']);
  if (toolUseId === undefined) return [];
  const output = compactValue(
    codexToolOutput(payload['output'] ?? payload['contentItems']),
    10_000
  );
  const imageAttachments = codexImagePlaceholders(payload['output'] ?? payload['contentItems']);
  return [
    {
      kind: 'tool_result',
      toolUseId,
      output: output.text,
      failed: payload['status'] === 'failed' || payload['error'] !== undefined,
      truncated: output.truncated,
      ...(imageAttachments.length === 0 ? {} : { imageAttachments }),
      createdAt
    }
  ];
}

function codexToolPayload(record: Record<string, unknown>): Record<string, unknown> | undefined {
  return record['type'] === 'response_item' && isRecord(record['payload'])
    ? record['payload']
    : undefined;
}

function codexGeneratedImageEvent(
  record: Record<string, unknown>
): NativeTranscriptToolCall | undefined {
  if (record['type'] !== 'event_msg' || !isRecord(record['payload'])) return undefined;
  const payload = record['payload'];
  if (
    payload['type'] !== 'image_generation_end' ||
    typeof payload['call_id'] !== 'string' ||
    typeof payload['saved_path'] !== 'string'
  )
    return undefined;
  const localPath = payload['saved_path'];
  if (!localPath.includes('/.codex/generated_images/') || !/\.(?:png|jpe?g|webp)$/i.test(localPath))
    return undefined;
  return {
    kind: 'tool_call',
    toolUseId: payload['call_id'],
    toolName: 'imagegen',
    input: null,
    inputSummary: null,
    inputTruncated: false,
    outputSummary:
      payload['status'] === 'completed' ? 'Image generation completed' : 'Image generation failed',
    outputTruncated: false,
    toolCategory: 'IMAGE_GENERATION',
    imageAttachments: [{ name: basename(localPath), mime: imageMime(localPath), localPath }],
    failed: payload['status'] !== 'completed',
    createdAt: timestampOf(record)
  };
}

function codexToolOutput(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const text = value.flatMap((block) => {
    if (typeof block === 'string') return [block];
    if (!isRecord(block)) return [];
    const direct = firstString(block, ['text', 'content']);
    return direct === undefined ? [] : [codexVisibleToolText(direct)];
  });
  return text.length > 0 ? text.join('') : value;
}

function codexVisibleToolText(value: string): string {
  const marker = 'data:image/';
  let cursor = 0;
  let visible = '';
  while (cursor < value.length) {
    const start = value.indexOf(marker, cursor);
    if (start < 0) return visible + value.slice(cursor);
    visible += `${value.slice(cursor, start)}[Image content filtered]`;
    const doubleQuote = value.indexOf('"', start);
    const singleQuote = value.indexOf("'", start);
    const end =
      doubleQuote < 0
        ? singleQuote
        : singleQuote < 0
          ? doubleQuote
          : Math.min(doubleQuote, singleQuote);
    if (end < 0) return visible;
    cursor = end;
  }
  return visible;
}

function codexImagePlaceholders(value: unknown): readonly NativeTranscriptImageAttachment[] {
  const attachments: NativeTranscriptImageAttachment[] = [];
  let visited = 0;
  const visit = (current: unknown, depth: number): void => {
    if (attachments.length >= 5 || visited >= 128 || depth > 5 || current == null) return;
    visited += 1;
    if (typeof current === 'string') {
      const paths: string[] = [];
      collectGeneratedImagePaths(current, paths);
      for (const localPath of paths) {
        if (attachments.some((attachment) => attachment.localPath === localPath)) continue;
        attachments.push({ name: basename(localPath), mime: imageMime(localPath), localPath });
      }
      return;
    }
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry, depth + 1);
      return;
    }
    if (!isRecord(current)) return;
    const type = typeof current['type'] === 'string' ? current['type'] : '';
    if (type === 'input_text' && typeof current['text'] === 'string') {
      const mime = /["']image_url["']\s*:\s*["']data:(image\/[^;,"']+)[;,]/.exec(
        current['text']
      )?.[1];
      if (mime !== undefined)
        attachments.push({ name: `image-${attachments.length + 1}.${imageExtension(mime)}`, mime });
    }
    const imageUrl = isRecord(current['image_url'])
      ? firstString(current['image_url'], ['url'])
      : typeof current['image_url'] === 'string'
        ? current['image_url']
        : undefined;
    const data = typeof current['data'] === 'string' ? current['data'] : imageUrl;
    if (
      (type === 'image' || type === 'input_image' || type === 'output_image') &&
      data?.startsWith('data:image/')
    ) {
      const mime = /^data:([^;,]+)[;,]/.exec(data)?.[1] ?? 'image/png';
      attachments.push({ name: `image-${attachments.length + 1}.${imageExtension(mime)}`, mime });
    }
    for (const child of Object.values(current)) visit(child, depth + 1);
  };
  visit(value, 0);
  return attachments;
}

function collectGeneratedImagePaths(value: string, paths: string[]): void {
  const marker = '/.codex/generated_images/';
  let cursor = 0;
  while (paths.length < 5) {
    const markerIndex = value.indexOf(marker, cursor);
    if (markerIndex < 0) return;
    let start = markerIndex;
    while (start > 0 && !/[\s"']/.test(value[start - 1] as string)) start -= 1;
    let end = markerIndex + marker.length;
    while (end < value.length && !/[\s"']/.test(value[end] as string)) end += 1;
    const path = value.slice(start, end).replace(/[),.;:]+$/, '');
    if (/\.(?:png|jpe?g|webp)$/i.test(path) && !paths.includes(path)) paths.push(path);
    cursor = end;
  }
}

function imageMime(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  return 'image/png';
}

function imageExtension(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'png';
}

function codexViewedImagePath(call: NativeTranscriptToolCall): string | undefined {
  const toolName = call.toolName.toLowerCase();
  if (toolName === 'view_image' || toolName === 'imageview') {
    return isRecord(call.input) && typeof call.input['path'] === 'string'
      ? call.input['path']
      : undefined;
  }
  if (toolName !== 'exec' || typeof call.input !== 'string') return undefined;
  if (!/tools\.view_image\s*\(/.test(call.input)) return undefined;
  const encodedPath = /["']path["']\s*:\s*("(?:\\.|[^"\\])*")/.exec(call.input)?.[1];
  if (encodedPath === undefined) return undefined;
  try {
    const path = JSON.parse(encodedPath) as unknown;
    return typeof path === 'string' ? path : undefined;
  } catch {
    return undefined;
  }
}

function isInjectedContextPrompt(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.startsWith('<codex_internal_context')) return true;
  if (/^<(?:environment_context|subagent_notification|turn_aborted)(?:\s|>)/u.test(normalized))
    return true;
  return (
    normalized.startsWith('# AGENTS.md instructions') &&
    (normalized.includes('<INSTRUCTIONS>') || normalized.includes('<environment_context>'))
  );
}

function unsupportedCodexResponseItems(
  record: Record<string, unknown>,
  createdAt: number | null
): readonly NativeTranscriptUnknown[] {
  const payload = codexToolPayload(record);
  const type = typeof payload?.type === 'string' ? payload.type : undefined;
  if (
    type === undefined ||
    typeof payload?.role === 'string' ||
    type === 'reasoning' ||
    type === 'custom_tool_call' ||
    type === 'custom_tool_call_output' ||
    type === 'function_call' ||
    type === 'function_call_output'
  )
    return [];
  return [
    {
      kind: 'unknown',
      sourceEventType: `codex:${type}`,
      label: `Codex ${compact(type).slice(0, 128)}`,
      createdAt
    }
  ];
}

function codexReasoningSummariesOf(
  record: Record<string, unknown>,
  createdAt: number | null
): readonly NativeTranscriptReasoningSummary[] {
  const payload = codexToolPayload(record);
  if (payload?.type !== 'reasoning') return [];
  const sections = Array.isArray(payload.summary)
    ? payload.summary.flatMap((value, index) => {
        if (typeof value !== 'string') return [];
        const text = compact(value).slice(0, 10_000);
        return text.length === 0 ? [] : [{ index, text }];
      })
    : [];
  return [{ kind: 'reasoning_summary', representation: 'summary', sections, createdAt }];
}
function withToolResult(
  call: NativeTranscriptToolCall,
  result: NativeToolResult
): NativeTranscriptToolCall {
  const viewedImagePath = codexViewedImagePath(call);
  const imageAttachments = result.imageAttachments?.map((attachment) =>
    attachment.localPath !== undefined || viewedImagePath === undefined
      ? attachment
      : {
          name: basename(viewedImagePath),
          mime: imageMime(viewedImagePath),
          localPath: viewedImagePath
        }
  );
  return {
    ...call,
    outputSummary: result.output,
    outputTruncated: result.truncated,
    ...(imageAttachments === undefined ? {} : { imageAttachments }),
    failed: result.failed
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
  // A Codex sub-agent transcript records its own thread in `payload.id`, but
  // retains the parent thread in `payload.session_id`.  Treating the latter
  // as this file's identity makes the child file overwrite the parent thread
  // in the discovery index, which then shows unrelated messages for the
  // parent Chat.
  if (record['type'] === 'session_meta') {
    const transcriptId = nestedString(record, ['payload', 'id']);
    if (transcriptId !== undefined) return transcriptId;
  }
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
export const codexNativeTranscriptAdapter: NativeTranscriptAdapter = {
  runner: 'codex',
  transcriptRoot: () => join(homedir(), '.codex', 'sessions'),
  includesPath: () => true,
  parse,
  createProjection() {
    return {
      userText: (text) => parseCodexComposerImageMarkers(publicGoalHistoryText(text)).text,
      planText: () => undefined,
      normalizeTool: (entry) =>
        normalizeCodexTool({
          name: entry.toolName,
          namespace: 'codex',
          rawInput: entry.input,
          inputSummary: entry.inputSummary,
          outputSummary: entry.outputSummary,
          truncated: entry.inputTruncated || entry.outputTruncated,
          ...(entry.imageAttachments === undefined ? {} : { attachments: entry.imageAttachments })
        }),
      userInputQuestions: () => []
    };
  }
};
