import { retainedCodeInputs } from '../../session/context-gc-observations.js';

import {
  contextGcTargetKey,
  type ContextGcReplacement,
  type ContextGcTarget
} from '../../session/context-gc-checkpoint.js';

import {
  codeCellCompletionSequence,
  contextGcCodeModeInputReplacement,
  contextGcCodeModeOutputReplacement,
  normalizeContextGcCodeModeInput
} from '../../session/context-gc-replacements.js';

import { CONTEXT_GC_POLICY } from './gc-economics.js';

import {
  type ContextGcPlannerInput,
  type ContextCandidate,
  type CandidateSavings,
  type ToolGroup
} from './gc-contracts.js';

import { successfulRolloutsAfter, targetFor, isRecord } from './gc-candidates.js';

export function collectCodeModeCandidates(
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
