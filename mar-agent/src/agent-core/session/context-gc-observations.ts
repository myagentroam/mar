import { isDeepStrictEqual } from 'node:util';
import type { SessionRecord } from './store/index.js';
import {
  codeCellCompletionSequence,
  contextGcPatchResultFromCompletedPayload,
  contextGcPatchResultFromFailedPayload
} from './context-gc-replacements.js';
import {
  parseCodeCalls,
  parseObservations,
  type CodeObservation,
  type CodeToolCallRecord
} from '../tools/code-mode/observations.js';

/** Resolve private observation identity to real dispatch facts, not Provider tool calls. */
export function codeObservationEvidence(
  records: readonly SessionRecord[],
  result: SessionRecord,
  observation: Extract<CodeObservation, { type: 'tool_result' }>
) {
  if (observation.outcome !== 'completed') return undefined;
  const evidence = codeToolEvidence(records, result, observation.source, 'completed');
  if (!evidence) return undefined;
  return {
    callId: evidence.callId,
    call: evidence.call,
    completed: evidence.terminal,
    result: {
      ...result,
      payload: {
        role: 'tool',
        callId: evidence.callId,
        content: observation.result.content,
        observationId: observation.id
      }
    }
  };
}

function codeToolEvidence(
  records: readonly SessionRecord[],
  result: SessionRecord,
  source: Extract<CodeObservation, { type: 'tool_result' }>['source'],
  outcome: 'completed' | 'failed'
) {
  const started = records.findLast(
    (record) =>
      record.sequence < result.sequence &&
      record.type === 'tool.started' &&
      isRecord(record.payload) &&
      record.payload.callId === source.callId &&
      record.payload.toolName === source.toolName &&
      typeof record.payload.parentCallId === 'string' &&
      isDeepStrictEqual(record.payload.input, source.input)
  );
  if (!started || !isRecord(started.payload)) return undefined;
  const parentId = started.payload.parentCallId;
  const parent = records.find(
    (record) =>
      record.type === 'model.context' &&
      record.sequence < started.sequence &&
      isRecord(record.payload) &&
      record.payload.role === 'tool_call' &&
      record.payload.callId === parentId &&
      record.payload.name === 'code_exec'
  );
  if (!parent) return undefined;
  const original = records.find((record) => record.recordId === result.recordId) ?? result;
  if (!isRecord(original.payload)) return undefined;
  const outerId = original.payload.callId;
  const outer = records.findLast(
    (record) =>
      record.sequence < result.sequence &&
      (record.type === 'tool.completed' ||
        (outcome === 'failed' && record.type === 'tool.failed')) &&
      isRecord(record.payload) &&
      record.payload.callId === outerId &&
      (record.payload.toolName === 'code_exec' || record.payload.toolName === 'code_exec_wait')
  );
  if (
    !outer ||
    (outcome === 'completed'
      ? codeCellCompletionSequence(records, outer)
      : partialPatchCellTerminalSequence(records, outer)) === undefined ||
    (outcome === 'completed' &&
      records.some(
        (record) =>
          record.sequence < result.sequence &&
          record.type === 'tool.failed' &&
          isRecord(record.payload) &&
          record.payload.callId === outerId
      ))
  )
    return undefined;
  if (original.payload.callId !== parentId) {
    const initial = records.find(
      (record) =>
        record.sequence < outer.sequence &&
        record.type === 'tool.completed' &&
        isRecord(record.payload) &&
        record.payload.callId === parentId
    );
    if (
      !initial ||
      !isRecord(outer.payload) ||
      outer.payload.toolName !== 'code_exec_wait' ||
      !isRecord(initial.payload) ||
      !isRecord(outer.payload.data) ||
      !isRecord(initial.payload.data) ||
      typeof outer.payload.data.cellId !== 'string' ||
      outer.payload.data.cellId !== initial.payload.data.cellId
    )
      return undefined;
  }
  const completed = records.findLast(
    (record) =>
      record.sequence > started.sequence &&
      record.sequence < result.sequence &&
      record.type === `tool.${outcome}` &&
      isRecord(record.payload) &&
      record.payload.callId === source.callId &&
      record.payload.toolName === source.toolName &&
      record.payload.parentCallId === parentId
  );
  if (
    !completed ||
    records.some(
      (record) =>
        record.sequence > started.sequence &&
        record.sequence < result.sequence &&
        record.type === (outcome === 'completed' ? 'tool.failed' : 'tool.completed') &&
        isRecord(record.payload) &&
        record.payload.callId === source.callId
    )
  )
    return undefined;
  const call: SessionRecord = {
    ...started,
    payload: {
      role: 'tool_call',
      name: source.toolName,
      callId: source.callId,
      arguments: source.input
    }
  };
  return { callId: source.callId, call, terminal: completed, result };
}

