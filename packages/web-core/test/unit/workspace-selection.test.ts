import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import type {
  NodeWorkbenchManifest,
  Session,
  Workspace,
  WorkspaceTarget
} from '../../src/model/workbench.js';
import { createWorkbenchWorkspaceSelectionService } from '../../src/service/workbench-workspace-selection-service.js';
import { createWorkspaceViewCacheService } from '../../src/service/workspace-view-cache-service.js';
import { ApiError } from '../../src/util/api-error.js';

const target = (nodeId = 'node-1', workspaceId = 'workspace-1'): WorkspaceTarget => ({
  nodeId,
  workspaceId
});
const workspace = (id: string): Workspace => ({ id, path: `/tmp/${id}`, kind: 'DIRECTORY' });
function fixture() {
  const workspaceTarget = ref<WorkspaceTarget>();
  const selectedSessionId = ref<string>();
  const selectedRunId = ref<string>();
  const cache = createWorkspaceViewCacheService(
    (nodeId, workspaceId) => `${nodeId}:${workspaceId}`
  );
  const cached = new Map<string, readonly Workspace[]>([
    ['node-1', [workspace('workspace-1'), workspace('workspace-2')]],
    ['node-2', [workspace('workspace-3')]]
  ]);
  const sessions = ref<Session[]>([]);
  const workspaces = ref<Workspace[]>([]);
  const draftOpen = ref(false);
  const profilesLoading = ref(false);
  const events: string[] = [];
  const stopWatch = vi.fn(() => {
    events.push('stop');
  });
  const saveCurrent = vi.fn(() => {
    events.push('save');
  });
  const activateCache = vi.fn((nodeId: string, workspaceId: string) => {
    events.push('activate');
    cache.activate(nodeId, workspaceId);
  });
  const restoreInspector = vi.fn(() => {
    events.push('inspector');
  });
  const refreshInspector = vi.fn();
  const restoreDraft = vi.fn(() => {
    events.push('draft');
  });
  const startWatch = vi.fn(async () => {
    events.push('watch');
  });
  const openSession = vi.fn(async (id: string) => {
    events.push('session');
    selectedSessionId.value = id;
  });
  const openDraft = vi.fn(() => {
    events.push('open-draft');
    draftOpen.value = true;
  });
  const restoreSession = vi.fn(async () => undefined);
  const takeRestoredSelection = vi.fn<() => { readonly selectedSessionId?: string } | undefined>(
    () => undefined
  );
  const hasProfiles = vi.fn(() => true);
  const loadProfiles = vi.fn(async () => undefined);
  const refreshManifest = vi.fn(async () => undefined);
  const restoreManifest = vi.fn<() => NodeWorkbenchManifest | undefined>(() => undefined);
  const refreshTransport = vi.fn();
  const isHostAvailable = vi.fn(() => true);
  const hasNode = vi.fn(() => true);
  const clearContent = vi.fn();
  const cacheWorkspaces = vi.fn((nodeId: string, values: readonly Workspace[]) => {
    cached.set(nodeId, values);
  });
  const rememberWorkspace = vi.fn();
  const rememberTarget = vi.fn();
  const request = vi.fn<() => Promise<{ workspaces: Workspace[] }>>(() => new Promise(() => {}));
  const notice = vi.fn();
  const invalidateWorkspace = vi.fn((value: WorkspaceTarget) => {
    cache.remove(value.nodeId, value.workspaceId);
    service.clear();
  });
  const service = createWorkbenchWorkspaceSelectionService({
    workspaceTarget,
    selectedSessionId,
    selectedRunId,
    workspaces,
    sessions,
    draftOpen,
    profilesLoading,
    manifest: ref(),
    manifestLoading: ref(false),
    isCacheActive: cache.isActive,
    hasNode,
    isHostAvailable,
    cachedWorkspaces: (nodeId) => cached.get(nodeId) ?? [],
    cacheWorkspaces,
    rememberWorkspace,
    rememberTarget,
    invalidateWorkspace,
    deactivateCache: cache.deactivate,
    clearContent,
    showWorkbench: vi.fn(),
    closeSidebar: vi.fn(),
    restoreProfiles: vi.fn(),
    restoreManifest,
    refreshManifest,
    refreshTransport,
    request: request as never,
    notice,
    errorMessage: (error) => (error as Error).message,
    stopWatch,
    startWatch,
    saveCurrent,
    activateCache,
    restoreInspector,
    refreshInspector,
    initializePaging: vi.fn(),
    tabId: (nodeId, workspaceId) => `${nodeId}:${workspaceId}`,
    viewCache: cache.view,
    resetQueue: vi.fn(),
    openSession,
    openDraft,
    restoreDraft,
    hasProfiles,
    loadProfiles,
    takeRestoredSelection,
    restoreSession
  });
  return {
    service,
    workspaceTarget,
    selectedSessionId,
    selectedRunId,
    cache,
    cached,
    sessions,
    workspaces,
    draftOpen,
    profilesLoading,
    events,
    stopWatch,
    saveCurrent,
    activateCache,
    restoreInspector,
    refreshInspector,
    restoreDraft,
    startWatch,
    openSession,
    openDraft,
    restoreSession,
    takeRestoredSelection,
    hasProfiles,
    loadProfiles,
    refreshManifest,
    restoreManifest,
    refreshTransport,
    isHostAvailable,
    hasNode,
    clearContent,
    cacheWorkspaces,
    rememberWorkspace,
    rememberTarget,
    request,
    notice,
    invalidateWorkspace
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('Workspace-only foreground selection', () => {
  it.each([target(), target('node-2', 'workspace-3')])(
    'activates $nodeId/$workspaceId without waiting for any request',
    async (value) => {
      const f = fixture();
      f.refreshManifest.mockImplementation(() => new Promise(() => {}));
      f.loadProfiles.mockImplementation(() => new Promise(() => {}));
      const activation = f.service.select(value);
      expect(f.workspaceTarget.value).toEqual(value);
      expect(f.cache.isActive(value.nodeId, value.workspaceId)).toBe(true);
      expect(f.draftOpen.value).toBe(true);
      await expect(activation).resolves.toBe(true);
      expect(f.service.loading.value).toBe(true);
    }
  );

  it('restores cached session, Inspector and draft in the same order for every Workspace', async () => {
    const f = fixture();
    const sessions = [
      { id: 'saved', externalSessionId: 'saved', workspaceId: 'workspace-3' } as Session
    ];
    f.cache.activate('node-2', 'workspace-3');
    f.cache.captureActive({ sessions, selectedSessionId: 'saved', inspector: {} }, 2);
    f.cache.deactivate();
    await f.service.select(target('node-2', 'workspace-3'));
    expect(f.events).toEqual([
      'save',
      'stop',
      'activate',
      'inspector',
      'draft',
      'session',
      'watch'
    ]);
    expect(f.sessions.value).toEqual(sessions);
    expect(f.refreshInspector).toHaveBeenCalledWith('node-2', 'workspace-3');
    expect(f.openSession).toHaveBeenCalledWith('saved', { skipSaveCurrent: true });
  });

  it('activates an uncached target immediately, then starts its Watch after metadata arrives', async () => {
    const f = fixture();
    const pending = deferred<{ workspaces: Workspace[] }>();
    f.request.mockReturnValue(pending.promise);
    await f.service.select(target('node-3', 'uncached'));
    expect(f.workspaceTarget.value).toEqual(target('node-3', 'uncached'));
    expect(f.workspaces.value).toEqual([]);
    expect(f.rememberTarget).toHaveBeenCalledWith(target('node-3', 'uncached'));
    expect(f.startWatch).not.toHaveBeenCalled();
    pending.resolve({ workspaces: [workspace('uncached')] });
    await vi.waitFor(() => expect(f.startWatch).toHaveBeenCalledWith('uncached'));
    expect(f.workspaces.value).toEqual([workspace('uncached')]);
    expect(f.service.loading.value).toBe(false);
  });

  it('retains the activated target and its cache on temporary network failure', async () => {
    const f = fixture();
    const error = new Error('network unavailable');
    f.request.mockRejectedValue(error);
    await f.service.select(target('node-2', 'workspace-3'));
    await vi.waitFor(() =>
      expect(f.notice).toHaveBeenLastCalledWith(
        expect.stringContaining('network unavailable'),
        'error',
        error
      )
    );
    expect(f.workspaceTarget.value).toEqual(target('node-2', 'workspace-3'));
    expect(f.invalidateWorkspace).not.toHaveBeenCalled();
    expect(f.service.loading.value).toBe(false);
  });

  it.each(['FORBIDDEN', 'WORKSPACE_NOT_FOUND', 'REQUEST_FAILED_403', 'REQUEST_FAILED_404'])(
    'invalidates inaccessible content on %s',
    async (code) => {
      const f = fixture();
      f.request.mockRejectedValue(new ApiError(code, 'Unavailable'));
      await f.service.select(target());
      await vi.waitFor(() => expect(f.invalidateWorkspace).toHaveBeenCalledWith(target()));
      expect(f.workspaceTarget.value).toBeUndefined();
      expect(f.cache.hasActive()).toBe(false);
    }
  );

  it('invalidates a Workspace missing from the authoritative list', async () => {
    const f = fixture();
    f.request.mockResolvedValue({ workspaces: [] });
    await f.service.select(target());
    await vi.waitFor(() => expect(f.invalidateWorkspace).toHaveBeenCalledWith(target()));
  });

  it('ignores stale success and failure after a newer Workspace selection', async () => {
    const f = fixture();
    const old = deferred<{ workspaces: Workspace[] }>();
    f.request.mockReturnValueOnce(old.promise);
    await f.service.select(target());
    await f.service.select(target('node-1', 'workspace-2'));
    old.resolve({ workspaces: [] });
    await Promise.resolve();
    expect(f.workspaceTarget.value).toEqual(target('node-1', 'workspace-2'));
    expect(f.invalidateWorkspace).not.toHaveBeenCalled();
    expect(f.cacheWorkspaces).not.toHaveBeenCalled();
  });

  it('rejects first-generation A responses after A to B to A', async () => {
    const f = fixture();
    const first = deferred<{ workspaces: Workspace[] }>();
    const final = deferred<{ workspaces: Workspace[] }>();
    f.request
      .mockReturnValueOnce(first.promise)
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockReturnValueOnce(final.promise);
    await f.service.select(target());
    await f.service.select(target('node-1', 'workspace-2'));
    await f.service.select(target());
    first.reject(new ApiError('FORBIDDEN', 'Stale access failure'));
    await Promise.resolve();
    expect(f.workspaceTarget.value).toEqual(target());
    expect(f.invalidateWorkspace).not.toHaveBeenCalled();
    expect(f.service.loading.value).toBe(true);
    final.resolve({ workspaces: [workspace('workspace-1')] });
    await vi.waitFor(() => expect(f.service.loading.value).toBe(false));
  });

  it('invalidates requests when selection clears without retaining a host context', async () => {
    const f = fixture();
    const pending = deferred<{ workspaces: Workspace[] }>();
    f.request.mockReturnValue(pending.promise);
    await f.service.select(target());
    f.service.clear();
    pending.resolve({ workspaces: [workspace('workspace-1')] });
    await Promise.resolve();
    expect(f.workspaceTarget.value).toBeUndefined();
    expect(f.workspaces.value).toEqual([]);
    expect(f.sessions.value).toEqual([]);
    expect(f.cache.hasActive()).toBe(false);
    expect(f.cacheWorkspaces).not.toHaveBeenCalled();
  });

  it('preserves the current session and draft on reactivation', async () => {
    const f = fixture();
    await f.service.select(target());
    f.sessions.value = [{ id: 'session', workspaceId: 'workspace-1' } as Session];
    f.selectedSessionId.value = 'session';
    f.draftOpen.value = false;
    f.openDraft.mockClear();
    f.restoreDraft.mockClear();
    f.activateCache.mockClear();
    await f.service.select(target());
    expect(f.openDraft).not.toHaveBeenCalled();
    expect(f.restoreDraft).not.toHaveBeenCalled();
    expect(f.activateCache).not.toHaveBeenCalled();
    expect(f.selectedSessionId.value).toBe('session');
    expect(f.draftOpen.value).toBe(false);
  });

  it('restores persisted session ownership after opening a draft without waiting to activate', async () => {
    const f = fixture();
    f.takeRestoredSelection.mockReturnValue({ selectedSessionId: 'saved' });
    await f.service.select(target());
    expect(f.openDraft).toHaveBeenCalledOnce();
    expect(f.restoreSession).toHaveBeenCalledWith('workspace-1', 'saved');
  });

  it('activates an offline Workspace immediately without requests, then restores its cache after reconnection', async () => {
    const f = fixture();
    f.isHostAvailable.mockReturnValue(false);
    const sessions = [
      { id: 'saved', externalSessionId: 'saved', workspaceId: 'workspace-3' } as Session
    ];
    f.cache.activate('node-2', 'workspace-3');
    f.cache.captureActive({ sessions }, 2);
    f.cache.deactivate();
    await f.service.select(target('node-2', 'workspace-3'));
    expect(f.workspaceTarget.value).toEqual(target('node-2', 'workspace-3'));
    expect(f.request).not.toHaveBeenCalled();
    expect(f.startWatch).not.toHaveBeenCalled();
    expect(f.sessions.value).toEqual([]);
    f.isHostAvailable.mockReturnValue(true);
    await f.service.select(target('node-2', 'workspace-3'));
    expect(f.sessions.value).toEqual(sessions);
    expect(f.activateCache).toHaveBeenCalledWith('node-2', 'workspace-3');
    expect(f.startWatch).toHaveBeenCalledWith('workspace-3');
  });

  it('removes a target whose execution host is absent', async () => {
    const f = fixture();
    f.hasNode.mockReturnValue(false);
    await expect(f.service.select(target())).resolves.toBe(false);
    expect(f.invalidateWorkspace).toHaveBeenCalledWith(target());
    expect(f.request).not.toHaveBeenCalled();
  });
});
