import { effectScope, nextTick, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceFileToolsController } from '../../src/service/workspace-file-tools-controller.js';
import { createWorkspaceFileWorkbenchController } from '../../src/service/workspace-file-workbench-controller.js';
import { createFileAccessFixture } from '../support/file-access-fixture.js';
import type { ScopedHttpService } from '../../src/service/scoped-http-service.js';
import type { WorkspaceDirectFileRange } from '../../src/model/workspace-direct-file.js';

function fixture(request = vi.fn()) {
  const target = ref({ nodeId: 'node', workspaceId: 'one' });
  const visible = ref(true);
  const ready = ref(true);
  const searchReady = ref(true);
  const history = ref(true);
  const tool = ref('changes');
  const scope = effectScope();
  const controller = scope.run(() =>
    createWorkspaceFileToolsController({
      target,
      http: { request } as unknown as ScopedHttpService,
      workspacePath: () => '/workspace',
      workspaceKind: () => 'GIT_WORKSPACE',
      workbench: { invalidateDeletedSelection: vi.fn(), openToolIntent: vi.fn() },
      updateBranch: vi.fn(),
      queueUploads: vi.fn(),
      notice: vi.fn(),
      errorMessage: String,
      cache: () => ({ isActive: () => false, updateSearch: vi.fn(), view: () => ({}) }) as never,
      ready: () => ready.value,
      visible: () => visible.value,
      activeTool: () => tool.value,
      searchReady: () => searchReady.value,
      historySupported: () => history.value,
      isGit: () => true,
      workspace: () => undefined,
      updateWorkspace: vi.fn()
    })
  )!;
  return { scope, controller, target, visible, ready, searchReady, history, tool };
}

