import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  opendir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises';
import { homedir, platform as hostPlatform } from 'node:os';
import { basename, dirname, isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path';
import { spawn } from 'node:child_process';
import type { GitSummary, WorkspaceGitTracking, WorkspaceKind } from '@myagentroam/protocol';
import { Minimatch } from 'minimatch';
import { logNodeCommandFailure } from './operational.js';
import { terminateProcessTree } from './process-tree.js';
import { gitOperationEnvironment } from './service/git-operation-service.js';

const GIT_TIMEOUT_MS = 5_000;
const GIT_STATUS_TIMEOUT_MS = 30_000;
const GIT_HISTORY_TIMEOUT_MS = 15_000;
const GIT_OUTPUT_LIMIT = 512 * 1024;
const GIT_LARGE_OUTPUT_LIMIT = 8 * 1024 * 1024;
const FILE_READ_LIMIT = 512 * 1024;
const DIRECTORY_PAGE_LIMIT = 200;
const DIRECTORY_PICKER_LIMIT = 200;
const SEARCH_RESULT_LIMIT = 200;
const GIT_WORKTREE_LIST_LIMIT = 128;
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
const REF_PATTERN = /^(?!-)(?!.*\.\.)(?!.*@\{)[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

export interface WorkspaceInspection {
  readonly path: string;
  readonly kind: WorkspaceKind;
  readonly gitSummary?: GitSummary;
}

export interface WorkspaceFileEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: 'FILE' | 'DIRECTORY';
  readonly size: number | null;
  readonly modifiedAt: number | null;
  readonly score?: number;
}

export interface WorkspaceFilePage {
  readonly entries: readonly WorkspaceFileEntry[];
  readonly nextCursor: string | null;
  readonly truncated: boolean;
}

export interface WorkspaceFileSearchPage {
  readonly entries: readonly WorkspaceFileEntry[];
  readonly nextCursor: string | null;
  readonly truncated: boolean;
  readonly indexState?: 'BUILDING' | 'READY';
}

export type WorkspaceUploadPreflightStatus =
  'READY' | 'EXISTS_FILE' | 'EXISTS_DIRECTORY' | 'INVALID_NAME';

export interface WorkspaceUploadTarget {
  readonly path: string;
  readonly absolutePath: string;
  readonly status: WorkspaceUploadPreflightStatus;
}

export interface WorkspaceDirectoryEntry {
  readonly path: string;
  readonly name: string;
  readonly selectable: boolean;
}

export interface WorkspaceDirectoryListing {
  readonly homePath: string;
  readonly currentPath: string;
  readonly parentPath: string | null;
  readonly browseRoots: readonly string[];
  readonly selectable: boolean;
  readonly entries: readonly WorkspaceDirectoryEntry[];
  readonly truncated: boolean;
}

export async function createWorkspaceDirectory(
  parentPath: string,
  directoryName: string,
  allowedRoots: readonly string[]
): Promise<string> {
  const name = directoryName.trim();
  if (
    name.length === 0 ||
    name.length > 255 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  )
    throw new Error('WORKSPACE_DIRECTORY_NAME_INVALID');
  const roots = await Promise.all(allowedRoots.map((root) => realpath(root)));
  const parent = await realpath(parentPath).catch(() => {
    throw new Error('WORKSPACE_DIRECTORY_NOT_ALLOWED');
  });
  const metadata = await stat(parent).catch(() => undefined);
  if (metadata?.isDirectory() !== true || !isWithinAllowedRoot(parent, roots))
    throw new Error('WORKSPACE_DIRECTORY_NOT_ALLOWED');
  const target = resolve(parent, name);
  if (dirname(target) !== parent || !isWithinAllowedRoot(target, roots))
    throw new Error('WORKSPACE_DIRECTORY_NAME_INVALID');
  try {
    await mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('WORKSPACE_DIRECTORY_EXISTS');
    throw error;
  }
  return target;
}

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

/**
 * Lists directory names only for the Workspace picker. Browsing begins at the
 * first allowed root when configured, while the Node account home remains a
 * browse boundary and terminal default.
 */
export async function listWorkspaceDirectories(
  requestedPath: string | undefined,
  allowedRoots: readonly string[],
  homePath = homedir()
): Promise<WorkspaceDirectoryListing> {
  const home = await realpath(homePath);
  const roots = await Promise.all(allowedRoots.map((root) => realpath(root)));
  const browseRoots = [...new Set([home, ...roots])];
  const requested =
    requestedPath === undefined ? (roots[0] ?? home) : await realpath(requestedPath);
  const directory = await stat(requested);
  if (!directory.isDirectory() || !isWithinAllowedRoot(requested, browseRoots))
    throw new Error('WORKSPACE_DIRECTORY_NOT_ALLOWED');

  const children = await readdir(requested, { withFileTypes: true });
  const entries: WorkspaceDirectoryEntry[] = [];
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!child.isDirectory() && !child.isSymbolicLink()) continue;
    const path = await realpath(resolve(requested, child.name)).catch(() => undefined);
    if (path === undefined || !isWithinAllowedRoot(path, browseRoots)) continue;
    const metadata = await stat(path).catch(() => undefined);
    if (metadata === undefined || !metadata.isDirectory()) continue;
    entries.push({ path, name: child.name, selectable: isWithinAllowedRoot(path, roots) });
    if (entries.length > DIRECTORY_PICKER_LIMIT) break;
  }
  const parent = dirname(requested);
  return {
    homePath: home,
    currentPath: requested,
    parentPath: parent === requested || !isWithinAllowedRoot(parent, browseRoots) ? null : parent,
    browseRoots: roots,
    selectable: isWithinAllowedRoot(requested, roots),
    entries: entries.slice(0, DIRECTORY_PICKER_LIMIT),
    truncated: entries.length > DIRECTORY_PICKER_LIMIT
  };
}

export async function listWorkspaceFiles(
  workspaceRoot: string,
  requestedPath = '.',
  cursor?: string,
  limit = DIRECTORY_PAGE_LIMIT
): Promise<WorkspaceFilePage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DIRECTORY_PAGE_LIMIT)
    throw new Error('DIRECTORY_CURSOR_INVALID');
  const root = await resolveRegisteredWorkspaceRoot(workspaceRoot);
  const directory = await resolveWorkspaceEntryFromCanonicalRoot(root, requestedPath, true);
  const entries = await readdir(directory, { withFileTypes: true });
  const cursorValue = decodeDirectoryCursor(cursor, requestedPath);
  const names = entries
    .filter((entry) => entry.name !== '.git' && !isWorkspaceUploadTemporaryName(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const start = cursorValue === undefined ? 0 : names.findIndex((name) => name > cursorValue);
  if (cursorValue !== undefined && start === -1)
    return { entries: [], nextCursor: null, truncated: false };
  const pageNames = names.slice(start, start + limit);
  const output: WorkspaceFileEntry[] = [];
  for (const name of pageNames) {
    const child = await resolveWorkspaceEntry(
      root,
      relative(root, resolve(directory, name)),
      false
    ).catch((error: unknown) => {
      if (isSkippableWorkspaceEntryError(error)) return undefined;
      throw error;
    });
    if (child === undefined) continue;
    const metadata = await lstat(child).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (metadata === undefined || (!metadata.isFile() && !metadata.isDirectory())) continue;
    output.push({
      path: relative(root, child).split(sep).join('/'),
      name,
      kind: metadata.isDirectory() ? 'DIRECTORY' : 'FILE',
      size: metadata.isFile() ? metadata.size : null,
      modifiedAt: metadata.mtimeMs
    });
  }
  const nextName = names[start + pageNames.length];
  return {
    entries: output,
    nextCursor:
      nextName === undefined || pageNames.length === 0
        ? null
        : encodeDirectoryCursor(requestedPath, pageNames[pageNames.length - 1] as string),
    truncated: nextName !== undefined
  };
}

export type WorkspaceFileMutation =
  | { readonly action: 'CREATE_FILE'; readonly path: string }
  | { readonly action: 'CREATE_DIRECTORY'; readonly path: string }
  | { readonly action: 'MOVE'; readonly path: string; readonly destination: string }
  | { readonly action: 'DELETE'; readonly path: string };

export async function mutateWorkspaceFile(
  workspaceRoot: string,
  mutation: WorkspaceFileMutation
): Promise<{ readonly path?: string; readonly deleted?: true }> {
  const root = await resolveRegisteredWorkspaceRoot(workspaceRoot);
  if (mutation.action === 'CREATE_FILE' || mutation.action === 'CREATE_DIRECTORY') {
    const target = await resolveNewWorkspaceEntry(root, mutation.path);
    if (mutation.action === 'CREATE_FILE') await writeFile(target, '', { flag: 'wx' });
    else await mkdir(target);
    return { path: workspaceRelativePath(root, target) };
  }
  await assertWorkspaceMutationPathHasNoSymlinks(root, mutation.path);
  const source = await resolveWorkspaceEntryMetadata(root, mutation.path);
  if (workspaceRelativePath(root, source.path) === '.')
    throw new Error('FILE_ROOT_MUTATION_INVALID');
  if (mutation.action === 'DELETE') {
    await rm(source.path, { recursive: source.metadata.isDirectory(), force: false });
    return { deleted: true };
  }
  const destination = await resolveNewWorkspaceEntry(root, mutation.destination);
  if (source.metadata.isDirectory()) {
    const destinationFromSource = relative(source.path, destination);
    if (
      destinationFromSource === '' ||
      (!isAbsolute(destinationFromSource) &&
        destinationFromSource !== '..' &&
        !destinationFromSource.startsWith(`..${sep}`))
    )
      throw new Error('FILE_MOVE_DESCENDANT_INVALID');
  }
  await rename(source.path, destination);
  return { path: workspaceRelativePath(root, destination) };
}

async function resolveNewWorkspaceEntry(root: string, requestedPath: string): Promise<string> {
  const normalized = requestedPath.replaceAll('\\', '/');
  const segments = normalized.split('/');
  const name = segments.at(-1);
  if (
    requestedPath.includes('\0') ||
    normalized.startsWith('/') ||
    isAbsolute(requestedPath) ||
    win32.isAbsolute(normalized) ||
    name === undefined ||
    name.length === 0 ||
    segments.some(invalidWorkspaceMutationSegment)
  )
    throw new Error('FILE_PATH_ESCAPE');
  const parentPath = segments.length === 1 ? '.' : segments.slice(0, -1).join('/');
  await assertWorkspaceMutationPathHasNoSymlinks(root, parentPath);
  const parent = await resolveWorkspaceEntryFromCanonicalRoot(root, parentPath, true);
  const target = resolve(parent, name);
  try {
    await lstat(target);
    throw new Error('FILE_ALREADY_EXISTS');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return target;
}

async function assertWorkspaceMutationPathHasNoSymlinks(
  root: string,
  requestedPath: string
): Promise<void> {
  const normalized = requestedPath.replaceAll('\\', '/');
  if (normalized === '.') return;
  const segments = normalized.split('/');
  if (
    requestedPath.includes('\0') ||
    normalized.startsWith('/') ||
    isAbsolute(requestedPath) ||
    win32.isAbsolute(normalized) ||
    segments.some(invalidWorkspaceMutationSegment)
  )
    throw new Error('FILE_PATH_ESCAPE');
  let candidate = root;
  for (const segment of segments) {
    candidate = resolve(candidate, segment);
    const metadata = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new Error('FILE_NOT_FOUND');
      throw error;
    });
    if (metadata.isSymbolicLink()) throw new Error('FILE_PATH_ESCAPE');
  }
}

