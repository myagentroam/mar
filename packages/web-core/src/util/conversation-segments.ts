import type {
  ConversationSegmentPage,
  ConversationTurn,
  ConversationTurnPage
} from '../model/workbench.js';

type ConversationSegment = ConversationSegmentPage['segments'][number];
const CONVERSATION_STATUSES = new Set([
  'PREPARING',
  'RUNNING',
  'WAITING_INPUT',
  'WAITING_APPROVAL',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
  'LOST'
]);

function isOptionalConversationTime(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 0)
  );
}

function isConversationSegmentItem(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.kind === 'string' &&
    item.kind.length > 0 &&
    typeof item.status === 'string' &&
    item.status.length > 0
  );
}

export function isConversationSegment(value: unknown): value is ConversationSegment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const segment = value as Partial<ConversationSegment>;
  return (
    typeof segment.id === 'string' &&
    segment.id.length > 0 &&
    typeof segment.turnId === 'string' &&
    segment.turnId.length > 0 &&
    typeof segment.sessionId === 'string' &&
    segment.sessionId.length > 0 &&
    (segment.runId === null || (typeof segment.runId === 'string' && segment.runId.length > 0)) &&
    typeof segment.index === 'number' &&
    Number.isInteger(segment.index) &&
    segment.index >= 0 &&
    typeof segment.status === 'string' &&
    CONVERSATION_STATUSES.has(segment.status) &&
    Array.isArray(segment.items) &&
    segment.items.every(isConversationSegmentItem) &&
    isOptionalConversationTime(segment.startedAt) &&
    isOptionalConversationTime(segment.completedAt)
  );
}

export function parseConversationSegmentPage(
  value: unknown,
  fallbackSequence?: number
): ConversationTurnPage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const page = value as Record<string, unknown>;
  if (
    page.unit !== 'SEGMENT' ||
    !Array.isArray(page.segments) ||
    !page.segments.every(isConversationSegment)
  )
    return undefined;
  const sessionIds = new Set(page.segments.map((segment) => segment.sessionId));
  if (sessionIds.size > 1) return undefined;
  return segmentPageAsTurnPage({
    unit: 'SEGMENT',
    segments: page.segments,
    nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null,
    ...(typeof page.snapshotSequence === 'number'
      ? { snapshotSequence: page.snapshotSequence }
      : fallbackSequence === undefined
        ? {}
        : { snapshotSequence: fallbackSequence }),
    ...(page.source === 'official' || page.source === 'native' || page.source === 'runtime'
      ? { source: page.source }
      : {}),
    ...(typeof page.readAt === 'number' ? { readAt: page.readAt } : {}),
    ...(typeof page.latestVisibleAt === 'number' ? { latestVisibleAt: page.latestVisibleAt } : {}),
    ...(page.deferredOlderHistory === true ? { deferredOlderHistory: true } : {})
  });
}

export function segmentPageAsTurnPage(
  page: ConversationSegmentPage | ConversationTurnPage
): ConversationTurnPage {
  if (!Array.isArray((page as Partial<ConversationSegmentPage>).segments))
    throw new Error('The conversation history response contains no segments.');
  const segmentPage = page as ConversationSegmentPage;
  if (!segmentPage.segments.every(isConversationSegment))
    throw new Error('The conversation Segment response contains an invalid Segment.');
  return {
    ...segmentPage,
    turns: segmentPage.segments.map((segment) => ({
      id: segment.id,
      turnId: segment.turnId,
      segmentIndex: segment.index,
      sessionId: segment.sessionId,
      runId: segment.runId,
      status: segment.status,
      ...(segment.rewind === undefined ? {} : { rewind: segment.rewind }),
      items: segment.items,
      ...(segment.startedAt === undefined ? {} : { startedAt: segment.startedAt }),
      ...(segment.completedAt === undefined ? {} : { completedAt: segment.completedAt })
    }))
  };
}

/** Preserve Node Turn order and update existing units in place in both views and caches. */
export function mergeConversationProjectionUnits(
  current: readonly ConversationTurn[],
  incoming: readonly ConversationTurn[]
): ConversationTurn[] {
  const merged = [...current];
  for (const [incomingIndex, turn] of incoming.entries()) {
    const existing = merged.findIndex((candidate) => candidate.id === turn.id);
    if (existing >= 0) {
      merged.splice(existing, 1, turn);
      continue;
    }
    if (turn.turnId !== undefined && turn.segmentIndex !== undefined) {
      const next = merged.findIndex(
        (candidate) =>
          candidate.turnId === turn.turnId &&
          candidate.segmentIndex !== undefined &&
          candidate.segmentIndex > turn.segmentIndex!
      );
      const previous = merged.findLastIndex((candidate) => candidate.turnId === turn.turnId);
      if (next >= 0 || previous >= 0) {
        merged.splice(next >= 0 ? next : previous + 1, 0, turn);
        continue;
      }
    }
    // A hydrated history window can prepend older Turns to an already visible live Turn.
    // Use the next shared Segment as an ordering anchor, not the time or text of either Turn.
    const nextShared = incoming
      .slice(incomingIndex + 1)
      .find((candidate) => merged.some((existingTurn) => existingTurn.id === candidate.id));
    if (nextShared !== undefined) {
      merged.splice(
        merged.findIndex((candidate) => candidate.id === nextShared.id),
        0,
        turn
      );
      continue;
    }
    merged.push(turn);
  }
  return merged;
}

/** Segment indexes are local to a Turn; Turn order is supplied by Node. */
export function latestConversationProjectionIndex(
  turns: readonly ConversationTurn[],
  runId: string,
  turnId?: string
): number {
  const last = turns.findLastIndex(
    (turn) => turn.runId === runId && (turnId === undefined || (turn.turnId ?? turn.id) === turnId)
  );
  if (last < 0) return -1;
  const owner = turns[last]!.turnId ?? turns[last]!.id;
  let latest = last;
  for (const [index, turn] of turns.entries()) {
    if (
      turn.runId === runId &&
      (turn.turnId ?? turn.id) === owner &&
      (turn.segmentIndex ?? -1) > (turns[latest]!.segmentIndex ?? -1)
    )
      latest = index;
  }
  return latest;
}

/** Run status only advances the latest Segment of the latest Turn. */
export function syncConversationRunStatus(
  turns: readonly ConversationTurn[],
  runId: string,
  status: ConversationTurn['status']
): ConversationTurn[] {
  const latest = latestConversationProjectionIndex(turns, runId);
  return turns.map((turn, index) => {
    const matches = index === latest;
    return matches && turn.status !== status ? { ...turn, status } : turn;
  });
}
