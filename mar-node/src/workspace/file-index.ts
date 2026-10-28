import { opendir, readFile } from 'node:fs/promises';
import { platform as hostPlatform } from 'node:os';
import { posix, relative, resolve, sep } from 'node:path';
import { Minimatch } from 'minimatch';
import type { WorkspaceFileEntry, WorkspaceFileSearchPage } from './contracts.js';
import {
  resolveRegisteredWorkspaceRoot,
  resolveWorkspaceEntryFromCanonicalRoot,
  resolveWorkspaceEntryMetadata
} from './path-access.js';

const SEARCH_RESULT_LIMIT = 200;
const FILE_INDEX_IDLE_TTL_MS = 60 * 60 * 1_000;
const FILE_INDEX_FRESHNESS_TTL_MS = 30_000;
const FILE_INDEX_ENTRY_LIMIT = 100_000;
const FILE_INDEX_METADATA_CONCURRENCY = 32;
const FILE_INDEX_BYTE_LIMIT = 64 * 1024 * 1024;
const DEFAULT_QUICK_OPEN_EXCLUDES = [
  '**/.git/**',
  '**/node_modules/**',
  '**/bower_components/**',
  '**/.pnpm/**',
  '**/.yarn/**',
  '**/.cache/**',
  '**/.parcel-cache/**',
  '**/.turbo/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/test/runs/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.svelte-kit/**',
  '**/.angular/**',
  '**/target/**',
  '**/.gradle/**',
  '**/bin/**',
  '**/obj/**',
  '**/vendor/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**'
];

/** A per-workspace, process-local index for the Quick Open file picker. */
export class WorkspaceFileIndex {
  private entries: WorkspaceFileEntry[] = [];
  private fileEntries: readonly WorkspaceFileEntry[] = [];
  private retainedBytes = 0;
  private failure: unknown;
  private foregroundRequested = false;
  private readonly preparationConsumers = new Set<() => boolean>();
  private truncated = false;
  private root: string | undefined;
  private loading: Promise<void> | undefined;
  private stale = true;
  private expiryTimer: NodeJS.Timeout | undefined;
  private refreshedAt = 0;
  private refreshAttemptedAt = 0;
  private lifecycleGeneration = 0;

  constructor(
    private readonly workspaceRoot: string,
    private readonly limits: {
      readonly entryLimit?: number;
      readonly idleTtlMs?: number;
      readonly freshnessTtlMs?: number;
      readonly byteLimit?: number;
      readonly onRebuilt?: () => void;
      readonly schedule?: (
        run: () => Promise<void>,
        background: () => boolean,
        needed: () => boolean
      ) => Promise<void>;
    } = {}
  ) {}

  get accountedBytes(): number {
    return this.retainedBytes;
  }

  /** Prepares only metadata; a queued background scan may lose its consumer. */
  prepare(needed: () => boolean = () => true): Promise<void> {
    if (!this.stale && this.root !== undefined) {
      this.touch();
      return Promise.resolve();
    }
    if (!needed()) return Promise.resolve();
    this.preparationConsumers.add(needed);
    this.startLoading(true, () => {
      for (const consumer of this.preparationConsumers) {
        if (consumer()) return true;
        this.preparationConsumers.delete(consumer);
      }
      return false;
    });
    return this.loading!;
  }

  async contentCandidates(options: { readonly requireFresh?: boolean } = {}): Promise<{
    readonly entries: readonly WorkspaceFileEntry[];
    readonly truncated: boolean;
  }> {
    await this.ensureLoaded(options.requireFresh === true);
    return this.currentContentCandidates();
  }

  /**
   * Returns the current candidate snapshot without synchronously rebuilding an
   * empty or explicitly invalidated index. A stale loaded snapshot schedules
   * its normal single-flight refresh before it is returned.
   */
  peekContentCandidates():
    | {
        readonly entries: readonly WorkspaceFileEntry[];
        readonly truncated: boolean;
      }
    | undefined {
    if (this.stale || this.root === undefined) return undefined;
    if (
      Date.now() - this.refreshAttemptedAt >=
      (this.limits.freshnessTtlMs ?? FILE_INDEX_FRESHNESS_TTL_MS)
    )
      this.refreshInBackground();
    return this.currentContentCandidates();
  }

