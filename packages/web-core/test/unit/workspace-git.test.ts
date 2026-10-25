import { describe, expect, it, vi } from 'vitest';
import type {
  ChangeEntry,
  ChangeRepository,
  HistoryCommit,
  HistoryFile,
  HistoryRef
} from '../../src/model/workspace-git.js';
import type { ScopedHttpService } from '../../src/service/scoped-http-service.js';
import { changeKey, createWorkspaceGitService } from '../../src/service/workspace-git-service.js';
import type { WorkspaceFileOperationTarget } from '../../src/service/workspace-file-operation-service.js';
import type { WorkspaceFileTab } from '../../src/util/workspace-file-tab.js';
import { limitChangeRepositories } from '../../src/util/workspace-git.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function historyRef(name: string): HistoryRef {
  return {
    name,
    displayName: name,
    kind: 'LOCAL',
    hash: 'a'.repeat(40),
    current: true
  };
}

function historyCommit(hash: string, refs: readonly string[] = []): HistoryCommit {
  return {
    hash,
    parents: [],
    subject: `subject ${hash}`,
    authorName: 'Test Author',
    authorEmail: 'author@example.test',
    committedAt: 1,
    refs
  };
}

function historyFile(path: string): HistoryFile {
  return { path, change: 'MODIFIED' };
}

const defaultTarget: WorkspaceFileOperationTarget = {
  nodeId: 'node-1',
  workspaceId: 'workspace-1'
};

function createGitHarness(
  handler: (path: string, init?: RequestInit) => Promise<unknown> = async () => ({})
) {
  let activeTarget: WorkspaceFileOperationTarget | undefined = defaultTarget;
  const request = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(handler);
  const http: ScopedHttpService = {
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      return (await request(path, init)) as T;
    }
  };
  const onFailure = vi.fn();
  const onWorkspace = vi.fn();
  const onBranch = vi.fn();
  const service = createWorkspaceGitService({
    http,
    target: () => activeTarget,
    gitEnabled: () => true,
    historyEnabled: () => true,
    onFailure,
    onWorkspace,
    onBranch
  });
  return {
    service,
    request,
    onFailure,
    onWorkspace,
    onBranch,
    setTarget(target: WorkspaceFileOperationTarget | undefined) {
      activeTarget = target;
    }
  };
}

function requestUrl(path: string): URL {
  return new URL(path, 'http://workspace.test');
}

