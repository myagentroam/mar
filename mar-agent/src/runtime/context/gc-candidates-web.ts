import { contextGcTargetKey } from '../../session/context-gc-checkpoint.js';
import {
  completedTodoWrite,
  todoInputReplacement,
  todoSnapshotReplacement,
  visibleTodoSnapshot
} from '../../session/context-gc-todo.js';

import {
  contextGcWebOutputReplacement,
  contextGcToolOutputReplacement,
  contextGcSkillOutputReplacement,
  hasGenericContextGcPreview,
  isGenericContextGcTool,
  type ContextGcWebToolName
} from '../../session/context-gc-replacements.js';

import {
  CONTEXT_GC_TEXT_PROTECTION_ROLLOUTS,
  contextGcProtectionMature
} from '../../session/context-gc-protection.js';

import {
  type ContextGcPlannerInput,
  type ContextCandidate,
  type CandidateSavings,
  type ToolGroup
} from './gc-contracts.js';

import { targetFor, isRecord } from './gc-candidates.js';

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
    const protection = input.protection!.after(Math.max(evidenceSequence, target.sequence));
    const observedRollouts = protection.rollouts;
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
    if (contextGcProtectionMature(protection)) eligible.push(candidate);
    else if (observedRollouts < CONTEXT_GC_TEXT_PROTECTION_ROLLOUTS) {
      protectedTokens += reclaimedTokens;
      retryAfterRollouts = Math.min(
        retryAfterRollouts,
        CONTEXT_GC_TEXT_PROTECTION_ROLLOUTS - observedRollouts
      );
    }
  }
  return { eligible, protectedTokens, retryAfterRollouts };
}

