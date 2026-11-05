import { publicErrorSchema, workspaceGitTrackingSchema } from '@myagentroam/protocol';
import type {
  ChangeEntry,
  ChangeRepository,
  GitWorktreeSummary,
  HistoryCommit,
  HistoryFile
} from '../model/workspace-git.js';
import type { WorkspaceFileOpenIntent, WorkspaceFileTab } from './workspace-file-tab.js';

export function gitFileRepositoryPath(
  repositoryPath: string,
  worktreePath: string | undefined,
  repositoryRoot: unknown,
  workspacePath: string | undefined
): string | undefined {
  if (worktreePath !== undefined) return undefined;
  return typeof repositoryRoot === 'string' &&
    (repositoryPath !== '' || repositoryRoot !== workspacePath)
    ? repositoryPath
    : undefined;
}

export function changeDiffIntent(
  entry: ChangeEntry,
  diffFiles: readonly ChangeEntry[],
  target: { readonly nodeId: string; readonly workspaceId: string },
  repositoryRoot: unknown,
  workspacePath: string | undefined
): WorkspaceFileOpenIntent {
  const paths = diffFiles
    .filter(
      (candidate) =>
        candidate.repositoryPath === entry.repositoryPath &&
        (candidate.worktreePath ?? '') === (entry.worktreePath ?? '')
    )
    .map((candidate) => candidate.path);
  return {
    kind: 'WORKTREE_DIFF',
    ...(gitFileRepositoryPath(
      entry.repositoryPath,
      entry.worktreePath,
      repositoryRoot,
      workspacePath
    ) === undefined
      ? {}
      : { gitFile: true }),
    ...target,
    path: entry.path,
    repositoryPath: entry.repositoryPath,
    worktreePath: entry.worktreePath ?? '',
    paths
  };
}

export function changeFileLocation(
  entry: ChangeEntry,
  repositoryRoot: unknown,
  workspacePath: string | undefined
): { path: string; worktreePath?: string; repositoryPath?: string } {
  const repositoryPath = gitFileRepositoryPath(
    entry.repositoryPath,
    entry.worktreePath,
    repositoryRoot,
    workspacePath
  );
  return {
    path:
      repositoryPath === undefined && entry.worktreePath === undefined
        ? workspaceChangePath(entry)
        : entry.path,
    ...(entry.worktreePath === undefined ? {} : { worktreePath: entry.worktreePath }),
    ...(repositoryPath === undefined ? {} : { repositoryPath })
  };
}

export function historyDiffIntent(
  target: { readonly nodeId: string; readonly workspaceId: string },
  commit: HistoryCommit,
  file: HistoryFile,
  source: { readonly repositoryPath: string; readonly refs: readonly string[] }
): WorkspaceFileOpenIntent {
  return {
    kind: 'HISTORY_DIFF',
    ...target,
    path: file.path,
    repositoryPath: source.repositoryPath,
    worktreePath: '',
    commit: commit.hash,
    ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
    refs: [...source.refs],
    paths: [file.path]
  };
}

export function comparisonChange(
  entries: readonly ChangeEntry[],
  path: string
): ChangeEntry | undefined {
  return entries.find((entry) => entry.diffAvailable && workspaceChangePath(entry) === path);
}

export function adjacentChange(
  entries: readonly ChangeEntry[],
  tab: WorkspaceFileTab,
  direction: -1 | 1
): ChangeEntry | undefined {
  const files = entries.filter(
    (entry) =>
      entry.diffAvailable &&
      entry.repositoryPath === tab.repositoryPath &&
      (entry.worktreePath ?? '') === tab.worktreePath
  );
  if (files.length === 0) return undefined;
  const current = files.findIndex((entry) => entry.path === tab.path);
  return files[(Math.max(current, 0) + direction + files.length) % files.length];
}

export function parseChangeEntries(
  value: unknown,
  repositoryPath: string,
  repositoryName: string,
  source: ChangeRepository['source'],
  worktreePath?: string
): readonly ChangeEntry[] {
  if (typeof value !== 'object' || value === null) return [];
  const raw = (value as { readonly changes?: unknown }).changes;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const entry = item as Record<string, unknown>;
    return typeof entry.path === 'string'
      ? [
          {
            repositoryPath,
            repositoryName,
            source,
            ...(worktreePath === undefined ? {} : { worktreePath }),
            path: entry.path,
            state:
              entry.state === 'STAGED' || entry.state === 'UNSTAGED' || entry.state === 'UNTRACKED'
                ? entry.state
                : 'UNTRACKED',
            change: typeof entry.change === 'string' ? entry.change : 'MODIFIED',
            diffAvailable: entry.diffAvailable === true
          }
        ]
      : [];
  });
}