function invalidWorkspaceMutationSegment(segment: string): boolean {
  if (segment.length === 0 || segment === '.' || segment === '..' || segment === '.git')
    return true;
  if (hostPlatform() !== 'win32') return false;
  const normalized = segment.replace(/[. ]+$/u, '').toUpperCase();
  return (
    /[<>:"|?*]/u.test(segment) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/u.test(normalized)
  );
}

function workspaceRelativePath(root: string, path: string): string {
  const value = relative(root, path).split(sep).join('/');
  return value.length === 0 ? '.' : value;
}

function isSkippableWorkspaceEntryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'FILE_PATH_ESCAPE' ||
      error.message === 'FILE_NOT_FOUND' ||
      error.message === 'FILE_NOT_REGULAR')
  );
}

/** Validates an upload destination without following an existing target symlink. */
export async function preflightWorkspaceUpload(
  workspaceRoot: string,
  requestedDirectory: string,
  name: string
): Promise<WorkspaceUploadTarget> {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('\0') ||
    name.includes('/') ||
    name.includes('\\') ||
    isWorkspaceUploadTemporaryName(name)
  ) {
    return { path: '', absolutePath: '', status: 'INVALID_NAME' };
  }
  const root = await resolveRegisteredWorkspaceRoot(workspaceRoot);
  const directory = await resolveWorkspaceEntry(root, requestedDirectory, true);
  const absolutePath = resolve(directory, name);
  if (dirname(absolutePath) !== directory) throw new Error('FILE_PATH_ESCAPE');
  const relativePath = relative(root, absolutePath).split(sep).join('/');
  const metadata = await lstat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (metadata === undefined) return { path: relativePath, absolutePath, status: 'READY' };
  if (metadata.isSymbolicLink()) throw new Error('FILE_PATH_ESCAPE');
  if (metadata.isFile()) return { path: relativePath, absolutePath, status: 'EXISTS_FILE' };
  return { path: relativePath, absolutePath, status: 'EXISTS_DIRECTORY' };
}

export function workspaceUploadTemporaryName(uploadId: string): string {
  return `.mar-upload-${uploadId}.part`;
}

function isWorkspaceUploadTemporaryName(name: string): boolean {
  return (
    /^\.mar-upload-[0-9a-f-]{36}\.part$/iu.test(name) ||
    /^\.mar-edit-[0-9a-f-]{36}\.part$/iu.test(name)
  );
}

export async function readWorkspaceTextFile(
  workspaceRoot: string,
  requestedPath: string,
  offset = 0,
  limit = FILE_READ_LIMIT
): Promise<{
  readonly path: string;
  readonly encoding: 'utf-8' | 'base64';
  readonly size: number;
  readonly content: string;
  readonly truncated: boolean;
  readonly nextOffset: number | null;
  readonly revision: string;
}> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > FILE_READ_LIMIT
  )
    throw new Error('FILE_RANGE_INVALID');
  const root = await resolveRegisteredWorkspaceRoot(workspaceRoot);
  const file = await resolveWorkspaceEntry(root, requestedPath, false);
  const metadata = await lstat(file);
  if (!metadata.isFile()) throw new Error('FILE_NOT_REGULAR');
  if (metadata.size > FILE_READ_LIMIT * 16) throw new Error('FILE_TOO_LARGE');
  const source = await readFile(file);
  const revision = createHash('sha256').update(source).digest('hex');
  const binary = source.includes(0) || !isValidUtf8(source);
  if (binary) {
    const end = Math.min(source.length, offset + limit);
    const slice = source.subarray(offset, end);
    return {
      path: relative(root, file).split(sep).join('/'),
      encoding: 'base64',
      size: source.length,
      content: slice.toString('base64'),
      truncated: end < source.length,
      nextOffset: end < source.length ? end : null,
      revision
    };
  }
  if (offset > 0 && offset < source.length && isUtf8ContinuationByte(source[offset] as number))
    throw new Error('FILE_RANGE_INVALID');
  let end = Math.min(source.length, offset + limit);
  if (end < source.length && isUtf8ContinuationByte(source[end] as number)) {
    while (end > offset && isUtf8ContinuationByte(source[end] as number)) end -= 1;
    if (end === offset) {
      end += 1;
      while (end < source.length && isUtf8ContinuationByte(source[end] as number)) end += 1;
    }
  }
  const slice = source.subarray(offset, end);
  const content = new TextDecoder('utf-8', { fatal: true }).decode(slice);
  const nextOffset = end < source.length ? end : null;
  return {
    path: relative(root, file).split(sep).join('/'),
    encoding: 'utf-8',
    size: source.length,
    content,
    truncated: nextOffset !== null,
    nextOffset,
    revision
  };
}

export async function writeWorkspaceTextFile(
  workspaceRoot: string,
  requestedPath: string,
  content: string,
  expectedRevision: string
): Promise<{ readonly path: string; readonly revision: string; readonly size: number }> {
  if (!/^[0-9a-f]{64}$/u.test(expectedRevision)) throw new Error('FILE_REVISION_INVALID');
  const source = Buffer.from(content, 'utf8');
  if (source.length > FILE_READ_LIMIT * 16) throw new Error('FILE_TOO_LARGE');
  if (source.includes(0)) throw new Error('FILE_NOT_TEXT');
  const root = await resolveRegisteredWorkspaceRoot(workspaceRoot);
  await assertWorkspaceMutationPathHasNoSymlinks(root, requestedPath);
  const file = await resolveWorkspaceEntry(root, requestedPath, false);
  const metadata = await lstat(file);
  if (!metadata.isFile()) throw new Error('FILE_NOT_REGULAR');
  const current = await readFile(file);
  if (current.includes(0) || !isValidUtf8(current)) throw new Error('FILE_NOT_TEXT');
  const currentRevision = createHash('sha256').update(current).digest('hex');
  if (currentRevision !== expectedRevision) throw new Error('FILE_WRITE_CONFLICT');
  const revision = createHash('sha256').update(source).digest('hex');
  const staging = resolve(dirname(file), `.mar-edit-${randomUUID()}.part`);
  try {
    await writeFile(staging, source, { flag: 'wx', mode: metadata.mode });
    await rename(staging, file);
  } finally {
    await rm(staging, { force: true }).catch(() => undefined);
  }
  return { path: workspaceRelativePath(root, file), revision, size: source.length };
}

