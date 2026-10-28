import { nativeTranscriptAdapter } from '../native-transcript-adapters.js';
import type { NativeTranscriptProjection } from '../native-transcript-model.js';
import { createHash } from 'node:crypto';
import type { NodeAgentSession } from './contracts.js';
import type { NodeConversationItem, NodeConversationTurn } from '../runtime-model.js';
import type {
  NativeSessionHistory,
  NativeTranscriptImageAttachment,
  NativeTranscriptItem
} from '../native-transcript-model.js';
import { compactRunnerText, nativePageEnd } from '../runner/normalization.js';
import { isPlainRecord } from '../util/records.js';

export interface SessionContextUsage {
  readonly model: string | null;
  readonly usedTokens: number;
  readonly maxTokens: number;
  readonly percentage: number;
}

export type ConversationHistorySource = 'official' | 'native' | 'runtime';

export interface ConversationHistoryPage {
  readonly turns: readonly NodeConversationTurn[];
  readonly nextCursor: string | null;
  readonly snapshotSequence: number;
  readonly source: ConversationHistorySource;
  readonly readAt: number;
  readonly latestVisibleAt: number;
  readonly deferredOlderHistory?: boolean;
}

export async function settleWithin<T>(
  promise: Promise<T>,
  milliseconds: number
): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), milliseconds);
        timer.unref();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function isWithinWorkspace(cwd: string, workspacePath: string): boolean {
  const normalize = (value: string) => {
    const compact = value.replace(/[\\/]+/g, '/').replace(/\/$/, '');
    return process.platform === 'win32' ? compact.toLowerCase() : compact;
  };
  const normalizedCwd = normalize(cwd);
  const normalizedWorkspace = normalize(workspacePath);
  if (normalizedCwd === normalizedWorkspace) return true;
  return normalizedCwd.startsWith(`${normalizedWorkspace}/`);
}

export function latestNativeActivity(history: NativeSessionHistory): number {
  return history.lastActivityAt;
}

export function sameContextUsage(left: SessionContextUsage, right: SessionContextUsage): boolean {
  return (
    left.model === right.model &&
    left.usedTokens === right.usedTokens &&
    left.maxTokens === right.maxTokens
  );
}

export function isNativeHistory(value: unknown): value is NativeSessionHistory {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { items?: unknown }).items)
  );
}

export function deduplicateDirectSessions<T extends NodeAgentSession>(
  sessions: readonly T[]
): readonly T[] {
  const values = new Map<string, T>();
  for (const session of sessions) {
    const existing = values.get(session.id);
    if (existing === undefined || existing.lastActivityAt < session.lastActivityAt)
      values.set(session.id, session);
  }
  return [...values.values()].sort((left, right) => right.lastActivityAt - left.lastActivityAt);
}

