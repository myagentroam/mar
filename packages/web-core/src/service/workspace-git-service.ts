import { computed, readonly, ref, shallowRef } from 'vue';
import { publicErrorSchema } from '@myagentroam/protocol';
import type { ScopedHttpService } from './scoped-http-service.js';
import {
  filePageWorkspace,
  type WorkspaceFileOperationTarget
} from './workspace-file-operation-service.js';
import type { WorkspaceFileTreeWorkspace } from './workspace-file-tree-service.js';
import type {
  ChangeEntry,
  HistoryCommit,
  HistoryFile,
  HistoryRef
} from '../model/workspace-git.js';
import type { WorkspaceFileTab } from '../util/workspace-file-tab.js';
import {
  changeEntries,
  changeRepositories,
  changeWorktrees,
  changeWorktreesTruncated,
  hasExplicitChangeRepositoryGroups
} from '../util/workspace-git.js';
import { currentChangesBranch } from '../util/file-presentation.js';
import { createTrailingTask } from '../util/trailing-task.js';

export interface WorkspaceGitHistorySelection {
  readonly repositoryPath: string;
  readonly refs: readonly string[];
}
export interface WorkspaceGitSnapshot {
  readonly changes: unknown;
  readonly historyRepositoryPath: string;
  readonly selectedHistoryRefs: readonly string[];
  readonly historyCommits: readonly HistoryCommit[];
  readonly historyNextCursor: string | null;
  readonly historySource?: WorkspaceGitHistorySelection;
}
export type WorkspaceGitOperation = 'CHANGES' | 'HISTORY' | 'FILES' | 'RESTORE';