export async function readWorkspaceFileContentRange(
  workspaceRoot: string,
  requestedPath: string,
  offset = 0,
  limit = FILE_READ_LIMIT
): Promise<{
  readonly path: string;
  readonly size: number;
  readonly sourceRevision: string;
  readonly offset: number;
  readonly contentBase64: string;
  readonly nextOffset: number | null;
}> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > FILE_READ_LIMIT
  )
    throw new Error('FILE_RANGE_INVALID');
  const root = await resolveRegisteredWorkspaceRoot(workspaceRoot);
  const file = await resolveWorkspaceEntry(root, requestedPath, false);
  const metadata = await lstat(file);
  if (!metadata.isFile()) throw new Error('FILE_NOT_REGULAR');
  if (offset > metadata.size) throw new Error('FILE_RANGE_INVALID');
  const length = Math.min(limit, metadata.size - offset);
  const source = Buffer.allocUnsafe(length);
  const handle = await open(file, 'r');
  try {
    const { bytesRead } = await handle.read(source, 0, length, offset);
    const end = offset + bytesRead;
    return {
      path: relative(root, file).split(sep).join('/'),
      size: metadata.size,
      sourceRevision: fileSourceRevision(metadata),
      offset,
      contentBase64: source.subarray(0, bytesRead).toString('base64'),
      nextOffset: end < metadata.size ? end : null
    };
  } finally {
    await handle.close();
  }
}

/** Reads one regular absolute file range using the Node account's filesystem permissions. */
export async function readAbsoluteFileContentRange(
  requestedPath: string,
  offset = 0,
  limit = FILE_READ_LIMIT
): Promise<{
  readonly path: string;
  readonly size: number;
  readonly sourceRevision: string;
  readonly offset: number;
  readonly contentBase64: string;
  readonly nextOffset: number | null;
}> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > FILE_READ_LIMIT
  )
    throw new Error('FILE_RANGE_INVALID');
  const { file, metadata } = await resolveAbsoluteFile(requestedPath);
  if (offset > metadata.size) throw new Error('FILE_RANGE_INVALID');
  const length = Math.min(limit, metadata.size - offset);
  const source = Buffer.allocUnsafe(length);
  const handle = await open(file, 'r');
  try {
    const { bytesRead } = await handle.read(source, 0, length, offset);
    const end = offset + bytesRead;
    return {
      path: file,
      size: metadata.size,
      sourceRevision: fileSourceRevision(metadata),
      offset,
      contentBase64: source.subarray(0, bytesRead).toString('base64'),
      nextOffset: end < metadata.size ? end : null
    };
  } finally {
    await handle.close();
  }
}

function fileSourceRevision(metadata: Stats): string {
  return createHash('sha256')
    .update(
      [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join(':')
    )
    .digest('hex');
}

/** Reads one regular absolute file using the Node account's filesystem permissions. */
export async function readAbsoluteTextFile(
  requestedPath: string,
  offset = 0,
  limit = FILE_READ_LIMIT
): Promise<{
  readonly path: string;
  readonly encoding: 'utf-8' | 'base64';
  readonly size: number;
  readonly content: string;
  readonly truncated: boolean;
  readonly nextOffset: number | null;
}> {
  const { file, metadata } = await resolveAbsoluteFile(requestedPath);
  if (metadata.size > FILE_READ_LIMIT * 16) throw new Error('FILE_TOO_LARGE');
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > FILE_READ_LIMIT
  )
    throw new Error('FILE_RANGE_INVALID');
  const source = await readFile(file);
  const binary = source.includes(0) || !isValidUtf8(source);
  const end = Math.min(source.length, offset + limit);
  if (binary) {
    const slice = source.subarray(offset, end);
    return {
      path: file,
      encoding: 'base64',
      size: source.length,
      content: slice.toString('base64'),
      truncated: end < source.length,
      nextOffset: end < source.length ? end : null
    };
  }
  if (offset > 0 && offset < source.length && isUtf8ContinuationByte(source[offset] as number))
    throw new Error('FILE_RANGE_INVALID');
  let textEnd = end;
  if (textEnd < source.length && isUtf8ContinuationByte(source[textEnd] as number)) {
    while (textEnd > offset && isUtf8ContinuationByte(source[textEnd] as number)) textEnd -= 1;
    if (textEnd === offset) {
      textEnd += 1;
      while (textEnd < source.length && isUtf8ContinuationByte(source[textEnd] as number))
        textEnd += 1;
    }
  }
  const nextOffset = textEnd < source.length ? textEnd : null;
  return {
    path: file,
    encoding: 'utf-8',
    size: source.length,
    content: new TextDecoder('utf-8', { fatal: true }).decode(source.subarray(offset, textEnd)),
    truncated: nextOffset !== null,
    nextOffset
  };
}

export function normalizeFilePreviewPath(requestedPath: string): string {
  if (!/^sandbox:/iu.test(requestedPath)) return requestedPath;
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestedPath.slice(requestedPath.indexOf(':') + 1));
  } catch {
    throw new Error('FILE_PATH_ESCAPE');
  }
  const normalized = decoded.replace(/^\/([a-z]:[\\/])/iu, '$1');
  if (
    normalized.length === 0 ||
    /^[\\/]{2,}[?.](?:[\\/]|$)/u.test(decoded) ||
    (!isAbsolute(normalized) && !win32.isAbsolute(normalized)) ||
    normalized.includes('\0') ||
    normalized.includes('?') ||
    normalized.includes('#')
  )
    throw new Error('FILE_PATH_ESCAPE');
  return normalized;
}

async function resolveAbsoluteFile(
  requestedPath: string
): Promise<{ readonly file: string; readonly metadata: Stats }> {
  if (!isAbsolute(requestedPath)) throw new Error('FILE_PATH_ESCAPE');
  const file = await realpath(requestedPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error('FILE_NOT_FOUND');
    throw error;
  });
  const metadata = await lstat(file);
  if (!metadata.isFile()) throw new Error('FILE_NOT_REGULAR');
  return { file, metadata };
}

function isValidUtf8(source: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(source);
    return true;
  } catch {
    return false;
  }
}

function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0b1100_0000) === 0b1000_0000;
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

async function resolveRegisteredWorkspaceRoot(workspaceRoot: string): Promise<string> {
  const root = await realpath(workspaceRoot);
  if (normalizeWorkspacePath(root) !== normalizeWorkspacePath(workspaceRoot))
    throw Object.assign(new Error('WORKSPACE_NOT_ALLOWED'), { code: 'WORKSPACE_NOT_ALLOWED' });
  return root;
}

export class SessionExecutionDirectoryError extends Error {
  readonly code = 'SESSION_EXECUTION_DIRECTORY_INVALID';
  readonly publicParameters: { readonly reason: string };

  constructor(
    reason: string,
    readonly publicMessage: string,
    options?: ErrorOptions
  ) {
    super(publicMessage, options);
    this.publicParameters = { reason };
  }
}

/** Bind ordinary Session execution to one registered Workspace, not all allowed roots. */
export async function resolveWorkspaceExecutionDirectory(
  workspaceRoot: string,
  cwd: string
): Promise<string> {
  if (!isAbsolute(cwd) || (process.platform === 'win32' && win32.parse(cwd).root.length <= 1))
    throw new SessionExecutionDirectoryError(
      'ABSOLUTE_PATH_REQUIRED',
      'The execution directory must be an absolute path on this Node.'
    );
  try {
    const root = await resolveRegisteredWorkspaceRoot(workspaceRoot);
    const directory = await realpath(cwd);
    if (!isWithinAllowedRoot(directory, [root]))
      throw new SessionExecutionDirectoryError(
        'OUTSIDE_WORKSPACE',
        'The execution directory is outside the authorized Workspace.'
      );
    if (!(await stat(directory)).isDirectory())
      throw new SessionExecutionDirectoryError(
        'NOT_DIRECTORY',
        'The execution directory is not a directory.'
      );
    return directory;
  } catch (error) {
    if (error instanceof SessionExecutionDirectoryError) throw error;
    const code =
      error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const [reason, message] =
      code === 'WORKSPACE_NOT_ALLOWED'
        ? [
            'WORKSPACE_ROOT_CHANGED',
            'The registered Workspace root no longer identifies the same directory.'
          ]
        : code === 'ENOENT' || code === 'ENOTDIR'
          ? ['NOT_FOUND', 'The execution directory or Workspace root is unavailable.']
          : code === 'EACCES' || code === 'EPERM'
            ? [
                'ACCESS_DENIED',
                'The Node account cannot access the execution directory or Workspace root.'
              ]
            : ['IO_ERROR', 'The execution directory could not be verified.'];
    throw new SessionExecutionDirectoryError(reason!, message!, { cause: error });
  }
}

