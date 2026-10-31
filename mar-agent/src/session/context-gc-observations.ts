import type { SessionRecord } from './store/types.js';
import { completedTodoWrite, todoInputReplacement } from './context-gc-todo.js';
import { terminalExecLifecycles, type ContextGcExecFact } from './context-gc-exec-lifecycle.js';
import {
  contextGcPatchResultFromCompletedPayload,
  contextGcPatchResultFromFailedPayload,
  contextGcExecInputReplacement,
  normalizeContextGcExecResult
} from './context-gc-replacements.js';
import {
  parseCodeCalls,
  parseObservations,
  type CodeObservation,
  type CodeToolCallRecord
} from './code-observation-projection.js';

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
      typeof record.payload.parentCallId === 'string'
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
      (record.type === 'tool.completed' || record.type === 'tool.failed') &&
      isRecord(record.payload) &&
      record.payload.callId === outerId &&
      (record.payload.toolName === 'code_exec' || record.payload.toolName === 'code_exec_wait')
  );
  if (!outer) return undefined;
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

export function retainedCodeInputs(
  records: readonly SessionRecord[],
  parentCallId: string,
  todoEvidenceMature?: (original: SessionRecord, successor: SessionRecord) => boolean,
  execOptions?: {
    readonly activeProcessIds: ReadonlySet<string>;
    readonly evidenceMature: (sequence: number) => boolean;
    readonly selected?: (callId: string, toolName: string, summary: unknown) => boolean;
  }
) {
  const initial = records.findLast(
    (record) =>
      record.type === 'tool.completed' &&
      isRecord(record.payload) &&
      record.payload.callId === parentCallId &&
      record.payload.toolName === 'code_exec'
  );
  const initialData =
    initial && isRecord(initial.payload) && isRecord(initial.payload.data)
      ? initial.payload.data
      : undefined;
  const cellId = initialData?.cellId;
  const inputs = new Map<string, unknown>();
  const nestedExecCallIds = new Set<string>();
  const nestedCallIds = new Set<string>();
  for (const record of records) {
    if (
      record.type !== 'tool.started' ||
      !isRecord(record.payload) ||
      record.payload.parentCallId !== parentCallId ||
      typeof record.payload.callId !== 'string'
    )
      continue;
    nestedCallIds.add(record.payload.callId);
    if (record.payload.toolName === 'exec' || record.payload.toolName === 'exec_wait')
      nestedExecCallIds.add(record.payload.callId);
  }
  const waits = new Map<string, SessionRecord>();
  for (const snapshot of records) {
    if (
      snapshot.type === 'tool.completed' &&
      isRecord(snapshot.payload) &&
      snapshot.payload.toolName === 'code_exec_wait' &&
      typeof snapshot.payload.callId === 'string'
    )
      waits.set(snapshot.payload.callId, snapshot);
    if (
      snapshot.type !== 'model.context' ||
      !isRecord(snapshot.payload) ||
      snapshot.payload.role !== 'tool' ||
      !Array.isArray(snapshot.payload.calls)
    )
      continue;
    const calls = (callsFromRecord(snapshot) ?? []).filter((call) =>
      nestedCallIds.has(call.callId)
    );
    if (calls.length === 0) continue;
    const outerId = snapshot.payload.callId;
    if (outerId !== parentCallId) {
      const outer = typeof outerId === 'string' ? waits.get(outerId) : undefined;
      if (
        !outer ||
        outer.sequence >= snapshot.sequence ||
        !isRecord(outer.payload) ||
        !isRecord(outer.payload.data) ||
        typeof cellId !== 'string' ||
        outer.payload.data.cellId !== cellId
      )
        continue;
    }
    for (const call of calls) inputs.set(call.callId, call.input);
  }
  const terminalExecs = new Map<string, number>();
  if (execOptions && nestedExecCallIds.size > 0) {
    const processIds = new Set<string>();
    for (const callId of nestedExecCallIds) {
      const input = inputs.get(callId);
      if (isRecord(input) && typeof input.processId === 'string') processIds.add(input.processId);
    }
    for (const record of records) {
      if (!isRecord(record.payload) || typeof record.payload.callId !== 'string') continue;
      if (!nestedExecCallIds.has(record.payload.callId)) continue;
      const data = record.type === 'tool.started' ? record.payload.input : record.payload.data;
      if (isRecord(data) && typeof data.processId === 'string') processIds.add(data.processId);
    }
    for (const lifecycle of terminalExecLifecycles(
      execFactsFromRecords(records, nestedExecCallIds, processIds),
      execOptions.activeProcessIds
    )) {
      const boundary = lifecycle.at(-1)!.value.resultSequence;
      if (boundary !== undefined && execOptions.evidenceMature(boundary))
        for (const fact of lifecycle) terminalExecs.set(fact.callId, boundary);
    }
  }
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
    const actualInput = inputs.has(String(call.callId))
      ? inputs.get(String(call.callId))
      : call.input;
    if (
      (call.toolName === 'exec' || call.toolName === 'exec_wait') &&
      typeof call.callId === 'string' &&
      terminalExecs.has(call.callId)
    ) {
      const summary = contextGcExecInputReplacement(actualInput, call.toolName);
      if (!execOptions?.selected || execOptions.selected(call.callId, call.toolName, summary))
        return [{ callId: call.callId, toolName: call.toolName, input: summary }];
    }
    if (
      call.toolName === 'todo_write' &&
      todoEvidenceMature &&
      isRecord(actualInput) &&
      Array.isArray(actualInput.items)
    ) {
      const originalRecord = records.find(
        (item) => completedTodoWrite(item)?.callId === call.callId
      );
      const original = originalRecord && completedTodoWrite(originalRecord);
      const successor =
        original &&
        records
          .flatMap((item) => {
            const fact = completedTodoWrite(item);
            return fact &&
              fact.revision > original.revision &&
              todoEvidenceMature(originalRecord!, item)
              ? [{ record: item, ...fact }]
              : [];
          })
          .sort((a, b) => b.revision - a.revision)[0];
      if (original && successor)
        return [
          {
            callId: call.callId,
            toolName: call.toolName,
            input: todoInputReplacement(
              original.revision,
              actualInput.items.length,
              successor.revision
            )
          }
        ];
    }
    // Successful patches have durable file evidence; other inputs retain their direct-mode semantics.
    return completedPatch
      ? []
      : [{ callId: call.callId, toolName: call.toolName, input: actualInput }];
  });
}

