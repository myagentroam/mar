import { createHash } from 'node:crypto';
import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { RunnerName } from '@myagentroam/protocol';
import {
  forEachJsonlRecord,
  listJsonlFiles,
  mapConcurrent,
  readJsonlBackwardWindow,
  readJsonlFileAnchor,
  readJsonlWindow
} from './native-jsonl-reader.js';
import { nodeLog } from './operational.js';
import { stripClaudePlanTag } from './runner-command-engine.js';
import { stripGoalStartPrompt } from './service/goal-runtime.js';
import { parseCodexComposerImageMarkers } from './runner/codex/composer-image-markers.js';
import {
  extractClaudeToolResults,
  type ClaudeToolResultMetadata
} from './runner/claude/tool-normalizer.js';

const DISCOVERY_READ_BYTES = 32 * 1024;
const TRANSCRIPT_HEADER_READ_BYTES = 32 * 1024;
const TRANSCRIPT_READ_MAX_BYTES = 16 * 1024 * 1024;
const TRANSCRIPT_MIN_LINES = 256;
const TRANSCRIPT_MAX_LINES = 4096;
const TRANSCRIPT_LINES_PER_TURN = 32;
const CONTEXT_USAGE_READ_BYTES = 256 * 1024;
const CLAUDE_CONTEXT_USAGE_READ_BYTES = [CONTEXT_USAGE_READ_BYTES, 1024 * 1024, 4 * 1024 * 1024];
const TRANSCRIPT_INDEX_TTL_MS = 60 * 60_000;
const DISCOVERY_SNAPSHOT_TTL_MS = 15_000;
const TRANSCRIPT_DETAIL_CACHE_TTL_MS = 60_000;
const TRANSCRIPT_DETAIL_CACHE_MAX_ENTRIES = 16;
const transcriptIndex = new Map<string, string>();
const transcriptIndexTimers = new Map<string, NodeJS.Timeout>();
const transcriptDetailCache = new Map<
  string,
  {
    readonly fingerprint: string;
    readonly parsed: NativeSessionHistory | undefined;
    expiresAt: number;
  }
>();
const transcriptDetailReads = new Map<
  string,
  { readonly fingerprint: string; readonly read: Promise<NativeSessionHistory | undefined> }
>();
const discoveryReads = new Map<string, Promise<readonly NativeSessionHistory[]>>();
const discoverySnapshots = new Map<string, NativeDiscoverySnapshot>();
const discoveryGenerations = new Map<string, number>();

interface NativeDiscoveryFile {
  readonly fingerprint: string;
  readonly parsed: NativeSessionHistory | undefined;
}

interface NativeDiscoverySnapshot {
  readonly expiresAt: number;
  readonly files: ReadonlyMap<string, NativeDiscoveryFile>;
  readonly sessions: readonly NativeSessionHistory[];
  cacheHits: number;
}

export interface NativeTranscriptMessage {
  readonly kind: 'message';
  readonly role: 'USER' | 'ASSISTANT';
  readonly text: string;
  /** Metadata only: Composer image bytes and local paths are never sent to Web. */
  readonly imageAttachments?: readonly NativeTranscriptImageAttachment[];
  readonly createdAt: number | null;
  readonly nativeId?: string;
  /** Runner-provided native Turn boundary for non-destructive branching. */
  readonly nativeTurnId?: string;
}

export interface NativeTranscriptToolCall {
  readonly kind: 'tool_call';
  readonly toolUseId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly inputSummary: string | null;
  readonly inputTruncated: boolean;
  readonly outputSummary: string | null;
  readonly outputTruncated: boolean;
  readonly claudeResult?: ClaudeToolResultMetadata;
  readonly toolCategory?: 'IMAGE_GENERATION';
  /** Metadata only: native transcript image bytes are never retained here. */
  readonly imageAttachments?: readonly NativeTranscriptImageAttachment[];
  readonly failed: boolean;
  readonly createdAt: number | null;
  readonly nativeId?: string;
}

export interface NativeTranscriptUnknown {
  readonly kind: 'unknown';
  readonly sourceEventType: string;
  readonly label: string;
  readonly createdAt: number | null;
  readonly nativeId?: string;
}

export interface NativeTranscriptReasoningSummary {
  readonly kind: 'reasoning_summary';
  readonly sections: readonly { readonly index: number; readonly text: string }[];
  readonly createdAt: number | null;
  readonly nativeId?: string;
}

export interface NativeTranscriptContextCompaction {
  readonly kind: 'context_compaction';
  readonly phase: 'COMPLETED';
  readonly summary: string | null;
  readonly createdAt: number | null;
  readonly nativeId?: string;
}

export interface NativeTranscriptImageAttachment {
  readonly name: string;
  readonly mime: string;
  readonly byteSize?: number;
  /** Runner-owned local artifact path; never sent to Web. */
  readonly localPath?: string;
  /** Stable source identity for a Runner-owned file or lazy reader. */
  readonly sourceId?: string;
  /** Loads image bytes only after an explicit preview request. */
  readonly read?: () => Promise<
    { readonly name: string; readonly mime: string; readonly dataBase64: string } | undefined
  >;
}

export type NativeTranscriptItem =
  | NativeTranscriptMessage
  | NativeTranscriptToolCall
  | NativeTranscriptReasoningSummary
  | NativeTranscriptContextCompaction
  | NativeTranscriptUnknown;

export interface NativeSessionHistory {
  readonly runner: RunnerName;
  readonly externalSessionId: string;
  readonly cwd: string;
  readonly title?: string;
  readonly digest: string;
  readonly items: readonly NativeTranscriptItem[];
  /**
   * Latest timestamp of a visible conversation or tool item.  Filesystem
   * metadata is deliberately excluded: runners can rewrite transcript-side
   * metadata without adding a user-visible conversation record.
   */
  readonly lastActivityAt: number;
  /** The bounded reader omitted bytes between its header and tail windows. */
  readonly truncated?: boolean;
  /** Opaque paging facts for reading the preceding newline-aligned JSONL window. */
  readonly windowStart?: number;
  readonly windowEnd?: number;
  readonly snapshotEnd?: number;
  readonly fileAnchor?: string;
  readonly anchorBytes?: number;
  /** The supplied page cursor no longer matched this transcript. */
  readonly cursorReset?: boolean;
  /** Page-size input used to derive the stable JSONL line window. */
  readonly windowReadLimit?: number;
}