export function nativeConversationPage(
  session: NodeAgentSession,
  history: NativeSessionHistory,
  input: { readonly cursor?: string; readonly limit?: number },
  runtimeTurns: readonly NodeConversationTurn[] = [],
  registerImages: (
    images: readonly NativeTranscriptImageAttachment[]
  ) => readonly Record<string, unknown>[] = () => []
): { readonly turns: readonly NodeConversationTurn[]; readonly nextCursor: string | null } {
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 500);
  const effectiveCursor = history.cursorReset === true ? undefined : input.cursor;
  const nativeTurns = nativeTranscriptTurns(history.items);
  const nativeTurnIds = nativeTranscriptTurnIds(session.id, nativeTurns);
  const end = nativePageEnd(effectiveCursor, session.id, nativeTurns.length);
  const start = Math.max(0, end - limit);
  const projection = nativeTranscriptAdapter(session.runner)!.createProjection(
    history.items.slice(0, nativeTurns[start]?.[0]?.index ?? 0)
  );
  const nativePageTurns = nativeTurns
    .slice(start, end)
    .map((entries, relativeIndex): NodeConversationTurn => {
      const nativeUser = entries.find(
        ({ entry }) => entry.kind === 'message' && entry.role === 'USER'
      )?.entry;
      const matchedClientMessageId =
        nativeUser?.kind === 'message'
          ? nativeUserClientMessageId(
              projection.userText(nativeUser.text),
              nativeUser.createdAt,
              runtimeTurns
            )
          : null;
      const runtimeTurn =
        typeof matchedClientMessageId === 'string'
          ? runtimeTurns.find((turn) => runtimeTurnClientMessageId(turn) === matchedClientMessageId)
          : undefined;
      const turnId = runtimeTurn?.id ?? nativeTurnIds[start + relativeIndex]!;
      const itemIdentities = nativeTranscriptItemIdentities(entries);
      const nativeItems = entries.map(({ entry, index }, entryIndex) => ({
        ...nativeTranscriptConversationItem(
          session,
          entry,
          index,
          itemIdentities[entryIndex]!,
          turnId,
          runtimeTurns,
          registerImages,
          projection
        ),
        runId: runtimeTurn?.runId ?? null
      }));
      const runtimeErrors = (runtimeTurn?.items ?? [])
        .filter((item) => item.kind === 'error')
        .map((item) => ({ ...item, turnId, runId: runtimeTurn?.runId ?? null }));
      // Native transcripts do not expose a terminal event for an individual response.
      // Once linked to a managed Run, the Runtime owns that Turn until it leaves memory.
      const items =
        runtimeTurn !== undefined
          ? runtimeTurn!.items.map((item) => ({
              ...item,
              turnId,
              runId: runtimeTurn!.runId
            }))
          : [
              ...nativeItems,
              ...runtimeErrors.filter((error) => !nativeItems.some((item) => item.id === error.id))
            ];
      const startedAt = items[0]?.startedAt ?? null;
      const completedAt = items.at(-1)?.completedAt ?? startedAt;
      const after = lastNativeItemId(entries);
      const nativeIndex = start + relativeIndex;
      const turnBoundaryAfter =
        nativeUser?.kind === 'message' ? nativeUser.nativeTurnId : undefined;
      const previousNativeUser = nativeTurns[nativeIndex - 1]?.find(
        ({ entry }) => entry.kind === 'message' && entry.role === 'USER'
      )?.entry;
      const turnBoundaryBefore =
        previousNativeUser?.kind === 'message' ? previousNativeUser.nativeTurnId : undefined;
      const firstNativeTurn = nativeIndex === 0 && history.truncated !== true;
      return {
        id: turnId,
        sessionId: session.id,
        runId: runtimeTurn?.runId ?? null,
        userItemId: items.find((item) => item.kind === 'user_message')?.id ?? null,
        status: runtimeErrors.length > 0 ? 'FAILED' : 'SUCCEEDED',
        model: null,
        effort: null,
        access: null,
        ...(after === undefined
          ? {}
          : {
              rewind: {
                before: lastNativeItemId(nativeTurns[start + relativeIndex - 1] ?? []) ?? null,
                after
              }
            }),
        ...(turnBoundaryAfter === undefined ||
        (!firstNativeTurn && turnBoundaryBefore === undefined)
          ? {}
          : { rewind: { before: turnBoundaryBefore ?? null, after: turnBoundaryAfter } }),
        items,
        startedAt,
        completedAt
      };
    });
  const turns = nativePageTurns;
  const nextEnd = start;
  const cursorBase = {
    sessionId: session.id,
    ...(history.snapshotEnd === undefined ? {} : { snapshotEnd: history.snapshotEnd }),
    ...(history.windowEnd === undefined ? {} : { nextEnd: history.windowEnd }),
    ...(history.fileAnchor === undefined ? {} : { fileAnchor: history.fileAnchor }),
    ...(history.anchorBytes === undefined ? {} : { anchorBytes: history.anchorBytes }),
    readLimit: history.windowReadLimit ?? limit
  };
  const precedingWindow =
    history.truncated === true &&
    history.windowStart !== undefined &&
    history.snapshotEnd !== undefined &&
    history.fileAnchor !== undefined &&
    history.anchorBytes !== undefined
      ? Buffer.from(
          JSON.stringify({
            sessionId: session.id,
            snapshotEnd: history.snapshotEnd,
            nextEnd: history.windowStart,
            fileAnchor: history.fileAnchor,
            anchorBytes: history.anchorBytes,
            readLimit: history.windowReadLimit ?? limit
          })
        ).toString('base64url')
      : null;
  return {
    turns,
    nextCursor:
      nextEnd > 0
        ? Buffer.from(JSON.stringify({ ...cursorBase, end: nextEnd })).toString('base64url')
        : precedingWindow
  };
}

function runtimeTurnClientMessageId(turn: NodeConversationTurn): string | undefined {
  const user = turn.items.find((item) => item.kind === 'user_message');
  return isPlainRecord(user?.payload) && typeof user.payload.clientMessageId === 'string'
    ? user.payload.clientMessageId
    : undefined;
}

