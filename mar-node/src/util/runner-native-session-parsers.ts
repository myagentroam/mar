import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { NodeAgentSession } from '../database.js';
import type { NodeConversationItem, NodeConversationTurn } from '../runtime-model.js';
import type {
  NativeSessionHistory,
  NativeTranscriptImageAttachment,
  NativeTranscriptItem
} from '../native-transcript-model.js';
import { stripClaudePlanTag } from '../runner-command-engine.js';
import { publicGoalHistoryText } from '../service/goal-runtime.js';
import { parseCodexComposerImageMarkers } from '../runner/codex/composer-image-markers.js';
import { normalizeCodexTool } from '../runner/codex/tool-normalizer.js';
import {
  normalizeClaudeTool,
  restoreClaudeSubagentTitles
} from '../runner/claude/tool-normalizer.js';
import { compactRunnerText, isPlainRecord, nativePageEnd } from './node-operation-parsers.js';

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

export function extractId(result: unknown, key: 'thread' | 'turn'): string {
  if (
    typeof result === 'object' &&
    result !== null &&
    key in result &&
    typeof (result as Record<string, unknown>)[key] === 'object' &&
    (result as Record<string, unknown>)[key] !== null &&
    typeof ((result as Record<string, unknown>)[key] as Record<string, unknown>)['id'] === 'string'
  ) {
    return ((result as Record<string, unknown>)[key] as Record<string, unknown>)['id'] as string;
  }
  throw new Error(`CODEX_${key.toUpperCase()}_ID_MISSING`);
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

export function extractCodexThreads(result: unknown): readonly {
  readonly id: string;
  readonly source: string | undefined;
  readonly derived: boolean;
  readonly cwd: unknown;
  readonly title: string | undefined;
  readonly titleOrigin: 'OFFICIAL' | 'PREVIEW' | undefined;
}[] {
  if (typeof result !== 'object' || result === null || !('data' in result)) return [];
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const value = entry as {
      id?: unknown;
      sourceKind?: unknown;
      source?: string | { kind?: unknown } | unknown;
      cwd?: unknown;
      name?: unknown;
      preview?: unknown;
    };
    if (typeof value.id !== 'string') return [];
    const source =
      typeof value.sourceKind === 'string'
        ? value.sourceKind
        : typeof value.source === 'string'
          ? value.source
          : typeof value.source === 'object' &&
              value.source !== null &&
              typeof (value.source as { kind?: unknown }).kind === 'string'
            ? ((value.source as { kind: string }).kind as string)
            : undefined;
    const sourceRecord = isPlainRecord(value.source) ? value.source : undefined;
    const derived =
      source === 'subagent' ||
      sourceRecord?.kind === 'subagent' ||
      isPlainRecord(sourceRecord?.subagent) ||
      isPlainRecord(sourceRecord?.subAgent);
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const preview = typeof value.preview === 'string' ? value.preview.trim() : '';
    const title = name || preview || undefined;
    const titleOrigin = name ? 'OFFICIAL' : preview ? 'PREVIEW' : undefined;
    return [{ id: value.id, source, derived, cwd: value.cwd, title, titleOrigin }];
  });
}

