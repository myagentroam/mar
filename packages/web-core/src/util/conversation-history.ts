import type { ConversationTurn } from '../model/workbench.js';
import { appendExecutionPresentation } from '@myagentroam/protocol';
import { translate } from '../service/locale-preference-service.js';

export const MAX_CONVERSATION_HISTORY_BYTES = 8 * 1024 * 1024;
export const MAX_CONVERSATION_ITEM_TEXT_CHARACTERS = 64 * 1024;
export const MAX_CONVERSATION_SEGMENT_ITEMS = 200;
export const CONVERSATION_INITIAL_SEGMENT_LIMIT = 10;
export const CONVERSATION_SEGMENT_PAGE_SIZE = 10;
export const CONVERSATION_RECENT_SEGMENT_LIMIT = 15;
export const CONVERSATION_RECENT_SEGMENT_BUFFER_LIMIT = 30;
export const CONVERSATION_INITIAL_RENDER_CHARACTERS = 48 * 1024;
export const CONVERSATION_INITIAL_RENDER_ITEMS = 40;
export const CONVERSATION_RENDER_BATCH_ITEMS = 8;

export function conversationItemCount(turns: readonly ConversationTurn[]): number {
  return turns.reduce((total, turn) => total + turn.items.length, 0);
}

export function initialConversationRenderItemCount(turns: readonly ConversationTurn[]): number {
  let characters = 0;
  let items = 0;
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex]!;
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex]!;
      const itemCharacters = JSON.stringify(item.payload ?? null).length;
      if (
        items > 0 &&
        (items >= CONVERSATION_INITIAL_RENDER_ITEMS ||
          characters + itemCharacters > CONVERSATION_INITIAL_RENDER_CHARACTERS)
      )
        return items;
      items += 1;
      characters += itemCharacters;
    }
  }
  return items;
}

export function latestConversationItems(
  turns: readonly ConversationTurn[],
  itemCount: number
): ConversationTurn[] {
  let remaining = Math.max(0, itemCount);
  const result: ConversationTurn[] = [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0 && remaining > 0; turnIndex -= 1) {
    const turn = turns[turnIndex]!;
    const start = Math.max(0, turn.items.length - remaining);
    const items = turn.items.slice(start);
    if (items.length > 0) result.unshift(start === 0 ? turn : { ...turn, items });
    remaining -= items.length;
  }
  return result;
}
const truncationMessage = () =>
  translate('generated.conversationHistory.olderChatHistoryWasTruncatedInThis');
const itemTruncationMessage = () =>
  translate('generated.conversationHistory.olderMessageContentWasTruncatedInThis');
const DISPLAY_TEXT_FIELDS = [
  'text',
  'outputPreview',
  'outputSummary',
  'inputSummary',
  'reason'
] as const;
const encoder = new TextEncoder();
const normalizedTurns = new WeakSet<object>();
const serializedByteSizes = new WeakMap<object, number>();

function serializedBytes(value: unknown): number {
  if (typeof value === 'object' && value !== null) {
    const cached = serializedByteSizes.get(value);
    if (cached !== undefined) return cached;
    const size = encoder.encode(JSON.stringify(value)).byteLength;
    serializedByteSizes.set(value, size);
    return size;
  }
  return encoder.encode(JSON.stringify(value)).byteLength;
}

export function limitConversationPayloadText(payload: unknown): unknown {
  const itemMessage = itemTruncationMessage();
  const value = conversationPayload(payload);
  if (value === undefined) return payload;
  const separator = '\n\n';
  const tailLength = Math.max(
    0,
    MAX_CONVERSATION_ITEM_TEXT_CHARACTERS - itemMessage.length - separator.length
  );
  let limited: Record<string, unknown> | undefined;
  for (const field of DISPLAY_TEXT_FIELDS) {
    const text = value[field];
    if (typeof text !== 'string' || text.length <= MAX_CONVERSATION_ITEM_TEXT_CHARACTERS) continue;
    limited ??= { ...value };
    limited[field] = `${itemMessage}${separator}${text.slice(-tailLength)}`;
  }
  if (limited === undefined) return payload;
  return { ...limited, truncated: true };
}

export function limitConversationSegmentText(turn: ConversationTurn): ConversationTurn {
  const itemMessage = itemTruncationMessage();
  if (normalizedTurns.has(turn)) return turn;
  let changed = false;
  let items = turn.items.map((item) => {
    const payload = limitConversationPayloadText(item.payload);
    if (payload === item.payload) return item;
    changed = true;
    return { ...item, payload };
  });
  if (items.length > MAX_CONVERSATION_SEGMENT_ITEMS) {
    const warning = {
      id: `${turn.id}:items-truncated`,
      kind: 'warning',
      status: 'COMPLETED',
      payload: { message: itemMessage }
    };
    const firstUser = items.find((item) => item.kind === 'user_message');
    const tailCapacity = MAX_CONVERSATION_SEGMENT_ITEMS - (firstUser === undefined ? 1 : 2);
    const tail = items.slice(-tailCapacity);
    items =
      firstUser !== undefined && !tail.includes(firstUser)
        ? [firstUser, warning, ...tail]
        : [warning, ...items.slice(-(MAX_CONVERSATION_SEGMENT_ITEMS - 1))];
    changed = true;
  }
  const normalized = changed ? { ...turn, items } : turn;
  normalizedTurns.add(normalized);
  return normalized;
}