function lastNativeItemId(
  entries: readonly { readonly entry: NativeTranscriptItem; readonly index: number }[]
): string | undefined {
  return entries.findLast(({ entry }) => entry.rewindAfter !== undefined)?.entry.rewindAfter;
}

function nativeTranscriptTurnIds(
  sessionId: string,
  turns: readonly (readonly {
    readonly entry: NativeTranscriptItem;
    readonly index: number;
  }[])[]
): readonly string[] {
  const occurrences = new Map<string, number>();
  return turns.map((entries) => {
    const user = entries.find(
      ({ entry }) => entry.kind === 'message' && entry.role === 'USER'
    )?.entry;
    const first = user ?? entries[0]?.entry;
    const base =
      first?.nativeId ??
      nativeTranscriptSourceIdentity(first) ??
      nativeTranscriptItemFingerprint(first);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return `${sessionId}:native:${base}${occurrence === 0 ? '' : `:${occurrence}`}`;
  });
}

function nativeTranscriptItemIdentities(
  entries: readonly { readonly entry: NativeTranscriptItem; readonly index: number }[]
): readonly string[] {
  const nativeIdCounts = new Map<string, number>();
  for (const { entry } of entries)
    if (entry.nativeId !== undefined)
      nativeIdCounts.set(entry.nativeId, (nativeIdCounts.get(entry.nativeId) ?? 0) + 1);
  const occurrences = new Map<string, number>();
  return entries.map(({ entry }) => {
    const base =
      nativeTranscriptSourceIdentity(entry) ??
      (entry.nativeId !== undefined && nativeIdCounts.get(entry.nativeId) === 1
        ? entry.nativeId
        : `${entry.nativeId === undefined ? '' : `${entry.nativeId}:`}${nativeTranscriptItemFingerprint(entry)}`);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return occurrence === 0 ? base : `${base}:${occurrence}`;
  });
}

function nativeTranscriptSourceIdentity(
  entry: NativeTranscriptItem | undefined
): string | undefined {
  return entry?.sourceItemId === undefined
    ? undefined
    : `source:${createHash('sha256').update(entry.sourceItemId).digest('base64url').slice(0, 24)}`;
}

function nativeTranscriptItemFingerprint(entry: NativeTranscriptItem | undefined): string {
  return createHash('sha256')
    .update(JSON.stringify(entry ?? null))
    .digest('base64url')
    .slice(0, 24);
}