export function codexThreadCwd(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('CODEX_THREAD_CWD_INVALID');
  if (!value.startsWith('file:')) return value;
  try {
    return fileURLToPath(value);
  } catch {
    throw new Error('CODEX_THREAD_CWD_INVALID');
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

export function claudeDiscoveredSession(
  value: unknown,
  fallbackCwd: string
):
  | {
      readonly externalSessionId: string;
      readonly cwd: string;
      readonly title?: string;
      readonly titleOrigin?: 'OFFICIAL' | 'PREVIEW';
    }
  | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.isSidechain === true) return undefined;
  const externalSessionId =
    typeof record.sessionId === 'string'
      ? record.sessionId
      : typeof record.id === 'string'
        ? record.id
        : undefined;
  if (externalSessionId === undefined || externalSessionId.length === 0) return undefined;
  const officialTitle = [record.customTitle, record.firstPrompt, record.title].find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0
  );
  const previewTitle =
    typeof record.summary === 'string' && record.summary.trim().length > 0
      ? record.summary
      : undefined;
  const title = officialTitle ?? previewTitle;
  const cwd = typeof record.cwd === 'string' && record.cwd.length > 0 ? record.cwd : fallbackCwd;
  return {
    externalSessionId,
    cwd,
    ...(title === undefined
      ? {}
      : {
          title: title.slice(0, 80),
          titleOrigin: officialTitle === undefined ? ('PREVIEW' as const) : ('OFFICIAL' as const)
        })
  };
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
  const knownClaudeSubagents = restoreClaudeSubagentTitles(
    session.runner === 'claude-code'
      ? history.items
          .slice(0, nativeTurns[start]?.[0]?.index ?? 0)
          .filter((entry) => entry.kind === 'tool_call')
      : []
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
              session.runner,
              nativeUser,
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
          knownClaudeSubagents
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
        ...(after === undefined || session.runner !== 'claude-code'
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
  return entries.findLast(({ entry }) => entry.nativeId !== undefined)?.entry.nativeId;
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
  knownClaudeSubagents: Map<string, string>
): NodeConversationItem {
  const time = entry.createdAt;
  const isToolCall = entry.kind === 'tool_call';
  const isUnknown = entry.kind === 'unknown';
  const isReasoning = entry.kind === 'reasoning_summary';
  const isContextCompaction = entry.kind === 'context_compaction';
  const normalizedClaudeTool =
    session.runner === 'claude-code' && isToolCall
      ? normalizeClaudeTool(
          entry.toolName,
          entry.input,
          entry.outputSummary,
          entry.failed,
          entry.inputTruncated || entry.outputTruncated,
          knownClaudeSubagents,
          entry.claudeResult
        )
      : undefined;
  const normalizedCodexTool =
    session.runner === 'codex' && isToolCall
      ? normalizeCodexTool({
          name: entry.toolName,
          namespace: 'codex',
          rawInput: entry.input,
          inputSummary: entry.inputSummary,
          outputSummary: entry.outputSummary,
          truncated: entry.inputTruncated || entry.outputTruncated,
          ...(entry.imageAttachments === undefined ? {} : { attachments: entry.imageAttachments })
        })
      : undefined;
  const userInputQuestions =
    session.runner === 'claude-code' &&
    isToolCall &&
    entry.toolName === 'AskUserQuestion' &&
    isPlainRecord(entry.input)
      ? claudeUserInputQuestions(entry.input)
      : [];
  const isUserInputRequest = userInputQuestions.length > 0;
  const clientMessageId =
    entry.kind === 'message' && entry.role === 'USER'
      ? nativeUserClientMessageId(session.runner, entry, time, runtimeTurns)
      : null;
  // Claude tagged Plan Mode strips the injected planning instruction label from user content
  // and normalizes a complete <proposed_plan> Agent response into a plan card.
  const entryText =
    entry.kind === 'message'
      ? entry.role === 'USER'
        ? nativeUserMessageText(session.runner, entry.text)
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
    entry.kind === 'message' && entry.role !== 'USER' ? claudePlanText(entryText) : undefined;
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
            ? (normalizedClaudeTool?.kind ?? normalizedCodexTool?.kind ?? 'tool_call')
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
                ...(normalizedClaudeTool?.payload ??
                  normalizedCodexTool?.payload ?? {
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
 * Claude JSONL does not retain browser request IDs. While the Node process is alive, match current
 * runtime user messages by content and creation time so native history replaces the optimistic Turn.
 */
export function nativeUserClientMessageId(
  runner: NodeAgentSession['runner'],
  entry: Extract<NativeSessionHistory['items'][number], { readonly kind: 'message' }>,
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
    // Tagged Plan Mode instruction labels exist only in native transcripts; runtime bubbles retain the original content.
    if (clientMessageId === null || payload.text !== nativeUserMessageText(runner, entry.text))
      continue;
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

function nativeUserMessageText(runner: NodeAgentSession['runner'], text: string): string {
  const withoutPlan = runner === 'claude-code' ? stripClaudePlanTag(text) : text;
  const normalized = publicGoalHistoryText(withoutPlan);
  if (runner !== 'codex') return normalized;
  return parseCodexComposerImageMarkers(normalized).text;
}

/**
 * Normalize the documented App Server `thread/read(includeTurns: true)`
 * result.  Only items with a user-visible Workbench representation are kept;
 * raw protocol envelopes are deliberately never exposed to Web.
 */
export function claudePlanText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('<proposed_plan>') || !/<\/proposed_plan>\s*$/.test(trimmed))
    return undefined;
  const plan = trimmed
    .slice('<proposed_plan>'.length)
    .replace(/<\/proposed_plan>\s*$/, '')
    .trim();
  return plan.length > 0 ? plan : undefined;
}

export function claudeUserInputQuestions(value: Record<string, unknown>): readonly {
  readonly id: string;
  readonly prompt: string;
  readonly input: 'SINGLE_SELECT' | 'MULTI_SELECT' | 'SHORT_TEXT';
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    readonly description: string | null;
  }[];
  readonly allowOther: boolean;
  readonly multiSelect: boolean;
}[] {
  if (!Array.isArray(value.questions) || value.questions.length === 0 || value.questions.length > 4)
    return [];
  const questions = value.questions.map((raw, index) => {
    if (!isPlainRecord(raw) || typeof raw.question !== 'string') return undefined;
    const options = Array.isArray(raw.options)
      ? raw.options.flatMap((option) => {
          if (!isPlainRecord(option) || typeof option.label !== 'string') return [];
          const label = compactRunnerText(option.label, 500);
          return label.length === 0
            ? []
            : [
                {
                  value: label,
                  label,
                  description:
                    typeof option.description === 'string'
                      ? compactRunnerText(option.description, 1_000)
                      : null
                }
              ];
        })
      : [];
    const multiSelect = raw.multiSelect === true;
    return {
      id: `claude-question-${index}`,
      prompt: compactRunnerText(raw.question, 5_000),
      input: options.length === 0 ? 'SHORT_TEXT' : multiSelect ? 'MULTI_SELECT' : 'SINGLE_SELECT',
      options,
      allowOther: true,
      multiSelect
    } as const;
  });
  return questions.some((question) => question === undefined)
    ? []
    : (questions as NonNullable<(typeof questions)[number]>[]);
}