/** Actual context-window facts emitted by the Codex native transcript. */
export interface NativeCodexContextUsage {
  readonly usedTokens: number;
  readonly maxTokens: number;
}

export interface NativeClaudeContextUsage {
  readonly model: string;
  readonly usedTokens: number;
  readonly maxTokens: number;
}

const DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS = 200_000;
const CLAUDE_CONTEXT_WINDOW_ENV = 'MAR_CLAUDE_CONTEXT_WINDOW_TOKENS';

/**
 * Read-only adapter for the supported vendor JSONL stores.  It requires an
 * explicit cwd on the record and returns normalized visible messages and tool
 * cards; no raw vendor events or hidden reasoning are exposed to the Workbench.
 */
export async function discoverNativeSessions(
  runner: RunnerName,
  workspacePath: string
): Promise<readonly NativeSessionHistory[]> {
  const wanted = canonical(workspacePath);
  return (await discoverAllNativeSessions(runner)).filter(
    (value) => canonical(value.cwd) === wanted
  );
}

/**
 * Reads every supported transcript header before applying a Workspace filter.
 * A short Runner-level snapshot is shared across Workspaces and refreshes only
 * files whose size or modification time changed. A fixed file-count cutoff
 * would silently hide older sessions from a project with a large global history.
 */
export async function discoverAllNativeSessions(
  runner: RunnerName
): Promise<readonly NativeSessionHistory[]> {
  const key = discoveryKey(runner);
  const snapshot = discoverySnapshots.get(key);
  if (snapshot !== undefined && snapshot.expiresAt > Date.now()) {
    snapshot.cacheHits += 1;
    return snapshot.sessions;
  }
  const current = discoveryReads.get(key);
  if (current !== undefined) {
    nodeLog('native.session.discovery.single-flight-joined', { runner });
    return current;
  }
  const generation = discoveryGenerations.get(key) ?? 0;
  const discovery = performNativeSessionDiscovery(runner, snapshot)
    .then((next) => {
      if ((discoveryGenerations.get(key) ?? 0) === generation) discoverySnapshots.set(key, next);
      return next.sessions;
    })
    .finally(() => {
      if (discoveryReads.get(key) === discovery) discoveryReads.delete(key);
    });
  discoveryReads.set(key, discovery);
  return discovery;
}

async function performNativeSessionDiscovery(
  runner: RunnerName,
  previous: NativeDiscoverySnapshot | undefined
): Promise<NativeDiscoverySnapshot> {
  const startedAt = performance.now();
  const found = new Map<string, NativeSessionHistory>();
  nodeLog('native.session.discovery.started', { runner });
  const files = (await listJsonlFiles(transcriptRoot(runner))).filter(
    (path) => runner !== 'claude-code' || !path.split(/[\\/]/u).includes('subagents')
  );
  nodeLog('native.session.discovery.files-listed', {
    runner,
    files: files.length,
    durationMs: Math.round(performance.now() - startedAt)
  });
  let completed = 0;
  let parsedCount = 0;
  let reusedCount = 0;
  let metadataFailures = 0;
  let metadataWorkMs = 0;
  let parseWorkMs = 0;
  const discoveredFiles = await mapConcurrent(files, 32, async (path) => {
    let fingerprint: string;
    const metadataStartedAt = performance.now();
    try {
      const metadata = await stat(path);
      fingerprint = `${metadata.size}:${metadata.mtimeMs}`;
    } catch {
      metadataFailures += 1;
      return undefined;
    } finally {
      metadataWorkMs += performance.now() - metadataStartedAt;
    }
    const cached = previous?.files.get(path);
    let parsed: NativeSessionHistory | undefined;
    if (cached?.fingerprint === fingerprint) {
      parsed = cached.parsed;
      reusedCount += 1;
    } else {
      const parseStartedAt = performance.now();
      parsed = await readTranscript(path, runner, DISCOVERY_READ_BYTES);
      parseWorkMs += performance.now() - parseStartedAt;
      parsedCount += 1;
    }
    completed += 1;
    if (completed % 250 === 0)
      nodeLog('native.session.discovery.progress', {
        runner,
        completed,
        files: files.length,
        parsedFiles: parsedCount,
        reusedFiles: reusedCount,
        metadataFailures,
        metadataWorkMs: Math.round(metadataWorkMs),
        parseWorkMs: Math.round(parseWorkMs),
        durationMs: Math.round(performance.now() - startedAt)
      });
    return { path, fingerprint, parsed };
  });
  const snapshotFiles = new Map<string, NativeDiscoveryFile>();
  for (const file of discoveredFiles) {
    if (file === undefined) continue;
    snapshotFiles.set(file.path, { fingerprint: file.fingerprint, parsed: file.parsed });
    const parsed = file.parsed;
    // Discovery only needs a session identity, cwd and an optional early
    // title. Loading entire JSONL files here made opening a Workspace depend
    // on the total history of every other project on the Node.
    if (parsed === undefined) continue;
    const cwd = canonical(parsed.cwd);
    setTranscriptIndex(indexKey(runner, cwd, parsed.externalSessionId), file.path);
    found.set(`${cwd}\u0000${parsed.externalSessionId}`, parsed);
  }
  nodeLog('native.session.discovery.completed', {
    runner,
    files: files.length,
    sessions: found.size,
    parsedFiles: parsedCount,
    reusedFiles: reusedCount,
    unparsedFiles: [...snapshotFiles.values()].filter((file) => file.parsed === undefined).length,
    metadataFailures,
    metadataWorkMs: Math.round(metadataWorkMs),
    parseWorkMs: Math.round(parseWorkMs),
    cacheMode: previous === undefined ? 'cold' : 'refresh',
    previousCacheHits: previous?.cacheHits ?? 0,
    durationMs: Math.round(performance.now() - startedAt)
  });
  return {
    expiresAt: Date.now() + DISCOVERY_SNAPSHOT_TTL_MS,
    files: snapshotFiles,
    sessions: [...found.values()],
    cacheHits: 0
  };
}

