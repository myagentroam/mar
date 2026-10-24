import { isDeepStrictEqual } from 'node:util';
import {
  marAgentReasoningEffortSchema,
  type MarAgentReasoningEffort
} from '../../model/configuration.js';
import type { ModelMessage } from '../../model/contracts.js';
import { compactSummaryFromCheckpoint } from '../../session/store/execution-state.js';
import { estimatedRequestTokens } from './request-budget.js';
export interface AuthoritativeModelUsage {
  readonly contextInputTokens: number;
  readonly outputTokens: number | undefined;
  readonly historyMessages?: readonly ModelMessage[];
  readonly appendedMessages?: readonly ModelMessage[];
}

export function latestModelUsage(
  records: readonly import('../../session/store/index.js').SessionRecord[],
  selectedModelId: string
): AuthoritativeModelUsage | undefined {
  let usage: AuthoritativeModelUsage | undefined;
  const toolCallIds = new Set<string>();
  // readContext starts at compact.completed, whose execution header is before the boundary.
  let activeModelId: string | undefined = selectedModelId;
  for (const record of records) {
    const payload = record.payload as Record<string, unknown>;
    if (compactSummaryFromCheckpoint(record) !== undefined) {
      usage = undefined;
      toolCallIds.clear();
      activeModelId = modelIdFromPayload(payload);
      continue;
    }
    if (record.type === 'execution.header') {
      activeModelId = modelIdFromPayload(payload);
      usage = undefined;
      toolCallIds.clear();
      continue;
    }
    if (record.type === 'model.context' && payload.role === 'tool_call') {
      if (typeof payload.callId === 'string' && payload.callId.length > 0)
        toolCallIds.add(payload.callId);
      else usage = undefined;
    }
    if (usage !== undefined) {
      if (record.type === 'model.context') {
        const role = payload.role;
        if (role === 'tool') {
          if (typeof payload.callId !== 'string' || !toolCallIds.has(payload.callId))
            usage = undefined;
          else
            usage = {
              ...usage,
              appendedMessages: [
                ...(usage.appendedMessages ?? []),
                payload as unknown as ModelMessage
              ]
            };
        } else if (role !== 'tool_call' && role !== 'assistant' && role !== 'provider')
          usage = undefined;
      } else if (invalidatesUsageCalibration(record.type, payload.type)) usage = undefined;
    }
    if (
      payload.type === 'usage.updated' &&
      payload.purpose !== 'compact' &&
      activeModelId === selectedModelId
    ) {
      const value = payload.contextInputTokens ?? payload.inputTokens;
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        usage = {
          contextInputTokens: value,
          outputTokens:
            typeof payload.outputTokens === 'number' &&
            Number.isSafeInteger(payload.outputTokens) &&
            payload.outputTokens >= 0
              ? payload.outputTokens
              : undefined
        };
    }
  }
  return usage;
}

export function reasoningEffortBaseline(
  records: readonly import('../../session/store/index.js').SessionRecord[],
  modelId: string
): MarAgentReasoningEffort | undefined {
  let baseline: MarAgentReasoningEffort | undefined;
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]!;
    if (compactSummaryFromCheckpoint(record) !== undefined) break;
    if (record.type !== 'execution.header') continue;
    const payload = record.payload as Record<string, unknown>;
    if (payload.modelId !== modelId) break;
    const effort = marAgentReasoningEffortSchema.safeParse(payload.reasoningEffort);
    if (effort.success) baseline = effort.data;
  }
  return baseline;
}

export function shouldUseNativeCompaction(input: {
  readonly estimatedRequestTokens: number;
  readonly contextWindowTokens: number;
  readonly latestUsage: AuthoritativeModelUsage | undefined;
  readonly historyMessages: readonly ModelMessage[];
  readonly appendedMessages: readonly ModelMessage[];
}): boolean {
  if (input.estimatedRequestTokens <= input.contextWindowTokens) return true;
  if (input.latestUsage === undefined || input.latestUsage.outputTokens === undefined) return false;
  const historyDelta = appendOnlyUsageDelta(input.latestUsage, input.historyMessages);
  if (historyDelta === undefined) return false;
  const appendedTokens = estimatedRequestTokens(
    '',
    [...historyDelta, ...input.appendedMessages],
    []
  );
  return (
    input.latestUsage.contextInputTokens + input.latestUsage.outputTokens + appendedTokens <=
    input.contextWindowTokens
  );
}

function appendOnlyUsageDelta(
  usage: AuthoritativeModelUsage,
  historyMessages: readonly ModelMessage[]
): readonly ModelMessage[] | undefined {
  if (usage.historyMessages === undefined) return usage.appendedMessages ?? [];
  if (historyMessages.length < usage.historyMessages.length) return undefined;
  for (let index = 0; index < usage.historyMessages.length; index++)
    if (!isDeepStrictEqual(usage.historyMessages[index], historyMessages[index])) return undefined;
  const appended = historyMessages.slice(usage.historyMessages.length);
  const toolCallIds = new Set(
    usage.historyMessages
      .filter((message) => message.role === 'tool_call')
      .map((message) => message.callId)
  );
  return appended.every(
    (message) =>
      (message.role === 'tool' && toolCallIds.has(message.callId)) ||
      (message.role === 'user' && message.contextKind === 'environment')
  )
    ? appended
    : undefined;
}

function invalidatesUsageCalibration(recordType: string, payloadType: unknown): boolean {
  if (
    recordType === 'turn.user' ||
    recordType === 'context.environment' ||
    recordType === 'context.gc.completed'
  )
    return true;
  return payloadType === 'message.completed';
}

function modelIdFromPayload(
  payload: Record<string, unknown>,
  key: 'modelId' | 'providerModelId' = 'modelId'
): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