describe('Workspace Git service', () => {
  it('limits rendered changes across repository boundaries without dropping later batches', () => {
    const repository = (repositoryPath: string, count: number): ChangeRepository => ({
      repositoryPath,
      repositoryName: repositoryPath || 'root',
      source: 'ROOT',
      current: true,
      branch: 'main',
      locked: false,
      prunable: false,
      changes: Array.from({ length: count }, (_, index) => ({
        repositoryPath,
        repositoryName: repositoryPath,
        source: 'ROOT',
        path: `${repositoryPath}/${index}.txt`,
        state: 'UNTRACKED',
        change: 'ADDED',
        diffAvailable: true
      }))
    });
    const repositories = [repository('', 2), repository('sub', 3), repository('empty', 0)];

    expect(
      limitChangeRepositories(repositories, 3).map((entry) => [
        entry.repositoryPath,
        entry.changes.length
      ])
    ).toEqual([
      ['', 2],
      ['sub', 1],
      ['empty', 0]
    ]);
    expect(
      limitChangeRepositories(repositories, 6).map((entry) => [
        entry.repositoryPath,
        entry.changes.length
      ])
    ).toEqual([
      ['', 2],
      ['sub', 3],
      ['empty', 0]
    ]);
  });

  it('uses the initial Watch snapshot without an extra changes GET when opening history', async () => {
    const snapshot = {
      workspace: {
        id: 'workspace-1',
        path: '/workspace',
        kind: 'GIT_WORKSPACE',
        gitSummary: { branch: 'main' }
      },
      repositories: [],
      changes: []
    };
    const { service, request } = createGitHarness(async (path) => {
      if (requestUrl(path).pathname.endsWith('/git/refs')) return { refs: [] };
      if (requestUrl(path).pathname.endsWith('/git/history'))
        return { commits: [], nextCursor: null };
      throw new Error(`Unexpected request: ${path}`);
    });

    expect(service.applyWatch(snapshot, 1)).toBe(true);
    expect(request).not.toHaveBeenCalled();
    await service.openHistory();

    expect(request.mock.calls.map(([path]) => requestUrl(path).pathname)).toEqual([
      '/api/workspaces/workspace-1/git/refs',
      '/api/workspaces/workspace-1/git/history'
    ]);
    expect(service.changes.value).toEqual(snapshot);
  });

  it('opens History before the first Watch after binding the initial target', async () => {
    const { service, request } = createGitHarness(async (path) => {
      const pathname = requestUrl(path).pathname;
      if (pathname.endsWith('/changes')) return { changes: [] };
      if (pathname.endsWith('/git/refs')) return { refs: [historyRef('refs/heads/main')] };
      if (pathname.endsWith('/git/history'))
        return { commits: [historyCommit('initial')], nextCursor: null };
      throw new Error(`Unexpected request: ${path}`);
    });
    await service.openHistory();
    expect(service.historyCommits.value.map((commit) => commit.hash)).toEqual(['initial']);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('coalesces overlapping change refreshes into one trailing request', async () => {
    const first = deferred<unknown>();
    const trailing = deferred<unknown>();
    const trailingStarted = deferred<void>();
    let calls = 0;
    const { service, request } = createGitHarness(async () => {
      calls += 1;
      if (calls === 1) return first.promise;
      trailingStarted.resolve();
      return trailing.promise;
    });

    const firstRefresh = service.loadChanges();
    const joinedRefresh = service.loadChanges();
    const joinedAgain = service.loadChanges();
    expect(joinedRefresh).toBe(firstRefresh);
    expect(joinedAgain).toBe(firstRefresh);
    expect(request).toHaveBeenCalledTimes(1);

    first.resolve({ changes: [{ path: 'first.txt' }] });
    await trailingStarted.promise;
    expect(request).toHaveBeenCalledTimes(2);
    trailing.resolve({ changes: [{ path: 'trailing.txt' }] });
    await firstRefresh;

    expect(service.changes.value).toEqual({ changes: [{ path: 'trailing.txt' }] });
    expect(service.changesRefreshing.value).toBe(false);
  });

  it('does not apply a pending changes response or restore loading after workspace reset', async () => {
    const pending = deferred<unknown>();
    const { service } = createGitHarness(async () => pending.promise);

    const loading = service.loadChanges();
    expect(service.changesRefreshing.value).toBe(true);
    service.reset();
    expect(service.changesRefreshing.value).toBe(false);

    pending.resolve({ changes: [{ path: 'stale.txt' }] });
    await loading;

    expect(service.changes.value).toBeUndefined();
    expect(service.changesRefreshing.value).toBe(false);
  });

  it('keeps a newer Watch snapshot over an older in-flight changes GET', async () => {
    const pending = deferred<unknown>();
    const olderSnapshot = { repositories: [], changes: [{ path: 'older.txt' }] };
    const newerSnapshot = { repositories: [], changes: [{ path: 'watch-newer.txt' }] };
    const { service } = createGitHarness(async () => pending.promise);

    expect(service.applyWatch(olderSnapshot, 1)).toBe(true);
    const loading = service.loadChanges();
    expect(service.applyWatch(newerSnapshot, 2)).toBe(true);
    pending.resolve(olderSnapshot);
    await loading;

    expect(service.changes.value).toEqual(newerSnapshot);
    expect(service.changesRefreshing.value).toBe(false);
  });

  it('retains healthy repository tracking beside partial failures without duplicating grouped worktrees', async () => {
    const repositoryError = {
      code: 'GIT_REPOSITORY_UNAVAILABLE',
      message: 'Repository unavailable.'
    };
    const discoveryError = {
      code: 'GIT_DISCOVERY_PARTIAL',
      message: 'Some repositories could not be read.'
    };
    const response = {
      workspace: {
        id: 'workspace-1',
        path: '/workspace',
        kind: 'GIT_WORKSPACE',
        gitSummary: { branch: 'main' }
      },
      repositories: [
        {
          repositoryPath: '',
          repositoryName: 'root',
          source: 'ROOT',
          branch: 'main',
          current: true,
          tracking: { upstream: 'origin/main', ahead: 2, behind: 1 },
          status: 'DIRTY',
          locked: false,
          prunable: false,
          changes: [
            { path: 'src/main.ts', state: 'UNSTAGED', change: 'MODIFIED', diffAvailable: true }
          ]
        },
        {
          repositoryPath: 'packages/missing',
          repositoryName: 'missing',
          source: 'SUBMODULE',
          branch: null,
          status: 'UNAVAILABLE',
          locked: false,
          prunable: false,
          error: repositoryError,
          changes: []
        },
        {
          repositoryPath: '',
          repositoryName: 'feature worktree',
          source: 'WORKTREE',
          worktreePath: 'worktrees/feature',
          branch: 'feature',
          status: 'DIRTY',
          locked: false,
          prunable: false,
          changes: [
            { path: 'src/feature.ts', state: 'UNTRACKED', change: 'ADDED', diffAvailable: true }
          ]
        }
      ],
      worktrees: [
        {
          directoryName: 'feature',
          branch: 'feature',
          head: 'b'.repeat(40),
          current: false,
          status: 'DIRTY',
          locked: false,
          prunable: false
        }
      ],
      errors: [discoveryError]
    };
    const { service } = createGitHarness(async () => response);

    await service.loadChanges();

    expect(service.repositories.value.map((repository) => repository.repositoryName)).toEqual([
      'root',
      'missing',
      'feature worktree'
    ]);
    expect(service.repositories.value[0]?.tracking).toEqual({
      upstream: 'origin/main',
      ahead: 2,
      behind: 1
    });
    expect(service.repositories.value[1]).toMatchObject({
      status: 'UNAVAILABLE',
      error: repositoryError,
      changes: []
    });
    expect(service.discoveryErrors.value).toEqual([discoveryError]);
    expect(service.visibleChanges.value.map((entry) => entry.path)).toEqual([
      'src/main.ts',
      'src/feature.ts'
    ]);
    expect(service.worktrees.value).toEqual([]);
  });

  it('pins history repository and refs while newer selections supersede late responses', async () => {
    const refsA = deferred<unknown>();
    const refsB = deferred<unknown>();
    const historyA = deferred<unknown>();
    const historyB = deferred<unknown>();
    const historyStartedA = deferred<void>();
    const historyStartedB = deferred<void>();
    const { service, request } = createGitHarness(async (path) => {
      const url = requestUrl(path);
      const repositoryPath = url.searchParams.get('repositoryPath');
      if (url.pathname.endsWith('/git/refs'))
        return repositoryPath === 'repo/A' ? refsA.promise : refsB.promise;
      if (url.pathname.endsWith('/git/history')) {
        if (repositoryPath === 'repo/A') {
          historyStartedA.resolve();
          return historyA.promise;
        }
        historyStartedB.resolve();
        return historyB.promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const selectedRefsA = ['refs/heads/a'];
    const selectedRefsB = ['refs/heads/b'];

    const selectionA = service.selectHistory('repo/A', selectedRefsA);
    selectedRefsA.push('changed-after-selection');
    refsA.resolve({ refs: [historyRef('refs/heads/a')] });
    await historyStartedA.promise;

    const selectionB = service.selectHistory('repo/B', selectedRefsB);
    selectedRefsB.push('changed-after-selection');
    refsB.resolve({ refs: [historyRef('refs/heads/b')] });
    await historyStartedB.promise;

    historyB.resolve({ commits: [historyCommit('commit-B')], nextCursor: null });
    await selectionB;
    historyA.resolve({ commits: [historyCommit('commit-A')], nextCursor: null });
    await selectionA;

    expect(service.historyRepositoryPath.value).toBe('repo/B');
    expect(service.selectedHistoryRefs.value).toEqual(['refs/heads/b']);
    expect(service.historySource.value).toEqual({
      repositoryPath: 'repo/B',
      refs: ['refs/heads/b']
    });
    expect(service.historyRefs.value.map((ref) => ref.name)).toEqual(['refs/heads/b']);
    expect(service.historyCommits.value.map((commit) => commit.hash)).toEqual(['commit-B']);
    expect(service.historyLoading.value).toBe(false);
    for (const [path] of request.mock.calls) {
      const url = requestUrl(path);
      if (!url.pathname.endsWith('/git/refs') && !url.pathname.endsWith('/git/history')) continue;
      const expectedRef =
        url.searchParams.get('repositoryPath') === 'repo/A' ? 'refs/heads/a' : 'refs/heads/b';
      expect(url.searchParams.getAll('refs')).toEqual([expectedRef]);
    }
  });

  it('uses the next history cursor and deduplicates commits across pages', async () => {
    let historyPage = 0;
    const { service, request } = createGitHarness(async (path) => {
      const url = requestUrl(path);
      if (url.pathname.endsWith('/git/refs')) return { refs: [historyRef('refs/heads/main')] };
      historyPage += 1;
      return historyPage === 1
        ? { commits: [historyCommit('commit-1')], nextCursor: 'cursor/next' }
        : {
            commits: [historyCommit('commit-1'), historyCommit('commit-2')],
            nextCursor: null
          };
    });

    await service.selectHistory('repo/main', ['refs/heads/main']);
    await service.loadHistory();

    const historyUrls = request.mock.calls
      .map(([path]) => requestUrl(path))
      .filter((url) => url.pathname.endsWith('/git/history'));
    expect(historyUrls).toHaveLength(2);
    expect(historyUrls[0]?.searchParams.get('cursor')).toBeNull();
    expect(historyUrls[1]?.searchParams.get('cursor')).toBe('cursor/next');
    expect(historyUrls.every((url) => url.searchParams.get('repositoryPath') === 'repo/main')).toBe(
      true
    );
    expect(
      historyUrls.every((url) => url.searchParams.getAll('refs')[0] === 'refs/heads/main')
    ).toBe(true);
    expect(service.historyCommits.value.map((commit) => commit.hash)).toEqual([
      'commit-1',
      'commit-2'
    ]);
    expect(service.historyNextCursor.value).toBeNull();
  });

  it('keeps applied history identity for commit files and pagination after a draft fails', async () => {
    const historyError = new Error('HISTORY_REFRESH_FAILED');
    const oldCommit = historyCommit('old-commit', ['refs/heads/applied']);
    const { service, request, onFailure } = createGitHarness(async (path) => {
      const url = requestUrl(path);
      if (url.pathname.endsWith('/git/refs'))
        return {
          refs: [
            historyRef(
              url.searchParams.get('repositoryPath') === 'repo/applied'
                ? 'refs/heads/applied'
                : 'refs/heads/draft'
            )
          ]
        };
      if (url.pathname.endsWith('/git/history')) {
        if (url.searchParams.get('repositoryPath') === 'repo/draft') throw historyError;
        return url.searchParams.has('cursor')
          ? { commits: [historyCommit('next-commit')], nextCursor: null }
          : { commits: [oldCommit], nextCursor: 'applied-next' };
      }
      if (url.pathname.endsWith('/git/commits/old-commit/files'))
        return { files: [historyFile('old-name.txt')] };
      throw new Error(`Unexpected request: ${path}`);
    });

    await service.selectHistory('repo/applied', ['refs/heads/applied']);
    await service.selectHistory('repo/draft', ['refs/heads/draft']);
    expect(service.historyRepositoryPath.value).toBe('repo/draft');
    expect(service.selectedHistoryRefs.value).toEqual(['refs/heads/draft']);
    expect(service.historySource.value).toEqual({
      repositoryPath: 'repo/applied',
      refs: ['refs/heads/applied']
    });

    await expect(service.loadHistoryFiles(oldCommit)).resolves.toBe(true);

    const filesRequest = request.mock.calls
      .map(([path]) => requestUrl(path))
      .find((url) => url.pathname.endsWith('/git/commits/old-commit/files'));
    expect(filesRequest?.searchParams.get('repositoryPath')).toBe('repo/applied');
    expect(filesRequest?.searchParams.getAll('refs')).toEqual(['refs/heads/applied']);
    expect(service.historyFiles.value['old-commit']).toEqual([historyFile('old-name.txt')]);
    expect(onFailure).toHaveBeenCalledWith(historyError, 'HISTORY');
    await service.loadHistory();
    const pagination = requestUrl(request.mock.calls.at(-1)![0]);
    expect(pagination.searchParams.get('repositoryPath')).toBe('repo/applied');
    expect(pagination.searchParams.getAll('refs')).toEqual(['refs/heads/applied']);
    expect(pagination.searchParams.get('cursor')).toBe('applied-next');
    expect(service.historyCommits.value.map((commit) => commit.hash)).toEqual([
      'old-commit',
      'next-commit'
    ]);
  });

  it('retains accepted Watch facts when restoring an older view cache', () => {
    const { service } = createGitHarness();
    const old = { branch: 'old', changes: [] };
    service.restore({ changes: old });
    const snapshot = service.snapshot();
    const fresh = { branch: 'fresh', changes: [] };
    service.applyWatch(fresh, 3);
    service.restore(snapshot);
    expect(service.changes.value).toEqual(fresh);
    expect(service.applyWatch(old, 2)).toBe(false);
    expect(service.changes.value).toEqual(fresh);
  });

  it.each([
    { nodeId: 'node-1', workspaceId: 'workspace-2' },
    { nodeId: 'node-2', workspaceId: 'workspace-1' }
  ])('isolates cached Changes and Watch revisions for $nodeId/$workspaceId', (target) => {
    const { service, setTarget } = createGitHarness();
    const a = { changes: [{ path: 'a-only.txt' }] };
    const cached = { changes: [{ path: 'b-cached.txt' }] };
    const fresh = { changes: [{ path: 'b-fresh.txt' }] };
    expect(service.applyWatch(a, 3)).toBe(true);
    setTarget(target);
    service.restore({ changes: cached });
    expect(service.changes.value).toEqual(cached);
    expect(service.applyWatch(fresh, 1)).toBe(true);
    expect(service.applyWatch(a, 0)).toBe(false);
    expect(service.changes.value).toEqual(fresh);
    service.restore({ changes: cached });
    expect(service.changes.value).toEqual(fresh);
  });

  it('accepts a new target Watch before cache recovery and clears missing targets and reset state', () => {
    const { service, setTarget } = createGitHarness();
    service.applyWatch({ changes: [{ path: 'a-only.txt' }] }, 3);
    setTarget({ nodeId: 'node-2', workspaceId: 'workspace-1' });
    const fresh = { changes: [{ path: 'b-fresh.txt' }] };
    expect(service.applyWatch(fresh, 1)).toBe(true);
    service.restore({ changes: { changes: [{ path: 'b-cached.txt' }] } });
    expect(service.changes.value).toEqual(fresh);
    setTarget(defaultTarget);
    service.restore({});
    expect(service.changes.value).toBeUndefined();
    expect(service.applyWatch(fresh, 1)).toBe(true);
    setTarget(undefined);
    service.restore({ changes: fresh });
    expect(service.changes.value).toBeUndefined();
    expect(service.applyWatch(fresh, 9)).toBe(false);
    setTarget(defaultTarget);
    service.reset();
    expect(service.applyWatch(fresh, 1)).toBe(true);
    service.reset(true);
    expect(service.changes.value).toBeUndefined();
    expect(service.applyWatch(fresh, 1)).toBe(false);
  });

  it.each(['success', 'failure'] as const)(
    'isolates old HTTP %s and finally while the restored target refreshes',
    async (outcome) => {
      const old = deferred<unknown>();
      const next = deferred<unknown>();
      const { service, setTarget, onFailure } = createGitHarness(async (path) =>
        requestUrl(path).pathname.includes('workspace-1') ? old.promise : next.promise
      );
      service.applyWatch({ changes: [{ path: 'a-only.txt' }] }, 3);
      const oldRequest = service.loadChanges();
      setTarget({ nodeId: 'node-1', workspaceId: 'workspace-2' });
      const cached = { changes: [{ path: 'b-cached.txt' }] };
      service.restore({ changes: cached });
      const newRequest = service.loadChanges();
      if (outcome === 'success') old.resolve({ changes: [{ path: 'a-late.txt' }] });
      else old.reject(new Error('OLD_TARGET_FAILED'));
      await oldRequest;
      expect(service.changes.value).toEqual(cached);
      expect(service.changesRefreshing.value).toBe(true);
      expect(onFailure).not.toHaveBeenCalled();
      const fresh = { changes: [{ path: 'b-fresh.txt' }] };
      expect(service.applyWatch(fresh, 1)).toBe(true);
      next.resolve({ changes: [{ path: 'b-stale-http.txt' }] });
      await newRequest;
      expect(service.changes.value).toEqual(fresh);
      expect(service.changesRefreshing.value).toBe(false);
    }
  );

  it('runs distinct commit file reads in parallel, reuses identical reads, and ignores reset results', async () => {
    const filesA = deferred<unknown>();
    const filesB = deferred<unknown>();
    const filesStale = deferred<unknown>();
    const commits = [
      historyCommit('commit-A'),
      historyCommit('commit-B'),
      historyCommit('commit-stale')
    ];
    const fileResponses = new Map([
      ['commit-A', filesA],
      ['commit-B', filesB],
      ['commit-stale', filesStale]
    ]);
    const { service, request, onFailure } = createGitHarness(async (path) => {
      const url = requestUrl(path);
      if (url.pathname.endsWith('/git/refs')) return { refs: [historyRef('main')] };
      if (url.pathname.endsWith('/git/history')) return { commits, nextCursor: null };
      if (url.pathname.includes('/git/commits/') && url.pathname.endsWith('/files')) {
        const hash = url.pathname.split('/').at(-2)!;
        return fileResponses.get(hash)!.promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    await service.selectHistory('repo/main', ['main']);

    const firstA = service.loadHistoryFiles(commits[0]!);
    const secondA = service.loadHistoryFiles(commits[0]!);
    const firstB = service.loadHistoryFiles(commits[1]!);
    expect(secondA).toBe(firstA);
    expect(
      request.mock.calls.filter(([path]) => requestUrl(path).pathname.endsWith('/files'))
    ).toHaveLength(2);
    expect(service.historyFilesLoading.value).toEqual(['commit-A', 'commit-B']);

    filesB.resolve({ files: [historyFile('b.txt')] });
    await expect(firstB).resolves.toBe(true);
    filesA.resolve({ files: [historyFile('a.txt')] });
    await expect(firstA).resolves.toBe(true);
    expect(service.historyFiles.value).toEqual({
      'commit-B': [historyFile('b.txt')],
      'commit-A': [historyFile('a.txt')]
    });
    expect(service.historyFilesLoading.value).toEqual([]);

    const staleRead = service.loadHistoryFiles(commits[2]!);
    service.reset();
    filesStale.resolve({ files: [historyFile('stale.txt')] });
    await expect(staleRead).resolves.toBe(false);
    expect(service.historyFiles.value).toEqual({});
    expect(service.historyFilesLoading.value).toEqual([]);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('retains tab workspace, repository, revision, refs, and rename source in history diffs', async () => {
    const diff = { status: 'available', patch: 'diff contents' };
    const { service, request } = createGitHarness(async () => ({ diff }));
    const tab: WorkspaceFileTab = {
      id: 1,
      identity: 'history-diff',
      kind: 'HISTORY_DIFF',
      nodeId: 'node-diff',
      workspaceId: 'workspace / one',
      path: 'src/new name.ts',
      fileName: 'new name.ts',
      repositoryPath: 'packages/core',
      worktreePath: '',
      commit: 'commit/123',
      previousPath: 'src/old name.ts',
      refs: ['refs/heads/main', 'refs/remotes/origin/main']
    };

    await expect(service.loadDiff(tab)).resolves.toBe(diff);

    const [path] = request.mock.calls[0]!;
    const url = requestUrl(path);
    expect(url.pathname).toBe(
      '/api/workspaces/workspace%20%2F%20one/git/commits/commit%2F123/diff'
    );
    expect(url.searchParams.get('nodeId')).toBe('node-diff');
    expect(url.searchParams.get('repositoryPath')).toBe('packages/core');
    expect(url.searchParams.get('path')).toBe('src/new name.ts');
    expect(url.searchParams.get('previousPath')).toBe('src/old name.ts');
    expect(url.searchParams.getAll('refs')).toEqual([
      'refs/heads/main',
      'refs/remotes/origin/main'
    ]);

    const invalid = createGitHarness(async () => ({})).service;
    await expect(invalid.loadDiff(tab)).rejects.toThrow('NODE_RESPONSE_INVALID');
  });

  it('serializes restore operations and clears status while reporting POST errors', async () => {
    const post = deferred<unknown>();
    const restoreError = new Error('RESTORE_FAILED');
    const { service, request, onFailure } = createGitHarness(async () => post.promise);
    const entry: ChangeEntry = {
      repositoryPath: 'repo/root',
      repositoryName: 'root',
      source: 'ROOT',
      path: 'src/main.ts',
      state: 'UNSTAGED',
      change: 'MODIFIED',
      diffAvailable: true
    };

    const restoring = service.restoreChange(entry);
    expect(service.restoringPath.value).toBe(changeKey(entry));
    await expect(service.restoreChange({ ...entry, path: 'other.ts' })).resolves.toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]?.method).toBe('POST');
    post.reject(restoreError);

    await expect(restoring).resolves.toBe(false);
    expect(service.restoringPath.value).toBeUndefined();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(restoreError, 'RESTORE');
  });

  it('keeps a successful restore successful when the follow-up changes refresh fails', async () => {
    const refreshError = new Error('CHANGES_REFRESH_FAILED');
    const { service, request, onFailure } = createGitHarness(async (_path, init) => {
      if (init?.method === 'POST') return {};
      throw refreshError;
    });
    const entry: ChangeEntry = {
      repositoryPath: 'repo/root',
      repositoryName: 'root',
      source: 'ROOT',
      path: 'src/main.ts',
      state: 'UNSTAGED',
      change: 'MODIFIED',
      diffAvailable: true
    };

    await expect(service.restoreChange(entry)).resolves.toBe(true);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(request.mock.calls[1]?.[1]).toBeUndefined();
    expect(service.restoringPath.value).toBeUndefined();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(refreshError, 'CHANGES');
  });

  it.each(['success', 'failure'] as const)(
    'isolates an old restore POST %s from the new target operation',
    async (outcome) => {
      const old = deferred<unknown>();
      const next = deferred<unknown>();
      const { service, setTarget, request, onFailure } = createGitHarness(async (path, init) => {
        if (init?.method !== 'POST') return { changes: [] };
        return requestUrl(path).searchParams.get('nodeId') === 'node-1'
          ? old.promise
          : next.promise;
      });
      const entry: ChangeEntry = {
        repositoryPath: 'sub',
        repositoryName: 'sub',
        source: 'SUBMODULE',
        worktreePath: '/temporary/a',
        path: 'same.txt',
        state: 'UNSTAGED',
        change: 'MODIFIED',
        diffAvailable: true
      };
      const oldRestore = service.restoreChange(entry);
      const b = { nodeId: 'node-2', workspaceId: 'workspace-1' };
      setTarget(b);
      service.restore({ changes: { changes: [] } });
      const bEntry = { ...entry, repositoryPath: '', worktreePath: '/temporary/b' };
      const newRestore = service.restoreChange(bEntry);
      if (outcome === 'success') old.resolve({ restored: true });
      else old.reject(new Error('OLD_RESTORE_FAILED'));
      await expect(oldRestore).resolves.toBe(outcome === 'success');
      expect(onFailure).not.toHaveBeenCalled();
      expect(service.restoringPath.value).toBe(changeKey(bEntry));
      expect(request).toHaveBeenCalledTimes(2);
      const [path, init] = request.mock.calls[1]!;
      expect(requestUrl(path).pathname).toBe('/api/workspaces/workspace-1/changes/restore');
      expect(requestUrl(path).searchParams.get('nodeId')).toBe('node-2');
      expect(JSON.parse(init!.body as string)).toEqual({
        nodeId: 'node-2',
        path: 'same.txt',
        state: 'UNSTAGED',
        worktreePath: '/temporary/b'
      });
      next.resolve({ restored: true });
      await expect(newRestore).resolves.toBe(true);
      expect(service.restoringPath.value).toBeUndefined();
    }
  );

  it('restores a Git snapshot and clears Git state on a DIRECTORY Watch update', async () => {
    const watchSnapshot = {
      workspace: {
        id: 'workspace-1',
        path: '/workspace',
        kind: 'GIT_WORKSPACE',
        gitSummary: { branch: 'main' }
      },
      repositories: [],
      changes: [{ path: 'src/main.ts' }]
    };
    const { service, onWorkspace } = createGitHarness(async (path) => {
      if (requestUrl(path).pathname.endsWith('/git/refs'))
        return { refs: [historyRef('refs/heads/main')] };
      return { commits: [historyCommit('commit-main')], nextCursor: 'cursor-next' };
    });
    expect(service.applyWatch(watchSnapshot, 1)).toBe(true);
    await service.selectHistory('repo/main', ['refs/heads/main']);
    const snapshot = service.snapshot();

    service.reset();
    service.restore(snapshot);
    expect(service.changes.value).toEqual(watchSnapshot);
    expect(service.historyRepositoryPath.value).toBe('repo/main');
    expect(service.selectedHistoryRefs.value).toEqual(['refs/heads/main']);
    expect(service.historyCommits.value.map((commit) => commit.hash)).toEqual(['commit-main']);
    expect(service.historyNextCursor.value).toBe('cursor-next');
    expect(service.historySource.value).toEqual({
      repositoryPath: 'repo/main',
      refs: ['refs/heads/main']
    });

    const directorySnapshot = {
      workspace: { id: 'workspace-1', path: '/plain', kind: 'DIRECTORY' },
      repositories: [],
      changes: []
    };
    expect(service.applyWatch(directorySnapshot, 2)).toBe(true);
    expect(service.changes.value).toBeUndefined();
    expect(service.historyRepositoryPath.value).toBe('');
    expect(service.selectedHistoryRefs.value).toEqual([]);
    expect(service.historyCommits.value).toEqual([]);
    expect(service.historyNextCursor.value).toBeNull();
    expect(service.historySource.value).toEqual({ repositoryPath: '', refs: [] });
    expect(service.applyWatch(watchSnapshot, 1)).toBe(false);
    expect(onWorkspace).toHaveBeenLastCalledWith(directorySnapshot.workspace);
  });
});