/** Reads one already-discovered external session again to follow appended JSONL records. */
export async function readNativeSession(
  runner: RunnerName,
  workspacePath: string,
  externalSessionId: string,
  page?: {
    readonly snapshotEnd: number;
    readonly nextEnd: number;
    readonly fileAnchor: string;
    readonly anchorBytes: number;
    readonly readLimit?: number;
  },
  limit = 30
): Promise<NativeSessionHistory | undefined> {
  const wanted = canonical(workspacePath);
  const path = getTranscriptIndex(indexKey(runner, wanted, externalSessionId));
  if (path === undefined) return undefined;
  const detail = await readTranscriptDetail(path, runner, page, page?.readLimit ?? limit);
  const parsed = detail?.history;
  if (
    parsed === undefined ||
    parsed.externalSessionId !== externalSessionId ||
    canonical(parsed.cwd) !== wanted
  ) {
    deleteTranscriptIndex(indexKey(runner, wanted, externalSessionId));
    return undefined;
  }
  return detail?.cursorAccepted === false ? { ...parsed, cursorReset: true } : parsed;
}

async function readTranscriptDetail(
  path: string,
  runner: RunnerName,
  page:
    | {
        readonly snapshotEnd: number;
        readonly nextEnd: number;
        readonly fileAnchor: string;
        readonly anchorBytes: number;
        readonly readLimit?: number;
      }
    | undefined,
  limit: number
): Promise<
  | { readonly history: NativeSessionHistory | undefined; readonly cursorAccepted: boolean }
  | undefined
> {
  let fingerprint: string;
  try {
    const metadata = await stat(path);
    fingerprint = `${metadata.size}:${metadata.mtimeMs}`;
  } catch {
    return undefined;
  }
  const metadataSize = Number(fingerprint.slice(0, fingerprint.indexOf(':')));
  const validPage =
    page !== undefined &&
    page.snapshotEnd <= metadataSize &&
    (await readJsonlFileAnchor(path, page.anchorBytes)) === page.fileAnchor
      ? page
      : undefined;
  const targetLines = Math.min(
    TRANSCRIPT_MAX_LINES,
    Math.max(TRANSCRIPT_MIN_LINES, Math.max(1, limit) * TRANSCRIPT_LINES_PER_TURN)
  );
  const pageKey = `${
    validPage === undefined
      ? 'latest'
      : `${validPage.fileAnchor}:${validPage.snapshotEnd}:${validPage.nextEnd}`
  }:${targetLines}`;
  const key = `${runner}\u0000${path}\u0000${pageKey}`;
  const cacheFingerprint =
    validPage === undefined ? fingerprint : `${validPage.fileAnchor}:${validPage.snapshotEnd}`;
  const cached = transcriptDetailCache.get(key);
  if (cached?.fingerprint === cacheFingerprint && cached.expiresAt > Date.now()) {
    cached.expiresAt = Date.now() + TRANSCRIPT_DETAIL_CACHE_TTL_MS;
    transcriptDetailCache.delete(key);
    transcriptDetailCache.set(key, cached);
    return {
      history: cached.parsed,
      cursorAccepted: page === undefined || validPage !== undefined
    };
  }
  transcriptDetailCache.delete(key);
  const current = transcriptDetailReads.get(key);
  if (current?.fingerprint === cacheFingerprint) {
    nodeLog('native.session.history.single-flight-joined', { runner });
    return {
      history: await current.read,
      cursorAccepted: page === undefined || validPage !== undefined
    };
  }
  const startedAt = performance.now();
  const read = readTranscript(path, runner, TRANSCRIPT_READ_MAX_BYTES, validPage, targetLines)
    .then((parsed) =>
      parsed === undefined ? undefined : { ...parsed, windowReadLimit: page?.readLimit ?? limit }
    )
    .then((parsed) => {
      if (transcriptDetailReads.get(key)?.read === read) {
        transcriptDetailCache.set(key, {
          fingerprint: cacheFingerprint,
          parsed,
          expiresAt: Date.now() + TRANSCRIPT_DETAIL_CACHE_TTL_MS
        });
        pruneTranscriptDetailCache();
      }
      const durationMs = Math.round(performance.now() - startedAt);
      if (durationMs >= 250)
        nodeLog('native.session.history.detail-parse.completed', {
          runner,
          bytes: Number(fingerprint.slice(0, fingerprint.indexOf(':'))),
          durationMs
        });
      return parsed;
    })
    .finally(() => {
      if (transcriptDetailReads.get(key)?.read === read) transcriptDetailReads.delete(key);
    });
  transcriptDetailReads.set(key, { fingerprint: cacheFingerprint, read });
  return { history: await read, cursorAccepted: page === undefined || validPage !== undefined };
}

function pruneTranscriptDetailCache(): void {
  const now = Date.now();
  for (const [key, cached] of transcriptDetailCache)
    if (cached.expiresAt <= now) transcriptDetailCache.delete(key);
  while (transcriptDetailCache.size > TRANSCRIPT_DETAIL_CACHE_MAX_ENTRIES) {
    const oldest = transcriptDetailCache.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    transcriptDetailCache.delete(oldest);
  }
}

/**
 * Codex records the most recent prompt token count alongside the model context
 * window in `event_msg/token_count`.  Read only the tail of an already
 * discovered transcript: the count is append-only and never needs a costly
 * full-history scan.
 */
export async function readCodexNativeContextUsage(
  workspacePath: string,
  externalSessionId: string
): Promise<NativeCodexContextUsage | undefined> {
  const wanted = canonical(workspacePath);
  let path = getTranscriptIndex(indexKey('codex', wanted, externalSessionId));
  if (path === undefined) {
    await discoverNativeSessions('codex', workspacePath);
    path = getTranscriptIndex(indexKey('codex', wanted, externalSessionId));
  }
  if (path === undefined) return undefined;
  const window = await readJsonlWindow(path, { tailBytes: CONTEXT_USAGE_READ_BYTES });
  if (window === undefined) return undefined;
  let usage: NativeCodexContextUsage | undefined;
  forEachJsonlRecord(window.content, (record) => {
    const next = codexContextUsage(record);
    if (next !== undefined) usage = next;
  });
  return usage;
}

/** Reads the latest actual Claude prompt occupancy without starting a CLI/SDK control stream. */
export async function readClaudeNativeContextUsage(
  workspacePath: string,
  externalSessionId: string,
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly settingsPath?: string;
  } = {}
): Promise<NativeClaudeContextUsage | undefined> {
  const wanted = canonical(workspacePath);
  let path = getTranscriptIndex(indexKey('claude-code', wanted, externalSessionId));
  path ??= await locateClaudeTranscript(wanted, externalSessionId);
  if (path === undefined) {
    await discoverNativeSessions('claude-code', workspacePath);
    path = getTranscriptIndex(indexKey('claude-code', wanted, externalSessionId));
  }
  if (path === undefined) return undefined;
  const latest = await readLatestClaudeContextUsage(path);
  if (latest === undefined) return undefined;
  return {
    ...latest,
    maxTokens: await claudeContextWindowTokens(options)
  };
}