  /** Starts a single candidate refresh without making the caller await it. */
  refreshContentCandidates(requireFresh = false): Promise<void> {
    if (this.loading !== undefined) return this.loading;
    if (this.stale || this.root === undefined) {
      this.startLoading();
      return this.loading!;
    }
    if (requireFresh) {
      this.refreshAttemptedAt = Date.now();
      this.startLoading();
      return this.loading!;
    }
    if (
      Date.now() - this.refreshAttemptedAt >=
      (this.limits.freshnessTtlMs ?? FILE_INDEX_FRESHNESS_TTL_MS)
    )
      this.refreshInBackground();
    return this.loading ?? Promise.resolve();
  }

  private currentContentCandidates(): {
    readonly entries: readonly WorkspaceFileEntry[];
    readonly truncated: boolean;
  } {
    this.touch();
    return {
      entries: this.fileEntries,
      truncated: this.truncated
    };
  }

  dispose(): void {
    this.lifecycleGeneration += 1;
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.entries = [];
    this.fileEntries = [];
    this.root = undefined;
    this.retainedBytes = 0;
    this.failure = undefined;
    this.foregroundRequested = false;
    this.preparationConsumers.clear();
    this.truncated = false;
    this.stale = true;
    this.refreshedAt = 0;
    this.refreshAttemptedAt = 0;
  }

  async search(
    query: string,
    cursor?: string,
    limit = SEARCH_RESULT_LIMIT,
    includeDirectories = false,
    waitForIndex = true
  ): Promise<WorkspaceFileSearchPage> {
    const generation = this.lifecycleGeneration;
    if (
      query.trim().length === 0 ||
      query.length > 256 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > SEARCH_RESULT_LIMIT
    )
      throw new Error('FILE_SEARCH_LIMIT_EXCEEDED');
    const after = decodeSearchCursor(cursor, query);
    if (!waitForIndex && (this.stale || this.root === undefined)) {
      if (this.failure !== undefined) {
        const failure = this.failure;
        this.failure = undefined;
        throw failure;
      }
      this.foregroundRequested = true;
      this.startLoading();
      return { entries: [], nextCursor: null, truncated: false, indexState: 'BUILDING' };
    }
    await this.ensureLoaded();
    if (generation !== this.lifecycleGeneration || this.root === undefined)
      throw new Error('FILE_INDEX_INVALIDATED');
    this.touch();
    const terms = query.trim().toLocaleLowerCase().split(/\s+/u);
    const afterEntry =
      after === undefined
        ? undefined
        : this.entries.find(
            (entry) => entry.path === after && (includeDirectories || entry.kind === 'FILE')
          );
    const afterScore = afterEntry === undefined ? -1 : fuzzyPathScore(afterEntry.path, terms);
    const afterCandidate =
      afterEntry === undefined || afterScore < 0
        ? undefined
        : { entry: afterEntry, score: afterScore };
    const ranked = new RankedCandidateHeap(limit + 1);
    for (const entry of this.entries) {
      if (!includeDirectories && entry.kind !== 'FILE') continue;
      const score = fuzzyPathScore(entry.path, terms);
      if (score < 0) continue;
      const candidate = { entry, score };
      if (afterCandidate !== undefined && compareRankedCandidate(candidate, afterCandidate) <= 0)
        continue;
      ranked.add(candidate);
    }
    const candidates = ranked.sorted();
    const page = candidates.slice(0, limit).map((candidate) => ({
      ...candidate.entry,
      score: candidate.score
    }));
    const next = candidates[limit]?.entry.path;
    return {
      entries: page,
      nextCursor:
        next === undefined ? null : encodeSearchCursor(query, page.at(-1)?.path ?? after ?? ''),
      truncated: next !== undefined || this.truncated,
      ...(!waitForIndex ? { indexState: 'READY' as const } : {})
    };
  }