it.each([
  ['selected file', 'src/selected.ts', 'src/selected.ts'],
  ['ancestor directory', 'src/nested/selected.ts', 'src']
] as const)(
  'preserves unrelated Git tabs when deleting the %s',
  async (_selection, selectedPath, deletedPath) => {
    const target = ref({ nodeId: 'node', workspaceId: 'one' });
    const parentPath = selectedPath.slice(0, selectedPath.lastIndexOf('/'));
    const parentSegments = parentPath.split('/');
    let deleted = false;
    const request = vi.fn(async (url: string) => {
      if (url.includes('/files?')) {
        const path = new URL(url, 'http://localhost').searchParams.get('path') ?? '.';
        const pathSegments = path === '.' ? [] : path.split('/');
        const files =
          path === parentPath && !deleted
            ? [
                {
                  path: selectedPath,
                  name: selectedPath.split('/').at(-1)!,
                  kind: 'FILE',
                  size: 1
                }
              ]
            : pathSegments.length < parentSegments.length
              ? (() => {
                  const directory = parentSegments.slice(0, pathSegments.length + 1).join('/');
                  return deleted && directory === deletedPath
                    ? []
                    : [
                        {
                          path: directory,
                          name: directory.split('/').at(-1)!,
                          kind: 'DIRECTORY',
                          size: null
                        }
                      ];
                })()
              : [];
        return { files: { entries: files, nextCursor: null } };
      }
      if (url.endsWith('/files/mutate')) deleted = true;
      return {};
    });
    const http = { request } as unknown as ScopedHttpService;
    let finishRead!: (value: WorkspaceDirectFileRange) => void;
    let holdNextRead = false;
    let readSignal: AbortSignal | undefined;
    const pendingRead = new Promise<WorkspaceDirectFileRange>((resolve) => {
      finishRead = resolve;
    });
    const directFileReadRange = vi.fn(
      (
        ...args: [string, number, number, string?, unknown?, string?, AbortSignal?]
      ): Promise<WorkspaceDirectFileRange> => {
        if (holdNextRead) {
          holdNextRead = false;
          readSignal = args[6];
          return pendingRead;
        }
        return Promise.resolve({
          bytes: new Uint8Array([112, 114, 101, 118, 105, 101, 119]),
          size: 7,
          offset: 0,
          nextOffset: null,
          revision: 'r1'
        });
      }
    );
    const workbench = createWorkspaceFileWorkbenchController({
      externalTarget: () => target.value,
      fileWriteEnabled: () => false,
      onPopupBlocked: vi.fn(),
      target: () => target.value,
      page: () => undefined,
      prewarmEnabled: () => false,
      resolveRepositoryPath: () => undefined,
      reveal: async () => {},
      comparison: async () => undefined,
      onOpenFailure: vi.fn(),
      onRevealFailure: vi.fn(),
      access: createFileAccessFixture({
        http,
        transfers: () => ({ directFileReadRange })
      }),
      preview: { onWritten: vi.fn() },
      navigation: { http, onFileTarget: vi.fn(), onFailure: vi.fn() }
    });
    const scope = effectScope();
    const tools = scope.run(() =>
      createWorkspaceFileToolsController({
        target,
        http,
        workspacePath: () => '/workspace',
        workspaceKind: () => 'GIT_WORKSPACE',
        workbench,
        updateBranch: vi.fn(),
        queueUploads: vi.fn(),
        notice: vi.fn(),
        errorMessage: String,
        cache: () => ({ isActive: () => false, updateSearch: vi.fn(), view: () => ({}) }) as never,
        ready: () => true,
        visible: () => true,
        activeTool: () => 'files',
        searchReady: () => true,
        historySupported: () => true,
        isGit: () => true,
        workspace: () => undefined,
        updateWorkspace: vi.fn()
      })
    )!;
    const loadChanges = vi.spyOn(tools.git, 'loadChanges').mockResolvedValue(undefined);
    const worktreeIntent = {
      kind: 'WORKTREE_DIFF' as const,
      ...target.value,
      path: 'other.bin',
      repositoryPath: '/workspace',
      worktreePath: '/workspace'
    };
    const historyIntent = {
      kind: 'HISTORY_DIFF' as const,
      ...target.value,
      path: 'older.bin',
      repositoryPath: '/workspace',
      worktreePath: '',
      commit: 'a'.repeat(40),
      refs: ['main']
    };

    try {
      await tools.files.tree.reveal(selectedPath);
      tools.files.tree.selectPath(selectedPath);
      await workbench.openTab(worktreeIntent);
      await workbench.openTab(historyIntent);
      const gitTabs = [...workbench.tabList.value];
      const historyTab = gitTabs.find((tab) => tab.kind === 'HISTORY_DIFF')!;
      expect(gitTabs.map((tab) => tab.kind)).toEqual(['WORKTREE_DIFF', 'HISTORY_DIFF']);
      await workbench.openFile(selectedPath);
      expect(workbench.frames.value).toHaveLength(1);
      const selectedTab = workbench.tabList.value.find((tab) => tab.path === selectedPath)!;
      workbench.restore({
        dirtyTextDrafts: [
          {
            tabIdentity: selectedTab.identity,
            path: selectedPath,
            content: 'unsaved text',
            expectedRevision: 'r1'
          }
        ]
      });
      expect(workbench.hasDraft(selectedTab.identity)).toBe(true);

      holdNextRead = true;
      const opening = workbench.openFile('other/pending.ts');
      await vi.waitFor(() => expect(readSignal).toBeDefined());
      expect(workbench.frames.value).toHaveLength(2);

      await tools.files.mutate(tools.files.captureTarget()!, 'DELETE', deletedPath);

      expect(request.mock.calls.some(([url]) => url.endsWith('/files/mutate'))).toBe(true);
      expect(readSignal?.aborted).toBe(true);
      expect(workbench.frames.value).toEqual([]);
      expect(workbench.hasDraft(selectedTab.identity)).toBe(false);
      expect(workbench.tabList.value).toEqual(gitTabs);
      expect(
        workbench.tabList.value.map((tab) => [tab.identity, tab.nodeId, tab.workspaceId])
      ).toEqual(gitTabs.map((tab) => [tab.identity, 'node', 'one']));
      expect(loadChanges).toHaveBeenCalledOnce();

      finishRead({
        bytes: new Uint8Array([108, 97, 116, 101, 32, 112, 114, 101, 118, 105, 101, 119]),
        size: 12,
        offset: 0,
        nextOffset: null,
        revision: 'r1'
      });
      await opening;
      expect(workbench.frames.value).toEqual([]);

      await workbench.openTab(worktreeIntent);
      await workbench.openTab(historyIntent);
      expect(workbench.tabList.value).toEqual(gitTabs);
      expect(workbench.activeTab.value?.identity).toBe(historyTab.identity);
    } finally {
      finishRead({
        bytes: new Uint8Array([99, 108, 101, 97, 110, 117, 112]),
        size: 7,
        offset: 0,
        nextOffset: null,
        revision: 'cleanup'
      });
      loadChanges.mockRestore();
      tools.dispose();
      workbench.dispose();
      scope.stop();
    }
  }
);