export function changeRepositories(value: unknown): readonly ChangeRepository[] {
  if (typeof value !== 'object' || value === null) return [];
  const record = value as {
    readonly repositories?: unknown;
  };
  if (!Array.isArray(record.repositories)) return [];
  const repositories = record.repositories.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const repository = item as Record<string, unknown>;
    if (typeof repository.repositoryPath !== 'string') return [];
    if (
      repository.source !== 'ROOT' &&
      repository.source !== 'SUBMODULE' &&
      repository.source !== 'WORKTREE'
    )
      return [];
    const source: ChangeRepository['source'] = repository.source;
    const worktreePath =
      source === 'WORKTREE' && typeof repository.worktreePath === 'string'
        ? repository.worktreePath
        : undefined;
    if (source === 'WORKTREE' && worktreePath === undefined) return [];
    const repositoryName =
      typeof repository.repositoryName === 'string' && repository.repositoryName.length > 0
        ? repository.repositoryName
        : repository.repositoryPath;
    const groupError = publicErrorSchema.safeParse(repository.error);
    const tracking = workspaceGitTrackingSchema.safeParse(repository.tracking);
    const parsed: ChangeRepository = {
      repositoryPath: repository.repositoryPath,
      repositoryName,
      source,
      ...(worktreePath === undefined ? {} : { worktreePath }),
      ...(typeof repository.physicalPath === 'string'
        ? { physicalPath: repository.physicalPath }
        : {}),
      current: repository.current === true || source === 'ROOT',
      branch: typeof repository.branch === 'string' ? repository.branch : null,
      ...(tracking.success && repository.status !== 'UNAVAILABLE'
        ? { tracking: tracking.data }
        : {}),
      ...(typeof repository.head === 'string' ? { head: repository.head } : {}),
      ...(repository.status === 'CLEAN' ||
      repository.status === 'DIRTY' ||
      repository.status === 'UNAVAILABLE'
        ? { status: repository.status }
        : {}),
      locked: repository.locked === true,
      prunable: repository.prunable === true,
      ...(groupError.success ? { error: groupError.data } : {}),
      ...(repository.changesTruncated === true ? { changesTruncated: true } : {}),
      changes:
        repository.status === 'UNAVAILABLE'
          ? []
          : parseChangeEntries(
              repository,
              repository.repositoryPath,
              repositoryName,
              source,
              worktreePath
            )
    };
    return [parsed];
  });
  const root = repositories.find((repository) => repository.source === 'ROOT');
  return root === undefined
    ? repositories
    : [root, ...repositories.filter((repository) => repository !== root)];
}

export function changeEntries(value: unknown): readonly ChangeEntry[] {
  return changeRepositories(value).flatMap((repository) => repository.changes);
}

export function limitChangeRepositories(
  repositories: readonly ChangeRepository[],
  limit: number
): readonly ChangeRepository[] {
  let remaining = limit;
  return repositories.flatMap((repository) => {
    if (repository.changes.length === 0) return [repository];
    if (remaining <= 0) return [];
    const changes = repository.changes.slice(0, remaining);
    remaining -= changes.length;
    return [{ ...repository, changes }];
  });
}

export function hasExplicitChangeRepositoryGroups(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const repositories = (value as { readonly repositories?: unknown }).repositories;
  if (!Array.isArray(repositories)) return false;
  return repositories.some(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      ((item as { readonly source?: unknown }).source === 'ROOT' ||
        (item as { readonly source?: unknown }).source === 'SUBMODULE' ||
        (item as { readonly source?: unknown }).source === 'WORKTREE')
  );
}

export function changeWorktrees(value: unknown): readonly GitWorktreeSummary[] {
  if (typeof value !== 'object' || value === null) return [];
  const worktrees = (value as { readonly worktrees?: unknown }).worktrees;
  if (!Array.isArray(worktrees)) return [];
  return worktrees.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const worktree = item as Record<string, unknown>;
    if (
      typeof worktree.directoryName !== 'string' ||
      worktree.directoryName.length === 0 ||
      (typeof worktree.branch !== 'string' && worktree.branch !== null) ||
      typeof worktree.head !== 'string' ||
      !/^[0-9a-f]{40,64}$/u.test(worktree.head) ||
      typeof worktree.current !== 'boolean' ||
      (worktree.status !== 'CLEAN' &&
        worktree.status !== 'DIRTY' &&
        worktree.status !== 'UNAVAILABLE') ||
      typeof worktree.locked !== 'boolean' ||
      typeof worktree.prunable !== 'boolean'
    )
      return [];
    return [worktree as unknown as GitWorktreeSummary];
  });
}

export function changeWorktreesTruncated(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly worktreesTruncated?: unknown }).worktreesTruncated === true
  );
}

export function workspaceChangePath(
  entry: Pick<ChangeEntry, 'repositoryPath' | 'repositoryName' | 'worktreePath' | 'path'>
): string {
  if (entry.worktreePath !== undefined)
    return `${entry.worktreePath.replace(/[\\/]+$/u, '')}/${entry.path}`;
  return entry.repositoryPath.length === 0 ? entry.path : `${entry.repositoryPath}/${entry.path}`;
}

export function shortChange(change: string): string {
  return (
    {
      ADDED: 'A',
      MODIFIED: 'M',
      DELETED: 'D',
      RENAMED: 'R',
      COPIED: 'C',
      TYPE_CHANGED: 'T'
    }[change] ?? '?'
  );
}

export function changeFileName(changePath: string): string {
  return changePath.split('/').at(-1) ?? changePath;
}

export function changeDirectory(changePath: string): string {
  const separator = changePath.lastIndexOf('/');
  return separator > 0 ? changePath.slice(0, separator) : '';
}
