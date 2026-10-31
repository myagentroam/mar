import type { ModelUsage } from '../../model/contracts.js';

import { type ContextGcEconomicsPolicy } from '../../session/context-gc-checkpoint.js';

export const CONTEXT_GC_POLICY: ContextGcEconomicsPolicy = {
  version: 1,
  immediatePaybackRollouts: 3,
  maximumPaybackRollouts: 20,
  contextGrowthSampleWindow: 16,
  minimumContextGrowthSamples: 6,
  minimumObservationRollouts: 1,
  stageAProtectionRollouts: 6,
  largeExecProtectionRollouts: 6,
  normalInputCostRate: 1,
  cacheReadCostRate: 0.1,
  cacheWriteCostRate: 1.25,
  outputCostRate: 1,
  minimumGrossReductionRate: 0.2,
  minimumCacheInvestmentRoi: 0.1
};

const CONTEXT_GC_START_RATIO = 0.5;

const HIGH_WATER_GROSS_REDUCTION_START_RATIO = 0.7;

const HIGH_WATER_MINIMUM_GROSS_REDUCTION_RATE = 0.1;

const MINIMUM_CONTEXT_WINDOW_REDUCTION_RATIO = 0.05;

export const COMPACT_CREDIT_ACTIVATION_RATIO = 0.8;

export const COMPACT_THRESHOLD_RATIO = 0.9;

const IMMINENT_COMPACT_CREDIT_DISCOUNT = 0.8;

interface ContextGcEconomicsInput {
  readonly contextUsageTokens: number;
  readonly reclaimedTokens: number;
  readonly reclaimedCachedTokens: number;
  readonly cacheReadTokens: number;
  readonly preservedCachedPrefixTokens: number;
  readonly compactDeferralCreditCostUnits: number;
  readonly projectedRolloutsUntilCompactAfterGc: number;
  readonly contextGrowthSampleCount: number;
  readonly minimumGrossReductionRate?: number;
  readonly minimumReclaimedTokens?: number;
}

export interface ContextGcEconomicsResult {
  readonly cacheRebuildPenaltyCostUnits: number;
  readonly requiredPositiveNetRollouts: number;
  readonly requiredTargetRoiRollouts: number;
  readonly expectedNetSavedCostUnits: number;
  readonly cacheInvestmentRoi: number;
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
  const cacheRebuildPenaltyCostUnits =
    invalidatedRetainedCachedTokens *
    (CONTEXT_GC_POLICY.cacheWriteCostRate - CONTEXT_GC_POLICY.cacheReadCostRate);
  const reclaimedUncachedTokens = Math.max(0, reclaimedTokens - reclaimedCachedTokens);
  const firstRolloutSavingsCostUnits =
    reclaimedCachedTokens * CONTEXT_GC_POLICY.cacheReadCostRate +
    reclaimedUncachedTokens * CONTEXT_GC_POLICY.normalInputCostRate;
  const steadyRolloutSavingsCostUnits = reclaimedTokens * CONTEXT_GC_POLICY.cacheReadCostRate;
  const netAt = (rollouts: number) =>
    input.compactDeferralCreditCostUnits -
    cacheRebuildPenaltyCostUnits +
    (rollouts <= 0
      ? 0
      : firstRolloutSavingsCostUnits + Math.max(0, rollouts - 1) * steadyRolloutSavingsCostUnits);
  const maximumSearch = Math.max(CONTEXT_GC_POLICY.maximumPaybackRollouts + 1, 10_000);
  const requiredPositiveNetRollouts = firstMatchingRollout(
    maximumSearch,
    (rollouts) => netAt(rollouts) > 0
  );
  const requiredTargetRoiRollouts =
    cacheRebuildPenaltyCostUnits === 0
      ? requiredPositiveNetRollouts
      : firstMatchingRollout(
          maximumSearch,
          (rollouts) =>
            netAt(rollouts) > 0 &&
            netAt(rollouts) / cacheRebuildPenaltyCostUnits >=
              CONTEXT_GC_POLICY.minimumCacheInvestmentRoi
        );
  const targetRollouts = Number.isFinite(requiredTargetRoiRollouts)
    ? requiredTargetRoiRollouts
    : CONTEXT_GC_POLICY.maximumPaybackRollouts;
  const expectedNetSavedCostUnits = netAt(targetRollouts);
  const cacheInvestmentRoi =
    cacheRebuildPenaltyCostUnits === 0
      ? 0
      : expectedNetSavedCostUnits / cacheRebuildPenaltyCostUnits;
  const grossReductionRate = reclaimedTokens / Math.max(1, Math.max(0, input.contextUsageTokens));
  const minimumGrossReductionRate = Math.max(
    0,
    input.minimumGrossReductionRate ?? CONTEXT_GC_POLICY.minimumGrossReductionRate
  );
  const minimumReclaimedTokens = Math.max(
    0,
    input.minimumReclaimedTokens ??
      Math.ceil(Math.max(0, input.contextUsageTokens) * minimumGrossReductionRate)
  );
  const immediate = requiredTargetRoiRollouts <= CONTEXT_GC_POLICY.immediatePaybackRollouts;
  const passes =
    reclaimedTokens > 0 &&
    reclaimedTokens >= minimumReclaimedTokens &&
    Number.isFinite(requiredTargetRoiRollouts) &&
    (immediate ||
      (requiredTargetRoiRollouts <= CONTEXT_GC_POLICY.maximumPaybackRollouts &&
        input.contextGrowthSampleCount >= CONTEXT_GC_POLICY.minimumContextGrowthSamples &&
        requiredTargetRoiRollouts <= input.projectedRolloutsUntilCompactAfterGc));
  return {
    cacheRebuildPenaltyCostUnits,
    requiredPositiveNetRollouts,
    requiredTargetRoiRollouts,
    expectedNetSavedCostUnits,
    cacheInvestmentRoi,
    grossReductionRate,
    passes
  };
}

