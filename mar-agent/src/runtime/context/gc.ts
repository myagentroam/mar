import type { SessionModelMessage as ModelMessage } from '../../session/model-request.js';

import {
  ContextGcCheckpointCache,
  contextGcBaseFromRecords,
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
  contextGcMessageTokens,
  contextGcPrefixTokens,
  contextGcReclaimedTokens
} from './gc-tokens.js';

import { applyContextGcReplacementsToMessages, providerToolCallId } from './projection.js';

import {
  contextGcMinimumReclaimedTokens,
  contextGcEligibleUsage,
  modelContextUsage
} from './gc-admission.js';

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

export { contextGcMinimumReclaimedTokens, contextGcEligibleUsage } from './gc-admission.js';

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
    usageRecord,
    normalRolloutOrdinal: countSuccessfulNormalRollouts(
      input.records,
      input.modelId,
      input.contextWindowTokens
    ),
    protectedCandidateTokens: text.plan?.metrics.protectedCandidateTokens ?? 0
  };
  if (text.plan) {
    const { project: _project, ...inlineMedia } = media;
    return { ...text, plan: { ...text.plan, draft: { ...text.plan.draft, inlineMedia } } };
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
  return plan ? { ...text, plan } : text;
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
  const usageRecord = latestUsageRecord(input.records, input.modelId);
  if (!usageRecord) return {};
  const normalRolloutOrdinal = countSuccessfulNormalRollouts(
    input.records,
    input.modelId,
    input.contextWindowTokens
  );
  const previous = input.checkpointCache!.read(input.records);
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
  const eligible = [
    ...deterministic.eligible,
    ...exec.eligible,
    ...codeMode.eligible,
    ...web.eligible,
    ...tools.eligible
  ];
  const combined = evaluateCandidateSet(input, existing, eligible, {
    stage: 'UNIFIED',
    contextUsageTokens,
    usageRecord,
    normalRolloutOrdinal,
    protectedCandidateTokens
  });
  const retryAfterRollouts = Math.min(
    deterministic.retryAfterRollouts,
    exec.retryAfterRollouts,
    codeMode.retryAfterRollouts,
    web.retryAfterRollouts,
    tools.retryAfterRollouts
  );
  if (combined) {
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
  // An already mature but sub-threshold batch can combine with newly mature
  // candidates on the next rollout; no-candidate backoff must not delay it.
  if (eligible.length > 0) return { retryAfterRollouts: 1 };
  return protectedCandidateTokens > 0 && Number.isFinite(retryAfterRollouts)
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
    ...(evaluated.mediaOnly
      ? {}
      : { minimumRequiredReclaimedTokens: evaluated.minimumReclaimedTokens }),
    minimumObservedRollouts: evaluated.minimumObservedRollouts,
    protectedCandidateTokens: evaluated.protectedCandidateTokens,
    eligibleCandidateCount: evaluated.eligibleCandidateCount,
    eligibleTargetCount: replacements.reduce(
      (count, replacement) =>
        count +
        1 +
        (replacement.kind === 'TOOL_CALL_INPUT' ? replacement.providerAliasTargets.length : 0),
      0
    )
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
  const baseline = applyContextGcReplacementsToMessages(
    input.messages,
    input.messageSources,
    existing
  );
  const baselineMessages = mediaProjection?.(baseline.messages) ?? baseline.messages;
  const reclaimedTokens = contextGcReclaimedTokens(input, baselineMessages, projectedMessages);
  const minimumReclaimedTokens = contextGcMinimumReclaimedTokens(input.contextWindowTokens);
  if (!state.mediaOnly && reclaimedTokens < minimumReclaimedTokens) return undefined;
  const beforeTokens =
    contextGcPrefixTokens(input) + contextGcMessageTokens(input, baselineMessages);
  const afterTokens =
    contextGcPrefixTokens(input) + contextGcMessageTokens(input, projectedMessages);
  if (!state.mediaOnly && reclaimedTokens === 0) return undefined;
  return {
    ...state,
    replacements,
    beforeTokens,
    afterTokens,
    reclaimedTokens,
    minimumReclaimedTokens,
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
    if (record.type === 'execution.header' || record.type === 'compact.completed') {
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
