import type { SessionRecord } from './record-contract.js';

export const CONTEXT_GC_TEXT_PROTECTION_ROLLOUTS = 10;

export function contextGcProtectionMature(rollouts: number): boolean {
  return rollouts >= CONTEXT_GC_TEXT_PROTECTION_ROLLOUTS;
}

/** One immutable boundary index; Compact seeds configuration when its execution header is sliced out. */
export function buildContextGcProtection(
  records: readonly SessionRecord[],
  modelId: string,
  contextWindowTokens: number
) {
  const configurations = new Map<string, { modelId: string; window: number }>();
  const attempts = new Map<string, number>();
  const successful: number[] = [];
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
      (record.type !== 'execution.header' && record.type !== 'model.attempt') ||
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
    } else if (payload.purpose === 'EXECUTION') {
      if (payload.state === 'STARTED') {
        const configuration = configurations.get(key) ?? baseline;
        if (configuration.modelId === modelId && configuration.window === contextWindowTokens)
          attempts.set(key, record.sequence);
        else attempts.delete(key);
      } else if (payload.state === 'SUCCEEDED' || payload.state === 'FAILED') {
        const start = attempts.get(key);
        if (start !== undefined && payload.state === 'SUCCEEDED') successful.push(start);
        attempts.delete(key);
      }
    }
  }
  successful.sort((a, b) => a - b);
  return {
    after(anchor: number) {
      return afterCount(successful, anchor);
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