function nativeTranscriptTurns(items: readonly NativeTranscriptItem[]): readonly (readonly {
  readonly entry: NativeTranscriptItem;
  readonly index: number;
}[])[] {
  const turns: { entry: NativeTranscriptItem; index: number }[][] = [];
  let current: { entry: NativeTranscriptItem; index: number }[] = [];
  for (const [index, entry] of items.entries()) {
    if (entry.kind === 'message' && entry.role === 'USER' && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push({ entry, index });
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

function nativeTranscriptConversationItem(
  session: NodeAgentSession,
  entry: NativeTranscriptItem,
  index: number,
  itemIdentity: string,
  turnId: string,
  runtimeTurns: readonly NodeConversationTurn[],
  registerImages: (
    images: readonly NativeTranscriptImageAttachment[]
  ) => readonly Record<string, unknown>[],
  projection: NativeTranscriptProjection
): NodeConversationItem {
  const time = entry.createdAt;
  const isToolCall = entry.kind === 'tool_call';
  const isUnknown = entry.kind === 'unknown';
  const isReasoning = entry.kind === 'reasoning_summary';
  const isContextCompaction = entry.kind === 'context_compaction';
  const normalizedTool = isToolCall ? projection.normalizeTool(entry) : undefined;
  const userInputQuestions = isToolCall ? projection.userInputQuestions(entry) : [];
  const isUserInputRequest = userInputQuestions.length > 0;
  const clientMessageId =
    entry.kind === 'message' && entry.role === 'USER'
      ? nativeUserClientMessageId(projection.userText(entry.text), time, runtimeTurns)
      : null;
  const entryText =
    entry.kind === 'message'
      ? entry.role === 'USER'
        ? projection.userText(entry.text)
        : entry.text
      : '';
  const runtimeUserPayload =
    clientMessageId === null ? undefined : runtimeUserMessagePayload(clientMessageId, runtimeTurns);
  const userAttachments = Array.isArray(runtimeUserPayload?.attachments)
    ? runtimeUserPayload.attachments
    : entry.kind === 'message' && entry.role === 'USER' && entry.imageAttachments !== undefined
      ? registerImages(entry.imageAttachments)
      : [];
  const planText =
    entry.kind === 'message' && entry.role !== 'USER' ? projection.planText(entryText) : undefined;
  const item: NodeConversationItem = {
    id: `${turnId}:item:${itemIdentity}`,
    ...(entry.sourceItemId === undefined ? {} : { sourceItemId: entry.sourceItemId }),
    sessionId: session.id,
    turnId,
    runId: null,
    parentItemId: null,
    sourceSequence: index,
    revision: 0,
    kind: isUserInputRequest
      ? 'user_input_request'
      : isReasoning
        ? 'reasoning'
        : isContextCompaction
          ? 'context_compaction'
          : isToolCall
            ? (normalizedTool?.kind ?? 'tool_call')
            : isUnknown
              ? 'unknown'
              : entry.kind === 'message' && entry.role === 'USER'
                ? 'user_message'
                : planText !== undefined
                  ? 'plan'
                  : 'assistant_message',
    status: 'COMPLETED',
    payload: isUserInputRequest
      ? {
          requestId: `native:${entry.kind === 'tool_call' ? entry.toolUseId : `item-${itemIdentity}`}`,
          questions: userInputQuestions
        }
      : isReasoning
        ? { representation: entry.representation ?? 'unspecified', sections: entry.sections }
        : isContextCompaction
          ? { phase: entry.phase, summary: entry.summary }
          : isToolCall
            ? {
                ...(normalizedTool?.payload ?? {
                  namespace: session.runner,
                  toolName: entry.toolName,
                  title: entry.toolName,
                  inputSummary: entry.inputSummary,
                  outputSummary: entry.outputSummary,
                  progressLabel: null,
                  errorCode: entry.failed ? 'TOOL_EXECUTION_FAILED' : null,
                  truncated: entry.inputTruncated || entry.outputTruncated
                }),
                ...(entry.toolCategory === undefined ? {} : { toolCategory: entry.toolCategory }),
                ...(entry.imageAttachments === undefined
                  ? {}
                  : { attachments: registerImages(entry.imageAttachments) })
              }
            : isUnknown
              ? { sourceEventType: entry.sourceEventType, label: entry.label }
              : entry.kind === 'message' && entry.role === 'USER'
                ? {
                    clientMessageId,
                    text: entryText,
                    contexts: [],
                    delivery: 'ACCEPTED',
                    ...(userAttachments.length === 0 ? {} : { attachments: userAttachments })
                  }
                : planText !== undefined
                  ? { explanation: compactRunnerText(planText, 20_000), steps: [] }
                  : { text: entryText, format: 'markdown', source: 'native-file' },
    startedAt: time,
    completedAt: time
  };
  return item;
}

/**
 * Native history may not retain browser request IDs. While the Node process is alive, match current
 * runtime user messages by content and creation time so native history replaces the optimistic Turn.
 */
export function nativeUserClientMessageId(
  text: string,
  createdAt: number | null,
  runtimeTurns: readonly NodeConversationTurn[]
): string | null {
  const candidates: { readonly clientMessageId: string; readonly createdAt: number | null }[] = [];
  for (const turn of runtimeTurns) {
    const user = turn.items.find((item) => item.kind === 'user_message');
    if (user === undefined || !isPlainRecord(user.payload)) continue;
    const payload = user.payload;
    const clientMessageId =
      typeof payload.clientMessageId === 'string' ? payload.clientMessageId : null;
    if (clientMessageId === null || payload.text !== text) continue;
    const runtimeCreatedAt = user.startedAt ?? turn.startedAt;
    candidates.push({ clientMessageId, createdAt: runtimeCreatedAt ?? null });
  }
  if (createdAt === null) return candidates.length === 1 ? candidates[0]!.clientMessageId : null;
  const timed = candidates
    .filter((candidate) => candidate.createdAt !== null)
    .map((candidate) => ({
      ...candidate,
      distance: Math.abs(createdAt - candidate.createdAt!)
    }))
    .filter((candidate) => candidate.distance <= 60_000)
    .sort((left, right) => left.distance - right.distance);
  return timed[0]?.clientMessageId ?? null;
}

function runtimeUserMessagePayload(
  clientMessageId: string,
  runtimeTurns: readonly NodeConversationTurn[]
): Record<string, unknown> | undefined {
  for (const turn of runtimeTurns) {
    const user = turn.items.find((item) => item.kind === 'user_message');
    if (!isPlainRecord(user?.payload) || user.payload.clientMessageId !== clientMessageId) continue;
    return user.payload;
  }
  return undefined;
}
