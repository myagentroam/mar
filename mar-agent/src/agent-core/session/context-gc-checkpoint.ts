import { posix, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  inlineMediaGcAnchored,
  parseInlineMediaGc,
  type InlineMediaGcCheckpoint
} from './inline-media.js';
import {
  codeCallEvidence,
  codePartialPatchCallEvidence,
  callsFromRecord,
  codeObservationEvidence,
  observationsFromRecord,
  retainedCodeInputs
} from './context-gc-observations.js';
import { parseReadContextOutput } from '../tools/local/read-context.js';
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
  type ContextGcWebToolName
} from './context-gc-replacements.js';
import {
  contextGcSubagentNeedsRetainedPriorFinal,
  contextGcSubagentOutputReplacement,
  contextGcSubagentSnapshotIsPreciselyCovered,
  contextGcSubagentSnapshotIsSuperseded,
  normalizeContextGcSubagentSnapshot,
  type ContextGcSubagentSnapshot,
  type ContextGcSubagentToolName
} from './context-gc-subagent.js';
import type { SessionRecord } from './store/index.js';

export const CONTEXT_GC_CHECKPOINT_VERSION = 1 as const;
export const CONTEXT_GC_MAX_TARGETS = 4_096;
export type ContextGcPlatform = 'linux' | 'darwin' | 'win32';

export interface ContextGcEconomicsPolicy {
  readonly version: 1;
  readonly immediatePaybackRollouts: number;
  readonly maximumPaybackRollouts: number;
  readonly contextGrowthSampleWindow: number;
  readonly minimumContextGrowthSamples: number;
  readonly minimumObservationRollouts: number;
  readonly stageAProtectionRollouts: number;
  readonly largeExecProtectionRollouts: number;
  readonly normalInputCostRate: number;
  readonly cacheReadCostRate: number;
  readonly cacheWriteCostRate: number;
  readonly outputCostRate: number;
  readonly minimumGrossReductionRate: number;
  readonly minimumCacheInvestmentRoi: number;
}

export type ContextGcBase =
  | { readonly type: 'SESSION_START'; readonly firstSequence: number }
  | { readonly type: 'COMPACT'; readonly sequence: number; readonly recordId: string };

export interface ContextGcTarget {
  readonly observationId?: string;
  readonly sequence: number;
  readonly recordId: string;
  readonly role: 'tool_call' | 'tool' | 'provider';
  readonly callId?: string;
  readonly toolName?: string;
}

export interface ContextGcReadItemReplacement {
  readonly supersededByCallId?: string;
  readonly index: number;
  readonly path: string;
  readonly replacement: string;
  readonly evidenceSequence: number;
}

export type ContextGcReplacement =
  | {
      readonly kind: 'READ_OUTPUT_ITEMS';
      readonly callId: string;
      readonly target: ContextGcTarget;
      readonly items: readonly ContextGcReadItemReplacement[];
      readonly evidenceSequences: readonly number[];
    }
  | {
      readonly kind: 'TOOL_CALL_INPUT';
      readonly toolName: 'apply_patch' | 'exec' | 'exec_wait' | 'code_exec';
      readonly callId: string;
      readonly target: ContextGcTarget;
      readonly replacementArguments: unknown;
      readonly providerAliasTargets: readonly ContextGcTarget[];
      readonly evidenceSequence: number;
    }
  | {
      readonly kind: 'EXEC_OUTPUT';
      readonly terminalCallId?: string;
      readonly callId: string;
      readonly target: ContextGcTarget;
      readonly replacementContent: string;
      readonly evidenceSequence: number;
    }
  | {
      readonly kind: 'CODE_MODE_OUTPUT';
      readonly callId: string;
      readonly target: ContextGcTarget;
      readonly replacementContent: string;
      readonly evidenceSequence: number;
    }
  | {
      readonly kind: 'SUBAGENT_OUTPUT';
      readonly toolName: 'agent_wait' | 'agent_message' | 'agent_cancel';
      readonly callId: string;
      readonly target: ContextGcTarget;
      readonly replacementContent: string;
      readonly terminalToolName: ContextGcSubagentToolName;
      readonly terminalCallId: string;
      readonly evidenceSequence: number;
      readonly retainedPriorFinal?: {
        readonly toolName: ContextGcSubagentToolName;
        readonly callId: string;
        readonly evidenceSequence: number;
      };
    }
  | {
      readonly kind: 'WEB_OUTPUT';
      readonly toolName: ContextGcWebToolName;
      readonly callId: string;
      readonly target: ContextGcTarget;
      readonly replacementContent: string;
      readonly evidenceSequence: number;
    };

export interface ContextGcMetrics {
  readonly stage: 'STAGE_A' | 'STAGE_A_AND_EXEC' | 'INLINE_MEDIA';
  readonly tokenEstimator?: 'UTF8_BYTES_V1';
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly reclaimedTokens: number;
  readonly grossReductionRate: number;
  readonly effectiveMinimumGrossReductionRate?: number;
  readonly minimumRequiredReclaimedTokens?: number;
  readonly cacheRebuildPenaltyCostUnits: number;
  readonly compactDeferralCreditCostUnits: number;
  readonly imminentCompactAvoidanceCreditCostUnits?: number;
  readonly appliedCompactCreditCostUnits?: number;
  readonly requiredPositiveNetRollouts: number | null;
  readonly requiredTargetRoiRollouts: number | null;
  readonly projectedRolloutsUntilCompactAfterGc: number;
  readonly projectedTokensBeforeGc?: number;
  readonly projectedTokensAfterGc?: number;
  readonly contextGrowthSampleCount: number;
  readonly contextGrowthP75Tokens: number;
  readonly expectedNetSavedCostUnits: number;
  readonly cacheInvestmentRoi: number;
  readonly minimumObservedRollouts: number;
  readonly protectedCandidateTokens: number;
  readonly eligibleCandidateCount: number;
  readonly eligibleTargetCount: number;
  readonly cachePenaltyKnown?: boolean;
}

export interface ContextGcCheckpointDraft {
  readonly inlineMedia?: InlineMediaGcCheckpoint;
  readonly version: 1;
  readonly base: ContextGcBase;
  readonly boundarySequence: number;
  readonly replacements: readonly ContextGcReplacement[];
  readonly trigger: {
    readonly usageSequence: number | null;
    readonly contextInputTokens: number;
    readonly contextWindowTokens: number;
    readonly normalRolloutOrdinal: number;
    readonly modelId: string;
    readonly platform: ContextGcPlatform;
  };
  readonly economics: ContextGcEconomicsPolicy;
  readonly metrics: ContextGcMetrics;
}

export interface ContextGcCheckpointPayload extends ContextGcCheckpointDraft {
  readonly checkpointId: string;
  readonly generation: number;
}

