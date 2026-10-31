import type { SessionModelMessage as ModelMessage } from '../../session/model-request.js';

import {
  ContextGcCheckpointCache,
  contextGcBaseFromRecords,
  contextGcCheckpointIntervalEligible,
  contextGcMinimumUsageGrowth,
  contextGcTargetKey,
  normalizeContextGcReplacements,
  type ContextGcCheckpointDraft,
  type ContextGcMetrics,
  type ContextGcReplacement
} from '../../session/context-gc-checkpoint.js';

import type { SessionRecord } from '../../session/record-contract.js';
import { buildContextGcProtection } from '../../session/context-gc-protection.js';

import {
  CONTEXT_GC_TOKEN_ESTIMATOR,
  contextGcCacheImpact,
  contextGcMessageTokens,
  contextGcPrefixTokens,
  contextGcReclaimedTokens
} from './gc-tokens.js';

import { applyContextGcReplacementsToMessages, providerToolCallId } from './projection.js';

import {
  CONTEXT_GC_POLICY,
  COMPACT_CREDIT_ACTIVATION_RATIO,
  COMPACT_THRESHOLD_RATIO,
  evaluateContextGcEconomics,
  contextGcMinimumGrossReductionRate,
  contextGcMinimumReclaimedTokens,
  contextGcEligibleUsage,
  contextGcImminentCompactAvoidanceCredit,
  contextGcAppliedCompactCreditCostUnits,
  modelContextUsage,
  clamp
} from './gc-economics.js';

import {
  type ContextGcPlan,
  type ContextGcInspection,
  type ContextGcPlannerInput,
  type ContextCandidate,
  type CandidateSavings
} from './gc-contracts.js';

import { buildToolGroups, countSuccessfulNormalRollouts, isRecord } from './gc-candidates.js';

import { collectCodeModeCandidates } from './gc-candidates-code.js';

import { collectDeterministicCandidates } from './gc-candidates-read-patch.js';

import { collectExecCandidates } from './gc-candidates-exec.js';

import { collectToolOutputCandidates, collectWebCandidates } from './gc-candidates-web.js';

export {
  CONTEXT_GC_POLICY,
  type ContextGcEconomicsResult,
  evaluateContextGcEconomics,
  contextGcMinimumGrossReductionRate,
  contextGcMinimumReclaimedTokens,
  contextGcEligibleUsage,
  contextGcImminentCompactAvoidanceCredit,
  contextGcAppliedCompactCreditCostUnits
} from './gc-economics.js';

export {
  type ContextGcPlan,
  type ContextGcInspection,
  type ContextGcPlannerInput
} from './gc-contracts.js';

export function planContextGc(input: ContextGcPlannerInput): ContextGcPlan | undefined {
  return inspectContextGc(input).plan;
}

export function inspectContextGc(input: ContextGcPlannerInput): ContextGcInspection {
  const text = inspectTextGc(input);
  const media = input.inlineMedia;
  if (!media || (media.reason === 'TEXT_GC' && !text.plan)) return text;
  const currentUsage = modelContextUsage(input.usage);
  const usageRecord =
    (currentUsage === undefined ? undefined : latestUsageRecord(input.records, input.modelId)) ??
    input.records.at(-1);
  const contextUsageTokens = currentUsage ?? 0;
  if (!usageRecord) return text;
  input = {
    ...input,
    tokenCache: new Map(),
    checkpointCache: input.checkpointCache ?? new ContextGcCheckpointCache()
  };
  const state = {
    stage: text.plan?.stage ?? ('INLINE_MEDIA' as const),
    contextUsageTokens,
    usageRatio: contextUsageTokens / input.contextWindowTokens,
    usageRecord,
    normalRolloutOrdinal: countSuccessfulNormalRollouts(
      input.records,
      input.modelId,
      input.contextWindowTokens
    ),
    protectedCandidateTokens: text.plan?.metrics.protectedCandidateTokens ?? 0
  };
  if (text.plan) {
    const combined = evaluateCandidateSet(
      input,
      [],
      [
        {
          replacements: text.plan.draft.replacements,
          observedRollouts: text.plan.metrics.minimumObservedRollouts,
          evidenceSequence: text.plan.draft.boundarySequence
        }
      ],
      state,
      media.project
    );
    if (combined?.economics.passes) {
      const plan = finalizePlan(input, combined, true);
      if (plan) return { plan };
    }
    if (media.reason === 'TEXT_GC') return text;
  }
  // Byte pressure has its own admission signal; it never relaxes text GC eligibility.
  const onlyMedia = evaluateCandidateSet(
    input,
    input.checkpointCache!.read(input.records)?.payload.replacements ?? [],
    [
      {
        replacements: [],
        observedRollouts: media.reason === 'HARD_LIMIT' ? 0 : 2,
        evidenceSequence: input.records.at(-1)!.sequence
      }
    ],
    { ...state, stage: 'INLINE_MEDIA', mediaOnly: true },
    media.project
  );
  const plan = onlyMedia && finalizePlan(input, onlyMedia, true);
  return plan ? { plan } : text;
}

