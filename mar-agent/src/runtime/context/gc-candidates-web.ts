import { contextGcTargetKey } from '../../session/context-gc-checkpoint.js';

import {
  contextGcWebOutputReplacement,
  type ContextGcWebToolName
} from '../../session/context-gc-replacements.js';

import { CONTEXT_GC_POLICY } from './gc-economics.js';

import {
  type ContextGcPlannerInput,
  type ContextCandidate,
  type CandidateSavings,
  type ToolGroup
} from './gc-contracts.js';

import { successfulRolloutsAfter, targetFor, isRecord } from './gc-candidates.js';

export function collectWebCandidates(
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

function isContextGcWebToolName(value: string): value is ContextGcWebToolName {
  return value === 'web_search' || value === 'web_fetch';
}