async function resolveWorkspaceEntry(
  workspaceRoot: string,
  requestedPath: string,
  directory: boolean
): Promise<string> {
  const root = await resolveRegisteredWorkspaceRoot(workspaceRoot);
  return resolveWorkspaceEntryFromCanonicalRoot(root, requestedPath, directory);
}

async function resolveWorkspaceEntryFromCanonicalRoot(
  root: string,
  requestedPath: string,
  directory: boolean
): Promise<string> {
  const entry = await resolveWorkspaceEntryMetadata(root, requestedPath);
  if (
    directory
      ? !entry.metadata.isDirectory()
      : !entry.metadata.isFile() && !entry.metadata.isDirectory()
  )
    throw new Error(directory ? 'FILE_NOT_DIRECTORY' : 'FILE_NOT_REGULAR');
  return entry.path;
}

async function resolveWorkspaceEntryMetadata(
  root: string,
  requestedPath: string
): Promise<{ readonly path: string; readonly metadata: Stats }> {
  if (
    requestedPath.includes('\0') ||
    requestedPath.length === 0 ||
    requestedPath.startsWith('/') ||
    requestedPath.startsWith('\\')
  )
    throw new Error('FILE_PATH_ESCAPE');
  const normalized = requestedPath.replaceAll('\\', '/');
  if (normalized.split('/').some((segment) => segment === '..' || segment === '.git'))
    throw new Error('FILE_PATH_ESCAPE');
  let candidate: string;
  try {
    candidate = await realpath(resolve(root, normalized));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('FILE_NOT_FOUND');
    throw error;
  }
  const pathToCandidate = relative(root, candidate);
  if (
    isAbsolute(pathToCandidate) ||
    pathToCandidate.startsWith('..') ||
    pathToCandidate === '..' ||
    pathToCandidate.startsWith(`..${sep}`)
  )
    throw new Error('FILE_PATH_ESCAPE');
  const metadata = await lstat(candidate);
  return { path: candidate, metadata };
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

function encodeDirectoryCursor(path: string, name: string): string {
  return Buffer.from(JSON.stringify({ path, name })).toString('base64url');
}

function decodeDirectoryCursor(
  cursor: string | undefined,
  expectedPath: string
): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      (value as Record<string, unknown>).path !== expectedPath ||
      typeof (value as Record<string, unknown>).name !== 'string'
    )
      throw new Error();
    return (value as { name: string }).name;
  } catch {
    throw new Error('DIRECTORY_CURSOR_INVALID');
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

export function normalizeWorkspacePath(
  input: string,
  platform: NodeJS.Platform = hostPlatform()
): string {
  if (input.length === 0 || input.includes('\u0000')) {
    throw new Error('WORKSPACE_PATH_INVALID');
  }
  if (platform === 'win32') {
    // Device paths bypass normal Win32 resolution and must never be accepted.
    if (/^\\\\[?.]/.test(input)) {
      throw new Error('WORKSPACE_DEVICE_PATH_REJECTED');
    }
    const normalized = win32.normalize(input.replaceAll('/', '\\'));
    if (!win32.isAbsolute(normalized)) {
      throw new Error('WORKSPACE_PATH_NOT_ABSOLUTE');
    }
    // A drive root must remain absolute instead of becoming drive-relative.
    const root = win32.parse(normalized).root;
    return (normalized === root ? root : normalized.replace(/\\+$/, '')).toLowerCase();
  }
  if (platform !== 'linux' && platform !== 'darwin') {
    throw new Error('WORKSPACE_PLATFORM_UNSUPPORTED');
  }
  const normalized = posix.normalize(input);
  if (!posix.isAbsolute(normalized)) {
    throw new Error('WORKSPACE_PATH_NOT_ABSOLUTE');
  }
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}

export function isWithinAllowedRoot(
  target: string,
  roots: readonly string[],
  platform: NodeJS.Platform = hostPlatform()
): boolean {
  const normalizedTarget = normalizeWorkspacePath(target, platform);
  const pathApi = platform === 'win32' ? win32 : posix;
  return roots.some((root) => {
    const normalizedRoot = normalizeWorkspacePath(root, platform);
    const relative = pathApi.relative(normalizedRoot, normalizedTarget);
    return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative));
  });
}

/** Resolving both candidate and roots rejects Linux symlinks which point outside a root. */
export async function inspectWorkspace(
  requestedPath: string,
  allowedRoots: readonly string[]
): Promise<WorkspaceInspection> {
  const resolvedPath = await realpath(requestedPath);
  const resolvedRoots = await Promise.all(allowedRoots.map((root) => realpath(root)));
  const directory = await stat(resolvedPath);
  if (!directory.isDirectory() || !isWithinAllowedRoot(resolvedPath, resolvedRoots)) {
    throw new Error('WORKSPACE_NOT_ALLOWED');
  }
  try {
    const summary = await readGitSummary(resolvedPath);
    return { path: resolvedPath, kind: 'GIT_WORKSPACE', gitSummary: summary };
  } catch (error) {
    if ((error instanceof GitCommandError && error.code === 128) || isGitUnavailable(error)) {
      return { path: resolvedPath, kind: 'DIRECTORY' };
    }
    throw error;
  }
}

export async function readGitSummary(workspacePath: string): Promise<GitSummary> {
  const commonDir = (
    await runReadOnlyGit(workspacePath, ['rev-parse', '--git-common-dir'])
  ).text.trim();
  const headResult = await runReadOnlyGitAllowFailure(workspacePath, [
    'rev-parse',
    '--verify',
    'HEAD'
  ]);
  const branchResult = await runReadOnlyGitAllowFailure(workspacePath, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD'
  ]);
  const statusOptions = {
    timeoutMs: GIT_STATUS_TIMEOUT_MS,
    outputLimit: GIT_LARGE_OUTPUT_LIMIT
  };
  const status = await runReadOnlyGit(workspacePath, ['status', '--porcelain=v1'], statusOptions);
  return {
    commonDir,
    head: headResult.code === 0 ? headResult.text.trim() : '',
    branch: branchResult.code === 0 ? branchResult.text.trim() : null,
    dirty: status.output.length > 0,
    snapshot: summarizeText(status.text)
  };
}

export function assertSafeGitRef(ref: string): void {
  if (!REF_PATTERN.test(ref)) {
    throw new Error('GIT_REF_INVALID');
  }
}

export async function readRestrictedDiff(
  workspacePath: string,
  fromRef: string,
  toRef: string
): Promise<{
  readonly binary: boolean;
  readonly text?: string;
  readonly summary?: string;
  readonly truncated: boolean;
}> {
  assertSafeGitRef(fromRef);
  assertSafeGitRef(toRef);
  const result = await runReadOnlyGit(workspacePath, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    fromRef,
    toRef
  ]);
  const binary = result.output.includes(0) || result.text.includes('Binary files ');
  if (binary) {
    return {
      binary: true,
      summary: `binary diff sha256=${createHash('sha256').update(result.output).digest('hex')} bytes=${result.output.length}`,
      truncated: result.truncated
    };
  }
  return { binary: false, text: result.text, truncated: result.truncated };
}

export type CurrentChange = {
  readonly path: string;
  readonly state: 'STAGED' | 'UNSTAGED' | 'UNTRACKED';
  readonly change: 'ADDED' | 'MODIFIED' | 'DELETED' | 'RENAMED' | 'COPIED' | 'TYPE_CHANGED';
};

export interface CurrentChangesRepository {
  readonly repositoryPath: string;
  readonly repositoryName: string;
  readonly branch: string | null;
  readonly tracking?: WorkspaceGitTracking;
  readonly changes: readonly CurrentChange[];
}