function inspectTextGc(input: ContextGcPlannerInput): ContextGcInspection {
  const contextUsageTokens = contextGcEligibleUsage(input.usage, input.contextWindowTokens);
  if (contextUsageTokens === undefined) return {};
  input = {
    ...input,
    tokenCache: new Map(),
    checkpointCache: input.checkpointCache ?? new ContextGcCheckpointCache(),
    protection: buildContextGcProtection(input.records, input.modelId, input.contextWindowTokens)
  };
  const usageRatio = contextUsageTokens / input.contextWindowTokens;
  const usageRecord = latestUsageRecord(input.records, input.modelId);
  if (!usageRecord) return {};
  const normalRolloutOrdinal = countSuccessfulNormalRollouts(
    input.records,
    input.modelId,
    input.contextWindowTokens
  );
  const previous = input.checkpointCache!.read(input.records);
  const checkpointEligible = contextGcCheckpointIntervalEligible(
    {
      usageSequence: usageRecord.sequence,
      contextInputTokens: contextUsageTokens,
      contextWindowTokens: input.contextWindowTokens,
      normalRolloutOrdinal,
      modelId: input.modelId,
      platform: input.platform
    },
    previous?.payload.trigger
  );
  // Discovery and economic evaluation have their own low-growth opportunities;
  // neither a protected candidate nor periodic discovery makes a draft eligible.
  if (
    previous?.payload.trigger.modelId === input.modelId &&
    previous.payload.trigger.contextWindowTokens === input.contextWindowTokens
  ) {
    const rolloutGrowth = normalRolloutOrdinal - previous.payload.trigger.normalRolloutOrdinal;
    if (
      rolloutGrowth < 2 ||
      (previous.payload.metrics.protectedCandidateTokens === 0 &&
        rolloutGrowth < CONTEXT_GC_POLICY.largeExecProtectionRollouts &&
        contextUsageTokens - previous.payload.trigger.contextInputTokens <
          contextGcMinimumUsageGrowth(input.contextWindowTokens))
    )
      return {};
  }
  if (input.messages.length !== input.messageSources.length) return {};
  const groups = buildToolGroups(input.records, input.messages, input.messageSources);
  const existing = previous?.payload.replacements ?? [];
  const candidateSavings = createCandidateSavingsEstimator(input, existing);
  const existingTargets = new Set(
    existing.flatMap((replacement) => [
      contextGcTargetKey(replacement.target),
      ...(replacement.kind === 'TOOL_CALL_INPUT'
        ? replacement.providerAliasTargets.map(contextGcTargetKey)
        : [])
    ])
  );
  const deterministic = collectDeterministicCandidates(
    input,
    groups,
    existing,
    existingTargets,
    candidateSavings
  );
  const exec = collectExecCandidates(input, groups, existingTargets, candidateSavings);
  const codeMode = collectCodeModeCandidates(input, groups, existingTargets, candidateSavings);
  const web = collectWebCandidates(input, groups, existingTargets, candidateSavings);
  const tools = collectToolOutputCandidates(input, groups, existingTargets, candidateSavings);
  const protectedCandidateTokens =
    deterministic.protectedTokens +
    exec.protectedTokens +
    codeMode.protectedTokens +
    web.protectedTokens +
    tools.protectedTokens;
  const combined = evaluateCandidateSet(
    input,
    existing,
    [
      ...deterministic.eligible,
      ...exec.eligible,
      ...codeMode.eligible,
      ...web.eligible,
      ...tools.eligible
    ],
    {
      stage: 'UNIFIED',
      contextUsageTokens,
      usageRatio,
      usageRecord,
      normalRolloutOrdinal,
      protectedCandidateTokens
    }
  );
  const retryAfterRollouts = Math.min(
    deterministic.retryAfterRollouts,
    exec.retryAfterRollouts,
    codeMode.retryAfterRollouts,
    web.retryAfterRollouts,
    tools.retryAfterRollouts
  );
  if (combined?.economics.passes && checkpointEligible) {
    const plan = finalizePlan(input, combined);
    return plan
      ? {
          plan,
          ...(protectedCandidateTokens > 0 && Number.isFinite(retryAfterRollouts)
            ? { retryAfterRollouts }
            : {})
        }
      : {};
  }
  return protectedCandidateTokens > 0 &&
    (combined?.economics.passes ||
      protectedCandidateTokens >=
        contextGcMinimumReclaimedTokens(contextUsageTokens, input.contextWindowTokens)) &&
    Number.isFinite(retryAfterRollouts)
    ? { retryAfterRollouts }
    : {};
}