async function readLatestClaudeContextUsage(
  path: string
): Promise<{ readonly model: string; readonly usedTokens: number } | undefined> {
  for (const tailBytes of CLAUDE_CONTEXT_USAGE_READ_BYTES) {
    const window = await readJsonlWindow(path, { tailBytes });
    if (window === undefined) return undefined;
    let latest: { readonly model: string; readonly usedTokens: number } | undefined;
    forEachJsonlRecord(window.content, (record) => {
      const usage = claudeContextUsage(record);
      if (usage !== undefined) latest = usage;
    });
    if (latest !== undefined) return latest;
    if (!window.truncated) return undefined;
  }
  return undefined;
}

/** Claude main transcripts use the native session ID as their filename. */
async function locateClaudeTranscript(
  wantedCwd: string,
  externalSessionId: string
): Promise<string | undefined> {
  const root = transcriptRoot('claude-code');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, `${externalSessionId}.jsonl`));
  const parsed = await mapConcurrent(candidates, 16, async (path) => ({
    path,
    history: await readTranscript(path, 'claude-code', DISCOVERY_READ_BYTES)
  }));
  const match = parsed.find(
    ({ history }) =>
      history?.externalSessionId === externalSessionId && canonical(history.cwd) === wantedCwd
  );
  if (match === undefined) return undefined;
  setTranscriptIndex(indexKey('claude-code', wantedCwd, externalSessionId), match.path);
  return match.path;
}

export async function claudeContextWindowTokens(
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly settingsPath?: string;
  } = {}
): Promise<number> {
  const environment = options.environment ?? process.env;
  const direct = positiveInteger(environment[CLAUDE_CONTEXT_WINDOW_ENV]);
  if (direct !== undefined) return direct;
  try {
    const settings: unknown = JSON.parse(
      await readFile(options.settingsPath ?? join(homedir(), '.claude', 'settings.json'), 'utf8')
    );
    if (isRecord(settings) && isRecord(settings.env)) {
      const configured = positiveInteger(settings.env[CLAUDE_CONTEXT_WINDOW_ENV]);
      if (configured !== undefined) return configured;
    }
  } catch {
    // Missing or malformed optional Claude settings use the stable default.
  }
  return DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS;
}

/**
 * Permanently removes exactly one previously discovered transcript. The
 * caller supplies no path: the in-process discovery index resolves it, then
 * the record is re-read and its runner/cwd/native ID are checked again before
 * unlinking. This keeps a destructive operation bounded to one known file.
 */
export async function removeNativeSession(
  runner: RunnerName,
  workspacePath: string,
  externalSessionId: string
): Promise<void> {
  const wanted = canonical(workspacePath);
  let path = getTranscriptIndex(indexKey(runner, wanted, externalSessionId));
  if (path === undefined) {
    await discoverNativeSessions(runner, workspacePath);
    path = getTranscriptIndex(indexKey(runner, wanted, externalSessionId));
  }
  if (path === undefined) throw new Error('NATIVE_TRANSCRIPT_UNAVAILABLE');
  const parsed = await readTranscript(path, runner, DISCOVERY_READ_BYTES);
  if (
    parsed === undefined ||
    parsed.externalSessionId !== externalSessionId ||
    canonical(parsed.cwd) !== wanted
  ) {
    deleteTranscriptIndex(indexKey(runner, wanted, externalSessionId));
    throw new Error('NATIVE_TRANSCRIPT_UNAVAILABLE');
  }
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('NATIVE_TRANSCRIPT_UNAVAILABLE');
    throw error;
  }
  deleteTranscriptIndex(indexKey(runner, wanted, externalSessionId));
  const detailKeyPrefix = `${runner}\u0000${path}\u0000`;
  for (const key of transcriptDetailCache.keys())
    if (key.startsWith(detailKeyPrefix)) transcriptDetailCache.delete(key);
  for (const key of transcriptDetailReads.keys())
    if (key.startsWith(detailKeyPrefix)) transcriptDetailReads.delete(key);
  invalidateNativeDiscovery(runner);
}

function transcriptRoot(runner: RunnerName): string {
  return runner === 'codex'
    ? join(homedir(), '.codex', 'sessions')
    : join(homedir(), '.claude', 'projects');
}

function discoveryKey(runner: RunnerName): string {
  return `${runner}\u0000${transcriptRoot(runner)}`;
}

function invalidateNativeDiscovery(runner: RunnerName): void {
  const key = discoveryKey(runner);
  discoveryGenerations.set(key, (discoveryGenerations.get(key) ?? 0) + 1);
  discoverySnapshots.delete(key);
  discoveryReads.delete(key);
}

