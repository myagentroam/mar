import {
  whiteboardOperationPresentationSchema,
  type WhiteboardOperationPresentation
} from '@myagentroam/protocol';
import { isPlainRecord } from '../../util/records.js';
import type { WhiteboardEntryChanges } from './whiteboard-store.js';

export interface WhiteboardToolResult {
  readonly data: Record<string, unknown> & { readonly boardAgentId?: string };
  readonly boardAgentName?: string | undefined;
  readonly entryChanges?: WhiteboardEntryChanges;
}

const whiteboardEventProjection = whiteboardOperationPresentationSchema.passthrough();

/** Bounds public call metadata separately from the model receipt and its copyable output. */
export function whiteboardOperationEvent(
  input: unknown,
  { data: receipt, boardAgentName, entryChanges }: WhiteboardToolResult
) {
  const request = whiteboardOperationPresentation(input);
  const changes: { entries: string[]; removedCount: number; truncated?: true } | undefined =
    request.action === 'update' &&
    receipt.changed === true &&
    entryChanges &&
    (entryChanges.entries.length || entryChanges.removedCount)
      ? { entries: [...entryChanges.entries], removedCount: entryChanges.removedCount }
      : undefined;
  const parsed = whiteboardOperationPresentationSchema.safeParse({
    ...request,
    boardAgentId: receipt.boardAgentId,
    boardRevision: receipt.boardRevision,
    entryCount:
      request.action === 'read' && Array.isArray(receipt.entries)
        ? receipt.entries.length
        : undefined,
    changed: receipt.changed
  });
  if (!parsed.success) return undefined;
  const owner = boardAgentName
    ?.trim()
    .slice(0, 500)
    .replace(/[\uD800-\uDBFF]$/u, '');
  const event = {
    whiteboardOperation: {
      ...parsed.data,
      ...(owner ? { boardAgentName: owner } : {}),
      ...(changes ? { entryChanges: changes } : {})
    }
  };
  // Core only accepts 8 KiB of explicit extension event data, including JSON escaping.
  if (changes) {
    while (changes.entries.length && Buffer.byteLength(JSON.stringify(event)) > 8000) {
      changes.entries.pop();
      changes.truncated = true;
    }
  }
  return event;
}

export function whiteboardOperationPresentation(
  input: unknown,
  completedData?: unknown
): WhiteboardOperationPresentation & Record<string, unknown> {
  const completed = whiteboardEventProjection.safeParse(
    isPlainRecord(completedData) ? completedData.whiteboardOperation : undefined
  );
  if (completed.success) return completed.data;
  const args = isPlainRecord(input) ? input : {};
  const { action, boardAgentId, ops } = args;
  return {
    ...(action === 'read' || action === 'join' || action === 'leave' || action === 'update'
      ? { action }
      : {}),
    ...(action !== 'leave' &&
    typeof boardAgentId === 'string' &&
    boardAgentId.length > 0 &&
    boardAgentId.length <= 256
      ? { boardAgentId }
      : {}),
    ...(action === 'update' && Array.isArray(ops) && ops.length > 0 && ops.length <= 128
      ? { operationCount: ops.length }
      : {})
  };
}
