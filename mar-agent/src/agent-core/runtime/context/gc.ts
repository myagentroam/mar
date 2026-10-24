import type { ClientToolDefinition, ModelMessage, ModelUsage } from '../../model/contracts.js';
import {
  codeCallEvidence,
  codePartialPatchCallEvidence,
  codeObservationEvidence,
  retainedCodeInputs
} from '../../session/context-gc-observations.js';
import {
  ContextGcCheckpointCache,
  contextGcBaseFromRecords,
  contextGcLogicalPathKey,
  contextGcMinimumUsageGrowth,
  contextGcTargetKey,
  normalizeContextGcReplacements,
  type ContextGcCheckpointDraft,
  type ContextGcEconomicsPolicy,
  type ContextGcMetrics,
  type ContextGcPlatform,
  type ContextGcReplacement,
  type ContextGcTarget
} from '../../session/context-gc-checkpoint.js';
import {
  codeCellCompletionSequence,
  contextGcApplyPatchInputReplacement,
  contextGcCodeModeInputReplacement,
  contextGcCodeModeOutputReplacement,
  contextGcExecInputReplacement,
  contextGcExecOutputReplacement,
  contextGcPatchResultFromCompletedPayload,
  contextGcPatchResultFromFailedPayload,
  contextGcStaleReadReplacement,
  contextGcWebOutputReplacement,
  normalizeContextGcCodeModeInput,
  normalizeContextGcExecResult,
  type ContextGcExecResult,
  type ContextGcWebToolName
} from '../../session/context-gc-replacements.js';
import {
  contextGcSubagentNeedsRetainedPriorFinal,
  contextGcSubagentOutputReplacement,
  contextGcSubagentPriorFinalIsRetained,
  contextGcSubagentSnapshotIsPreciselyCovered,
  contextGcSubagentSnapshotIsSuperseded,
  contextGcSubagentSnapshotTurnId,
  normalizeContextGcSubagentSnapshot,
  type ContextGcSubagentSnapshot,
  type ContextGcSubagentToolName
} from '../../session/context-gc-subagent.js';
import type { SessionRecord } from '../../session/store/index.js';
import { parseReadContextOutput } from '../../tools/local/read-context.js';
import {
  CONTEXT_GC_TOKEN_ESTIMATOR,
  contextGcCacheImpact,
  contextGcMessageTokens,
  contextGcPrefixTokens,
  contextGcReclaimedTokens
} from './gc-tokens.js';
import {
  applyContextGcReplacementsToMessages,
  providerToolCallId,
  providerToolName
} from './projection.js';