async function readTranscript(
  path: string,
  runner: RunnerName,
  byteLimit: number,
  page?: {
    readonly snapshotEnd: number;
    readonly nextEnd: number;
    readonly fileAnchor: string;
    readonly anchorBytes: number;
  },
  targetLines = Number.MAX_SAFE_INTEGER
): Promise<NativeSessionHistory | undefined> {
  const window = await readJsonlBackwardWindow(path, {
    headBytes: Math.min(byteLimit, TRANSCRIPT_HEADER_READ_BYTES),
    targetLines,
    maxBytes: byteLimit,
    ...(page === undefined ? {} : { page })
  });
  if (window === undefined) return undefined;
  const { content, truncated } = window;
  let cwd: string | undefined;
  let id: string | undefined;
  let derivedSession = false;
  const items: NativeTranscriptItem[] = [];
  const toolIndexes = new Map<string, number>();
  const metaRecordIds = new Set<string>();
  const claudeCompactCommandIds = new Set<string>();
  let codexTurnId: string | undefined;
  forEachJsonlRecord(content, (value) => {
    if (derivedTranscriptRecord(runner, value)) derivedSession = true;
    cwd ??= workspacePath(value);
    id ??= sessionId(value);
    if (
      runner === 'claude-code' &&
      typeof value['uuid'] === 'string' &&
      isClaudeCompactCommand(value)
    )
      claudeCompactCommandIds.add(value['uuid']);
  });
  forEachJsonlRecord(truncated ? window.pageContent : content, (value) => {
    if (runner === 'codex' && value['type'] === 'event_msg' && isRecord(value['payload'])) {
      const payload = value['payload'];
      if (payload['type'] === 'task_started')
        codexTurnId = typeof payload['turn_id'] === 'string' ? payload['turn_id'] : undefined;
      else if (payload['type'] === 'task_complete') codexTurnId = undefined;
    }
    const recordId = typeof value['uuid'] === 'string' ? value['uuid'] : undefined;
    const parentId = typeof value['parentUuid'] === 'string' ? value['parentUuid'] : undefined;
    if (value['isMeta'] === true && recordId !== undefined) metaRecordIds.add(recordId);
    if (
      runner === 'claude-code' &&
      parentId !== undefined &&
      claudeCompactCommandIds.has(parentId) &&
      isClaudeCompactSuccess(value)
    ) {
      items.push({
        kind: 'context_compaction',
        phase: 'COMPLETED',
        summary: null,
        createdAt: timestampOf(value),
        nativeId: parentId
      });
      return;
    }
    if (
      isHiddenTranscriptRecord(value) ||
      (parentId !== undefined && metaRecordIds.has(parentId))
    ) {
      return;
    }
    const generatedImage = codexGeneratedImageEvent(value);
    if (generatedImage !== undefined) items.push(generatedImage);
    for (const parsedItem of transcriptItems(runner, value)) {
      const item = {
        ...parsedItem,
        ...(recordId === undefined ? {} : { nativeId: recordId }),
        ...(runner === 'codex' &&
        parsedItem.kind === 'message' &&
        parsedItem.role === 'USER' &&
        codexTurnId !== undefined
          ? { nativeTurnId: codexTurnId }
          : {})
      };
      if (item.kind === 'tool_result') {
        const toolIndex = toolIndexes.get(item.toolUseId);
        if (toolIndex !== undefined)
          items[toolIndex] = withToolResult(items[toolIndex] as NativeTranscriptToolCall, item);
        continue;
      }
      if (item.kind === 'tool_call') {
        toolIndexes.set(item.toolUseId, items.length);
        items.push(item);
        continue;
      }
      items.push(item);
    }
  });
  if (derivedSession) return undefined;
  if (cwd === undefined) return undefined;
  const title = items.find(
    (item): item is NativeTranscriptMessage => item.kind === 'message' && item.role === 'USER'
  )?.text;
  // Tagged Plan Mode instruction labels do not form a session title.
  const strippedTitle =
    title === undefined ? undefined : stripClaudePlanTag(stripGoalStartPrompt(title));
  return {
    runner,
    externalSessionId: id ?? basename(path, '.jsonl'),
    cwd,
    ...(strippedTitle === undefined || strippedTitle.length === 0
      ? {}
      : { title: compact(strippedTitle) }),
    digest: createHash('sha256').update(content).digest('hex'),
    items,
    lastActivityAt: Math.max(0, ...items.map((item) => item.createdAt ?? 0)),
    truncated,
    windowStart: window.start,
    windowEnd: window.end,
    snapshotEnd: window.snapshotEnd,
    fileAnchor: window.fileAnchor,
    anchorBytes: window.anchorBytes
  };
}

function derivedTranscriptRecord(runner: RunnerName, value: Record<string, unknown>): boolean {
  if (runner === 'claude-code') return value['isSidechain'] === true;
  if (runner !== 'codex' || value['type'] !== 'session_meta') return false;
  const payload = isRecord(value['payload']) ? value['payload'] : undefined;
  if (payload === undefined) return false;
  if (payload['thread_source'] === 'subagent') return true;
  const source = payload['source'];
  return (
    source === 'subagent' ||
    (isRecord(source) && (source['kind'] === 'subagent' || isRecord(source['subagent'])))
  );
}

function workspacePath(record: Record<string, unknown>): string | undefined {
  return (
    firstString(record, ['cwd', 'working_directory', 'workspacePath']) ??
    nestedString(record, ['payload', 'cwd']) ??
    nestedString(record, ['message', 'cwd'])
  );
}

function sessionId(record: Record<string, unknown>): string | undefined {
  // A Codex sub-agent transcript records its own thread in `payload.id`, but
  // retains the parent thread in `payload.session_id`.  Treating the latter
  // as this file's identity makes the child file overwrite the parent thread
  // in the discovery index, which then shows unrelated messages for the
  // parent Chat.
  if (record['type'] === 'session_meta') {
    const transcriptId = nestedString(record, ['payload', 'id']);
    if (transcriptId !== undefined) return transcriptId;
  }
  return (
    firstString(record, ['sessionId', 'session_id', 'thread_id', 'conversationId']) ??
    nestedString(record, ['payload', 'id']) ??
    nestedString(record, ['payload', 'session_id']) ??
    nestedString(record, ['payload', 'thread_id'])
  );
}

function codexContextUsage(value: unknown): NativeCodexContextUsage | undefined {
  if (!isRecord(value) || value.type !== 'event_msg' || !isRecord(value.payload)) return undefined;
  const payload = value.payload;
  if (payload.type !== 'token_count' || !isRecord(payload.info)) return undefined;
  const promptUsage = payload.info.last_token_usage;
  const maxTokens = payload.info.model_context_window;
  if (
    !isRecord(promptUsage) ||
    typeof promptUsage.input_tokens !== 'number' ||
    typeof maxTokens !== 'number'
  )
    return undefined;
  if (
    !Number.isFinite(promptUsage.input_tokens) ||
    !Number.isInteger(promptUsage.input_tokens) ||
    !Number.isFinite(maxTokens) ||
    !Number.isInteger(maxTokens) ||
    maxTokens <= 0 ||
    promptUsage.input_tokens < 0
  )
    return undefined;
  return { usedTokens: promptUsage.input_tokens, maxTokens };
}