function partialPatchCellTerminalSequence(
  records: readonly SessionRecord[],
  result: SessionRecord
) {
  if (!isRecord(result.payload) || !isRecord(result.payload.data)) return undefined;
  const data = result.payload.data;
  if (typeof data.cellId !== 'string') return undefined;
  const terminal = (status: unknown) =>
    status === 'completed' || status === 'failed' || status === 'cancelled';
  if (terminal(data.status)) return result.sequence;
  if (data.status !== 'running') return undefined;
  return records.findLast(
    (record) =>
      record.type === 'code.cell.completed' &&
      isRecord(record.payload) &&
      record.payload.cellId === data.cellId &&
      terminal(record.payload.status)
  )?.sequence;
}

export function observationsFromRecord(record: SessionRecord): CodeObservation[] | undefined {
  return isRecord(record.payload) ? parseObservations(record.payload.observations) : undefined;
}

export function codeCallEvidence(
  records: readonly SessionRecord[],
  result: SessionRecord,
  entry: CodeToolCallRecord
) {
  if (entry.status !== 'completed') return undefined;
  const evidence = codeObservationEvidence(records, result, {
    type: 'tool_result',
    id: `call:${entry.callId}`,
    source: { callId: entry.callId, toolName: entry.toolName, input: entry.input },
    outcome: 'completed',
    result: { content: '' }
  });
  if (!evidence || !isRecord(evidence.completed.payload)) return undefined;
  return {
    ...evidence,
    result: {
      ...evidence.result,
      payload: {
        role: 'tool',
        callId: entry.callId,
        content: JSON.stringify(evidence.completed.payload.data ?? {})
      }
    }
  };
}

/** Failed patch calls can prove applied file units, never successful input reclamation. */
export function codePartialPatchCallEvidence(
  records: readonly SessionRecord[],
  result: SessionRecord,
  entry: CodeToolCallRecord
) {
  if (entry.status !== 'failed' || entry.toolName !== 'apply_patch') return undefined;
  const evidence = codeToolEvidence(
    records,
    result,
    { callId: entry.callId, toolName: entry.toolName, input: entry.input },
    'failed'
  );
  if (!evidence || !contextGcPatchResultFromFailedPayload(evidence.terminal.payload))
    return undefined;
  return { callId: evidence.callId, call: evidence.call, failed: evidence.terminal, result };
}

export function callsFromRecord(record: SessionRecord): CodeToolCallRecord[] | undefined {
  return isRecord(record.payload) ? parseCodeCalls(record.payload.calls) : undefined;
}

export function retainedCodeInputs(records: readonly SessionRecord[], parentCallId: string) {
  return records.flatMap((record) => {
    if (
      !isRecord(record.payload) ||
      record.type !== 'tool.started' ||
      record.payload.parentCallId !== parentCallId
    )
      return [];
    const call = record.payload;
    const completedPatch =
      call.toolName === 'apply_patch' &&
      records.some(
        (next) =>
          next.sequence > record.sequence &&
          next.type === 'tool.completed' &&
          isRecord(next.payload) &&
          next.payload.callId === call.callId &&
          next.payload.toolName === 'apply_patch' &&
          next.payload.parentCallId === parentCallId &&
          contextGcPatchResultFromCompletedPayload(next.payload) !== undefined
      ) &&
      !records.some(
        (next) =>
          next.sequence > record.sequence &&
          next.type === 'tool.failed' &&
          isRecord(next.payload) &&
          next.payload.callId === call.callId
      );
    // Successful patches have durable file evidence; other inputs retain their direct-mode semantics.
    return completedPatch
      ? []
      : [{ callId: call.callId, toolName: call.toolName, input: call.input }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
