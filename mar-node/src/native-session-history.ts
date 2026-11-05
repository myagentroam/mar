import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RunnerName } from '@myagentroam/protocol';
import type { NativeSessionHistory } from './native-transcript-model.js';
import {
  listJsonlFiles,
  mapConcurrent,
  readJsonlBackwardWindow,
  readJsonlFileAnchor
} from './native-jsonl-reader.js';
import { nativeTranscriptAdapter } from './native-transcript-adapters.js';
import { nodeLog } from './operational.js';
const DISCOVERY_READ_BYTES = 32 * 1024;
const TRANSCRIPT_HEADER_READ_BYTES = 32 * 1024;
const TRANSCRIPT_READ_MAX_BYTES = 16 * 1024 * 1024;
const TRANSCRIPT_MIN_LINES = 256;
const TRANSCRIPT_MAX_LINES = 4096;
const TRANSCRIPT_LINES_PER_TURN = 32;
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
  const files = (await listJsonlFiles(transcriptRoot(runner))).filter((path) =>
    nativeTranscriptAdapter(runner)!.includesPath(path)
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
  return nativeTranscriptAdapter(runner)!.transcriptRoot();
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
  const parsed = nativeTranscriptAdapter(runner)?.parse(path, window);
  if (parsed === undefined) return undefined;
  return {
    ...parsed,
    runner,
    externalSessionId: parsed.externalSessionId ?? basename(path, '.jsonl'),
    digest: createHash('sha256').update(window.content).digest('hex'),
    lastActivityAt: Math.max(0, ...parsed.items.map((item) => item.createdAt ?? 0)),
    truncated: window.truncated,
    windowStart: window.start,
    windowEnd: window.end,
    snapshotEnd: window.snapshotEnd,
    fileAnchor: window.fileAnchor,
    anchorBytes: window.anchorBytes
  };
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

/** Context-only location: history and deletion keep their existing discovery/index paths. */
export async function locateNativeSessionPath(
  runner: RunnerName,
  workspacePath: string,
  externalSessionId: string
): Promise<string | undefined> {
  const wanted = canonical(workspacePath);
  const key = indexKey(runner, wanted, externalSessionId);
  const path = getTranscriptIndex(key);
  if (path !== undefined) return path;
  const candidates = await nativeTranscriptAdapter(runner)?.locateCandidates?.(externalSessionId);
  if (candidates !== undefined) {
    const parsed = await mapConcurrent(candidates, 16, async (path) => ({
      path,
      history: await readTranscript(path, runner, DISCOVERY_READ_BYTES)
    }));
    const match = parsed.find(
      ({ history }) =>
        history?.externalSessionId === externalSessionId && canonical(history.cwd) === wanted
    );
    if (match !== undefined) {
      setTranscriptIndex(key, match.path);
      return match.path;
    }
  }
  await discoverNativeSessions(runner, workspacePath);
  return getTranscriptIndex(key);
}
