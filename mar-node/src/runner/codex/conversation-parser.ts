import { fileURLToPath } from 'node:url';
import type { NodeAgentSession } from '../../session/contracts.js';
import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { nodeLog } from '../../operational.js';
import {
  RunnerUsageTracker,
  usageToken,
  type RunnerUsageFact,
  type RunnerUsageValues
} from '../../service/runner-usage-tracker.js';

export class CodexUsageNormalizer {
  private readonly tracker: RunnerUsageTracker;
  private rollout: { path: string; threadId: string; offset: number } | undefined;
  private pendingRead: Promise<void> = Promise.resolve();
  private decoder = new StringDecoder('utf8');
  private partialLine = '';
  private oversizedLine = false;
  constructor(
    identity: string,
    publish: (value: RunnerUsageFact) => void,
    private readonly requestedModel?: string
  ) {
    this.tracker = new RunnerUsageTracker(identity, publish);
  }

  async attachRollout(path: string, threadId: string): Promise<void> {
    await this.pendingRead;
    this.decoder = new StringDecoder('utf8');
    this.partialLine = '';
    this.oversizedLine = false;
    try {
      // Anchor before dispatch. Inherited history and earlier requests never become new usage.
      this.rollout = { path, threadId, offset: (await stat(path)).size };
    } catch {
      this.reportReadFailure();
    }
  }

  get hasRollout(): boolean {
    return this.rollout !== undefined;
  }

  flushRollout(turnId: string, compact: boolean): Promise<void> {
    this.pendingRead = this.pendingRead
      .then(async () => {
        const rollout = this.rollout;
        if (!rollout) return;
        const file = await open(rollout.path, 'r');
        try {
          const end = (await file.stat()).size;
          if (end < rollout.offset || end - rollout.offset > 16 * 1024 * 1024)
            throw new Error('USAGE_NATIVE_READ_LIMIT');
          const buffer = Buffer.alloc(64 * 1024);
          while (rollout.offset < end) {
            const { bytesRead } = await file.read(
              buffer,
              0,
              Math.min(buffer.length, end - rollout.offset),
              rollout.offset
            );
            if (!bytesRead) break;
            rollout.offset += bytesRead;
            this.consumeRollout(this.decoder.write(buffer.subarray(0, bytesRead)), turnId, compact);
          }
        } finally {
          await file.close();
        }
      })
      .catch(() => this.reportReadFailure());
    return this.pendingRead;
  }

  private reportReadFailure(): void {
    this.rollout = undefined;
    nodeLog('model.usage.unavailable', { runner: 'codex', code: 'USAGE_NATIVE_READ_FAILED' });
  }

  private consumeRollout(text: string, turnId: string, compact: boolean): void {
    for (const part of text.split(/(?<=\n)/u)) {
      if (!this.oversizedLine) this.partialLine += part;
      if (this.partialLine.length > 128 * 1024) {
        this.partialLine = '';
        this.oversizedLine = true;
      }
      if (!part.endsWith('\n')) continue;
      if (!this.oversizedLine) {
        try {
          const value: unknown = JSON.parse(this.partialLine);
          if (isPlainRecord(value) && value.type === 'token_usage_record') {
            const receipt = isPlainRecord(value.payload) ? value.payload : undefined;
            if (receipt?.thread_id === this.rollout?.threadId && receipt?.turn_id === turnId)
              this.observe(
                'rawResponse/completed',
                {
                  responseId: receipt.response_id,
                  usage: receipt.usage
                },
                compact
              );
          }
        } catch {
          // Non-receipt and malformed native lines cannot turn into estimated usage.
        }
      }
      this.partialLine = '';
      this.oversizedLine = false;
    }
  }
  observe(method: string, params: Record<string, unknown>, compact: boolean): void {
    // TokenCount.last can replay context/compaction snapshots without a request identity.
    // Only raw response completions are independently additive request facts.
    if (method !== 'rawResponse/completed' || typeof params.responseId !== 'string') return;
    const usage = isPlainRecord(params.usage) ? params.usage : {};
    const inputTokens = usageToken(usage.inputTokens ?? usage.input_tokens);
    const outputTokens = usageToken(usage.outputTokens ?? usage.output_tokens);
    const cacheReadTokens = usageToken(
      usage.cachedInputTokens ??
        usage.cached_input_tokens ??
        (isPlainRecord(usage.input_tokens_details)
          ? usage.input_tokens_details.cached_tokens
          : undefined)
    );
    const cacheWriteTokens = usageToken(
      usage.cacheWriteInputTokens ?? usage.cache_write_input_tokens
    );
    const reasoningTokens = usageToken(
      usage.reasoningOutputTokens ??
        usage.reasoning_output_tokens ??
        (isPlainRecord(usage.output_tokens_details)
          ? usage.output_tokens_details.reasoning_tokens
          : undefined)
    );
    const values: RunnerUsageValues = {
      purpose: compact ? 'compact' : 'conversation',
      agentRole: 'root',
      ...(this.requestedModel ? { requestedModel: this.requestedModel } : {}),
      ...(typeof params.model === 'string' ? { actualModel: params.model } : {}),
      responseId: params.responseId,
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
      ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
      ...(reasoningTokens === undefined ? {} : { reasoningTokens })
    };
    this.tracker.snapshot(params.responseId, values, true, 'partial');
  }
}
import { basename, extname } from 'node:path';
import type { RunnerHistoryImageRegistrar } from '../contracts.js';
import type { NativeTranscriptImageAttachment } from '../../native-transcript-model.js';
import { runnerErrorProjection } from '../runner-error.js';
import { conversationImageAttachmentSchema } from '@myagentroam/protocol';
import type {
  NodeConversationItem,
  NodeConversationTurn,
  NodeMessageAttachmentInput
} from '../../runtime-model.js';
import { parseCodexComposerImageMarkers } from './composer-image-markers.js';
import { normalizeCodexTool } from './tool-normalizer.js';
import { publicOutputSnapshot, shellExecution } from '../execution-presentation.js';
import { publicGoalHistoryText } from '../../service/goal-runtime.js';
const MAX_COMPOSER_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_COMPOSER_ATTACHMENTS_BYTES = 10 * 1024 * 1024;
const MAX_ASSISTANT_MESSAGE_CHARACTERS = 64 * 1024;

import type { PublicConversationItem } from '../../native-transcript-model.js';

/** Only the official thread descriptor can declare history-only Revert support. */
export function codexThreadHistoryModes(
  result: unknown
): readonly { readonly id: string; readonly paginated: boolean }[] {
  if (!isPlainRecord(result)) return [];
  const descriptors = Array.isArray(result.data) ? result.data : [result.thread];
  return descriptors.flatMap((value) =>
    isPlainRecord(value) && typeof value.id === 'string'
      ? [{ id: value.id, paginated: value.historyMode === 'paginated' }]
      : []
  );
}

export function codexPaginatedThread(result: unknown): boolean {
  return (
    isPlainRecord(result) &&
    isPlainRecord(result.thread) &&
    result.thread.historyMode === 'paginated'
  );
}

