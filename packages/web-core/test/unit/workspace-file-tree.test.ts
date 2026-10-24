import { describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceFileTreeService,
  workspaceFileTreeWindow,
  matchesWorkspaceDisplayFilter,
  visibleWorkspaceFileTreeRows,
  type WorkspaceFileTreePage
} from '../../src/service/workspace-file-tree-service.js';

describe('Workspace file tree state', () => {
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