/** Generic successful tool results share output retention rules, without inferring resource state. */
export function collectToolOutputCandidates(
  input: ContextGcPlannerInput,
  groups: ReadonlyMap<string, ToolGroup>,
  existingTargets: ReadonlySet<string>,
  candidateSavings: CandidateSavings
): { eligible: ContextCandidate[]; protectedTokens: number; retryAfterRollouts: number } {
  const eligible: ContextCandidate[] = [];
  let protectedTokens = 0;
  let retryAfterRollouts = Infinity;
  const searches = [...groups.values()]
    .filter(
      (group) =>
        group.toolName === 'tool_search' &&
        !group.failed &&
        group.completed &&
        group.call &&
        group.result?.message.role === 'tool' &&
        group.result.message.toolSearchTools !== undefined
    )
    .sort((left, right) => left.result!.record.sequence - right.result!.record.sequence);
  for (const group of searches) {
    const result = group.result!;
    const target = targetFor(result.record, result.message);
    const definitions = result.message.toolSearchTools!;
    if (!target || definitions.length === 0) continue;
    const retainedToolNames: string[] = [];
    const evidence: number[] = [];
    for (const tool of definitions) {
      const successor = searches.findLast(
        (candidate) =>
          candidate.result!.record.sequence > result.record.sequence &&
          candidate.result!.message.toolSearchTools!.some((item) => item.name === tool.name) &&
          (() => {
            const count = input.protection!.after(
              Math.max(target.sequence, candidate.result!.record.sequence)
            );
            return contextGcProtectionMature(count);
          })()
      );
      if (successor) evidence.push(successor.result!.record.sequence);
      else retainedToolNames.push(tool.name);
    }
    if (evidence.length === 0) continue;
    const evidenceSequence = Math.max(...evidence);
    const observedRollouts = input.protection!.after(
      Math.max(target.sequence, evidenceSequence)
    ).rollouts;
    const candidate: ContextCandidate = {
      replacements: [
        {
          kind: 'TOOL_OUTPUT',
          toolName: 'tool_search',
          callId: group.callId,
          target,
          replacementContent: result.message.content,
          retainedToolNames,
          evidenceSequence
        }
      ],
      observedRollouts,
      evidenceSequence
    };
    if (candidateSavings(candidate) > 0) eligible.push(candidate);
  }
  const writes = input.records.flatMap((record) => {
    const fact = completedTodoWrite(record);
    return fact ? [{ record, ...fact }] : [];
  });
  for (const group of groups.values()) {
    if (group.failed || !group.completed || !group.call || group.call.message.role !== 'tool_call')
      continue;
    const ownWrite = completedTodoWrite(group.completed);
    const snapshot =
      group.toolName === 'todo_read' && group.result?.message.role === 'tool'
        ? visibleTodoSnapshot(group.result.message.content)
        : undefined;
    const currentRevision =
      group.toolName === 'todo_write' ? ownWrite?.revision : snapshot?.revision;
    if (currentRevision === undefined) continue;
    const targetEntry = group.toolName === 'todo_write' ? group.call : group.result;
    if (!targetEntry) continue;
    const target = targetFor(targetEntry.record, targetEntry.message);
    if (!target || existingTargets.has(contextGcTargetKey(target))) continue;
    const successor = writes
      .filter(
        (write) =>
          write.revision > currentRevision &&
          contextGcProtectionMature(
            input.protection!.after(
              Math.max(target.sequence, group.completed!.sequence, write.record.sequence)
            )
          )
      )
      .sort((a, b) => b.revision - a.revision)[0];
    if (!successor) continue;
    const evidenceSequence = successor.record.sequence;
    const observedRollouts = input.protection!.after(
      Math.max(target.sequence, group.completed.sequence, evidenceSequence)
    ).rollouts;
    let replacement: ContextCandidate['replacements'][number];
    if (group.toolName === 'todo_write') {
      const args = group.call.message.arguments;
      if (!isRecord(args) || !Array.isArray(args.items)) continue;
      replacement = {
        kind: 'TOOL_CALL_INPUT',
        toolName: 'todo_write',
        callId: group.callId,
        target,
        replacementArguments: todoInputReplacement(
          currentRevision,
          args.items.length,
          successor.revision
        ),
        providerAliasTargets: group.aliases
          .map(({ record, message }) => targetFor(record, message))
          .filter((value) => value !== undefined),
        evidenceSequence
      };
    } else {
      if (!snapshot) continue;
      replacement = {
        kind: 'TOOL_OUTPUT',
        toolName: 'todo_read',
        callId: group.callId,
        target,
        replacementContent: todoSnapshotReplacement(
          currentRevision,
          snapshot.count,
          successor.revision
        ),
        evidenceSequence
      };
    }
    const candidate = { replacements: [replacement], observedRollouts, evidenceSequence };
    if (candidateSavings(candidate) > 0) eligible.push(candidate);
  }
  const skills = [...groups.values()]
    .filter(
      (group) =>
        group.toolName === 'skill' &&
        group.call?.message.role === 'tool_call' &&
        isRecord(group.call.message.arguments) &&
        typeof group.call.message.arguments.name === 'string' &&
        group.result?.message.role === 'tool' &&
        group.completed &&
        !group.failed &&
        !group.evidenceOnly
    )
    .sort((left, right) => left.result!.record.sequence - right.result!.record.sequence);
  for (const [index, group] of skills.entries()) {
    const target = targetFor(group.result!.record, group.result!.message);
    if (!target || existingTargets.has(contextGcTargetKey(target))) continue;
    const args = group.call!.message.arguments as { name: string };
    const later = skills.slice(index + 1).filter((candidate) => {
      const laterTarget = targetFor(candidate.result!.record, candidate.result!.message);
      return (
        laterTarget &&
        (candidate.call!.message.arguments as { name: string }).name === args.name &&
        !existingTargets.has(contextGcTargetKey(laterTarget))
      );
    });
    const successor = later.findLast((candidate) => {
      const count = input.protection!.after(
        Math.max(target.sequence, candidate.result!.record.sequence)
      );
      return contextGcProtectionMature(count);
    });
    if (!successor) continue;
    const evidenceSequence = successor.result!.record.sequence;
    const observedRollouts = input.protection!.after(
      Math.max(target.sequence, evidenceSequence)
    ).rollouts;
    const candidate: ContextCandidate = {
      replacements: [
        {
          kind: 'TOOL_OUTPUT',
          toolName: 'skill',
          callId: group.callId,
          target,
          replacementContent: contextGcSkillOutputReplacement(
            args.name,
            group.result!.message.content,
            successor.callId
          ),
          evidenceSequence
        }
      ],
      observedRollouts,
      evidenceSequence
    };
    if (candidateSavings(candidate) > 0) eligible.push(candidate);
  }
  for (const group of groups.values()) {
    if (
      !isGenericContextGcTool(group.toolName) ||
      group.evidenceOnly ||
      !group.call ||
      !group.result ||
      group.failed ||
      !group.completed ||
      group.call.message.role !== 'tool_call' ||
      group.result.message.role !== 'tool' ||
      typeof group.result.message.content !== 'string' ||
      !hasGenericContextGcPreview(group.result.message.content) ||
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
    const protection = input.protection!.after(Math.max(evidenceSequence, target.sequence));
    const observedRollouts = protection.rollouts;
    const candidate: ContextCandidate = {
      replacements: [
        {
          kind: 'TOOL_OUTPUT',
          toolName: group.toolName,
          callId: group.callId,
          target,
          replacementContent: contextGcToolOutputReplacement(
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
    if (contextGcProtectionMature(protection)) eligible.push(candidate);
    else if (observedRollouts < CONTEXT_GC_TEXT_PROTECTION_ROLLOUTS) {
      protectedTokens += reclaimedTokens;
      retryAfterRollouts = Math.min(
        retryAfterRollouts,
        CONTEXT_GC_TEXT_PROTECTION_ROLLOUTS - observedRollouts
      );
    }
  }
  return { eligible, protectedTokens, retryAfterRollouts };
}

function isContextGcWebToolName(value: string): value is ContextGcWebToolName {
  return value === 'web_search' || value === 'web_fetch';
}
