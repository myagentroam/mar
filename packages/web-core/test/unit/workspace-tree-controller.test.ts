import { workspaceTargetRef } from './support/workspace-fixture.js';
import { ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElMessageBox } from 'element-plus';
import type {
  NodeSummary,
  Workspace,
  WorkspaceTab,
  WorkspaceTarget
} from '../../src/model/workbench.js';
import type { WorkbenchWorkspaceTreeControllerOptions } from '../../src/service/WorkbenchWorkspaceTreeController.js';
import { createWorkbenchWorkspaceTreeController } from '../../src/service/WorkbenchWorkspaceTreeController.js';
import { createWorkspaceTabService } from '../../src/service/WorkspaceTabService.js';
import { createWorkspaceTreeService } from '../../src/service/WorkspaceTreeService.js';

vi.mock('element-plus', () => ({ ElMessageBox: { confirm: vi.fn(), prompt: vi.fn() } }));

function node(id: string, overrides?: Partial<NodeSummary>): NodeSummary {
  return {
    id,
    displayName: id,
    registeredAddress: '127.0.0.1',
    platform: 'linux',
    architecture: 'x64',
    nodeAppVersion: '0.9.63',
    nodeVersion: 'v24.0.0',
    connected: true,
    disabled: false,
    capabilities: {},
    ...overrides
  };
}

function workspace(id: string, overrides?: Partial<Workspace>): Workspace {
  return { id, path: `/tmp/${id}`, kind: 'DIRECTORY', ...overrides };
}

function fixture() {
  const nodes = ref([node('node-1'), node('node-2')]);
  const workspaces = ref([workspace('workspace-1')]);
  const selectedNodeId = ref<string>('node-1');
  const selectedWorkspaceId = ref<string>('workspace-1');
  const selectedSessionId = ref<string>('session-1');
  const selectedRunId = ref<string>('run-1');
  const activeTabId = ref<string>();
  const tree = createWorkspaceTreeService({
    persist: vi.fn()
  });
  tree.cacheWorkspaces('node-1', workspaces.value);
  tree.cacheWorkspaces('node-2', [workspace('workspace-2')]);
  const tabs = createWorkspaceTabService({
    maxTabs: 8,
    tabId: (nodeId, workspaceId) => `${nodeId}:${workspaceId}`,
    workspaceLabel: (value) => value.displayName ?? value.id,
    nodeLabel: (value) => value.displayName ?? value.id,
    onEvict: vi.fn(),
    onChange: vi.fn()
  });
  const showWorkbench = vi.fn();
  const loading = ref(false);
  const notice = ref('');
  const releaseTerminalDock = vi.fn();
  const deleteTerminalDock = vi.fn();
  const request = vi.fn(async (_path: string) => ({}));
  const saveCurrent = vi.fn();
  const discardCache = vi.fn();
  let selectionRevision = 0;
  const clearWorkspace = vi.fn(() => {
    selectionRevision += 1;
    selectedWorkspaceId.value = undefined as never;
    selectedSessionId.value = undefined as never;
    selectedRunId.value = undefined as never;
  });
  const activateWorkspace = vi.fn(async (target: WorkspaceTarget, _restoreSession?: boolean) => {
    selectedNodeId.value = target.nodeId;
    selectedWorkspaceId.value = target.workspaceId;
    return true;
  });
  const refreshWorkspaceSessions = vi.fn(async () => undefined);
  const refreshNodes = vi.fn(async () => undefined);
  const closeMobileSidebar = vi.fn();
  const closeMobileWorkspaceSurface = vi.fn();
  const workspaceTabSession = vi.fn<() => string | undefined>(() => undefined);
  const openWorkspaceTabSession = vi.fn(async (_sessionId: string) => undefined);
  const controller = createWorkbenchWorkspaceTreeController({
    nodes,
    workspaces,
    sessions: ref([]),
    workspaceTarget: workspaceTargetRef(selectedNodeId, selectedWorkspaceId),
    selectedSessionId,
    selectedRunId,
    activeTabId,
    showWorkbench,
    loading,
    notice,
    workspacesByNode: tree.workspacesByNode,
    tabs,
    tree,
    releaseTerminalDock,
    deleteTerminalDock,
    request: request as WorkbenchWorkspaceTreeControllerOptions['request'],
    saveCurrent,
    discardCache,
    workspaceTabSession,
    openWorkspaceTabSession,
    activateWorkspace: (target, restoreSession) => {
      selectionRevision += 1;
      return restoreSession === false
        ? activateWorkspace(target, false)
        : activateWorkspace(target);
    },
    clearWorkspace,
    currentSelectionRevision: () => selectionRevision,
    cleanupSessionsEnabled: () => true,
    refreshWorkspaceSessions,
    refreshNodes,
    closeMobileSidebar,
    closeMobileWorkspaceSurface,
    errorMessage: (error) => `request failed: ${(error as Error).message}`,
    tabLabel: (value) => value.displayName ?? value.id
  });

  return {
    nodes,
    workspaces,
    selectedNodeId,
    selectedWorkspaceId,
    selectedSessionId,
    selectedRunId,
    activeTabId,
    tabs,
    showWorkbench,
    loading,
    notice,
    releaseTerminalDock,
    deleteTerminalDock,
    request,
    saveCurrent,
    discardCache,
    activateWorkspace,
    clearWorkspace,
    refreshWorkspaceSessions,
    refreshNodes,
    closeMobileSidebar,
    closeMobileWorkspaceSurface,
    tree,
    controller,
    workspaceTabSession,
    openWorkspaceTabSession
  };
}

