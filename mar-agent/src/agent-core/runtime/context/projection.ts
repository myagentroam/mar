import { restoreNativeModelContext } from '../../model/native-context.js';
import { appliedInputRecord } from '../../session/deferred-input.js';
import { inputMetadataFromRecord } from '../../session/store/index.js';
import type { ModelMessage } from '../../model/contracts.js';
import {
  contextGcTargetKey,
  latestValidContextGcCheckpoint,
  type ContextGcCheckpointCache,
  type ContextGcCheckpointPayload,
  type ContextGcReplacement,
  type ContextGcTarget
} from '../../session/context-gc-checkpoint.js';
import type { SessionRecord } from '../../session/store/index.js';
import { TOOL_EXECUTION_LIMITS } from '../../tools/execution-limits.js';
import { replaceReadContextItems } from '../../tools/local/read-context.js';
import {
  parseCodeCalls,
  parseObservations,
  renderObservationResult
} from '../../tools/code-mode/observations.js';

export interface ContextProjectionEntry {
  readonly record: SessionRecord;
  readonly message: ModelMessage;
}

export interface ContextProjection {
  readonly entries: readonly ContextProjectionEntry[];
  readonly checkpoint?: ContextGcCheckpointPayload;
}

const MAX_MODEL_CONTEXT_BYTES = 1024 * 1024;

export function buildContextProjection(
  records: readonly SessionRecord[],
  workspace?: string,
  checkpointCache?: ContextGcCheckpointCache
): ContextProjection {
  let activeModelId: string | undefined;
  const rawEntries: ContextProjectionEntry[] = [];
  for (const record of records) {
    if (record.type === 'execution.header') {
      activeModelId = modelIdFromPayload(record.payload);
      continue;
    }
    if (record.type === 'compact.completed') {
      activeModelId = modelIdFromPayload(record.payload);
      rawEntries.splice(0);
      continue;
    }
    if (record.type !== 'model.context' || !isRecord(record.payload)) continue;
    const applied = appliedInputRecord(record);
    const message = applied
      ? {
          role: 'user' as const,
          content: (record.payload as Record<string, unknown>).content as string,
          metadata: inputMetadataFromRecord(applied)
        }
      : restoreModelContext(record.payload, activeModelId);
    if (message) rawEntries.push({ record, message });
  }
  const valid = checkpointCache
    ? checkpointCache.read(records, undefined, workspace)
    : latestValidContextGcCheckpoint(records, undefined, workspace);
  const messages = rawEntries.flatMap((entry) => (entry.message ? [entry.message] : []));
  const sources = rawEntries.flatMap((entry) => (entry.message ? [entry.record] : []));
  const applied = applyContextGcReplacementsToMessages(
    messages,
    sources,
    valid?.payload.replacements ?? []
  );
  const paired = filterPairedContext(applied.messages, applied.messageSources);
  const entries = paired.messages.map((message, index) => ({
    message,
    record: paired.messageSources[index]!
  }));
  return { entries, ...(valid ? { checkpoint: valid.payload } : {}) };
}