export function codexPaginatedCursor(sessionId: string, cursor?: string): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      isPlainRecord(value) &&
      value.source === 'codex-paginated' &&
      value.sessionId === sessionId &&
      typeof value.cursor === 'string' &&
      value.cursor.length > 0
    )
      return value.cursor;
  } catch {
    // Invalid or foreign cursors never fall back to JSONL.
  }
  throw new Error('EVENT_CURSOR_INVALID');
}

export function codexPaginatedConversationPage(
  session: NodeAgentSession,
  result: unknown,
  earlierTurnId: string | null,
  managedTurn: (nativeTurnId: string) => NodeConversationTurn | undefined,
  registerImages?: RunnerHistoryImageRegistrar
): { readonly turns: readonly NodeConversationTurn[]; readonly nextCursor: string | null } {
  if (!isPlainRecord(result) || !Array.isArray(result.data))
    throw new Error('NATIVE_TRANSCRIPT_UNAVAILABLE');
  const values = result.data;
  if (
    values.some(
      (value) =>
        !isPlainRecord(value) ||
        typeof value.id !== 'string' ||
        !Array.isArray(value.items) ||
        value.itemsView !== 'full'
    ) ||
    (result.nextCursor !== undefined &&
      result.nextCursor !== null &&
      typeof result.nextCursor !== 'string')
  )
    throw new Error('NATIVE_TRANSCRIPT_UNAVAILABLE');
  const turns = values.flatMap((value, index) => {
    const native = value as Record<string, unknown> & { id: string };
    const turn = codexOfficialTurn(session, native, index, managedTurn(native.id), registerImages);
    if (turn === undefined) return [];
    const earlier = values[index + 1] as { id: string } | undefined;
    return [{ ...turn, rewind: { before: earlier?.id ?? earlierTurnId, after: native.id } }];
  });
  return {
    turns: turns.reverse(),
    nextCursor:
      typeof result.nextCursor === 'string'
        ? Buffer.from(
            JSON.stringify({
              source: 'codex-paginated',
              sessionId: session.id,
              cursor: result.nextCursor
            })
          ).toString('base64url')
        : null
  };
}

export function codexOfficialConversationPage(
  session: NodeAgentSession,
  result: unknown,
  input: { readonly cursor?: string; readonly limit?: number },
  managedTurnForNative: (nativeTurnId: string) => NodeConversationTurn | undefined
):
  | { readonly turns: readonly NodeConversationTurn[]; readonly nextCursor: string | null }
  | undefined {
  if (!isPlainRecord(result) || !isPlainRecord(result.thread)) return undefined;
  const thread = result.thread;
  if (thread.id !== session.externalSessionId || !Array.isArray(thread.turns)) return undefined;
  const parsedTurns = thread.turns.flatMap((value, sequence) => {
    const nativeTurnId =
      typeof value === 'object' && value !== null && typeof value.id === 'string'
        ? value.id
        : undefined;
    const turn = codexOfficialTurn(
      session,
      value,
      sequence,
      nativeTurnId === undefined ? undefined : managedTurnForNative(nativeTurnId)
    );
    return turn === undefined || nativeTurnId === undefined ? [] : [{ nativeTurnId, turn }];
  });
  const allTurns = parsedTurns.map(({ nativeTurnId, turn }, index) => ({
    ...turn,
    rewind: { before: parsedTurns[index - 1]?.nativeTurnId ?? null, after: nativeTurnId }
  }));
  if (allTurns.length === 0) return undefined;
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 500);
  const end = nativePageEnd(input.cursor, session.id, allTurns.length);
  const start = Math.max(0, end - limit);
  return {
    turns: allTurns.slice(start, end),
    nextCursor:
      start > 0
        ? Buffer.from(JSON.stringify({ sessionId: session.id, end: start })).toString('base64url')
        : null
  };
}