/** Disposable memoization for one evaluation's immutable record snapshot. */
export class ContextGcCheckpointCache {
  #snapshot:
    | {
        records: readonly SessionRecord[];
        boundarySequence: number;
        value: ReturnType<typeof latestValidContextGcCheckpoint>;
      }
    | undefined;

  read(
    records: readonly SessionRecord[],
    boundarySequence = records.at(-1)?.sequence ?? 0
  ): ReturnType<typeof latestValidContextGcCheckpoint> {
    const cached = this.#snapshot;
    if (cached?.records === records && cached.boundarySequence === boundarySequence)
      return cached.value;
    const value = latestValidContextGcCheckpoint(records, boundarySequence);
    this.#snapshot = { records, boundarySequence, value };
    return value;
  }
}

export function contextGcMinimumUsageGrowth(contextWindowTokens: number): number {
  return Math.max(2_000, Math.floor(contextWindowTokens * 0.05));
}

/** Compare adjacent checkpoint triggers only within the same model/window scope. */
export function contextGcCheckpointIntervalEligible(
  trigger: ContextGcCheckpointDraft['trigger'],
  previous?: ContextGcCheckpointDraft['trigger']
): boolean {
  if (
    !previous ||
    trigger.modelId !== previous.modelId ||
    trigger.contextWindowTokens !== previous.contextWindowTokens
  )
    return true;
  return (
    trigger.normalRolloutOrdinal - previous.normalRolloutOrdinal >= 2 &&
    trigger.contextInputTokens - previous.contextInputTokens >=
      contextGcMinimumUsageGrowth(trigger.contextWindowTokens)
  );
}

