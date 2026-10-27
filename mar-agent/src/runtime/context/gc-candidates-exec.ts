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

import {
  type ContextGcPlannerInput,
  type ContextCandidate,
  type CandidateSavings,
  type ToolGroup
} from './gc-contracts.js';

import { successfulRolloutsAfter, targetFor, isRecord } from './gc-candidates.js';

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
