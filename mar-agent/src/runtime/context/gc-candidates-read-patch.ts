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
  contextGcStaleReadReplacement
} from '../../session/context-gc-replacements.js';

import { parseReadContextOutput } from '../../prompts/read-context.js';

import { CONTEXT_GC_POLICY } from './gc-economics.js';

import {
  type ContextGcPlannerInput,
  type ContextCandidate,
  type CandidateSavings,
  type ToolGroup
} from './gc-contracts.js';

import { successfulRolloutsAfter, targetFor } from './gc-candidates.js';

export function collectStageACandidates(
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
