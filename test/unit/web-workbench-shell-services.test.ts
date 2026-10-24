import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchLayoutService } from '../../ee/web/src/service/workbench-layout-service';
import { createWorkbenchRouteService } from '../../ee/web/src/service/workbench-route-service';
import { createSessionSnapshotRefreshService } from '../../ee/web/src/service/session-snapshot-refresh-service';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  };
}

describe('Web Workbench application shell services', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('Restores valid persisted Workspace Tabs up to the limit despite corrupted tab layouts', () => {
    const localStorage = memoryStorage();
    localStorage.setItem(
      'mar.workbench.tabs.v1',
      JSON.stringify([
        { id: 'n:w1', nodeId: 'n', workspaceId: 'w1', label: 'W1', lastActiveAt: 2 },
        { id: 'n:w2', nodeId: 'n', workspaceId: 'w2', label: 'W2', lastActiveAt: 1 },
        { id: 'broken' }
      ])
    );
    const sessionStorage = memoryStorage();
    sessionStorage.setItem('mar.workbench.layout.v1', '{');
    vi.stubGlobal('sessionStorage', sessionStorage);
    vi.stubGlobal('localStorage', localStorage);
    const restoreTabs = vi.fn();
    const restoreTree = vi.fn();
    const service = createWorkbenchLayoutService({
      sidebarCollapsed: { value: false } as never,
      expandedNodeIds: { value: [] } as never,
      nodeOrder: { value: [] } as never,
      workspaceOrderByNode: { value: {} } as never,
      workspaceTabs: { value: [] } as never,
      maxWorkspaceTabs: 1,
      restoreTree,
      restoreTabs
    });

    service.restore();

    expect(restoreTree).toHaveBeenCalledWith([], {}, []);
    expect(restoreTabs).toHaveBeenCalledWith([
      { id: 'n:w1', nodeId: 'n', workspaceId: 'w1', label: 'W1', lastActiveAt: 2 }
    ]);
  });

  it('Restores Workspaces and Sessions in persisted order while ignoring legacy query parameters', async () => {
    const replaceState = vi.fn();
    const storage = memoryStorage();
    storage.setItem(
      'mar.workbench.selection.v1',
      JSON.stringify({ nodeId: 'n1', workspaceId: 'w1', sessionId: 's1' })
    );
    vi.stubGlobal('window', {
      location: {
        search: '?node=n1&workspace=w1&session=s1&view=nodes',
        href: 'http://localhost/?node=n1&workspace=w1&session=s1&view=nodes'
      },
      history: { replaceState }
    });
    vi.stubGlobal('localStorage', storage);
    const workspaceTarget = {
      value: undefined as { nodeId: string; workspaceId: string } | undefined
    };
    const selectedSessionId = { value: undefined as string | undefined };
    const sessions = {
      value: [] as { id: string; workspaceId: string; externalSessionId?: string }[]
    };
    const activateWorkspace = vi.fn(async (target: { nodeId: string; workspaceId: string }) => {
      workspaceTarget.value = target;
      sessions.value = [{ id: 's1', workspaceId: 'w1', externalSessionId: 's1' }];
      return true;
    });
    const synchronizeSessions = vi.fn(async () => undefined);
    const openSession = vi.fn(async (sessionId: string) => {
      selectedSessionId.value = sessionId;
    });
    const service = createWorkbenchRouteService({
      lookupSession: vi.fn(async () => sessions.value[0] as never),
      openDraft: vi.fn(),
      notice: vi.fn(),
      nodes: { value: [{ id: 'n1' }] } as never,
      sessions: sessions as never,
      workspaceTarget: workspaceTarget as never,
      selectedSessionId: selectedSessionId as never,
      view: { value: 'nodes' } as never,
      managementSection: { value: 'users' } as never,
      activateWorkspace,
      synchronizeSessions,
      openSession
    });

    await service.restore();

    expect(activateWorkspace).toHaveBeenCalledWith({ nodeId: 'n1', workspaceId: 'w1' });
    expect(synchronizeSessions).not.toHaveBeenCalled();
    expect(openSession).toHaveBeenCalledWith('s1');
    expect(replaceState).not.toHaveBeenCalled();
    expect(storage.getItem('mar.workbench.selection.v1')).toBe(
      JSON.stringify({ workspace: { nodeId: 'n1', workspaceId: 'w1' }, sessionId: 's1' })
    );
  });

  it('Writes the active hosted conversation to the URL and preserves the reload target', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: {
        search: '?view=conversations&node=node-1&conversation=conversation-1',
        href: 'http://localhost/console?view=conversations&node=node-1&conversation=conversation-1'
      },
      history: { replaceState }
    });
    vi.stubGlobal('localStorage', memoryStorage());
    const selectedHostedNodeId = { value: 'node-1' as string | undefined };
    const selectedHostedConversationId = { value: 'conversation-1' as string | undefined };
    const service = createWorkbenchRouteService({
      lookupSession: vi.fn(async () => undefined),
      openDraft: vi.fn(),
      notice: vi.fn(),
      nodes: { value: [] } as never,
      sessions: { value: [] } as never,
      workspaceTarget: { value: undefined } as never,
      selectedSessionId: { value: undefined } as never,
      selectedHostedNodeId: selectedHostedNodeId as never,
      selectedHostedConversationId: selectedHostedConversationId as never,
      view: { value: 'conversations' } as never,
      managementSection: { value: 'users' } as never,
      activateWorkspace: vi.fn(),
      synchronizeSessions: vi.fn(),
      openSession: vi.fn()
    });

    expect(service.hostedConversationRoute).toEqual({
      nodeId: 'node-1',
      conversationId: 'conversation-1'
    });
    service.sync();
    let route = new URL(String(replaceState.mock.calls.at(-1)?.[2]), 'http://localhost');
    expect(route.searchParams.get('view')).toBe('conversations');
    expect(route.searchParams.get('node')).toBe('node-1');
    expect(route.searchParams.get('conversation')).toBe('conversation-1');

    selectedHostedNodeId.value = undefined;
    selectedHostedConversationId.value = undefined;
    service.sync();
    route = new URL(String(replaceState.mock.calls.at(-1)?.[2]), 'http://localhost');
    expect(route.searchParams.has('node')).toBe(false);
    expect(route.searchParams.has('conversation')).toBe(false);
  });

  it('Restoring an invalid Node clears the active Workspace selection', async () => {
    const storage = memoryStorage();
    storage.setItem(
      'mar.workbench.selection.v1',
      JSON.stringify({ nodeId: 'missing', workspaceId: 'workspace-1', sessionId: 'session-1' })
    );
    vi.stubGlobal('window', {
      location: { search: '', href: 'http://localhost/console' },
      history: { replaceState: vi.fn() }
    });
    vi.stubGlobal('localStorage', storage);
    const activateWorkspace = vi.fn();
    const service = createWorkbenchRouteService({
      lookupSession: vi.fn(async () => undefined),
      openDraft: vi.fn(),
      notice: vi.fn(),
      nodes: { value: [{ id: 'node-1' }] } as never,
      sessions: { value: [] } as never,
      workspaceTarget: { value: undefined } as never,
      selectedSessionId: { value: undefined } as never,
      view: { value: 'nodes' } as never,
      managementSection: { value: 'users' } as never,
      activateWorkspace,
      synchronizeSessions: vi.fn(),
      openSession: vi.fn()
    });

    await service.restore();

    expect(activateWorkspace).not.toHaveBeenCalled();
    expect(storage.getItem('mar.workbench.selection.v1')).toBeNull();
  });

  it('Other Console menus do not restore the Node Workbench selection', async () => {
    const storage = memoryStorage();
    storage.setItem(
      'mar.workbench.selection.v1',
      JSON.stringify({ nodeId: 'node-1', workspaceId: 'workspace-1', sessionId: 'session-1' })
    );
    vi.stubGlobal('window', {
      location: {
        search: '?view=settings',
        href: 'http://localhost/console?view=settings'
      },
      history: { replaceState: vi.fn() }
    });
    vi.stubGlobal('localStorage', storage);
    const activateWorkspace = vi.fn();
    const service = createWorkbenchRouteService({
      lookupSession: vi.fn(async () => undefined),
      openDraft: vi.fn(),
      notice: vi.fn(),
      nodes: { value: [{ id: 'node-1' }] } as never,
      sessions: { value: [] } as never,
      workspaceTarget: { value: undefined } as never,
      selectedSessionId: { value: undefined } as never,
      view: { value: 'settings' } as never,
      managementSection: { value: 'users' } as never,
      activateWorkspace,
      synchronizeSessions: vi.fn(),
      openSession: vi.fn()
    });

    await service.restore();

    expect(activateWorkspace).not.toHaveBeenCalled();
    expect(storage.getItem('mar.workbench.selection.v1')).not.toBeNull();
  });

  it('Restoring an invalid session preserves the valid Workspace and removes the old session selection', async () => {
    const storage = memoryStorage();
    storage.setItem(
      'mar.workbench.selection.v1',
      JSON.stringify({ nodeId: 'node-1', workspaceId: 'workspace-1', sessionId: 'missing' })
    );
    vi.stubGlobal('window', {
      location: { search: '', href: 'http://localhost/console' },
      history: { replaceState: vi.fn() }
    });
    vi.stubGlobal('localStorage', storage);
    const workspaceTarget = {
      value: undefined as { nodeId: string; workspaceId: string } | undefined
    };
    const openSession = vi.fn();
    const service = createWorkbenchRouteService({
      lookupSession: vi.fn(async () => undefined),
      openDraft: vi.fn(),
      notice: vi.fn(),
      nodes: { value: [{ id: 'node-1' }] } as never,
      sessions: { value: [] } as never,
      workspaceTarget: workspaceTarget as never,
      selectedSessionId: { value: undefined } as never,
      view: { value: 'nodes' } as never,
      managementSection: { value: 'users' } as never,
      activateWorkspace: vi.fn(async (target: { nodeId: string; workspaceId: string }) => {
        workspaceTarget.value = target;
        return true;
      }),
      synchronizeSessions: vi.fn(),
      openSession
    });

    await service.restore();

    expect(openSession).not.toHaveBeenCalled();
    expect(storage.getItem('mar.workbench.selection.v1')).toBe(
      JSON.stringify({ workspace: { nodeId: 'node-1', workspaceId: 'workspace-1' } })
    );
  });

  it('Delayed backfill applies only to the Workspace and Session selected when scheduled', async () => {
    vi.useFakeTimers();
    const workspaceTarget = { value: { nodeId: 'node-1', workspaceId: 'workspace-1' } };
    const selectedSessionId = { value: 'session-1' };
    const refresh = vi.fn();
    const service = createSessionSnapshotRefreshService({
      workspaceTarget: workspaceTarget as never,
      selectedSessionId: selectedSessionId as never,
      refresh
    });
    service.schedule(100, true);
    selectedSessionId.value = 'session-2';
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('Duplicate session resynchronization within one event loop performs only the latest authoritative refresh', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const service = createSessionSnapshotRefreshService({
      workspaceTarget: { value: { nodeId: 'node-1', workspaceId: 'workspace-1' } } as never,
      selectedSessionId: { value: 'session-1' } as never,
      refresh
    });

    service.schedule();
    service.schedule();
    service.schedule();
    await vi.runOnlyPendingTimersAsync();

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith('session-1', false);
  });

  it('Repeated resynchronization during an in-flight authoritative refresh coalesces into one follow-up', async () => {
    vi.useFakeTimers();
    let finishFirst!: () => void;
    const first = new Promise<void>((resolve) => (finishFirst = resolve));
    const refresh = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined);
    const service = createSessionSnapshotRefreshService({
      workspaceTarget: { value: { nodeId: 'node-1', workspaceId: 'workspace-1' } } as never,
      selectedSessionId: { value: 'session-1' } as never,
      refresh
    });

    service.schedule();
    await vi.runOnlyPendingTimersAsync();
    service.schedule();
    service.schedule();
    await vi.runOnlyPendingTimersAsync();
    expect(refresh).toHaveBeenCalledOnce();

    finishFirst();
    await first;
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });
});
