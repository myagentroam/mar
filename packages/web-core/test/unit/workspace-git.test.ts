import { afterEach, describe, expect, it, vi } from 'vitest';
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
import {
  changeDiffIntent,
  gitFileRepositoryPath,
  limitChangeRepositories
} from '../../src/util/workspace-git.js';

it('derives file intents and locations from the live Git owner and workspace metadata', () => {
  let workspacePath = '/root';
  const entry: ChangeEntry = {
    repositoryPath: 'nested',
    repositoryName: 'nested',
    source: 'SUBMODULE',
    path: 'a.ts',
    state: 'UNSTAGED',
    change: 'MODIFIED',
    diffAvailable: true
  };
  const linked = { ...entry, source: 'WORKTREE' as const, worktreePath: '/linked', path: 'b.ts' };
  const service = createWorkspaceGitService({
    http: { request: vi.fn() } as unknown as ScopedHttpService,
    target: () => ({ nodeId: 'n', workspaceId: 'w' }),
    gitEnabled: () => true,
    historyEnabled: () => true,
    workspacePath: () => workspacePath,
    onFailure: vi.fn(),
    onWorkspace: vi.fn(),
    onBranch: vi.fn()
  });
  service.applyWatch(
    {
      repositoryRoot: '/root',
      repositories: [
        {
          repositoryPath: 'nested',
          repositoryName: 'nested',
          source: 'SUBMODULE',
          changes: [entry]
        },
        {
          repositoryPath: 'nested',
          repositoryName: 'linked',
          source: 'WORKTREE',
          worktreePath: '/linked',
          changes: [linked]
        }
      ]
    },
    1
  );
  expect(service.changeIntent(entry)).toMatchObject({
    kind: 'WORKTREE_DIFF',
    paths: ['a.ts']
  });
  expect(service.changeIntent(entry)?.gitFile).toBeUndefined();
  expect(service.changeLocation(entry)).toEqual({ path: 'nested/a.ts' });
  expect(service.changeLocation(linked)).toMatchObject({ path: 'b.ts', worktreePath: '/linked' });
  expect(service.resolveRepositoryPath('', undefined)).toBeUndefined();
  workspacePath = '/another-root';
  expect(service.resolveRepositoryPath('', undefined)).toBe('');
  service.reset();
});

it('preserves repository and worktree identity in change intents', () => {
  const entry: ChangeEntry = {
    repositoryPath: 'nested',
    repositoryName: 'nested',
    source: 'SUBMODULE',
    path: 'a.ts',
    state: 'UNSTAGED',
    change: 'MODIFIED',
    diffAvailable: true
  };
  const linked = { ...entry, source: 'WORKTREE' as const, worktreePath: '/linked', path: 'b.ts' };
  expect(gitFileRepositoryPath('', undefined, '/root', '/root')).toBeUndefined();
  expect(gitFileRepositoryPath('nested', undefined, '/root', '/root')).toBeUndefined();
  expect(gitFileRepositoryPath('nested', '/linked', '/root', '/root')).toBeUndefined();
  expect(
    changeDiffIntent(entry, [entry, linked], { nodeId: 'n', workspaceId: 'w' }, '/root', '/root')
  ).toMatchObject({
    kind: 'WORKTREE_DIFF',
    repositoryPath: 'nested',
    worktreePath: '',
    paths: ['a.ts']
  });
  expect(
    changeDiffIntent(linked, [entry, linked], { nodeId: 'n', workspaceId: 'w' }, '/root', '/root')
  ).toEqual({
    kind: 'WORKTREE_DIFF',
    nodeId: 'n',
    workspaceId: 'w',
    path: 'b.ts',
    repositoryPath: 'nested',
    worktreePath: '/linked',
    paths: ['b.ts']
  });
});

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

