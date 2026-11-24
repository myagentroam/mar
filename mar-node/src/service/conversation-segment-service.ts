import type {
  ConversationItem,
  ConversationSegment,
  ConversationSegmentPage
} from '@myagentroam/protocol';
import type { NodeAgentSession } from '../session/contracts.js';
import type { NodeConversationItem, NodeConversationTurn } from '../runtime-model.js';
import type { ConversationHistoryPage } from '../session/runner-native-session-parsers.js';
import {
  isAgentCollaborationMessage,
  projectConversationWorkProcesses
} from '../session/runtime/work-process.js';

const MAX_INITIAL_TURN_PAGE_SIZE = 30;

function conversationSegmentPrefix(turn: NodeConversationTurn): string {
  const user = turn.items.find((item) => item.kind === 'user_message');
  const payload =
    typeof user?.payload === 'object' && user.payload !== null && !Array.isArray(user.payload)
      ? (user.payload as Record<string, unknown>)
      : undefined;
  const clientMessageId = payload?.clientMessageId;
  return typeof clientMessageId === 'string' && clientMessageId.length > 0
    ? `message:${clientMessageId}`
    : turn.id;
}

interface SegmentCursor {
  readonly version: 1;
  readonly sessionId: string;
  readonly beforeSegmentId: string;
  readonly turnCursor?: string | null;
}

/** Use the same boundaries for snapshot and realtime delivery. */
function* segmentItemPositions(items: readonly NodeConversationItem[]) {
  let index = 0;
  let previousKind: string | undefined;
  for (const item of items) {
    if (!isAgentCollaborationMessage(item)) {
      if (previousKind === 'assistant_message' && item.kind !== 'assistant_message') index++;
      previousKind = item.kind;
    }
    yield { item, index, previousKind };
  }
}

export function conversationSegments(turn: NodeConversationTurn): ConversationSegment[] {
  turn = projectConversationWorkProcesses(turn);
  const prefix = conversationSegmentPrefix(turn);
  const groups: NodeConversationItem[][] = [];
  for (const { item, index } of segmentItemPositions(turn.items)) {
    (groups[index] ??= []).push(item);
  }
  if (groups.length === 0) groups.push([]);
  return groups.map((items, index) => {
    const id = `${prefix}:segment:${index}`;
    const latest = index === groups.length - 1;
    const projectedItems = items.map(({ sourceItemId: _sourceItemId, ...item }) => ({
      ...item,
      runId: turn.runId,
      segmentId: id,
      segmentIndex: index
    })) as ConversationItem[];
    return {
      id,
      sessionId: turn.sessionId,
      turnId: turn.id,
      runId: turn.runId,
      index,
      status: (latest ? turn.status : 'SUCCEEDED') as ConversationSegment['status'],
      ...(turn.rewind === undefined ? {} : { rewind: turn.rewind }),
      items: projectedItems,
      startedAt: projectedItems[0]?.startedAt ?? turn.startedAt,
      completedAt: latest
        ? (turn.completedAt ?? null)
        : (projectedItems.at(-1)?.completedAt ?? null)
    };
  });
}

export function conversationSegmentIdentityForItem(
  turn: NodeConversationTurn,
  itemId: string,
  itemKind?: string
): { readonly id: string; readonly index: number } {
  const prefix = conversationSegmentPrefix(turn);
  let index = 0;
  let previousKind: string | undefined;
  const runtimeItemId = turn.runId === null ? itemId : `${turn.runId}:${itemId}`;
  for (const position of segmentItemPositions(turn.items)) {
    ({ index, previousKind } = position);
    if (position.item.id === itemId || position.item.id === runtimeItemId)
      return { id: `${prefix}:segment:${index}`, index };
  }
  if (previousKind === 'assistant_message' && itemKind !== 'assistant_message') index++;
  return { id: `${prefix}:segment:${index}`, index };
}

export class ConversationSegmentService {
  constructor(
    private readonly readTurns: (
      session: NodeAgentSession,
      input: { readonly cursor?: string; readonly limit?: number }
    ) => Promise<ConversationHistoryPage>
  ) {}