function compactOversizedTurn(turn: ConversationTurn, maximumBytes: number): ConversationTurn {
  const historyMessage = truncationMessage();
  const turnBytes = serializedBytes(turn);
  if (turnBytes <= maximumBytes) return turn;
  let items = [...turn.items];
  let truncated = false;
  if (items.length > 1) {
    let low = 1;
    let high = items.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (serializedBytes({ ...turn, items: items.slice(middle) }) <= maximumBytes) high = middle;
      else low = middle + 1;
    }
    items = items.slice(low);
    truncated = true;
  }
  if (serializedBytes({ ...turn, items }) > maximumBytes && items[0] !== undefined) {
    const item = items[0];
    const payload = conversationPayload(item.payload);
    const text = typeof payload?.text === 'string' ? payload.text : undefined;
    items = [
      {
        ...item,
        payload: {
          text:
            text === undefined
              ? historyMessage
              : `${historyMessage}\n\n${text.slice(-Math.max(128, Math.floor(maximumBytes / 8)))}`,
          message: historyMessage,
          truncated: true
        }
      }
    ];
    truncated = true;
  }
  const warning = {
    id: `${turn.id}:history-truncated`,
    kind: 'warning',
    status: 'COMPLETED',
    payload: { message: historyMessage }
  };
  const withWarning = truncated ? [warning, ...items] : items;
  const candidates = [withWarning, items, []];
  for (const candidate of candidates) {
    const compacted = { ...turn, items: candidate } as ConversationTurn;
    if (serializedBytes(compacted) <= maximumBytes) {
      normalizedTurns.add(compacted);
      return compacted;
    }
  }
  const empty = { ...turn, items: [] };
  normalizedTurns.add(empty);
  return empty;
}

/** ConversationTurn input is oldest-first; return a contiguous in-memory window in the same order. */
export function limitConversationHistory(
  turns: readonly ConversationTurn[],
  maximumBytes = MAX_CONVERSATION_HISTORY_BYTES
): ConversationTurn[] {
  const arrayOverhead = serializedBytes([]);
  if (turns.length === 0 || maximumBytes <= arrayOverhead) return [];
  const normalizedTurns = turns.map(limitConversationSegmentText);
  const newest = compactOversizedTurn(normalizedTurns.at(-1)!, maximumBytes - arrayOverhead);
  const newestBytes = serializedBytes(newest);
  if (newestBytes + arrayOverhead > maximumBytes) return [];
  const retained = [newest];
  let used = arrayOverhead + newestBytes;
  for (const turn of normalizedTurns.slice(0, -1).reverse()) {
    const size = serializedBytes(turn) + 1;
    if (used + size > maximumBytes) break;
    retained.push(turn);
    used += size;
  }
  const ordered = retained.reverse();
  return ordered.length === turns.length &&
    newest === normalizedTurns.at(-1) &&
    normalizedTurns.every((turn, index) => turn === turns[index])
    ? [...turns]
    : ordered;
}

export function limitRecentConversationSegments(
  turns: readonly ConversationTurn[],
  maximum = CONVERSATION_RECENT_SEGMENT_LIMIT
): ConversationTurn[] {
  return turns.length <= maximum ? [...turns] : turns.slice(-maximum);
}

export function conversationPayload(payload: unknown): Record<string, unknown> | undefined {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
}

export function latestConversationVisibleAt(turns: readonly ConversationTurn[]): number {
  return Math.max(0, ...turns.map((turn) => Math.max(turn.startedAt ?? 0, turn.completedAt ?? 0)));
}

export function conversationTurnHasRunId(turn: ConversationTurn): turn is ConversationTurn & {
  readonly runId: string;
} {
  return typeof turn.runId === 'string' && turn.runId.length > 0;
}

function conversationTurnClientMessageId(turn: ConversationTurn): string | undefined {
  for (const item of turn.items) {
    if (item.kind !== 'user_message') continue;
    const clientMessageId = conversationPayload(item.payload)?.clientMessageId;
    if (typeof clientMessageId === 'string' && clientMessageId.length > 0) return clientMessageId;
  }
  return undefined;
}

/** Only retire browser-created placeholders; Node-owned Turns are never reconciled by content. */
export function reconcileOptimisticConversationTurns(
  turns: readonly ConversationTurn[]
): ConversationTurn[] {
  const acknowledged = new Set(
    turns.flatMap((turn) => {
      const clientMessageId = conversationTurnClientMessageId(turn);
      return clientMessageId !== undefined && turn.id !== clientMessageId ? [clientMessageId] : [];
    })
  );
  return turns.filter((turn) => {
    const clientMessageId = conversationTurnClientMessageId(turn);
    return !(
      turn.runId === null &&
      turn.id === clientMessageId &&
      acknowledged.has(clientMessageId)
    );
  });
}