function finalizePlan(
  input: ContextGcPlannerInput,
  evaluated: ReturnType<typeof evaluateCandidateSet> & {},
  includeMedia = false
): ContextGcPlan | undefined {
  if (!evaluated) return undefined;
  let inlineMedia: import('../../session/inline-media.js').InlineMediaGcCheckpoint | undefined;
  if (includeMedia && input.inlineMedia) {
    const { project: _project, ...checkpoint } = input.inlineMedia;
    inlineMedia = checkpoint;
  }
  const base = contextGcBaseFromRecords(input.records, evaluated.boundarySequence);
  if (!base) return undefined;
  const replacements = normalizeContextGcReplacements(evaluated.replacements);
  if (!replacements || (replacements.length === 0 && !inlineMedia)) return undefined;
  const metrics: ContextGcMetrics = {
    stage: evaluated.stage,
    tokenEstimator: CONTEXT_GC_TOKEN_ESTIMATOR,
    beforeTokens: evaluated.beforeTokens,
    afterTokens: evaluated.afterTokens,
    reclaimedTokens: evaluated.reclaimedTokens,
    grossReductionRate: evaluated.economics.grossReductionRate,
    effectiveMinimumGrossReductionRate: evaluated.minimumGrossReductionRate,
    minimumRequiredReclaimedTokens: evaluated.minimumReclaimedTokens,
    cacheRebuildPenaltyCostUnits: evaluated.economics.cacheRebuildPenaltyCostUnits,
    compactDeferralCreditCostUnits: evaluated.compactDeferralCreditCostUnits,
    imminentCompactAvoidanceCreditCostUnits: evaluated.imminentCompactAvoidanceCreditCostUnits,
    appliedCompactCreditCostUnits: evaluated.appliedCompactCreditCostUnits,
    requiredPositiveNetRollouts: Number.isFinite(evaluated.economics.requiredPositiveNetRollouts)
      ? evaluated.economics.requiredPositiveNetRollouts
      : null,
    requiredTargetRoiRollouts: Number.isFinite(evaluated.economics.requiredTargetRoiRollouts)
      ? evaluated.economics.requiredTargetRoiRollouts
      : null,
    projectedRolloutsUntilCompactAfterGc: evaluated.projectedRolloutsUntilCompactAfterGc,
    projectedTokensBeforeGc: evaluated.projectedTokensBeforeGc,
    projectedTokensAfterGc: evaluated.projectedTokensAfterGc,
    contextGrowthSampleCount: evaluated.contextGrowthSamples.length,
    contextGrowthP75Tokens: evaluated.contextGrowthP75Tokens,
    expectedNetSavedCostUnits: evaluated.economics.expectedNetSavedCostUnits,
    cacheInvestmentRoi: evaluated.economics.cacheInvestmentRoi,
    minimumObservedRollouts: evaluated.minimumObservedRollouts,
    protectedCandidateTokens: evaluated.protectedCandidateTokens,
    eligibleCandidateCount: evaluated.eligibleCandidateCount,
    eligibleTargetCount: replacements.reduce(
      (count, replacement) =>
        count +
        1 +
        (replacement.kind === 'TOOL_CALL_INPUT' ? replacement.providerAliasTargets.length : 0),
      0
    ),
    cachePenaltyKnown: input.usage.cacheReadTokens !== undefined
  };
  const draft: ContextGcCheckpointDraft = {
    ...(inlineMedia ? { inlineMedia } : {}),
    version: 1,
    base,
    boundarySequence: evaluated.boundarySequence,
    replacements,
    trigger: {
      usageSequence:
        modelContextUsage(input.usage) !== undefined &&
        isRecord(evaluated.usageRecord.payload) &&
        evaluated.usageRecord.payload.type === 'usage.updated'
          ? evaluated.usageRecord.sequence
          : null,
      contextInputTokens: evaluated.contextUsageTokens,
      contextWindowTokens: input.contextWindowTokens,
      normalRolloutOrdinal: evaluated.normalRolloutOrdinal,
      modelId: input.modelId,
      platform: input.platform
    },
    economics: CONTEXT_GC_POLICY,
    metrics
  };
  return { stage: evaluated.stage, draft, metrics };
}

