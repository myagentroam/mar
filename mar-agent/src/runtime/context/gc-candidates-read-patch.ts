import {
  contextGcLogicalPathKey,
  contextGcTargetKey,
  type ContextGcReplacement,
  type ContextGcTarget
} from '../../session/context-gc-checkpoint.js';

import {
  contextGcApplyPatchInputReplacement,
  contextGcPatchResultFromCompletedPayload,
  contextGcPatchResultFromFailedPayload,
  contextGcStaleReadReplacement,
  contextGcReadRangeCovers,
  contextGcCoveredReadReplacement
} from '../../session/context-gc-replacements.js';

import { parseReadContextOutput } from '../../prompts/read-context.js';

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

import { targetFor } from './gc-candidates.js';

export function collectDeterministicCandidates(
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
  const reads = [...groups.values()]
    .filter(
      (group) =>
        group.toolName === 'read' &&
        group.call?.message.role === 'tool_call' &&
        group.result?.message.role === 'tool'
    )
    .sort((left, right) => left.result!.record.sequence - right.result!.record.sequence);
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
            supersededByCallId: patch.callId
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
      } else if (protection.rollouts < CONTEXT_GC_TEXT_PROTECTION_ROLLOUTS) {
        awaitingRollouts.push(replacement);
        retryAfterRollouts = Math.min(
          retryAfterRollouts,
          CONTEXT_GC_TEXT_PROTECTION_ROLLOUTS - protection.rollouts
        );
      }
    }
    if (awaitingRollouts.length) {
      protectedTokens += Math.max(
        0,
        candidateSavings({ replacements: awaitingRollouts, observedRollouts: 0, evidenceSequence })
      );
    }
    if (!mature.length) continue;
    const candidate: ContextCandidate = {
      replacements: mature,
      observedRollouts,
      evidenceSequence
    };
    const reclaimedTokens = candidateSavings(candidate);
    if (reclaimedTokens <= 0) continue;
    for (const replacement of mature) {
      if (replacement.kind !== 'READ_OUTPUT_ITEMS') continue;
      for (const item of replacement.items) {
        const key = `${replacement.target.recordId}:${replacement.target.observationId ?? ''}:${item.index}`;
        if (candidateReadItems.has(key)) claimedReadItems.add(key);
      }
    }
    eligible.push(candidate);
  }
  const visibleReads = reads.flatMap((group) => {
    if (group.evidenceOnly || group.failed || !group.completed) return [];
    const target = targetFor(group.result!.record, group.result!.message);
    const parsed = parseReadContextOutput(group.result!.message.content);
    return target && parsed ? [{ group, target, items: parsed.items }] : [];
  });
  for (const [index, old] of visibleReads.entries()) {
    for (const item of old.items) {
      const itemKey = `${old.target.recordId}:${old.target.observationId ?? ''}:${item.index}`;
      if (claimedReadItems.has(itemKey) || item.content.startsWith('<mar_context_gc ')) continue;
      const pathKey = contextGcLogicalPathKey(item.path, input.workspace, input.platform);
      if (!pathKey) continue;
      const later = visibleReads
        .slice(index + 1)
        .filter((entry) =>
          entry.items.some(
            (candidate) =>
              contextGcLogicalPathKey(candidate.path, input.workspace, input.platform) ===
                pathKey &&
              contextGcReadRangeCovers(item, candidate) &&
              !existingReadReplacements
                .get(contextGcTargetKey(entry.target))
                ?.items.some((prior) => prior.index === candidate.index)
          )
        );
      const successor = later.findLast((entry) => {
        const count = input.protection!.after(entry.target.sequence);
        return contextGcProtectionMature(count);
      });
      if (!successor) continue;
      const existingRead = existingReadReplacements.get(contextGcTargetKey(old.target));
      const evidenceSequence = successor.target.sequence;
      const replacement: ContextGcReplacement = {
        kind: 'READ_OUTPUT_ITEMS',
        callId: old.group.callId,
        target: old.target,
        items: [
          ...(existingRead?.items ?? []),
          {
            index: item.index,
            path: item.path,
            replacement: contextGcCoveredReadReplacement(item, successor.group.callId),
            evidenceSequence,
            supersededByCallId: successor.group.callId
          }
        ],
        evidenceSequences: [
          ...new Set([...(existingRead?.evidenceSequences ?? []), evidenceSequence])
        ]
      };
      const candidate: ContextCandidate = {
        replacements: [replacement],
        observedRollouts: input.protection!.after(evidenceSequence).rollouts,
        evidenceSequence
      };
      if (candidateSavings(candidate) > 0) {
        eligible.push(candidate);
        claimedReadItems.add(itemKey);
      }
    }
  }
  return { eligible, protectedTokens, retryAfterRollouts };
}