export function isConversationTurn(value: unknown): value is ConversationTurn {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ConversationTurn).id === 'string' &&
    typeof (value as ConversationTurn).sessionId === 'string' &&
    Array.isArray((value as ConversationTurn).items)
  );
}

export function mergeConversationPayload(
  current: unknown,
  next: unknown,
  append: unknown
): unknown {
  const previous = conversationPayload(current);
  const incoming = conversationPayload(next);
  if (previous === undefined || incoming === undefined) return next;
  const merged: Record<string, unknown> = { ...previous, ...incoming };
  if (
    append === 'sections' &&
    Array.isArray(previous.sections) &&
    Array.isArray(incoming.sections)
  ) {
    const sections = new Map<number, string>();
    for (const section of [...previous.sections, ...incoming.sections]) {
      if (
        typeof section !== 'object' ||
        section === null ||
        typeof (section as Record<string, unknown>).index !== 'number' ||
        !Number.isInteger((section as Record<string, unknown>).index) ||
        ((section as Record<string, unknown>).index as number) < 0 ||
        typeof (section as Record<string, unknown>).text !== 'string'
      )
        continue;
      const { index, text } = section as { index: number; text: string };
      const combined = `${sections.get(index) ?? ''}${text}`;
      sections.set(index, combined.length <= 10_000 ? combined : `${combined.slice(0, 9_999)}…`);
    }
    merged.sections = [...sections]
      .sort(([left], [right]) => left - right)
      .map(([index, text]) => ({ index, text }));
  }
  if (
    (append === 'outputPreview' || append === 'outputSummary') &&
    typeof previous[append] === 'string' &&
    typeof incoming[append] === 'string'
  )
    merged[append] = `${previous[append]}${incoming[append]}`;
  if (append === 'output' && typeof incoming.output === 'object' && incoming.output !== null) {
    if (incoming.toolPresentation !== undefined)
      merged.toolPresentation = appendExecutionPresentation(
        previous.toolPresentation,
        incoming.toolPresentation
      );
    const prior =
      typeof previous.output === 'object' && previous.output !== null
        ? (previous.output as Record<string, unknown>)
        : {};
    const update = incoming.output as Record<string, unknown>;
    if (typeof update.text === 'string') {
      const text = `${typeof prior.text === 'string' ? prior.text : ''}${update.text}`;
      merged.output = {
        text: boundedOutputTail(text),
        truncated: prior.truncated === true || update.truncated === true || text.length > 10_000
      };
      if (typeof incoming.outputPreview === 'string') {
        const combined = `${typeof previous.outputPreview === 'string' ? previous.outputPreview : ''}${incoming.outputPreview}`;
        merged.outputPreview = boundedOutputTail(combined);
      }
    }
  }
  return merged;
}

function boundedOutputTail(text: string): string {
  if (text.length <= 10_000) return text;
  const tail = text.slice(-10_000);
  return /^[\uDC00-\uDFFF]/u.test(tail) ? tail.slice(1) : tail;
}

export function isOptimisticSteerItem(item: ConversationTurn['items'][number]): boolean {
  return item.kind === 'user_message' && item.id.includes(':steer:');
}

export function restoreLocalSteers(
  snapshotItems: readonly ConversationTurn['items'][number][],
  previousItems: readonly ConversationTurn['items'][number][],
  localSteers: readonly ConversationTurn['items'][number][]
): ConversationTurn['items'] {
  let restored = [...snapshotItems];
  for (const steer of localSteers) {
    const clientMessageId = conversationPayload(steer.payload)?.clientMessageId;
    restored = restored.filter(
      (item) =>
        item.id !== steer.id &&
        !(
          item.kind === 'user_message' &&
          clientMessageId !== undefined &&
          conversationPayload(item.payload)?.clientMessageId === clientMessageId
        )
    );
    const priorIndex = previousItems.findIndex((item) => item.id === steer.id);
    const nextKnown = previousItems
      .slice(priorIndex + 1)
      .find((item) => restored.some((candidate) => candidate.id === item.id));
    if (nextKnown !== undefined) {
      restored.splice(
        restored.findIndex((item) => item.id === nextKnown.id),
        0,
        steer
      );
      continue;
    }
    const previousKnown = previousItems
      .slice(0, priorIndex)
      .findLast((item) => restored.some((candidate) => candidate.id === item.id));
    if (previousKnown !== undefined) {
      restored.splice(restored.findIndex((item) => item.id === previousKnown.id) + 1, 0, steer);
      continue;
    }
    const firstFollowup = restored.findIndex(
      (item) =>
        item.kind === 'command_execution' || item.kind === 'tool_call' || item.kind === 'plan'
    );
    restored.splice(firstFollowup < 0 ? restored.length : firstFollowup, 0, steer);
  }
  return restored;
}