export function createWorkspaceGitService(input: {
  readonly http: ScopedHttpService;
  readonly target: () => WorkspaceFileOperationTarget | undefined;
  readonly gitEnabled: () => boolean;
  readonly historyEnabled: () => boolean;
  readonly onFailure: (error: unknown, operation: WorkspaceGitOperation) => void;
  readonly onWorkspace: (workspace: WorkspaceFileTreeWorkspace) => void;
  readonly onBranch: (workspaceId: string, branch: string | null) => void;
}) {
  const changes = shallowRef<unknown>();
  const changesRefreshing = ref(false);
  const changesFetchFailed = ref(false);
  const historyFetchFailed = ref(false);
  let changesFetchRequested = false;
  const restoringPath = ref<string>();
  const historyRepositoryPath = ref('');
  const selectedHistoryRefs = ref<readonly string[]>([]);
  const historyRefs = shallowRef<readonly HistoryRef[]>([]);
  const historyCommits = shallowRef<readonly HistoryCommit[]>([]);
  const historyNextCursor = ref<string | null>(null);
  const historyLoading = ref(false);
  const historyFiles = shallowRef<Readonly<Record<string, readonly HistoryFile[]>>>({});
  const historyFilesLoading = ref<readonly string[]>([]);
  const historySource = shallowRef<WorkspaceGitHistorySelection>({ repositoryPath: '', refs: [] });
  let historyRefsRepository: string | undefined;
  let historyFetch:
    { readonly repositoryPath: string; readonly promise: Promise<boolean> } | undefined;
  let epoch = 0;
  let historyGeneration = 0;
  let appliedWatchRevision = -1;
  let changesTarget: WorkspaceFileOperationTarget | undefined;
  const fileRequests = new Map<string, Promise<boolean>>();
  const visibleChanges = computed(() => changeEntries(changes.value));
  const repositories = computed(() => changeRepositories(changes.value));
  const worktrees = computed(() =>
    hasExplicitChangeRepositoryGroups(changes.value) ? [] : changeWorktrees(changes.value)
  );
  const worktreesTruncated = computed(() => changeWorktreesTruncated(changes.value));
  const discoveryErrors = computed(() => {
    const errors = (changes.value as { readonly errors?: unknown } | undefined)?.errors;
    return Array.isArray(errors)
      ? errors.flatMap((error: unknown) => {
          const parsed = publicErrorSchema.safeParse(error);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
  });
  function current(target: WorkspaceFileOperationTarget, generation: number): boolean {
    const active = input.target();
    return (
      generation === epoch &&
      active?.nodeId === target.nodeId &&
      active.workspaceId === target.workspaceId
    );
  }
  function url(
    target: WorkspaceFileOperationTarget,
    path: string,
    values: Record<string, string> = {},
    selection?: WorkspaceGitHistorySelection
  ): string {
    const parameters = new URLSearchParams({ nodeId: target.nodeId, ...values });
    if (selection?.repositoryPath) parameters.set('repositoryPath', selection.repositoryPath);
    for (const name of selection?.refs ?? []) parameters.append('refs', name);
    return `/api/workspaces/${encodeURIComponent(target.workspaceId)}${path}?${parameters}`;
  }
  function acceptChanges(value: unknown, target: WorkspaceFileOperationTarget): void {
    const workspace = filePageWorkspace(
      (value as { readonly workspace?: unknown } | null)?.workspace
    );
    if (workspace !== undefined) input.onWorkspace(workspace);
    if (workspace?.kind === 'DIRECTORY') {
      reset(true);
      return;
    }
    changes.value = value;
    const branch = currentChangesBranch(value);
    if (branch !== undefined) input.onBranch(target.workspaceId, branch);
  }
  function createChangesTask(generation: number) {
    return createTrailingTask(async () => {
      const target = input.target();
      if (target === undefined || generation !== epoch || !input.gitEnabled()) return;
      const fetch = changesFetchRequested;
      changesFetchRequested = false;
      changesRefreshing.value = true;
      let watchRevision = appliedWatchRevision;
      try {
        if (fetch) {
          const failed = await fetchRemotes(target);
          if (!current(target, generation)) return;
          changesFetchFailed.value = failed;
        }
        watchRevision = appliedWatchRevision;
        const value = await input.http.request(url(target, '/changes'));
        if (current(target, generation) && watchRevision === appliedWatchRevision)
          acceptChanges(value, target);
      } catch (error) {
        if (current(target, generation) && watchRevision === appliedWatchRevision)
          input.onFailure(error, 'CHANGES');
      } finally {
        if (current(target, generation)) changesRefreshing.value = false;
      }
    });
  }
  let changesTask = createChangesTask(epoch);
  function matchesChangesTarget(target = input.target()): boolean {
    return (
      target?.nodeId === changesTarget?.nodeId && target?.workspaceId === changesTarget?.workspaceId
    );
  }
  async function fetchRemotes(
    target: WorkspaceFileOperationTarget,
    repositoryPath?: string
  ): Promise<boolean> {
    try {
      const result = await input.http.request<{ readonly fetchFailed: boolean }>(
        url(target, '/git/fetch'),
        {
          method: 'POST',
          body: JSON.stringify({
            nodeId: target.nodeId,
            ...(repositoryPath === undefined ? {} : { repositoryPath })
          })
        }
      );
      return result.fetchFailed !== false;
    } catch {
      return true;
    }
  }
  function loadChanges(fetch = false): Promise<void> {
    if (!matchesChangesTarget()) reset();
    changesFetchRequested ||= fetch;
    return changesTask.request();
  }
  function applyWatch(value: unknown, revision?: number): boolean {
    const target = input.target();
    if (!matchesChangesTarget(target)) reset();
    if (
      target === undefined ||
      (revision === undefined
        ? appliedWatchRevision >= 0
        : !Number.isInteger(revision) || revision <= appliedWatchRevision)
    )
      return false;
    appliedWatchRevision = revision ?? 0;
    acceptChanges(value, target);
    return true;
  }
  function clearHistoryFiles(): void {
    historyFiles.value = {};
    historyFilesLoading.value = [];
    fileRequests.clear();
  }
  async function loadHistory(resetPage = false, fetch = false): Promise<void> {
    const target = input.target();
    if (target === undefined || !input.historyEnabled() || (!resetPage && historyLoading.value))
      return;
    const generation = epoch;
    const request = resetPage ? ++historyGeneration : historyGeneration;
    if (resetPage) {
      historyFilesLoading.value = [];
      fileRequests.clear();
    }
    const selection = resetPage
      ? { repositoryPath: historyRepositoryPath.value, refs: [...selectedHistoryRefs.value] }
      : { ...historySource.value, refs: [...historySource.value.refs] };
    const valid = () =>
      current(target, generation) && request === historyGeneration && input.historyEnabled();
    const cursor = resetPage ? null : historyNextCursor.value;
    historyLoading.value = true;
    try {
      if (fetch && historyFetch?.repositoryPath !== selection.repositoryPath)
        historyFetch = {
          repositoryPath: selection.repositoryPath,
          promise: fetchRemotes(target, selection.repositoryPath)
        };
      const fetching =
        historyFetch?.repositoryPath === selection.repositoryPath ? historyFetch : undefined;
      if (fetching !== undefined) {
        const failed = await fetching.promise;
        if (historyFetch === fetching) historyFetch = undefined;
        if (!valid()) return;
        historyFetchFailed.value = failed;
        historyRefsRepository = undefined;
      }
      let refs: readonly HistoryRef[] | undefined;
      if (resetPage && historyRefsRepository !== selection.repositoryPath) {
        const result = await input.http.request<{ readonly refs?: unknown }>(
          url(target, '/git/refs', {}, selection)
        );
        if (!valid()) return;
        if (!Array.isArray(result.refs)) throw new Error('NODE_RESPONSE_INVALID');
        refs = result.refs.filter(isHistoryRef);
        historyRefs.value = refs;
        historyRefsRepository = selection.repositoryPath;
        const availableRefs = new Set(refs.map((entry) => entry.name));
        selection.refs = selection.refs.filter((name) => availableRefs.has(name));
        selectedHistoryRefs.value = [...selection.refs];
      }
      const result = await input.http.request<{
        readonly commits?: unknown;
        readonly nextCursor?: unknown;
      }>(
        url(
          target,
          '/git/history',
          { limit: '50', ...(cursor === null ? {} : { cursor }) },
          selection
        )
      );
      if (!valid()) return;
      if (!Array.isArray(result.commits) || !result.commits.every(isHistoryCommit))
        throw new Error('NODE_RESPONSE_INVALID');
      const existing = resetPage ? [] : historyCommits.value;
      const seen = new Set(existing.map((commit) => commit.hash));
      historyCommits.value = [
        ...existing,
        ...result.commits.filter((commit) => {
          if (seen.has(commit.hash)) return false;
          seen.add(commit.hash);
          return true;
        })
      ];
      historyNextCursor.value = typeof result.nextCursor === 'string' ? result.nextCursor : null;
      if (resetPage) {
        historySource.value = selection;
        clearHistoryFiles();
      }
    } catch (error) {
      if (valid()) input.onFailure(error, 'HISTORY');
    } finally {
      if (valid()) historyLoading.value = false;
    }
  }
  function selectHistory(repositoryPath: string, refs: readonly string[]): Promise<void> {
    const changedRepository = repositoryPath !== historyRepositoryPath.value;
    historyRepositoryPath.value = repositoryPath;
    selectedHistoryRefs.value = [...refs];
    if (changedRepository) historyFetchFailed.value = false;
    return loadHistory(true, changedRepository);
  }
  async function openHistory(): Promise<void> {
    if (!matchesChangesTarget()) reset();
    const target = input.target(),
      generation = epoch;
    if (target === undefined) return;
    if (changes.value === undefined) await loadChanges();
    if (!current(target, generation)) return;
    const available = repositories.value.filter((entry) => entry.source !== 'WORKTREE');
    if (!available.some((entry) => entry.repositoryPath === historyRepositoryPath.value))
      historyRepositoryPath.value = available[0]?.repositoryPath ?? '';
    historyRefsRepository = undefined;
    await loadHistory(true, true);
  }
  function loadHistoryFiles(commit: HistoryCommit): Promise<boolean> {
    const target = input.target(),
      generation = epoch,
      request = historyGeneration;
    if (target === undefined) return Promise.resolve(false);
    if (historyFiles.value[commit.hash] !== undefined) return Promise.resolve(true);
    const active = fileRequests.get(commit.hash);
    if (active !== undefined) return active;
    const source = historySource.value;
    const selection = { ...source, refs: [...source.refs] };
    const valid = () =>
      current(target, generation) &&
      request === historyGeneration &&
      source === historySource.value;
    historyFilesLoading.value = [...historyFilesLoading.value, commit.hash];
    const pending = (async () => {
      try {
        const result = await input.http.request<{ readonly files?: unknown }>(
          url(target, `/git/commits/${encodeURIComponent(commit.hash)}/files`, {}, selection)
        );
        if (!valid()) return false;
        if (!Array.isArray(result.files) || !result.files.every(isHistoryFile))
          throw new Error('NODE_RESPONSE_INVALID');
        historyFiles.value = { ...historyFiles.value, [commit.hash]: result.files };
        return true;
      } catch (error) {
        if (valid()) input.onFailure(error, 'FILES');
        return false;
      } finally {
        if (valid()) {
          historyFilesLoading.value = historyFilesLoading.value.filter(
            (hash) => hash !== commit.hash
          );
          fileRequests.delete(commit.hash);
        }
      }
    })();
    fileRequests.set(commit.hash, pending);
    return pending;
  }
  async function loadDiff(tab: WorkspaceFileTab, signal?: AbortSignal): Promise<unknown> {
    const target = { nodeId: tab.nodeId, workspaceId: tab.workspaceId };
    let path: string;
    if (tab.kind === 'HISTORY_DIFF' && tab.commit !== undefined) {
      path = url(
        target,
        `/git/commits/${encodeURIComponent(tab.commit)}/diff`,
        {
          path: tab.path,
          ...(tab.previousPath === undefined ? {} : { previousPath: tab.previousPath })
        },
        { repositoryPath: tab.repositoryPath, refs: tab.refs ?? [] }
      );
    } else if (tab.kind === 'WORKTREE_DIFF')
      path = url(target, '/changes/diff', {
        path: tab.path,
        ...(tab.repositoryPath === '' ? {} : { repositoryPath: tab.repositoryPath }),
        ...(tab.worktreePath === '' ? {} : { worktreePath: tab.worktreePath })
      });
    else throw new Error('NODE_RESPONSE_INVALID');
    const result = await input.http.request(path, signal === undefined ? {} : { signal });
    if (typeof result !== 'object' || result === null || !('diff' in result))
      throw new Error('NODE_RESPONSE_INVALID');
    return result.diff;
  }
  async function restoreChange(entry: ChangeEntry, target = input.target()): Promise<boolean> {
    const generation = epoch;
    if (
      target === undefined ||
      !input.gitEnabled() ||
      !current(target, generation) ||
      restoringPath.value !== undefined
    )
      return false;
    restoringPath.value = changeKey(entry);
    try {
      await input.http.request(url(target, '/changes/restore'), {
        method: 'POST',
        body: JSON.stringify({
          nodeId: target.nodeId,
          path: entry.path,
          state: entry.state,
          ...(entry.repositoryPath === '' ? {} : { repositoryPath: entry.repositoryPath }),
          ...(entry.worktreePath === undefined ? {} : { worktreePath: entry.worktreePath })
        })
      });
      if (!current(target, generation)) return true;
      await loadChanges();
      return true;
    } catch (error) {
      if (current(target, generation)) input.onFailure(error, 'RESTORE');
      return false;
    } finally {
      if (current(target, generation)) restoringPath.value = undefined;
    }
  }
  function snapshot(): WorkspaceGitSnapshot {
    return {
      changes: changes.value,
      historyRepositoryPath: historyRepositoryPath.value,
      selectedHistoryRefs: [...selectedHistoryRefs.value],
      historyCommits: [...historyCommits.value],
      historyNextCursor: historyNextCursor.value,
      historySource: { ...historySource.value, refs: [...historySource.value.refs] }
    };
  }
  function reset(preserveWatchRevision = false): void {
    epoch += 1;
    historyGeneration += 1;
    if (!preserveWatchRevision || !matchesChangesTarget()) appliedWatchRevision = -1;
    const target = input.target();
    changesTarget = target === undefined ? undefined : { ...target };
    changesTask = createChangesTask(epoch);
    changes.value = undefined;
    changesRefreshing.value = false;
    changesFetchRequested = false;
    changesFetchFailed.value = false;
    historyFetchFailed.value = false;
    restoringPath.value = undefined;
    historyRepositoryPath.value = '';
    selectedHistoryRefs.value = [];
    historyRefs.value = [];
    historyRefsRepository = undefined;
    historyCommits.value = [];
    historyFetch = undefined;
    historyNextCursor.value = null;
    historyLoading.value = false;
    historySource.value = { repositoryPath: '', refs: [] };
    clearHistoryFiles();
  }
  function restore(value: Partial<WorkspaceGitSnapshot>): void {
    const watchedChanges = changes.value;
    const hasWatch = matchesChangesTarget() && appliedWatchRevision >= 0;
    reset(true);
    if (input.target() === undefined || !input.gitEnabled()) return;
    changes.value = hasWatch ? watchedChanges : value.changes;
    historyRepositoryPath.value =
      typeof value.historyRepositoryPath === 'string' ? value.historyRepositoryPath : '';
    selectedHistoryRefs.value = Array.isArray(value.selectedHistoryRefs)
      ? value.selectedHistoryRefs.filter((name): name is string => typeof name === 'string')
      : [];
    historyCommits.value = Array.isArray(value.historyCommits)
      ? value.historyCommits.filter(isHistoryCommit)
      : [];
    historyNextCursor.value =
      typeof value.historyNextCursor === 'string' ? value.historyNextCursor : null;
    historySource.value = value.historySource ?? {
      repositoryPath: historyRepositoryPath.value,
      refs: [...selectedHistoryRefs.value]
    };
  }
  return {
    changes: readonly(changes),
    changesRefreshing: readonly(changesRefreshing),
    changesFetchFailed: readonly(changesFetchFailed),
    historyFetchFailed: readonly(historyFetchFailed),
    restoringPath: readonly(restoringPath),
    visibleChanges,
    repositories,
    worktrees,
    worktreesTruncated,
    discoveryErrors,
    historyRepositoryPath: readonly(historyRepositoryPath),
    selectedHistoryRefs: readonly(selectedHistoryRefs),
    historyRefs: readonly(historyRefs),
    historyCommits: readonly(historyCommits),
    historyNextCursor: readonly(historyNextCursor),
    historyLoading: readonly(historyLoading),
    historyFiles: readonly(historyFiles),
    historyFilesLoading: readonly(historyFilesLoading),
    historySource: readonly(historySource),
    loadChanges,
    applyWatch,
    loadHistory,
    selectHistory,
    openHistory,
    loadHistoryFiles,
    loadDiff,
    restoreChange,
    snapshot,
    restore,
    reset
  };
}

export type WorkspaceGitService = ReturnType<typeof createWorkspaceGitService>;

export function changeKey(entry: ChangeEntry): string {
  return `${entry.repositoryPath}:${entry.worktreePath ?? ''}:${entry.state}:${entry.path}`;
}
function isHistoryRef(value: unknown): value is HistoryRef {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<HistoryRef>;
  return (
    typeof item.name === 'string' &&
    typeof item.displayName === 'string' &&
    typeof item.hash === 'string' &&
    typeof item.current === 'boolean' &&
    (item.kind === 'LOCAL' || item.kind === 'REMOTE')
  );
}
function isHistoryCommit(value: unknown): value is HistoryCommit {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<HistoryCommit>;
  return (
    typeof item.hash === 'string' &&
    Array.isArray(item.parents) &&
    item.parents.every((parent) => typeof parent === 'string') &&
    typeof item.subject === 'string' &&
    typeof item.authorName === 'string' &&
    typeof item.authorEmail === 'string' &&
    typeof item.committedAt === 'number' &&
    Array.isArray(item.refs) &&
    item.refs.every((name) => typeof name === 'string')
  );
}
function isHistoryFile(value: unknown): value is HistoryFile {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<HistoryFile>;
  return (
    typeof item.path === 'string' &&
    typeof item.change === 'string' &&
    (item.previousPath === undefined || typeof item.previousPath === 'string')
  );
}