export function codexOfficialTurn(
  session: NodeAgentSession,
  value: unknown,
  sequence: number,
  managedTurn: NodeConversationTurn | undefined,
  registerImages?: RunnerHistoryImageRegistrar
): NodeConversationTurn | undefined {
  if (!isPlainRecord(value) || typeof value.id !== 'string' || !Array.isArray(value.items))
    return undefined;
  const status =
    value.status === 'inProgress'
      ? 'RUNNING'
      : value.status === 'failed'
        ? 'FAILED'
        : value.status === 'interrupted'
          ? 'INTERRUPTED'
          : 'SUCCEEDED';
  const startedAt = codexTimestamp(value.startedAt);
  const completedAt = codexTimestamp(value.completedAt) ?? startedAt;
  const items = codexOfficialItems(
    session,
    value.id as string,
    value.items,
    sequence,
    startedAt,
    completedAt,
    registerImages
  );
  if ((status === 'FAILED' || status === 'INTERRUPTED') && isPlainRecord(value.error)) {
    const projected = runnerErrorProjection(value.error, 'CODEX_RUN_FAILED');
    items.push({
      id: `${session.id}:official:${value.id}:error`,
      sessionId: session.id,
      turnId: `${session.id}:official:${value.id}`,
      runId: null,
      parentItemId: null,
      sourceSequence: sequence * 10_000 + value.items.length + 1,
      revision: 0,
      kind: 'error',
      status: 'FAILED',
      startedAt,
      completedAt,
      payload: { ...projected, recoverable: true, retryAfterMs: null }
    });
  }
  if (items.length === 0) return undefined;
  if (managedTurn !== undefined) {
    const officialComplete =
      value.status === 'completed' ||
      value.status === 'failed' ||
      value.status === 'interrupted' ||
      (value.status === undefined && codexTimestamp(value.completedAt) !== null);
    const localUser = managedTurn.items.find((item) => item.kind === 'user_message');
    const officialNativeItemIds = codexNativeItemIds(value.items);
    const officialAssistantCount = items.filter((item) => item.kind === 'assistant_message').length;
    const officialAssistantMessage = officialAssistantCount > 0;
    const managedAssistants = managedTurn.items.filter(
      (item) => item.kind === 'assistant_message' && conversationItemNativeId(item.id) === undefined
    );
    const managedAssistantCandidates =
      officialAssistantCount === 0 ? [] : managedAssistants.slice(-officialAssistantCount);
    const preferLocalAssistant = officialAssistantMessage && !officialComplete;
    const replacedManagedAssistantIds = new Set(
      preferLocalAssistant
        ? []
        : officialAssistantCount === 0
          ? []
          : managedAssistantCandidates.map((item) => item.id)
    );
    const localLiveItems = managedTurn.items.filter((item) => {
      if (item.kind === 'user_message') return false;
      if (preferLocalAssistant && item.kind === 'assistant_message') return true;
      // `item/agentMessage/delta` uses a synthetic runtime ID. Once
      // `thread/read` returns the final Agent message, it is the same reply
      // without a shared native item ID and must replace that transient item.
      if (item.kind === 'assistant_message' && replacedManagedAssistantIds.has(item.id))
        return false;
      const nativeItemId = conversationItemNativeId(item.id);
      return nativeItemId === undefined || !officialNativeItemIds.has(nativeItemId);
    });
    const officialItems = [
      ...retainManagedImageAttachments(
        managedTurn,
        value.id,
        items
          .filter((item) => item.kind !== 'assistant_message' || !preferLocalAssistant)
          .map((item) =>
            item.kind === 'user_message' && localUser !== undefined
              ? { ...localUser, turnId: managedTurn.id }
              : { ...item, turnId: managedTurn.id, runId: managedTurn.runId }
          )
      )
    ];
    if (localUser !== undefined && !officialItems.some((item) => item.kind === 'user_message'))
      officialItems.unshift({ ...localUser, turnId: managedTurn.id });
    const retainedLocalIds = new Set(localLiveItems.map((item) => item.id));
    const consumedOfficialIds = new Set<string>();
    const officialUser = officialItems.find((item) => item.kind === 'user_message');
    const officialAssistants = officialItems.filter((item) => item.kind === 'assistant_message');
    const officialContextCompactions = officialItems.filter(
      (item) => item.kind === 'context_compaction'
    );
    const officialItemMarker = `:official:${value.id}:`;
    const officialByNativeId = new Map(
      officialItems.flatMap((item) => {
        const markerIndex = item.id.lastIndexOf(officialItemMarker);
        return markerIndex < 0
          ? []
          : [[item.id.slice(markerIndex + officialItemMarker.length), item] as const];
      })
    );
    const reconciledItems: NodeConversationItem[] = [];
    for (const managedItem of managedTurn.items) {
      let replacement: NodeConversationItem | undefined;
      if (managedItem.kind === 'user_message') replacement = officialUser;
      else if (managedItem.kind === 'error' && isPlainRecord(managedItem.payload))
        replacement = officialItems.find(
          (item) =>
            item.kind === 'error' &&
            isPlainRecord(item.payload) &&
            isPlainRecord(managedItem.payload) &&
            item.payload.code === managedItem.payload.code &&
            item.payload.message === managedItem.payload.message
        );
      else if (managedItem.kind === 'context_compaction')
        replacement = officialContextCompactions.find((item) => !consumedOfficialIds.has(item.id));
      else {
        const nativeId = conversationItemNativeId(managedItem.id);
        if (nativeId !== undefined) replacement = officialByNativeId.get(nativeId);
        if (
          replacement === undefined &&
          managedItem.kind === 'assistant_message' &&
          replacedManagedAssistantIds.has(managedItem.id)
        )
          replacement = officialAssistants.find((item) => !consumedOfficialIds.has(item.id));
      }
      if (replacement !== undefined) {
        if (!consumedOfficialIds.has(replacement.id)) {
          reconciledItems.push(replacement);
          consumedOfficialIds.add(replacement.id);
        }
      } else if (retainedLocalIds.has(managedItem.id)) reconciledItems.push(managedItem);
    }
    for (const item of officialItems)
      if (!consumedOfficialIds.has(item.id)) reconciledItems.push(item);
    return {
      ...managedTurn,
      status: officialComplete ? status : managedTurn.status,
      // Reconcile against the managed runtime order. Official items replace
      // matching live projections in place; newly visible terminal items such
      // as a plan are appended after the commentary and tools that preceded it.
      items: reconciledItems,
      startedAt,
      completedAt: officialComplete ? completedAt : null
    };
  }
  return {
    id: `${session.id}:official:${value.id}`,
    sessionId: session.id,
    runId: null,
    userItemId: items.find((item) => item.kind === 'user_message')?.id ?? null,
    status,
    model: null,
    effort: null,
    access: null,
    items,
    startedAt,
    completedAt: status === 'RUNNING' ? null : completedAt
  };
}

/**
 * Codex's authoritative thread records omit MAR's Node-local generated-image
 * references. Preserve those references like user-image metadata: cache expiry
 * only makes the bytes unavailable, while the conversation still renders its
 * image placeholder.
 */
export function retainManagedImageAttachments(
  managedTurn: NodeConversationTurn,
  nativeTurnId: string,
  officialItems: readonly NodeConversationItem[]
): readonly NodeConversationItem[] {
  const localAttachments = new Map<string, unknown>();
  for (const item of managedTurn.items) {
    const nativeItemId = conversationItemNativeId(item.id);
    if (nativeItemId === undefined || !isPlainRecord(item.payload)) continue;
    if (!Array.isArray(item.payload.attachments) || item.payload.attachments.length === 0) continue;
    localAttachments.set(nativeItemId, item.payload.attachments);
  }
  if (localAttachments.size === 0) return officialItems;
  const marker = `:official:${nativeTurnId}:`;
  return officialItems.map((item) => {
    if (!isPlainRecord(item.payload) || Array.isArray(item.payload.attachments)) return item;
    const markerIndex = item.id.lastIndexOf(marker);
    if (markerIndex < 0) return item;
    const attachments = localAttachments.get(item.id.slice(markerIndex + marker.length));
    return attachments === undefined
      ? item
      : { ...item, payload: { ...item.payload, attachments } };
  });
}

export function codexNativeItemIds(values: readonly unknown[]): ReadonlySet<string> {
  return new Set(
    values.flatMap((value) => {
      if (!isPlainRecord(value)) return [];
      const id =
        typeof value.call_id === 'string'
          ? value.call_id
          : typeof value.id === 'string'
            ? value.id
            : undefined;
      return id === undefined ? [] : [id];
    })
  );
}

export function conversationItemNativeId(itemId: string): string | undefined {
  if (itemId.startsWith('codex:')) return itemId.slice('codex:'.length);
  const marker = ':codex:';
  const markerIndex = itemId.lastIndexOf(marker);
  return markerIndex < 0 ? undefined : itemId.slice(markerIndex + marker.length);
}

/** Keep a custom tool invocation and its output in one Workbench card. */
export function codexOfficialItems(
  session: NodeAgentSession,
  nativeTurnId: string,
  values: readonly unknown[],
  turnSequence: number,
  startedAt: number | null,
  completedAt: number | null,
  registerImages?: RunnerHistoryImageRegistrar
): NodeConversationItem[] {
  const items: NodeConversationItem[] = [];
  const pairedToolIndexes = new Map<string, number>();
  // App Server preserves execution order within a Turn. Keep that order while
  // merging a paired tool invocation with its output into one Workbench card.
  for (const [itemSequence, value] of values.entries()) {
    let item = codexOfficialItem(
      session,
      nativeTurnId,
      value,
      turnSequence,
      itemSequence,
      startedAt,
      completedAt
    );
    if (item === undefined) continue;
    if (isPlainRecord(value)) {
      const sources = codexOfficialImageSources(value, item.id);
      const attachments = sources.map(
        (source) => registerImages?.([source])[0] ?? { name: source.name, mime: source.mime }
      );
      if (attachments.length > 0 && isPlainRecord(item.payload))
        item = { ...item, payload: { ...item.payload, attachments } };
    }
    // Codex persists one compaction as both `compacted` state and a
    // `context_compacted` event. App Server normalizes both records to
    // consecutive `contextCompaction` items without preserving their source.
    if (item.kind === 'context_compaction' && items.at(-1)?.kind === 'context_compaction') continue;
    const key = codexPairedToolCallId(value);
    if (key === undefined) {
      items.push(item);
      continue;
    }
    const existingIndex = pairedToolIndexes.get(key);
    if (existingIndex === undefined) {
      pairedToolIndexes.set(key, items.length);
      items.push(item);
      continue;
    }
    const previous = items[existingIndex] as NodeConversationItem;
    const invocation =
      isPlainRecord(value) && (value.type === 'custom_tool_call' || value.type === 'function_call')
        ? item
        : previous;
    const result = invocation === item ? previous : item;
    items[existingIndex] = mergeCodexCustomToolItems(invocation, result);
  }
  return [...coalesceImageGenerationItems(items)];
}

