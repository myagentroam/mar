import {
  contextGcTargetKey,
  type ContextGcReplacement,
  type ContextGcTarget
} from '../../session/context-gc-checkpoint.js';

import {
  contextGcExecInputReplacement,
  contextGcExecOutputReplacement,
  normalizeContextGcExecResult,
  type ContextGcExecResult
} from '../../session/context-gc-replacements.js';

import { CONTEXT_GC_POLICY } from './gc-economics.js';
import { contextGcProtectionMature } from '../../session/context-gc-protection.js';

import {
  type ContextGcPlannerInput,
  type ContextCandidate,
  type CandidateSavings,
  type ToolGroup
} from './gc-contracts.js';

import { targetFor, isRecord } from './gc-candidates.js';
import { terminalExecLifecycles } from '../../session/context-gc-exec-lifecycle.js';

interface ExecInvocation {
  readonly group: ToolGroup;
  readonly input: Record<string, unknown>;
  readonly result: ContextGcExecResult;
}

export function collectExecCandidates(
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
  const facts = execGroups.map((group) => ({
    value: group,
    callId: group.callId,
    toolName: group.toolName,
    sequence: group.call?.record.sequence ?? Number.MAX_SAFE_INTEGER,
    ...(isRecord(group.call?.message.arguments) ? { input: group.call.message.arguments } : {}),
    ...(invocations.get(group.callId) ? { result: invocations.get(group.callId)!.result } : {})
  }));
  for (const selected of terminalExecLifecycles(facts, input.activeProcessIds)) {
    const lifecycle = selected.map((fact) => invocations.get(fact.callId)!);
    const final = lifecycle.at(-1)!;
    const evidenceSequence = final.group.result!.record.sequence;
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
    const mature: ContextGcReplacement[] = [];
    const awaitingRollouts: ContextGcReplacement[] = [];
    let observedRollouts = Infinity;
    for (const replacement of replacements) {
      const protection = input.protection!.after(
        Math.max(evidenceSequence, replacement.target.sequence)
      );
      if (contextGcProtectionMature(protection)) {
        mature.push(replacement);
        observedRollouts = Math.min(observedRollouts, protection.rollouts);
      } else if (protection.rollouts < CONTEXT_GC_POLICY.largeExecProtectionRollouts) {
        awaitingRollouts.push(replacement);
        retryAfterRollouts = Math.min(
          retryAfterRollouts,
          CONTEXT_GC_POLICY.largeExecProtectionRollouts - protection.rollouts
        );
      }
    }
    if (awaitingRollouts.length)
      protectedTokens += Math.max(
        0,
        candidateSavings({ replacements: awaitingRollouts, observedRollouts: 0, evidenceSequence })
      );
    if (!mature.length) continue;
    const candidate: ContextCandidate = {
      replacements: mature,
      observedRollouts,
      evidenceSequence
    };
    const reclaimedTokens = candidateSavings(candidate);
    if (reclaimedTokens <= 0) continue;
    eligible.push(candidate);
  }
  return { eligible, protectedTokens, retryAfterRollouts };
}