function localChanges(path: string) {
  return {
    repositories: [
      {
        repositoryPath: '',
        repositoryName: 'root',
        source: 'ROOT',
        changes: [{ path, state: 'UNTRACKED', change: 'ADDED' }]
      }
    ]
  };
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
  afterEach(() => vi.restoreAllMocks());
  it('reads local Changes before fetching and rereads after fetching, but never fetches for background reads', async () => {
    const { service, request } = createGitHarness(async (path) =>
      requestUrl(path).pathname.endsWith('/git/fetch') ? { fetchFailed: false } : { changes: [] }
    );
    await service.loadChanges();
    expect(request).toHaveBeenCalledTimes(1);
    request.mockClear();
    await service.loadChanges(true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(request.mock.calls.map(([path]) => requestUrl(path).pathname)).toEqual([
      '/api/workspaces/workspace-1/changes',
      '/api/workspaces/workspace-1/git/fetch',
      '/api/workspaces/workspace-1/changes'
    ]);
    expect(JSON.parse(request.mock.calls[1]![1]!.body as string)).toEqual({ nodeId: 'node-1' });
  });

  it.each([false, true])(
    'does not reread Changes when fetch reports no update, including failure=%s',
    async (fetchFailed) => {
      const pending = deferred<{ fetchFailed: boolean; updated: boolean }>();
      const { service, request, onFailure } = createGitHarness(async (path) =>
        path.includes('/git/fetch') ? pending.promise : localChanges('local.txt')
      );
      await service.loadChanges(true);
      pending.resolve({ fetchFailed, updated: false });
      await pending.promise;
      // A later local read drains any erroneously queued completion refresh too.
      await service.loadChanges();
      expect(request).toHaveBeenCalledTimes(3);
      expect(service.visibleChanges.value[0]?.path).toBe('local.txt');
      expect(service.changesFetchFailed.value).toBe(fetchFailed);
      expect(onFailure).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    'rereads Changes after refs update, including failure=%s',
    async (fetchFailed) => {
      let reads = 0;
      const { service } = createGitHarness(async (path) =>
        path.includes('/git/fetch')
          ? { fetchFailed, updated: true }
          : localChanges(`local-${++reads}.txt`)
      );
      await service.loadChanges(true);
      await vi.waitFor(() => expect(service.visibleChanges.value[0]?.path).toBe('local-2.txt'));
      expect(service.changesFetchFailed.value).toBe(fetchFailed);
      expect(service.changesRefreshing.value).toBe(false);
    }
  );

  it('keeps local Changes refreshes independent of a slow fetch without queuing another fetch', async () => {
    const pending = deferred<{ fetchFailed: boolean }>();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    let reads = 0;
    const { service, request } = createGitHarness(async (path) => {
      if (requestUrl(path).pathname.endsWith('/git/fetch')) return pending.promise;
      return localChanges(`local-${++reads}.txt`);
    });
    await service.loadChanges(true);
    expect(service.visibleChanges.value[0]?.path).toBe('local-1.txt');
    expect(service.changesRefreshing.value).toBe(false);
    clock.mockReturnValue(30_000);
    await service.loadChanges(true);
    await service.loadChanges();
    expect(service.visibleChanges.value[0]?.path).toBe('local-3.txt');
    expect(request.mock.calls.filter(([path]) => path.includes('/git/fetch'))).toHaveLength(1);
    pending.resolve({ fetchFailed: false });
    await vi.waitFor(() => expect(service.visibleChanges.value[0]?.path).toBe('local-4.txt'));
    expect(service.changesRefreshing.value).toBe(false);
    expect(request).toHaveBeenCalledTimes(5);
  });

  it.each(['in-flight', 'cooldown'])(
    'does not queue a fetch when refreshes during %s finish after the interval',
    async (phase) => {
      const pendingFetch = deferred<{ fetchFailed: boolean }>();
      const pendingRead = deferred<unknown>();
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
      let holdRead = false;
      let reads = 0;
      const { service, request } = createGitHarness(async (path) => {
        if (path.includes('/git/fetch')) return pendingFetch.promise;
        reads += 1;
        if (holdRead) {
          holdRead = false;
          return pendingRead.promise;
        }
        return localChanges(`local-${reads}.txt`);
      });
      await service.loadChanges(true);
      if (phase === 'cooldown') {
        pendingFetch.resolve({ fetchFailed: true });
        await vi.waitFor(() => expect(reads).toBe(2));
      }
      clock.mockReturnValue(phase === 'cooldown' ? 29_999 : 30_000);
      holdRead = true;
      const refresh = service.loadChanges(true);
      const repeated = service.loadChanges(true);
      pendingFetch.resolve({ fetchFailed: true });
      await vi.waitFor(() => expect(service.changesFetchFailed.value).toBe(true));
      clock.mockReturnValue(60_000);
      pendingRead.resolve(localChanges('delayed-local.txt'));
      await Promise.all([refresh, repeated]);
      expect(request.mock.calls.filter(([path]) => path.includes('/git/fetch'))).toHaveLength(1);
      expect(service.changesRefreshing.value).toBe(false);
      expect(service.visibleChanges.value[0]?.path).toBe(`local-${reads}.txt`);
    }
  );

  it('coalesces fetch intentions received before the first local read completes', async () => {
    const firstRead = deferred<unknown>();
    const secondRead = deferred<unknown>();
    const pendingFetch = deferred<{ fetchFailed: boolean }>();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    let reads = 0;
    const { service, request } = createGitHarness(async (path) => {
      if (path.includes('/git/fetch')) return pendingFetch.promise;
      if (++reads === 1) return firstRead.promise;
      if (reads === 2) return secondRead.promise;
      return localChanges(`local-${reads}.txt`);
    });
    const first = service.loadChanges(true);
    const repeated = service.loadChanges(true);
    firstRead.resolve(localChanges('first-local.txt'));
    await vi.waitFor(() => expect(reads).toBe(2));
    pendingFetch.resolve({ fetchFailed: true });
    await vi.waitFor(() => expect(service.changesFetchFailed.value).toBe(true));
    clock.mockReturnValue(30_000);
    secondRead.resolve(localChanges('second-local.txt'));
    await Promise.all([first, repeated]);
    expect(request.mock.calls.filter(([path]) => path.includes('/git/fetch'))).toHaveLength(1);
    expect(service.visibleChanges.value[0]?.path).toBe('local-3.txt');
    expect(service.changesRefreshing.value).toBe(false);
  });

  it('keeps local data with a weak fetch failure flag and clears it after success', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    let fail = true;
    const { service, request, onFailure } = createGitHarness(async (path) => {
      if (requestUrl(path).pathname.endsWith('/git/fetch')) return { fetchFailed: fail };
      return {
        repositories: [
          {
            repositoryPath: '',
            repositoryName: 'root',
            source: 'ROOT',
            changes: [{ path: 'local.txt', state: 'UNTRACKED', change: 'ADDED' }]
          }
        ]
      };
    });
    await service.loadChanges(true);
    await vi.waitFor(() => expect(service.changesFetchFailed.value).toBe(true));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(service.visibleChanges.value).toHaveLength(1);
    await service.loadChanges();
    expect(service.changesFetchFailed.value).toBe(true);
    fail = false;
    clock.mockReturnValue(29_999);
    await service.loadChanges(true);
    expect(request.mock.calls.filter(([path]) => path.includes('/git/fetch'))).toHaveLength(1);
    expect(service.changesFetchFailed.value).toBe(true);
    clock.mockReturnValue(30_000);
    await service.loadChanges(true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(8));
    expect(service.changesFetchFailed.value).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('rereads Changes after a rejected fetch without reporting a local read failure', async () => {
    let reads = 0;
    const { service, onFailure } = createGitHarness(async (path) => {
      if (requestUrl(path).pathname.endsWith('/git/fetch')) throw new Error('offline');
      return localChanges(`local-${++reads}.txt`);
    });
    await service.loadChanges(true);
    await vi.waitFor(() => expect(service.visibleChanges.value[0]?.path).toBe('local-2.txt'));
    expect(service.changesFetchFailed.value).toBe(true);
    expect(service.changesError.value).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('continues History after a failed fetch without refetching for pagination or ref filters', async () => {
    const { service, request, onFailure } = createGitHarness(async (path) => {
      const pathname = requestUrl(path).pathname;
      if (pathname.endsWith('/git/fetch')) throw new Error('offline');
      if (pathname.endsWith('/git/refs')) return { refs: [historyRef('refs/heads/main')] };
      if (pathname.endsWith('/git/history')) return { commits: [historyCommit('a'.repeat(40))] };
      return { changes: [] };
    });
    await service.openHistory();
    expect(service.historyFetchFailed.value).toBe(true);
    expect(service.historyCommits.value).toHaveLength(1);
    const fetches = () =>
      request.mock.calls.filter(([path]) => requestUrl(path).pathname.endsWith('/git/fetch'));
    expect(fetches()).toHaveLength(1);
    await service.loadHistory();
    await service.selectHistory('', ['refs/heads/main']);
    expect(fetches()).toHaveLength(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it.each([
    { nodeId: 'node-1', workspaceId: 'workspace-2' },
    { nodeId: 'node-2', workspaceId: 'workspace-1' }
  ])('does not read or publish a late fetch result into $nodeId/$workspaceId', async (target) => {
    const pending = deferred<{ fetchFailed: boolean }>();
    const { service, request, setTarget } = createGitHarness(async (path) =>
      requestUrl(path).pathname.endsWith('/git/fetch') ? pending.promise : { changes: [] }
    );
    await service.loadChanges(true);
    expect(request).toHaveBeenCalledTimes(2);
    setTarget(target);
    service.reset();
    pending.resolve({ fetchFailed: true });
    await pending.promise;
    await service.loadChanges();
    expect(service.changesFetchFailed.value).toBe(false);
    expect(request).toHaveBeenCalledTimes(3);
    expect(requestUrl(request.mock.calls[2]![0]).pathname).toBe(
      `/api/workspaces/${target.workspaceId}/changes`
    );
  });

  it('retains the Changes fetch interval across target resets and isolates other targets', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const { service, request, setTarget } = createGitHarness(async (path) =>
      path.includes('/git/fetch') ? { fetchFailed: true } : { changes: [] }
    );
    await service.loadChanges(true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    for (const target of [
      { nodeId: 'node-1', workspaceId: 'workspace-2' },
      { nodeId: 'node-2', workspaceId: 'workspace-1' }
    ]) {
      setTarget(target);
      service.reset();
      await service.loadChanges(true);
      await vi.waitFor(() => expect(service.changesFetchFailed.value).toBe(true));
    }
    setTarget(defaultTarget);
    service.reset();
    await service.loadChanges(true);
    expect(request.mock.calls.filter(([path]) => path.includes('/git/fetch'))).toHaveLength(3);
    expect(service.changesFetchFailed.value).toBe(true);
  });

  it.each(['completed', 'pending'])(
    'clears an account-owned Changes fetch before the next account (%s)',
    async (phase) => {
      vi.spyOn(performance, 'now').mockReturnValue(0);
      const previous = deferred<{ fetchFailed: boolean; updated: boolean }>();
      const current = deferred<{ fetchFailed: boolean; updated: boolean }>();
      let fetches = 0;
      const { service } = createGitHarness(async (path) =>
        path.includes('/git/fetch')
          ? ++fetches === 1
            ? previous.promise
            : current.promise
          : { changes: [] }
      );
      await service.loadChanges(true);
      if (phase === 'completed') {
        previous.resolve({ fetchFailed: true, updated: false });
        await vi.waitFor(() => expect(service.changesFetchFailed.value).toBe(true));
      }

      service.clear();
      await service.loadChanges(true);
      expect(fetches).toBe(2);
      previous.resolve({ fetchFailed: true, updated: false });
      await previous.promise;
      await service.loadChanges();
      expect(service.changesFetchFailed.value).toBe(false);
      current.resolve({ fetchFailed: false, updated: false });
      await current.promise;
    }
  );

  it('prunes expired Changes fetch bookkeeping without removing an in-flight attempt', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const deletes = vi.spyOn(Map.prototype, 'delete');
    const pending = deferred<{ fetchFailed: boolean }>();
    const { service, setTarget } = createGitHarness(async (path) =>
      path.includes('/git/fetch') ? pending.promise : { changes: [] }
    );
    await service.loadChanges(true);
    clock.mockReturnValue(31_000);
    setTarget({ nodeId: 'node-2', workspaceId: 'workspace-2' });
    service.reset();
    expect(deletes).not.toHaveBeenCalledWith(JSON.stringify(['node-1', 'workspace-1']));
    pending.resolve({ fetchFailed: false });
    await vi.waitFor(() => expect(pending.promise).resolves.toEqual({ fetchFailed: false }));
    await service.loadChanges();
    expect(deletes).toHaveBeenCalledWith(JSON.stringify(['node-1', 'workspace-1']));
  });

  it('rejoins an in-flight Changes fetch after leaving and returning to its target', async () => {
    const pending = deferred<{ fetchFailed: boolean }>();
    let reads = 0;
    const { service, request, setTarget } = createGitHarness(async (path) => {
      if (path.includes('/git/fetch')) return pending.promise;
      return localChanges(`local-${++reads}.txt`);
    });
    await service.loadChanges(true);
    setTarget({ nodeId: 'node-1', workspaceId: 'workspace-2' });
    service.reset();
    setTarget(defaultTarget);
    service.reset();
    await service.loadChanges(true);
    expect(request.mock.calls.filter(([path]) => path.includes('/git/fetch'))).toHaveLength(1);
    pending.resolve({ fetchFailed: true });
    await vi.waitFor(() => expect(service.visibleChanges.value[0]?.path).toBe('local-3.txt'));
    expect(service.changesFetchFailed.value).toBe(true);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('waits for the in-flight History fetch when ref filters supersede its original read', async () => {
    const pending = deferred<{ fetchFailed: boolean }>();
    const { service, request, onFailure } = createGitHarness(async (path) => {
      const pathname = requestUrl(path).pathname;
      if (pathname.endsWith('/git/fetch')) return pending.promise;
      if (pathname.endsWith('/git/refs')) return { refs: [historyRef('refs/heads/main')] };
      return { commits: [], nextCursor: null };
    });
    const opening = service.loadHistory(true, true);
    const filtering = service.selectHistory('', ['refs/heads/main']);
    expect(request).toHaveBeenCalledTimes(1);
    pending.resolve({ fetchFailed: true });
    await Promise.all([opening, filtering]);
    expect(service.historyFetchFailed.value).toBe(true);
    const reads = request.mock.calls.filter(([path]) =>
      requestUrl(path).pathname.endsWith('/git/history')
    );
    expect(reads).toHaveLength(1);
    expect(requestUrl(reads[0]![0]).searchParams.getAll('refs')).toEqual(['refs/heads/main']);
    expect(onFailure).not.toHaveBeenCalled();
  });

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
      if (requestUrl(path).pathname.endsWith('/git/fetch')) return { fetchFailed: false };
      if (requestUrl(path).pathname.endsWith('/git/refs')) return { refs: [] };
      if (requestUrl(path).pathname.endsWith('/git/history'))
        return { commits: [], nextCursor: null };
      throw new Error(`Unexpected request: ${path}`);
    });

    expect(service.applyWatch(snapshot, 1)).toBe(true);
    expect(request).not.toHaveBeenCalled();
    await service.openHistory();

    expect(request.mock.calls.map(([path]) => requestUrl(path).pathname)).toEqual([
      '/api/workspaces/workspace-1/git/fetch',
      '/api/workspaces/workspace-1/git/refs',
      '/api/workspaces/workspace-1/git/history'
    ]);
    expect(service.changes.value).toEqual(snapshot);
  });

  it('opens History before the first Watch after binding the initial target', async () => {
    const { service, request } = createGitHarness(async (path) => {
      const pathname = requestUrl(path).pathname;
      if (pathname.endsWith('/git/fetch')) return { fetchFailed: false };
      if (pathname.endsWith('/changes')) return { changes: [] };
      if (pathname.endsWith('/git/refs')) return { refs: [historyRef('refs/heads/main')] };
      if (pathname.endsWith('/git/history'))
        return { commits: [historyCommit('initial')], nextCursor: null };
      throw new Error(`Unexpected request: ${path}`);
    });
    await service.openHistory();
    expect(service.historyCommits.value.map((commit) => commit.hash)).toEqual(['initial']);
    expect(request).toHaveBeenCalledTimes(4);
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

  it('clears a failed HTTP read through a recovered Watch snapshot without another GET', async () => {
    const error = new Error('Changes read failed');
    const { service, request } = createGitHarness(async () => {
      throw error;
    });
    await service.loadChanges();
    expect(service.changesError.value).toBe(true);
    expect(service.changesFailureCause.value).toBe(error);
    expect(request).toHaveBeenCalledOnce();

    const snapshot = localChanges('recovered.txt');
    expect(service.applyWatch(snapshot, 1)).toBe(true);
    expect(service.changesError.value).toBe(false);
    expect(service.changesFailureCause.value).toBeUndefined();
    expect(service.visibleChanges.value[0]?.path).toBe('recovered.txt');
    expect(request).toHaveBeenCalledOnce();
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

  it('applies new history refs only after the replacement page succeeds', async () => {
    let pending = deferred<unknown>();
    let started = deferred<void>();
    const { service } = createGitHarness(async (path) => {
      const url = requestUrl(path);
      const repository = url.searchParams.get('repositoryPath');
      if (url.pathname.endsWith('/git/fetch')) return {};
      if (url.pathname.endsWith('/git/refs'))
        return { refs: [historyRef(repository === 'old' ? 'refs/heads/old' : 'refs/heads/new')] };
      if (repository === 'old')
        return { commits: [historyCommit('old')], nextCursor: 'old-cursor' };
      started.resolve();
      return pending.promise;
    });
    await service.selectHistory('old', ['refs/heads/old']);
    const oldRefs = service.historyRefs.value;
    const loading = service.selectHistory('new', ['refs/heads/missing']);
    await started.promise;
    expect(service.historyRefs.value).toBe(oldRefs);
    expect(service.selectedHistoryRefs.value).toEqual(['refs/heads/missing']);
    expect(service.historyCommits.value.map((commit) => commit.hash)).toEqual(['old']);
    pending.reject(new Error('History unavailable'));
    await loading;
    expect(service.historyRefs.value).toBe(oldRefs);
    expect(service.historySource.value).toEqual({
      repositoryPath: 'old',
      refs: ['refs/heads/old']
    });
    expect(service.historyNextCursor.value).toBe('old-cursor');

    pending = deferred<unknown>();
    started = deferred<void>();
    const retry = service.loadHistory(true, true);
    await started.promise;
    expect(service.historyRefs.value).toBe(oldRefs);
    pending.resolve({ commits: [historyCommit('new')], nextCursor: null });
    await retry;
    expect(service.historyRefs.value.map((entry) => entry.name)).toEqual(['refs/heads/new']);
    expect(service.selectedHistoryRefs.value).toEqual([]);
    expect(service.historySource.value).toEqual({ repositoryPath: 'new', refs: [] });
    expect(service.historyCommits.value.map((commit) => commit.hash)).toEqual(['new']);
  });

  it('uses the next history cursor and deduplicates commits across pages', async () => {
    let historyPage = 0;
    const { service, request } = createGitHarness(async (path) => {
      const url = requestUrl(path);
      if (url.pathname.endsWith('/git/fetch')) return { fetchFailed: false };
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
      const [oldPath, oldInit] = request.mock.calls[0]!;
      expect(requestUrl(oldPath).searchParams.get('nodeId')).toBe('node-1');
      expect(JSON.parse(oldInit!.body as string)).toMatchObject({
        nodeId: 'node-1',
        path: 'same.txt',
        repositoryPath: 'sub',
        worktreePath: '/temporary/a'
      });
      const b = { nodeId: 'node-2', workspaceId: 'workspace-1' };
      setTarget(b);
      service.restore({ changes: { changes: [] } });
      const bEntry = { ...entry, repositoryPath: '', worktreePath: '/temporary/b' };
      const newRestore = service.restoreChange(bEntry);
      const oldError = new Error('OLD_RESTORE_FAILED');
      if (outcome === 'success') old.resolve({ restored: true });
      else old.reject(oldError);
      await expect(oldRestore).resolves.toBe(outcome === 'success');
      if (outcome === 'success') expect(onFailure).not.toHaveBeenCalled();
      else expect(onFailure).toHaveBeenCalledExactlyOnceWith(oldError, 'RESTORE');
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
      expect(onFailure).toHaveBeenCalledTimes(outcome === 'failure' ? 1 : 0);
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
  it.each(['refresh', 'branch'] as const)(
    'keeps old commit files loading without inventing a failure when %s fails',
    async (operation) => {
      const pendingFiles = deferred<unknown>();
      const commit = historyCommit('old-commit');
      let histories = 0;
      const { service, onFailure } = createGitHarness(async (path) => {
        const url = requestUrl(path);
        if (url.pathname.endsWith('/git/refs'))
          return { refs: [historyRef('main'), historyRef('other')] };
        if (url.pathname.endsWith('/git/history')) {
          if (++histories > 1) throw new Error('HISTORY_FAILED');
          return { commits: [commit], nextCursor: null };
        }
        if (url.pathname.endsWith('/git/commits/old-commit/files')) return pendingFiles.promise;
        throw new Error(`Unexpected request: ${path}`);
      });
      await service.selectHistory('', ['main']);
      const files = service.loadHistoryFiles(commit);
      const next =
        operation === 'refresh' ? service.loadHistory(true) : service.selectHistory('', ['other']);
      expect(service.historyFilesLoading.value).toEqual(['old-commit']);
      expect(service.historyFilesErrors.value).toEqual([]);
      await next;
      expect(service.historyCommits.value).toEqual([commit]);
      expect(service.historyFilesErrors.value).toEqual([]);
      expect(service.historyFilesLoading.value).toEqual(['old-commit']);
      pendingFiles.resolve({ files: [historyFile('still-readable.txt')] });
      await expect(files).resolves.toBe(true);
      expect(service.historyFiles.value['old-commit']).toEqual([historyFile('still-readable.txt')]);
      expect(service.historyFilesErrors.value).toEqual([]);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure).toHaveBeenCalledWith(expect.any(Error), 'HISTORY');
    }
  );
  it('ignores an old commit-file result after a replacement history page succeeds', async () => {
    const pendingFiles = deferred<unknown>();
    const old = historyCommit('old');
    const next = historyCommit('new');
    let histories = 0;
    const { service, onFailure } = createGitHarness(async (path) => {
      const url = requestUrl(path);
      if (url.pathname.endsWith('/git/refs')) return { refs: [] };
      if (url.pathname.endsWith('/git/history'))
        return { commits: [++histories === 1 ? old : next], nextCursor: null };
      if (url.pathname.endsWith('/git/commits/old/files')) return pendingFiles.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    await service.loadHistory(true);
    const files = service.loadHistoryFiles(old);
    await service.loadHistory(true);
    pendingFiles.resolve({ files: [historyFile('stale.txt')] });
    await expect(files).resolves.toBe(false);
    expect(service.historyCommits.value).toEqual([next]);
    expect(service.historyFiles.value).toEqual({});
    expect(service.historyFilesErrors.value).toEqual([]);
    expect(onFailure).not.toHaveBeenCalled();
  });
  it('keeps the history cursor and files on failed reads and retries their actual operations', async () => {
    let historyCalls = 0;
    let fileCalls = 0;
    const first = historyCommit('a'.repeat(40));
    const second = historyCommit('b'.repeat(40));
    const { service, request } = createGitHarness(async (path) => {
      const url = requestUrl(path);
      if (url.pathname.endsWith('/git/refs')) return { refs: [] };
      if (url.pathname.endsWith('/git/history')) {
        historyCalls++;
        if (historyCalls === 1) return { commits: [first], nextCursor: 'cursor-1' };
        if (historyCalls === 2) throw new Error('offline');
        return { commits: [second], nextCursor: null };
      }
      if (url.pathname.endsWith('/files')) {
        if (++fileCalls === 1) throw new Error('offline');
        return { files: [historyFile('a.ts')] };
      }
      return { changes: [] };
    });
    await service.loadHistory(true);
    await service.loadHistory(false);
    expect(service.historyError.value).toEqual({ resetPage: false, fetch: false });
    expect(service.historyCommits.value).toEqual([first]);
    expect(service.historyNextCursor.value).toBe('cursor-1');
    await service.loadHistory(false);
    expect(service.historyError.value).toBeUndefined();
    expect(service.historyCommits.value).toEqual([first, second]);
    const historyRequests = request.mock.calls
      .map(([path]) => requestUrl(path))
      .filter((url) => url.pathname.endsWith('/git/history'));
    expect(historyRequests.slice(1).map((url) => url.searchParams.get('cursor'))).toEqual([
      'cursor-1',
      'cursor-1'
    ]);
    await service.loadHistoryFiles(first);
    expect(service.historyFilesErrors.value).toEqual([first.hash]);
    await service.loadHistoryFiles(first);
    expect(service.historyFilesErrors.value).toEqual([]);
    expect(service.historyFiles.value[first.hash]).toEqual([historyFile('a.ts')]);
  });
});