function codexLocalImageSource(
  path: string,
  name = basename(path)
): NativeTranscriptImageAttachment {
  const mime = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
  }[extname(path).toLowerCase()];
  return mime === undefined ? { name, mime: 'image/unknown' } : { name, mime, localPath: path };
}

function codexOfficialImageSources(
  value: Record<string, unknown>,
  sourceId: string
): readonly NativeTranscriptImageAttachment[] {
  if (value.type !== 'userMessage') {
    const path =
      value.type === 'imageView'
        ? value.path
        : value.type === 'imageGeneration'
          ? value.savedPath
          : undefined;
    return typeof path === 'string' ? [codexLocalImageSource(path)] : [];
  }
  const images: NativeTranscriptImageAttachment[] = [];
  const paths = new Set<string>();
  let totalBytes = 0;
  const content = Array.isArray(value.content) ? value.content : [];
  for (const part of content) {
    if (!isPlainRecord(part) || images.length >= 5) continue;
    const name = `Image #${images.length + 1}`;
    if (part.type === 'localImage' && typeof part.path === 'string') {
      if (!paths.has(part.path)) {
        paths.add(part.path);
        images.push(codexLocalImageSource(part.path, name));
      }
    } else if (part.type === 'image') {
      const image = codexImageAttachments([{ type: 'input_image', image_url: part.url }])[0];
      const publicMime =
        image !== undefined &&
        conversationImageAttachmentSchema.safeParse({ name, mime: image.mime }).success;
      const byteSize = image === undefined ? 0 : Buffer.byteLength(image.dataBase64, 'base64');
      const readable =
        image !== undefined &&
        publicMime &&
        totalBytes + byteSize <= MAX_COMPOSER_ATTACHMENTS_BYTES;
      if (readable) totalBytes += byteSize;
      images.push(
        !readable || image === undefined
          ? { name, mime: publicMime ? image!.mime : 'image/unknown' }
          : {
              name,
              mime: image.mime,
              byteSize,
              sourceId: `${sourceId}:image:${images.length}`,
              read: async () => ({ ...image, name })
            }
      );
    } else if (part.type === 'text' && typeof part.text === 'string') {
      for (const marker of parseCodexComposerImageMarkers(part.text).images) {
        if (images.length >= 5) break;
        if (!paths.has(marker.localPath)) {
          paths.add(marker.localPath);
          images.push(codexLocalImageSource(marker.localPath, `Image #${marker.index}`));
        }
      }
    }
  }
  return images;
}

export function codexPairedToolCallId(value: unknown): string | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (
    value.type !== 'custom_tool_call' &&
    value.type !== 'custom_tool_call_output' &&
    value.type !== 'function_call' &&
    value.type !== 'function_call_output'
  )
    return undefined;
  return typeof value.call_id === 'string'
    ? value.call_id
    : typeof value.id === 'string'
      ? value.id
      : undefined;
}

export function mergeCodexCustomToolItems(
  invocation: NodeConversationItem,
  result: NodeConversationItem
): NodeConversationItem {
  const invocationPayload = isPlainRecord(invocation.payload) ? invocation.payload : {};
  const resultPayload = isPlainRecord(result.payload) ? result.payload : {};
  if (invocation.kind === 'command_execution')
    return {
      ...invocation,
      status: result.status,
      completedAt: result.completedAt,
      payload: {
        ...invocationPayload,
        outputPreview:
          resultPayload.outputPreview ??
          resultPayload.outputSummary ??
          invocationPayload.outputPreview,
        exitCode: resultPayload.exitCode ?? invocationPayload.exitCode,
        durationMs: resultPayload.durationMs ?? invocationPayload.durationMs,
        truncated: invocationPayload.truncated === true || resultPayload.truncated === true,
        ...(resultPayload.attachments === undefined
          ? {}
          : { attachments: resultPayload.attachments })
      }
    };
  if (invocation.kind !== result.kind) return invocation;
  if (invocation.kind !== 'tool_call') return invocation;
  return {
    ...invocation,
    status: result.status,
    completedAt: result.completedAt,
    payload: {
      ...invocationPayload,
      outputSummary: resultPayload.outputSummary ?? invocationPayload.outputSummary,
      errorCode: resultPayload.errorCode ?? invocationPayload.errorCode,
      truncated: invocationPayload.truncated === true || resultPayload.truncated === true,
      ...(resultPayload.attachments === undefined ? {} : { attachments: resultPayload.attachments })
    }
  };
}

export function coalesceImageGenerationItems(
  items: readonly NodeConversationItem[]
): readonly NodeConversationItem[] {
  const merged: NodeConversationItem[] = [];
  for (const item of items) {
    const payload = isPlainRecord(item.payload) ? item.payload : undefined;
    const previous = merged.at(-1);
    const previousPayload =
      previous !== undefined && isPlainRecord(previous.payload) ? previous.payload : undefined;
    if (
      item.kind !== 'tool_call' ||
      payload?.toolName !== 'imagegen' ||
      previous?.kind !== 'tool_call' ||
      previousPayload?.toolName !== 'imagegen' ||
      previous.id !== item.id
    ) {
      merged.push(item);
      continue;
    }
    const attachments = [
      ...(Array.isArray(previousPayload.attachments) ? previousPayload.attachments : []),
      ...(Array.isArray(payload.attachments) ? payload.attachments : [])
    ];
    merged[merged.length - 1] = {
      ...previous,
      status: item.status,
      completedAt: item.completedAt ?? previous.completedAt,
      payload: {
        ...previousPayload,
        ...payload,
        inputSummary: previousPayload.inputSummary ?? payload.inputSummary,
        attachments
      }
    };
  }
  return merged;
}

export function codexPlanText(value: Record<string, unknown>): string | undefined {
  if (typeof value.type !== 'string' || typeof value.text !== 'string') return undefined;
  const text = value.text.trim();
  if (text.length === 0) return undefined;
  if (value.type.toLocaleLowerCase() === 'plan') return text;
  if (value.type !== 'agentMessage' || !text.startsWith('<proposed_plan>')) return undefined;
  const plan = text
    .slice('<proposed_plan>'.length)
    .replace(/<\/proposed_plan>\s*$/, '')
    .trim();
  return plan.length > 0 ? plan : undefined;
}

