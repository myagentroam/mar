import { compactSummaryFromCheckpoint } from '../record-projection.js';
import { todoItemsFromSnapshot, type TodoItem } from '../todo.js';
import type { SessionExecutionState, SessionMeta, SessionRecord } from './types.js';

export function deriveExecutionState(records: readonly SessionRecord[]): SessionExecutionState & {
  resume: NonNullable<SessionMeta['resume']>;
} {
  let automaticTitle = false;
  let sawUserTurn = false;
  let compactSequence: number | undefined;
  let todoSequence: number | undefined;
  let todoRevision = 0;
  let todoItems: TodoItem[] = [];
  let executionModel: ReturnType<typeof executionModelFromRecord>;
  let firstUserMessagePreview: string | undefined;
  let userTurns = 0;
  for (const record of records) {
    if (isNativeUserTurn(record)) userTurns++;
    firstUserMessagePreview ??= userMessagePreviewFromRecord(record);
    if (record.type === 'session.created')
      automaticTitle =
        (record.payload as { automaticTitle?: unknown } | undefined)?.automaticTitle === true;
    else if (record.type === 'turn.user') sawUserTurn = true;
    else if (record.type === 'session.title.updated') automaticTitle = false;
    else if (isCompactCheckpoint(record)) compactSequence = record.sequence;
    else if (record.type === 'todo.updated') {
      const items = todoItemsFromSnapshot(record.payload);
      if (!items) continue;
      todoSequence = record.sequence;
      todoRevision++;
      todoItems = items;
    }
    const candidate = executionModelFromRecord(record);
    if (candidate !== undefined) executionModel = candidate;
  }
  const boundary = records.findLastIndex(isCompactCheckpoint);
  return {
    automaticTitlePending: automaticTitle && !sawUserTurn,
    todo: { revision: todoRevision, items: todoItems },
    contextRecords: boundary < 0 ? [...records] : records.slice(boundary),
    resume: {
      version: 1,
      userTurns,
      ...(compactSequence === undefined ? {} : { compactSequence }),
      ...(todoSequence === undefined ? {} : { todoSequence }),
      todoRevision,
      executionModelIndexed: true,
      firstUserMessageIndexed: true,
      ...(firstUserMessagePreview === undefined ? {} : { firstUserMessagePreview }),
      ...(executionModel === undefined ? {} : executionModel)
    }
  };
}

export function isNativeUserTurn(record: SessionRecord): boolean {
  return (
    record.type === 'turn.user' &&
    (record.payload as { inputSource?: unknown }).inputSource === undefined
  );
}

export function userMessagePreviewFromRecord(record: SessionRecord): string | undefined {
  if (
    record.type !== 'turn.user' ||
    !isObject(record.payload) ||
    record.payload.inputSource === 'parent_agent' ||
    typeof record.payload.prompt !== 'string'
  )
    return undefined;
  const preview = record.payload.prompt.trim().replace(/\s+/gu, ' ').slice(0, 160);
  return preview || undefined;
}

export function executionModelFromRecord(
  record: SessionRecord
): { modelId: string; modelName?: string; reasoningEffort?: string } | undefined {
  if (record.type !== 'execution.header' || !isObject(record.payload)) return undefined;
  const modelId = record.payload.modelId;
  if (typeof modelId !== 'string' || modelId.trim().length === 0) return undefined;
  const modelName = record.payload.modelName;
  const reasoningEffort = record.payload.reasoningEffort;
  return {
    modelId,
    ...(typeof modelName === 'string' && modelName.trim().length > 0 ? { modelName } : {}),
    ...(typeof reasoningEffort === 'string' && reasoningEffort.trim().length > 0
      ? { reasoningEffort }
      : {})
  };
}

export function isCompactCheckpoint(record: SessionRecord | undefined): boolean {
  return compactSummaryFromCheckpoint(record) !== undefined;
}

export function sameResumeIndex(
  left: SessionMeta['resume'],
  right: NonNullable<SessionMeta['resume']>
): boolean {
  return (
    left?.version === right.version &&
    left.userTurns === right.userTurns &&
    left.compactSequence === right.compactSequence &&
    left.todoSequence === right.todoSequence &&
    left.todoRevision === right.todoRevision &&
    left.executionModelIndexed === right.executionModelIndexed &&
    left.firstUserMessageIndexed === right.firstUserMessageIndexed &&
    left.firstUserMessagePreview === right.firstUserMessagePreview &&
    left.modelId === right.modelId &&
    left.modelName === right.modelName &&
    left.reasoningEffort === right.reasoningEffort
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
