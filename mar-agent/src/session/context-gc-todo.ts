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
  record: SessionRecord
): { callId: string; revision: number } | undefined {
  if (
    record.type !== 'tool.completed' ||
    !object(record.payload) ||
    record.payload.type !== 'tool.completed' ||
    record.payload.toolName !== 'todo_write' ||
    typeof record.payload.callId !== 'string'
  )
    return undefined;
  const revision = todoRevision(record.payload.data);
  return revision === undefined ? undefined : { callId: record.payload.callId, revision };
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
