import type { NodeWorkspace } from '../database.js';
import { lstat } from 'node:fs/promises';
import { basename, posix, resolve } from 'node:path';
import { publicErrorMessage, type PublicError } from '@myagentroam/protocol';
import { nodeLog } from '../operational.js';
import {
  GitCommandError,
  isWorkspaceChangeVisible,
  listGitWorktrees,
  listGitSubmodules,
  readCurrentChangesSummary,
  resolveGitRepository,
  resolveWorkspaceGitRoot,
  type CurrentChangesRepository,
  type GitWorktreeList
} from '../workspace.js';
import { WorkspaceDomainState } from './workspace-domain-state.js';

const CACHE_TTL_MS = 5_000;
const REPOSITORY_READ_CONCURRENCY = 4;
const WORKTREE_READ_CONCURRENCY = 4;
const CHANGE_VISIBILITY_CONCURRENCY = 16;
const SUBMODULE_LIMIT = 128;

type RepositoryResult = CurrentChangesRepository & {
  readonly dirty: boolean;
  readonly status: 'CLEAN' | 'DIRTY' | 'UNAVAILABLE';
  readonly error?: PublicError;
};

export class WorkspaceChangeService {
  constructor(private readonly state: WorkspaceDomainState) {}

  revision(workspaceId: string): number {
    return this.state.changesVersions.get(workspaceId) ?? 0;
  }

  invalidate(workspaceId: string): void {
    this.state.changesReads.delete(workspaceId);
    this.state.changesCache.delete(workspaceId);
    this.state.changesVersions.set(
      workspaceId,
      (this.state.changesVersions.get(workspaceId) ?? 0) + 1
    );
  }

  clear(): void {
    this.state.changesReads.clear();
    this.state.changesCache.clear();
    this.state.changesVersions.clear();
  }

