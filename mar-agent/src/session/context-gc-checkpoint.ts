import { posix, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { inlineMediaGcAnchored, parseInlineMediaGc } from './inline-media.js';
import { buildContextGcProtection, contextGcProtectionMature } from './context-gc-protection.js';
import {
  completedTodoWrite,
  todoInputReplacement,
  todoSnapshotReplacement,
  visibleTodoSnapshot
} from './context-gc-todo.js';
import { contextGcRetainedInputMarkup } from './context-gc-markup.js';
import {
  codeCallEvidence,
  codePartialPatchCallEvidence,
  callsFromRecord,
  codeObservationEvidence,
  observationsFromRecord,
  retainedCodeInputs
} from './context-gc-observations.js';
import { parseReadContextOutput } from '../prompts/read-context.js';
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
  contextGcReadRangeCovers,
  contextGcCoveredReadReplacement,
  contextGcSkillOutputReplacement,
  contextGcToolOutputReplacement,
  contextGcWebOutputReplacement,
  isGenericContextGcTool,
  normalizeContextGcCodeModeInput,
  normalizeContextGcExecResult
} from './context-gc-replacements.js';
import {
  contextGcSubagentNeedsRetainedPriorFinal,
  contextGcSubagentOutputReplacement,
  contextGcSubagentSnapshotIsPreciselyCovered,
  contextGcSubagentSnapshotIsSuperseded,
  normalizeContextGcSubagentSnapshot,
  type ContextGcSubagentSnapshot
} from './context-gc-subagent.js';
import type { SessionRecord } from './record-contract.js';
import type {
  ContextGcPlatform,
  ContextGcEconomicsPolicy,
  ContextGcBase,
  ContextGcTarget,
  ContextGcReadItemReplacement,
  ContextGcReplacement,
  ContextGcCheckpointPayload
} from './context-gc-contract.js';
export type {
  ContextGcPlatform,
  ContextGcEconomicsPolicy,
  ContextGcBase,
  ContextGcTarget,
  ContextGcReadItemReplacement,
  ContextGcReplacement,
  ContextGcMetrics,
  ContextGcCheckpointDraft,
  ContextGcCheckpointPayload
} from './context-gc-contract.js';