  /** Project the already bounded Turn page; only initial snapshots impose a Segment limit. */
  projectInitial(
    session: NodeAgentSession,
    page: ConversationHistoryPage,
    limit?: number
  ): ConversationSegmentPage {
    const all = page.turns.flatMap(conversationSegments);
    const segments = limit === undefined ? all : all.slice(-limit);
    return {
      snapshotSequence: page.snapshotSequence,
      source: page.source,
      readAt: page.readAt,
      latestVisibleAt: page.latestVisibleAt,
      unit: 'SEGMENT',
      segments,
      nextCursor:
        segments.length === 0 || (segments.length === all.length && page.nextCursor === null)
          ? null
          : encodeCursor({
              version: 1,
              sessionId: session.id,
              beforeSegmentId: segments[0]!.id
            })
    };
  }

  async read(
    session: NodeAgentSession,
    input: { readonly cursor?: string; readonly limit?: number }
  ): Promise<ConversationSegmentPage> {
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 500);
    const boundary =
      input.cursor === undefined ? undefined : decodeCursor(input.cursor, session.id);
    const collected: ConversationSegment[] = [];
    const visited = new Set<string>();
    let turnCursor = boundary?.turnCursor ?? undefined;
    let oldestTurnCursor: string | null = null;
    let locatingBoundary = boundary !== undefined;
    let hasOlder = false;
    let metadata: Omit<ConversationSegmentPage, 'unit' | 'segments' | 'nextCursor'> | undefined;

    while (collected.length < limit) {
      const page = await this.readTurns(session, {
        ...(turnCursor === undefined ? {} : { cursor: turnCursor }),
        // Preserve the bounded live window without crossing its deferred history boundary.
        limit: boundary === undefined ? Math.min(limit, MAX_INITIAL_TURN_PAGE_SIZE) : 1
      });
      metadata ??= {
        snapshotSequence: page.snapshotSequence,
        source: page.source,
        readAt: page.readAt,
        latestVisibleAt: page.latestVisibleAt,
        ...(boundary === undefined && page.deferredOlderHistory === true
          ? { deferredOlderHistory: true }
          : {})
      };
      const pageSegments = page.turns.flatMap(conversationSegments);
      let eligible = pageSegments;
      if (locatingBoundary) {
        const boundaryIndex = pageSegments.findIndex(
          (segment) => segment.id === boundary?.beforeSegmentId
        );
        if (boundaryIndex >= 0) {
          eligible = pageSegments.slice(0, boundaryIndex);
          locatingBoundary = false;
        } else eligible = [];
      }
      if (!locatingBoundary && eligible.length > 0) {
        const remaining = Math.max(0, limit - collected.length);
        const take = eligible.slice(-remaining);
        hasOlder = eligible.length > take.length || page.nextCursor !== null;
        collected.unshift(...take);
        oldestTurnCursor = turnCursor ?? null;
      }
      if (boundary === undefined && page.deferredOlderHistory === true) break;
      if (collected.length >= limit || page.nextCursor === null) break;
      if (visited.has(page.nextCursor)) throw new Error('EVENT_CURSOR_INVALID');
      visited.add(page.nextCursor);
      turnCursor = page.nextCursor;
    }
    if (locatingBoundary) throw new Error('EVENT_CURSOR_INVALID');
    const nextCursor =
      collected.length === 0 || !hasOlder
        ? null
        : encodeCursor({
            version: 1,
            sessionId: session.id,
            beforeSegmentId: collected[0]!.id,
            turnCursor: oldestTurnCursor
          });
    return {
      ...(metadata ?? {
        snapshotSequence: 0,
        source: 'runtime' as const,
        readAt: Date.now(),
        latestVisibleAt: 0
      }),
      unit: 'SEGMENT',
      segments: collected,
      nextCursor
    };
  }
}

function encodeCursor(cursor: SegmentCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value: string, sessionId: string): SegmentCursor {
  try {
    const decoded = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8')
    ) as Partial<SegmentCursor>;
    if (
      decoded.version !== 1 ||
      decoded.sessionId !== sessionId ||
      typeof decoded.beforeSegmentId !== 'string' ||
      decoded.beforeSegmentId.length === 0 ||
      (decoded.turnCursor !== undefined &&
        decoded.turnCursor !== null &&
        (typeof decoded.turnCursor !== 'string' || decoded.turnCursor.length === 0))
    )
      throw new Error('EVENT_CURSOR_INVALID');
    return decoded as SegmentCursor;
  } catch {
    throw new Error('EVENT_CURSOR_INVALID');
  }
}