function evaluateCandidateSet(
  input: ContextGcPlannerInput,
  existing: readonly ContextGcReplacement[],
  candidates: readonly ContextCandidate[],
  state: {
    readonly stage: ContextGcMetrics['stage'];
    readonly mediaOnly?: boolean;
    readonly contextUsageTokens: number;
    readonly usageRatio: number;
    readonly usageRecord: SessionRecord;
    readonly normalRolloutOrdinal: number;
    readonly protectedCandidateTokens: number;
  },
  mediaProjection?: (messages: readonly ModelMessage[]) => readonly ModelMessage[]
) {
  if (candidates.length === 0) return undefined;
  const replacements = normalizeContextGcReplacements([
    ...existing,
    ...candidates.flatMap((candidate) => candidate.replacements)
  ]);
  if (!replacements) return undefined;
  const projected = applyContextGcReplacementsToMessages(
    input.messages,
    input.messageSources,
    replacements
  );
  const projectedMessages = mediaProjection?.(projected.messages) ?? projected.messages;
  const reclaimedTokens = contextGcReclaimedTokens(input, input.messages, projectedMessages);
  const minimumGrossReductionRate = contextGcMinimumGrossReductionRate(state.usageRatio);
  const minimumReclaimedTokens = contextGcMinimumReclaimedTokens(
    state.contextUsageTokens,
    input.contextWindowTokens
  );
  if (!state.mediaOnly && reclaimedTokens < minimumReclaimedTokens) return undefined;
  const beforeTokens = contextGcPrefixTokens(input) + contextGcMessageTokens(input, input.messages);
  const afterTokens =
    contextGcPrefixTokens(input) + contextGcMessageTokens(input, projectedMessages);
  if (!state.mediaOnly && reclaimedTokens === 0) return undefined;
  const cache = contextGcCacheImpact(
    input,
    input.messages,
    projectedMessages,
    input.usage.cacheReadTokens ?? 0,
    reclaimedTokens
  );
  const growthSamples = collectContextGrowthSamples(
    input.records,
    input.modelId,
    input.contextWindowTokens,
    input.checkpointCache!
  );
  const contextGrowthP75Tokens = percentile75(growthSamples);
  const compactThresholdTokens = Math.floor(input.contextWindowTokens * COMPACT_THRESHOLD_RATIO);
  // Usage describes the request before its generated output and tool results.
  const pendingMessages = input.messages.filter(
    (_message, index) => input.messageSources[index]!.sequence > state.usageRecord.sequence
  );
  const pendingTokens =
    Math.max(0, input.usage.outputTokens ?? 0) + contextGcMessageTokens(input, pendingMessages);
  const projectedTokensBeforeGc = state.contextUsageTokens + pendingTokens;
  const projectedTokensAfterGc = Math.max(0, projectedTokensBeforeGc - reclaimedTokens);
  if (!state.mediaOnly && projectedTokensAfterGc >= compactThresholdTokens) return undefined;
  const projectedRolloutsUntilCompactAfterGc =
    contextGrowthP75Tokens <= 0
      ? 0
      : Math.max(
          0,
          Math.floor(
            (compactThresholdTokens - projectedTokensAfterGc) / Math.max(1, contextGrowthP75Tokens)
          )
        );
  const compactDeferralCreditCostUnits =
    state.usageRatio >= COMPACT_CREDIT_ACTIVATION_RATIO
      ? compactDeferralCredit(input, reclaimedTokens, compactThresholdTokens)
      : 0;
  const imminentCompactAvoidanceCreditCostUnits = contextGcImminentCompactAvoidanceCredit({
    contextUsageTokens: state.contextUsageTokens,
    contextWindowTokens: input.contextWindowTokens,
    compactThresholdTokens,
    projectedTokensBeforeGc,
    projectedTokensAfterGc,
    contextGrowthP75Tokens
  });
  const appliedCompactCreditCostUnits = contextGcAppliedCompactCreditCostUnits(
    compactDeferralCreditCostUnits,
    imminentCompactAvoidanceCreditCostUnits
  );
  const economics = evaluateContextGcEconomics({
    contextUsageTokens: state.contextUsageTokens,
    reclaimedTokens,
    reclaimedCachedTokens: cache.reclaimedCachedTokens,
    cacheReadTokens: input.usage.cacheReadTokens ?? 0,
    preservedCachedPrefixTokens: cache.preservedCachedPrefixTokens,
    compactDeferralCreditCostUnits: appliedCompactCreditCostUnits,
    projectedRolloutsUntilCompactAfterGc,
    contextGrowthSampleCount: growthSamples.length,
    minimumGrossReductionRate,
    minimumReclaimedTokens
  });
  return {
    ...state,
    economics,
    reclaimedCachedTokens: cache.reclaimedCachedTokens,
    replacements,
    beforeTokens,
    afterTokens,
    reclaimedTokens,
    contextGrowthSamples: growthSamples,
    contextGrowthP75Tokens,
    minimumGrossReductionRate,
    minimumReclaimedTokens,
    projectedRolloutsUntilCompactAfterGc,
    projectedTokensBeforeGc,
    projectedTokensAfterGc,
    compactDeferralCreditCostUnits,
    imminentCompactAvoidanceCreditCostUnits,
    appliedCompactCreditCostUnits,
    boundarySequence: input.records.at(-1)?.sequence ?? state.usageRecord.sequence,
    minimumObservedRollouts: Math.min(...candidates.map((candidate) => candidate.observedRollouts)),
    eligibleCandidateCount: candidates.length
  };
}

