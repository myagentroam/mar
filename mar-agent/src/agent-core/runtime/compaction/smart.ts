import { MarAgentError } from '../../error.js';
import type { ModelMessage } from '../../model/contracts.js';
import { compactSummaryFromCheckpoint, type SessionRecord } from '../../session/store/index.js';

export const SMART_COMPACTION_MARKER =
  '<mar_runtime>\n  <smart_compaction>For this message only, smart_compact may be considered at a clear transition into sustained new work, when the previous phase is largely complete and its details have low continuation value.</smart_compaction>\n</mar_runtime>';

export interface SmartCompactionInput {
  readonly recordId: string;
  readonly eligible: boolean;
  requested: boolean;
  error?: unknown;
}

/** A measured watermark, not the stricter native-request budget calibration. */
export function latestSmartContextTokens(
  records: readonly SessionRecord[],
  modelId: string,
  contextWindowTokens: number
): number | undefined {
  let tokens: number | undefined;
  let matchingModel = false;
  for (const record of records) {
    const payload = record.payload as Record<string, unknown>;
    if (compactSummaryFromCheckpoint(record) !== undefined) {
      tokens = undefined;
      // A sliced checkpoint does not prove the input window used by later usage.
      matchingModel = false;
    }
    if (record.type === 'context.gc.completed') tokens = undefined;
    if (record.type === 'execution.header' && payload.mode !== 'compact') {
      matchingModel =
        payload.modelId === modelId && payload.contextWindowTokens === contextWindowTokens;
      if (!matchingModel) tokens = undefined;
    }
    if (matchingModel && payload.type === 'usage.updated' && payload.purpose !== 'compact') {
      const value = payload.contextInputTokens ?? payload.inputTokens;
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) tokens = value;
    }
  }
  return tokens;
}

/** Only provider views receive the marker; durable message content stays unchanged. */
export function projectSmartCompactionMessage(message: ModelMessage): ModelMessage {
  if (
    message.role !== 'user' ||
    message.contextKind !== undefined ||
    !message.metadata?.smartCompaction
  )
    return message;
  const suffix = '\n\n' + SMART_COMPACTION_MARKER;
  return {
    ...message,
    content: message.content + suffix,
    ...(message.textBlocks ? { textBlocks: [...message.textBlocks, { text: suffix }] } : {})
  };
}

export function requestSmartCompaction(
  input: SmartCompactionInput | undefined,
  start: () => void
): void {
  if (!input?.eligible)
    throw new MarAgentError(
      'MAR_AGENT_SMART_COMPACT_DENIED',
      'The current user input is not eligible for Smart Compaction.'
    );
  if ('error' in input) throw input.error;
  if (input.requested) return;
  input.requested = true;
  try {
    start();
  } catch (error) {
    input.error = error;
    throw error;
  }
}