export const CONTEXT_GC_CHECKPOINT_VERSION = 1 as const;
export const CONTEXT_GC_MAX_TARGETS = 4_096;
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
    (payload.economics !== undefined && !isContextGcEconomicsPolicy(payload.economics)) ||
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
    ...(payload.economics === undefined ? {} : { economics: structuredClone(payload.economics) }),
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
  const protection = buildContextGcProtection(
    records,
    payload.trigger.modelId,
    payload.trigger.contextWindowTokens
  );
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
    const anchors =
      replacement.kind === 'READ_OUTPUT_ITEMS'
        ? replacement.items.map((item) =>
            Math.max(replacement.target.sequence, item.evidenceSequence)
          )
        : [Math.max(replacement.target.sequence, ...evidence)];
    if (replacement.kind === 'TOOL_CALL_INPUT' && replacement.toolName === 'todo_write') {
      const terminal = records.find(
        (item) => completedTodoWrite(item)?.callId === replacement.callId
      );
      if (terminal) anchors[0] = Math.max(anchors[0]!, terminal.sequence);
    }
    if (
      (replacement.kind === 'TOOL_CALL_INPUT' && replacement.toolName === 'code_exec') ||
      (replacement.kind === 'CODE_MODE_OUTPUT' && !replacement.target.observationId)
    ) {
      const result = recordsBySequence.get(replacement.evidenceSequence);
      if (result && isRecord(result.payload) && typeof result.payload.callId === 'string') {
        const callId = result.payload.callId;
        const terminal = records.findLast(
          (item) =>
            item.sequence < result.sequence &&
            item.type === 'tool.completed' &&
            isRecord(item.payload) &&
            item.payload.callId === callId
        );
        const completion = terminal && codeCellCompletionSequence(records, terminal);
        if (completion !== undefined) anchors[0] = Math.max(anchors[0]!, completion);
      }
    }
    if (
      anchors.some((anchor) => {
        const count = protection.after(anchor);
        return !contextGcProtectionMature(count);
      })
    )
      return undefined;
    if (
      !replacementMatchesRecords(
        replacement,
        records,
        recordsBySequence,
        workspace,
        payload.trigger.platform,
        payload.replacements,
        protection,
        committed.get(contextGcReplacementKey(replacement))
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

function resultVisibleAfter(
  source: SessionRecord,
  observationId: string | undefined,
  successor: SessionRecord
): boolean {
  if (successor.sequence !== source.sequence) return successor.sequence > source.sequence;
  if (!isRecord(successor.payload)) return false;
  const observations = observationsFromRecord(source) ?? [];
  const sourceIndex = observations.findIndex((value) => value.id === observationId);
  const successorId = successor.payload.observationId;
  return (
    sourceIndex >= 0 && observations.findIndex((value) => value.id === successorId) > sourceIndex
  );
}

/** A checkpoint draft is valid only when its replacements match the source records and evidence. */
function replacementMatchesRecords(
  replacement: ContextGcReplacement,
  records: readonly SessionRecord[],
  recordsBySequence: ReadonlyMap<number, SessionRecord>,
  workspace: string | undefined,
  platform: ContextGcPlatform,
  allReplacements: readonly ContextGcReplacement[],
  protection: ReturnType<typeof buildContextGcProtection>,
  previous: ContextGcReplacement | undefined
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
      if (original && !evidence && item.supersededByCallId) {
        const later = successfulToolEvidence(
          records,
          recordsBySequence,
          item.evidenceSequence,
          'read',
          item.supersededByCallId
        );
        if (
          !later ||
          !resultVisibleAfter(source, replacement.target.observationId, later.result) ||
          !isRecord(later.result.payload) ||
          typeof later.result.payload.content !== 'string'
        )
          return false;
        const laterItems = parseReadContextOutput(later.result.payload.content)?.items ?? [];
        const pathKey = contextGcLogicalPathKey(original.path, workspace, platform);
        const observationId =
          typeof later.result.payload.observationId === 'string'
            ? later.result.payload.observationId
            : undefined;
        const laterRecord = recordsBySequence.get(item.evidenceSequence);
        if (laterRecord && observationsFromRecord(laterRecord) !== undefined && !observationId)
          return false;
        const covered = laterItems.some(
          (next) =>
            pathKey !== undefined &&
            contextGcLogicalPathKey(next.path, workspace, platform) === pathKey &&
            contextGcReadRangeCovers(original, next) &&
            !allReplacements.some(
              (prior) =>
                prior.kind === 'READ_OUTPUT_ITEMS' &&
                prior.target.sequence === later.result.sequence &&
                prior.target.observationId === observationId &&
                prior.items.some((existing) => existing.index === next.index)
            )
        );
        return (
          covered && item.replacement === contextGcCoveredReadReplacement(original, later.callId)
        );
      }
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
  if (replacement.kind === 'TOOL_CALL_INPUT' && replacement.toolName === 'todo_write') {
    const own = records.find((item) => completedTodoWrite(item)?.callId === replacement.callId);
    const original = own && completedTodoWrite(own);
    const successorRecord = recordsBySequence.get(replacement.evidenceSequence);
    const successor = successorRecord && completedTodoWrite(successorRecord);
    const args = source.payload.arguments;
    return (
      original !== undefined &&
      successor !== undefined &&
      successor.revision > original.revision &&
      isRecord(args) &&
      Array.isArray(args.items) &&
      isDeepStrictEqual(
        replacement.replacementArguments,
        todoInputReplacement(original.revision, args.items.length, successor.revision)
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
            ? retainedCodeInputs(
                records,
                replacement.callId,
                (original, successor) => {
                  const count = protection.after(
                    Math.max(
                      replacement.target.sequence,
                      replacement.evidenceSequence,
                      codeCellCompletionSequence(records, evidence.completed) ?? 0,
                      original.sequence,
                      successor.sequence
                    )
                  );
                  return contextGcProtectionMature(count);
                },
                {
                  activeProcessIds: new Set(),
                  evidenceMature: (sequence) => {
                    const count = protection.after(
                      Math.max(
                        replacement.target.sequence,
                        replacement.evidenceSequence,
                        codeCellCompletionSequence(records, evidence.completed) ?? 0,
                        sequence
                      )
                    );
                    return contextGcProtectionMature(count);
                  },
                  selected: (callId, toolName, summary) => {
                    const argument = replacement.replacementArguments;
                    const content =
                      typeof argument === 'string'
                        ? argument
                        : isRecord(argument)
                          ? argument.code
                          : undefined;
                    return (
                      typeof content === 'string' &&
                      content.includes(
                        contextGcRetainedInputMarkup({ callId, toolName, input: summary })
                      )
                    );
                  }
                }
              )
            : []
        )
      )
    );
  }
  if (replacement.kind === 'CODE_MODE_OUTPUT') {
    if (replacement.target.observationId) {
      const observation = observationsFromRecord(source)?.find(
        (value) => value.id === replacement.target.observationId && value.type === 'value'
      );
      return (
        observation?.type === 'value' &&
        source.payload.callId === replacement.callId &&
        replacement.evidenceSequence === source.sequence &&
        ['code_exec', 'code_exec_wait'].includes(
          toolNameForCallId(records, replacement.callId, source.sequence) ?? ''
        ) &&
        replacement.replacementContent ===
          contextGcCodeModeOutputReplacement(
            observation.value,
            observation.truncated === true,
            true
          )
      );
    }
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
          evidence.completed.payload.truncated,
          false
        )
    );
  }
  if (replacement.kind === 'TOOL_OUTPUT') {
    if (replacement.toolName === 'tool_search') {
      const original = successfulToolEvidence(
        records,
        recordsBySequence,
        source.sequence,
        'tool_search',
        replacement.callId
      );
      if (
        !original ||
        !isRecord(source.payload) ||
        !Array.isArray(source.payload.toolSearchTools) ||
        replacement.retainedToolNames === undefined ||
        replacement.replacementContent !== source.payload.content
      )
        return false;
      const sourceNames = source.payload.toolSearchTools.flatMap((tool) =>
        isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : []
      );
      const priorNames =
        previous?.kind === 'TOOL_OUTPUT' && previous.retainedToolNames !== undefined
          ? previous.retainedToolNames
          : sourceNames;
      if (
        replacement.retainedToolNames.some((name) => !priorNames.includes(name)) ||
        !isDeepStrictEqual(
          replacement.retainedToolNames,
          priorNames.filter((name) => replacement.retainedToolNames!.includes(name))
        )
      )
        return false;
      const removed = priorNames.filter((name) => !replacement.retainedToolNames!.includes(name));
      if (removed.length === 0) return false;
      const successors = records.filter(
        (item) =>
          item.sequence > source.sequence &&
          item.sequence <= replacement.evidenceSequence &&
          item.type === 'model.context' &&
          isRecord(item.payload) &&
          item.payload.role === 'tool' &&
          typeof item.payload.callId === 'string' &&
          Array.isArray(item.payload.toolSearchTools) &&
          successfulToolEvidence(
            records,
            recordsBySequence,
            item.sequence,
            'tool_search',
            item.payload.callId
          ) !== undefined
      );
      return (
        removed.every((name) =>
          successors.some((item) => {
            if (!isRecord(item.payload) || !Array.isArray(item.payload.toolSearchTools))
              return false;
            const target = {
              sequence: item.sequence,
              recordId: item.recordId,
              role: 'tool' as const,
              ...(typeof item.payload.callId === 'string' ? { callId: item.payload.callId } : {})
            };
            const applied = allReplacements.find(
              (candidate) => contextGcTargetKey(candidate.target) === contextGcTargetKey(target)
            );
            return (
              item.payload.toolSearchTools.some((tool) => isRecord(tool) && tool.name === name) &&
              !(
                applied?.kind === 'TOOL_OUTPUT' &&
                applied.retainedToolNames !== undefined &&
                !applied.retainedToolNames.includes(name)
              )
            );
          })
        ) && successors.some((item) => item.sequence === replacement.evidenceSequence)
      );
    }
    if (replacement.toolName === 'todo_read') {
      const original = successfulToolEvidence(
        records,
        recordsBySequence,
        source.sequence,
        'todo_read',
        replacement.callId
      );
      const successorRecord = recordsBySequence.get(replacement.evidenceSequence);
      const successor = successorRecord && completedTodoWrite(successorRecord);
      const snapshot =
        typeof source.payload.content === 'string'
          ? visibleTodoSnapshot(source.payload.content)
          : undefined;
      return (
        original !== undefined &&
        snapshot !== undefined &&
        successor !== undefined &&
        successor.revision > snapshot.revision &&
        replacement.replacementContent ===
          todoSnapshotReplacement(snapshot.revision, snapshot.count, successor.revision)
      );
    }
    if (replacement.toolName === 'skill') {
      const original = successfulToolEvidence(
        records,
        recordsBySequence,
        source.sequence,
        'skill',
        replacement.callId
      );
      let successorCallId: unknown;
      try {
        successorCallId = JSON.parse(replacement.replacementContent).supersededByCallId;
      } catch {
        return false;
      }
      if (typeof successorCallId !== 'string') return false;
      const successor = successfulToolEvidence(
        records,
        recordsBySequence,
        replacement.evidenceSequence,
        'skill',
        successorCallId
      );
      const successorRecord = recordsBySequence.get(replacement.evidenceSequence);
      const successorObservationId = isRecord(successor?.result.payload)
        ? successor.result.payload.observationId
        : undefined;
      if (
        !successorRecord ||
        !isRecord(successorRecord.payload) ||
        (observationsFromRecord(successorRecord) !== undefined &&
          typeof successorObservationId !== 'string')
      )
        return false;
      const successorKey = contextGcTargetKey({
        sequence: successorRecord.sequence,
        recordId: successorRecord.recordId,
        role: 'tool',
        ...(typeof successorRecord.payload.callId === 'string'
          ? { callId: successorRecord.payload.callId }
          : {}),
        ...(typeof successorObservationId === 'string'
          ? { observationId: successorObservationId }
          : {})
      });
      if (
        !original ||
        !successor ||
        !resultVisibleAfter(source, replacement.target.observationId, successor.result) ||
        !isRecord(original.call.payload) ||
        !isRecord(successor.call.payload) ||
        !isRecord(original.call.payload.arguments) ||
        !isRecord(successor.call.payload.arguments) ||
        typeof original.call.payload.arguments.name !== 'string' ||
        original.call.payload.arguments.name !== successor.call.payload.arguments.name ||
        typeof source.payload.content !== 'string' ||
        allReplacements.some((item) => contextGcTargetKey(item.target) === successorKey)
      )
        return false;
      return (
        replacement.replacementContent ===
        contextGcSkillOutputReplacement(
          original.call.payload.arguments.name,
          source.payload.content,
          successor.callId
        )
      );
    }
    const evidence = successfulToolEvidence(
      records,
      recordsBySequence,
      replacement.evidenceSequence,
      replacement.toolName,
      replacement.callId
    );
    return (
      isGenericContextGcTool(replacement.toolName) &&
      evidence !== undefined &&
      evidence.result.sequence === replacement.target.sequence &&
      !hasFailedToolEvidence(records, evidence.call, evidence.result, replacement.toolName) &&
      isRecord(evidence.completed.payload) &&
      typeof evidence.completed.payload.truncated === 'boolean' &&
      typeof source.payload.content === 'string' &&
      replacement.replacementContent ===
        contextGcToolOutputReplacement(
          replacement.toolName,
          source.payload.content,
          evidence.completed.payload.truncated
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
  toolName: string,
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
    const observations = observationsFromRecord(result) ?? [];
    // Repeated observations of a known call use its last visible occurrence.
    for (const observation of expectedCallId ? [...observations].reverse() : observations) {
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
  toolName: string
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
        value.toolName === 'code_exec' ||
        value.toolName === 'todo_write') &&
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
  if (value.kind === 'TOOL_OUTPUT')
    return (
      hasOnlyKeys(value, [
        'kind',
        'toolName',
        'callId',
        'target',
        'replacementContent',
        'retainedToolNames',
        'evidenceSequence'
      ]) &&
      value.target.role === 'tool' &&
      isNonemptyString(value.toolName) &&
      (value.toolName === 'skill' ||
        value.toolName === 'todo_read' ||
        value.toolName === 'tool_search' ||
        isGenericContextGcTool(value.toolName)) &&
      (value.target.toolName === undefined || value.target.toolName === value.toolName) &&
      (isNonemptyString(value.replacementContent) ||
        (value.toolName === 'tool_search' && value.replacementContent === '')) &&
      (value.retainedToolNames === undefined ||
        (value.toolName === 'tool_search' &&
          Array.isArray(value.retainedToolNames) &&
          value.retainedToolNames.every(isNonemptyString) &&
          new Set(value.retainedToolNames).size === value.retainedToolNames.length)) &&
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

function isContextGcEconomicsPolicy(value: unknown): value is ContextGcEconomicsPolicy {
  return (
    isRecord(value) &&
    value.version === 1 &&
    [
      'maximumPaybackRollouts',
      'contextGrowthSampleWindow',
      'minimumContextGrowthSamples',
      'minimumObservationRollouts',
      'stageAProtectionRollouts',
      'largeExecProtectionRollouts'
    ].every((key) => isNonnegativeInteger(value[key])) &&
    ['minimumPaybackRollouts', 'immediatePaybackRollouts'].every(
      (key) => value[key] === undefined || isNonnegativeInteger(value[key])
    ) &&
    ['normalInputCostRate', 'cacheReadCostRate'].every((key) => isNonnegativeFinite(value[key])) &&
    [
      'cacheWriteCostRate',
      'minimumCacheInvestmentRoi',
      'minimumGrossReductionRate',
      'outputCostRate'
    ].every((key) => value[key] === undefined || isNonnegativeFinite(value[key]))
  );
}

function isContextGcMetrics(value: unknown): boolean {
  if (
    !isRecord(value) ||
    (value.stage !== 'UNIFIED' &&
      value.stage !== 'STAGE_A' &&
      value.stage !== 'STAGE_A_AND_EXEC' &&
      value.stage !== 'INLINE_MEDIA')
  )
    return false;
  const nonnegative = [
    'beforeTokens',
    'afterTokens',
    'reclaimedTokens',
    'minimumObservedRollouts',
    'protectedCandidateTokens',
    'eligibleCandidateCount',
    'eligibleTargetCount'
  ];
  const optionalNonnegative = [
    'grossReductionRate',
    'cacheRebuildPenaltyCostUnits',
    'projectedRolloutsUntilCompactAfterGc',
    'contextGrowthSampleCount',
    'contextGrowthP75Tokens',
    'effectiveMinimumGrossReductionRate',
    'compactDeferralCreditCostUnits',
    'minimumRequiredReclaimedTokens',
    'imminentCompactAvoidanceCreditCostUnits',
    'appliedCompactCreditCostUnits',
    'projectedTokensBeforeGc',
    'projectedTokensAfterGc'
  ];
  return (
    nonnegative.every((key) => isNonnegativeFinite(value[key])) &&
    [
      ...(value.requiredPositiveNetRollouts === undefined ? [] : ['requiredPositiveNetRollouts']),
      ...(value.requiredTargetRoiRollouts === undefined ? [] : ['requiredTargetRoiRollouts'])
    ].every(
      (key) =>
        isNonnegativeFinite(value[key]) || (value.stage === 'INLINE_MEDIA' && value[key] === null)
    ) &&
    optionalNonnegative.every(
      (key) => value[key] === undefined || isNonnegativeFinite(value[key])
    ) &&
    (value.expectedNetSavedCostUnits === undefined ||
      Number.isFinite(value.expectedNetSavedCostUnits)) &&
    (value.cacheInvestmentRoi === undefined || Number.isFinite(value.cacheInvestmentRoi)) &&
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