export function applyContextGcReplacementsToMessages(
  messages: readonly ModelMessage[],
  messageSources: readonly SessionRecord[],
  replacements: readonly ContextGcReplacement[]
): { readonly messages: ModelMessage[]; readonly messageSources: SessionRecord[] } {
  if (messages.length !== messageSources.length)
    throw new Error('Context projection message sources are not aligned.');
  const direct = new Map(
    replacements.map((replacement) => [contextGcTargetKey(replacement.target), replacement])
  );
  const aliases = new Set(
    replacements.flatMap((replacement) =>
      replacement.kind === 'TOOL_CALL_INPUT'
        ? replacement.providerAliasTargets.map(contextGcTargetKey)
        : []
    )
  );
  const projected: Array<{ message: ModelMessage; source: SessionRecord }> = [];
  for (const [index, source] of messageSources.entries()) {
    const message = messages[index]!;
    const target = targetFromMessage(source, message);
    if (target && aliases.has(contextGcTargetKey(target))) continue;
    const replacement = target ? direct.get(contextGcTargetKey(target)) : undefined;
    let next = cloneMessage(message);
    if (next.observations && target) {
      const observations = next.observations.map((value) => {
        const itemTarget = { ...target, observationId: value.id };
        const item = direct.get(contextGcTargetKey(itemTarget));
        if (!item || !targetMatchesReplacement(itemTarget, item.target)) return value;
        if (item.kind === 'READ_OUTPUT_ITEMS' && value.type === 'tool_result')
          return {
            ...value,
            result: {
              ...value.result,
              content: replaceReadContextItems(value.result.content, item.items)
            }
          };
        if ('replacementContent' in item)
          return value.type === 'tool_result'
            ? { ...value, result: { ...value.result, content: item.replacementContent } }
            : { ...value, value: item.replacementContent };
        return value;
      });
      next = {
        ...next,
        observations,
        content:
          next.textBlocks === undefined
            ? renderObservationResult(observations, next.content)
            : next.content
      };
    }
    if (replacement && target && targetMatchesReplacement(target, replacement.target)) {
      if (
        replacement.kind === 'READ_OUTPUT_ITEMS' &&
        next.role === 'tool' &&
        typeof next.content === 'string'
      )
        next = {
          ...next,
          content: replaceReadContextItems(next.content, replacement.items)
        };
      else if (replacement.kind === 'TOOL_CALL_INPUT' && next.role === 'tool_call')
        next = { ...next, arguments: structuredClone(replacement.replacementArguments) };
      else if (
        (replacement.kind === 'EXEC_OUTPUT' ||
          replacement.kind === 'CODE_MODE_OUTPUT' ||
          replacement.kind === 'SUBAGENT_OUTPUT' ||
          replacement.kind === 'WEB_OUTPUT') &&
        next.role === 'tool'
      )
        next = { ...next, content: replacement.replacementContent };
    }
    if (next.textBlocks !== undefined && next.content !== message.content)
      next = {
        ...next,
        textBlocks: [{ text: next.content }]
      };
    projected.push({ message: next, source });
  }
  return {
    messages: projected.map(({ message }) => message),
    messageSources: projected.map(({ source }) => source)
  };
}

export function filterPairedContext(
  messages: readonly ModelMessage[],
  messageSources: readonly SessionRecord[]
): { readonly messages: ModelMessage[]; readonly messageSources: SessionRecord[] } {
  if (messages.length !== messageSources.length)
    throw new Error('Context projection message sources are not aligned.');
  const entries = messages.map((message, index) => ({
    message,
    source: messageSources[index]!
  }));
  const completedToolCalls = new Set(
    entries
      .filter(({ message }) => message.role === 'tool')
      .map(({ message }) => message.callId)
      .filter((callId): callId is string => callId !== undefined)
  );
  const paired = entries.filter(({ message }) => {
    if (message.role === 'tool_call') return completedToolCalls.has(message.callId ?? '');
    if (message.role !== 'provider' || message.provider !== 'OPENAI_RESPONSES') return true;
    const callId = providerToolCallId(message);
    return callId === undefined || completedToolCalls.has(callId);
  });
  return {
    messages: paired.map(({ message }) => message),
    messageSources: paired.map(({ source }) => source)
  };
}

