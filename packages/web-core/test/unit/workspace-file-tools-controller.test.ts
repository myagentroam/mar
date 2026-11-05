import { effectScope, nextTick, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceFileToolsController } from '../../src/service/workspace-file-tools-controller.js';
import type { ScopedHttpService } from '../../src/service/scoped-http-service.js';

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
