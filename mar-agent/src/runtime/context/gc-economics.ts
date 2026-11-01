import type { ModelUsage } from '../../model/contracts.js';

import { type ContextGcEconomicsPolicy } from '../../session/context-gc-checkpoint.js';
import { AGENT_EXECUTION_POLICY } from '../execution-policy.js';
import { CONTEXT_GC_TEXT_PROTECTION_ROLLOUTS } from '../../session/context-gc-protection.js';

export const CONTEXT_GC_POLICY = {
  version: 1,
  minimumPaybackRollouts: 30,
  maximumPaybackRollouts: 60,
  contextGrowthSampleWindow: 16,
  minimumContextGrowthSamples: 6,
  minimumObservationRollouts: 1,
  stageAProtectionRollouts: CONTEXT_GC_TEXT_PROTECTION_ROLLOUTS,
  largeExecProtectionRollouts: CONTEXT_GC_TEXT_PROTECTION_ROLLOUTS,
  normalInputCostRate: 1,
  cacheReadCostRate: 0.05
} satisfies ContextGcEconomicsPolicy;

const CONTEXT_GC_START_RATIO = 0.5;

export const COMPACT_THRESHOLD_RATIO = AGENT_EXECUTION_POLICY.backgroundCompactionPercent / 100;

interface ContextGcEconomicsInput {
  readonly contextUsageTokens: number;
  readonly contextWindowTokens: number;
  readonly reclaimedTokens: number;
  readonly reclaimedCachedTokens: number;
  readonly cacheReadTokens: number;
  readonly preservedCachedPrefixTokens: number;
}

export interface ContextGcEconomicsResult {
  readonly cacheRebuildPenaltyCostUnits: number;
  readonly requiredPositiveNetRollouts: number | null;
  readonly expectedNetSavedCostUnits: number;
  readonly grossReductionRate: number;
  readonly passes: boolean;
}

export function evaluateContextGcEconomics(
  input: ContextGcEconomicsInput
): ContextGcEconomicsResult {
  const reclaimedTokens = Math.max(0, input.reclaimedTokens);
  const cacheReadTokens = Math.max(0, input.cacheReadTokens);
  const preservedCachedPrefixTokens = clamp(input.preservedCachedPrefixTokens, 0, cacheReadTokens);
  const invalidatedCachedSuffixTokens = cacheReadTokens - preservedCachedPrefixTokens;
  const reclaimedCachedTokens = clamp(
    input.reclaimedCachedTokens,
    0,
    invalidatedCachedSuffixTokens
  );
  const invalidatedRetainedCachedTokens = Math.max(
    0,
    invalidatedCachedSuffixTokens - reclaimedCachedTokens
  );
  // Calculate token-derived costs in cache-read units to keep exact zero exact.
  const unitsPerNormalInput =
    CONTEXT_GC_POLICY.normalInputCostRate / CONTEXT_GC_POLICY.cacheReadCostRate;
  const cacheRebuildPenalty = invalidatedRetainedCachedTokens * (unitsPerNormalInput - 1);
  const cacheRebuildPenaltyCostUnits = cacheRebuildPenalty * CONTEXT_GC_POLICY.cacheReadCostRate;
  const reclaimedUncachedTokens = Math.max(0, reclaimedTokens - reclaimedCachedTokens);
  const firstRolloutSavings = reclaimedCachedTokens + reclaimedUncachedTokens * unitsPerNormalInput;
  const steadyRolloutSavings = reclaimedTokens;
  const netAt = (rollouts: number) =>
    rollouts <= 0
      ? -cacheRebuildPenalty
      : firstRolloutSavings +
        Math.max(0, rollouts - 1) * steadyRolloutSavings -
        cacheRebuildPenalty;
  let requiredPositiveNetRollouts: number | null;
  if (netAt(1) > 0) requiredPositiveNetRollouts = 1;
  else if (steadyRolloutSavings <= 0) requiredPositiveNetRollouts = null;
  else {
    requiredPositiveNetRollouts = Math.max(2, Math.floor(-netAt(1) / steadyRolloutSavings) + 2);
    if (netAt(requiredPositiveNetRollouts - 1) > 0) requiredPositiveNetRollouts--;
    else if (netAt(requiredPositiveNetRollouts) <= 0) requiredPositiveNetRollouts++;
  }
  const expectedNetSavedCostUnits =
    netAt(requiredPositiveNetRollouts ?? 0) * CONTEXT_GC_POLICY.cacheReadCostRate;
  const grossReductionRate = reclaimedTokens / Math.max(1, Math.max(0, input.contextUsageTokens));
  const minimumReclaimedTokens = contextGcMinimumReclaimedTokens(input.contextWindowTokens);
  const usageRatio = input.contextUsageTokens / input.contextWindowTokens;
  const progress = clamp(
    (usageRatio - CONTEXT_GC_START_RATIO) / (COMPACT_THRESHOLD_RATIO - CONTEXT_GC_START_RATIO),
    0,
    1
  );
  const paybackWindow =
    CONTEXT_GC_POLICY.minimumPaybackRollouts +
    progress *
      (CONTEXT_GC_POLICY.maximumPaybackRollouts - CONTEXT_GC_POLICY.minimumPaybackRollouts);
  const withinWindow =
    requiredPositiveNetRollouts !== null && requiredPositiveNetRollouts <= paybackWindow;
  const passes =
    reclaimedTokens > 0 &&
    reclaimedTokens >= minimumReclaimedTokens &&
    Number.isFinite(usageRatio) &&
    usageRatio >= CONTEXT_GC_START_RATIO &&
    usageRatio < COMPACT_THRESHOLD_RATIO &&
    withinWindow;
  return {
    cacheRebuildPenaltyCostUnits,
    requiredPositiveNetRollouts,
    expectedNetSavedCostUnits,
    grossReductionRate,
    passes
  };
}

export function contextGcMinimumReclaimedTokens(contextWindowTokens: number): number {
  return Math.ceil(contextWindowTokens / 20);
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

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