function claudeContextUsage(
  value: Record<string, unknown>
): { readonly model: string; readonly usedTokens: number } | undefined {
  if (value.type !== 'assistant' || !isRecord(value.message)) return undefined;
  const model = value.message.model;
  const usage = value.message.usage;
  if (
    typeof model !== 'string' ||
    model.length === 0 ||
    model === '<synthetic>' ||
    !isRecord(usage)
  )
    return undefined;
  const inputTokens = nonNegativeInteger(usage.input_tokens);
  const cacheCreationTokens = optionalNonNegativeInteger(usage.cache_creation_input_tokens);
  const cacheReadTokens = optionalNonNegativeInteger(usage.cache_read_input_tokens);
  if (
    inputTokens === undefined ||
    cacheCreationTokens === undefined ||
    cacheReadTokens === undefined
  )
    return undefined;
  return { model, usedTokens: inputTokens + cacheCreationTokens + cacheReadTokens };
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return value === undefined ? 0 : nonNegativeInteger(value);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

type NativeToolResult = {
  readonly kind: 'tool_result';
  readonly toolUseId: string;
  readonly output: string;
  readonly failed: boolean;
  readonly truncated: boolean;
  readonly claudeResult?: ClaudeToolResultMetadata;
  readonly imageAttachments?: readonly NativeTranscriptImageAttachment[];
  readonly createdAt: number | null;
  readonly nativeId?: string;
};

function transcriptItems(
  runner: RunnerName,
  record: Record<string, unknown>
): readonly (NativeTranscriptItem | NativeToolResult)[] {
  const createdAt = timestampOf(record);
  const results = [...toolResultsOf(record, createdAt), ...codexToolResultsOf(record, createdAt)];
  if (results.length > 0) return results;
  const values: NativeTranscriptItem[] = [
    ...toolUsesOf(record, createdAt),
    ...codexToolUsesOf(record, createdAt),
    ...codexReasoningSummariesOf(record, createdAt),
    ...unsupportedCodexResponseItems(record, createdAt),
    ...unsupportedTranscriptItems(record, createdAt)
  ];
  const role = roleOf(record);
  if (role === undefined) return values;
  const rawText = messageText(textOf(record) ?? '');
  if (rawText.length === 0) return values;
  // Codex transcripts can contain the host's injected AGENTS.md and runtime
  // context as a `user` item before the first actual prompt.  It is neither a
  // user-visible chat turn nor a meaningful session title.
  if (role === 'USER' && isInjectedContextPrompt(rawText)) return values;
  const message =
    role === 'USER' && runner === 'codex'
      ? parseCodexComposerImageMarkers(rawText)
      : { text: rawText, images: [] };
  values.unshift({
    kind: 'message',
    role,
    text: message.text,
    ...(message.images.length === 0
      ? {}
      : {
          imageAttachments: message.images.map((image) => ({
            name: `Image #${image.index}`,
            mime: imageMime(image.localPath),
            localPath: image.localPath
          }))
        }),
    createdAt
  });
  return values;
}

function unsupportedCodexResponseItems(
  record: Record<string, unknown>,
  createdAt: number | null
): readonly NativeTranscriptUnknown[] {
  const payload = codexToolPayload(record);
  const type = typeof payload?.type === 'string' ? payload.type : undefined;
  if (
    type === undefined ||
    typeof payload?.role === 'string' ||
    type === 'reasoning' ||
    type === 'custom_tool_call' ||
    type === 'custom_tool_call_output' ||
    type === 'function_call' ||
    type === 'function_call_output'
  )
    return [];
  return [
    {
      kind: 'unknown',
      sourceEventType: `codex:${type}`,
      label: `Codex ${compact(type).slice(0, 128)}`,
      createdAt
    }
  ];
}

function codexReasoningSummariesOf(
  record: Record<string, unknown>,
  createdAt: number | null
): readonly NativeTranscriptReasoningSummary[] {
  const payload = codexToolPayload(record);
  if (payload?.type !== 'reasoning') return [];
  const sections = Array.isArray(payload.summary)
    ? payload.summary.flatMap((value, index) => {
        if (typeof value !== 'string') return [];
        const text = compact(value).slice(0, 10_000);
        return text.length === 0 ? [] : [{ index, text }];
      })
    : [];
  return [{ kind: 'reasoning_summary', sections, createdAt }];
}

function unsupportedTranscriptItems(
  record: Record<string, unknown>,
  createdAt: number | null
): readonly NativeTranscriptUnknown[] {
  return contentBlocks(record).flatMap((block) => {
    const type = typeof block.type === 'string' ? block.type : undefined;
    if (
      type === undefined ||
      type === 'text' ||
      type === 'input_text' ||
      type === 'output_text' ||
      type === 'image' ||
      type === 'input_image' ||
      type === 'thinking' ||
      type === 'redacted_thinking' ||
      type === 'encrypted_thinking' ||
      type === 'tool_use' ||
      type === 'tool_result'
    )
      return [];
    return [
      {
        kind: 'unknown' as const,
        sourceEventType: `transcript:${type}`,
        label: `Agent ${compact(type).slice(0, 128)}`,
        createdAt
      }
    ];
  });
}

function toolUsesOf(
  record: Record<string, unknown>,
  createdAt: number | null
): readonly NativeTranscriptToolCall[] {
  return contentBlocks(record).flatMap((block) => {
    if (
      block['type'] !== 'tool_use' ||
      typeof block['id'] !== 'string' ||
      typeof block['name'] !== 'string'
    )
      return [];
    const input = block['input'];
    const summary = compactValue(input, 10_000);
    return [
      {
        kind: 'tool_call' as const,
        toolUseId: block['id'],
        toolName: compact(block['name']).slice(0, 128),
        input,
        inputSummary: summary.text || null,
        inputTruncated: summary.truncated,
        outputSummary: null,
        outputTruncated: false,
        failed: false,
        createdAt
      }
    ];
  });
}

function toolResultsOf(
  record: Record<string, unknown>,
  createdAt: number | null
): readonly NativeToolResult[] {
  return extractClaudeToolResults(record).map((result) => ({
    ...result,
    kind: 'tool_result' as const,
    createdAt
  }));
}

/**
 * Codex persists custom and standard function tools as paired `response_item`
 * records. Their record IDs differ, while `call_id` is the stable identifier
 * shared by invocation and result. Normalize on that key so JSONL fallback
 * history has the same single-card shape as live events.
 */
function codexToolUsesOf(
  record: Record<string, unknown>,
  createdAt: number | null
): readonly NativeTranscriptToolCall[] {
  const payload = codexToolPayload(record);
  if (payload?.['type'] !== 'custom_tool_call' && payload?.['type'] !== 'function_call') return [];
  const toolUseId = firstString(payload, ['call_id', 'id']);
  const toolName = firstString(payload, ['name', 'tool']);
  if (toolUseId === undefined || toolName === undefined) return [];
  const input = payload['input'] ?? payload['arguments'];
  const summary = compactValue(input, 10_000);
  return [
    {
      kind: 'tool_call',
      toolUseId,
      toolName: compact(toolName).slice(0, 128),
      input,
      inputSummary: summary.text || null,
      inputTruncated: summary.truncated,
      outputSummary: null,
      outputTruncated: false,
      failed: false,
      createdAt
    }
  ];
}

function codexToolResultsOf(
  record: Record<string, unknown>,
  createdAt: number | null
): readonly NativeToolResult[] {
  const payload = codexToolPayload(record);
  if (
    payload?.['type'] !== 'custom_tool_call_output' &&
    payload?.['type'] !== 'function_call_output'
  )
    return [];
  const toolUseId = firstString(payload, ['call_id', 'id']);
  if (toolUseId === undefined) return [];
  const output = compactValue(
    codexToolOutput(payload['output'] ?? payload['contentItems']),
    10_000
  );
  const imageAttachments = codexImagePlaceholders(payload['output'] ?? payload['contentItems']);
  return [
    {
      kind: 'tool_result',
      toolUseId,
      output: output.text,
      failed: payload['status'] === 'failed' || payload['error'] !== undefined,
      truncated: output.truncated,
      ...(imageAttachments.length === 0 ? {} : { imageAttachments }),
      createdAt
    }
  ];
}

function codexToolPayload(record: Record<string, unknown>): Record<string, unknown> | undefined {
  return record['type'] === 'response_item' && isRecord(record['payload'])
    ? record['payload']
    : undefined;
}

function codexGeneratedImageEvent(
  record: Record<string, unknown>
): NativeTranscriptToolCall | undefined {
  if (record['type'] !== 'event_msg' || !isRecord(record['payload'])) return undefined;
  const payload = record['payload'];
  if (
    payload['type'] !== 'image_generation_end' ||
    typeof payload['call_id'] !== 'string' ||
    typeof payload['saved_path'] !== 'string'
  )
    return undefined;
  const localPath = payload['saved_path'];
  if (!localPath.includes('/.codex/generated_images/') || !/\.(?:png|jpe?g|webp)$/i.test(localPath))
    return undefined;
  return {
    kind: 'tool_call',
    toolUseId: payload['call_id'],
    toolName: 'imagegen',
    input: null,
    inputSummary: null,
    inputTruncated: false,
    outputSummary:
      payload['status'] === 'completed' ? 'Image generation completed' : 'Image generation failed',
    outputTruncated: false,
    toolCategory: 'IMAGE_GENERATION',
    imageAttachments: [{ name: basename(localPath), mime: imageMime(localPath), localPath }],
    failed: payload['status'] !== 'completed',
    createdAt: timestampOf(record)
  };
}

/** Extract Codex output text blocks instead of rendering their JSON envelopes. */
function codexToolOutput(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const text = value.flatMap((block) => {
    if (typeof block === 'string') return [block];
    if (!isRecord(block)) return [];
    const direct = firstString(block, ['text', 'content']);
    return direct === undefined ? [] : [codexVisibleToolText(direct)];
  });
  return text.length > 0 ? text.join('') : value;
}

function codexVisibleToolText(value: string): string {
  const marker = 'data:image/';
  let cursor = 0;
  let visible = '';
  while (cursor < value.length) {
    const start = value.indexOf(marker, cursor);
    if (start < 0) return visible + value.slice(cursor);
    visible += `${value.slice(cursor, start)}[Image content filtered]`;
    const doubleQuote = value.indexOf('"', start);
    const singleQuote = value.indexOf("'", start);
    const end =
      doubleQuote < 0
        ? singleQuote
        : singleQuote < 0
          ? doubleQuote
          : Math.min(doubleQuote, singleQuote);
    if (end < 0) return visible;
    cursor = end;
  }
  return visible;
}

/** Extract only image placeholder metadata from native Codex output. */
function codexImagePlaceholders(value: unknown): readonly NativeTranscriptImageAttachment[] {
  const attachments: NativeTranscriptImageAttachment[] = [];
  let visited = 0;
  const visit = (current: unknown, depth: number): void => {
    if (attachments.length >= 5 || visited >= 128 || depth > 5 || current == null) return;
    visited += 1;
    if (typeof current === 'string') {
      const paths: string[] = [];
      collectGeneratedImagePaths(current, paths);
      for (const localPath of paths) {
        if (attachments.some((attachment) => attachment.localPath === localPath)) continue;
        attachments.push({ name: basename(localPath), mime: imageMime(localPath), localPath });
      }
      return;
    }
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry, depth + 1);
      return;
    }
    if (!isRecord(current)) return;
    const type = typeof current['type'] === 'string' ? current['type'] : '';
    if (type === 'input_text' && typeof current['text'] === 'string') {
      const mime = /["']image_url["']\s*:\s*["']data:(image\/[^;,"']+)[;,]/.exec(
        current['text']
      )?.[1];
      if (mime !== undefined)
        attachments.push({ name: `image-${attachments.length + 1}.${imageExtension(mime)}`, mime });
    }
    const imageUrl = isRecord(current['image_url'])
      ? firstString(current['image_url'], ['url'])
      : typeof current['image_url'] === 'string'
        ? current['image_url']
        : undefined;
    const data = typeof current['data'] === 'string' ? current['data'] : imageUrl;
    if (
      (type === 'image' || type === 'input_image' || type === 'output_image') &&
      data?.startsWith('data:image/')
    ) {
      const mime = /^data:([^;,]+)[;,]/.exec(data)?.[1] ?? 'image/png';
      attachments.push({ name: `image-${attachments.length + 1}.${imageExtension(mime)}`, mime });
    }
    for (const child of Object.values(current)) visit(child, depth + 1);
  };
  visit(value, 0);
  return attachments;
}