function execFactsFromRecords(
  records: readonly SessionRecord[],
  relevantCallIds: ReadonlySet<string>,
  relevantProcessIds: ReadonlySet<string>
): ContextGcExecFact<{ resultSequence?: number }>[] {
  const facts = new Map<string, ContextGcExecFact<{ resultSequence?: number }>>();
  const completedByCallId = new Map<string, SessionRecord>();
  const startedByCallId = new Map<string, SessionRecord>();
  for (const record of records) {
    if (
      isRecord(record.payload) &&
      typeof record.payload.callId === 'string' &&
      typeof record.payload.toolName === 'string'
    ) {
      const key = `${record.payload.toolName}:${record.payload.callId}`;
      if (record.type === 'tool.completed') completedByCallId.set(key, record);
      if (record.type === 'tool.started') startedByCallId.set(key, record);
    }
    if (record.type !== 'model.context' || !isRecord(record.payload)) continue;
    const payload = record.payload;
    if (
      payload.role === 'tool_call' &&
      (payload.name === 'exec' || payload.name === 'exec_wait') &&
      typeof payload.callId === 'string'
    ) {
      facts.set(payload.callId, {
        value: {},
        callId: payload.callId,
        toolName: payload.name,
        sequence: record.sequence,
        ...(isRecord(payload.arguments) ? { input: payload.arguments } : {})
      });
    }
    if (payload.role !== 'tool') continue;
    if (typeof payload.callId === 'string') {
      const fact = facts.get(payload.callId);
      const completed = fact && completedByCallId.get(`${fact.toolName}:${fact.callId}`);
      const result = completed && normalizeContextGcExecResult(payload.content, completed.payload);
      if (fact && result)
        facts.set(fact.callId, { ...fact, value: { resultSequence: record.sequence }, result });
    }
    for (const call of callsFromRecord(record) ?? []) {
      if (call.toolName !== 'exec' && call.toolName !== 'exec_wait') continue;
      const started = startedByCallId.get(`${call.toolName}:${call.callId}`);
      const completed = completedByCallId.get(`${call.toolName}:${call.callId}`);
      const data = completed && isRecord(completed.payload) ? completed.payload.data : undefined;
      const inputProcess = isRecord(call.input) ? call.input.processId : undefined;
      const resultProcess = isRecord(data) ? data.processId : undefined;
      if (
        !relevantCallIds.has(call.callId) &&
        !(typeof inputProcess === 'string' && relevantProcessIds.has(inputProcess)) &&
        !(typeof resultProcess === 'string' && relevantProcessIds.has(resultProcess))
      )
        continue;
      if (!started || !isRecord(started.payload) || started.payload.toolName !== call.toolName)
        continue;
      const evidence = codeCallEvidence(records, record, call);
      const content =
        evidence && isRecord(evidence.result.payload) ? evidence.result.payload.content : undefined;
      const result = evidence && normalizeContextGcExecResult(content, evidence.completed.payload);
      facts.set(call.callId, {
        value: result ? { resultSequence: record.sequence } : {},
        callId: call.callId,
        toolName: call.toolName,
        sequence: started.sequence,
        ...(isRecord(call.input) ? { input: call.input } : {}),
        ...(result ? { result } : {})
      });
    }
  }
  return [...facts.values()].filter(
    (fact) =>
      relevantCallIds.has(fact.callId) ||
      (typeof fact.input?.processId === 'string' && relevantProcessIds.has(fact.input.processId)) ||
      (typeof fact.result?.processId === 'string' && relevantProcessIds.has(fact.result.processId))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
