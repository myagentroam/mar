import type { Ref } from 'vue';
import { conversationProcessGroupSchema } from '@myagentroam/protocol';
import {
  CONVERSATION_RECENT_SEGMENT_BUFFER_LIMIT,
  CONVERSATION_RECENT_SEGMENT_LIMIT,
  conversationPayload,
  conversationTurnHasRunId,
  reconcileOptimisticConversationTurns,
  isOptimisticSteerItem,
  limitConversationPayloadText,
  limitRecentConversationSegments,
  limitConversationSegmentText,
  mergeConversationPayload,
  restoreLocalSteers
} from '../util/conversation-history.js';
import type { ConversationTurn, ConversationTurnPage } from '../model/workbench.js';

import {
  latestConversationProjectionIndex,
  mergeConversationProjectionUnits
} from '../util/conversation-segments.js';

const deltaEncoder = new TextEncoder();

export function createConversationProjectionService(options: {
  readonly turns: Ref<ConversationTurn[]>;
  readonly nextCursor: Ref<string | null>;
  readonly onRecentWindowOverflow: () => void;
  readonly limitHistory: (turns: readonly ConversationTurn[]) => ConversationTurn[];
  readonly scheduleTextDeltaFlush?: (flush: () => void) => () => void;
}) {
  const liveSequences = new Map<string, number>();
  const itemSequences = new Map<string, number>();
  const snapshotSequences = new Map<string, number>();
  let latestSequence = 0;
  let pendingDeltaBytes = 0;
  const pendingTextDeltas = new Map<
    string,
    {
      readonly runId: string;
      readonly itemId?: string;
      readonly turnId?: string;
      readonly segmentId?: string;
      readonly segmentIndex?: number;
      readonly chunks: Array<{ readonly text: string; readonly sequence: number | undefined }>;
      text: string;
      sequence?: number;
      createdAt: number;
    }
  >();
  let cancelTextDeltaFlush: (() => void) | undefined;
  let textDeltaFlushScheduled = false;

  const scheduleTextDeltaFlush =
    options.scheduleTextDeltaFlush ??
    ((flush: () => void) => {
      if (typeof requestAnimationFrame === 'function') {
        const frame = requestAnimationFrame(flush);
        return () => cancelAnimationFrame(frame);
      }
      queueMicrotask(flush);
      return () => undefined;
    });

  const turnKey = (turn: Pick<ConversationTurn, 'sessionId' | 'id'>) =>
    `${turn.sessionId}:${turn.id}`;
  const itemKey = (turn: Pick<ConversationTurn, 'sessionId' | 'id'>, itemId: string) =>
    `${turnKey(turn)}:${itemId}`;

  function installTurns(next: readonly ConversationTurn[]): void {
    const previous = options.turns.value;
    if (next.length < previous.length) {
      const retained = new Set(next.map((turn) => turnKey(turn)));
      const retainedRuns = new Set(next.map((turn) => turn.runId));
      for (const turn of previous) {
        if (retained.has(turnKey(turn))) continue;
        liveSequences.delete(turnKey(turn));
        const itemPrefix = `${turnKey(turn)}:`;
        for (const key of itemSequences.keys())
          if (key.startsWith(itemPrefix)) itemSequences.delete(key);
        if (conversationTurnHasRunId(turn) && !retainedRuns.has(turn.runId))
          snapshotSequences.delete(turn.runId);
      }
    }
    options.turns.value = [...next];
  }

  function limitTurns(): void {
    installTurns(options.limitHistory(options.turns.value));
  }

  function collapseRecentWindow(): boolean {
    if (options.turns.value.length <= CONVERSATION_RECENT_SEGMENT_BUFFER_LIMIT) return false;
    installTurns(
      limitRecentConversationSegments(options.turns.value, CONVERSATION_RECENT_SEGMENT_LIMIT)
    );
    options.nextCursor.value = null;
    return true;
  }

  function resetHistory(): void {
    discardPendingTextDeltas();
    itemSequences.clear();
    liveSequences.clear();
    snapshotSequences.clear();
    pendingDeltaBytes = 0;
    latestSequence = 0;
  }

  function restore(_turns: readonly ConversationTurn[]): void {
    resetHistory();
  }

  function clearSession(sessionId: string, runIds: readonly string[]): void {
    flushPendingTextDeltas();
    const prefix = `${sessionId}:`;
    for (const key of liveSequences.keys()) if (key.startsWith(prefix)) liveSequences.delete(key);
    for (const key of itemSequences.keys()) if (key.startsWith(prefix)) itemSequences.delete(key);
    for (const runId of runIds) snapshotSequences.delete(runId);
  }

  function markLive(turn: ConversationTurn, sequence?: number): void {
    if (sequence === undefined) return;
    latestSequence = Math.max(latestSequence, sequence);
    const key = turnKey(turn);
    liveSequences.set(key, Math.max(liveSequences.get(key) ?? 0, sequence));
  }

  function latestRunProjectionIndex(runId: string, turnId?: string): number {
    return latestConversationProjectionIndex(options.turns.value, runId, turnId);
  }

  function coveredBySnapshot(runId: string, sequence?: number): boolean {
    return sequence !== undefined && sequence <= (snapshotSequences.get(runId) ?? -1);
  }

  /** One identity resolver for full Items and streaming deltas. */
  function resolveProjection(runId: string, event: Record<string, unknown>): number {
    const segmentId = typeof event.segmentId === 'string' ? event.segmentId : undefined;
    const turnId = typeof event.turnId === 'string' ? event.turnId : undefined;
    if (segmentId === undefined) {
      if (typeof event.itemId === 'string') {
        const existing = options.turns.value.findIndex(
          (turn) =>
            turn.runId === runId &&
            (turnId === undefined || (turn.turnId ?? turn.id) === turnId) &&
            turn.items.some((item) => item.id === event.itemId)
        );
        if (existing >= 0) return existing;
      }
      return latestRunProjectionIndex(runId, turnId);
    }
    const existing = options.turns.value.findIndex(
      (turn) => turn.id === segmentId && (turn.runId === runId || turn.runId === null)
    );
    if (existing >= 0) {
      // Native history may omit runtime identity; the matching live event restores it.
      if (options.turns.value[existing]!.runId === null)
        options.turns.value = options.turns.value.map((turn, index) =>
          index === existing ? { ...turn, runId } : turn
        );
      return existing;
    }
    if (
      turnId === undefined ||
      typeof event.segmentIndex !== 'number' ||
      !Number.isInteger(event.segmentIndex) ||
      event.segmentIndex < 0
    )
      return -1;
    // Apply queued text before closing its Segment; frame batching must not change event order.
    flushPendingTextDeltas();
    const managedIndex = latestRunProjectionIndex(runId, turnId);
    const previousIndex =
      managedIndex >= 0
        ? managedIndex
        : options.turns.value.findLastIndex(
            (turn) => turn.turnId === turnId && turn.runId === null
          );
    const previous = options.turns.value[previousIndex];
    if (previous === undefined) return -1;
    const segmentIndex = event.segmentIndex;
    // Missing older units are outside this window, not new live Segments.
    if (segmentIndex <= (previous.segmentIndex ?? -1)) return -1;
    const created: ConversationTurn = {
      ...previous,
      id: segmentId,
      turnId,
      runId,
      segmentIndex,
      items: [],
      startedAt: null,
      completedAt: null
    };
    options.turns.value = mergeConversationProjectionUnits(options.turns.value, [
      { ...previous, status: 'SUCCEEDED' },
      created
    ]);
    if (collapseRecentWindow()) options.onRecentWindowOverflow();
    return options.turns.value.findIndex((turn) => turn.id === segmentId && turn.runId === runId);
  }

  function streamingTarget(runId: string, payload: Record<string, unknown>, sequence?: number) {
    if (coveredBySnapshot(runId, sequence)) return undefined;
    const turnIndex = resolveProjection(runId, payload);
    const turn = options.turns.value[turnIndex];
    if (turn === undefined || completedConversationTurnStatus(turn.status)) return undefined;
    const itemId = typeof payload.itemId === 'string' ? payload.itemId : undefined;
    const current =
      itemId === undefined
        ? undefined
        : turn.items.find((item) => item.id === itemId && item.kind === 'assistant_message');
    if (current !== undefined && completedConversationStatus(current.status)) return undefined;
    if (
      itemId !== undefined &&
      sequence !== undefined &&
      sequence <= (itemSequences.get(itemKey(turn, itemId)) ?? -1)
    )
      return undefined;
    return { turnIndex, turn };
  }

  function mergeItem(
    runId: string,
    input: unknown,
    sequence?: number,
    createdAt = Date.now()
  ): boolean {
    flushPendingTextDeltas();
    const event = conversationPayload(input);
    if (event === undefined) return false;
    const { itemId, kind, status } = event;
    if (typeof itemId !== 'string' || typeof kind !== 'string' || typeof status !== 'string')
      return false;
    if (coveredBySnapshot(runId, sequence)) return false;
    const turnIndex = resolveProjection(runId, event);
    if (turnIndex < 0) return false;
    const turn = options.turns.value[turnIndex]!;
    const existingIndex = turn.items.findIndex((item) => item.id === itemId);
    const current = existingIndex < 0 ? undefined : turn.items[existingIndex];
    const sequenceKey = itemKey(turn, itemId);
    if (
      sequence !== undefined &&
      sequence <= (itemSequences.get(sequenceKey) ?? Number.NEGATIVE_INFINITY)
    )
      return false;
    if (
      current !== undefined &&
      completedConversationStatus(current.status) &&
      !completedConversationStatus(status)
    )
      return false;
    const eventAt = validConversationTime(createdAt) ? createdAt : Date.now();
    const trailingItem = turn.items.at(-1);
    const items = turn.items.map((item) =>
      item.id === trailingItem?.id &&
      item.kind === 'assistant_message' &&
      item.status === 'IN_PROGRESS'
        ? { ...item, status: 'COMPLETED', completedAt: eventAt }
        : item
    );
    const itemStartedAt = validConversationTime(event.startedAt)
      ? event.startedAt
      : (current?.startedAt ?? eventAt);
    const itemCompletedAt =
      event.completedAt === null
        ? null
        : validConversationTime(event.completedAt)
          ? event.completedAt
          : completedConversationStatus(status)
            ? (current?.completedAt ?? eventAt)
            : (current?.completedAt ?? null);
    const item = {
      id: itemId,
      kind,
      status,
      ...(event.processGroup === undefined
        ? {}
        : { processGroup: conversationProcessGroupSchema.parse(event.processGroup) }),
      ...(typeof event.parentItemId === 'string' ? { parentItemId: event.parentItemId } : {}),
      startedAt: itemStartedAt,
      completedAt: itemCompletedAt,
      payload: limitConversationPayloadText(
        event.merge === true && current !== undefined
          ? mergeConversationPayload(current.payload, event.payload, event.append)
          : event.payload
      )
    };
    if (existingIndex < 0) items.push(item);
    else items.splice(existingIndex, 1, item);
    options.turns.value = options.turns.value.map((candidate, index) =>
      index === turnIndex
        ? { ...candidate, items, startedAt: candidate.startedAt ?? item.startedAt }
        : candidate
    );
    if (sequence !== undefined) itemSequences.set(sequenceKey, sequence);
    markLive(turn, sequence);
    limitTurns();
    return true;
  }

  function applyTextDelta(
    runId: string,
    input: unknown,
    sequence?: number,
    createdAt = Date.now()
  ): boolean {
    const payload = conversationPayload(input);
    const text = payload?.text;
    if (typeof text !== 'string' || text.length === 0) return false;
    if (payload === undefined) return false;
    const target = streamingTarget(runId, payload, sequence);
    if (target === undefined) return false;
    const { turnIndex, turn } = target;
    const nativeItemId = typeof payload?.itemId === 'string' ? payload.itemId : undefined;
    const lastItem = turn.items.at(-1);
    const continuing =
      nativeItemId === undefined &&
      lastItem?.kind === 'assistant_message' &&
      lastItem.status === 'IN_PROGRESS';
    const existingIndex =
      nativeItemId === undefined
        ? continuing
          ? turn.items.length - 1
          : -1
        : turn.items.findIndex(
            (item) => item.id === nativeItemId && item.kind === 'assistant_message'
          );
    const itemId =
      existingIndex >= 0
        ? turn.items[existingIndex]!.id
        : (nativeItemId ?? `${runId}:assistant:${sequence ?? 'live'}`);
    const current = existingIndex < 0 ? undefined : turn.items[existingIndex];
    const sequenceKey = itemKey(turn, itemId);
    if (
      sequence !== undefined &&
      sequence <= (itemSequences.get(sequenceKey) ?? Number.NEGATIVE_INFINITY)
    )
      return false;
    const currentPayload = conversationPayload(current?.payload);
    const combinedText = `${typeof currentPayload?.text === 'string' ? currentPayload.text : ''}${text}`;
    const item = {
      id: itemId,
      kind: 'assistant_message',
      status: 'IN_PROGRESS',
      startedAt: current?.startedAt ?? (validConversationTime(createdAt) ? createdAt : Date.now()),
      completedAt: null,
      payload: {
        ...(currentPayload ?? {}),
        ...(limitConversationPayloadText({ text: combinedText }) as Record<string, unknown>),
        format: 'markdown',
        model: null
      }
    };
    const items = [...turn.items];
    if (existingIndex < 0) items.push(item);
    else items.splice(existingIndex, 1, item);
    options.turns.value = options.turns.value.map((candidate, index) =>
      index === turnIndex
        ? { ...candidate, items, startedAt: candidate.startedAt ?? item.startedAt }
        : candidate
    );
    if (sequence !== undefined) itemSequences.set(sequenceKey, sequence);
    pendingDeltaBytes += deltaEncoder.encode(text).byteLength;
    if (pendingDeltaBytes >= 64 * 1024) {
      markLive(turn, sequence);
      limitTurns();
      pendingDeltaBytes = 0;
      return true;
    }
    markLive(turn, sequence);
    return true;
  }

  function flushPendingTextDeltas(): void {
    cancelTextDeltaFlush?.();
    cancelTextDeltaFlush = undefined;
    textDeltaFlushScheduled = false;
    drainPendingTextDeltas();
  }

  function drainPendingTextDeltas(): void {
    if (pendingTextDeltas.size === 0) return;
    const pending = [...pendingTextDeltas.values()];
    pendingTextDeltas.clear();
    for (const delta of pending)
      applyTextDelta(delta.runId, delta, delta.sequence, delta.createdAt);
  }

  function discardPendingTextDeltas(): void {
    cancelTextDeltaFlush?.();
    cancelTextDeltaFlush = undefined;
    textDeltaFlushScheduled = false;
    pendingTextDeltas.clear();
  }

  function mergeTextDelta(
    runId: string,
    input: unknown,
    sequence?: number,
    createdAt = Date.now()
  ): boolean {
    const payload = conversationPayload(input);
    const text = payload?.text;
    if (typeof text !== 'string' || text.length === 0) return false;
    const itemId =
      payload !== undefined && typeof payload.itemId === 'string' ? payload.itemId : undefined;
    if (payload === undefined) return false;
    const target = streamingTarget(runId, payload, sequence);
    if (target === undefined) return false;
    const turn = target.turn;
    const key = `${runId}\u0000${turn.id}\u0000${itemId ?? ''}`;
    const pending = pendingTextDeltas.get(key);
    if (pending !== undefined && sequence !== undefined && sequence <= (pending.sequence ?? -1))
      return false;
    if (pending === undefined) {
      pendingTextDeltas.set(key, {
        runId,
        ...(itemId === undefined ? {} : { itemId }),
        turnId: turn.turnId ?? turn.id,
        ...(turn.segmentIndex === undefined
          ? {}
          : { segmentId: turn.id, segmentIndex: turn.segmentIndex }),
        text,
        chunks: [{ text, sequence }],
        ...(sequence === undefined ? {} : { sequence }),
        createdAt
      });
    } else {
      pending.text += text;
      pending.chunks.push({ text, sequence });
      if (sequence !== undefined) pending.sequence = sequence;
    }
    if (!textDeltaFlushScheduled) {
      textDeltaFlushScheduled = true;
      const cancel = scheduleTextDeltaFlush(() => {
        textDeltaFlushScheduled = false;
        cancelTextDeltaFlush = undefined;
        drainPendingTextDeltas();
      });
      if (textDeltaFlushScheduled) cancelTextDeltaFlush = cancel;
      else cancel();
    }
    return true;
  }

  function recordSnapshot(turn: ConversationTurn, sequence: number | undefined): void {
    markLive(turn, sequence);
    if (!conversationTurnHasRunId(turn) || sequence === undefined) return;
    snapshotSequences.set(turn.runId, Math.max(snapshotSequences.get(turn.runId) ?? 0, sequence));
  }

  function staleSnapshot(page: ConversationTurnPage): boolean {
    return page.snapshotSequence !== undefined && page.snapshotSequence < latestSequence;
  }

  function mergeLatest(page: ConversationTurnPage): boolean {
    flushPendingTextDeltas();
    if (staleSnapshot(page)) return false;
    const priorTurns = options.turns.value;
    const pageTurns = page.turns.map(limitConversationSegmentText);
    const insertsNewTurn = pageTurns.some(
      (turn) => !priorTurns.some((candidate) => candidate.id === turn.id)
    );
    const incoming = pageTurns;
    const previous = new Map(options.turns.value.map((turn) => [turn.id, turn]));
    const mergedIncoming = incoming.map((turn) => {
      const previousTurn =
        previous.get(turn.id) ?? options.turns.value.find((candidate) => candidate.id === turn.id);
      if (previousTurn === undefined) {
        markLive(turn, page.snapshotSequence);
        return turn;
      }
      const liveSequence = liveSequences.get(turnKey(turn));
      if (
        liveSequence !== undefined &&
        page.snapshotSequence !== undefined &&
        liveSequence > page.snapshotSequence
      )
        return previousTurn;
      markLive(turn, page.snapshotSequence);
      const localSteers = previousTurn.items.filter(isOptimisticSteerItem);
      return localSteers.length === 0
        ? turn
        : { ...turn, items: restoreLocalSteers(turn.items, previousTurn.items, localSteers) };
    });
    options.turns.value = reconcileOptimisticConversationTurns(
      mergeConversationProjectionUnits(options.turns.value, mergedIncoming)
    );
    const overflowed = insertsNewTurn && collapseRecentWindow();
    limitTurns();
    const changed = JSON.stringify(priorTurns) !== JSON.stringify(options.turns.value);
    // Watch snapshots and complete terminal Turns can match the realtime projection. Preserve the
    // array reference so Vue does not render an unchanged authoritative confirmation as a refresh.
    if (!changed) options.turns.value = priorTurns;
    if (!overflowed && options.nextCursor.value === null && page.nextCursor !== null)
      options.nextCursor.value = page.nextCursor;
    if (overflowed) options.onRecentWindowOverflow();
    return changed;
  }

  function replaceRecent(page: ConversationTurnPage): boolean {
    flushPendingTextDeltas();
    if (staleSnapshot(page)) return false;
    replaceWindow(page);
    return true;
  }

  function replaceWindow(page: ConversationTurnPage): void {
    // Reset to the snapshot, then replay only buffered deltas beyond its sequence boundary.
    const pageTurns = page.turns.map(limitConversationSegmentText);
    const pending = [...pendingTextDeltas.values()];
    resetHistory();
    options.turns.value = options.limitHistory(pageTurns);
    options.nextCursor.value = page.nextCursor;
    latestSequence = page.snapshotSequence ?? 0;
    for (const turn of options.turns.value) {
      recordSnapshot(turn, page.snapshotSequence);
    }
    for (const delta of pending) {
      const boundary = page.snapshotSequence;
      if (boundary === undefined) continue;
      const chunks = delta.chunks.filter(
        (chunk) => chunk.sequence !== undefined && chunk.sequence > boundary
      );
      if (chunks.length === 0) continue;
      applyTextDelta(
        delta.runId,
        { ...delta, text: chunks.map((chunk) => chunk.text).join('') },
        chunks.at(-1)!.sequence,
        delta.createdAt
      );
    }
  }

  function replaceAuthoritative(page: ConversationTurnPage): boolean {
    flushPendingTextDeltas();
    if (staleSnapshot(page)) return false;
    replaceWindow(page);
    return true;
  }

  return {
    resetHistory,
    restore,
    clearSession,
    markLive,
    mergeItem,
    mergeTextDelta,
    flushPendingTextDeltas,
    mergeLatest,
    replaceRecent,
    replaceAuthoritative
  };
}

function validConversationTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function completedConversationStatus(status: string): boolean {
  return ['COMPLETED', 'FAILED', 'DECLINED', 'CANCELLED', 'INTERRUPTED'].includes(status);
}

function completedConversationTurnStatus(status: string): boolean {
  return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'LOST'].includes(status);
}