describe('Workspace file tools surface lifecycle', () => {
  it('loads the visible Git tool once and refreshes on revisions and target changes', async () => {
    const f = fixture();
    const changes = vi.spyOn(f.controller.git, 'loadChanges').mockResolvedValue(undefined);
    const openHistory = vi.spyOn(f.controller.git, 'openHistory').mockResolvedValue(undefined);
    try {
      f.controller.mountSurface();
      expect(changes).toHaveBeenCalledTimes(1);
      f.controller.mountSurface();
      expect(changes).toHaveBeenCalledTimes(1);
      f.controller.invalidate('changes');
      await nextTick();
      expect(changes).toHaveBeenCalledTimes(2);
      f.target.value = { nodeId: 'node', workspaceId: 'two' };
      await nextTick();
      expect(changes).toHaveBeenCalledTimes(3);
      f.tool.value = 'history';
      await nextTick();
      expect(openHistory).toHaveBeenCalledTimes(1);
      f.controller.unmountSurface();
      f.target.value = { nodeId: 'node', workspaceId: 'three' };
      await nextTick();
      expect(openHistory).toHaveBeenCalledTimes(1);
    } finally {
      f.controller.dispose();
      f.scope.stop();
    }
  });

  it('cancels pending search and history when their surface or capability becomes unavailable', () => {
    const f = fixture();
    const cancelSearch = vi.spyOn(f.controller.search, 'cancelPending');
    const cancelHistory = vi.spyOn(f.controller.git, 'cancelHistoryPending');
    vi.spyOn(f.controller.git, 'loadChanges').mockResolvedValue(undefined);
    vi.spyOn(f.controller.git, 'openHistory').mockResolvedValue(undefined);
    try {
      f.tool.value = 'search';
      f.controller.mountSurface();
      f.searchReady.value = false;
      expect(cancelSearch).toHaveBeenCalledOnce();
      f.tool.value = 'history';
      f.history.value = false;
      expect(cancelHistory).toHaveBeenCalledOnce();
    } finally {
      f.controller.dispose();
      f.scope.stop();
    }
  });

  it('stops automatic loads when disposed before its surface unmounts', async () => {
    const f = fixture();
    const changes = vi.spyOn(f.controller.git, 'loadChanges').mockResolvedValue(undefined);
    try {
      f.controller.mountSurface();
      expect(changes).toHaveBeenCalledTimes(1);
      f.controller.dispose();
      f.controller.invalidate('changes');
      f.target.value = { nodeId: 'node', workspaceId: 'two' };
      await nextTick();
      expect(changes).toHaveBeenCalledTimes(1);
    } finally {
      f.controller.dispose();
      f.scope.stop();
    }
  });

  it('ignores a late search result after the tool is hidden', async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => {
      resolve = done;
    });
    const f = fixture(vi.fn(() => pending));
    try {
      f.tool.value = 'search';
      f.controller.mountSurface();
      const search = f.controller.search.search({
        ...f.target.value,
        query: 'old',
        useRegex: false
      });
      expect(f.controller.search.loading.value).toBe(true);
      f.visible.value = false;
      expect(f.controller.search.loading.value).toBe(false);
      resolve({
        search: {
          matches: [{ path: 'old.txt', line: 1, column: 1, preview: 'old' }],
          truncated: false
        }
      });
      await search;
      expect(f.controller.search.matches.value).toEqual([]);
      expect(f.controller.search.error.value).toBeUndefined();
    } finally {
      f.controller.dispose();
      f.scope.stop();
    }
  });
});