export interface GitWorktreeListEntry {
  readonly path: string;
  readonly directoryName: string;
  readonly branch: string | null;
  readonly head: string;
  readonly current: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

export interface GitWorktreeList {
  readonly entries: readonly GitWorktreeListEntry[];
  readonly truncated: boolean;
}

function currentBranchFromStatusHeader(header: string): string | null {
  const value = header.slice(3);
  if (value.startsWith('HEAD ')) return null;
  const unborn = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(value);
  if (unborn !== null) return unborn[1] ?? null;
  return value.split('...')[0]?.split(' ')[0] ?? null;
}

function trackingFromStatusHeader(header: string): CurrentChangesRepository['tracking'] {
  const match = /^## [^ ]+\.\.\.([^ ]+)(?: \[(ahead \d+)?(?:, )?(behind \d+)?\])?$/.exec(header);
  if (match?.[1] === undefined) return undefined;
  return {
    upstream: match[1],
    ahead: Number(match[2]?.slice(6) ?? 0),
    behind: Number(match[3]?.slice(7) ?? 0)
  };
}

export async function listGitWorktrees(workspacePath: string): Promise<GitWorktreeList> {
  const options = {
    timeoutMs: GIT_STATUS_TIMEOUT_MS,
    outputLimit: GIT_LARGE_OUTPUT_LIMIT
  };
  const nulDelimited = await runReadOnlyGitAllowFailure(
    workspacePath,
    ['worktree', 'list', '--porcelain', '-z'],
    options
  );
  if (nulDelimited.code === 0) return parseGitWorktreeList(workspacePath, nulDelimited, true);
  if (!canRetryGitWorktreeListWithoutNullOutput(nulDelimited))
    throw gitCommandFailure(nulDelimited.code, nulDelimited.stderr, 'worktree');
  const lineDelimited = await runReadOnlyGit(
    workspacePath,
    ['worktree', 'list', '--porcelain'],
    options
  );
  return parseGitWorktreeList(workspacePath, lineDelimited, false);
}

async function parseGitWorktreeList(
  workspacePath: string,
  result: GitResult,
  nulDelimited: boolean
): Promise<GitWorktreeList> {
  const currentPath = normalizeWorkspacePath(await realpath(workspacePath));
  const entries: GitWorktreeListEntry[] = [];
  let truncated = result.truncated;
  const groups = nulDelimited ? result.text.split('\0\0') : result.text.split(/\r?\n\r?\n/);
  for (const group of groups) {
    if (group.length === 0) continue;
    if (entries.length >= GIT_WORKTREE_LIST_LIMIT) {
      truncated = true;
      break;
    }
    const fields = (nulDelimited ? group.split('\0') : group.split(/\r?\n/)).filter(
      (field) => field.length > 0
    );
    if (
      !nulDelimited &&
      fields.some(
        (field) =>
          !(
            field.startsWith('worktree ') ||
            field.startsWith('HEAD ') ||
            field.startsWith('branch ') ||
            field === 'bare' ||
            field === 'detached' ||
            field === 'locked' ||
            field.startsWith('locked ') ||
            field === 'prunable' ||
            field.startsWith('prunable ')
          )
      )
    ) {
      throw new Error('GIT_WORKTREE_LIST_INVALID');
    }
    if (fields.some((field) => field === 'bare')) continue;
    const pathField = fields.find((field) => field.startsWith('worktree '));
    const headField = fields.find((field) => field.startsWith('HEAD '));
    const path = pathField?.slice('worktree '.length);
    const head = headField?.slice('HEAD '.length);
    if (
      path === undefined ||
      path.length === 0 ||
      head === undefined ||
      !/^[0-9a-f]{40,64}$/u.test(head)
    ) {
      if (result.truncated) {
        truncated = true;
        continue;
      }
      throw new Error('GIT_WORKTREE_LIST_INVALID');
    }
    const branchField = fields.find((field) => field.startsWith('branch '));
    const branchRef = branchField?.slice('branch '.length);
    const branch =
      branchRef === undefined
        ? null
        : branchRef.startsWith('refs/heads/')
          ? branchRef.slice('refs/heads/'.length)
          : branchRef;
    const directoryName = (basename(path).trim() || branch || head.slice(0, 12)).slice(0, 512);
    entries.push({
      path,
      directoryName,
      branch,
      head,
      current: normalizeWorkspacePath(path) === currentPath,
      locked: fields.some((field) => field === 'locked' || field.startsWith('locked ')),
      prunable: fields.some((field) => field === 'prunable' || field.startsWith('prunable '))
    });
  }
  return { entries, truncated };
}

export async function readCurrentChangesSummary(
  workspacePath: string,
  isolateSubmoduleFailures = false
): Promise<{
  readonly branch: string | null;
  readonly tracking?: WorkspaceGitTracking;
  readonly changes: readonly CurrentChange[];
}> {
  const args = [
    'status',
    '--porcelain=v1',
    '-z',
    '--branch',
    '--ahead-behind',
    '--untracked-files=all'
  ];
  const options = { timeoutMs: GIT_STATUS_TIMEOUT_MS, outputLimit: GIT_LARGE_OUTPUT_LIMIT };
  const result = await runReadOnlyGit(workspacePath, args, options).catch((error: unknown) => {
    if (!isolateSubmoduleFailures || !(error instanceof GitCommandError)) throw error;
    // Validate root facts independently when descending into a damaged child fails.
    // A second failure remains a repository failure, never an empty success.
    return runReadOnlyGit(workspacePath, [...args, '--ignore-submodules=dirty'], options);
  });
  const records = result.text.split('\0');
  const header = records.shift() ?? '';
  const output: CurrentChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as string;
    if (record.length < 4) continue;
    const indexState = record[0] as string;
    const worktreeState = record[1] as string;
    const path = record.slice(3);
    if (indexState === '?' && worktreeState === '?') {
      output.push({ path, state: 'UNTRACKED', change: 'ADDED' });
      continue;
    }
    if (indexState !== ' ') {
      output.push({ path, state: 'STAGED', change: gitChange(indexState) });
    }
    if (worktreeState !== ' ') {
      output.push({ path, state: 'UNSTAGED', change: gitChange(worktreeState) });
    }
    // Porcelain v1 -z emits a second NUL-delimited source path for rename
    // and copy records. It is metadata for the same entry, never another
    // status record.
    if (indexState === 'R' || indexState === 'C' || worktreeState === 'R' || worktreeState === 'C')
      index += 1;
  }
  const tracking = trackingFromStatusHeader(header);
  return {
    branch: header.startsWith('## ') ? currentBranchFromStatusHeader(header) : null,
    ...(tracking === undefined ? {} : { tracking }),
    changes: output
  };
}

export async function listGitSubmodules(workspacePath: string): Promise<
  readonly {
    readonly path: string;
    readonly mapping: 'MAPPED' | 'MISSING' | 'INVALID';
    readonly gitExitCode?: number;
  }[]