export function contextGcMinimumGrossReductionRate(usageRatio: number): number {
  if (!Number.isFinite(usageRatio) || usageRatio <= HIGH_WATER_GROSS_REDUCTION_START_RATIO)
    return CONTEXT_GC_POLICY.minimumGrossReductionRate;
  if (usageRatio >= COMPACT_THRESHOLD_RATIO) return HIGH_WATER_MINIMUM_GROSS_REDUCTION_RATE;
  const progress =
    (usageRatio - HIGH_WATER_GROSS_REDUCTION_START_RATIO) /
    (COMPACT_THRESHOLD_RATIO - HIGH_WATER_GROSS_REDUCTION_START_RATIO);
  return (
    CONTEXT_GC_POLICY.minimumGrossReductionRate -
    progress *
      (CONTEXT_GC_POLICY.minimumGrossReductionRate - HIGH_WATER_MINIMUM_GROSS_REDUCTION_RATE)
  );
}

export function contextGcMinimumReclaimedTokens(
  contextUsageTokens: number,
  contextWindowTokens: number
): number {
  if (
    !Number.isFinite(contextUsageTokens) ||
    contextUsageTokens < 0 ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  )
    return 0;
  const usageRatio = contextUsageTokens / contextWindowTokens;
  const required = Math.max(
    contextUsageTokens * contextGcMinimumGrossReductionRate(usageRatio),
    contextWindowTokens * MINIMUM_CONTEXT_WINDOW_REDUCTION_RATIO
  );
  return Math.ceil(required - 1e-9);
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

export function contextGcImminentCompactAvoidanceCredit(input: {
  readonly contextUsageTokens: number;
  readonly contextWindowTokens: number;
  readonly compactThresholdTokens: number;
  readonly projectedTokensBeforeGc: number;
  readonly projectedTokensAfterGc: number;
  readonly contextGrowthP75Tokens: number;
}): number {
  if (
    input.contextUsageTokens >= input.compactThresholdTokens ||
    input.contextGrowthP75Tokens <= 0 ||
    input.projectedTokensBeforeGc < input.compactThresholdTokens
  )
    return 0;
  const safetyMarginTokens = Math.max(
    input.contextWindowTokens * MINIMUM_CONTEXT_WINDOW_REDUCTION_RATIO,
    input.contextGrowthP75Tokens * CONTEXT_GC_POLICY.immediatePaybackRollouts
  );
  if (input.projectedTokensAfterGc > input.compactThresholdTokens - safetyMarginTokens) return 0;
  return (
    input.contextUsageTokens *
    CONTEXT_GC_POLICY.normalInputCostRate *
    IMMINENT_COMPACT_CREDIT_DISCOUNT
  );
}

export function contextGcAppliedCompactCreditCostUnits(
  compactDeferralCreditCostUnits: number,
  imminentCompactAvoidanceCreditCostUnits: number
): number {
  return Math.max(0, compactDeferralCreditCostUnits, imminentCompactAvoidanceCreditCostUnits);
}

export function modelContextUsage(value: ModelUsage | Record<string, unknown>): number | undefined {
  const context = value.contextInputTokens ?? value.inputTokens;
  return typeof context === 'number' && Number.isSafeInteger(context) && context >= 0
    ? context
    : undefined;
}

function firstMatchingRollout(limit: number, predicate: (rollouts: number) => boolean): number {
  for (let rollouts = 0; rollouts <= limit; rollouts++) if (predicate(rollouts)) return rollouts;
  return Number.POSITIVE_INFINITY;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