export function contextGcLogicalPathKey(
  path: string,
  workspace: string,
  platform?: ContextGcPlatform
): string | undefined {
  if (!path || !workspace || path.includes('\0') || workspace.includes('\0')) return undefined;
  const windows =
    platform === 'win32' ||
    (platform === undefined &&
      (/^[a-zA-Z]:[\\/]/u.test(workspace) || /^[\\/]{2}/u.test(workspace)));
  if (windows) {
    const root = win32.resolve(workspace.replaceAll('/', '\\'));
    const resolved = win32.resolve(root, path.replaceAll('/', '\\'));
    const relative = win32.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${win32.sep}`) || win32.isAbsolute(relative))
      return undefined;
    return resolved.replaceAll('\\', '/').toLowerCase();
  }
  const root = posix.resolve(workspace);
  const resolved = posix.resolve(root, path);
  const relative = posix.relative(root, resolved);
  if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative))
    return undefined;
  return resolved;
}

export function contextGcTargetKey(target: ContextGcTarget): string {
  // Tool outputs are identified by their record/call and observation, not optional tool-name metadata.
  return `${target.sequence}:${target.recordId}:${target.role}:${target.callId ?? ''}:${
    target.role === 'tool' ? '' : (target.toolName ?? '')
  }${target.observationId ? `:${target.observationId}` : ''}`;
}

export function contextGcReplacementKey(replacement: ContextGcReplacement): string {
  return contextGcTargetKey(replacement.target);
}

export function contextGcBaseFromRecords(
  records: readonly SessionRecord[],
  boundarySequence = records.at(-1)?.sequence ?? 0
): ContextGcBase | undefined {
  const compact = records.findLast(
    (record) =>
      record.sequence <= boundarySequence &&
      record.type === 'compact.completed' &&
      isNonemptyString((record.payload as { summary?: unknown } | undefined)?.summary)
  );
  if (compact) return { type: 'COMPACT', sequence: compact.sequence, recordId: compact.recordId };
  const first = records.find(
    (record) => record.sequence <= boundarySequence && record.type === 'session.created'
  );
  return first ? { type: 'SESSION_START', firstSequence: first.sequence } : undefined;
}

export function contextGcBaseSequence(base: ContextGcBase): number {
  return base.type === 'COMPACT' ? base.sequence : base.firstSequence;
}

export function normalizeContextGcReplacements(
  replacements: readonly ContextGcReplacement[]
): ContextGcReplacement[] | undefined {
  const normalized = new Map<string, ContextGcReplacement>();
  const readItems = new Map<string, Map<number, ContextGcReadItemReplacement>>();
  for (const replacement of replacements) {
    if (!isContextGcReplacement(replacement)) return undefined;
    const value = structuredClone(replacement);
    const key = contextGcReplacementKey(value);
    if (value.kind === 'READ_OUTPUT_ITEMS') {
      const items =
        normalized.get(key)?.kind === 'READ_OUTPUT_ITEMS'
          ? readItems.get(key)!
          : new Map<number, ContextGcReadItemReplacement>();
      for (const item of value.items) items.set(item.index, item);
      readItems.set(key, items);
    }
    normalized.set(key, value);
  }
  const values = [...normalized].map(([key, value]): ContextGcReplacement => {
    if (value.kind !== 'READ_OUTPUT_ITEMS') return value;
    const items = [...readItems.get(key)!.values()];
    return {
      ...value,
      items,
      evidenceSequences: [...new Set(items.map((item) => item.evidenceSequence))]
    };
  });
  const targets = new Set(
    values.flatMap((replacement) => [
      contextGcTargetKey(replacement.target),
      ...(replacement.kind === 'TOOL_CALL_INPUT'
        ? replacement.providerAliasTargets.map(contextGcTargetKey)
        : [])
    ])
  );
  if (targets.size > CONTEXT_GC_MAX_TARGETS) return undefined;
  return values.sort(
    (left, right) =>
      left.target.sequence - right.target.sequence ||
      contextGcReplacementKey(left).localeCompare(contextGcReplacementKey(right))
  );
}

export function parseContextGcCheckpoint(
  record: SessionRecord | undefined
): ContextGcCheckpointPayload | undefined {
  if (record?.type !== 'context.gc.completed' || !isRecord(record.payload)) return undefined;
  const payload = record.payload;
  if (
    payload.version !== CONTEXT_GC_CHECKPOINT_VERSION ||
    !isNonemptyString(payload.checkpointId) ||
    !isPositiveInteger(payload.generation) ||
    !isContextGcBase(payload.base) ||
    !isPositiveInteger(payload.boundarySequence) ||
    !Array.isArray(payload.replacements) ||
    (payload.replacements.length === 0 && payload.inlineMedia === undefined) ||
    !isContextGcTrigger(payload.trigger) ||
    !isContextGcEconomicsPolicy(payload.economics) ||
    !isContextGcMetrics(payload.metrics) ||
    (payload.inlineMedia !== undefined && !parseInlineMediaGc(payload.inlineMedia))
  )
    return undefined;
  const replacements = normalizeContextGcReplacements(
    payload.replacements as ContextGcReplacement[]
  );
  if (!replacements || replacements.length !== payload.replacements.length) return undefined;
  return {
    version: 1,
    checkpointId: payload.checkpointId,
    generation: payload.generation,
    base: structuredClone(payload.base),
    boundarySequence: payload.boundarySequence,
    replacements,
    trigger: structuredClone(payload.trigger),
    economics: structuredClone(payload.economics),
    metrics: structuredClone(payload.metrics),
    ...(payload.inlineMedia === undefined
      ? {}
      : { inlineMedia: parseInlineMediaGc(payload.inlineMedia)! })
  } as ContextGcCheckpointPayload;
}

export function validateContextGcCheckpoint(
  records: readonly SessionRecord[],
  record: SessionRecord,
  workspace = sessionWorkspace(records),
  committedReplacements: readonly ContextGcReplacement[] = []
): ContextGcCheckpointPayload | undefined {
  const payload = parseContextGcCheckpoint(record);
  if (!payload || payload.boundarySequence >= record.sequence) return undefined;
  const base = contextGcBaseFromRecords(records, payload.boundarySequence);
  if (!sameContextGcBase(payload.base, base)) return undefined;
  const baseSequence = contextGcBaseSequence(payload.base);
  // Later cell completion cannot retroactively authorize an earlier checkpoint.
  records = records.filter((item) => item.sequence <= payload.boundarySequence);
  if (payload.inlineMedia && !inlineMediaGcAnchored(records, payload.inlineMedia)) return undefined;
  const recordsBySequence = new Map(records.map((item) => [item.sequence, item]));
  if (!triggerMatchesRecords(records, recordsBySequence, payload)) return undefined;
  if (
    payload.trigger.usageSequence === null &&
    !isDeepStrictEqual(payload.replacements, committedReplacements)
  )
    return undefined;
  const committed = new Map(
    committedReplacements.map((replacement) => [contextGcReplacementKey(replacement), replacement])
  );
  const changed = payload.replacements.flatMap((replacement): ContextGcReplacement[] => {
    const previous = committed.get(contextGcReplacementKey(replacement));
    if (isDeepStrictEqual(previous, replacement)) return [];
    if (previous?.kind === 'READ_OUTPUT_ITEMS' && replacement.kind === 'READ_OUTPUT_ITEMS') {
      const retained = new Map(previous.items.map((item) => [item.index, item]));
      const items = replacement.items.filter(
        (item) => !isDeepStrictEqual(retained.get(item.index), item)
      );
      if (items.length > 0)
        return [
          {
            ...replacement,
            items,
            evidenceSequences: [...new Set(items.map((item) => item.evidenceSequence))]
          }
        ];
    }
    return [replacement];
  });
  const targets = payload.replacements.flatMap((replacement) => [
    replacement.target,
    ...(replacement.kind === 'TOOL_CALL_INPUT' ? replacement.providerAliasTargets : [])
  ]);
  if (new Set(targets.map(contextGcTargetKey)).size !== targets.length) return undefined;
  for (const replacement of changed) {
    for (const target of [
      replacement.target,
      ...(replacement.kind === 'TOOL_CALL_INPUT' ? replacement.providerAliasTargets : [])
    ]) {
      const source = recordsBySequence.get(target.sequence);
      if (!source || !targetMatchesRecord(target, source)) return undefined;
    }
    const evidence =
      replacement.kind === 'READ_OUTPUT_ITEMS'
        ? replacement.evidenceSequences
        : [
            replacement.evidenceSequence,
            ...(replacement.kind === 'SUBAGENT_OUTPUT' &&
            replacement.retainedPriorFinal !== undefined
              ? [replacement.retainedPriorFinal.evidenceSequence]
              : [])
          ];
    if (
      evidence.some(
        (sequence) =>
          !isPositiveInteger(sequence) ||
          sequence < baseSequence ||
          sequence > payload.boundarySequence ||
          !recordsBySequence.has(sequence)
      )
    )
      return undefined;
    if (
      !replacementMatchesRecords(
        replacement,
        records,
        recordsBySequence,
        workspace,
        payload.trigger.platform
      )
    )
      return undefined;
  }
  return payload;
}

export function latestValidContextGcCheckpoint(
  records: readonly SessionRecord[],
  boundarySequence = records.at(-1)?.sequence ?? 0
): { readonly record: SessionRecord; readonly payload: ContextGcCheckpointPayload } | undefined {
  const base = contextGcBaseFromRecords(records, boundarySequence);
  if (!base) return undefined;
  const baseSequence = contextGcBaseSequence(base);
  // Committed local checkpoints are trusted; historical evidence is checked at commit only.
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]!;
    if (record.sequence < baseSequence) break;
    if (record.sequence > boundarySequence || record.type !== 'context.gc.completed') continue;
    const payload = parseContextGcCheckpoint(record);
    if (
      payload &&
      payload.boundarySequence >= baseSequence &&
      payload.boundarySequence < record.sequence &&
      sameContextGcBase(payload.base, base)
    )
      return { record, payload };
  }
  return undefined;
}

export function sameContextGcBase(
  left: ContextGcBase | undefined,
  right: ContextGcBase | undefined
): boolean {
  if (!left || !right || left.type !== right.type) return false;
  return left.type === 'SESSION_START'
    ? left.firstSequence ===
        (right as Extract<ContextGcBase, { type: 'SESSION_START' }>).firstSequence
    : left.sequence === (right as Extract<ContextGcBase, { type: 'COMPACT' }>).sequence &&
        left.recordId === (right as Extract<ContextGcBase, { type: 'COMPACT' }>).recordId;
}

function targetMatchesRecord(target: ContextGcTarget, record: SessionRecord): boolean {
  if (
    record.type !== 'model.context' ||
    record.recordId !== target.recordId ||
    !isRecord(record.payload) ||
    record.payload.role !== target.role
  )
    return false;
  const messageCallId = modelContextCallId(record.payload);
  const messageToolName = modelContextToolName(record.payload);
  return (
    (target.callId === undefined || target.callId === messageCallId) &&
    (target.observationId === undefined ||
      observationsFromRecord(record)?.some((value) => value.id === target.observationId) ===
        true) &&
    (target.toolName === undefined || target.toolName === messageToolName)
  );
}

/** A checkpoint draft is valid only when its replacements match the source records and evidence. */
function replacementMatchesRecords(
  replacement: ContextGcReplacement,
  records: readonly SessionRecord[],
  recordsBySequence: ReadonlyMap<number, SessionRecord>,
  workspace: string | undefined,
  platform: ContextGcPlatform
): boolean {
  let source = recordsBySequence.get(replacement.target.sequence);
  if (!source || !isRecord(source.payload)) return false;
  let sourceToolSequence = source.sequence;
  if (replacement.target.observationId) {
    const selected = observationsFromRecord(source)?.find(
      (value) => value.id === replacement.target.observationId
    );
    if (!selected) return false;
    if (selected.type === 'tool_result') {
      const evidence = codeObservationEvidence(records, source, selected);
      if (!evidence) return false;
      sourceToolSequence = evidence.completed.sequence;
      source = {
        ...source,
        payload: {
          ...source.payload,
          callId: selected.source.callId,
          content: selected.result.content
        }
      };
    } else source = { ...source, payload: { ...source.payload, content: selected.value } };
    recordsBySequence = new Map(recordsBySequence).set(source.sequence, source);
  }
  if (!isRecord(source.payload)) return false;
  if (replacement.kind === 'READ_OUTPUT_ITEMS') {
    if (!workspace || toolNameForCallId(records, replacement.callId, source.sequence) !== 'read')
      return false;
    const parsed =
      typeof source.payload.content === 'string'
        ? parseReadContextOutput(source.payload.content)
        : undefined;
    if (!parsed) return false;
    const originalItems = new Map(parsed.items.map((item) => [item.index, item]));
    return replacement.items.every((item) => {
      const original = originalItems.get(item.index);
      const evidence = appliedPatchEvidenceForPath(
        records,
        recordsBySequence,
        item.evidenceSequence,
        item.path,
        workspace,
        platform,
        sourceToolSequence,
        item.supersededByCallId
      );
      return (
        original?.pathTruncated === false &&
        original?.path === item.path &&
        evidence !== undefined &&
        item.replacement ===
          contextGcStaleReadReplacement({
            path: item.path,
            content: original.content,
            operation: evidence.file.operation
          })
      );
    });
  }
  if (replacement.kind === 'TOOL_CALL_INPUT' && replacement.toolName === 'apply_patch') {
    const evidence = successfulToolEvidence(
      records,
      recordsBySequence,
      replacement.evidenceSequence,
      'apply_patch'
    );
    const result = contextGcPatchResultFromCompletedPayload(evidence?.completed.payload);
    return (
      evidence?.callId === replacement.callId &&
      evidence.call.sequence === replacement.target.sequence &&
      result !== undefined &&
      isDeepStrictEqual(
        replacement.replacementArguments,
        contextGcApplyPatchInputReplacement(source.payload.arguments, result)
      )
    );
  }
  if (replacement.kind === 'TOOL_CALL_INPUT' && replacement.toolName === 'code_exec') {
    const evidence = successfulToolEvidence(
      records,
      recordsBySequence,
      replacement.evidenceSequence,
      replacement.toolName
    );
    const input = normalizeContextGcCodeModeInput(source.payload.arguments);
    return (
      evidence?.callId === replacement.callId &&
      codeCellCompletionSequence(records, evidence.completed) !== undefined &&
      evidence.call.sequence === replacement.target.sequence &&
      input !== undefined &&
      isDeepStrictEqual(
        replacement.replacementArguments,
        contextGcCodeModeInputReplacement(
          input,
          observationsFromRecord(evidence.result)
            ? retainedCodeInputs(records, replacement.callId)
            : []
        )
      )
    );
  }
  if (replacement.kind === 'CODE_MODE_OUTPUT') {
    const evidence = (['code_exec', 'code_exec_wait'] as const)
      .map((name) =>
        successfulToolEvidence(records, recordsBySequence, replacement.evidenceSequence, name)
      )
      .find((item) => item !== undefined);
    return (
      evidence?.callId === replacement.callId &&
      codeCellCompletionSequence(records, evidence.completed) !== undefined &&
      evidence.result.sequence === replacement.target.sequence &&
      isRecord(evidence.result.payload) &&
      typeof evidence.result.payload.content === 'string' &&
      isRecord(evidence.completed.payload) &&
      typeof evidence.completed.payload.truncated === 'boolean' &&
      replacement.replacementContent ===
        contextGcCodeModeOutputReplacement(
          source.payload.content as string,
          replacement.target.observationId
            ? observationsFromRecord(source)?.some(
                (value) =>
                  value.id === replacement.target.observationId &&
                  value.type === 'value' &&
                  value.truncated === true
              ) === true
            : evidence.completed.payload.truncated
        )
    );
  }
  if (replacement.kind === 'SUBAGENT_OUTPUT') {
    const retainedPriorFinal = replacement.retainedPriorFinal;
    const sourceEvidence = successfulToolEvidence(
      records,
      recordsBySequence,
      source.sequence,
      replacement.toolName
    );
    const terminalEvidence = successfulToolEvidence(
      records,
      recordsBySequence,
      replacement.evidenceSequence,
      replacement.terminalToolName,
      replacement.terminalCallId
    );
    if (
      !sourceEvidence ||
      sourceEvidence.callId !== replacement.callId ||
      !terminalEvidence ||
      terminalEvidence.callId !== replacement.terminalCallId ||
      !isRecord(terminalEvidence.result.payload) ||
      !isRecord(sourceEvidence.result.payload)
    )
      return false;
    let retainedPriorFinalEvidence: ReturnType<typeof successfulToolEvidence> | undefined;
    let retainedPriorFinalSnapshot: ContextGcSubagentSnapshot | undefined;
    if (retainedPriorFinal !== undefined) {
      retainedPriorFinalEvidence = successfulToolEvidence(
        records,
        recordsBySequence,
        retainedPriorFinal.evidenceSequence,
        retainedPriorFinal.toolName,
        retainedPriorFinal.callId
      );
      if (
        !retainedPriorFinalEvidence ||
        retainedPriorFinalEvidence.callId !== retainedPriorFinal.callId ||
        !isRecord(retainedPriorFinalEvidence.result.payload)
      )
        return false;
      retainedPriorFinalSnapshot = normalizeContextGcSubagentSnapshot(
        retainedPriorFinalEvidence.result.payload.content,
        retainedPriorFinalEvidence.completed.payload,
        retainedPriorFinal.toolName
      );
    }
    const sourceSnapshot = normalizeContextGcSubagentSnapshot(
      sourceEvidence.result.payload.content,
      sourceEvidence.completed.payload,
      replacement.toolName
    );
    const terminalSnapshot = normalizeContextGcSubagentSnapshot(
      terminalEvidence.result.payload.content,
      terminalEvidence.completed.payload,
      replacement.terminalToolName
    );
    return (
      sourceSnapshot !== undefined &&
      terminalSnapshot !== undefined &&
      contextGcSubagentNeedsRetainedPriorFinal(sourceSnapshot) ===
        (retainedPriorFinal !== undefined) &&
      (retainedPriorFinalEvidence === undefined ||
        retainedPriorFinalEvidence.result.sequence < sourceEvidence.result.sequence) &&
      sourceEvidence.completed.sequence < terminalEvidence.completed.sequence &&
      (contextGcSubagentSnapshotIsSuperseded(
        sourceSnapshot,
        terminalSnapshot,
        retainedPriorFinalSnapshot
      ) ||
        contextGcSubagentSnapshotIsPreciselyCovered(sourceSnapshot, terminalSnapshot)) &&
      replacement.replacementContent ===
        contextGcSubagentOutputReplacement({
          sourceContent: sourceEvidence.result.payload.content as string,
          source: sourceSnapshot,
          terminal: terminalSnapshot
        })
    );
  }
  if (replacement.kind === 'WEB_OUTPUT') {
    const sourceEvidence = successfulToolEvidence(
      records,
      recordsBySequence,
      source.sequence,
      replacement.toolName
    );
    if (
      !sourceEvidence ||
      sourceEvidence.callId !== replacement.callId ||
      hasFailedToolEvidence(
        records,
        sourceEvidence.call,
        sourceEvidence.result,
        replacement.toolName
      ) ||
      !completeWebToolEvidence(sourceEvidence.completed, sourceEvidence.result) ||
      !isRecord(sourceEvidence.result.payload) ||
      typeof sourceEvidence.result.payload.content !== 'string' ||
      sourceEvidence.result.sequence !== replacement.evidenceSequence ||
      !isRecord(sourceEvidence.completed.payload) ||
      typeof sourceEvidence.completed.payload.truncated !== 'boolean'
    )
      return false;
    return (
      replacement.replacementContent ===
      contextGcWebOutputReplacement(
        replacement.toolName,
        sourceEvidence.result.payload.content,
        sourceEvidence.completed.payload.truncated
      )
    );
  }
  if (!isSuccessfulExecLifecycleEvidence(replacement, source, records, recordsBySequence))
    return false;
  if (replacement.kind === 'TOOL_CALL_INPUT')
    return isDeepStrictEqual(
      replacement.replacementArguments,
      contextGcExecInputReplacement(source.payload.arguments, replacement.toolName)
    );
  const targetEvidence =
    successfulToolEvidence(
      records,
      recordsBySequence,
      source.sequence,
      'exec',
      replacement.callId
    ) ??
    successfulToolEvidence(
      records,
      recordsBySequence,
      source.sequence,
      'exec_wait',
      replacement.callId
    );
  const result = normalizeContextGcExecResult(
    source.payload.content,
    targetEvidence?.completed.payload
  );
  return (
    result !== undefined &&
    replacement.replacementContent === contextGcExecOutputReplacement(result)
  );
}

function toolNameForCallId(
  records: readonly SessionRecord[],
  callId: string,
  beforeSequence: number
): string | undefined {
  const call = modelToolCallForCallId(records, callId, beforeSequence);
  return call && isRecord(call.payload) && typeof call.payload.name === 'string'
    ? call.payload.name
    : undefined;
}

function successfulToolEvidence(
  records: readonly SessionRecord[],
  recordsBySequence: ReadonlyMap<number, SessionRecord>,
  evidenceSequence: number,
  toolName:
    | 'apply_patch'
    | 'exec'
    | 'exec_wait'
    | 'code_exec'
    | 'code_exec_wait'
    | ContextGcSubagentToolName
    | ContextGcWebToolName,
  expectedCallId?: string
):
  | {
      readonly callId: string;
      readonly call: SessionRecord;
      readonly completed: SessionRecord;
      readonly result: SessionRecord;
    }
  | undefined {
  const result = recordsBySequence.get(evidenceSequence);
  if (
    result?.type !== 'model.context' ||
    !isRecord(result.payload) ||
    result.payload.role !== 'tool' ||
    typeof result.payload.callId !== 'string'
  )
    return undefined;
  const callId = result.payload.callId;
  const call = modelToolCallForCallId(records, callId, result.sequence);
  if (
    !call ||
    !isRecord(call.payload) ||
    call.payload.name !== toolName ||
    (expectedCallId && expectedCallId !== callId)
  ) {
    for (const observation of observationsFromRecord(result) ?? []) {
      if (
        observation.type !== 'tool_result' ||
        observation.source.toolName !== toolName ||
        (expectedCallId && observation.source.callId !== expectedCallId)
      )
        continue;
      const evidence = codeObservationEvidence(records, result, observation);
      if (evidence) return evidence;
    }
    for (const entry of callsFromRecord(result) ?? []) {
      if (entry.toolName !== toolName || (expectedCallId && entry.callId !== expectedCallId))
        continue;
      const evidence = codeCallEvidence(records, result, entry);
      if (evidence) return evidence;
    }
    return undefined;
  }
  const completed = records.findLast(
    (record) =>
      record.sequence > call.sequence &&
      record.sequence < result.sequence &&
      record.type === 'tool.completed' &&
      isRecord(record.payload) &&
      record.payload.type === 'tool.completed' &&
      record.payload.callId === callId &&
      record.payload.toolName === toolName
  );
  return completed ? { callId, call, completed, result } : undefined;
}

function completeWebToolEvidence(completed: SessionRecord, result: SessionRecord): boolean {
  return (
    isRecord(completed.payload) &&
    completed.payload.type === 'tool.completed' &&
    typeof completed.payload.truncated === 'boolean' &&
    isRecord(result.payload) &&
    typeof result.payload.content === 'string'
  );
}

function hasFailedToolEvidence(
  records: readonly SessionRecord[],
  call: SessionRecord,
  result: SessionRecord,
  toolName: ContextGcWebToolName
): boolean {
  if (!isRecord(result.payload) || typeof result.payload.callId !== 'string') return true;
  const callId = result.payload.callId;
  return records.some(
    (record) =>
      record.sequence > call.sequence &&
      record.sequence < result.sequence &&
      record.type === 'tool.failed' &&
      isRecord(record.payload) &&
      record.payload.type === 'tool.failed' &&
      record.payload.callId === callId &&
      record.payload.toolName === toolName
  );
}

function modelToolCallForCallId(
  records: readonly SessionRecord[],
  callId: string,
  beforeSequence: number
): SessionRecord | undefined {
  const direct = records.findLast(
    (record) =>
      record.sequence < beforeSequence &&
      record.type === 'model.context' &&
      isRecord(record.payload) &&
      record.payload.role === 'tool_call' &&
      record.payload.callId === callId
  );
  if (direct) return direct;
  const started = records.findLast(
    (record) =>
      record.sequence < beforeSequence &&
      record.type === 'tool.started' &&
      isRecord(record.payload) &&
      record.payload.callId === callId &&
      typeof record.payload.parentCallId === 'string'
  );
  return started && isRecord(started.payload)
    ? {
        ...started,
        payload: {
          role: 'tool_call',
          name: started.payload.toolName,
          callId,
          arguments: started.payload.input
        }
      }
    : undefined;
}

function modelToolResultForCall(
  records: readonly SessionRecord[],
  call: SessionRecord,
  beforeSequence: number
): SessionRecord | undefined {
  if (!isRecord(call.payload) || typeof call.payload.callId !== 'string') return undefined;
  const callId = call.payload.callId;
  return records.find(
    (record) =>
      record.sequence > call.sequence &&
      record.sequence <= beforeSequence &&
      record.type === 'model.context' &&
      isRecord(record.payload) &&
      record.payload.role === 'tool' &&
      record.payload.callId === callId
  );
}

function partialPatchEvidence(
  records: readonly SessionRecord[],
  recordsBySequence: ReadonlyMap<number, SessionRecord>,
  evidenceSequence: number,
  expectedCallId?: string
) {
  const result = recordsBySequence.get(evidenceSequence);
  if (
    result?.type !== 'model.context' ||
    !isRecord(result.payload) ||
    result.payload.role !== 'tool' ||
    typeof result.payload.callId !== 'string'
  )
    return undefined;
  const callId = result.payload.callId;
  const call = modelToolCallForCallId(records, callId, result.sequence);
  if (
    !call ||
    !isRecord(call.payload) ||
    call.payload.name !== 'apply_patch' ||
    (expectedCallId && callId !== expectedCallId)
  ) {
    for (const entry of callsFromRecord(result) ?? []) {
      if (expectedCallId && entry.callId !== expectedCallId) continue;
      const evidence = codePartialPatchCallEvidence(records, result, entry);
      if (evidence) return evidence;
    }
    return undefined;
  }
  const failed = records.findLast(
    (record) =>
      record.sequence > call.sequence &&
      record.sequence < result.sequence &&
      record.type === 'tool.failed' &&
      isRecord(record.payload) &&
      record.payload.callId === callId &&
      contextGcPatchResultFromFailedPayload(record.payload) !== undefined
  );
  return failed ? { callId, call, failed, result } : undefined;
}

function appliedPatchEvidenceForPath(
  records: readonly SessionRecord[],
  recordsBySequence: ReadonlyMap<number, SessionRecord>,
  evidenceSequence: number,
  path: string,
  workspace: string,
  platform: ContextGcPlatform,
  readSequence: number,
  expectedCallId?: string
):
  | {
      readonly callId: string;
      readonly file: {
        readonly operation: 'modified' | 'deleted' | 'moved';
      };
    }
  | undefined {
  const evidence = successfulToolEvidence(
    records,
    recordsBySequence,
    evidenceSequence,
    'apply_patch',
    expectedCallId
  );
  const partial = evidence
    ? undefined
    : partialPatchEvidence(records, recordsBySequence, evidenceSequence, expectedCallId);
  const callId = evidence?.callId ?? partial?.callId;
  const terminalSequence = evidence?.completed.sequence ?? partial?.failed.sequence;
  const result = evidence
    ? contextGcPatchResultFromCompletedPayload(evidence.completed.payload)
    : contextGcPatchResultFromFailedPayload(partial?.failed.payload);
  if (!result || !callId || terminalSequence === undefined || readSequence >= terminalSequence)
    return undefined;
  const expected = contextGcLogicalPathKey(path, workspace, platform);
  if (!expected) return undefined;
  const file = result.files.find(
    (file) =>
      file.operation !== 'added' &&
      contextGcLogicalPathKey(file.path, workspace, platform) === expected
  );
  return file && file.operation !== 'added'
    ? { callId, file: { operation: file.operation } }
    : undefined;
}

function isSuccessfulExecLifecycleEvidence(
  replacement: Extract<ContextGcReplacement, { kind: 'TOOL_CALL_INPUT' | 'EXEC_OUTPUT' }>,
  source: SessionRecord,
  records: readonly SessionRecord[],
  recordsBySequence: ReadonlyMap<number, SessionRecord>
): boolean {
  const expectedTerminal =
    replacement.kind === 'EXEC_OUTPUT' ? replacement.terminalCallId : undefined;
  const evidence =
    successfulToolEvidence(
      records,
      recordsBySequence,
      replacement.evidenceSequence,
      'exec',
      expectedTerminal
    ) ??
    successfulToolEvidence(
      records,
      recordsBySequence,
      replacement.evidenceSequence,
      'exec_wait',
      expectedTerminal
    );
  if (!evidence || !isRecord(evidence.call.payload) || !isRecord(evidence.result.payload))
    return false;
  const finalResult = normalizeContextGcExecResult(
    evidence.result.payload.content,
    evidence.completed.payload
  );
  if (!finalResult || finalResult.status === 'running') return false;
  const targetCall =
    replacement.kind === 'TOOL_CALL_INPUT'
      ? source
      : modelToolCallForCallId(records, replacement.callId, source.sequence);
  if (
    !targetCall ||
    targetCall.sequence > evidence.call.sequence ||
    !isRecord(targetCall.payload) ||
    targetCall.payload.role !== 'tool_call' ||
    (targetCall.payload.name !== 'exec' && targetCall.payload.name !== 'exec_wait') ||
    targetCall.payload.callId !== replacement.callId
  )
    return false;
  const targetResult =
    replacement.kind === 'EXEC_OUTPUT'
      ? source
      : modelToolResultForCall(records, targetCall, evidence.result.sequence);
  if (!targetResult) return false;
  const targetEvidence = successfulToolEvidence(
    records,
    recordsBySequence,
    targetResult.sequence,
    targetCall.payload.name,
    replacement.callId
  );
  if (!targetEvidence || targetEvidence.call.sequence !== targetCall.sequence) return false;
  if (targetEvidence.callId === evidence.callId)
    return targetEvidence.call.sequence === evidence.call.sequence;
  const evidenceInput = evidence.call.payload.arguments;
  const targetInput = targetCall.payload.arguments;
  if (!isRecord(evidenceInput) || !isRecord(targetInput)) return false;
  const evidenceProcessId = evidenceInput.processId;
  const targetOutput =
    isRecord(targetResult.payload) && targetEvidence
      ? normalizeContextGcExecResult(targetResult.payload.content, targetEvidence.completed.payload)
      : undefined;
  const targetProcessId =
    typeof targetInput.processId === 'string'
      ? targetInput.processId
      : typeof targetOutput?.processId === 'string'
        ? targetOutput.processId
        : undefined;
  return (
    typeof evidenceProcessId === 'string' &&
    targetProcessId === evidenceProcessId &&
    targetResult.sequence <= evidence.result.sequence
  );
}

function triggerMatchesRecords(
  records: readonly SessionRecord[],
  recordsBySequence: ReadonlyMap<number, SessionRecord>,
  payload: ContextGcCheckpointPayload
): boolean {
  if (
    payload.trigger.usageSequence !== null &&
    (payload.trigger.usageSequence < contextGcBaseSequence(payload.base) ||
      payload.trigger.usageSequence > payload.boundarySequence)
  )
    return false;
  const withoutUsage = payload.trigger.usageSequence === null;
  if (
    withoutUsage &&
    (!payload.inlineMedia ||
      payload.inlineMedia.reason === 'TEXT_GC' ||
      payload.metrics.stage !== 'INLINE_MEDIA' ||
      payload.trigger.contextInputTokens !== 0)
  )
    return false;
  const usageRecord = withoutUsage
    ? undefined
    : recordsBySequence.get(payload.trigger.usageSequence!);
  if (
    !withoutUsage &&
    (!usageRecord ||
      !isRecord(usageRecord.payload) ||
      usageRecord.payload.type !== 'usage.updated' ||
      modelContextUsage(usageRecord.payload) !== payload.trigger.contextInputTokens)
  )
    return false;
  const baseSequence = contextGcBaseSequence(payload.base);
  let modelId: string | undefined;
  let contextWindowTokens: number | undefined;
  let triggerConfigurationMatches = false;
  let latestMatchingUsageSequence: number | undefined;
  let normalRolloutOrdinal = 0;
  for (const record of records) {
    if (record.sequence < baseSequence) continue;
    if (record.sequence > payload.boundarySequence) break;
    if (
      (record.type === 'execution.header' || record.type === 'compact.completed') &&
      isRecord(record.payload)
    ) {
      if (typeof record.payload.modelId === 'string') modelId = record.payload.modelId;
      if (isPositiveInteger(record.payload.contextWindowTokens))
        contextWindowTokens = record.payload.contextWindowTokens;
      if (withoutUsage) latestMatchingUsageSequence = undefined;
    }
    const matchingConfiguration =
      modelId === payload.trigger.modelId &&
      contextWindowTokens === payload.trigger.contextWindowTokens;
    if (record.sequence === usageRecord?.sequence || withoutUsage)
      triggerConfigurationMatches = matchingConfiguration;
    if (
      matchingConfiguration &&
      isRecord(record.payload) &&
      record.payload.type === 'usage.updated' &&
      modelContextUsage(record.payload) !== undefined
    )
      latestMatchingUsageSequence = record.sequence;
    if (
      matchingConfiguration &&
      record.type === 'model.attempt' &&
      isRecord(record.payload) &&
      record.payload.purpose === 'EXECUTION' &&
      record.payload.state === 'SUCCEEDED'
    )
      normalRolloutOrdinal++;
  }
  return (
    triggerConfigurationMatches &&
    (withoutUsage
      ? latestMatchingUsageSequence === undefined
      : latestMatchingUsageSequence === payload.trigger.usageSequence) &&
    normalRolloutOrdinal === payload.trigger.normalRolloutOrdinal
  );
}

function modelContextUsage(value: Record<string, unknown>): number | undefined {
  const context = value.contextInputTokens ?? value.inputTokens;
  return isNonnegativeInteger(context) ? context : undefined;
}

function sessionWorkspace(records: readonly SessionRecord[]): string | undefined {
  const created = records.find(
    (record) => record.type === 'session.created' && isRecord(record.payload)
  );
  return created && isRecord(created.payload) && isNonemptyString(created.payload.workspace)
    ? created.payload.workspace
    : undefined;
}

function modelContextCallId(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.callId === 'string') return payload.callId;
  if (payload.role !== 'provider' || !isRecord(payload.item)) return undefined;
  const value = payload.item.call_id;
  return typeof value === 'string' ? value : undefined;
}

function modelContextToolName(payload: Record<string, unknown>): string | undefined {
  if ((payload.role === 'tool_call' || payload.role === 'tool') && typeof payload.name === 'string')
    return payload.name;
  if (payload.role !== 'provider' || !isRecord(payload.item)) return undefined;
  const value = payload.item.name;
  return typeof value === 'string' ? value : undefined;
}

function isContextGcReplacement(value: unknown): value is ContextGcReplacement {
  if (
    !isRecord(value) ||
    !isContextGcTarget(value.target) ||
    !isNonemptyString(value.callId) ||
    (value.target.callId !== value.callId && value.target.observationId === undefined)
  )
    return false;
  if (value.kind === 'READ_OUTPUT_ITEMS') {
    const items = value.items;
    const evidenceSequences = value.evidenceSequences;
    if (!(
      hasOnlyKeys(value, ['kind', 'callId', 'target', 'items', 'evidenceSequences']) &&
      value.target.role === 'tool' &&
      Array.isArray(items) &&
      items.length > 0 &&
      items.every(
        (item) =>
          isRecord(item) &&
          hasOnlyKeys(item, [
            'index',
            'path',
            'replacement',
            'evidenceSequence',
            'supersededByCallId'
          ]) &&
          (item.supersededByCallId === undefined || isNonemptyString(item.supersededByCallId)) &&
          isNonnegativeInteger(item.index) &&
          isNonemptyString(item.path) &&
          isNonemptyString(item.replacement) &&
          isPositiveInteger(item.evidenceSequence)
      ) &&
      Array.isArray(evidenceSequences) &&
      evidenceSequences.length > 0 &&
      evidenceSequences.every(isPositiveInteger)
    ))
      return false;
    const evidence = new Set(evidenceSequences);
    const usedEvidence = new Set(items.map((item) => item.evidenceSequence));
    return (
      new Set(items.map((item) => item.index)).size === items.length &&
      evidence.size === evidenceSequences.length &&
      usedEvidence.size === evidence.size &&
      evidenceSequences.every((sequence) => usedEvidence.has(sequence))
    );
  }
  if (value.kind === 'TOOL_CALL_INPUT')
    return (
      hasOnlyKeys(value, [
        'kind',
        'toolName',
        'callId',
        'target',
        'replacementArguments',
        'providerAliasTargets',
        'evidenceSequence'
      ]) &&
      value.target.role === 'tool_call' &&
      (value.toolName === 'apply_patch' ||
        value.toolName === 'exec' ||
        value.toolName === 'exec_wait' ||
        value.toolName === 'code_exec') &&
      value.target.toolName === value.toolName &&
      Array.isArray(value.providerAliasTargets) &&
      value.providerAliasTargets.every(
        (target) =>
          isContextGcTarget(target) &&
          target.role === 'provider' &&
          target.callId === value.callId &&
          target.toolName === value.toolName
      ) &&
      isPositiveInteger(value.evidenceSequence) &&
      value.replacementArguments !== undefined
    );
  if (value.kind === 'SUBAGENT_OUTPUT')
    return (
      hasOnlyKeys(value, [
        'kind',
        'toolName',
        'callId',
        'target',
        'replacementContent',
        'terminalToolName',
        'terminalCallId',
        'evidenceSequence',
        'retainedPriorFinal'
      ]) &&
      value.target.role === 'tool' &&
      (value.toolName === 'agent_wait' ||
        value.toolName === 'agent_message' ||
        value.toolName === 'agent_cancel') &&
      (value.target.toolName === undefined || value.target.toolName === value.toolName) &&
      isNonemptyString(value.replacementContent) &&
      (value.terminalToolName === 'agent_start' ||
        value.terminalToolName === 'agent_wait' ||
        value.terminalToolName === 'agent_message' ||
        value.terminalToolName === 'agent_cancel') &&
      isNonemptyString(value.terminalCallId) &&
      isPositiveInteger(value.evidenceSequence) &&
      (value.retainedPriorFinal === undefined ||
        (isRecord(value.retainedPriorFinal) &&
          Object.keys(value.retainedPriorFinal).every((key) =>
            ['toolName', 'callId', 'evidenceSequence'].includes(key)
          ) &&
          (value.retainedPriorFinal.toolName === 'agent_start' ||
            value.retainedPriorFinal.toolName === 'agent_wait' ||
            value.retainedPriorFinal.toolName === 'agent_message' ||
            value.retainedPriorFinal.toolName === 'agent_cancel') &&
          isNonemptyString(value.retainedPriorFinal.callId) &&
          isPositiveInteger(value.retainedPriorFinal.evidenceSequence)))
    );
  if (value.kind === 'WEB_OUTPUT')
    return (
      hasOnlyKeys(value, [
        'kind',
        'toolName',
        'callId',
        'target',
        'replacementContent',
        'evidenceSequence'
      ]) &&
      value.target.role === 'tool' &&
      (value.toolName === 'web_search' || value.toolName === 'web_fetch') &&
      (value.target.toolName === undefined || value.target.toolName === value.toolName) &&
      isNonemptyString(value.replacementContent) &&
      isPositiveInteger(value.evidenceSequence)
    );
  if (value.kind === 'CODE_MODE_OUTPUT')
    return (
      hasOnlyKeys(value, ['kind', 'callId', 'target', 'replacementContent', 'evidenceSequence']) &&
      value.target.role === 'tool' &&
      isNonemptyString(value.replacementContent) &&
      isPositiveInteger(value.evidenceSequence)
    );
  return (
    value.kind === 'EXEC_OUTPUT' &&
    hasOnlyKeys(value, [
      'kind',
      'callId',
      'target',
      'replacementContent',
      'evidenceSequence',
      'terminalCallId'
    ]) &&
    (value.terminalCallId === undefined || isNonemptyString(value.terminalCallId)) &&
    value.target.role === 'tool' &&
    isNonemptyString(value.replacementContent) &&
    isPositiveInteger(value.evidenceSequence)
  );
}

function isContextGcTarget(value: unknown): value is ContextGcTarget {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['sequence', 'recordId', 'role', 'callId', 'toolName', 'observationId']) &&
    (value.observationId === undefined ||
      (value.role === 'tool' && isNonemptyString(value.observationId))) &&
    isPositiveInteger(value.sequence) &&
    isNonemptyString(value.recordId) &&
    (value.role === 'tool_call' || value.role === 'tool' || value.role === 'provider') &&
    (value.callId === undefined || isNonemptyString(value.callId)) &&
    (value.toolName === undefined || isNonemptyString(value.toolName))
  );
}

function isContextGcBase(value: unknown): value is ContextGcBase {
  return (
    isRecord(value) &&
    ((value.type === 'SESSION_START' && isPositiveInteger(value.firstSequence)) ||
      (value.type === 'COMPACT' &&
        isPositiveInteger(value.sequence) &&
        isNonemptyString(value.recordId)))
  );
}

function isContextGcTrigger(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.usageSequence === null || isPositiveInteger(value.usageSequence)) &&
    isNonnegativeInteger(value.contextInputTokens) &&
    isPositiveInteger(value.contextWindowTokens) &&
    isNonnegativeInteger(value.normalRolloutOrdinal) &&
    isNonemptyString(value.modelId) &&
    (value.platform === 'linux' || value.platform === 'darwin' || value.platform === 'win32')
  );
}

function isContextGcEconomicsPolicy(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.version === 1 &&
    [
      'immediatePaybackRollouts',
      'maximumPaybackRollouts',
      'contextGrowthSampleWindow',
      'minimumContextGrowthSamples',
      'minimumObservationRollouts',
      'stageAProtectionRollouts',
      'largeExecProtectionRollouts'
    ].every((key) => isNonnegativeInteger(value[key])) &&
    [
      'normalInputCostRate',
      'cacheReadCostRate',
      'cacheWriteCostRate',
      'outputCostRate',
      'minimumGrossReductionRate',
      'minimumCacheInvestmentRoi'
    ].every((key) => isNonnegativeFinite(value[key]))
  );
}

function isContextGcMetrics(value: unknown): boolean {
  if (
    !isRecord(value) ||
    (value.stage !== 'STAGE_A' &&
      value.stage !== 'STAGE_A_AND_EXEC' &&
      value.stage !== 'INLINE_MEDIA')
  )
    return false;
  const nonnegative = [
    'beforeTokens',
    'afterTokens',
    'reclaimedTokens',
    'grossReductionRate',
    'cacheRebuildPenaltyCostUnits',
    'compactDeferralCreditCostUnits',
    'projectedRolloutsUntilCompactAfterGc',
    'contextGrowthSampleCount',
    'contextGrowthP75Tokens',
    'minimumObservedRollouts',
    'protectedCandidateTokens',
    'eligibleCandidateCount',
    'eligibleTargetCount'
  ];
  const optionalNonnegative = [
    'effectiveMinimumGrossReductionRate',
    'minimumRequiredReclaimedTokens',
    'imminentCompactAvoidanceCreditCostUnits',
    'appliedCompactCreditCostUnits',
    'projectedTokensBeforeGc',
    'projectedTokensAfterGc'
  ];
  return (
    nonnegative.every((key) => isNonnegativeFinite(value[key])) &&
    ['requiredPositiveNetRollouts', 'requiredTargetRoiRollouts'].every(
      (key) =>
        isNonnegativeFinite(value[key]) || (value.stage === 'INLINE_MEDIA' && value[key] === null)
    ) &&
    optionalNonnegative.every(
      (key) => value[key] === undefined || isNonnegativeFinite(value[key])
    ) &&
    Number.isFinite(value.expectedNetSavedCostUnits) &&
    Number.isFinite(value.cacheInvestmentRoi) &&
    (value.tokenEstimator === undefined || value.tokenEstimator === 'UTF8_BYTES_V1') &&
    (value.cachePenaltyKnown === undefined || typeof value.cachePenaltyKnown === 'boolean')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNonnegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isValidBoundary(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
