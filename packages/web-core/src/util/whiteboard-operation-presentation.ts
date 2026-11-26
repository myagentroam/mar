import {
  whiteboardOperationPresentationSchema,
  type WhiteboardOperationPresentation
} from '@myagentroam/protocol';
import { translate } from '../service/locale-preference-service.js';
import { conversationPayload } from './conversation-history.js';

export interface WhiteboardEntryChanges {
  readonly entries: readonly string[];
  readonly removedCount: number;
  readonly truncated: boolean;
}

function entryChanges(value: unknown): WhiteboardEntryChanges | undefined {
  const changes = conversationPayload(value);
  if (!changes) return undefined;
  const { entries, removedCount, truncated } = changes;
  if (
    !Array.isArray(entries) ||
    !entries.every((entry): entry is string => typeof entry === 'string') ||
    typeof removedCount !== 'number' ||
    !Number.isSafeInteger(removedCount) ||
    removedCount < 0
  )
    return undefined;
  return { entries, removedCount, truncated: truncated === true };
}

export function whiteboardOperation(payload: Record<string, unknown> | undefined) {
  const presentation = conversationPayload(payload?.toolPresentation);
  const facts = conversationPayload(
    presentation?.kind === 'EXTENSION' && presentation.name === 'whiteboard'
      ? presentation.data
      : payload?.whiteboardOperation
  );
  if (!facts) return undefined;
  const parsed = whiteboardOperationPresentationSchema.safeParse(facts);
  return parsed.success
    ? {
        ...parsed.data,
        boardAgentName:
          typeof facts.boardAgentName === 'string' && facts.boardAgentName.trim()
            ? facts.boardAgentName
            : undefined,
        entryChanges: parsed.data.action === 'update' ? entryChanges(facts.entryChanges) : undefined
      }
    : undefined;
}

export function whiteboardOperationTitle(operation: WhiteboardOperationPresentation): string {
  return translate(`presentation.whiteboardOperation.${operation.action ?? 'unknown'}`);
}

export function whiteboardReceiptText(
  operation: WhiteboardOperationPresentation
): string | undefined {
  const { action, entryCount, changed } = operation;
  if (action === 'read' && entryCount !== undefined) {
    if (entryCount === 0) return translate('presentation.whiteboardDetail.empty');
    if (entryCount === 1) return translate('presentation.whiteboardDetail.singleEntry');
    return translate('presentation.whiteboardDetail.entries', { count: entryCount });
  }
  if (action === 'leave' && changed !== undefined)
    return translate(
      changed
        ? 'presentation.whiteboardDetail.unfollowed'
        : 'presentation.whiteboardDetail.noFollowedBoard'
    );
  return undefined;
}