function latestUsageRecord(
  records: readonly SessionRecord[],
  selectedModelId: string
): SessionRecord | undefined {
  let activeModelId = selectedModelId;
  let latest: SessionRecord | undefined;
  for (const record of records) {
    if (record.type === 'execution.header') {
      const modelId = modelIdFromRecord(record);
      if (modelId) activeModelId = modelId;
    } else if (
      activeModelId === selectedModelId &&
      isRecord(record.payload) &&
      record.payload.type === 'usage.updated' &&
      modelContextUsage(record.payload) !== undefined
    )
      latest = record;
  }
  return latest;
}

function collectContextGrowthSamples(
  records: readonly SessionRecord[],
  modelId: string,
  contextWindowTokens: number,
  checkpointCache: ContextGcCheckpointCache
): number[] {
  const previous = checkpointCache.read(records);
  const base = contextGcBaseFromRecords(records);
  const startSequence =
    previous?.record.sequence ?? (base?.type === 'COMPACT' ? base.sequence : base?.firstSequence);
  let activeModelId = modelId;
  let activeWindow = contextWindowTokens;
  let previousUsage: number | undefined;
  const samples: number[] = [];
  for (const record of records) {
    if (startSequence !== undefined && record.sequence <= startSequence) continue;
    if (record.type === 'execution.header' && isRecord(record.payload)) {
      const nextModel = modelIdFromRecord(record);
      const nextWindow = record.payload.contextWindowTokens;
      if (
        nextModel !== modelId ||
        (typeof nextWindow === 'number' && nextWindow !== contextWindowTokens)
      ) {
        activeModelId = nextModel ?? activeModelId;
        activeWindow =
          typeof nextWindow === 'number' && Number.isSafeInteger(nextWindow)
            ? nextWindow
            : activeWindow;
        previousUsage = undefined;
      } else {
        activeModelId = modelId;
        activeWindow = contextWindowTokens;
      }
      continue;
    }
    if (
      activeModelId !== modelId ||
      activeWindow !== contextWindowTokens ||
      !isRecord(record.payload) ||
      record.payload.type !== 'usage.updated'
    )
      continue;
    const usage = modelContextUsage(record.payload);
    if (usage === undefined) {
      previousUsage = undefined;
      continue;
    }
    if (previousUsage !== undefined && usage > previousUsage) samples.push(usage - previousUsage);
    previousUsage = usage;
  }
  return samples.slice(-CONTEXT_GC_POLICY.contextGrowthSampleWindow);
}