> {
  const result = await runReadOnlyGit(workspacePath, ['ls-files', '--stage', '-z'], {
    timeoutMs: GIT_STATUS_TIMEOUT_MS,
    outputLimit: GIT_LARGE_OUTPUT_LIMIT
  });
  if (result.truncated) throw new Error('GIT_SUBMODULE_DISCOVERY_TRUNCATED');
  const paths = [
    ...new Set(
      result.text.split('\0').flatMap((record) => {
        const match = /^160000 [0-9a-f]+ [0-3]\t([\s\S]+)$/.exec(record);
        return match?.[1] === undefined ? [] : [match[1]];
      })
    )
  ].sort((left, right) => left.localeCompare(right));
  if (paths.length === 0) return [];
  const unavailable = (mapping: 'MISSING' | 'INVALID', gitExitCode?: number) =>
    paths.map((path) => ({ path, mapping, ...(gitExitCode === undefined ? {} : { gitExitCode }) }));
  try {
    const modulesFile = await lstat(resolve(workspacePath, '.gitmodules'));
    if (!modulesFile.isFile() || modulesFile.isSymbolicLink()) return unavailable('INVALID');
  } catch (error) {
    return unavailable((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MISSING' : 'INVALID');
  }
  const mappings = await runReadOnlyGitAllowFailure(
    workspacePath,
    ['config', '--null', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(path|url)$'],
    { outputLimit: GIT_LARGE_OUTPUT_LIMIT }
  );
  if (mappings.truncated || (mappings.code !== 0 && mappings.code !== 1))
    return unavailable('INVALID', mappings.code);
  const byName = new Map<string, { path?: string; hasUrl?: boolean }>();
  for (const entry of mappings.text.split('\0')) {
    const separator = entry.indexOf('\n');
    if (separator < 0) continue;
    const key = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    const match = /^submodule\.(.*)\.(path|url)$/.exec(key);
    if (match?.[1] === undefined) continue;
    const mapping = byName.get(match[1]) ?? {};
    if (match[2] === 'path') mapping.path = value;
    else mapping.hasUrl = value.trim().length > 0;
    byName.set(match[1], mapping);
  }
  const mappedPaths = new Set(
    [...byName.values()].flatMap((mapping) =>
      mapping.path !== undefined && mapping.hasUrl ? [mapping.path] : []
    )
  );
  return paths.map((path) => ({ path, mapping: mappedPaths.has(path) ? 'MAPPED' : 'MISSING' }));
}

export async function resolveGitRepository(
  workspacePath: string,
  repositoryPath: string,
  initializedSubmodulePaths?: readonly string[]
): Promise<string> {
  const root = await realpath(workspacePath);
  if (repositoryPath.length === 0) return root;
  if (
    repositoryPath.includes('\0') ||
    repositoryPath.startsWith('/') ||
    repositoryPath.startsWith('\\') ||
    repositoryPath
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  )
    throw new Error('GIT_REPOSITORY_INVALID');
  try {
    const requestedRepository = resolve(root, repositoryPath);
    const repository = await realpath(requestedRepository);
    if (
      normalizeWorkspacePath(requestedRepository) !== normalizeWorkspacePath(repository) ||
      !isWithinAllowedRoot(repository, [root])
    )
      throw new Error('invalid');
    if (initializedSubmodulePaths !== undefined) {
      if (!initializedSubmodulePaths.includes(repositoryPath)) throw new Error('invalid');
      return repository;
    }
    await assertGitSuperprojectChain(root, repository);
    return repository;
  } catch {
    throw new Error('GIT_REPOSITORY_INVALID');
  }
}

export async function resolveGitRepositoryTarget(
  workspacePath: string,
  repositoryPath: string,
  worktreePath?: string,
  initializedSubmodulePaths?: readonly string[]
): Promise<string> {
  if (worktreePath === undefined)
    return resolveGitRepository(workspacePath, repositoryPath, initializedSubmodulePaths);
  if (
    repositoryPath.length !== 0 ||
    worktreePath.length === 0 ||
    worktreePath.length > 4096 ||
    worktreePath.includes('\0')
  )
    throw new Error('GIT_REPOSITORY_INVALID');
  const requestedKey = normalizeWorkspacePath(worktreePath);
  const worktrees = await listGitWorktrees(workspacePath);
  const matched = worktrees.entries.find(
    (entry) => normalizeWorkspacePath(entry.path) === requestedKey
  );
  if (matched === undefined || matched.prunable) throw new Error('GIT_REPOSITORY_INVALID');
  try {
    return await realpath(matched.path);
  } catch {
    throw new Error('GIT_REPOSITORY_INVALID');
  }
}

async function assertGitSuperprojectChain(root: string, repository: string): Promise<void> {
  const rootKey = normalizeWorkspacePath(root);
  let current = repository;
  const visited = new Set<string>();
  for (let depth = 0; depth < 64; depth += 1) {
    const currentKey = normalizeWorkspacePath(current);
    if (currentKey === rootKey) return;
    if (visited.has(currentKey)) throw new Error('invalid');
    visited.add(currentKey);
    const result = await runReadOnlyGit(current, [
      'rev-parse',
      '--show-toplevel',
      '--show-superproject-working-tree'
    ]);
    const [topLevel, superproject] = result.text.split(/\r?\n/);
    if (topLevel === undefined || superproject === undefined || superproject.length === 0)
      throw new Error('invalid');
    const resolvedTopLevel = await realpath(topLevel);
    const resolvedSuperproject = await realpath(superproject);
    if (
      normalizeWorkspacePath(resolvedTopLevel) !== currentKey ||
      normalizeWorkspacePath(resolvedSuperproject) === currentKey ||
      !isWithinAllowedRoot(resolvedSuperproject, [root]) ||
      !isWithinAllowedRoot(current, [resolvedSuperproject])
    )
      throw new Error('invalid');
    current = resolvedSuperproject;
  }
  throw new Error('invalid');
}

export interface GitHistoryRefEntry {
  readonly name: string;
  readonly displayName: string;
  readonly kind: 'LOCAL' | 'REMOTE';
  readonly hash: string;
  readonly current: boolean;
}

export async function listGitHistoryRefs(
  repository: string
): Promise<readonly GitHistoryRefEntry[]> {
  const result = await runReadOnlyGit(
    repository,
    [
      'for-each-ref',
      '--format=%(refname)%09%(refname:short)%09%(objectname)%09%(HEAD)%09%(symref)',
      'refs/heads',
      'refs/remotes'
    ],
    {
      timeoutMs: GIT_HISTORY_TIMEOUT_MS,
      outputLimit: GIT_LARGE_OUTPUT_LIMIT
    }
  );
  return result.text
    .split(/\r?\n/)
    .flatMap((line) => {
      const [name, displayName, hash, head, symref] = line.split('\t');
      if (
        name === undefined ||
        displayName === undefined ||
        hash === undefined ||
        symref === undefined ||
        symref.length > 0 ||
        !/^[0-9a-f]{40,64}$/.test(hash)
      )
        return [];
      const kind = name.startsWith('refs/heads/')
        ? ('LOCAL' as const)
        : name.startsWith('refs/remotes/')
          ? ('REMOTE' as const)
          : undefined;
      return kind === undefined ? [] : [{ name, displayName, kind, hash, current: head === '*' }];
    })
    .sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) || left.displayName.localeCompare(right.displayName)
    );
}

function selectedHistoryRefs(
  available: readonly GitHistoryRefEntry[],
  requested: readonly string[] | undefined
): readonly GitHistoryRefEntry[] {
  if (requested === undefined || requested.length === 0) return available;
  const unique = [...new Set(requested)];
  const selected = unique.map((name) => available.find((entry) => entry.name === name));
  if (selected.some((entry) => entry === undefined)) throw new Error('GIT_HISTORY_REF_INVALID');
  return selected as readonly GitHistoryRefEntry[];
}

function historyCursor(offset: number, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ offset, fingerprint })).toString('base64url');
}

function parseHistoryCursor(value: string | undefined, fingerprint: string): number {
  if (value === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      !Number.isInteger(parsed.offset) ||
      (parsed.offset as number) < 0 ||
      parsed.fingerprint !== fingerprint
    )
      throw new Error('invalid');
    return parsed.offset as number;
  } catch {
    throw new Error('GIT_HISTORY_CURSOR_INVALID');
  }
}

export async function readGitHistory(
  repository: string,
  input: { readonly refs?: readonly string[]; readonly cursor?: string; readonly limit?: number }
): Promise<{ readonly commits: readonly object[]; readonly nextCursor: string | null }> {
  const available = await listGitHistoryRefs(repository);
  const selected = selectedHistoryRefs(available, input.refs);
  if (selected.length === 0) return { commits: [], nextCursor: null };
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('GIT_HISTORY_LIMIT_INVALID');
  const names = selected.map((entry) => entry.name).sort();
  const allBranchesSelected =
    input.refs === undefined ||
    input.refs.length === 0 ||
    (selected.length === available.length &&
      selected.every((entry) => available.some((candidate) => candidate.name === entry.name)));
  const revisionArguments = allBranchesSelected ? ['--branches', '--remotes'] : names;
  // Bind the offset cursor to the exact branch tips. Advancing a branch invalidates
  // the cursor instead of silently skipping or duplicating commits between pages.
  const fingerprint = createHash('sha256')
    .update(
      selected
        .map((entry) => `${entry.name}\0${entry.hash}`)
        .sort()
        .join('\0')
    )
    .digest('hex');
  const offset = parseHistoryCursor(input.cursor, fingerprint);
  const result = await runReadOnlyGit(
    repository,
    [
      'log',
      '--topo-order',
      '--date-order',
      `--skip=${offset}`,
      `--max-count=${limit + 1}`,
      '-z',
      '--format=%H%x00%P%x00%an%x00%ae%x00%ct%x00%s',
      ...revisionArguments,
      '--'
    ],
    { timeoutMs: GIT_HISTORY_TIMEOUT_MS }
  );
  const refsByHash = new Map<string, string[]>();
  for (const entry of available) {
    const refs = refsByHash.get(entry.hash) ?? [];
    refs.push(entry.displayName);
    refsByHash.set(entry.hash, refs);
  }
  const fields = result.text.split('\0');
  const commits: object[] = [];
  for (let index = 0; index + 5 < fields.length; index += 6) {
    const [hash, parents = '', authorName = '', authorEmail = '', committedAt = '0', subject = ''] =
      fields.slice(index, index + 6);
    if (hash === undefined || !/^[0-9a-f]{40,64}$/.test(hash)) continue;
    commits.push({
      hash,
      parents: parents.length === 0 ? [] : parents.split(' '),
      authorName,
      authorEmail,
      committedAt: Number(committedAt) * 1000,
      subject,
      refs: refsByHash.get(hash) ?? []
    });
  }
  const hasMore = commits.length > limit;
  return {
    commits: commits.slice(0, limit),
    nextCursor: hasMore ? historyCursor(offset + limit, fingerprint) : null
  };
}

