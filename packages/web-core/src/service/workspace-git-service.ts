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
  adjacentChange,
  changeDiffIntent,
  changeFileLocation,
  changeEntries,
  changeRepositories,
  changeWorktrees,
  changeWorktreesTruncated,
  comparisonChange,
  gitFileRepositoryPath,
  hasExplicitChangeRepositoryGroups,
  historyDiffIntent
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

const CHANGES_FETCH_INTERVAL_MS = 30_000;

interface GitFetchResult {
  readonly fetchFailed: boolean;
  readonly updated: boolean;
}

export function createWorkspaceGitService(input: {
  readonly http: ScopedHttpService;
  readonly target: () => WorkspaceFileOperationTarget | undefined;
  readonly gitEnabled: () => boolean;
  readonly historyEnabled: () => boolean;
  readonly workspacePath?: () => string | undefined;
  readonly onFailure: (error: unknown, operation: WorkspaceGitOperation) => void;
  readonly onWorkspace: (workspace: WorkspaceFileTreeWorkspace) => void;
  readonly onBranch: (workspaceId: string, branch: string | null) => void;
}) {
  const changes = shallowRef<unknown>();
  const changesRefreshing = ref(false);
  const changesError = ref(false);
  const changesFailureCause = shallowRef<unknown>();
  let changesFailedFetch = false;
  const changesFetchFailed = ref(false);
  const historyFetchFailed = ref(false);
  let changesFetchRequested = false;
  // This service belongs to the current page user; target resets retain its fetch interval.
  const changesFetches = new Map<
    string,
    {
      readonly startedAt: number;
      pending?: Promise<GitFetchResult>;
      failed: boolean;
      generation?: number;
    }
  >();
  const restoringPath = ref<string>();
  const historyRepositoryPath = ref('');
  const selectedHistoryRefs = ref<readonly string[]>([]);
  const historyRefs = shallowRef<readonly HistoryRef[]>([]);
  const historyCommits = shallowRef<readonly HistoryCommit[]>([]);
  const historyNextCursor = ref<string | null>(null);
  const historyLoading = ref(false);
  const historyError = ref<{ readonly resetPage: boolean; readonly fetch: boolean }>();
  const historyFailureCause = shallowRef<unknown>();
  const historyFiles = shallowRef<Readonly<Record<string, readonly HistoryFile[]>>>({});
  const historyFilesLoading = ref<readonly string[]>([]);
  const historyFilesErrors = ref<readonly string[]>([]);
  const historyFilesFailureCauses = shallowRef<Readonly<Record<string, unknown>>>({});
  const historySource = shallowRef<WorkspaceGitHistorySelection>({ repositoryPath: '', refs: [] });
  let historyRefsRepository: string | undefined;
  let historyFetch:
    { readonly repositoryPath: string; readonly promise: Promise<boolean> } | undefined;
  let epoch = 0;
  let historyGeneration = 0;
  let appliedWatchRevision = -1;
  let changesTarget: WorkspaceFileOperationTarget | undefined;
  const fileRequests = new Map<string, { promise?: Promise<boolean> }>();
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
    changesError.value = false;
    changesFailureCause.value = undefined;
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
      const watchRevision = appliedWatchRevision;
      try {
        const value = await input.http.request(url(target, '/changes'));
        if (current(target, generation) && watchRevision === appliedWatchRevision)
          acceptChanges(value, target);
      } catch (error) {
        if (current(target, generation) && watchRevision === appliedWatchRevision) {
          changesError.value = true;
          changesFailureCause.value = error;
          changesFailedFetch = fetch;
          input.onFailure(error, 'CHANGES');
        }
      } finally {
        if (current(target, generation)) changesRefreshing.value = false;
      }
      if (fetch && current(target, generation) && input.gitEnabled())
        requestChangesFetch(target, generation);
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
  ): Promise<GitFetchResult> {
    try {
      const result = await input.http.request<{
        readonly fetchFailed: boolean;
        readonly updated?: boolean;
      }>(url(target, '/git/fetch'), {
        method: 'POST',
        body: JSON.stringify({
          nodeId: target.nodeId,
          ...(repositoryPath === undefined ? {} : { repositoryPath })
        })
      });
      return { fetchFailed: result.fetchFailed !== false, updated: result.updated !== false };
    } catch {
      return { fetchFailed: true, updated: true };
    }
  }
  function requestChangesFetch(target: WorkspaceFileOperationTarget, generation: number): void {
    const key = JSON.stringify([target.nodeId, target.workspaceId]);
    let state = changesFetches.get(key);
    if (state?.pending === undefined) {
      // Refreshes requested before this attempt starts are already covered by it.
      changesFetchRequested = false;
      state = { startedAt: performance.now(), failed: false };
      changesFetches.set(key, state);
      const attempt = state;
      attempt.pending = fetchRemotes(target).then((result) => {
        attempt.failed = result.fetchFailed;
        delete attempt.pending;
        return result;
      });
    }
    // Rejoin after returning to a target, but refresh only once per active view generation.
    if (state.generation === generation) return;
    state.generation = generation;
    void state.pending!.then((result) => {
      if (!current(target, generation) || !input.gitEnabled()) return;
      changesFetchFailed.value = result.fetchFailed;
      if (result.updated) return loadChanges();
    });
  }
  function loadChanges(fetch = false): Promise<void> {
    if (!matchesChangesTarget()) reset();
    const target = input.target();
    if (fetch && target !== undefined && input.gitEnabled()) {
      const state = changesFetches.get(JSON.stringify([target.nodeId, target.workspaceId]));
      if (state?.pending !== undefined) {
        requestChangesFetch(target, epoch);
        fetch = false;
      } else if (
        state !== undefined &&
        performance.now() - state.startedAt < CHANGES_FETCH_INTERVAL_MS
      ) {
        changesFetchFailed.value = state.failed;
        fetch = false;
      }
    }
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
    historyFilesErrors.value = [];
    historyFilesFailureCauses.value = {};
    fileRequests.clear();
  }
  function cancelHistoryPending(): void {
    historyGeneration += 1;
    historyLoading.value = false;
    historyFilesLoading.value = [];
    fileRequests.clear();
  }
  async function loadHistory(resetPage = false, fetch = false): Promise<void> {
    const target = input.target();
    if (target === undefined || !input.historyEnabled() || (!resetPage && historyLoading.value))
      return;
    const generation = epoch;
    const request = resetPage ? ++historyGeneration : historyGeneration;
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
          promise: fetchRemotes(target, selection.repositoryPath).then(
            (result) => result.fetchFailed
          )
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
        const availableRefs = new Set(refs.map((entry) => entry.name));
        selection.refs = selection.refs.filter((name) => availableRefs.has(name));
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
      historyError.value = undefined;
      historyFailureCause.value = undefined;
      if (resetPage) {
        if (refs !== undefined) {
          historyRefs.value = refs;
          historyRefsRepository = selection.repositoryPath;
          selectedHistoryRefs.value = [...selection.refs];
        }
        historySource.value = selection;
        clearHistoryFiles();
      }
    } catch (error) {
      if (valid()) {
        historyError.value = { resetPage, fetch };
        historyFailureCause.value = error;
        input.onFailure(error, 'HISTORY');
      }
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
      generation = epoch,
      historyRequest = historyGeneration;
    if (target === undefined || !input.historyEnabled()) return;
    if (changes.value === undefined) await loadChanges();
    if (
      !current(target, generation) ||
      historyRequest !== historyGeneration ||
      !input.historyEnabled()
    )
      return;
    const available = repositories.value.filter((entry) => entry.source !== 'WORKTREE');
    if (!available.some((entry) => entry.repositoryPath === historyRepositoryPath.value))
      historyRepositoryPath.value = available[0]?.repositoryPath ?? '';
    historyRefsRepository = undefined;
    await loadHistory(true, true);
  }
  function loadHistoryFiles(commit: HistoryCommit): Promise<boolean> {
    const target = input.target(),
      generation = epoch;
    if (target === undefined || !input.historyEnabled()) return Promise.resolve(false);
    if (historyFiles.value[commit.hash] !== undefined) return Promise.resolve(true);
    const active = fileRequests.get(commit.hash);
    if (active?.promise !== undefined) return active.promise;
    const request: { promise?: Promise<boolean> } = {};
    fileRequests.set(commit.hash, request);
    const source = historySource.value;
    const selection = { ...source, refs: [...source.refs] };
    const valid = () =>
      current(target, generation) &&
      fileRequests.get(commit.hash) === request &&
      input.historyEnabled() &&
      source === historySource.value;
    historyFilesLoading.value = [...historyFilesLoading.value, commit.hash];
    const pending = (async () => {
      try {
        if (!valid()) return false;
        const result = await input.http.request<{ readonly files?: unknown }>(
          url(target, `/git/commits/${encodeURIComponent(commit.hash)}/files`, {}, selection)
        );
        if (!valid()) return false;
        if (!Array.isArray(result.files) || !result.files.every(isHistoryFile))
          throw new Error('NODE_RESPONSE_INVALID');
        historyFiles.value = { ...historyFiles.value, [commit.hash]: result.files };
        historyFilesErrors.value = historyFilesErrors.value.filter((hash) => hash !== commit.hash);
        const { [commit.hash]: _removed, ...remaining } = historyFilesFailureCauses.value;
        historyFilesFailureCauses.value = remaining;
        return true;
      } catch (error) {
        if (valid()) {
          if (!historyFilesErrors.value.includes(commit.hash))
            historyFilesErrors.value = [...historyFilesErrors.value, commit.hash];
          historyFilesFailureCauses.value = {
            ...historyFilesFailureCauses.value,
            [commit.hash]: error
          };
          input.onFailure(error, 'FILES');
        }
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
    request.promise = pending;
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
      input.onFailure(error, 'RESTORE');
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
    changesError.value = false;
    changesFailureCause.value = undefined;
    changesFailedFetch = false;
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
    historyError.value = undefined;
    historyFailureCause.value = undefined;
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
  function repositoryRoot(): unknown {
    return (changes.value as { repositoryRoot?: unknown } | undefined)?.repositoryRoot;
  }
  function changeIntent(entry: ChangeEntry) {
    const target = input.target();
    return target === undefined
      ? undefined
      : changeDiffIntent(
          entry,
          visibleChanges.value.filter((change) => change.diffAvailable),
          target,
          repositoryRoot(),
          input.workspacePath?.()
        );
  }
  function changeLocation(entry: ChangeEntry) {
    return changeFileLocation(entry, repositoryRoot(), input.workspacePath?.());
  }
  function historyIntent(commit: HistoryCommit, file: HistoryFile) {
    const target = input.target();
    return target === undefined
      ? undefined
      : historyDiffIntent(target, commit, file, historySource.value);
  }
  function resolveRepositoryPath(repositoryPath: string, worktreePath?: string) {
    return gitFileRepositoryPath(
      repositoryPath,
      worktreePath,
      repositoryRoot(),
      input.workspacePath?.()
    );
  }
  async function comparison(path: string) {
    if (!input.gitEnabled()) return undefined;
    await loadChanges();
    const entry = comparisonChange(visibleChanges.value, path);
    return entry === undefined ? undefined : changeIntent(entry);
  }
  function adjacentDiff(tab: WorkspaceFileTab, direction: -1 | 1) {
    const entry = adjacentChange(visibleChanges.value, tab, direction);
    return entry === undefined ? undefined : changeIntent(entry);
  }
  return {
    changes: readonly(changes),
    changesRefreshing: readonly(changesRefreshing),
    changesError: readonly(changesError),
    changesFailureCause: readonly(changesFailureCause),
    changesFetchFailed: readonly(changesFetchFailed),
    historyFetchFailed: readonly(historyFetchFailed),
    restoringPath: readonly(restoringPath),
    visibleChanges,
    changeIntent,
    changeLocation,
    historyIntent,
    resolveRepositoryPath,
    comparison,
    adjacentDiff,
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
    historyError: readonly(historyError),
    historyFailureCause: readonly(historyFailureCause),
    historyFiles: readonly(historyFiles),
    historyFilesLoading: readonly(historyFilesLoading),
    historyFilesErrors: readonly(historyFilesErrors),
    historyFilesFailureCauses: readonly(historyFilesFailureCauses),
    historySource: readonly(historySource),
    loadChanges,
    retryChanges: () => loadChanges(changesFailedFetch),
    applyWatch,
    loadHistory,
    selectHistory,
    openHistory,
    cancelHistoryPending,
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
