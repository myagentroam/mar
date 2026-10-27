import {
  contextGcTargetKey,
  type ContextGcReplacement
} from '../../session/context-gc-checkpoint.js';

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

import { CONTEXT_GC_POLICY } from './gc-economics.js';

import {
  type ContextGcPlannerInput,
  type ContextCandidate,
  type CandidateSavings,
  type ToolGroup
} from './gc-contracts.js';

import { successfulRolloutsAfter, targetFor } from './gc-candidates.js';

interface SubagentInvocation {
  readonly group: ToolGroup;
  readonly snapshot: ContextGcSubagentSnapshot;
  readonly turnId: string;
}

export function collectSubagentCandidates(
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

function isContextGcSubagentToolName(value: string): value is ContextGcSubagentToolName {
  return (
    value === 'agent_start' ||
    value === 'agent_wait' ||
    value === 'agent_message' ||
    value === 'agent_cancel'
  );
}