  private async ensureLoaded(requireFresh = false): Promise<void> {
    const generation = this.lifecycleGeneration;
    if (!this.stale && this.root !== undefined) {
      if (
        Date.now() - this.refreshAttemptedAt >=
        (this.limits.freshnessTtlMs ?? FILE_INDEX_FRESHNESS_TTL_MS)
      ) {
        if (requireFresh) {
          this.foregroundRequested = true;
          if (this.loading === undefined) {
            this.refreshAttemptedAt = Date.now();
            this.startLoading();
          }
          await this.loading;
          if (generation !== this.lifecycleGeneration) throw new Error('FILE_INDEX_INVALIDATED');
        } else this.refreshInBackground();
      }
      return;
    }
    this.startLoading();
    await this.loading;
    if (generation !== this.lifecycleGeneration) throw new Error('FILE_INDEX_INVALIDATED');
  }

  private startLoading(background = false, needed: () => boolean = () => true): void {
    if (!background) this.foregroundRequested = true;
    if (this.loading !== undefined) return;
    const generation = this.lifecycleGeneration;
    const current = () => generation === this.lifecycleGeneration;
    const required = () => current() && (this.foregroundRequested || needed());
    const run = async () => {
      if (!current()) throw new Error('FILE_INDEX_INVALIDATED');
      if (required()) await this.rebuild();
      if (!current()) throw new Error('FILE_INDEX_INVALIDATED');
    };
    const pending = (
      this.limits.schedule?.(run, () => !this.foregroundRequested, required) ?? run()
    )
      .catch((error: unknown) => {
        if (current()) this.failure = error;
        throw error;
      })
      .finally(() => {
        if (this.loading === pending) {
          this.loading = undefined;
          this.foregroundRequested = false;
          this.preparationConsumers.clear();
        }
      });
    this.loading = pending;
    // A fast acknowledgement has no awaiting consumer; retain failure for its next query.
    void this.loading.catch(() => undefined);
  }

  private touch(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(
      () => this.dispose(),
      this.limits.idleTtlMs ?? FILE_INDEX_IDLE_TTL_MS
    );
    this.expiryTimer.unref();
  }

  private async rebuild(): Promise<void> {
    const generation = this.lifecycleGeneration;
    const root = await resolveRegisteredWorkspaceRoot(this.workspaceRoot);
    if (generation !== this.lifecycleGeneration) return;
    const excludeOptions = { dot: true, nocase: hostPlatform() !== 'linux' };
    const excludes = [
      // Fixed directory globs can use their compiled regex without splitting every path.
      ...DEFAULT_QUICK_OPEN_EXCLUDES.map((pattern) => {
        const matcher = new Minimatch(pattern, excludeOptions);
        const regex = matcher.makeRe();
        // Globstar also matches line terminators in valid filesystem names.
        return regex ? new RegExp(regex.source, `${regex.flags}s`) : matcher;
      }),
      ...(await workspaceExcludePatterns(root)).map(
        (pattern) => new Minimatch(pattern, excludeOptions)
      )
    ];
    if (generation !== this.lifecycleGeneration) return;
    const indexed: WorkspaceFileEntry[] = [];
    const entryLimit = this.limits.entryLimit ?? FILE_INDEX_ENTRY_LIMIT;
    const byteLimit = this.limits.byteLimit ?? FILE_INDEX_BYTE_LIMIT;
    let bytes = 0;
    let truncated = false;
    const directories = ['.'];
    let directoryCursor = 0;
    while (
      generation === this.lifecycleGeneration &&
      directoryCursor < directories.length &&
      !truncated
    ) {
      const relativeDirectory = directories[directoryCursor] as string;
      directoryCursor += 1;
      const directory = await resolveWorkspaceEntryFromCanonicalRoot(
        root,
        relativeDirectory,
        true
      ).catch(() => undefined);
      if (directory === undefined) continue;
      const stream = await opendir(directory).catch(() => undefined);
      if (stream === undefined) continue;
      let pending: Promise<WorkspaceFileEntry | undefined>[] = [];
      const appendPending = async (): Promise<void> => {
        const resolvedEntries = await Promise.all(pending);
        pending = [];
        if (generation !== this.lifecycleGeneration) return;
        for (const entry of resolvedEntries) {
          if (entry === undefined) continue;
          if (entry.path === '.git' || entry.path.startsWith('.git/')) continue;
          const entryBytes = 160 + 2 * (entry.path.length + entry.name.length);
          if (bytes + entryBytes > byteLimit) {
            truncated = true;
            break;
          }
          bytes += entryBytes;
          if (entry.kind === 'DIRECTORY') directories.push(entry.path);
          indexed.push(entry);
          if (indexed.length >= entryLimit) {
            truncated = true;
            break;
          }
        }
      };
      for await (const child of stream) {
        if (generation !== this.lifecycleGeneration) return;
        const candidatePath =
          relativeDirectory === '.'
            ? child.name
            : posix.join(relativeDirectory.replaceAll('\\', '/'), child.name);
        if (
          candidatePath === '.git' ||
          candidatePath.startsWith('.git/') ||
          isExcluded(candidatePath, excludes)
        )
          continue;
        pending.push(inspectWorkspaceIndexEntry(root, candidatePath, child.name, excludes));
        if (pending.length >= FILE_INDEX_METADATA_CONCURRENCY) await appendPending();
        if (truncated) break;
      }
      if (!truncated && pending.length > 0) await appendPending();
    }
    if (generation !== this.lifecycleGeneration) return;
    this.root = root;
    this.entries = indexed;
    this.fileEntries = indexed.filter((entry) => entry.kind === 'FILE');
    this.retainedBytes = bytes;
    this.failure = undefined;
    this.truncated = truncated;
    this.stale = false;
    this.refreshedAt = Date.now();
    this.refreshAttemptedAt = this.refreshedAt;
    this.touch();
    this.limits.onRebuilt?.();
  }

