import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/util/api-error.js';
import {
  createWorkspaceFileTreeService,
  workspaceFileTreeWindow,
  matchesWorkspaceDisplayFilter,
  visibleWorkspaceFileTreeRows,
  type WorkspaceFileTreePage
} from '../../src/service/workspace-file-tree-service.js';

describe('Workspace file tree state', () => {
  it('reports a current permission failure during reveal without reporting stale failures', async () => {
    const failure = new ApiError('PERMISSION_DENIED', 'Access denied');
    let rejectRead: (reason: unknown) => void = () => {};
    const tree = createWorkspaceFileTreeService({
      workspaceName: () => 'project',
      list: () => new Promise((_resolve, reject) => (rejectRead = reject))
    });
    const current = tree.reveal('file.txt');
    rejectRead(failure);
    await expect(current).rejects.toBe(failure);

    tree.reset();
    const stale = tree.reveal('file.txt');
    tree.reset();
    rejectRead(failure);
    await expect(stale).resolves.toBeUndefined();
  });

  it.each(['reset', 'restore'] as const)(
    'does not report an old nested permission failure after %s during retry',
    async (replacement) => {
      const failure = new ApiError('PERMISSION_DENIED', 'Access denied');
      let rejectRead: (reason: unknown) => void = () => {};
      let attempts = 0;
      const tree = createWorkspaceFileTreeService({
        workspaceName: () => 'project',
        list: async (path) => {
          if (path === '.') return { entries: [directory('src')], nextCursor: null };
          attempts += 1;
          if (attempts === 1) throw failure;
          return new Promise((_resolve, reject) => (rejectRead = reject));
        }
      });
      await expect(tree.reveal('src/file.txt')).rejects.toBe(failure);
      const saved = tree.snapshot();
      const retry = tree.reveal('src/file.txt');
      await vi.waitFor(() => expect(attempts).toBe(2));
      if (replacement === 'reset') tree.reset();
      else tree.restore(saved);
      rejectRead(failure);
      await expect(retry).resolves.toBeUndefined();
    }
  );

  it('clears the previous refresh failure when restoring a cached tree', async () => {
    const tree = createWorkspaceFileTreeService({
      workspaceName: () => 'project',
      list: vi.fn().mockRejectedValue(new Error('offline'))
    });
    tree.applyRootPage({ entries: [file('ready.ts')], nextCursor: null });
    const snapshot = tree.snapshot();
    await tree.refresh();
    expect(tree.refreshError.value?.cause).toBeInstanceOf(Error);

    tree.restore(snapshot);

    expect(tree.refreshError.value).toBeUndefined();
    expect(tree.root.value.children.map((node) => node.path)).toEqual(['ready.ts']);
  });

  it('clears a failed initial root read when a Watch snapshot succeeds', async () => {
    const list = vi.fn().mockRejectedValue(new Error('offline'));
    const tree = createWorkspaceFileTreeService({ workspaceName: () => 'project', list });
    await tree.reveal('ready.ts');
    expect(tree.root.value.failedAppend).toBe(false);
    expect(tree.root.value.failure).toBeDefined();

    tree.applyRootPage({ entries: [file('ready.ts')], nextCursor: null });

    expect(tree.root.value.failedAppend).toBeUndefined();
    expect(tree.root.value.failure).toBeUndefined();
    expect(tree.root.value.loaded).toBe(true);
    expect(visibleWorkspaceFileTreeRows(tree.root.value, '').filter((row) => row.loadMore)).toEqual(
      []
    );
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('clears the root page failure but preserves unresolved child failures after a Watch snapshot', async () => {
    const list = vi.fn().mockRejectedValue(new Error('offline'));
    const tree = createWorkspaceFileTreeService({ workspaceName: () => 'project', list });
    tree.applyRootPage({ entries: [directory('src'), file('first.ts')], nextCursor: 'next' });
    const child = tree.root.value.children.find((node) => node.path === 'src')!;
    await tree.toggle(child);
    await tree.loadMore(tree.root.value);
    expect(child.failedAppend).toBe(false);
    expect(tree.root.value.failedAppend).toBe(true);

    tree.applyRootPage({ entries: [directory('src'), file('ready.ts')], nextCursor: null });

    expect(tree.root.value.failedAppend).toBeUndefined();
    expect(tree.root.value.failure).toBeUndefined();
    expect(child.failedAppend).toBe(false);
    expect(child.failure).toBeDefined();
    expect(
      visibleWorkspaceFileTreeRows(tree.root.value, '')
        .filter((row) => row.loadMore)
        .map((row) => row.node.path)
    ).toEqual(['src']);
  });

  it.each([false, true])(
    'isolates a root read replaced by a Watch snapshot (late failure=%s)',
    async (fails) => {
      let releaseOld!: () => void;
      let releaseNew!: () => void;
      const oldGate = new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
      const newGate = new Promise<void>((resolve) => {
        releaseNew = resolve;
      });
      const list = vi.fn(async (_path: string, cursor?: string): Promise<WorkspaceFileTreePage> => {
        if (cursor === 'old') {
          await oldGate;
          if (fails) throw new Error('offline');
          return { entries: [file('stale.ts')], nextCursor: 'stale' };
        }
        await newGate;
        return { entries: [file('new-page.ts')], nextCursor: null };
      });
      const tree = createWorkspaceFileTreeService({ workspaceName: () => 'project', list });
      tree.applyRootPage({ entries: [file('first.ts')], nextCursor: 'old' });
      const oldRead = tree.loadMore(tree.root.value);
      tree.applyRootPage({ entries: [file('current.ts')], nextCursor: 'current' });
      const newRead = tree.loadMore(tree.root.value);
      const newRequestStarted = list.mock.calls.some(([, cursor]) => cursor === 'current');

      releaseOld();
      await oldRead;
      const loadingAfterOldRead = tree.root.value.loading;
      releaseNew();
      await newRead;

      expect(newRequestStarted).toBe(true);
      expect(loadingAfterOldRead).toBe(true);
      expect(tree.root.value.failedAppend).toBeUndefined();
      expect(tree.root.value.failure).toBeUndefined();
      expect(tree.root.value.nextCursor).toBeNull();
      expect(tree.root.value.children.map((node) => node.path)).not.toContain('stale.ts');
      expect(tree.root.value.children.map((node) => node.path)).toContain('new-page.ts');
      expect(tree.root.value.loading).toBe(false);
    }
  );

  it.each([false, true])(
    'continues reveal after a Watch snapshot replaces its root read (fails=%s)',
    async (fails) => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const list = vi.fn(async (path: string) => {
        if (path === '.') {
          await pending;
          if (fails) throw new Error('old failure');
          return { entries: [file('stale.ts')], nextCursor: null };
        }
        return { entries: [file('src/ready.ts')], nextCursor: null };
      });
      const tree = createWorkspaceFileTreeService({ workspaceName: () => 'project', list });
      const reveal = tree.reveal('src/ready.ts');
      tree.applyRootPage({ entries: [directory('src')], nextCursor: null });
      release();
      await reveal;
      const child = tree.root.value.children.find((node) => node.path === 'src')!;
      expect(child.loaded).toBe(true);
      expect(child.expanded).toBe(true);
      expect(child.children.map((node) => node.path)).toEqual(['src/ready.ts']);
      expect(list).toHaveBeenCalledTimes(2);
      expect(tree.root.value.failedAppend).toBeUndefined();
    }
  );

  it('retains a directory page and cursor after failure and retries the same cursor', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        entries: [file('later.ts')],
        nextCursor: null
      });
    const tree = createWorkspaceFileTreeService({ workspaceName: () => 'project', list });
    tree.applyRootPage({ entries: [file('first.ts')], nextCursor: 'next' });
    await tree.loadMore(tree.root.value);
    expect(tree.root.value.failedAppend).toBe(true);
    expect(tree.root.value.children.map((node) => node.path)).toEqual(['first.ts']);
    expect(tree.root.value.nextCursor).toBe('next');
    await tree.loadMore(tree.root.value);
    expect(list.mock.calls).toEqual([
      ['.', 'next'],
      ['.', 'next']
    ]);
    expect(tree.root.value.failedAppend).toBeUndefined();
    expect(tree.root.value.children.map((node) => node.path)).toEqual(['first.ts', 'later.ts']);
  });
  it.each([false, true])(
    'ignores attachment resources without changing the tree (loaded=%s)',
    async (loaded) => {
      const list = vi.fn(async (): Promise<WorkspaceFileTreePage> => ({
        entries: [],
        nextCursor: null
      }));
      const tree = createWorkspaceFileTreeService({ workspaceName: () => 'project', list });
      if (loaded) {
        tree.applyRootPage({ entries: [file('inside.ts')], nextCursor: null });
        tree.selectPath('inside.ts');
      }
      const initial = tree.snapshot();
      for (const name of ['image.png', '原图 with spaces.jpg']) {
        const path = `mar-attachment://00000000-0000-4000-8000-000000000001/${name}`;
        await tree.reveal(path);
        tree.selectPath(path);
      }
      expect(list).not.toHaveBeenCalled();
      expect(tree.snapshot()).toEqual(initial);
    }
  );
  it('projects only visible rows and the buffer while clamping scroll positions', () => {
    expect(workspaceFileTreeWindow(1_000, 2_400, 480, 24, 8)).toEqual({
      start: 92,
      end: 128,
      offset: 2_208,
      totalHeight: 24_000
    });
    expect(workspaceFileTreeWindow(10, 10_000, 480, 24, 8)).toEqual({
      start: 0,
      end: 10,
      offset: 0,
      totalHeight: 240
    });
  });
  it('filters loaded files and directories by name or path while keeping ancestors of matches', () => {
    const root = {
      ...directory('.'),
      name: 'project',
      expanded: true,
      loaded: true,
      loading: false,
      nextCursor: 'root-next',
      placeholder: false,
      children: [
        {
          ...directory('docs'),
          expanded: true,
          loaded: true,
          loading: false,
          nextCursor: null,
          placeholder: false,
          children: [
            {
              ...file('docs/Guide.MD'),
              expanded: false,
              loaded: false,
              loading: false,
              nextCursor: null,
              placeholder: false,
              children: []
            }
          ]
        },
        {
          ...file('package.json'),
          expanded: false,
          loaded: false,
          loading: false,
          nextCursor: null,
          placeholder: false,
          children: []
        }
      ]
    };

    expect(matchesWorkspaceDisplayFilter('Guide.MD', 'guide')).toBe(true);
    expect(matchesWorkspaceDisplayFilter('package.json', 'GUIDE')).toBe(false);
    expect(
      visibleWorkspaceFileTreeRows(root, 'guide').map((row) => [row.node.path, row.loadMore])
    ).toEqual([
      ['.', false],
      ['docs', false],
      ['docs/Guide.MD', false],
      ['.', true]
    ]);
    expect(
      visibleWorkspaceFileTreeRows(root, '').map((row) => [row.node.path, row.loadMore])
    ).toEqual([
      ['.', false],
      ['docs', false],
      ['docs/Guide.MD', false],
      ['package.json', false],
      ['.', true]
    ]);
  });

  it('loads directories lazily with independent pagination and keeps directories before files', async () => {
    const list = vi.fn(async (path: string, cursor?: string): Promise<WorkspaceFileTreePage> => {
      if (path === '.')
        return {
          entries: [file('z.ts'), directory('src')],
          nextCursor: 'root-next'
        };
      if (path === 'src' && cursor === undefined)
        return { entries: [file('src/b.ts')], nextCursor: 'src-next' };
      return { entries: [file('src/c.ts')], nextCursor: null };
    });
    const tree = createWorkspaceFileTreeService({ workspaceName: () => 'project', list });

    await tree.refresh();
    expect(tree.root.value.children.map((node) => node.path)).toEqual(['src', 'z.ts']);
    const src = tree.root.value.children[0]!;
    await tree.toggle(src);
    await tree.loadMore(src);

    expect(list).toHaveBeenCalledWith('src', 'src-next');
    expect(src.children.map((node) => node.path)).toEqual(['src/b.ts', 'src/c.ts']);
    expect(tree.root.value.nextCursor).toBe('root-next');
  });

  it('initializes the root directory directly from the first Workspace Watch page without the legacy HTTP initial read', () => {
    const list = vi.fn<() => Promise<WorkspaceFileTreePage>>();
    const tree = createWorkspaceFileTreeService({ workspaceName: () => 'project', list });

    tree.reset();
    tree.applyRootPage({ entries: [file('README.md'), directory('src')], nextCursor: null });

    expect(list).not.toHaveBeenCalled();
    expect(tree.root.value.loaded).toBe(true);
    expect(tree.root.value.children.map((node) => node.path)).toEqual(['src', 'README.md']);
  });

  it('constructs and expands ancestors for quick reveal, then selects a file by path', async () => {
    const list = vi.fn(async (path: string): Promise<WorkspaceFileTreePage> => {
      if (path === '.') return { entries: [directory('docs')], nextCursor: null };
      if (path === 'docs') return { entries: [directory('docs/deep')], nextCursor: null };
      return { entries: [], nextCursor: null };
    });
    const tree = createWorkspaceFileTreeService({ workspaceName: () => 'project', list });
    await tree.refresh();
    tree.select(tree.root.value);

    await tree.reveal('docs/deep/very-long-name.ts');
    tree.selectPath('docs/deep/very-long-name.ts');

    const docs = tree.root.value.children[0]!;
    const deep = docs.children[0]!;
    expect(docs.expanded).toBe(true);
    expect(deep.expanded).toBe(true);
    expect(deep.children.map((node) => node.path)).toContain('docs/deep/very-long-name.ts');
    expect(tree.selectedPath.value).toBe('docs/deep/very-long-name.ts');
  });

  it.each(['.', 'docs', 'docs/deep'])(
    'stops revealing descendants when %s fails and allows a later retry',
    async (failedPath) => {
      let failing = true;
      const list = vi.fn(async (path: string): Promise<WorkspaceFileTreePage> => {
        if (failing && path === failedPath) throw new Error('FILE_NOT_FOUND');
        return { entries: [], nextCursor: null };
      });
      const tree = createWorkspaceFileTreeService({ workspaceName: () => 'project', list });
      const target = 'docs/deep/nested/result.md';
      const directories = ['.', 'docs', 'docs/deep', 'docs/deep/nested'];
      const failedIndex = directories.indexOf(failedPath);

      await tree.reveal(target);

      expect(list.mock.calls.map(([path]) => path)).toEqual(directories.slice(0, failedIndex + 1));
      let failedNode = tree.root.value;
      for (const path of directories.slice(1, failedIndex + 1)) {
        failedNode = failedNode.children.find((node) => node.path === path)!;
      }
      expect(failedNode.loaded).toBe(false);
      expect(failedNode.loading).toBe(false);
      expect(failedNode.children).toEqual([]);
      tree.selectPath(target);
      expect(tree.selectedPath.value).toBeUndefined();

      failing = false;
      list.mockClear();
      await tree.reveal(target);
      expect(list.mock.calls.map(([path]) => path)).toEqual(directories.slice(failedIndex));
      tree.selectPath(target);
      expect(tree.selectedPath.value).toBe(target);
    }
  );

  it.each([
    ['.', false],
    ['docs', false],
    ['.', true],
    ['docs', true]
  ] as const)(
    'shares an in-flight reveal for %s without treating loading as failure (fails=%s)',
    async (pendingPath, fails) => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const list = vi.fn(async (path: string): Promise<WorkspaceFileTreePage> => {
        if (path === pendingPath) {
          await pending;
          if (fails) throw new Error('FILE_NOT_FOUND');
        }
        return { entries: [], nextCursor: null };
      });
      const tree = createWorkspaceFileTreeService({ workspaceName: () => 'project', list });
      if (pendingPath === 'docs') tree.applyRootPage({ entries: [], nextCursor: null });
      let firstNeeded = true;
      const first = tree.reveal('docs/first.md', () => firstNeeded);
      await vi.waitFor(() => expect(list).toHaveBeenCalledWith(pendingPath, undefined));
      firstNeeded = false;
      const second = tree.reveal('docs/deep/second.md');
      release();
      await Promise.all([first, second]);
      expect(list.mock.calls.filter(([path]) => path === pendingPath)).toHaveLength(1);
      tree.selectPath('docs/deep/second.md');
      if (fails) {
        expect(list).toHaveBeenCalledTimes(1);
        expect(tree.selectedPath.value).toBeUndefined();
      } else {
        expect(tree.selectedPath.value).toBe('docs/deep/second.md');
      }
    }
  );

  it('does not reveal external absolute or escaping paths in the workspace tree', async () => {
    const list = vi.fn(async (): Promise<WorkspaceFileTreePage> => ({
      entries: [file('inside.ts')],
      nextCursor: null
    }));
    const tree = createWorkspaceFileTreeService({ workspaceName: () => 'project', list });
    await tree.refresh();
    tree.selectPath('inside.ts');

    for (const path of [
      '/home/ubuntu/other/tools/build.sh',
      'C:\\Users\\other\\build.sh',
      '\\\\server\\share\\build.sh',
      '../other/build.sh',
      'src/../../other/build.sh'
    ]) {
      await tree.reveal(path);
      tree.selectPath(path);
    }

    expect(list).toHaveBeenCalledTimes(1);
    expect(tree.root.value.children.map((node) => node.path)).toEqual(['inside.ts']);
    expect(tree.selectedPath.value).toBe('inside.ts');
  });

  it('restores expanded, paginated, and manually selected state from a snapshot', async () => {
    const list = vi.fn(async (): Promise<WorkspaceFileTreePage> => ({
      entries: [directory('src')],
      nextCursor: null
    }));
    const source = createWorkspaceFileTreeService({ workspaceName: () => 'project', list });
    await source.refresh();
    const src = source.root.value.children[0]!;
    await source.toggle(src);
    source.select(src);
    source.applyRootPage({
      entries: [directory('src'), file('README.md')],
      nextCursor: null
    });

    const restored = createWorkspaceFileTreeService({ workspaceName: () => 'project', list });
    const snapshot = source.snapshot();
    source.root.value.children[0]!.name = 'changed-after-snapshot';
    restored.restore(snapshot);

    expect(restored.root.value.children[0]).toMatchObject({
      path: 'src',
      name: 'src',
      expanded: true
    });
    expect(restored.selectedPath.value).toBe('src');
  });

  it('preserves loaded page ranges on refresh and clears removed expanded directories and selections', async () => {
    let refreshed = false;
    const list = vi.fn(async (path: string, cursor?: string): Promise<WorkspaceFileTreePage> => {
      if (path === '.') {
        if (refreshed) return { entries: [file('a.ts')], nextCursor: null };
        return cursor === undefined
          ? { entries: [file('a.ts')], nextCursor: 'next' }
          : { entries: [directory('removed')], nextCursor: null };
      }
      return { entries: [], nextCursor: null };
    });
    const tree = createWorkspaceFileTreeService({ workspaceName: () => 'project', list });
    await tree.refresh();
    await tree.loadMore(tree.root.value);
    const removed = tree.root.value.children.find((node) => node.path === 'removed')!;
    await tree.toggle(removed);
    tree.select(removed);

    refreshed = true;
    await tree.refresh();

    expect(tree.root.value.children.map((node) => node.path)).toEqual(['a.ts']);
    expect(tree.selectedPath.value).toBeUndefined();
  });

  it('keeps the current file tree until refresh completes, then replaces it atomically', async () => {
    let refreshStarted = false;
    let releaseRefresh!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const list = vi.fn(async (): Promise<WorkspaceFileTreePage> => {
      if (!refreshStarted) return { entries: [file('before.ts')], nextCursor: null };
      await refreshBlocked;
      return { entries: [file('after.ts')], nextCursor: null };
    });
    const tree = createWorkspaceFileTreeService({ workspaceName: () => 'project', list });
    await tree.refresh();

    refreshStarted = true;
    const refreshing = tree.refresh();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    expect(tree.root.value.children.map((node) => node.path)).toEqual(['before.ts']);

    releaseRefresh();
    await refreshing;
    expect(tree.root.value.children.map((node) => node.path)).toEqual(['after.ts']);
  });

  it('keeps the current file tree when refresh fails', async () => {
    let failRefresh = false;
    const list = vi.fn(async (): Promise<WorkspaceFileTreePage> => {
      if (failRefresh) throw new Error('FILES_REFRESH_FAILED');
      return { entries: [file('before.ts')], nextCursor: null };
    });
    const tree = createWorkspaceFileTreeService({ workspaceName: () => 'project', list });
    await tree.refresh();

    failRefresh = true;
    await tree.refresh();

    expect(tree.root.value.children.map((node) => node.path)).toEqual(['before.ts']);
  });

  it('does not commit a refresh when root metadata succeeds but an expanded directory fails', async () => {
    let failExpandedDirectory = false;
    const list = vi.fn(async (path: string): Promise<WorkspaceFileTreePage> => {
      if (path === '.')
        return {
          entries: [directory('src')],
          nextCursor: null,
          workspace: {
            id: 'workspace-1',
            path: '/project',
            kind: 'GIT_WORKSPACE',
            gitSummary: { branch: 'main' }
          }
        };
      if (failExpandedDirectory) throw new Error('FILES_REFRESH_FAILED');
      return { entries: [file('src/main.ts')], nextCursor: null };
    });
    const tree = createWorkspaceFileTreeService({ workspaceName: () => 'project', list });
    await tree.refresh();
    await tree.toggle(tree.root.value.children[0]!);

    failExpandedDirectory = true;
    const refreshed = await tree.refresh();

    expect(refreshed).toBeUndefined();
    expect(tree.root.value.children[0]).toMatchObject({
      path: 'src',
      expanded: true,
      children: [expect.objectContaining({ path: 'src/main.ts' })]
    });
  });
});

function directory(path: string) {
  return { path, name: path.split('/').at(-1)!, kind: 'DIRECTORY' as const, size: null };
}

function file(path: string) {
  return { path, name: path.split('/').at(-1)!, kind: 'FILE' as const, size: 1 };
}
