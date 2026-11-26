import {
  whiteboardOperationPresentationSchema,
  type WhiteboardOperationPresentation
} from '@myagentroam/protocol';
import { isPlainRecord } from '../../util/records.js';

/** Bounds public call metadata separately from the model receipt and its copyable output. */
export function whiteboardOperationEvent(input: unknown, result: unknown) {
  const request = whiteboardOperationPresentation(input);
  const receipt = isPlainRecord(result) ? result : {};
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
  return parsed.success ? { whiteboardOperation: parsed.data } : undefined;
}

export function whiteboardOperationPresentation(
  input: unknown,
  completedData?: unknown
): WhiteboardOperationPresentation {
  const completed = whiteboardOperationPresentationSchema.safeParse(
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