beforeEach(() => {
  vi.mocked(ElMessageBox.confirm).mockReset();
  vi.mocked(ElMessageBox.prompt).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Public Workspace tree controller', () => {
  it('opens each chosen session on repeated Tab clicks without reactivating the Workspace', async () => {
    const f = fixture();
    const tab = {
      id: 'node-1:workspace-1',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      label: 'one',
      lastActiveAt: 1
    };
    f.workspaceTabSession
      .mockReturnValueOnce('unread-1')
      .mockReturnValueOnce('unread-2')
      .mockReturnValueOnce('active-session');
    await f.controller.openWorkspaceTab(tab);
    await f.controller.openWorkspaceTab(tab);
    await f.controller.openWorkspaceTab(tab);
    expect(f.openWorkspaceTabSession.mock.calls).toEqual([
      ['unread-1'],
      ['unread-2'],
      ['active-session']
    ]);
    expect(f.activateWorkspace).not.toHaveBeenCalled();
    expect(f.showWorkbench).toHaveBeenCalledTimes(3);
  });

  it('skips cached restoration for a priority target, but not ordinary activation', async () => {
    const f = fixture();
    const tab = {
      id: 'node-2:workspace-2',
      nodeId: 'node-2',
      workspaceId: 'workspace-2',
      label: 'two',
      lastActiveAt: 1
    };
    f.workspaceTabSession.mockReturnValue('unloaded');
    await f.controller.openWorkspaceTab(tab);
    expect(f.activateWorkspace).toHaveBeenCalledWith(tab, false);
    expect(f.openWorkspaceTabSession).toHaveBeenCalledWith('unloaded');
    f.selectedWorkspaceId.value = 'workspace-1';
    f.workspaceTabSession.mockReturnValue(undefined);
    await f.controller.openWorkspaceTab(tab);
    expect(f.activateWorkspace).toHaveBeenLastCalledWith(tab);
    expect(f.openWorkspaceTabSession).toHaveBeenCalledTimes(1);
    await f.controller.activateWorkspaceTab(tab);
    expect(f.workspaceTabSession).toHaveBeenCalledTimes(2);
  });

  it('does not open after failed, superseded, or offline activation', async () => {
    for (const result of ['failed', 'superseded', 'offline'] as const) {
      const f = fixture();
      const tab = {
        id: 'node-2:workspace-2',
        nodeId: 'node-2',
        workspaceId: 'workspace-2',
        label: 'two',
        lastActiveAt: 1
      };
      f.workspaceTabSession.mockReturnValue('unread');
      if (result === 'failed') f.activateWorkspace.mockResolvedValue(false);
      if (result === 'superseded') f.activateWorkspace.mockImplementation(async () => true);
      if (result === 'offline') f.nodes.value[1] = { ...f.nodes.value[1]!, connected: false };
      await f.controller.openWorkspaceTab(tab);
      expect(f.openWorkspaceTabSession).not.toHaveBeenCalled();
    }
  });

  it('does not reactivate the selected Workspace from tabs or the tree', async () => {
    const f = fixture();
    f.tabs.remember('node-1', f.nodes.value[0], workspace('workspace-1'));
    const tab = f.tabs.tabs.value[0]!;
    await expect(f.controller.activateWorkspaceTab(tab)).resolves.toBe(true);
    await f.controller.openWorkspaceFromTree(tab.nodeId, tab.workspaceId);

    expect(f.activateWorkspace).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.saveCurrent).not.toHaveBeenCalled();
    expect(f.showWorkbench).toHaveBeenCalledTimes(2);
    expect(f.closeMobileSidebar).toHaveBeenCalled();
    expect(f.closeMobileWorkspaceSurface).toHaveBeenCalledOnce();
    expect(f.selectedSessionId.value).toBe('session-1');
    expect(f.selectedRunId.value).toBe('run-1');
  });

  it('activates once for repeated clicks while a Workspace is loading and compares the full identity', async () => {
    const f = fixture();
    let finish!: (value: boolean) => void;
    f.activateWorkspace.mockImplementationOnce((target) => {
      f.selectedNodeId.value = target.nodeId;
      f.selectedWorkspaceId.value = target.workspaceId;
      return new Promise((resolve) => (finish = resolve));
    });
    const tab: WorkspaceTab = {
      id: 'node-2:workspace-1',
      nodeId: 'node-2',
      workspaceId: 'workspace-1',
      label: 'Same workspace ID on another Node',
      lastActiveAt: 1
    };
    const pending = f.controller.activateWorkspaceTab(tab);
    await f.controller.activateWorkspaceTab(tab);
    await f.controller.openWorkspaceFromTree(tab.nodeId, tab.workspaceId);
    expect(f.activateWorkspace).toHaveBeenCalledOnce();
    expect(f.activateWorkspace).toHaveBeenCalledWith(tab);
    finish(true);
    await pending;
  });

  it('protects pins even from a stale close intent and cleans only normal tabs on bulk close', () => {
    const f = fixture();
    f.tabs.remember('node-1', f.nodes.value[0], workspace('workspace-1'));
    const stale = f.tabs.tabs.value[0]!;
    f.tabs.setPinned(stale.id, true);
    f.activeTabId.value = stale.id;
    f.tabs.remember('node-1', f.nodes.value[0], workspace('extra-1'));
    f.tabs.remember('node-1', f.nodes.value[0], workspace('extra-2'));
    f.controller.closeWorkspaceTab(stale);
    expect(f.releaseTerminalDock).not.toHaveBeenCalled();
    f.controller.closeUnpinnedWorkspaceTabs();
    expect(f.tabs.tabs.value.map((tab) => tab.id)).toEqual([stale.id]);
    expect(f.releaseTerminalDock).toHaveBeenCalledTimes(2);
    expect(f.deleteTerminalDock).toHaveBeenCalledTimes(2);
    expect(f.discardCache).toHaveBeenCalledTimes(2);
    expect(f.saveCurrent).not.toHaveBeenCalled();
    expect(f.activateWorkspace).not.toHaveBeenCalled();
    expect(f.selectedWorkspaceId.value).toBe('workspace-1');
  });

  it('closes the active normal tab last and falls back to a pin only once', () => {
    const f = fixture();
    f.tabs.remember('node-1', f.nodes.value[0], workspace('workspace-1'));
    f.tabs.setPinned('node-1:workspace-1', true);
    f.tabs.remember('node-1', f.nodes.value[0], workspace('extra-1'));
    f.tabs.remember('node-1', f.nodes.value[0], workspace('extra-2'));
    f.activeTabId.value = 'node-1:extra-1';
    f.controller.closeUnpinnedWorkspaceTabs();
    expect(f.releaseTerminalDock.mock.calls.map(([id]) => id)).toEqual([
      'node-1:extra-2',
      'node-1:extra-1'
    ]);
    expect(f.saveCurrent).toHaveBeenCalledOnce();
    expect(f.activateWorkspace).toHaveBeenCalledOnce();
    expect(f.activateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'workspace-1' })
    );
    expect(f.tabs.tabs.value[0]?.pinned).toBe(true);
  });

  it('returns to the most recently used tab rather than the first pinned tab after active close', async () => {
    const f = fixture();
    f.workspaces.value = ['workspace-1', 'workspace-2', 'workspace-3'].map((id) => workspace(id));
    f.tabs.restore(
      f.workspaces.value.map((item, index) => ({
        id: `node-1:${item.id}`,
        nodeId: 'node-1',
        workspaceId: item.id,
        label: item.id,
        pinned: index === 0,
        lastActiveAt: index + 1
      }))
    );
    f.activeTabId.value = 'node-1:workspace-3';
    f.controller.closeWorkspaceTab(f.tabs.tabs.value[2]!);
    expect(f.activateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'workspace-2' })
    );
    expect(f.releaseTerminalDock).toHaveBeenCalledWith('node-1:workspace-3');
    expect(f.saveCurrent).toHaveBeenCalledOnce();
    await Promise.resolve();
    f.activeTabId.value = 'node-1:workspace-1';
    await f.controller.activateWorkspaceTab(f.tabs.tabs.value[0]!);
    f.activateWorkspace.mockClear();
    f.controller.closeWorkspaceTab(f.tabs.tabs.value[1]!);
    expect(f.activateWorkspace).not.toHaveBeenCalled();
  });

  it('uses the unified Workspace activation entry for the MRU replacement', () => {
    const f = fixture();
    f.tabs.restore([
      {
        id: 'node-1:first',
        nodeId: 'node-1',
        workspaceId: 'first',
        label: 'first',
        pinned: true,
        lastActiveAt: 1
      },
      {
        id: 'node-2:workspace-2',
        nodeId: 'node-2',
        workspaceId: 'workspace-2',
        label: 'recent',
        lastActiveAt: 30
      },
      {
        id: 'node-1:current',
        nodeId: 'node-1',
        workspaceId: 'current',
        label: 'current',
        lastActiveAt: 40
      }
    ]);
    const recent = f.tabs.tabs.value[1]!;
    f.activeTabId.value = 'node-1:current';
    f.controller.closeWorkspaceTab(f.tabs.tabs.value[2]!);
    expect(f.activateWorkspace).toHaveBeenCalledExactlyOnceWith(recent);
  });

  it('falls back once to the MRU surviving pin on bulk close', () => {
    const f = fixture();
    f.tabs.restore([
      {
        id: 'node-1:workspace-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        label: 'first',
        pinned: true,
        lastActiveAt: 1
      },
      {
        id: 'node-2:workspace-2',
        nodeId: 'node-2',
        workspaceId: 'workspace-2',
        label: 'recent',
        pinned: true,
        lastActiveAt: 30
      },
      {
        id: 'node-1:other',
        nodeId: 'node-1',
        workspaceId: 'other',
        label: 'other',
        lastActiveAt: 35
      },
      {
        id: 'node-1:current',
        nodeId: 'node-1',
        workspaceId: 'current',
        label: 'current',
        lastActiveAt: 40
      }
    ]);
    const recent = f.tabs.tabs.value[1]!;
    f.activeTabId.value = 'node-1:current';
    f.controller.closeUnpinnedWorkspaceTabs();
    expect(f.tabs.tabs.value.map((tab) => tab.label)).toEqual(['first', 'recent']);
    expect(f.activateWorkspace).toHaveBeenCalledExactlyOnceWith(recent);
    expect(f.saveCurrent).toHaveBeenCalledOnce();
    expect(f.releaseTerminalDock).toHaveBeenCalledTimes(2);
  });

  it('skips a missing-Node MRU target and restores the next remaining workspace', async () => {
    const f = fixture();
    f.tabs.restore([
      {
        id: 'node-1:workspace-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        label: 'valid',
        lastActiveAt: 1
      },
      {
        id: 'missing:gone',
        nodeId: 'missing',
        workspaceId: 'gone',
        label: 'gone',
        pinned: true,
        lastActiveAt: 2
      },
      {
        id: 'node-1:current',
        nodeId: 'node-1',
        workspaceId: 'current',
        label: 'current',
        lastActiveAt: 3
      }
    ]);
    f.activeTabId.value = 'node-1:current';
    f.controller.closeWorkspaceTab(f.tabs.tabs.value[2]!);
    await vi.waitFor(() =>
      expect(f.activateWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'workspace-1' })
      )
    );
    expect(f.tabs.tabs.value.map((tab) => tab.label)).toEqual(['valid']);
  });

  it('keeps a rejected Workspace activation but tries the next MRU target without retaining closed selection', async () => {
    const f = fixture();
    f.tabs.restore([
      {
        id: 'node-1:workspace-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        label: 'valid',
        lastActiveAt: 1
      },
      {
        id: 'node-2:workspace-2',
        nodeId: 'node-2',
        workspaceId: 'workspace-2',
        label: 'failed',
        pinned: true,
        lastActiveAt: 2
      },
      {
        id: 'node-1:current',
        nodeId: 'node-1',
        workspaceId: 'current',
        label: 'current',
        lastActiveAt: 3
      }
    ]);
    f.activeTabId.value = 'node-1:current';
    f.activateWorkspace.mockResolvedValue(false);
    f.controller.closeWorkspaceTab(f.tabs.tabs.value[2]!);
    expect(f.selectedWorkspaceId.value).toBeUndefined();
    expect(f.selectedSessionId.value).toBeUndefined();
    expect(f.selectedRunId.value).toBeUndefined();
    await vi.waitFor(() =>
      expect(f.activateWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'workspace-1' })
      )
    );
    expect(f.tabs.tabs.value.some((tab) => tab.label === 'failed' && tab.pinned)).toBe(true);
  });

  it('leaves empty selection when every remaining MRU target fails', async () => {
    const f = fixture();
    f.tabs.restore([
      {
        id: 'node-2:workspace-2',
        nodeId: 'node-2',
        workspaceId: 'workspace-2',
        label: 'failed',
        lastActiveAt: 1
      },
      {
        id: 'node-1:current',
        nodeId: 'node-1',
        workspaceId: 'current',
        label: 'current',
        lastActiveAt: 2
      }
    ]);
    f.activeTabId.value = 'node-1:current';
    f.activateWorkspace.mockResolvedValue(false);
    f.controller.closeWorkspaceTab(f.tabs.tabs.value[1]!);
    await Promise.resolve();
    expect(f.selectedWorkspaceId.value).toBeUndefined();
    expect(f.tabs.tabs.value.map((tab) => tab.label)).toEqual(['failed']);
    expect(f.activateWorkspace).toHaveBeenCalledOnce();
  });

  it('does not retry fallback after a newer Workspace selection intent', async () => {
    const f = fixture();
    f.tabs.restore([
      {
        id: 'node-1:workspace-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        label: 'valid',
        lastActiveAt: 1
      },
      {
        id: 'node-2:workspace-2',
        nodeId: 'node-2',
        workspaceId: 'workspace-2',
        label: 'pending',
        lastActiveAt: 2
      },
      {
        id: 'node-1:current',
        nodeId: 'node-1',
        workspaceId: 'current',
        label: 'current',
        lastActiveAt: 3
      }
    ]);
    let finish!: (value: boolean) => void;
    f.activateWorkspace.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    f.activeTabId.value = 'node-1:current';
    f.controller.closeWorkspaceTab(f.tabs.tabs.value[2]!);
    f.clearWorkspace();
    f.controller.closeWorkspaceTab(f.tabs.tabs.value[1]!);
    finish(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.activateWorkspace).toHaveBeenCalledOnce();
  });

  it('cancels a closed pending target and resumes fallback without restoring the closed tab', async () => {
    const f = fixture();
    f.tabs.restore([
      {
        id: 'node-1:workspace-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        label: 'valid',
        lastActiveAt: 1
      },
      {
        id: 'node-2:workspace-2',
        nodeId: 'node-2',
        workspaceId: 'workspace-2',
        label: 'pending',
        lastActiveAt: 2
      },
      {
        id: 'node-1:current',
        nodeId: 'node-1',
        workspaceId: 'current',
        label: 'current',
        lastActiveAt: 3
      }
    ]);
    let finish!: (value: boolean) => void;
    f.activateWorkspace.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    f.activeTabId.value = 'node-1:current';
    f.controller.closeWorkspaceTab(f.tabs.tabs.value[2]!);
    f.controller.closeWorkspaceTab(f.tabs.tabs.value[1]!);
    await vi.waitFor(() =>
      expect(f.activateWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'workspace-1' })
      )
    );
    expect(f.clearWorkspace).toHaveBeenCalled();
    finish(false);
    await Promise.resolve();
    expect(f.tabs.tabs.value.map((tab) => tab.label)).toEqual(['valid']);
    expect(f.activateWorkspace).toHaveBeenCalledTimes(2);
  });

  it('bulk closes pending normal targets before starting one fallback to a surviving pin', async () => {
    const f = fixture();
    f.tabs.restore([
      {
        id: 'node-1:workspace-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        label: 'pin',
        pinned: true,
        lastActiveAt: 1
      },
      {
        id: 'node-1:other',
        nodeId: 'node-1',
        workspaceId: 'other',
        label: 'other',
        lastActiveAt: 2
      },
      {
        id: 'node-2:workspace-2',
        nodeId: 'node-2',
        workspaceId: 'workspace-2',
        label: 'pending',
        lastActiveAt: 3
      },
      {
        id: 'node-1:current',
        nodeId: 'node-1',
        workspaceId: 'current',
        label: 'current',
        lastActiveAt: 4
      }
    ]);
    let finish!: (value: boolean) => void;
    f.activateWorkspace.mockImplementationOnce(() => {
      f.clearWorkspace();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    f.activeTabId.value = 'node-1:current';
    f.controller.closeWorkspaceTab(f.tabs.tabs.value[3]!);
    f.activeTabId.value = undefined;
    f.controller.closeUnpinnedWorkspaceTabs();
    expect(f.tabs.tabs.value.map((tab) => tab.label)).toEqual(['pin']);
    expect(f.activateWorkspace).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: 'workspace-1' })
    );
    finish(false);
    await Promise.resolve();
    expect(f.activateWorkspace).toHaveBeenCalledTimes(2);
  });

  it('skips a permanently unavailable Workspace in MRU fallback without repeatedly trying it', async () => {
    const f = fixture();
    f.tabs.restore([
      {
        id: 'node-1:workspace-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        label: 'valid',
        lastActiveAt: 1
      },
      {
        id: 'node-1:missing',
        nodeId: 'node-1',
        workspaceId: 'missing',
        label: 'missing',
        pinned: true,
        lastActiveAt: 2
      },
      {
        id: 'node-1:current',
        nodeId: 'node-1',
        workspaceId: 'current',
        label: 'current',
        lastActiveAt: 3
      }
    ]);
    f.activateWorkspace.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    f.activeTabId.value = 'node-1:current';
    f.controller.closeWorkspaceTab(f.tabs.tabs.value[2]!);
    await vi.waitFor(() =>
      expect(f.activateWorkspace).toHaveBeenLastCalledWith(
        expect.objectContaining({ workspaceId: 'workspace-1' })
      )
    );
    expect(f.activateWorkspace).toHaveBeenCalledTimes(2);
  });

  it('still removes an authoritative missing Node tab when pinned', async () => {
    const f = fixture();
    f.tabs.remember('missing-node', undefined, workspace('orphan'));
    f.tabs.setPinned('missing-node:orphan', true);
    expect(await f.controller.activateWorkspaceTab(f.tabs.tabs.value[0]!)).toBe(false);
    expect(f.tabs.tabs.value).toEqual([]);
    expect(f.releaseTerminalDock).toHaveBeenCalledWith('missing-node:orphan');
  });

  it('refreshes loaded branches and preserves the active selection and local order', async () => {
    const f = fixture();
    f.tree.cacheWorkspaces('node-1', [workspace('workspace-1'), workspace('workspace-3')]);
    f.workspaces.value = [workspace('workspace-1'), workspace('workspace-3')];
    f.controller.startWorkspaceDrag({ dataTransfer: null } as DragEvent, 'node-1', 'workspace-3');
    f.controller.reorderWorkspace('node-1', workspace('workspace-1'));
    f.request.mockImplementation(async (path: string) => ({
      workspaces: path.includes('node-1')
        ? [workspace('workspace-1'), workspace('workspace-3'), workspace('new-workspace')]
        : [workspace('workspace-2')]
    }));

    await f.controller.refreshWorkspaceTree();

    expect(f.refreshNodes).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledWith('/api/workspaces?nodeId=node-1');
    expect(f.request).toHaveBeenCalledWith('/api/workspaces?nodeId=node-2');
    expect(f.tree.orderedWorkspaces('node-1').map((value) => value.id)).toEqual([
      'workspace-3',
      'workspace-1',
      'new-workspace'
    ]);
    expect(f.selectedWorkspaceId.value).toBe('workspace-1');
    expect(f.selectedSessionId.value).toBe('session-1');
  });

  it('refreshes only the requested Node from its context menu', async () => {
    const f = fixture();
    f.request.mockResolvedValue({ workspaces: [workspace('new-workspace')] });

    await f.controller.refreshNodeWorkspaces('node-2');

    expect(f.request).toHaveBeenCalledExactlyOnceWith('/api/workspaces?nodeId=node-2');
    expect(f.refreshNodes).not.toHaveBeenCalled();
    expect(f.workspaces.value).toEqual([workspace('workspace-1')]);
    expect(f.tree.workspacesForNode('node-2')).toEqual([workspace('new-workspace')]);
  });

  it('keeps the visible list after a failed refresh and ignores an older response', async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error('offline'));
    await f.controller.refreshNodeWorkspaces('node-1');
    expect(f.workspaces.value).toEqual([workspace('workspace-1')]);
    expect(f.notice.value).toContain('offline');

    let finishOldRequest: ((value: { workspaces: Workspace[] }) => void) | undefined;
    f.request.mockImplementationOnce(() => new Promise((resolve) => (finishOldRequest = resolve)));
    f.request.mockResolvedValueOnce({ workspaces: [workspace('new-workspace')] });
    const oldRequest = f.controller.refreshNodeWorkspaces('node-1');
    await f.controller.refreshNodeWorkspaces('node-1');
    finishOldRequest?.({ workspaces: [workspace('workspace-1')] });
    await oldRequest;
    expect(f.workspaces.value).toEqual([workspace('new-workspace')]);
  });

  it.each(['success', 'failure'] as const)(
    'does not project a stale tree refresh %s after switching away and back to the same Workspace',
    async (outcome) => {
      const f = fixture();
      let resolve!: (value: { workspaces: Workspace[] }) => void;
      let reject!: (error: Error) => void;
      f.request.mockImplementationOnce(
        () =>
          new Promise((done, fail) => {
            resolve = done;
            reject = fail;
          })
      );
      const pending = f.controller.refreshNodeWorkspaces('node-1');
      await f.controller.openWorkspaceFromTree('node-2', 'workspace-2');
      await f.controller.openWorkspaceFromTree('node-1', 'workspace-1');
      const current = workspace('workspace-1', { displayName: 'Current metadata' });
      f.workspaces.value = [current];
      f.notice.value = 'Current notice';

      if (outcome === 'success') resolve({ workspaces: [workspace('workspace-1')] });
      else reject(new Error('Old failure'));
      await pending;

      expect(f.workspaces.value).toEqual([current]);
      expect(f.notice.value).toBe('Current notice');
    }
  );

  it('shows the Workbench immediately for a Workspace tab through the activation entry', async () => {
    const f = fixture();
    f.selectedWorkspaceId.value = 'workspace-2';
    const tab: WorkspaceTab = {
      id: 'node-1:workspace-1',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      label: 'workspace-1',
      lastActiveAt: 1
    };

    await expect(f.controller.activateWorkspaceTab(tab)).resolves.toBe(true);

    expect(f.activateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'workspace-1' })
    );
    expect(f.showWorkbench).toHaveBeenCalledOnce();
  });

  it('delegates every Workspace including offline and uncached targets, but removes tabs whose Node no longer exists', async () => {
    const f = fixture();
    const crossNodeTab: WorkspaceTab = {
      id: 'node-2:workspace-2',
      nodeId: 'node-2',
      workspaceId: 'workspace-2',
      label: 'workspace-2',
      lastActiveAt: 1
    };

    f.tabs.restore([crossNodeTab]);
    f.activeTabId.value = crossNodeTab.id;
    f.nodes.value = [node('node-1')];
    await expect(f.controller.activateWorkspaceTab(crossNodeTab)).resolves.toBe(false);

    expect(f.tabs.tabs.value).toEqual([]);
    expect(f.activateWorkspace).not.toHaveBeenCalled();
    expect(f.activateWorkspace).not.toHaveBeenCalled();
    expect(f.showWorkbench).not.toHaveBeenCalled();

    f.tabs.restore([crossNodeTab]);
    f.activeTabId.value = 'node-1:workspace-1';
    f.nodes.value = [node('node-1'), node('node-2')];
    await expect(f.controller.activateWorkspaceTab(crossNodeTab)).resolves.toBe(true);
    expect(f.activateWorkspace).toHaveBeenCalledWith(crossNodeTab);

    f.nodes.value = [node('node-1', { connected: false })];
    await expect(
      f.controller.activateWorkspaceTab({
        ...crossNodeTab,
        nodeId: 'node-1',
        workspaceId: 'workspace-1'
      })
    ).resolves.toBe(true);

    expect(f.activateWorkspace).toHaveBeenLastCalledWith({
      ...crossNodeTab,
      nodeId: 'node-1',
      workspaceId: 'workspace-1'
    });
    f.nodes.value = [node('node-1')];
    await expect(
      f.controller.activateWorkspaceTab({
        ...crossNodeTab,
        nodeId: 'node-1',
        workspaceId: 'missing-workspace'
      })
    ).resolves.toBe(true);
    expect(f.activateWorkspace).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: 'missing-workspace' })
    );
  });

  it('releases terminal handles, discards cache, and clears selection when closing the active tab without a replacement', () => {
    const f = fixture();
    const selectedTab: WorkspaceTab = {
      id: 'node-1:workspace-1',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      label: 'workspace-1',
      lastActiveAt: 1
    };
    f.tabs.restore([selectedTab]);
    f.activeTabId.value = selectedTab.id;

    f.controller.closeWorkspaceTab(selectedTab);

    expect(f.saveCurrent).toHaveBeenCalledOnce();
    expect(f.releaseTerminalDock).toHaveBeenCalledWith(selectedTab.id);
    expect(f.deleteTerminalDock).toHaveBeenCalledWith(selectedTab.id);
    expect(f.discardCache).toHaveBeenCalledWith('node-1', 'workspace-1');
    expect(f.tabs.tabs.value).toEqual([]);
    expect(f.selectedWorkspaceId.value).toBeUndefined();
    expect(f.selectedSessionId.value).toBeUndefined();
    expect(f.selectedRunId.value).toBeUndefined();
  });

  it('preserves the current selection and tab and releases loading when Workspace removal fails', async () => {
    const f = fixture();
    const value = workspace('workspace-1');
    f.nodes.value = [node('node-1', { workspaceCreatable: true })];
    const tab: WorkspaceTab = {
      id: 'node-1:workspace-1',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      label: 'workspace-1',
      lastActiveAt: 1
    };
    f.tabs.restore([tab]);
    vi.mocked(ElMessageBox.confirm).mockResolvedValue(
      'confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>
    );
    f.request.mockRejectedValue(new Error('network unavailable'));

    await f.controller.removeWorkspace('node-1', value);

    expect(f.selectedWorkspaceId.value).toBe('workspace-1');
    expect(f.selectedSessionId.value).toBe('session-1');
    expect(f.selectedRunId.value).toBe('run-1');
    expect(f.tabs.tabs.value).toEqual([tab]);
    expect(f.loading.value).toBe(false);
    expect(f.notice.value).toContain('network unavailable');
  });

  it('preserves selection, releases loading, and skips list refresh when session cleanup fails', async () => {
    const f = fixture();
    f.request.mockRejectedValue(new Error('cleanup unavailable'));

    await expect(
      f.controller.cleanupWorkspaceSessions('node-1', workspace('workspace-1'), 30)
    ).rejects.toThrow('request failed: cleanup unavailable');

    expect(f.selectedWorkspaceId.value).toBe('workspace-1');
    expect(f.selectedSessionId.value).toBe('session-1');
    expect(f.loading.value).toBe(false);
    expect(f.refreshWorkspaceSessions).not.toHaveBeenCalled();
  });

  it('persists menu-selected group moves and cross-group drops with the registration capability', async () => {
    const f = fixture();
    const ungrouped = workspace('workspace-1');
    const grouped = workspace('workspace-2', { groupName: 'Existing' });
    f.nodes.value = [node('node-1', { workspaceCreatable: true, manageable: false })];
    f.workspaces.value = [ungrouped, grouped];
    f.tree.cacheWorkspaces('node-1', f.workspaces.value);

    await f.controller.moveWorkspaceGroup('node-1', ungrouped, 'New group');

    expect(f.request).toHaveBeenCalledWith('/api/workspaces/workspace-1?nodeId=node-1', {
      method: 'PATCH',
      body: JSON.stringify({ groupName: 'New group' })
    });
    expect(f.tree.workspacesForNode('node-1')).toContainEqual({
      ...ungrouped,
      groupName: 'New group'
    });

    f.request.mockClear();
    f.controller.startWorkspaceDrag({ dataTransfer: null } as DragEvent, 'node-1', 'workspace-1');
    f.controller.reorderWorkspace('node-1', grouped);
    await vi.waitFor(() =>
      expect(f.request).toHaveBeenCalledWith('/api/workspaces/workspace-1?nodeId=node-1', {
        method: 'PATCH',
        body: JSON.stringify({ groupName: 'Existing' })
      })
    );
  });

  it('moves a Workspace to ungrouped and keeps same-group ordering local', async () => {
    const f = fixture();
    const first = workspace('workspace-1', { groupName: 'Group' });
    const second = workspace('workspace-2', { groupName: 'Group' });
    const ungrouped = workspace('workspace-3');
    f.nodes.value = [node('node-1', { workspaceCreatable: true })];
    f.workspaces.value = [first, second, ungrouped];
    f.tree.cacheWorkspaces('node-1', f.workspaces.value);

    f.controller.startWorkspaceDrag({ dataTransfer: null } as DragEvent, 'node-1', first.id);
    f.controller.reorderWorkspace('node-1', ungrouped);
    await vi.waitFor(() =>
      expect(f.request).toHaveBeenCalledWith('/api/workspaces/workspace-1?nodeId=node-1', {
        method: 'PATCH',
        body: JSON.stringify({ groupName: null })
      })
    );

    f.request.mockClear();
    f.tree.cacheWorkspaces('node-1', [first, second, ungrouped]);
    f.controller.startWorkspaceDrag({ dataTransfer: null } as DragEvent, 'node-1', first.id);
    f.controller.reorderWorkspace('node-1', second);

    expect(f.request).not.toHaveBeenCalled();
    expect(f.tree.orderedWorkspaces('node-1').map((item) => item.id)).toEqual([
      'workspace-2',
      'workspace-1',
      'workspace-3'
    ]);
  });

  it('does not use Workspace management capability as a substitute for group permission', async () => {
    const f = fixture();
    const source = workspace('workspace-1');
    const target = workspace('workspace-2', { groupName: 'Existing' });
    f.nodes.value = [node('node-1', { workspaceCreatable: false, manageable: true })];
    f.workspaces.value = [source, target];
    f.tree.cacheWorkspaces('node-1', f.workspaces.value);

    f.controller.startWorkspaceDrag({ dataTransfer: null } as DragEvent, 'node-1', source.id);
    f.controller.reorderWorkspace('node-1', target);
    await f.controller.moveWorkspaceGroup('node-1', source, 'Existing');

    await Promise.resolve();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.tree.workspacesForNode('node-1')).toEqual([source, target]);
  });

  it('reorders without group permission and forwards explicit insertion positions', () => {
    const f = fixture();
    const first = workspace('workspace-1', { groupName: 'Group' });
    const second = workspace('workspace-2', { groupName: 'Group' });
    f.workspaces.value = [first, second];
    f.tree.cacheWorkspaces('node-1', f.workspaces.value);
    f.controller.startWorkspaceDrag({ dataTransfer: null } as DragEvent, 'node-1', second.id);
    f.controller.reorderWorkspace('node-1', first, 'after');
    expect(f.tree.orderedWorkspaces('node-1').map((item) => item.id)).toEqual([
      first.id,
      second.id
    ]);
    f.controller.startWorkspaceDrag({ dataTransfer: null } as DragEvent, 'node-1', second.id);
    f.controller.reorderWorkspace('node-1', first, 'before');
    expect(f.tree.orderedWorkspaces('node-1').map((item) => item.id)).toEqual([
      second.id,
      first.id
    ]);
    expect(f.request).not.toHaveBeenCalled();
  });

  it('accepts ungrouping on the owning Node but ignores cross-host and unauthorized drops', async () => {
    const f = fixture();
    const source = workspace('workspace-1', { groupName: 'Group' });
    f.nodes.value = [
      node('node-1', { workspaceCreatable: true }),
      node('node-2', { workspaceCreatable: true })
    ];
    f.workspaces.value = [source];
    f.tree.cacheWorkspaces('node-1', [source]);
    f.controller.startWorkspaceDrag({ dataTransfer: null } as DragEvent, 'node-1', source.id);
    f.controller.moveWorkspaceToGroup('node-2', null);
    expect(f.request).not.toHaveBeenCalled();
    f.controller.moveWorkspaceToGroup('node-1', null);
    await vi.waitFor(() => expect(f.tree.workspacesForNode('node-1')[0]?.groupName).toBeNull());
    expect(f.request).toHaveBeenCalledWith('/api/workspaces/workspace-1?nodeId=node-1', {
      method: 'PATCH',
      body: JSON.stringify({ groupName: null })
    });
    expect(f.tree.draggingWorkspace.value).toBeUndefined();

    f.request.mockClear();
    f.nodes.value = [node('node-1', { workspaceCreatable: false })];
    f.tree.cacheWorkspaces('node-1', [source]);
    f.controller.startWorkspaceDrag({ dataTransfer: null } as DragEvent, 'node-1', source.id);
    f.controller.moveWorkspaceToGroup('node-1', null);
    await Promise.resolve();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.tree.workspacesForNode('node-1')[0]?.groupName).toBe('Group');
  });

  it('allows a registration-capable user to remove an otherwise unmanaged Workspace', async () => {
    const f = fixture();
    const value = workspace('workspace-1', { manageable: false });
    f.nodes.value = [node('node-1', { workspaceCreatable: true, manageable: false })];
    f.workspaces.value = [value];
    f.tree.cacheWorkspaces('node-1', [value]);
    vi.mocked(ElMessageBox.confirm).mockResolvedValue(
      'confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>
    );

    await f.controller.removeWorkspace('node-1', value);

    expect(f.request).toHaveBeenCalledWith('/api/workspaces/workspace-1?nodeId=node-1', {
      method: 'DELETE'
    });
  });
});