/**
 * A final Claude tagged Plan Mode plan is fully wrapped in `<proposed_plan>` tags;
 * text with missing or unclosed tags remains a regular assistant message.
 */
export function codexSourceItemId(nativeTurnId: string, itemId: string): string {
  return JSON.stringify([nativeTurnId, itemId]);
}

export function codexTranscriptSourceItemId(
  record: Record<string, unknown>,
  nativeTurnId: string | undefined
): string | undefined {
  if (
    nativeTurnId === undefined ||
    record.type !== 'response_item' ||
    !isPlainRecord(record.payload)
  )
    return undefined;
  const payload = record.payload;
  const id = typeof payload.call_id === 'string' ? payload.call_id : payload.id;
  return typeof id === 'string'
    ? codexSourceItemId(nativeTurnId, boundedConversationItemId('codex', id))
    : undefined;
}

export function codexOfficialItem(
  session: NodeAgentSession,
  nativeTurnId: string,
  value: unknown,
  turnSequence: number,
  itemSequence: number,
  startedAt: number | null,
  completedAt: number | null
): NodeConversationItem | undefined {
  if (!isPlainRecord(value) || typeof value.type !== 'string' || value.type === 'subAgentActivity')
    return undefined;
  const id =
    (value.type === 'custom_tool_call' ||
      value.type === 'custom_tool_call_output' ||
      value.type === 'function_call' ||
      value.type === 'function_call_output') &&
    typeof value.call_id === 'string'
      ? value.call_id
      : typeof value.id === 'string'
        ? value.id
        : typeof value.call_id === 'string'
          ? value.call_id
          : `${nativeTurnId}:${itemSequence}`;
  const base = {
    id: `${session.id}:official:${nativeTurnId}:${id}`,
    sourceItemId: codexSourceItemId(nativeTurnId, boundedConversationItemId('codex', id)),
    sessionId: session.id,
    turnId: `${session.id}:official:${nativeTurnId}`,
    runId: null,
    parentItemId: null,
    sourceSequence: turnSequence * 10_000 + itemSequence + 1,
    revision: 0,
    status: codexItemStatus(value.status, value.status !== 'inProgress'),
    startedAt,
    completedAt
  } as const;
  if (value.type === 'userMessage') {
    const text = publicGoalHistoryText(codexContentText(value.content));
    const hasImage =
      Array.isArray(value.content) &&
      value.content.some(
        (part) =>
          isPlainRecord(part) &&
          (part.type === 'image' ||
            (part.type === 'localImage' && typeof part.path === 'string') ||
            (part.type === 'text' &&
              typeof part.text === 'string' &&
              parseCodexComposerImageMarkers(part.text).images.length > 0))
      );
    return text.length === 0 && !hasImage
      ? undefined
      : {
          ...base,
          kind: 'user_message',
          payload: { clientMessageId: null, text, contexts: [], delivery: 'ACCEPTED' }
        };
  }
  const planText = codexPlanText(value);
  if (planText !== undefined)
    return { ...base, kind: 'plan', payload: { explanation: planText, steps: [] } };
  if (
    value.type === 'agentMessage' &&
    typeof value.text === 'string' &&
    value.text.trim().length > 0
  )
    return {
      ...base,
      kind: 'assistant_message',
      payload: { text: value.text, format: 'markdown', source: 'codex-app-server' }
    };
  if (value.type === 'reasoning') {
    const sections = Array.isArray(value.summary)
      ? value.summary.flatMap((text, index) =>
          typeof text === 'string' && text.trim().length > 0
            ? [{ index, text: compactRunnerText(text, 10_000) }]
            : []
        )
      : [];
    return { ...base, kind: 'reasoning', payload: { representation: 'summary', sections } };
  }
  if (value.type === 'commandExecution') {
    const output = typeof value.aggregatedOutput === 'string' ? value.aggregatedOutput : '';
    return {
      ...base,
      kind: 'command_execution',
      payload: {
        command:
          typeof value.command === 'string'
            ? compactRunnerText(value.command, 10_000)
            : '(No command provided)',
        cwd: typeof value.cwd === 'string' ? compactRunnerText(value.cwd, 4_096) : null,
        outputPreview: publicOutputSnapshot(output).text,
        exitCode:
          typeof value.exitCode === 'number' && Number.isInteger(value.exitCode)
            ? value.exitCode
            : null,
        durationMs:
          typeof value.durationMs === 'number' &&
          Number.isInteger(value.durationMs) &&
          value.durationMs >= 0
            ? value.durationMs
            : null,
        truncated: output.length > 10_000,
        ...(base.status !== 'IN_PROGRESS'
          ? {
              output:
                typeof value.aggregatedOutput === 'string'
                  ? publicOutputSnapshot(output)
                  : undefined
            }
          : {}),
        toolPresentation: shellExecution(
          base.status === 'IN_PROGRESS' || typeof value.aggregatedOutput !== 'string'
            ? undefined
            : output
        )
      }
    };
  }
  if (value.type === 'mcpToolCall')
    return {
      ...base,
      kind: 'tool_call',
      payload: {
        title: [
          typeof value.server === 'string' ? value.server : '',
          typeof value.tool === 'string' ? value.tool : ''
        ]
          .filter(Boolean)
          .join('.'),
        namespace: typeof value.server === 'string' ? value.server : '',
        toolName: typeof value.tool === 'string' ? value.tool : '',
        inputSummary: codexCompactJson(value.arguments),
        outputSummary: codexCompactJson(value.result),
        ...(value.error === undefined ? {} : { errorCode: codexCompactJson(value.error) })
      }
    };
  if (value.type === 'webSearch')
    return {
      ...base,
      kind: 'tool_call',
      payload: {
        title: 'Web Search',
        namespace: 'web',
        toolName: 'search',
        inputSummary: typeof value.query === 'string' ? value.query : ''
      }
    };
  if (value.type === 'imageGeneration')
    return {
      ...base,
      kind: 'tool_call',
      payload: {
        title: 'imagegen',
        namespace: 'codex',
        toolName: 'imagegen',
        inputSummary: typeof value.revisedPrompt === 'string' ? value.revisedPrompt : null,
        outputSummary:
          value.status === 'completed' ? 'Image generation completed' : 'Image generation failed',
        progressLabel: null,
        errorCode: value.status === 'failed' ? 'IMAGE_GENERATION_FAILED' : null,
        truncated: false,
        toolCategory: 'IMAGE_GENERATION'
      }
    };
  if (
    value.type === 'dynamicToolCall' ||
    value.type === 'custom_tool_call' ||
    value.type === 'custom_tool_call_output' ||
    value.type === 'function_call' ||
    value.type === 'function_call_output' ||
    value.type === 'customToolCall' ||
    value.type === 'customToolCallOutput' ||
    value.type === 'functionCall' ||
    value.type === 'functionCallOutput'
  ) {
    const name =
      typeof value.tool === 'string'
        ? value.tool
        : typeof value.name === 'string'
          ? value.name
          : 'tool';
    const normalized = normalizeCodexTool({
      name,
      namespace: typeof value.namespace === 'string' ? value.namespace : 'codex',
      rawInput: value.arguments ?? value.input,
      inputSummary: codexCompactJson(value.arguments ?? value.input),
      outputSummary: codexToolOutputSummary(value.contentItems ?? value.output),
      outputOnly:
        value.type === 'custom_tool_call_output' ||
        value.type === 'function_call_output' ||
        value.type === 'customToolCallOutput' ||
        value.type === 'functionCallOutput'
    });
    return {
      ...base,
      kind: normalized.kind,
      payload: normalized.payload
    };
  }
  if (value.type === 'fileChange' && Array.isArray(value.changes))
    return {
      ...base,
      kind: 'file_change',
      payload: { changes: normalizeCodexFileChanges(value.changes) }
    };
  if (value.type === 'contextCompaction')
    return {
      ...base,
      kind: 'context_compaction',
      payload: {
        phase: 'COMPLETED',
        summary: 'Context compacted',
        summaryCode: 'CONTEXT_COMPACTED'
      }
    };
  const special = codexSpecialItem(value);
  return special === undefined
    ? codexUnknownOfficialItem(base, value)
    : {
        ...base,
        ...special,
        status: base.status
      };
}