function compactDeferralCredit(
  input: ContextGcPlannerInput,
  reclaimedTokens: number,
  compactThresholdTokens: number
): number {
  const base = contextGcBaseFromRecords(input.records);
  if (base?.type !== 'COMPACT') return 0;
  const compact = input.records.find((record) => record.sequence === base.sequence);
  if (!compact || !isRecord(compact.payload)) return 0;
  if (
    compact.payload.modelId !== input.modelId ||
    compact.payload.contextWindowTokens !== input.contextWindowTokens ||
    !isRecord(compact.payload.usage)
  )
    return 0;
  const usage = compact.payload.usage;
  const contextInput = modelContextUsage(usage);
  const cacheRead = nonnegativeNumber(usage.cacheReadTokens);
  const cacheWrite = nonnegativeNumber(usage.cacheWriteTokens);
  const output = nonnegativeNumber(usage.outputTokens);
  if (
    contextInput === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    output === undefined
  )
    return 0;
  const baseline = firstMatchingUsageAfter(
    input.records,
    compact.sequence,
    input.modelId,
    input.contextWindowTokens
  );
  if (baseline === undefined || baseline >= compactThresholdTokens) return 0;
  const fresh = Math.max(0, contextInput - cacheRead - cacheWrite);
  const compactCost =
    fresh * CONTEXT_GC_POLICY.normalInputCostRate +
    cacheRead * CONTEXT_GC_POLICY.cacheReadCostRate +
    cacheWrite * CONTEXT_GC_POLICY.cacheWriteCostRate +
    output * CONTEXT_GC_POLICY.outputCostRate;
  const cycleCapacity = Math.max(1, compactThresholdTokens - baseline);
  return compactCost * clamp(reclaimedTokens / cycleCapacity, 0, 1);
}

function firstMatchingUsageAfter(
  records: readonly SessionRecord[],
  sequence: number,
  modelId: string,
  contextWindowTokens: number
): number | undefined {
  let activeModelId = modelId;
  let activeContextWindowTokens = contextWindowTokens;
  for (const record of records) {
    if (record.sequence <= sequence) continue;
    if (record.type === 'execution.header' && isRecord(record.payload)) {
      if (typeof record.payload.modelId === 'string') activeModelId = record.payload.modelId;
      if (
        typeof record.payload.contextWindowTokens === 'number' &&
        Number.isSafeInteger(record.payload.contextWindowTokens) &&
        record.payload.contextWindowTokens > 0
      )
        activeContextWindowTokens = record.payload.contextWindowTokens;
      continue;
    }
    if (
      activeModelId !== modelId ||
      activeContextWindowTokens !== contextWindowTokens ||
      !isRecord(record.payload) ||
      record.payload.type !== 'usage.updated'
    )
      continue;
    const usage = modelContextUsage(record.payload);
    if (usage !== undefined) return usage;
  }
  return undefined;
}

/** Measure only affected call families, retaining native aliases for provider lowering. */
function createCandidateSavingsEstimator(
  input: ContextGcPlannerInput,
  existing: readonly ContextGcReplacement[]
): CandidateSavings {
  const byCall = new Map<string, number[]>();
  const byRecord = new Map<string, number[]>();
  for (const [index, message] of input.messages.entries()) {
    const callId = message.role === 'provider' ? providerToolCallId(message) : message.callId;
    if (callId) {
      const indices = byCall.get(callId) ?? [];
      indices.push(index);
      byCall.set(callId, indices);
    }
    const recordId = input.messageSources[index]!.recordId;
    const indices = byRecord.get(recordId) ?? [];
    indices.push(index);
    byRecord.set(recordId, indices);
  }
  return (candidate) => {
    const indices = new Set<number>();
    for (const replacement of candidate.replacements) {
      const targets = [
        replacement.target,
        ...(replacement.kind === 'TOOL_CALL_INPUT' ? replacement.providerAliasTargets : [])
      ];
      for (const target of targets) {
        for (const index of byRecord.get(target.recordId) ?? []) indices.add(index);
        if (target.callId) for (const index of byCall.get(target.callId) ?? []) indices.add(index);
      }
    }
    const ordered = [...indices].sort((a, b) => a - b);
    const messages = ordered.map((index) => input.messages[index]!);
    const sources = ordered.map((index) => input.messageSources[index]!);
    const replacements = normalizeContextGcReplacements([...existing, ...candidate.replacements]);
    if (!replacements) return 0;
    const projected = applyContextGcReplacementsToMessages(messages, sources, replacements);
    return contextGcReclaimedTokens(input, messages, projected.messages);
  };
}

function modelIdFromRecord(record: SessionRecord): string | undefined {
  if (!isRecord(record.payload)) return undefined;
  return typeof record.payload.modelId === 'string' ? record.payload.modelId : undefined;
}

function percentile75(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.75) - 1)]!;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
