import { completedNativeThinkingIdentity } from '../model/native-context.js';
import type { SessionRecord } from './record-contract.js';

export const CONTEXT_GC_TEXT_PROTECTION_ROLLOUTS = 10;

export function contextGcProtectionMature(count: {
  readonly rollouts: number;
  readonly thinking: number;
}) {
  return count.rollouts >= CONTEXT_GC_TEXT_PROTECTION_ROLLOUTS && count.thinking >= 3;
}

/** One immutable boundary index; Compact seeds configuration when its execution header is sliced out. */
export function buildContextGcProtection(
  records: readonly SessionRecord[],
  modelId: string,
  contextWindowTokens: number
) {
  const configurations = new Map<string, { modelId: string; window: number }>();
  const attempts = new Map<string, { start: number; matching: boolean; native: Set<string> }>();
  const successful: number[] = [];
  const thinking: number[] = [];
  let baseline = { modelId, window: contextWindowTokens };
  for (const record of records) {
    if (record.type === 'compact.completed' && isRecord(record.payload)) {
      baseline = {
        modelId:
          typeof record.payload.modelId === 'string' ? record.payload.modelId : baseline.modelId,
        window:
          typeof record.payload.contextWindowTokens === 'number'
            ? record.payload.contextWindowTokens
            : baseline.window
      };
      continue;
    }
    if (
      !record.executionId ||
      !['execution.header', 'model.attempt', 'model.context'].includes(record.type) ||
      !isRecord(record.payload)
    )
      continue;
    const key = record.executionId;
    const payload = record.payload;
    if (record.type === 'execution.header') {
      configurations.set(key, {
        modelId: typeof payload.modelId === 'string' ? payload.modelId : modelId,
        window:
          typeof payload.contextWindowTokens === 'number'
            ? payload.contextWindowTokens
            : contextWindowTokens
      });
    } else if (record.type === 'model.attempt') {
      if (payload.purpose !== 'EXECUTION') continue;
      if (payload.state === 'STARTED') {
        const configuration = configurations.get(key) ?? baseline;
        attempts.set(key, {
          start: record.sequence,
          matching:
            payload.purpose === 'EXECUTION' &&
            configuration.modelId === modelId &&
            configuration.window === contextWindowTokens,
          native: new Set()
        });
      } else if (payload.state === 'SUCCEEDED' || payload.state === 'FAILED') {
        const attempt = attempts.get(key);
        if (attempt?.matching) {
          if (payload.state === 'SUCCEEDED') successful.push(attempt.start);
          for (let i = 0; i < attempt.native.size; i++) thinking.push(attempt.start);
        }
        attempts.delete(key);
      }
    } else if (record.type === 'model.context') {
      const attempt = attempts.get(key);
      if (
        !attempt?.matching ||
        (typeof payload.providerModelId === 'string' && payload.providerModelId !== modelId)
      )
        continue;
      const identity = completedNativeThinkingIdentity(payload, record.recordId);
      if (identity !== undefined) attempt.native.add(identity);
    }
  }
  for (const attempt of attempts.values())
    if (attempt.matching)
      for (let i = 0; i < attempt.native.size; i++) thinking.push(attempt.start);
  successful.sort((a, b) => a - b);
  thinking.sort((a, b) => a - b);
  return {
    after(anchor: number) {
      return { rollouts: afterCount(successful, anchor), thinking: afterCount(thinking, anchor) };
    }
  };
}

function afterCount(values: readonly number[], anchor: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! <= anchor) low = middle + 1;
    else high = middle;
  }
  return values.length - low;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
