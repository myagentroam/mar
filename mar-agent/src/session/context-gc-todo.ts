import type { SessionRecord } from './record-contract.js';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function todoRevision(value: unknown): number | undefined {
  return object(value) && Number.isSafeInteger(value.revision) && (value.revision as number) >= 0
    ? (value.revision as number)
    : undefined;
}

/** A successful write is a domain fact even if its output was not observed. */
export function completedTodoWrite(
  record: SessionRecord,
  records: readonly SessionRecord[] = []
): { callId: string; revision: number } | undefined {
  if (
    record.type !== 'tool.completed' ||
    !object(record.payload) ||
    record.payload.type !== 'tool.completed' ||
    !['todo_write', 'todo'].includes(String(record.payload.toolName)) ||
    typeof record.payload.callId !== 'string'
  )
    return undefined;
  if (record.payload.toolName === 'todo') {
    const callId = record.payload.callId;
    const parentCallId = record.payload.parentCallId;
    const started = records.findLast(
      (item) =>
        item.sequence < record.sequence &&
        item.executionId === record.executionId &&
        item.type === 'tool.started' &&
        object(item.payload) &&
        item.payload.callId === callId &&
        item.payload.parentCallId === parentCallId &&
        item.payload.toolName === 'todo'
    );
    if (!started || !object(started.payload) || !isTodoWrite('todo', started.payload.input))
      return undefined;
  }
  const revision = todoRevision(record.payload.data);
  return revision === undefined ? undefined : { callId: record.payload.callId, revision };
}

/** Bind a write fact to this invocation, never an earlier occurrence of its call ID. */
export function todoWriteForCall(records: readonly SessionRecord[], call: SessionRecord) {
  if (!object(call.payload) || typeof call.payload.callId !== 'string') return undefined;
  const { callId, parentCallId } = call.payload;
  const toolName = call.type === 'tool.started' ? call.payload.toolName : call.payload.name;
  const input = call.type === 'tool.started' ? call.payload.input : call.payload.arguments;
  if (!isTodoWrite(toolName, input)) return undefined;
  const terminal = records.find(
    (record) =>
      record.sequence > call.sequence &&
      record.executionId === call.executionId &&
      (record.type === 'tool.completed' || record.type === 'tool.failed') &&
      object(record.payload) &&
      record.payload.callId === callId &&
      record.payload.parentCallId === parentCallId &&
      record.payload.toolName === toolName
  );
  if (!terminal) return undefined;
  const fact = completedTodoWrite(terminal, records);
  return fact ? { record: terminal, ...fact } : undefined;
}

export function isTodoWrite(toolName: unknown, input: unknown): boolean {
  return (
    toolName === 'todo_write' || (toolName === 'todo' && object(input) && input.action === 'write')
  );
}

export function isTodoRead(toolName: unknown, input: unknown): boolean {
  return (
    toolName === 'todo_read' || (toolName === 'todo' && object(input) && input.action === 'read')
  );
}

export function visibleTodoSnapshot(
  content: string
): { revision: number; count: number } | undefined {
  try {
    const value: unknown = JSON.parse(content);
    const revision = todoRevision(value);
    return revision !== undefined && object(value) && Array.isArray(value.items)
      ? { revision, count: value.items.length }
      : undefined;
  } catch {
    return undefined;
  }
}

export function todoInputReplacement(
  revision: number,
  count: number,
  successorRevision: number
): unknown {
  return {
    contextGc: 'Todo input was superseded by a successful later revision.',
    revision,
    count,
    supersededByRevision: successorRevision
  };
}

export function todoSnapshotReplacement(
  revision: number,
  count: number,
  successorRevision: number
): string {
  return JSON.stringify({
    contextGc: 'Todo snapshot was superseded by a successful later revision.',
    revision,
    count,
    supersededByRevision: successorRevision
  });
}