export function restoreModelContext(
  payload: Record<string, unknown>,
  providerModelId?: string
): ModelMessage | undefined {
  if (payload.inputRef !== undefined) {
    const input = appliedInputRecord({ type: 'model.context', payload } as SessionRecord)!;
    return {
      role: 'user',
      content: payload.content as string,
      metadata: inputMetadataFromRecord(input)
    };
  }
  const nativeItem =
    payload.role === 'provider' && payload.provider === 'OPENAI_RESPONSES' && isRecord(payload.item)
      ? payload.item
      : undefined;
  const toolName =
    payload.role === 'tool_call'
      ? payload.name
      : nativeItem?.type === 'custom_tool_call'
        ? nativeItem.name
        : undefined;
  const inputLimit =
    toolName === 'code_exec' || toolName === 'code_exec_wait'
      ? TOOL_EXECUTION_LIMITS.codeMaxInputBytes
      : toolName === 'apply_patch'
        ? TOOL_EXECUTION_LIMITS.patchMaxBytes
        : undefined;
  const byteLimit = inputLimit === undefined ? MAX_MODEL_CONTEXT_BYTES : inputLimit * 6 + 4096;
  if (Buffer.byteLength(JSON.stringify(payload)) > byteLimit) return undefined;
  if (payload.role === 'user' && typeof payload.content === 'string') {
    const blocks = payload.textBlocks;
    const textBlocks =
      Array.isArray(blocks) &&
      Array.from(blocks).every((block) => block && typeof block.text === 'string') &&
      blocks.map((block) => block.text).join('') === payload.content
        ? blocks.map((block) => ({ text: block.text as string }))
        : undefined;
    return {
      role: 'user',
      content: payload.content,
      contextKind: 'contextual',
      ...(textBlocks === undefined ? {} : { textBlocks })
    };
  }
  if (
    payload.role === 'tool' &&
    typeof payload.content === 'string' &&
    typeof payload.callId === 'string'
  )
    return {
      role: 'tool',
      content: payload.content,
      callId: payload.callId,
      ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
      ...(typeof payload.isError === 'boolean' ? { isError: payload.isError } : {}),
      ...(Array.isArray(payload.textBlocks) &&
      payload.textBlocks.every(
        (block) =>
          block &&
          typeof block.text === 'string' &&
          (block.cache === undefined || block.cache === true)
      ) &&
      payload.textBlocks.map((block) => block.text).join('') === payload.content
        ? {
            textBlocks: payload.textBlocks.map((block) => ({
              text: block.text,
              ...(block.cache === true ? { cache: true as const } : {})
            }))
          }
        : {}),
      ...(parseCodeCalls(payload.calls) ? { calls: parseCodeCalls(payload.calls)! } : {}),
      ...(parseObservations(payload.observations)
        ? { observations: parseObservations(payload.observations)! }
        : {}),
      ...(Array.isArray(payload.toolSearchTools)
        ? {
            toolSearchTools: payload.toolSearchTools.filter(
              (tool): tool is NonNullable<ModelMessage['toolSearchTools']>[number] =>
                isRecord(tool) &&
                typeof tool.name === 'string' &&
                typeof tool.description === 'string' &&
                isRecord(tool.inputSchema)
            )
          }
        : {})
    };
  if (
    payload.role === 'tool_call' &&
    typeof payload.callId === 'string' &&
    typeof payload.name === 'string'
  )
    return {
      role: 'tool_call',
      content: '',
      callId: payload.callId,
      name: payload.name,
      arguments: payload.arguments,
      ...(payload.inputMode === 'json' || payload.inputMode === 'freeform'
        ? { inputMode: payload.inputMode }
        : {})
    };
  if (payload.role === 'provider') return restoreNativeModelContext(payload, providerModelId);
  return undefined;
}

export function providerToolCallId(message: ModelMessage): string | undefined {
  if (message.role !== 'provider' || message.provider !== 'OPENAI_RESPONSES' || !message.item)
    return undefined;
  if (
    message.item.type !== 'function_call' &&
    message.item.type !== 'custom_tool_call' &&
    message.item.type !== 'tool_search_call'
  )
    return undefined;
  return typeof message.item.call_id === 'string' ? message.item.call_id : undefined;
}

export function providerToolName(message: ModelMessage): string | undefined {
  if (message.role !== 'provider' || !message.item) return undefined;
  if (message.item.type === 'tool_search_call') return 'tool_search';
  return typeof message.item.name === 'string' ? message.item.name : undefined;
}

function targetFromMessage(
  record: SessionRecord,
  message: ModelMessage
): ContextGcTarget | undefined {
  if (record.type !== 'model.context') return undefined;
  const callId = message.role === 'provider' ? providerToolCallId(message) : message.callId;
  const toolName = message.role === 'provider' ? providerToolName(message) : message.name;
  if (message.role !== 'tool_call' && message.role !== 'tool' && message.role !== 'provider')
    return undefined;
  return {
    sequence: record.sequence,
    recordId: record.recordId,
    role: message.role,
    ...(callId === undefined ? {} : { callId }),
    ...(toolName === undefined ? {} : { toolName })
  };
}

function targetMatchesReplacement(left: ContextGcTarget, right: ContextGcTarget): boolean {
  return (
    contextGcTargetKey(left) === contextGcTargetKey(right) &&
    (right.toolName === undefined || right.toolName === left.toolName)
  );
}

function cloneMessage(message: ModelMessage): ModelMessage {
  return structuredClone(message);
}

function modelIdFromPayload(
  payload: unknown,
  key: 'modelId' | 'providerModelId' = 'modelId'
): string | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