export function codexLiveConversationItem(
  value: Record<string, unknown>,
  completed: boolean,
  imageAttachments: readonly Record<string, unknown>[] = []
): PublicConversationItem | undefined {
  if (typeof value.type !== 'string' || value.type === 'subAgentActivity') return undefined;
  const nativeId =
    typeof value.call_id === 'string'
      ? value.call_id
      : typeof value.id === 'string'
        ? value.id
        : undefined;
  if (nativeId === undefined) return undefined;
  const itemId = boundedConversationItemId('codex', nativeId);
  if (value.type === 'reasoning') {
    const sections = Array.isArray(value.summary)
      ? value.summary.flatMap((text, index) =>
          typeof text === 'string' && text.trim().length > 0
            ? [{ index, text: compactRunnerText(text, 10_000) }]
            : []
        )
      : [];
    return {
      itemId,
      kind: 'reasoning',
      status: completed ? 'COMPLETED' : 'IN_PROGRESS',
      payload: { representation: 'summary', sections }
    };
  }
  const planText = codexPlanText(value);
  if (planText !== undefined)
    return {
      itemId,
      kind: 'plan',
      status: completed ? 'COMPLETED' : 'IN_PROGRESS',
      payload: { explanation: compactRunnerText(planText, 20_000), steps: [] }
    };
  if (value.type === 'agentMessage') {
    if (!completed || typeof value.text !== 'string' || value.text.length === 0) return undefined;
    return {
      itemId,
      kind: 'assistant_message',
      status: 'COMPLETED',
      payload: {
        text: compactRunnerText(value.text, MAX_ASSISTANT_MESSAGE_CHARACTERS),
        format: 'markdown',
        model: null
      }
    };
  }
  if (value.type === 'commandExecution') {
    const output = typeof value.aggregatedOutput === 'string' ? value.aggregatedOutput : '';
    return {
      itemId,
      kind: 'command_execution',
      status: codexItemStatus(value.status, completed),
      payload: {
        command:
          typeof value.command === 'string'
            ? compactRunnerText(value.command, 10_000)
            : '(No command provided)',
        cwd: typeof value.cwd === 'string' ? compactRunnerText(value.cwd, 4_096) : null,
        outputPreview: publicOutputSnapshot(output).text,
        exitCode:
          typeof value.exitCode === 'number' && Number.isInteger(value.exitCode)
            ? value.exitCode
            : null,
        durationMs:
          typeof value.durationMs === 'number' &&
          Number.isInteger(value.durationMs) &&
          value.durationMs >= 0
            ? value.durationMs
            : null,
        truncated: output.length > 10_000,
        ...(completed
          ? {
              output:
                typeof value.aggregatedOutput === 'string'
                  ? publicOutputSnapshot(output)
                  : undefined
            }
          : {}),
        toolPresentation: shellExecution(
          !completed || typeof value.aggregatedOutput !== 'string' ? undefined : output
        )
      }
    };
  }
  if (value.type === 'mcpToolCall') {
    const input = compactRunnerValue(value.arguments, 10_000);
    const output = compactRunnerValue(value.result, 10_000);
    const error = compactRunnerValue(value.error, 80);
    const server = typeof value.server === 'string' ? value.server : 'mcp';
    const tool = typeof value.tool === 'string' ? value.tool : 'tool';
    return {
      itemId,
      kind: 'tool_call',
      status: codexItemStatus(value.status, completed),
      payload: {
        namespace: compactRunnerText(server, 128),
        toolName: compactRunnerText(tool, 128),
        title: compactRunnerText(`${server}.${tool}`, 500),
        inputSummary: input.text || null,
        outputSummary: output.text || null,
        progressLabel: null,
        errorCode: error.text || null,
        truncated: input.truncated || output.truncated || error.truncated
      }
    };
  }
  if (value.type === 'webSearch')
    return {
      itemId,
      kind: 'tool_call',
      status: completed ? 'COMPLETED' : 'IN_PROGRESS',
      payload: {
        namespace: 'web',
        toolName: 'search',
        title: 'Web Search',
        inputSummary:
          typeof value.query === 'string' ? compactRunnerText(value.query, 10_000) : null,
        outputSummary: null,
        progressLabel: completed ? null : 'Searching',
        progressLabelCode: completed ? null : 'SEARCHING',
        errorCode: null,
        truncated: false
      }
    };
  if (value.type === 'fileChange' && Array.isArray(value.changes))
    return {
      itemId,
      kind: 'file_change',
      status: completed ? 'COMPLETED' : 'IN_PROGRESS',
      payload: { changes: normalizeCodexFileChanges(value.changes) },
      merge: true
    };
  if (value.type === 'imageGeneration')
    return {
      itemId,
      kind: 'tool_call',
      status: codexItemStatus(value.status, completed),
      payload: {
        namespace: 'codex',
        toolName: 'imagegen',
        title: 'imagegen',
        inputSummary:
          typeof value.revisedPrompt === 'string'
            ? compactRunnerText(value.revisedPrompt, 10_000)
            : null,
        outputSummary: completed ? 'Image generation completed' : null,
        outputSummaryCode: completed ? 'IMAGE_GENERATION_COMPLETED' : null,
        progressLabel: completed ? null : 'Generating image',
        progressLabelCode: completed ? null : 'GENERATING_IMAGE',
        errorCode: value.status === 'failed' ? 'IMAGE_GENERATION_FAILED' : null,
        truncated: false,
        toolCategory: 'IMAGE_GENERATION',
        ...(imageAttachments.length === 0 ? {} : { attachments: imageAttachments })
      },
      merge: true
    };
  if (value.type === 'contextCompaction')
    return {
      itemId,
      kind: 'context_compaction',
      status: completed ? 'COMPLETED' : 'IN_PROGRESS',
      payload: { phase: completed ? 'COMPLETED' : 'STARTED', summary: null }
    };
  if (
    value.type === 'dynamicToolCall' ||
    value.type === 'custom_tool_call' ||
    value.type === 'custom_tool_call_output' ||
    value.type === 'function_call' ||
    value.type === 'function_call_output' ||
    value.type === 'customToolCall' ||
    value.type === 'customToolCallOutput' ||
    value.type === 'functionCall' ||
    value.type === 'functionCallOutput'
  ) {
    const name =
      typeof value.tool === 'string'
        ? value.tool
        : typeof value.name === 'string'
          ? value.name
          : 'tool';
    const input = compactRunnerValue(value.arguments ?? value.input, 10_000);
    const output = compactRunnerValue(codexToolOutput(value.contentItems ?? value.output), 10_000);
    const outputOnly =
      value.type === 'custom_tool_call_output' ||
      value.type === 'function_call_output' ||
      value.type === 'customToolCallOutput' ||
      value.type === 'functionCallOutput';
    const normalized = normalizeCodexTool({
      name,
      namespace: typeof value.namespace === 'string' ? value.namespace : 'codex',
      rawInput: value.arguments ?? value.input,
      inputSummary: input.text || null,
      outputSummary: output.text || null,
      truncated: input.truncated || output.truncated,
      outputOnly,
      attachments: imageAttachments
    });
    return {
      itemId,
      kind: normalized.kind,
      status: codexItemStatus(value.status, completed),
      payload: normalized.payload,
      merge: true
    };
  }
  const special = codexSpecialItem(value);
  return special === undefined
    ? codexUnknownLiveItem(itemId, value.type, completed)
    : {
        itemId,
        kind: special.kind,
        status:
          special.kind === 'tool_call' ? codexItemStatus(value.status, completed) : 'COMPLETED',
        payload: special.payload,
        merge: special.kind === 'tool_call'
      };
}