  private refreshInBackground(): void {
    if (this.loading !== undefined) return;
    this.refreshAttemptedAt = Date.now();
    this.startLoading(true);
  }
}

async function workspaceExcludePatterns(root: string): Promise<string[]> {
  const settingsPath = resolve(root, '.vscode/settings.json');
  const settings = (await readFile(settingsPath, 'utf8')
    .then(JSON.parse)
    .catch(() => undefined)) as unknown;
  if (typeof settings !== 'object' || settings === null) return [];
  return ['files.exclude', 'search.exclude'].flatMap((key) => {
    const value = (settings as Record<string, unknown>)[key];
    return typeof value === 'object' && value !== null
      ? Object.entries(value).flatMap(([pattern, enabled]) => (enabled === true ? [pattern] : []))
      : [];
  });
}

function isExcluded(path: string, patterns: readonly (Minimatch | RegExp)[]): boolean {
  return patterns.some((pattern) =>
    pattern instanceof RegExp
      ? pattern.test(path) || pattern.test(`${path}/`)
      : pattern.match(path) || pattern.match(`${path}/`)
  );
}

interface RankedFileCandidate {
  readonly entry: WorkspaceFileEntry;
  readonly score: number;
}

function compareRankedCandidate(left: RankedFileCandidate, right: RankedFileCandidate): number {
  return right.score - left.score || left.entry.path.localeCompare(right.entry.path);
}

/** Keeps only the best page-sized candidate set, with the current worst item at the root. */
class RankedCandidateHeap {
  private readonly values: RankedFileCandidate[] = [];

  constructor(private readonly capacity: number) {}

  add(candidate: RankedFileCandidate): void {
    if (this.values.length < this.capacity) {
      this.values.push(candidate);
      this.bubbleUp(this.values.length - 1);
      return;
    }
    if (compareRankedCandidate(candidate, this.values[0] as RankedFileCandidate) >= 0) return;
    this.values[0] = candidate;
    this.sinkDown(0);
  }

  sorted(): RankedFileCandidate[] {
    return [...this.values].sort(compareRankedCandidate);
  }