export const CONTEXT_GC_POLICY: ContextGcEconomicsPolicy = {
  version: 1,
  immediatePaybackRollouts: 3,
  maximumPaybackRollouts: 20,
  contextGrowthSampleWindow: 16,
  minimumContextGrowthSamples: 6,
  minimumObservationRollouts: 1,
  stageAProtectionRollouts: 2,
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
const COMPACT_CREDIT_ACTIVATION_RATIO = 0.8;
const COMPACT_THRESHOLD_RATIO = 0.9;
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

export interface ContextGcPlan {
  readonly stage: 'STAGE_A' | 'STAGE_A_AND_EXEC';
  readonly draft: ContextGcCheckpointDraft;
  readonly metrics: ContextGcMetrics;
}

interface ContextGcCacheEconomicsProfile {
  readonly reclaimedTokens: number;
  readonly reclaimedCachedTokens: number;
  readonly cacheRebuildPenaltyCostUnits: number;
}

export interface ContextGcInspection {
  readonly plan?: ContextGcPlan;
  readonly retryAfterRollouts?: number;
}

export interface ContextGcPlannerInput {
  readonly records: readonly SessionRecord[];
  readonly messages: readonly ModelMessage[];
  readonly messageSources: readonly SessionRecord[];
  readonly system: string;
  readonly tools: readonly ClientToolDefinition[];
  readonly modelId: string;
  readonly modelProtocol?: string;
  readonly responsesConfigurationUpdates?: boolean;
  readonly contextWindowTokens: number;
  readonly usage: ModelUsage;
  readonly workspace: string;
  readonly platform: ContextGcPlatform;
  readonly activeProcessIds: ReadonlySet<string>;
  readonly tokenCache?: Map<string, number>;
  readonly checkpointCache?: ContextGcCheckpointCache;
}

interface ContextCandidate {
  readonly replacements: readonly ContextGcReplacement[];
  readonly observedRollouts: number;
  readonly evidenceSequence: number;
}

type CandidateSavings = (candidate: ContextCandidate) => number;

interface ToolGroup {
  evidenceOnly?: boolean;
  readonly callId: string;
  toolName: string;
  call?: { message: ModelMessage; record: SessionRecord };
  result?: { message: ModelMessage; record: SessionRecord };
  aliases: Array<{ message: ModelMessage; record: SessionRecord }>;
  completed?: SessionRecord;
  failed?: SessionRecord;
}

interface ExecInvocation {
  readonly group: ToolGroup;
  readonly input: Record<string, unknown>;
  readonly result: ContextGcExecResult;
}

interface SubagentInvocation {
  readonly group: ToolGroup;
  readonly snapshot: ContextGcSubagentSnapshot;
  readonly turnId: string;
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

export function planContextGc(input: ContextGcPlannerInput): ContextGcPlan | undefined {
  return inspectContextGc(input).plan;
}

export function inspectContextGc(input: ContextGcPlannerInput): ContextGcInspection {
  const contextUsageTokens = contextGcEligibleUsage(input.usage, input.contextWindowTokens);
  if (contextUsageTokens === undefined) return {};
  input = {
    ...input,
    tokenCache: new Map(),
    checkpointCache: input.checkpointCache ?? new ContextGcCheckpointCache()
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
  if (previous) {
    const minimumUsageGrowth = contextGcMinimumUsageGrowth(input.contextWindowTokens);
    const protectedCandidatesPending = previous.payload.metrics.protectedCandidateTokens > 0;
    const rolloutGrowth = normalRolloutOrdinal - previous.payload.trigger.normalRolloutOrdinal;
    if (
      rolloutGrowth < 2 ||
      (!protectedCandidatesPending &&
        rolloutGrowth < CONTEXT_GC_POLICY.largeExecProtectionRollouts &&
        contextUsageTokens - previous.payload.trigger.contextInputTokens < minimumUsageGrowth)
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
  const stageA = collectStageACandidates(
    input,
    groups,
    existing,
    existingTargets,
    candidateSavings
  );
  const subagent = collectSubagentCandidates(input, groups, existingTargets, candidateSavings);
  const deterministicCandidates = [...stageA.eligible, ...subagent.eligible];
  const deterministicProtectedTokens = stageA.protectedTokens + subagent.protectedTokens;
  const stageAPlan = evaluateCandidateSet(input, existing, deterministicCandidates, {
    stage: 'STAGE_A',
    contextUsageTokens,
    usageRatio,
    usageRecord,
    normalRolloutOrdinal,
    protectedCandidateTokens: deterministicProtectedTokens
  });
  if (stageAPlan?.economics.passes) {
    const exec = collectExecCandidates(input, groups, existingTargets, candidateSavings);
    const codeMode = collectCodeModeCandidates(input, groups, existingTargets, candidateSavings);
    const web = collectWebCandidates(input, groups, existingTargets, candidateSavings);
    const protectedCandidateTokens =
      deterministicProtectedTokens +
      exec.protectedTokens +
      codeMode.protectedTokens +
      web.protectedTokens;
    const stageAPlanWithProtectedCandidates =
      evaluateCandidateSet(input, existing, deterministicCandidates, {
        stage: 'STAGE_A',
        contextUsageTokens,
        usageRatio,
        usageRecord,
        normalRolloutOrdinal,
        protectedCandidateTokens
      }) ?? stageAPlan;
    const marginal = mergeMarginalLargeOutputCandidates(
      input,
      existing,
      deterministicCandidates,
      [...exec.eligible, ...codeMode.eligible, ...web.eligible],
      stageAPlanWithProtectedCandidates,
      {
        contextUsageTokens,
        usageRatio,
        usageRecord,
        normalRolloutOrdinal,
        protectedCandidateTokens
      }
    );
    const plan = finalizePlan(input, marginal ?? stageAPlanWithProtectedCandidates);
    const retryAfterRollouts = Math.min(
      exec.retryAfterRollouts,
      codeMode.retryAfterRollouts,
      web.retryAfterRollouts
    );
    return plan
      ? {
          plan,
          ...(protectedCandidateTokens > 0 && Number.isFinite(retryAfterRollouts)
            ? { retryAfterRollouts }
            : {})
        }
      : {};
  }

  const exec = collectExecCandidates(input, groups, existingTargets, candidateSavings);
  const codeMode = collectCodeModeCandidates(input, groups, existingTargets, candidateSavings);
  const web = collectWebCandidates(input, groups, existingTargets, candidateSavings);
  const combined = evaluateCandidateSet(
    input,
    existing,
    [...deterministicCandidates, ...exec.eligible, ...codeMode.eligible, ...web.eligible],
    {
      stage: 'STAGE_A_AND_EXEC',
      contextUsageTokens,
      usageRatio,
      usageRecord,
      normalRolloutOrdinal,
      protectedCandidateTokens:
        deterministicProtectedTokens +
        exec.protectedTokens +
        codeMode.protectedTokens +
        web.protectedTokens
    }
  );
  if (combined?.economics.passes) {
    const plan = finalizePlan(input, combined);
    return plan ? { plan } : {};
  }
  const retryAfterRollouts = Math.min(
    stageA.retryAfterRollouts,
    subagent.retryAfterRollouts,
    exec.retryAfterRollouts,
    codeMode.retryAfterRollouts,
    web.retryAfterRollouts
  );
  return deterministicProtectedTokens +
    exec.protectedTokens +
    codeMode.protectedTokens +
    web.protectedTokens >=
    contextGcMinimumReclaimedTokens(contextUsageTokens, input.contextWindowTokens) &&
    Number.isFinite(retryAfterRollouts)
    ? { retryAfterRollouts }
    : {};
}

function collectCodeModeCandidates(
  input: ContextGcPlannerInput,
  groups: ReadonlyMap<string, ToolGroup>,
  existingTargets: ReadonlySet<string>,
  candidateSavings: CandidateSavings
): { eligible: ContextCandidate[]; protectedTokens: number; retryAfterRollouts: number } {
  const eligible: ContextCandidate[] = [];
  let protectedTokens = 0;
  let retryAfterRollouts = Infinity;
  for (const group of [...groups.values()].filter((item) =>
    ['code_exec', 'code_exec_wait'].includes(item.toolName)
  )) {
    if (
      !group.call ||
      !group.result ||
      group.failed ||
      !group.completed ||
      group.call.message.role !== 'tool_call' ||
      group.result.message.role !== 'tool' ||
      typeof group.result.message.content !== 'string'
    )
      continue;
    const code = normalizeContextGcCodeModeInput(group.call.message.arguments);
    const completedPayload = group.completed.payload;
    const completionSequence = codeCellCompletionSequence(input.records, group.completed);
    if (
      (group.toolName !== 'code_exec_wait' && !code) ||
      completionSequence === undefined ||
      !isRecord(completedPayload) ||
      typeof completedPayload.truncated !== 'boolean'
    )
      continue;
    for (const observation of group.result.message.observations ?? []) {
      if (observation.type !== 'value') continue;
      const target = targetFor(group.result.record, {
        ...group.result.message,
        observationId: observation.id
      });
      if (!target || existingTargets.has(contextGcTargetKey(target))) continue;
      const evidenceSequence = group.result.record.sequence;
      const candidate: ContextCandidate = {
        replacements: [
          {
            kind: 'CODE_MODE_OUTPUT',
            callId: group.callId,
            target,
            replacementContent: contextGcCodeModeOutputReplacement(
              observation.value,
              observation.truncated === true
            ),
            evidenceSequence
          }
        ],
        observedRollouts: successfulRolloutsAfter(
          input.records,
          Math.max(evidenceSequence, completionSequence),
          input.modelId,
          input.contextWindowTokens
        ),
        evidenceSequence
      };
      const reclaimedTokens = candidateSavings(candidate);
      if (reclaimedTokens <= 0) continue;
      if (candidate.observedRollouts >= CONTEXT_GC_POLICY.largeExecProtectionRollouts)
        eligible.push(candidate);
      else {
        protectedTokens += reclaimedTokens;
        retryAfterRollouts = Math.min(
          retryAfterRollouts,
          CONTEXT_GC_POLICY.largeExecProtectionRollouts - candidate.observedRollouts
        );
      }
    }
    const callTarget = targetFor(group.call.record, group.call.message);
    const resultTarget = targetFor(group.result.record, group.result.message);
    if (!callTarget || !resultTarget) continue;
    const evidenceSequence = group.result.record.sequence;
    const replacements: ContextGcReplacement[] = [];
    if (code && !existingTargets.has(contextGcTargetKey(callTarget)))
      replacements.push({
        kind: 'TOOL_CALL_INPUT',
        toolName: group.toolName as 'code_exec',
        callId: group.callId,
        target: callTarget,
        replacementArguments: contextGcCodeModeInputReplacement(
          code,
          group.result.message.observations ? retainedCodeInputs(input.records, group.callId) : []
        ),
        providerAliasTargets: group.aliases
          .map(({ record, message }) => targetFor(record, message))
          .filter((target): target is ContextGcTarget => target !== undefined),
        evidenceSequence
      });
    if (
      !group.result.message.observations &&
      !existingTargets.has(contextGcTargetKey(resultTarget))
    )
      replacements.push({
        kind: 'CODE_MODE_OUTPUT',
        callId: group.callId,
        target: resultTarget,
        replacementContent: contextGcCodeModeOutputReplacement(
          group.result.message.content,
          completedPayload.truncated
        ),
        evidenceSequence
      });
    if (replacements.length === 0) continue;
    const observedRollouts = successfulRolloutsAfter(
      input.records,
      Math.max(evidenceSequence, completionSequence),
      input.modelId,
      input.contextWindowTokens
    );
    const candidate: ContextCandidate = { replacements, observedRollouts, evidenceSequence };
    const reclaimedTokens = candidateSavings(candidate);
    if (reclaimedTokens <= 0) continue;
    if (observedRollouts >= CONTEXT_GC_POLICY.largeExecProtectionRollouts) eligible.push(candidate);
    else {
      protectedTokens += reclaimedTokens;
      retryAfterRollouts = Math.min(
        retryAfterRollouts,
        CONTEXT_GC_POLICY.largeExecProtectionRollouts - observedRollouts
      );
    }
  }
  return { eligible, protectedTokens, retryAfterRollouts };
}

function mergeMarginalLargeOutputCandidates(
  input: ContextGcPlannerInput,
  existing: readonly ContextGcReplacement[],
  deterministicCandidates: readonly ContextCandidate[],
  execCandidates: readonly ContextCandidate[],
  stageAPlan: NonNullable<ReturnType<typeof evaluateCandidateSet>>,
  state: {
    readonly contextUsageTokens: number;
    readonly usageRatio: number;
    readonly usageRecord: SessionRecord;
    readonly normalRolloutOrdinal: number;
    readonly protectedCandidateTokens: number;
  }
): ReturnType<typeof evaluateCandidateSet> {
  let selected = [...deterministicCandidates];
  let current = stageAPlan;
  const stageAEarliestSequence = contextGcEarliestReplacementSequence(
    deterministicCandidates.flatMap((candidate) => candidate.replacements)
  );
  for (const candidate of [...execCandidates].sort(
    (left, right) => right.evidenceSequence - left.evidenceSequence
  )) {
    const evaluated = evaluateCandidateSet(input, existing, [...selected, candidate], {
      stage: 'STAGE_A_AND_EXEC',
      ...state
    });
    if (!evaluated?.economics.passes || evaluated.reclaimedTokens <= current.reclaimedTokens)
      continue;
    const doesNotMoveInvalidationEarlier =
      contextGcEarliestReplacementSequence(candidate.replacements) >= stageAEarliestSequence;
    if (
      !doesNotMoveInvalidationEarlier &&
      !contextGcMarginalCacheInvestmentPaysBack(
        {
          reclaimedTokens: current.reclaimedTokens,
          reclaimedCachedTokens: current.reclaimedCachedTokens,
          cacheRebuildPenaltyCostUnits: current.economics.cacheRebuildPenaltyCostUnits
        },
        {
          reclaimedTokens: evaluated.reclaimedTokens,
          reclaimedCachedTokens: evaluated.reclaimedCachedTokens,
          cacheRebuildPenaltyCostUnits: evaluated.economics.cacheRebuildPenaltyCostUnits
        }
      )
    )
      continue;
    selected = [...selected, candidate];
    current = evaluated;
  }
  return current === stageAPlan ? undefined : current;
}

export function contextGcMarginalCacheInvestmentPaysBack(
  current: ContextGcCacheEconomicsProfile,
  combined: ContextGcCacheEconomicsProfile
): boolean {
  const marginalPenalty =
    combined.cacheRebuildPenaltyCostUnits - current.cacheRebuildPenaltyCostUnits;
  if (marginalPenalty <= 0) return true;
  const firstRolloutSavings = (profile: ContextGcCacheEconomicsProfile) => {
    const reclaimedCachedTokens = clamp(
      profile.reclaimedCachedTokens,
      0,
      Math.max(0, profile.reclaimedTokens)
    );
    return (
      reclaimedCachedTokens * CONTEXT_GC_POLICY.cacheReadCostRate +
      Math.max(0, profile.reclaimedTokens - reclaimedCachedTokens) *
        CONTEXT_GC_POLICY.normalInputCostRate
    );
  };
  const marginalFirstRolloutSavings = firstRolloutSavings(combined) - firstRolloutSavings(current);
  const marginalSteadyRolloutSavings =
    Math.max(0, combined.reclaimedTokens - current.reclaimedTokens) *
    CONTEXT_GC_POLICY.cacheReadCostRate;
  for (let rollouts = 1; rollouts <= CONTEXT_GC_POLICY.immediatePaybackRollouts; rollouts++) {
    const net =
      -marginalPenalty +
      marginalFirstRolloutSavings +
      Math.max(0, rollouts - 1) * marginalSteadyRolloutSavings;
    if (net > 0 && net / marginalPenalty >= CONTEXT_GC_POLICY.minimumCacheInvestmentRoi)
      return true;
  }
  return false;
}

export function contextGcEarliestReplacementSequence(
  replacements: readonly ContextGcReplacement[]
): number {
  return Math.min(
    ...replacements.flatMap((replacement) => [
      replacement.target.sequence,
      ...(replacement.kind === 'TOOL_CALL_INPUT'
        ? replacement.providerAliasTargets.map((target) => target.sequence)
        : [])
    ])
  );
}

function finalizePlan(
  input: ContextGcPlannerInput,
  evaluated: ReturnType<typeof evaluateCandidateSet> & {}
): ContextGcPlan | undefined {
  if (!evaluated) return undefined;
  const base = contextGcBaseFromRecords(input.records, evaluated.boundarySequence);
  if (!base) return undefined;
  const replacements = normalizeContextGcReplacements(evaluated.replacements);
  if (!replacements || replacements.length === 0) return undefined;
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
    requiredPositiveNetRollouts: evaluated.economics.requiredPositiveNetRollouts,
    requiredTargetRoiRollouts: evaluated.economics.requiredTargetRoiRollouts,
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
    version: 1,
    base,
    boundarySequence: evaluated.boundarySequence,
    replacements,
    trigger: {
      usageSequence: evaluated.usageRecord.sequence,
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
    readonly stage: 'STAGE_A' | 'STAGE_A_AND_EXEC';
    readonly contextUsageTokens: number;
    readonly usageRatio: number;
    readonly usageRecord: SessionRecord;
    readonly normalRolloutOrdinal: number;
    readonly protectedCandidateTokens: number;
  }
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
  const reclaimedTokens = contextGcReclaimedTokens(input, input.messages, projected.messages);
  const minimumGrossReductionRate = contextGcMinimumGrossReductionRate(state.usageRatio);
  const minimumReclaimedTokens = contextGcMinimumReclaimedTokens(
    state.contextUsageTokens,
    input.contextWindowTokens
  );
  if (reclaimedTokens < minimumReclaimedTokens) return undefined;
  const beforeTokens = contextGcPrefixTokens(input) + contextGcMessageTokens(input, input.messages);
  const afterTokens =
    contextGcPrefixTokens(input) + contextGcMessageTokens(input, projected.messages);
  if (reclaimedTokens === 0) return undefined;
  const cache = contextGcCacheImpact(
    input,
    input.messages,
    projected.messages,
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
  if (projectedTokensAfterGc >= compactThresholdTokens) return undefined;
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

function collectStageACandidates(
  input: ContextGcPlannerInput,
  groups: ReadonlyMap<string, ToolGroup>,
  existingReplacements: readonly ContextGcReplacement[],
  existingTargets: ReadonlySet<string>,
  candidateSavings: CandidateSavings
): { eligible: ContextCandidate[]; protectedTokens: number; retryAfterRollouts: number } {
  const eligible: ContextCandidate[] = [];
  let protectedTokens = 0;
  let retryAfterRollouts = Infinity;
  const existingReadReplacements = new Map(
    existingReplacements.flatMap((replacement) =>
      replacement.kind === 'READ_OUTPUT_ITEMS'
        ? [[contextGcTargetKey(replacement.target), replacement] as const]
        : []
    )
  );
  const reads = [...groups.values()].filter(
    (group) =>
      group.toolName === 'read' &&
      group.call?.message.role === 'tool_call' &&
      group.result?.message.role === 'tool'
  );
  const claimedReadItems = new Set(
    [...existingReadReplacements.values()].flatMap((replacement) =>
      replacement.items.map(
        (item) =>
          `${replacement.target.recordId}:${replacement.target.observationId ?? ''}:${item.index}`
      )
    )
  );
  const patches = [...groups.values()]
    .flatMap((patch) => {
      if (patch.toolName !== 'apply_patch' || !patch.call || !patch.result) return [];
      const terminal = patch.failed ?? patch.completed;
      if (!terminal) return [];
      const result = patch.failed
        ? contextGcPatchResultFromFailedPayload(terminal.payload)
        : contextGcPatchResultFromCompletedPayload(terminal.payload);
      return result
        ? [{ patch, result, terminal, evidenceSequence: patch.result.record.sequence }]
        : [];
    })
    .sort((left, right) => left.evidenceSequence - right.evidenceSequence);
  for (const { patch, result, terminal, evidenceSequence } of patches) {
    const patchCall = patch.call!;
    const observedRollouts = successfulRolloutsAfter(
      input.records,
      evidenceSequence,
      input.modelId,
      input.contextWindowTokens
    );
    const replacements: ContextGcReplacement[] = [];
    const candidateReadItems = new Set<string>();
    const patchTarget = targetFor(patchCall.record, patchCall.message);
    if (!patch.failed && patchTarget && !existingTargets.has(contextGcTargetKey(patchTarget)))
      replacements.push({
        kind: 'TOOL_CALL_INPUT',
        toolName: 'apply_patch',
        callId: patch.callId,
        target: patchTarget,
        replacementArguments: contextGcApplyPatchInputReplacement(
          patchCall.message.arguments,
          result
        ),
        providerAliasTargets: patch.aliases
          .map(({ record, message }) => targetFor(record, message))
          .filter((target): target is ContextGcTarget => target !== undefined),
        evidenceSequence
      });
    for (const read of reads) {
      if ((read.completed?.sequence ?? read.result!.record.sequence) >= terminal.sequence) continue;
      const parsed = parseReadContextOutput(read.result!.message.content);
      if (!parsed) continue;
      const selected = parsed.items.flatMap((item) => {
        if (item.pathTruncated) return [];
        const itemKey = `${read.result!.record.recordId}:${read.result!.message.observationId ?? ''}:${item.index}`;
        if (claimedReadItems.has(itemKey) || candidateReadItems.has(itemKey)) return [];
        const pathKey = contextGcLogicalPathKey(item.path, input.workspace, input.platform);
        const matched = result.files.find(
          (file) =>
            file.operation !== 'added' &&
            contextGcLogicalPathKey(file.path, input.workspace, input.platform) === pathKey
        );
        if (!pathKey || !matched || matched.operation === 'added') return [];
        candidateReadItems.add(itemKey);
        return [
          {
            index: item.index,
            path: item.path,
            replacement: contextGcStaleReadReplacement({
              path: item.path,
              content: item.content,
              operation: matched.operation
            }),
            evidenceSequence,
            ...(read.result!.message.observationId ? { supersededByCallId: patch.callId } : {})
          }
        ];
      });
      if (selected.length === 0) continue;
      const target = targetFor(read.result!.record, read.result!.message);
      if (!target) continue;
      const existingRead = existingReadReplacements.get(contextGcTargetKey(target));
      replacements.push({
        kind: 'READ_OUTPUT_ITEMS',
        callId: read.callId,
        target,
        items: [...(existingRead?.items ?? []), ...selected],
        evidenceSequences: [
          ...new Set([...(existingRead?.evidenceSequences ?? []), evidenceSequence])
        ]
      });
    }
    if (replacements.length === 0) continue;
    const candidate: ContextCandidate = {
      replacements,
      observedRollouts,
      evidenceSequence
    };
    const reclaimedTokens = candidateSavings(candidate);
    if (reclaimedTokens <= 0) continue;
    for (const itemKey of candidateReadItems) claimedReadItems.add(itemKey);
    if (observedRollouts >= CONTEXT_GC_POLICY.stageAProtectionRollouts) eligible.push(candidate);
    else {
      protectedTokens += reclaimedTokens;
      retryAfterRollouts = Math.min(
        retryAfterRollouts,
        CONTEXT_GC_POLICY.stageAProtectionRollouts - observedRollouts
      );
    }
  }
  return { eligible, protectedTokens, retryAfterRollouts };
}

function collectSubagentCandidates(
  input: ContextGcPlannerInput,
  groups: ReadonlyMap<string, ToolGroup>,
  existingTargets: ReadonlySet<string>,
  candidateSavings: CandidateSavings
): { eligible: ContextCandidate[]; protectedTokens: number; retryAfterRollouts: number } {
  const eligible: ContextCandidate[] = [];
  let protectedTokens = 0;
  let retryAfterRollouts = Infinity;
  const invocations = [...groups.values()]
    .flatMap((group) => {
      if (
        !isContextGcSubagentToolName(group.toolName) ||
        !group.call ||
        !group.result ||
        group.failed ||
        !group.completed ||
        group.call.message.role !== 'tool_call' ||
        group.result.message.role !== 'tool'
      )
        return [];
      const snapshot = normalizeContextGcSubagentSnapshot(
        group.result.message.content,
        group.completed.payload,
        group.toolName
      );
      const turnId = snapshot && contextGcSubagentSnapshotTurnId(snapshot);
      return snapshot && turnId ? [{ group, snapshot, turnId }] : [];
    })
    .sort(
      (left, right) => left.group.completed!.sequence - right.group.completed!.sequence
    ) satisfies SubagentInvocation[];
  for (const [index, source] of invocations.entries()) {
    if (source.group.evidenceOnly) continue;
    if (
      source.group.toolName !== 'agent_wait' &&
      source.group.toolName !== 'agent_message' &&
      source.group.toolName !== 'agent_cancel'
    )
      continue;
    const sourceTarget = targetFor(source.group.result!.record, source.group.result!.message);
    if (!sourceTarget || existingTargets.has(contextGcTargetKey(sourceTarget))) continue;
    const needsRetainedPriorFinal = contextGcSubagentNeedsRetainedPriorFinal(source.snapshot);
    const retainedPriorFinal = needsRetainedPriorFinal
      ? invocations
          .slice(0, index)
          .findLast((candidate) =>
            contextGcSubagentPriorFinalIsRetained(source.snapshot, candidate.snapshot)
          )
      : undefined;
    if (needsRetainedPriorFinal && retainedPriorFinal === undefined) continue;
    const terminal = invocations
      .slice(index + 1)
      .find(
        (candidate) =>
          candidate.snapshot.agentId === source.snapshot.agentId &&
          candidate.turnId === source.turnId &&
          (contextGcSubagentSnapshotIsSuperseded(
            source.snapshot,
            candidate.snapshot,
            retainedPriorFinal?.snapshot
          ) ||
            contextGcSubagentSnapshotIsPreciselyCovered(source.snapshot, candidate.snapshot))
      );
    if (!terminal) continue;
    const sourceContent = source.group.result!.message.content;
    if (typeof sourceContent !== 'string') continue;
    const evidenceSequence = terminal.group.result!.record.sequence;
    const observedRollouts = successfulRolloutsAfter(
      input.records,
      evidenceSequence,
      input.modelId,
      input.contextWindowTokens
    );
    const replacement: ContextGcReplacement = {
      kind: 'SUBAGENT_OUTPUT',
      toolName: source.group.toolName,
      callId: source.group.callId,
      target: sourceTarget,
      replacementContent: contextGcSubagentOutputReplacement({
        sourceContent,
        source: source.snapshot,
        terminal: terminal.snapshot
      }),
      terminalToolName: terminal.group.toolName as ContextGcSubagentToolName,
      terminalCallId: terminal.group.callId,
      evidenceSequence,
      ...(retainedPriorFinal === undefined
        ? {}
        : {
            retainedPriorFinal: {
              toolName: retainedPriorFinal.group.toolName as ContextGcSubagentToolName,
              callId: retainedPriorFinal.group.callId,
              evidenceSequence: retainedPriorFinal.group.result!.record.sequence
            }
          })
    };
    const candidate: ContextCandidate = {
      replacements: [replacement],
      observedRollouts,
      evidenceSequence
    };
    const reclaimedTokens = candidateSavings(candidate);
    if (reclaimedTokens <= 0) continue;
    if (observedRollouts >= CONTEXT_GC_POLICY.stageAProtectionRollouts) eligible.push(candidate);
    else {
      protectedTokens += reclaimedTokens;
      retryAfterRollouts = Math.min(
        retryAfterRollouts,
        CONTEXT_GC_POLICY.stageAProtectionRollouts - observedRollouts
      );
    }
  }
  return { eligible, protectedTokens, retryAfterRollouts };
}

function collectExecCandidates(
  input: ContextGcPlannerInput,
  groups: ReadonlyMap<string, ToolGroup>,
  existingTargets: ReadonlySet<string>,
  candidateSavings: CandidateSavings
): { eligible: ContextCandidate[]; protectedTokens: number; retryAfterRollouts: number } {
  const eligible: ContextCandidate[] = [];
  let protectedTokens = 0;
  let retryAfterRollouts = Infinity;
  const execGroups = [...groups.values()]
    .filter((group) => group.toolName === 'exec' || group.toolName === 'exec_wait')
    .sort(
      (left, right) =>
        (left.call?.record.sequence ?? Number.MAX_SAFE_INTEGER) -
        (right.call?.record.sequence ?? Number.MAX_SAFE_INTEGER)
    );
  const invocations = new Map<string, ExecInvocation>();
  for (const group of execGroups) {
    if (
      !group.call ||
      !group.result ||
      group.failed ||
      !group.completed ||
      group.call.message.role !== 'tool_call' ||
      group.result.message.role !== 'tool' ||
      !isRecord(group.call.message.arguments)
    )
      continue;
    const result = normalizeContextGcExecResult(
      group.result.message.content,
      group.completed.payload
    );
    if (result)
      invocations.set(group.callId, {
        group,
        input: group.call.message.arguments,
        result
      });
  }
  for (const startGroup of execGroups) {
    const start = invocations.get(startGroup.callId);
    if (!start) continue;
    const isStart =
      start.group.toolName === 'exec' &&
      (start.input.action === 'start' ||
        (start.input.action == null && typeof start.input.command === 'string'));
    const processId =
      typeof start.input.processId === 'string'
        ? start.input.processId
        : typeof start.result.processId === 'string'
          ? start.result.processId
          : undefined;
    if (!isStart) {
      if (start.group.toolName !== 'exec_wait' || !processId) continue;
      // A process may start inside a cell or before the visible history boundary.
      // Begin with its first visible wait, but never split an unfinished lifecycle.
      const previous = execGroups.findLast(
        (group) =>
          (group.call?.record.sequence ?? Infinity) < start.group.call!.record.sequence &&
          ((isRecord(group.call?.message.arguments) &&
            group.call.message.arguments.processId === processId) ||
            invocations.get(group.callId)?.result.processId === processId)
      );
      const previousStatus = previous && invocations.get(previous.callId)?.result.status;
      if (previous && previousStatus !== 'completed' && previousStatus !== 'cancelled') continue;
    }
    const lifecycle: ExecInvocation[] = [start];
    let terminal = start.result.status !== 'running';
    if (!terminal) {
      if (!processId) continue;
      const relatedGroups = execGroups.filter(
        (group) =>
          (group.call?.record.sequence ?? 0) > start.group.call!.record.sequence &&
          isRecord(group.call?.message.arguments) &&
          group.call.message.arguments.processId === processId
      );
      if (
        relatedGroups.some((group) => !invocations.has(group.callId)) ||
        relatedGroups.length === 0
      )
        continue;
      for (const relatedGroup of relatedGroups) {
        const invocation = invocations.get(relatedGroup.callId)!;
        lifecycle.push(invocation);
        if (invocation.result.status !== 'running') {
          terminal = true;
          break;
        }
      }
    }
    if (!terminal || (processId && input.activeProcessIds.has(processId))) continue;
    const final = lifecycle.at(-1)!;
    const evidenceSequence = final.group.result!.record.sequence;
    const observedRollouts = successfulRolloutsAfter(
      input.records,
      evidenceSequence,
      input.modelId,
      input.contextWindowTokens
    );
    const replacements: ContextGcReplacement[] = [];
    for (const invocation of lifecycle) {
      if (invocation.group.evidenceOnly) continue;
      const callTarget = targetFor(invocation.group.call!.record, invocation.group.call!.message);
      const resultTarget = targetFor(
        invocation.group.result!.record,
        invocation.group.result!.message
      );
      if (!resultTarget) {
        replacements.splice(0);
        break;
      }
      if (callTarget && !existingTargets.has(contextGcTargetKey(callTarget)))
        replacements.push({
          kind: 'TOOL_CALL_INPUT',
          toolName: invocation.group.toolName as 'exec' | 'exec_wait',
          callId: invocation.group.callId,
          target: callTarget,
          replacementArguments: contextGcExecInputReplacement(
            invocation.input,
            invocation.group.toolName
          ),
          providerAliasTargets: invocation.group.aliases
            .map(({ record, message }) => targetFor(record, message))
            .filter((target): target is ContextGcTarget => target !== undefined),
          evidenceSequence
        });
      if (!existingTargets.has(contextGcTargetKey(resultTarget)))
        replacements.push({
          kind: 'EXEC_OUTPUT',
          ...(resultTarget.observationId ? { terminalCallId: final.group.callId } : {}),
          callId: invocation.group.callId,
          target: resultTarget,
          replacementContent: contextGcExecOutputReplacement(invocation.result),
          evidenceSequence
        });
    }
    if (replacements.length === 0) continue;
    const candidate: ContextCandidate = {
      replacements,
      observedRollouts,
      evidenceSequence
    };
    const reclaimedTokens = candidateSavings(candidate);
    if (reclaimedTokens <= 0) continue;
    if (observedRollouts >= CONTEXT_GC_POLICY.largeExecProtectionRollouts) eligible.push(candidate);
    else {
      protectedTokens += reclaimedTokens;
      retryAfterRollouts = Math.min(
        retryAfterRollouts,
        CONTEXT_GC_POLICY.largeExecProtectionRollouts - observedRollouts
      );
    }
  }
  return { eligible, protectedTokens, retryAfterRollouts };
}

function collectWebCandidates(
  input: ContextGcPlannerInput,
  groups: ReadonlyMap<string, ToolGroup>,
  existingTargets: ReadonlySet<string>,
  candidateSavings: CandidateSavings
): { eligible: ContextCandidate[]; protectedTokens: number; retryAfterRollouts: number } {
  const eligible: ContextCandidate[] = [];
  let protectedTokens = 0;
  let retryAfterRollouts = Infinity;
  for (const group of [...groups.values()].sort(
    (left, right) =>
      (left.result?.record.sequence ?? Number.MAX_SAFE_INTEGER) -
      (right.result?.record.sequence ?? Number.MAX_SAFE_INTEGER)
  )) {
    if (
      !isContextGcWebToolName(group.toolName) ||
      !group.call ||
      !group.result ||
      group.failed ||
      !group.completed ||
      group.call.message.role !== 'tool_call' ||
      group.result.message.role !== 'tool' ||
      typeof group.result.message.content !== 'string' ||
      !isRecord(group.completed.payload) ||
      group.completed.payload.type !== 'tool.completed' ||
      group.completed.payload.callId !== group.callId ||
      group.completed.payload.toolName !== group.toolName ||
      typeof group.completed.payload.truncated !== 'boolean'
    )
      continue;
    const target = targetFor(group.result.record, group.result.message);
    if (!target || existingTargets.has(contextGcTargetKey(target))) continue;
    const evidenceSequence = group.result.record.sequence;
    const observedRollouts = successfulRolloutsAfter(
      input.records,
      evidenceSequence,
      input.modelId,
      input.contextWindowTokens
    );
    const candidate: ContextCandidate = {
      replacements: [
        {
          kind: 'WEB_OUTPUT',
          toolName: group.toolName,
          callId: group.callId,
          target,
          replacementContent: contextGcWebOutputReplacement(
            group.toolName,
            group.result.message.content,
            group.completed.payload.truncated
          ),
          evidenceSequence
        }
      ],
      observedRollouts,
      evidenceSequence
    };
    const reclaimedTokens = candidateSavings(candidate);
    if (reclaimedTokens <= 0) continue;
    if (observedRollouts >= CONTEXT_GC_POLICY.largeExecProtectionRollouts) eligible.push(candidate);
    else {
      protectedTokens += reclaimedTokens;
      retryAfterRollouts = Math.min(
        retryAfterRollouts,
        CONTEXT_GC_POLICY.largeExecProtectionRollouts - observedRollouts
      );
    }
  }
  return { eligible, protectedTokens, retryAfterRollouts };
}

function isContextGcSubagentToolName(value: string): value is ContextGcSubagentToolName {
  return (
    value === 'agent_start' ||
    value === 'agent_wait' ||
    value === 'agent_message' ||
    value === 'agent_cancel'
  );
}

function isContextGcWebToolName(value: string): value is ContextGcWebToolName {
  return value === 'web_search' || value === 'web_fetch';
}

function buildToolGroups(
  records: readonly SessionRecord[],
  messages: readonly ModelMessage[],
  sources: readonly SessionRecord[]
): Map<string, ToolGroup> {
  const groups = new Map<string, ToolGroup>();
  const group = (callId: string, toolName = '') => {
    const current = groups.get(callId);
    if (current) {
      if (!current.toolName && toolName) current.toolName = toolName;
      return current;
    }
    const created: ToolGroup = { callId, toolName, aliases: [] };
    groups.set(callId, created);
    return created;
  };
  for (const [index, message] of messages.entries()) {
    const record = sources[index]!;
    if (message.role === 'tool_call' && message.callId && message.name)
      group(message.callId, message.name).call = { message, record };
    else if (message.role === 'tool' && message.callId)
      group(message.callId).result = { message, record };
    else if (message.role === 'provider') {
      const callId = providerToolCallId(message);
      if (callId) group(callId, providerToolName(message)).aliases.push({ message, record });
    }
  }
  for (const record of records) {
    if (!isRecord(record.payload)) continue;
    const type = record.payload.type;
    const callId = record.payload.callId;
    const toolName = record.payload.toolName;
    if (typeof callId !== 'string' || typeof toolName !== 'string') continue;
    const current = group(callId, toolName);
    if (type === 'tool.completed') current.completed = record;
    else if (type === 'tool.failed') current.failed = record;
  }
  for (const [index, message] of messages.entries()) {
    if (!message.observations || message.role !== 'tool') continue;
    const record = sources[index]!;
    for (const entry of message.calls ?? []) {
      if (
        ![
          'apply_patch',
          'exec',
          'exec_wait',
          'agent_start',
          'agent_wait',
          'agent_message',
          'agent_cancel'
        ].includes(entry.toolName) ||
        (entry.status === 'completed' &&
          message.observations.some(
            (value) => value.type === 'tool_result' && value.source.callId === entry.callId
          ))
      )
        continue;
      const evidence =
        codeCallEvidence(records, record, entry) ??
        codePartialPatchCallEvidence(records, record, entry);
      if (!evidence) continue;
      groups.set(`execution:${evidence.callId}`, {
        evidenceOnly: true,
        callId: evidence.callId,
        toolName: entry.toolName,
        aliases: [],
        ...('completed' in evidence
          ? { completed: evidence.completed }
          : { failed: evidence.failed }),
        call: {
          record: evidence.call,
          message: {
            role: 'tool_call',
            callId: evidence.callId,
            name: entry.toolName,
            content: '',
            arguments: entry.input
          }
        },
        result: {
          record,
          message: {
            role: 'tool',
            callId: message.callId!,
            content: (evidence.result.payload as { content: string }).content
          }
        }
      });
    }
    for (const observation of message.observations) {
      if (observation.type !== 'tool_result') continue;
      const evidence = codeObservationEvidence(records, record, observation);
      if (!evidence) continue;
      groups.set(`${evidence.callId}:${observation.id}`, {
        callId: evidence.callId,
        toolName: observation.source.toolName,
        aliases: [],
        completed: evidence.completed,
        call: {
          record: evidence.call,
          message: {
            role: 'tool_call',
            callId: evidence.callId,
            name: observation.source.toolName,
            content: '',
            arguments: observation.source.input
          }
        },
        result: {
          record,
          message: {
            role: 'tool',
            callId: message.callId!,
            content: observation.result.content,
            observationId: observation.id
          }
        }
      });
    }
  }
  return groups;
}

function successfulRolloutsAfter(
  records: readonly SessionRecord[],
  evidenceSequence: number,
  modelId: string,
  contextWindowTokens: number
): number {
  return countSuccessfulNormalRollouts(
    records.filter((record) => record.sequence > evidenceSequence),
    modelId,
    contextWindowTokens,
    modelConfigurationAt(records, evidenceSequence, modelId, contextWindowTokens)
  );
}

function countSuccessfulNormalRollouts(
  records: readonly SessionRecord[],
  modelId: string,
  contextWindowTokens: number,
  initial: { modelId: string; contextWindowTokens: number } = {
    modelId,
    contextWindowTokens
  }
): number {
  let activeModelId = initial.modelId;
  let activeContextWindowTokens = initial.contextWindowTokens;
  let count = 0;
  for (const record of records) {
    if (record.type === 'execution.header' && isRecord(record.payload)) {
      activeModelId =
        typeof record.payload.modelId === 'string' ? record.payload.modelId : activeModelId;
      activeContextWindowTokens =
        typeof record.payload.contextWindowTokens === 'number' &&
        Number.isSafeInteger(record.payload.contextWindowTokens) &&
        record.payload.contextWindowTokens > 0
          ? record.payload.contextWindowTokens
          : activeContextWindowTokens;
      continue;
    }
    if (
      activeModelId === modelId &&
      activeContextWindowTokens === contextWindowTokens &&
      record.type === 'model.attempt' &&
      isRecord(record.payload) &&
      record.payload.purpose === 'EXECUTION' &&
      record.payload.state === 'SUCCEEDED'
    )
      count++;
  }
  return count;
}

function modelConfigurationAt(
  records: readonly SessionRecord[],
  boundarySequence: number,
  fallbackModelId: string,
  fallbackContextWindowTokens: number
): { modelId: string; contextWindowTokens: number } {
  let modelId = fallbackModelId;
  let contextWindowTokens = fallbackContextWindowTokens;
  for (const record of records) {
    if (record.sequence > boundarySequence) break;
    if (record.type !== 'execution.header' || !isRecord(record.payload)) continue;
    if (typeof record.payload.modelId === 'string') modelId = record.payload.modelId;
    if (
      typeof record.payload.contextWindowTokens === 'number' &&
      Number.isSafeInteger(record.payload.contextWindowTokens) &&
      record.payload.contextWindowTokens > 0
    )
      contextWindowTokens = record.payload.contextWindowTokens;
  }
  return { modelId, contextWindowTokens };
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

function targetFor(record: SessionRecord, message: ModelMessage): ContextGcTarget | undefined {
  if (
    record.type !== 'model.context' ||
    (message.role !== 'tool_call' && message.role !== 'tool' && message.role !== 'provider')
  )
    return undefined;
  const callId = message.role === 'provider' ? providerToolCallId(message) : message.callId;
  const toolName = message.role === 'provider' ? providerToolName(message) : message.name;
  return {
    sequence: record.sequence,
    recordId: record.recordId,
    role: message.role,
    ...(callId === undefined ? {} : { callId }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(message.observationId ? { observationId: message.observationId } : {})
  };
}

function modelContextUsage(value: ModelUsage | Record<string, unknown>): number | undefined {
  const context = value.contextInputTokens ?? value.inputTokens;
  return typeof context === 'number' && Number.isSafeInteger(context) && context >= 0
    ? context
    : undefined;
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

function firstMatchingRollout(limit: number, predicate: (rollouts: number) => boolean): number {
  for (let rollouts = 0; rollouts <= limit; rollouts++) if (predicate(rollouts)) return rollouts;
  return Number.POSITIVE_INFINITY;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