function normalizeCodexFileChanges(
  changes: readonly unknown[]
): readonly Record<string, unknown>[] {
  return changes.flatMap((value) => {
    if (!isPlainRecord(value) || typeof value.path !== 'string') return [];
    const path = compactRunnerText(value.path, 4_096);
    if (path.length === 0) return [];
    const rawChange = typeof value.change === 'string' ? value.change : value.kind;
    const change =
      rawChange === 'add' || rawChange === 'added' || rawChange === 'ADDED'
        ? 'ADDED'
        : rawChange === 'delete' || rawChange === 'deleted' || rawChange === 'DELETED'
          ? 'DELETED'
          : rawChange === 'rename' || rawChange === 'renamed' || rawChange === 'RENAMED'
            ? 'RENAMED'
            : 'MODIFIED';
    return [
      {
        path,
        change,
        additions: nonnegativeIntegerOrNull(value.additions),
        deletions: nonnegativeIntegerOrNull(value.deletions)
      }
    ];
  });
}

function nonnegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function codexSpecialItem(
  value: Record<string, unknown>
):
  | { readonly kind: 'tool_call' | 'warning'; readonly payload: Record<string, unknown> }
  | undefined {
  if (value.type === 'sleep') {
    const durationMs = nonnegativeIntegerOrNull(value.durationMs);
    return {
      kind: 'tool_call',
      payload: normalizeCodexTool({
        name: 'clock.sleep',
        namespace: 'clock',
        inputSummary: durationMs === null ? null : `${durationMs} ms`
      }).payload
    };
  }
  if (value.type === 'imageView')
    return {
      kind: 'tool_call',
      payload: normalizeCodexTool({
        name: 'view_image',
        namespace: 'codex',
        inputSummary: typeof value.path === 'string' ? compactRunnerText(value.path, 4_096) : null
      }).payload
    };
  if (value.type === 'collabAgentToolCall') {
    const names: Record<string, string> = {
      spawnAgent: 'spawn_agent',
      sendInput: 'send_input',
      resumeAgent: 'resume_agent',
      wait: 'wait_agent',
      closeAgent: 'close_agent',
      sendMessage: 'send_message',
      followupTask: 'followup_task',
      interruptAgent: 'interrupt_agent',
      listAgents: 'list_agents'
    };
    const toolName = typeof value.tool === 'string' ? names[value.tool] : undefined;
    if (toolName === undefined) return undefined;
    const targets = Array.isArray(value.receiverThreadIds)
      ? value.receiverThreadIds.filter((id): id is string => typeof id === 'string')
      : [];
    const input = {
      ...(typeof value.prompt === 'string' ? { prompt: value.prompt } : {}),
      ...(targets.length === 1 ? { target: targets[0] } : {}),
      ...(targets.length > 1 ? { receiverThreadIds: targets } : {}),
      ...(typeof value.model === 'string' ? { model: value.model } : {})
    };
    const normalized = normalizeCodexTool({
      name: toolName,
      namespace: 'collaboration',
      rawInput: input,
      inputSummary: codexCompactJson(input) || null,
      outputSummary:
        codexCompactJson({
          status: value.status,
          agentsStates: value.agentsStates
        }) || null
    });
    const effort = value.reasoningEffort;
    const modelId = typeof value.model === 'string' ? compactRunnerText(value.model, 128) : '';
    return {
      kind: 'tool_call',
      payload: {
        ...normalized.payload,
        ...(modelId ? { subagentModelId: modelId } : {}),
        ...(typeof effort === 'string' &&
        ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)
          ? { subagentReasoningEffort: effort }
          : {})
      }
    };
  }
  const notice = codexNotice(value);
  return notice === undefined
    ? undefined
    : {
        kind: 'warning',
        payload: { code: notice.code, message: notice.message, recoverable: true }
      };
}

function codexNotice(
  value: Record<string, unknown>
): { readonly code: string; readonly message: string } | undefined {
  if (value.type === 'hookPrompt') {
    const count = Array.isArray(value.fragments) ? value.fragments.length : 0;
    return {
      code: 'CODEX_HOOK_PROMPT',
      message: `Hook prompt added (${count} ${count === 1 ? 'fragment' : 'fragments'}).`
    };
  }
  if (value.type === 'enteredReviewMode' || value.type === 'exitedReviewMode') {
    const action = value.type === 'enteredReviewMode' ? 'Entered' : 'Exited';
    const review = typeof value.review === 'string' ? compactRunnerText(value.review, 400) : '';
    return {
      code: value.type === 'enteredReviewMode' ? 'CODEX_REVIEW_STARTED' : 'CODEX_REVIEW_ENDED',
      message: `${action} review mode${review ? `: ${review}` : ''}`
    };
  }
  return undefined;
}

function codexUnknownOfficialItem(
  base: Omit<NodeConversationItem, 'kind' | 'payload'>,
  value: Record<string, unknown>
): NodeConversationItem | undefined {
  if (value.type === 'userMessage' || value.type === 'agentMessage') return undefined;
  const type = typeof value.type === 'string' ? value.type : 'unknown';
  return {
    ...base,
    kind: 'unknown',
    payload: { sourceEventType: `codex:${type}`, label: `Codex ${compactRunnerText(type, 128)}` }
  };
}