  async current(workspace: NodeWorkspace): Promise<unknown> {
    if (workspace.kind !== 'GIT_WORKSPACE') throw new Error('WORKSPACE_NOT_GIT');
    const cached = this.state.changesCache.get(workspace.id);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
    const existing = this.state.changesReads.get(workspace.id);
    if (existing !== undefined) return existing;
    // Invalidation may arrive during this shared read; its old result must not repopulate the cache.
    const version = this.state.changesVersions.get(workspace.id) ?? 0;
    const request = this.state.changesLimiter
      .run(async () => {
        const repositoryRoot = await resolveWorkspaceGitRoot(
          workspace.path,
          workspace.includeParentRepository ?? true
        );
        const startedAt = performance.now();
        const errors: PublicError[] = [];
        const failure = (code: string, error?: unknown): PublicError => ({
          code,
          message: publicErrorMessage(code),
          ...(error instanceof GitCommandError
            ? {
                parameters: { gitExitCode: error.code },
                details: error.publicDetails
              }
            : {})
        });
        const report = (source: string, path: string, error: PublicError) => {
          nodeLog('workspace.git-group.unavailable', {
            workspaceId: workspace.id,
            groupKind: source,
            groupPath: path,
            errorCode: error.code,
            ...error.parameters,
            ...(error.details === undefined ? {} : { errorDetails: error.details }),
            durationMs: Math.round(performance.now() - startedAt)
          });
        };
        const discoveryFailure = (source: string, path: string, code: string, error: unknown) => {
          const value = failure(code, error);
          if (errors.length < 16) errors.push(value);
          report(source, path, value);
        };
        const readRepository = async (
          repositoryPath: string,
          repositoryOverride?: string
        ): Promise<RepositoryResult> => {
          const repository =
            repositoryOverride ??
            (await resolveGitRepository(repositoryRoot, repositoryPath, [repositoryPath]));
          if (repositoryPath !== '' || repositoryOverride !== undefined) {
            const marker = await lstat(resolve(repository, '.git'));
            if (marker.isSymbolicLink() || (!marker.isFile() && !marker.isDirectory()))
              throw new Error('GIT_REPOSITORY_UNREADABLE');
          }
          const summary = await readCurrentChangesSummary(repository, true);
          const changes = (
            await mapWithConcurrency(
              summary.changes,
              CHANGE_VISIBILITY_CONCURRENCY,
              async (change) => ({
                change,
                visible: await isWorkspaceChangeVisible(repository, change.path)
              })
            )
          )
            .filter(({ visible }) => visible)
            .map(({ change }) => change);
          return {
            repositoryPath,
            repositoryName:
              repositoryPath === '' ? basename(repository) : posix.basename(repositoryPath),
            branch: summary.branch,
            ...(summary.tracking === undefined ? {} : { tracking: summary.tracking }),
            dirty: summary.changes.length > 0,
            status: summary.changes.length > 0 ? 'DIRTY' : 'CLEAN',
            changes
          };
        };
        const root = await readRepository('');
        const children: RepositoryResult[] = [];
        let parents = [''];
        let submodulesLimited = false;
        while (parents.length > 0 && !submodulesLimited) {
          const discovered = await mapWithConcurrency(
            parents,
            REPOSITORY_READ_CONCURRENCY,
            async (parent) => {
              try {
                const path = await resolveGitRepository(repositoryRoot, parent, [parent]);
                return (await listGitSubmodules(path)).map((entry) => ({
                  ...entry,
                  path: parent === '' ? entry.path : `${parent}/${entry.path}`
                }));
              } catch (error) {
                discoveryFailure('SUBMODULE', parent, 'GIT_SUBMODULE_DISCOVERY_FAILED', error);
                return [];
              }
            }
          );
          const candidates = discovered.flat();
          if (children.length + candidates.length > SUBMODULE_LIMIT) {
            candidates.splice(SUBMODULE_LIMIT - children.length);
            submodulesLimited = true;
            discoveryFailure('SUBMODULE', '', 'GIT_SUBMODULE_LIMIT_EXCEEDED', undefined);
          }
          const batch = await mapWithConcurrency(
            candidates,
            REPOSITORY_READ_CONCURRENCY,
            async (entry): Promise<RepositoryResult> => {
              let error: PublicError | undefined;
              if (entry.mapping !== 'MAPPED') {
                error = failure(
                  entry.mapping === 'MISSING'
                    ? 'GIT_SUBMODULE_MAPPING_MISSING'
                    : 'GIT_SUBMODULE_MAPPING_INVALID',
                  entry.gitExitCode === undefined
                    ? undefined
                    : new GitCommandError(entry.gitExitCode, '')
                );
              } else {
                try {
                  return await readRepository(entry.path);
                } catch (cause) {
                  error = failure('GIT_REPOSITORY_UNREADABLE', cause);
                }
              }
              report('SUBMODULE', entry.path, error);
              return {
                repositoryPath: entry.path,
                repositoryName: posix.basename(entry.path),
                branch: null,
                dirty: false,
                status: 'UNAVAILABLE',
                changes: [],
                error
              };
            }
          );
          children.push(...batch);
          parents = batch
            .filter((entry) => entry.status !== 'UNAVAILABLE')
            .map((entry) => entry.repositoryPath);
        }
        children.sort((left, right) => left.repositoryPath.localeCompare(right.repositoryPath));
        const worktreeList: GitWorktreeList = await listGitWorktrees(repositoryRoot).catch(
          (error: unknown) => {
            discoveryFailure('WORKTREE', '', 'GIT_WORKTREE_DISCOVERY_FAILED', error);
            return { entries: [], truncated: false };
          }
        );
        const linkedWorktrees = worktreeList.entries.filter((worktree) => !worktree.current);
        const linkedRepositories = await mapWithConcurrency(
          linkedWorktrees,
          WORKTREE_READ_CONCURRENCY,
          async (worktree) => {
            const metadata = {
              repositoryPath: '',
              repositoryName: worktree.directoryName,
              source: 'WORKTREE' as const,
              worktreePath: worktree.path,
              physicalPath: worktree.path,
              current: false,
              branch: worktree.branch,
              head: worktree.head,
              locked: worktree.locked,
              prunable: worktree.prunable
            };
            if (worktree.prunable) {
              const error = failure('GIT_REPOSITORY_UNREADABLE');
              report('WORKTREE', worktree.directoryName, error);
              return {
                ...metadata,
                dirty: false,
                status: 'UNAVAILABLE' as const,
                error,
                changes: []
              };
            }
            try {
              const repository = await readRepository('', worktree.path);
              return {
                ...metadata,
                dirty: repository.dirty,
                branch: repository.branch,
                ...(repository.tracking === undefined ? {} : { tracking: repository.tracking }),
                status: repository.dirty ? ('DIRTY' as const) : ('CLEAN' as const),
                changes: repository.changes
              };
            } catch (cause) {
              const error = failure('GIT_REPOSITORY_UNREADABLE', cause);
              report('WORKTREE', worktree.directoryName, error);
              return {
                ...metadata,
                dirty: false,
                status: 'UNAVAILABLE' as const,
                error,
                changes: []
              };
            }
          }
        );
        const currentWorktree = worktreeList.entries.find((worktree) => worktree.current);
        const worktrees = worktreeList.entries.map((worktree) => {
          const linked = linkedRepositories.find(
            (repository) => repository.worktreePath === worktree.path
          );
          return {
            directoryName: worktree.directoryName,
            branch: worktree.branch,
            head: worktree.head,
            current: worktree.current,
            status: worktree.current
              ? root.dirty
                ? ('DIRTY' as const)
                : ('CLEAN' as const)
              : (linked?.status ?? ('UNAVAILABLE' as const)),
            locked: worktree.locked,
            prunable: worktree.prunable
          };
        });
        const decorate = (change: (typeof root.changes)[number]) => ({
          ...change,
          additions: null,
          deletions: null,
          binary: false,
          diffAvailable: true
        });
        const value = {
          repositoryRoot,
          workspace: {
            id: workspace.id,
            path: workspace.path,
            kind: 'GIT_WORKSPACE',
            gitSummary: { branch: root.branch, repositoryRoot }
          },
          partial:
            errors.length > 0 ||
            children.some((group) => group.status === 'UNAVAILABLE') ||
            linkedRepositories.some((group) => group.status === 'UNAVAILABLE') ||
            worktreeList.truncated,
          ...(errors.length === 0 ? {} : { errors }),
          branch: root.branch,
          changes: root.changes.map(decorate),
          repositories: [
            {
              ...root,
              source: 'ROOT' as const,
              physicalPath: currentWorktree?.path ?? repositoryRoot,
              current: true,
              ...(currentWorktree === undefined ? {} : { head: currentWorktree.head }),
              status: root.dirty ? ('DIRTY' as const) : ('CLEAN' as const),
              locked: currentWorktree?.locked ?? false,
              prunable: currentWorktree?.prunable ?? false
            },
            ...children.map((repository) => ({ ...repository, source: 'SUBMODULE' as const })),
            ...linkedRepositories
          ].map(({ dirty: _dirty, ...repository }) => {
            void _dirty;
            return { ...repository, changes: repository.changes.map(decorate) };
          }),
          worktrees,
          worktreesTruncated: worktreeList.truncated
        };
        if (value.partial)
          nodeLog('workspace.changes.completed', {
            operation: 'workspace.changes.current',
            workspaceId: workspace.id,
            partial: true,
            unavailableGroups: value.repositories.filter((group) => group.status === 'UNAVAILABLE')
              .length,
            discoveryErrors: errors.length,
            durationMs: Math.round(performance.now() - startedAt)
          });
        if ((this.state.changesVersions.get(workspace.id) ?? 0) === version)
          this.state.changesCache.set(workspace.id, {
            value,
            expiresAt: Date.now() + CACHE_TTL_MS
          });
        return value;
      })
      .catch((error: unknown) => {
        if (
          (error as NodeJS.ErrnoException)?.code === 'ENOENT' &&
          (error as NodeJS.ErrnoException).syscall?.startsWith('spawn') === true
        )
          throw new Error('GIT_NOT_FOUND');
        throw error;
      });
    this.state.changesReads.set(workspace.id, request);
    try {
      return await request;
    } finally {
      if (this.state.changesReads.get(workspace.id) === request)
        this.state.changesReads.delete(workspace.id);
    }
  }
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  project: (value: Input) => Promise<Output>
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        output[index] = await project(values[index] as Input);
      }
    })
  );
  return output;
}