async function assertHistoryCommitReachable(
  repository: string,
  commit: string,
  refs: readonly string[] | undefined
): Promise<void> {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('GIT_HISTORY_COMMIT_INVALID');
  const selected = selectedHistoryRefs(await listGitHistoryRefs(repository), refs);
  for (const ref of selected) {
    const result = await runReadOnlyGitAllowFailure(repository, [
      'merge-base',
      '--is-ancestor',
      commit,
      ref.name
    ]);
    if (result.code === 0) return;
  }
  throw new Error('GIT_HISTORY_COMMIT_INVALID');
}

export async function readGitHistoryFiles(
  repository: string,
  commit: string,
  refs?: readonly string[]
): Promise<
  readonly { path: string; previousPath?: string; change: ReturnType<typeof gitChange> }[]
> {
  await assertHistoryCommitReachable(repository, commit, refs);
  const result = await runReadOnlyGit(
    repository,
    [
      'diff-tree',
      '--root',
      '--first-parent',
      '--no-commit-id',
      '-r',
      '-z',
      '-M',
      '-C',
      '--name-status',
      commit
    ],
    {
      timeoutMs: GIT_STATUS_TIMEOUT_MS,
      outputLimit: GIT_LARGE_OUTPUT_LIMIT
    }
  );
  const records = result.text.split('\0');
  const files: { path: string; previousPath?: string; change: ReturnType<typeof gitChange> }[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const status = records[index];
    if (status === undefined || status.length === 0) continue;
    const code = status[0] ?? 'M';
    if (code === 'R' || code === 'C') {
      const previousPath = records[index + 1];
      const path = records[index + 2];
      if (previousPath !== undefined && path !== undefined)
        files.push({ path, previousPath, change: gitChange(code) });
      index += 2;
    } else {
      const path = records[index + 1];
      if (path !== undefined) files.push({ path, change: gitChange(code) });
      index += 1;
    }
  }
  return files;
}

export async function readGitHistoryFileDiff(
  repository: string,
  commit: string,
  requestedPath: string,
  refs?: readonly string[],
  requestedPreviousPath?: string
): Promise<{
  readonly binary: boolean;
  readonly text?: string;
  readonly summary?: string;
  readonly truncated: boolean;
}> {
  await assertHistoryCommitReachable(repository, commit, refs);
  const path = safeGitWorkspacePath(requestedPath);
  const previousPath =
    requestedPreviousPath === undefined ? undefined : safeGitWorkspacePath(requestedPreviousPath);
  const result = await runReadOnlyGit(repository, [
    'show',
    '--format=',
    '--first-parent',
    '--no-ext-diff',
    '--no-textconv',
    commit,
    '--',
    `:(literal)${path}`,
    ...(previousPath === undefined || previousPath === path ? [] : [`:(literal)${previousPath}`])
  ]);
  const binary = result.output.includes(0) || result.text.includes('Binary files ');
  if (binary) {
    return {
      binary: true,
      summary: `binary diff sha256=${createHash('sha256').update(result.output).digest('hex')} bytes=${result.output.length}`,
      truncated: result.truncated
    };
  }
  return { binary: false, text: result.text, truncated: result.truncated };
}

export async function readGitHistoryFileContentRange(
  repository: string,
  commit: string,
  requestedPath: string,
  offset: number,
  limit: number,
  refs?: readonly string[]
): Promise<{
  readonly path: string;
  readonly size: number;
  readonly offset: number;
  readonly contentBase64: string;
  readonly nextOffset: number | null;
}> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 20 * 1024 * 1024 ||
    offset + limit > 20 * 1024 * 1024
  )
    throw new Error('FILE_RANGE_INVALID');
  await assertHistoryCommitReachable(repository, commit, refs);
  const path = safeGitWorkspacePath(requestedPath);
  const object = `${commit}:${path}`;
  const sizeResult = await runReadOnlyGit(repository, ['cat-file', '-s', object]);
  const size = Number(sizeResult.text.trim());
  if (!Number.isSafeInteger(size) || size < 0 || offset > size)
    throw new Error('FILE_RANGE_INVALID');
  if (offset === size) return { path, size, offset, contentBase64: '', nextOffset: null };
  const result = await runReadOnlyGitAllowFailure(repository, ['cat-file', 'blob', object], {
    outputLimit: offset + limit,
    timeoutMs: GIT_HISTORY_TIMEOUT_MS
  });
  if (result.code !== 0) throw gitCommandFailure(result.code, result.stderr, 'cat-file');
  const content = result.output.subarray(offset, Math.min(size, offset + limit));
  const nextOffset = offset + content.length;
  return {
    path,
    size,
    offset,
    contentBase64: content.toString('base64'),
    nextOffset: nextOffset < size ? nextOffset : null
  };
}

export async function openGitHistoryFileContent(
  repository: string,
  commit: string,
  requestedPath: string,
  refs?: readonly string[]
): Promise<{
  readonly path: string;
  readonly size: number;
  readonly chunks: AsyncIterable<Uint8Array>;
}> {
  await assertHistoryCommitReachable(repository, commit, refs);
  const path = safeGitWorkspacePath(requestedPath);
  const object = `${commit}:${path}`;
  const sizeResult = await runReadOnlyGit(repository, ['cat-file', '-s', object]);
  const size = Number(sizeResult.text.trim());
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('FILE_RANGE_INVALID');
  return {
    path,
    size,
    chunks: (async function* () {
      const child = spawn('git', ['cat-file', 'blob', object], {
        cwd: repository,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...gitOperationEnvironment.getStore(),
          GIT_OPTIONAL_LOCKS: '0'
        }
      });
      const errors: Buffer[] = [];
      let errorSize = 0;
      let closed = false;
      const exit = new Promise<{ readonly code: number; readonly stderr: string }>(
        (resolveExit) => {
          child.stderr.on('data', (chunk: Buffer) => {
            const remaining = Math.max(0, 4096 - errorSize);
            if (remaining === 0) return;
            const retained = chunk.subarray(0, remaining);
            errors.push(retained);
            errorSize += retained.length;
          });
          child.once('error', (error) => {
            closed = true;
            resolveExit({ code: 1, stderr: error.message });
          });
          child.once('close', (code) => {
            closed = true;
            resolveExit({
              code: code ?? 1,
              stderr: Buffer.concat(errors).toString('utf8')
            });
          });
        }
      );
      try {
        for await (const chunk of child.stdout) yield new Uint8Array(chunk);
        const result = await exit;
        if (result.code !== 0) throw gitCommandFailure(result.code, result.stderr, 'cat-file');
      } finally {
        if (!closed) child.kill('SIGKILL');
      }
    })()
  };
}

export async function readCurrentChanges(workspacePath: string): Promise<
  readonly {
    readonly path: string;
    readonly state: 'STAGED' | 'UNSTAGED' | 'UNTRACKED';
    readonly change: 'ADDED' | 'MODIFIED' | 'DELETED' | 'RENAMED' | 'COPIED' | 'TYPE_CHANGED';
  }[]
> {
  return (await readCurrentChangesSummary(workspacePath)).changes;
}

export async function readCurrentChangeDiff(
  workspacePath: string,
  requestedPath: string
): Promise<{
  readonly binary: boolean;
  readonly text?: string;
  readonly summary?: string;
  readonly truncated: boolean;
  readonly afterText?: string;
  readonly afterTruncated?: boolean;
}> {
  const path = safeGitWorkspacePath(requestedPath);
  await assertCurrentChangePathAccessible(workspacePath, path);
  const result = await readCurrentChangeGitDiff(workspacePath, path);
  const after = await readWorkingTreeText(workspacePath, path);
  const binary =
    result.output.includes(0) || result.text.includes('Binary files ') || after?.binary === true;
  if (binary) {
    return {
      binary: true,
      summary: `binary diff sha256=${createHash('sha256').update(result.output).digest('hex')} bytes=${result.output.length}`,
      truncated: result.truncated || after?.truncated === true
    };
  }
  return {
    binary: false,
    text: result.text,
    truncated: result.truncated || after?.truncated === true,
    afterText: after?.text ?? '',
    ...(after === undefined ? {} : { afterTruncated: after.truncated })
  };
}

async function readCurrentChangeGitDiff(workspacePath: string, path: string): Promise<GitResult> {
  const untracked = await runReadOnlyGit(workspacePath, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    `:(literal)${path}`
  ]);
  if (untracked.text.split('\0').includes(path)) {
    const result = await runReadOnlyGitAllowFailure(workspacePath, [
      'diff',
      '--no-index',
      '--no-ext-diff',
      '--no-textconv',
      '--',
      '/dev/null',
      path
    ]);
    if (result.code !== 0 && result.code !== 1)
      throw gitCommandFailure(result.code, result.stderr, 'diff');
    return result;
  }
  return runReadOnlyGit(workspacePath, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    'HEAD',
    '--',
    `:(literal)${path}`
  ]);
}