function codexUnknownLiveItem(
  itemId: string,
  type: string,
  completed: boolean
): PublicConversationItem | undefined {
  if (type === 'userMessage' || type === 'agentMessage') return undefined;
  return {
    itemId,
    kind: 'unknown',
    status: completed ? 'COMPLETED' : 'IN_PROGRESS',
    payload: { sourceEventType: `codex:${type}`, label: `Codex ${compactRunnerText(type, 128)}` }
  };
}

export function codexImageAttachments(value: unknown): readonly NodeMessageAttachmentInput[] {
  const found: NodeMessageAttachmentInput[] = [];
  let totalBytes = 0;
  const visit = (current: unknown, depth: number): void => {
    if (found.length >= 5 || depth > 4 || current === null || current === undefined) return;
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry, depth + 1);
      return;
    }
    if (!isPlainRecord(current)) return;
    const type = typeof current.type === 'string' ? current.type : '';
    if (type === 'input_text' && typeof current.text === 'string') {
      const embeddedImage = /["']image_url["']\s*:\s*["'](data:image\/[^"']+)["']/.exec(
        current.text
      )?.[1];
      if (embeddedImage !== undefined) {
        visit({ type: 'input_image', image_url: embeddedImage }, depth + 1);
      }
    }
    const rawData = typeof current.data === 'string' ? current.data : undefined;
    const rawUrl = isPlainRecord(current.image_url)
      ? typeof current.image_url.url === 'string'
        ? current.image_url.url
        : undefined
      : typeof current.image_url === 'string'
        ? current.image_url
        : undefined;
    const data = rawData ?? (rawUrl?.startsWith('data:') ? rawUrl : undefined);
    if (
      (type === 'image' || type === 'input_image' || type === 'output_image') &&
      data !== undefined
    ) {
      const match = /^data:([^;,]+);base64,(.*)$/.exec(data);
      const mime =
        typeof current.mimeType === 'string'
          ? current.mimeType
          : typeof current.mime === 'string'
            ? current.mime
            : (match?.[1] ?? 'image/png');
      const dataBase64 = match?.[2] ?? data;
      if (
        mime.startsWith('image/') &&
        isCanonicalBase64(dataBase64) &&
        dataBase64.length > 0 &&
        Buffer.byteLength(dataBase64, 'base64') <= MAX_COMPOSER_ATTACHMENT_BYTES &&
        totalBytes + Buffer.byteLength(dataBase64, 'base64') <= MAX_COMPOSER_ATTACHMENTS_BYTES
      ) {
        totalBytes += Buffer.byteLength(dataBase64, 'base64');
        found.push({
          name:
            typeof current.name === 'string'
              ? current.name
              : `generated-image-${found.length + 1}.png`,
          mime,
          dataBase64
        });
      }
    }
    for (const [key, child] of Object.entries(current)) {
      if (key === 'data' || key === 'image_url') continue;
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return found;
}

export function codexUserInputQuestions(value: unknown): readonly {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    readonly description: string | null;
  }[];
  readonly allowOther: boolean;
}[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) return [];
  const questions = value.map((raw) => {
    if (!isPlainRecord(raw) || typeof raw.id !== 'string' || typeof raw.question !== 'string')
      return undefined;
    const options = Array.isArray(raw.options)
      ? raw.options.flatMap((option) =>
          isPlainRecord(option) && typeof option.label === 'string'
            ? [
                {
                  value: compactRunnerText(option.label, 500),
                  label: compactRunnerText(option.label, 500),
                  description:
                    typeof option.description === 'string'
                      ? compactRunnerText(option.description, 1_000)
                      : null
                }
              ]
            : []
        )
      : [];
    return {
      id: compactRunnerText(raw.id, 128),
      prompt: compactRunnerText(raw.question, 5_000),
      options,
      allowOther: raw.isOther === true
    };
  });
  return questions.some((question) => question === undefined)
    ? []
    : (questions as NonNullable<(typeof questions)[number]>[]);
}

export function codexItemStatus(
  value: unknown,
  completed: boolean
): PublicConversationItem['status'] {
  if (value === 'failed') return 'FAILED';
  if (value === 'declined') return 'DECLINED';
  if (value === 'interrupted') return 'INTERRUPTED';
  return completed || value === 'completed' ? 'COMPLETED' : 'IN_PROGRESS';
}

export function codexContentText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const text = value
    .flatMap((part) => {
      if (typeof part === 'string') return [part];
      if (!isPlainRecord(part)) return [];
      return typeof part.text === 'string' ? [part.text] : [];
    })
    .join('\n')
    .trim();
  return parseCodexComposerImageMarkers(text).text.trim();
}

export function codexCompactJson(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return compactRunnerText(value, 10_000);
  try {
    return compactRunnerText(JSON.stringify(value), 10_000);
  } catch {
    return '';
  }
}

export function codexToolOutputSummary(value: unknown): string {
  return codexCompactJson(codexToolOutput(value));
}

/** App Server custom output is an array of text blocks, not JSON to show verbatim. */
export function codexToolOutput(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const text = value.flatMap((block) => {
    if (typeof block === 'string') return [block];
    if (!isPlainRecord(block)) return [];
    if (typeof block.text === 'string') {
      const visible = codexVisibleToolText(block.text);
      return visible.length > 0 ? [visible] : [];
    }
    if (typeof block.content === 'string') return [block.content];
    return [];
  });
  return text.length > 0
    ? text.join('')
    : value.some(isCodexImageBlock)
      ? 'Image generated'
      : value;
}

export function codexVisibleToolText(value: string): string {
  return value.replace(
    /(["']image_url["']\s*:\s*["'])data:image\/[^"']+(["'])/g,
    '$1[Image content extracted]$2'
  );
}

export function isCodexImageBlock(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return value.type === 'image' || value.type === 'input_image' || value.type === 'output_image';
}

import {
  compactRunnerText,
  compactRunnerValue,
  boundedConversationItemId,
  nativePageEnd
} from '../normalization.js';
import { isPlainRecord } from '../../util/records.js';
import { isCanonicalBase64 } from '../../session/attachments.js';

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

export function extractCodexThreads(result: unknown): readonly {
  readonly id: string;
  readonly source: string | undefined;
  readonly derived: boolean;
  readonly cwd: unknown;
  readonly title: string | undefined;
  readonly titleOrigin: 'OFFICIAL' | 'PREVIEW' | undefined;
  readonly lastActivityAt: number;
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
      updatedAt?: unknown;
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
    return [
      {
        id: value.id,
        source,
        derived,
        cwd: value.cwd,
        title,
        titleOrigin,
        lastActivityAt: codexTimestamp(value.updatedAt) ?? 0
      }
    ];
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

export function codexTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value))
    return value < 10_000_000_000 ? value * 1_000 : value;
  if (typeof value === 'string') {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? null : timestamp;
  }
  return null;
}
