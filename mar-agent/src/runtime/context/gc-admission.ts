import type { ModelUsage } from '../../model/contracts.js';

import { AGENT_EXECUTION_POLICY } from '../execution-policy.js';
const CONTEXT_GC_START_RATIO = 0.5;

export const COMPACT_THRESHOLD_RATIO = AGENT_EXECUTION_POLICY.backgroundCompactionPercent / 100;

export function contextGcMinimumReclaimedTokens(contextWindowTokens: number): number {
  return Math.floor(contextWindowTokens / 10) + 1;
}

export function contextGcEligibleUsage(
  usage: ModelUsage,
  contextWindowTokens: number
): number | undefined {
  const contextUsageTokens = modelContextUsage(usage);
  if (
    contextUsageTokens === undefined ||
    !Number.isSafeInteger(contextWindowTokens) ||
    contextWindowTokens <= 0
  )
    return undefined;
  const usageRatio = contextUsageTokens / contextWindowTokens;
  if (usageRatio < CONTEXT_GC_START_RATIO || usageRatio >= COMPACT_THRESHOLD_RATIO)
    return undefined;
  return contextUsageTokens;
}

export function modelContextUsage(value: ModelUsage | Record<string, unknown>): number | undefined {
  const context = value.contextInputTokens ?? value.inputTokens;
  return typeof context === 'number' && Number.isSafeInteger(context) && context >= 0
    ? context
    : undefined;
}