/** Current Changes must not expose an external link. */
export async function isWorkspaceChangeVisible(
  workspacePath: string,
  requestedPath: string
): Promise<boolean> {
  try {
    await assertCurrentChangePathAccessible(workspacePath, safeGitWorkspacePath(requestedPath));
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'FILE_PATH_ESCAPE' ||
        error.message === 'FILE_NOT_FOUND' ||
        error.message === 'FILE_NOT_REGULAR')
    )
      return false;
    throw error;
  }
}

async function assertCurrentChangePathAccessible(
  workspacePath: string,
  path: string
): Promise<void> {
  const root = await realpath(workspacePath);
  const candidate = resolve(root, path);
  const metadata = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (metadata === undefined) return;
  await resolveWorkspaceEntry(root, path, false);
}

interface DiffText {
  readonly binary: boolean;
  readonly text?: string;
  readonly truncated: boolean;
}

async function readWorkingTreeText(
  workspacePath: string,
  path: string
): Promise<DiffText | undefined> {
  const root = await realpath(workspacePath);
  let file: string;
  try {
    file = await resolveWorkspaceEntry(root, path, false);
  } catch (error) {
    if (error instanceof Error && error.message === 'FILE_NOT_FOUND') return undefined;
    throw error;
  }
  const metadata = await lstat(file);
  if (!metadata.isFile()) return undefined;
  const source = await readFile(file);
  return diffTextFromBuffer(source, source.length > GIT_OUTPUT_LIMIT);
}

function diffTextFromBuffer(source: Buffer, truncated: boolean): DiffText {
  if (source.includes(0) || !isValidUtf8(source)) return { binary: true, truncated };
  let end = Math.min(source.length, GIT_OUTPUT_LIMIT);
  while (end > 0 && end < source.length && isUtf8ContinuationByte(source[end] as number)) end -= 1;
  return { binary: false, text: source.subarray(0, end).toString('utf8'), truncated };
}

export async function restoreCurrentChange(
  workspacePath: string,
  requestedPath: string,
  state: 'STAGED' | 'UNSTAGED' | 'UNTRACKED'
): Promise<void> {
  const path = safeGitWorkspacePath(requestedPath);
  const pathspec = `:(literal)${path}`;
  if (state === 'UNTRACKED') {
    const status = await runReadOnlyGit(workspacePath, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
      pathspec
    ]);
    if (
      !status.text
        .split('\0')
        .some((record) => record.startsWith('?? ') && record.slice(3) === path)
    )
      throw new Error('GIT_CHANGE_RESTORE_UNAVAILABLE');
    const root = await realpath(workspacePath);
    const file = resolve(root, path);
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error('GIT_CHANGE_RESTORE_UNAVAILABLE');
    await unlink(file);
    return;
  }
  if (state === 'UNSTAGED') {
    await runGit(workspacePath, ['restore', '--worktree', '--', pathspec]);
    return;
  }
  await runGit(workspacePath, [
    'restore',
    '--source=HEAD',
    '--staged',
    '--worktree',
    '--',
    pathspec
  ]);
}

function safeGitWorkspacePath(requestedPath: string): string {
  if (
    requestedPath.length === 0 ||
    requestedPath.includes('\0') ||
    requestedPath.startsWith('/') ||
    requestedPath.startsWith('\\')
  )
    throw new Error('FILE_PATH_ESCAPE');
  const normalized = requestedPath.replaceAll('\\', '/');
  if (
    normalized
      .split('/')
      .some((segment) => segment === '' || segment === '..' || segment === '.git')
  )
    throw new Error('FILE_PATH_ESCAPE');
  return normalized;
}

function gitChange(
  status: string
): 'ADDED' | 'MODIFIED' | 'DELETED' | 'RENAMED' | 'COPIED' | 'TYPE_CHANGED' {
  if (status === 'A') return 'ADDED';
  if (status === 'D') return 'DELETED';
  if (status === 'R') return 'RENAMED';
  if (status === 'C') return 'COPIED';
  if (status === 'T') return 'TYPE_CHANGED';
  return 'MODIFIED';
}

interface GitResult {
  readonly code: number;
  readonly output: Buffer;
  readonly text: string;
  readonly truncated: boolean;
}

interface GitCommandOptions {
  readonly outputLimit?: number;
  readonly timeoutMs?: number;
  readonly readOnly?: boolean;
}

export class GitCommandError extends Error {
  readonly publicDetails: string;
  readonly publicParameters: { readonly gitExitCode: number };

  constructor(
    readonly code: number,
    readonly stderr: string
  ) {
    super('GIT_COMMAND_FAILED');
    this.publicParameters = { gitExitCode: code };
    this.publicDetails = stderr.trim().slice(0, 1_000) || `Git exited with status ${code}.`;
  }
}

function gitCommandFailure(
  code: number,
  stderr: string,
  subcommand: string,
  durationMs?: number,
  reason?: string
): GitCommandError {
  logNodeCommandFailure(`git ${subcommand}`, {
    exitCode: code,
    stderr,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(reason === undefined ? {} : { reason })
  });
  return new GitCommandError(code, stderr);
}

async function runReadOnlyGit(
  workspacePath: string,
  args: readonly string[],
  options: Omit<GitCommandOptions, 'readOnly'> = {}
): Promise<GitResult> {
  return runGit(workspacePath, args, { ...options, readOnly: true });
}

async function runReadOnlyGitAllowFailure(
  workspacePath: string,
  args: readonly string[],
  options: Omit<GitCommandOptions, 'readOnly'> = {}
): Promise<GitResult & { readonly stderr: string }> {
  return runGitAllowFailure(workspacePath, args, { ...options, readOnly: true });
}

async function runGit(
  workspacePath: string,
  args: readonly string[],
  options: GitCommandOptions = {}
): Promise<GitResult> {
  const startedAt = performance.now();
  const result = await runGitAllowFailure(workspacePath, args, options);
  if (result.code !== 0) {
    throw gitCommandFailure(
      result.code,
      result.stderr,
      args[0] ?? 'unknown',
      Math.round(performance.now() - startedAt)
    );
  }
  return result;
}

async function runGitAllowFailure(
  workspacePath: string,
  args: readonly string[],
  options: GitCommandOptions = {}
): Promise<GitResult & { readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const outputLimit = options.outputLimit ?? GIT_OUTPUT_LIMIT;
    const child = spawn('git', [...args], {
      cwd: workspacePath,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...gitOperationEnvironment.getStore(),
        ...(options.readOnly === true ? { GIT_OPTIONAL_LOCKS: '0' } : {})
      }
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let errorSize = 0;
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        const pid = child.pid;
        if (pid === undefined) {
          child.kill('SIGKILL');
          return;
        }
        void terminateProcessTree(
          {
            pid,
            kill: (signal) => child.kill(signal)
          },
          'win32'
        ).catch(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // The process may have exited while taskkill was starting.
          }
        });
        return;
      }
      child.kill('SIGKILL');
    }, options.timeoutMs ?? GIT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = Math.max(0, outputLimit - size);
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        chunks.push(retained);
        size += retained.length;
      }
      truncated ||= chunk.length > remaining;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = Math.max(0, 4096 - errorSize);
      if (remaining === 0) return;
      const retained = chunk.subarray(0, remaining);
      errors.push(retained);
      errorSize += retained.length;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      logNodeCommandFailure(`git ${args[0] ?? 'unknown'}`, {
        reason: (error as NodeJS.ErrnoException).code ?? 'START_FAILED'
      });
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(errors).toString('utf8');
      if (timedOut) {
        reject(
          gitCommandFailure(
            code === null || code === 0 ? 1 : code,
            `Git command timed out after ${options.timeoutMs ?? GIT_TIMEOUT_MS} ms.${stderr ? `\n${stderr}` : ''}`,
            args[0] ?? 'unknown',
            Math.round(performance.now() - startedAt),
            'TIMEOUT'
          )
        );
        return;
      }
      const output = Buffer.concat(chunks);
      resolve({
        code: code ?? 1,
        output,
        text: output.toString('utf8'),
        stderr,
        truncated
      });
    });
  });
}

function canRetryGitWorktreeListWithoutNullOutput(
  result: Pick<GitResult & { readonly stderr: string }, 'code' | 'stderr'>
): boolean {
  return (
    result.code === 129 ||
    /(?:unknown|unrecognized|invalid)\s+(?:option|switch).*['"`]?-?z\b/iu.test(result.stderr)
  );
}

function isGitUnavailable(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function summarizeText(value: string): string {
  return JSON.stringify({
    sha256: createHash('sha256').update(value).digest('hex'),
    bytes: Buffer.byteLength(value)
  });
}
