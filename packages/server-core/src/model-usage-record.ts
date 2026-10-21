import type { ModelUsageRecord } from '@myagentroam/protocol';

/** Personal ledger counters default to zero without changing the source observation. */
export function recordedUsage(record: ModelUsageRecord) {
  return {
    ...record,
    inputTokens: record.inputTokens ?? '0',
    outputTokens: record.outputTokens ?? '0',
    cacheReadTokens: record.cacheReadTokens ?? '0',
    cacheWriteTokens: record.cacheWriteTokens ?? '0',
    reasoningTokens: record.reasoningTokens ?? '0'
  };
}