function collectGeneratedImagePaths(value: string, paths: string[]): void {
  const marker = '/.codex/generated_images/';
  let cursor = 0;
  while (paths.length < 5) {
    const markerIndex = value.indexOf(marker, cursor);
    if (markerIndex < 0) return;
    let start = markerIndex;
    while (start > 0 && !/[\s"']/.test(value[start - 1] as string)) start -= 1;
    let end = markerIndex + marker.length;
    while (end < value.length && !/[\s"']/.test(value[end] as string)) end += 1;
    const path = value.slice(start, end).replace(/[),.;:]+$/, '');
    if (/\.(?:png|jpe?g|webp)$/i.test(path) && !paths.includes(path)) paths.push(path);
    cursor = end;
  }
}

function imageMime(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  return 'image/png';
}

function imageExtension(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'png';
}

function withToolResult(
  call: NativeTranscriptToolCall,
  result: NativeToolResult
): NativeTranscriptToolCall {
  const viewedImagePath = codexViewedImagePath(call);
  const imageAttachments = result.imageAttachments?.map((attachment) =>
    attachment.localPath !== undefined || viewedImagePath === undefined
      ? attachment
      : {
          name: basename(viewedImagePath),
          mime: imageMime(viewedImagePath),
          localPath: viewedImagePath
        }
  );
  return {
    ...call,
    outputSummary: result.output,
    outputTruncated: result.truncated,
    ...(result.claudeResult === undefined ? {} : { claudeResult: result.claudeResult }),
    ...(imageAttachments === undefined ? {} : { imageAttachments }),
    failed: result.failed
  };
}

function codexViewedImagePath(call: NativeTranscriptToolCall): string | undefined {
  const toolName = call.toolName.toLowerCase();
  if (toolName === 'view_image' || toolName === 'imageview') {
    return isRecord(call.input) && typeof call.input['path'] === 'string'
      ? call.input['path']
      : undefined;
  }
  if (toolName !== 'exec' || typeof call.input !== 'string') return undefined;
  if (!/tools\.view_image\s*\(/.test(call.input)) return undefined;
  const encodedPath = /["']path["']\s*:\s*("(?:\\.|[^"\\])*")/.exec(call.input)?.[1];
  if (encodedPath === undefined) return undefined;
  try {
    const path = JSON.parse(encodedPath) as unknown;
    return typeof path === 'string' ? path : undefined;
  } catch {
    return undefined;
  }
}

function isInjectedContextPrompt(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.startsWith('<codex_internal_context')) return true;
  if (/^<(?:environment_context|subagent_notification|turn_aborted)(?:\s|>)/u.test(normalized))
    return true;
  return (
    normalized.startsWith('# AGENTS.md instructions') &&
    (normalized.includes('<INSTRUCTIONS>') || normalized.includes('<environment_context>'))
  );
}

function isClaudeCompactCommand(record: Record<string, unknown>): boolean {
  return textOf(record)?.trim() === '<command-name>/compact</command-name>';
}

function isClaudeCompactSuccess(record: Record<string, unknown>): boolean {
  return textOf(record)?.trim() === '<local-command-stdout>Compacted</local-command-stdout>';
}

function isHiddenTranscriptRecord(record: Record<string, unknown>): boolean {
  if (contentBlocks(record).some((block) => block['type'] === 'tool_result')) return false;
  if (
    record['interruptedByShutdown'] === true ||
    record['isMeta'] === true ||
    record['isVisibleInTranscriptOnly'] === true ||
    record['isCompactSummary'] === true
  )
    return true;
  const text = textOf(record)?.trim() ?? '';
  return (
    text.startsWith('<local-command-') ||
    text.startsWith('<command-name>') ||
    text.startsWith('<command-message>')
  );
}

function roleOf(record: Record<string, unknown>): NativeTranscriptMessage['role'] | undefined {
  const candidates = [
    firstString(record, ['role']),
    nestedString(record, ['message', 'role']),
    nestedString(record, ['payload', 'role']),
    firstString(record, ['type']),
    nestedString(record, ['payload', 'type'])
  ];
  if (candidates.some((value) => value === 'user' || value === 'human' || value === 'input'))
    return 'USER';
  if (candidates.some((value) => value === 'assistant' || value === 'agent' || value === 'output'))
    return 'ASSISTANT';
  return undefined;
}

function textOf(record: Record<string, unknown>): string | undefined {
  return (
    firstString(record, ['content', 'text']) ??
    nestedText(record['message']) ??
    nestedText(record['payload'])
  );
}

function nestedText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  const direct = firstString(value, ['content', 'text', 'message']);
  if (direct !== undefined) return direct;
  if (Array.isArray(value['content'])) {
    const parts = value['content'].flatMap((part) => {
      if (typeof part === 'string') return [part];
      if (!isRecord(part)) return [];
      return [firstString(part, ['text', 'content'])].filter(
        (text): text is string => text !== undefined
      );
    });
    return parts.join('\n');
  }
  return undefined;
}

function contentBlocks(record: Record<string, unknown>): readonly Record<string, unknown>[] {
  const values = [record['message'], record['payload']];
  for (const value of values)
    if (isRecord(value) && Array.isArray(value['content']))
      return value['content'].filter(isRecord);
  return [];
}

function compactValue(
  value: unknown,
  limit: number
): { readonly text: string; readonly truncated: boolean } {
  if (value === undefined || value === null) return { text: '', truncated: false };
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      return { text: '(Unable to display)', truncated: false };
    }
  }
  return {
    text: text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`,
    truncated: text.length > limit
  };
}

function timestampOf(record: Record<string, unknown>): number | null {
  const raw = record['timestamp'] ?? record['created_at'] ?? record['createdAt'];
  if (typeof raw === 'number' && Number.isFinite(raw))
    return raw < 10_000_000_000 ? raw * 1_000 : raw;
  if (typeof raw === 'string') {
    const value = Date.parse(raw);
    return Number.isNaN(value) ? null : value;
  }
  return null;
}

function firstString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys)
    if (typeof value[key] === 'string' && (value[key] as string).length > 0)
      return value[key] as string;
  return undefined;
}

function nestedString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === 'string' && current.length > 0 ? current : undefined;
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 16_000);
}

/** Conversation content can be Markdown, so its internal whitespace must not be collapsed like a title. */
function messageText(value: string): string {
  return value.trim().slice(0, 16_000);
}

function canonical(value: string): string {
  try {
    const normalized = resolve(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
  } catch {
    return value;
  }
}

function indexKey(runner: RunnerName, cwd: string, externalSessionId: string): string {
  return `${runner}\u0000${cwd}\u0000${externalSessionId}`;
}

function setTranscriptIndex(key: string, path: string): void {
  const previousTimer = transcriptIndexTimers.get(key);
  if (previousTimer !== undefined) clearTimeout(previousTimer);
  transcriptIndex.set(key, path);
  const timer = setTimeout(() => deleteTranscriptIndex(key), TRANSCRIPT_INDEX_TTL_MS);
  timer.unref();
  transcriptIndexTimers.set(key, timer);
}

function getTranscriptIndex(key: string): string | undefined {
  return transcriptIndex.get(key);
}

function deleteTranscriptIndex(key: string): void {
  const timer = transcriptIndexTimers.get(key);
  if (timer !== undefined) clearTimeout(timer);
  transcriptIndexTimers.delete(key);
  transcriptIndex.delete(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