  private bubbleUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (
        compareRankedCandidate(
          this.values[index] as RankedFileCandidate,
          this.values[parent] as RankedFileCandidate
        ) <= 0
      )
        break;
      [this.values[index], this.values[parent]] = [
        this.values[parent] as RankedFileCandidate,
        this.values[index] as RankedFileCandidate
      ];
      index = parent;
    }
  }

  private sinkDown(start: number): void {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.values.length) return;
      const right = left + 1;
      const worse =
        right < this.values.length &&
        compareRankedCandidate(
          this.values[right] as RankedFileCandidate,
          this.values[left] as RankedFileCandidate
        ) > 0
          ? right
          : left;
      if (
        compareRankedCandidate(
          this.values[worse] as RankedFileCandidate,
          this.values[index] as RankedFileCandidate
        ) <= 0
      )
        return;
      [this.values[index], this.values[worse]] = [
        this.values[worse] as RankedFileCandidate,
        this.values[index] as RankedFileCandidate
      ];
      index = worse;
    }
  }
}

function fuzzyPathScore(path: string, terms: readonly string[]): number {
  const source = path.toLocaleLowerCase();
  const name = source.slice(source.lastIndexOf('/') + 1);
  let total = 0;
  for (const needle of terms) {
    const score = fuzzyTermScore(source, name, needle);
    if (score < 0) return -1;
    total += score;
  }
  return total - path.length / 1_000;
}

function fuzzyTermScore(source: string, name: string, needle: string): number {
  if (name === needle || source === needle) return 1_000;
  if (name.startsWith(needle) || source.startsWith(needle)) return 700;
  if (source.endsWith(`/${needle}`) || source.includes(`/${needle}/`)) return 600;
  if (name.includes(needle) || source.includes(needle)) return 500;
  let cursor = 0;
  let score = 0;
  let previous = -2;
  for (const character of needle) {
    const index = source.indexOf(character, cursor);
    if (index === -1) return -1;
    score += index === previous + 1 ? 12 : 1;
    if (index === 0 || '/._-'.includes(source[index - 1] ?? '')) score += 8;
    previous = index;
    cursor = index + 1;
  }
  return 100 + score / 1_000;
}

async function inspectWorkspaceIndexEntry(
  root: string,
  requestedPath: string,
  name: string,
  excludes: readonly (Minimatch | RegExp)[]
): Promise<WorkspaceFileEntry | undefined> {
  try {
    const entry = await resolveWorkspaceEntryMetadata(root, requestedPath);
    if (!entry.metadata.isFile() && !entry.metadata.isDirectory()) return undefined;
    const safePath = relative(root, entry.path).split(sep).join('/');
    // The requested path was already checked; aliases need the canonical-path check too.
    if (safePath !== requestedPath && isExcluded(safePath, excludes)) return undefined;
    return entry.metadata.isDirectory()
      ? {
          path: safePath,
          name,
          kind: 'DIRECTORY',
          size: null,
          modifiedAt: entry.metadata.mtimeMs
        }
      : {
          path: safePath,
          name,
          kind: 'FILE',
          size: entry.metadata.size,
          modifiedAt: entry.metadata.mtimeMs
        };
  } catch {
    return undefined;
  }
}

function encodeSearchCursor(query: string, path: string): string {
  return Buffer.from(JSON.stringify({ query, path })).toString('base64url');
}

function decodeSearchCursor(cursor: string | undefined, expectedQuery: string): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      (value as Record<string, unknown>).query !== expectedQuery ||
      typeof (value as Record<string, unknown>).path !== 'string'
    )
      throw new Error();
    return (value as { path: string }).path;
  } catch {
    throw new Error('DIRECTORY_CURSOR_INVALID');
  }
}

/** Searches file names only, so an exploratory request cannot exfiltrate file contents. */
export async function searchWorkspaceFiles(
  workspaceRoot: string,
  query: string,
  cursor?: string,
  limit = SEARCH_RESULT_LIMIT,
  includeDirectories = false
): Promise<WorkspaceFileSearchPage> {
  const index = new WorkspaceFileIndex(workspaceRoot);
  try {
    return await index.search(query, cursor, limit, includeDirectories);
  } finally {
    index.dispose();
  }
}
