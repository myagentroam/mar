import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { spawn } from 'node:child_process';
import type { GitSummary, WorkspaceGitTracking, WorkspaceKind } from '@myagentroam/protocol';
import { logNodeCommandFailure } from '../operational.js';
import { terminateProcessTree } from '../process-tree.js';
import { gitOperationEnvironment } from '../service/git-operation-service.js';
import {
  isWithinAllowedRoot,
  normalizeWorkspacePath,
  resolveRegisteredWorkspaceRoot,
  resolveWorkspaceEntry
} from './path-access.js';
import { isUtf8ContinuationByte, isValidUtf8 } from './utf8.js';

const GIT_TIMEOUT_MS = 5_000;
const GIT_STATUS_TIMEOUT_MS = 30_000;
const GIT_HISTORY_TIMEOUT_MS = 15_000;
const GIT_OUTPUT_LIMIT = 512 * 1024;
const GIT_LARGE_OUTPUT_LIMIT = 8 * 1024 * 1024;
const GIT_WORKTREE_LIST_LIMIT = 128;
const REF_PATTERN = /^(?!-)(?!.*\.\.)(?!.*@\{)[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

export interface WorkspaceInspection {
  readonly path: string;
  readonly kind: WorkspaceKind;
  readonly gitSummary?: GitSummary;
}

export async function inspectWorkspace(
  requestedPath: string,
  allowedRoots: readonly string[],
  includeParentRepository = true
): Promise<WorkspaceInspection> {
  const resolvedPath = await realpath(requestedPath);
  const resolvedRoots = await Promise.all(allowedRoots.map((root) => realpath(root)));
  const directory = await stat(resolvedPath);
  if (!directory.isDirectory() || !isWithinAllowedRoot(resolvedPath, resolvedRoots)) {
    throw new Error('WORKSPACE_NOT_ALLOWED');
  }
  try {
    const repositoryRoot = await resolveWorkspaceGitRoot(resolvedPath, includeParentRepository);
    const summary = { ...(await readGitSummary(repositoryRoot)), repositoryRoot };
    return { path: resolvedPath, kind: 'GIT_WORKSPACE', gitSummary: summary };
  } catch (error) {
    if (
      (error instanceof GitCommandError && error.code === 128) ||
      isGitUnavailable(error) ||
      (error instanceof Error && error.message === 'WORKSPACE_NOT_GIT')
    ) {
      return { path: resolvedPath, kind: 'DIRECTORY' };
    }
    throw error;
  }
}

/** Resolves the working tree without changing the registered Workspace identity. */
export async function resolveWorkspaceGitRoot(
  workspacePath: string,
  includeParentRepository = true
): Promise<string> {
  const workspace = await resolveRegisteredWorkspaceRoot(workspacePath);
  if (!includeParentRepository) {
    const marker = await lstat(resolve(workspace, '.git')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (
      marker === undefined ||
      marker.isSymbolicLink() ||
      (!marker.isFile() && !marker.isDirectory())
    )
      throw new Error('WORKSPACE_NOT_GIT');
  }
  const result = await runReadOnlyGit(workspace, ['rev-parse', '--show-toplevel']);
  const root = await realpath(result.text.replace(/\n$/u, ''));
  if (
    !includeParentRepository &&
    normalizeWorkspacePath(root) !== normalizeWorkspacePath(workspace)
  )
    throw new Error('WORKSPACE_NOT_GIT');
  return root;
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
  const binary = isBinaryGitPatch(result.text);
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
  readonly head?: string;
  readonly tracking?: WorkspaceGitTracking;
  readonly changes: readonly CurrentChange[];
  readonly changesTruncated?: boolean;
}

/** Returns a bounded, deterministic refs snapshot, or undefined when it cannot be compared. */
export async function readGitRefsSnapshot(
  workspacePath: string,
  timeoutMs: number
): Promise<Buffer | undefined> {
  if (timeoutMs <= 0) return undefined;
  try {
    const result = await runReadOnlyGit(
      workspacePath,
      ['for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)%00%(symref)'],
      { timeoutMs: Math.min(timeoutMs, GIT_TIMEOUT_MS), outputLimit: GIT_LARGE_OUTPUT_LIMIT }
    );
    return result.truncated ? undefined : result.output;
  } catch {
    return undefined;
  }
}

/** Fetches refs only; failures never expose remote URLs or authentication diagnostics. */
export async function fetchGitRepository(
  workspacePath: string,
  timeoutMs: number
): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  try {
    const result = await runGitAllowFailure(
      workspacePath,
      ['fetch', '--all', '--quiet', '--no-recurse-submodules', '--no-write-fetch-head'],
      {
        timeoutMs,
        processGroup: true,
        includeStderrInTimeout: false,
        environment: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
      }
    );
    return result.code === 0;
  } catch {
    return false;
  }
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
  readonly head?: string;
  readonly tracking?: WorkspaceGitTracking;
  readonly changes: readonly CurrentChange[];
  readonly changesTruncated?: boolean;
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
  if (result.truncated) records.pop();
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
  const branch = header.startsWith('## ') ? currentBranchFromStatusHeader(header) : null;
  const head =
    branch === null
      ? (await runReadOnlyGit(workspacePath, ['rev-parse', '--verify', 'HEAD'])).text.trim()
      : undefined;
  return {
    branch,
    ...(head === undefined ? {} : { head }),
    ...(tracking === undefined ? {} : { tracking }),
    ...(result.truncated ? { changesTruncated: true } : {}),
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
  const binary = isBinaryGitPatch(result.text);
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
  const binary = isBinaryGitPatch(result.text);
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
    // A non-UTF-8 worktree must not override Git's text patch or supply lossy context.
    ...(after?.binary === true ? {} : { afterText: after?.text ?? '' }),
    ...(after === undefined || after.binary ? {} : { afterTruncated: after.truncated })
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

function isBinaryGitPatch(text: string): boolean {
  // Git lines use LF; Unicode line separators inside hunk content are not marker boundaries.
  return /(?:^|\n)Binary files [^\n]+ differ(?:\r?\n|$)/u.test(text);
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
  readonly processGroup?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly includeStderrInTimeout?: boolean;
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
      detached: options.processGroup === true && process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...gitOperationEnvironment.getStore(),
        ...options.environment,
        ...(options.readOnly === true ? { GIT_OPTIONAL_LOCKS: '0' } : {})
      }
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let errorSize = 0;
    let truncated = false;
    let timedOut = false;
    let forcedTerminationTimer: NodeJS.Timeout | undefined;
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
      if (options.processGroup === true && child.pid !== undefined) {
        const pid = child.pid;
        try {
          // Give Git a chance to release transaction locks before bounded escalation.
          process.kill(-pid, 'SIGTERM');
          forcedTerminationTimer = setTimeout(() => {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              // The process group may have completed its cleanup already.
            }
          }, 250);
          forcedTerminationTimer.unref();
          return;
        } catch {
          // The group may have exited before the timeout fired.
        }
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
      clearTimeout(forcedTerminationTimer);
      logNodeCommandFailure(`git ${args[0] ?? 'unknown'}`, {
        reason: (error as NodeJS.ErrnoException).code ?? 'START_FAILED'
      });
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      clearTimeout(forcedTerminationTimer);
      const stderr = Buffer.concat(errors).toString('utf8');
      if (timedOut) {
        const details = options.includeStderrInTimeout === false ? '' : stderr;
        reject(
          gitCommandFailure(
            code === null || code === 0 ? 1 : code,
            `Git command timed out after ${options.timeoutMs ?? GIT_TIMEOUT_MS} ms.${details ? `\n${details}` : ''}`,
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
