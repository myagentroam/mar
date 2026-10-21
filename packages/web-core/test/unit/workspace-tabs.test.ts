import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceTabService } from '../../src/service/WorkspaceTabService.js';

const node = {
  id: 'node-1',
  displayName: 'Node 1',
  registeredAddress: '127.0.0.1',
  platform: 'linux',
  architecture: 'x64',
  nodeAppVersion: '0.1.4',
  nodeVersion: 'v22.13.0',
  connected: true,
  disabled: false,
  capabilities: {}
};

function workspace(id: string) {
  return { id, path: `/tmp/${id}`, kind: 'DIRECTORY' as const };
}

describe('Web Workspace tabs', () => {
  function pinnedFixture(maxTabs = 3) {
    const onEvict = vi.fn();
    const onChange = vi.fn();
    const tabs = createWorkspaceTabService({
      maxTabs,
      tabId: (n, w) => `${n}:${w}`,
      workspaceLabel: (item) => item.id,
      nodeLabel: (item) => item.displayName ?? item.id,
      onEvict,
      onChange
    });
    tabs.restore(
      ['a', 'b', 'c'].map((id, index) => ({
        id: `node-1:${id}`,
        nodeId: 'node-1',
        workspaceId: id,
        label: id,
        lastActiveAt: index + 1
      }))
    );
    return { tabs, onEvict, onChange };
  }

  it('pins tabs at the front, retains metadata and activity, and unpins at the normal boundary', () => {
    const { tabs, onChange } = pinnedFixture();
    tabs.rememberSession(node.id, 'b', 'native-b');
    tabs.setPinned('node-1:b', true);
    tabs.setPinned('node-1:c', true);
    expect(tabs.tabs.value.map((tab) => tab.workspaceId)).toEqual(['b', 'c', 'a']);
    expect(tabs.tabs.value[0]).toMatchObject({
      pinned: true,
      selectedSessionId: 'native-b',
      lastActiveAt: 2
    });
    tabs.remember(node.id, node, workspace('b'));
    expect(tabs.tabs.value[0]?.pinned).toBe(true);
    tabs.setPinned('node-1:b', false);
    expect(tabs.tabs.value.map((tab) => tab.workspaceId)).toEqual(['c', 'b', 'a']);
    const changes = onChange.mock.calls.length;
    tabs.setPinned('node-1:b', false);
    tabs.setPinned('missing', true);
    expect(onChange).toHaveBeenCalledTimes(changes);
  });

  it('reorders pins and automatically pins or unpins when crossing the section boundary', () => {
    const { tabs } = pinnedFixture();
    tabs.setPinned('node-1:a', true);
    tabs.setPinned('node-1:b', true);
    tabs.move('node-1:a', 1);
    expect(tabs.tabs.value.map((tab) => tab.workspaceId)).toEqual(['b', 'a', 'c']);
    expect(tabs.tabs.value[1]?.pinned).toBe(true);
    tabs.move('node-1:c', 0);
    expect(tabs.tabs.value.map((tab) => tab.workspaceId)).toEqual(['c', 'b', 'a']);
    expect(tabs.tabs.value.every((tab) => tab.pinned === true)).toBe(true);
    tabs.setPinned('node-1:c', false);
    tabs.move('node-1:a', 2);
    expect(tabs.tabs.value.map((tab) => tab.workspaceId)).toEqual(['b', 'c', 'a']);
    expect(tabs.tabs.value.map((tab) => tab.pinned === true)).toEqual([true, false, false]);
    expect(tabs.tabs.value.map((tab) => tab.lastActiveAt)).toEqual([2, 3, 1]);
  });

  it('keeps a normal tab normal at the section boundary and leaves all-normal reorders unchanged', () => {
    const { tabs } = pinnedFixture();
    tabs.setPinned('node-1:a', true);
    tabs.move('node-1:c', 1);
    expect(tabs.tabs.value.map((tab) => tab.workspaceId)).toEqual(['a', 'c', 'b']);
    expect(tabs.tabs.value[1]?.pinned).not.toBe(true);
    tabs.setPinned('node-1:a', false);
    tabs.move('node-1:b', 0);
    expect(tabs.tabs.value[0]?.pinned).not.toBe(true);
    expect(tabs.tabs.value.map((tab) => tab.lastActiveAt)).toEqual([2, 1, 3]);
  });

  it('selects MRU independently of display order and pinning, with stable ties and empty fallback', () => {
    const { tabs } = pinnedFixture();
    expect(tabs.mostRecentlyUsed()?.workspaceId).toBe('c');
    tabs.setPinned('node-1:a', true);
    tabs.setPinned('node-1:b', true);
    tabs.move('node-1:c', 0);
    expect(tabs.mostRecentlyUsed()?.workspaceId).toBe('c');
    tabs.restore(tabs.tabs.value.map((tab) => ({ ...tab, lastActiveAt: 20 })));
    expect(tabs.mostRecentlyUsed()?.workspaceId).toBe('c');
    tabs.restore([]);
    expect(tabs.mostRecentlyUsed()).toBeUndefined();
  });

  it('records activation without Workspace metadata, preserving pinning, identity and sessions', () => {
    const { tabs, onChange } = pinnedFixture();
    tabs.setPinned('node-1:a', true);
    const before = { ...tabs.tabs.value[0]! };
    tabs.touch('node-1:a');
    expect(tabs.mostRecentlyUsed()?.id).toBe('node-1:a');
    expect(tabs.tabs.value[0]).toMatchObject({ ...before, lastActiveAt: expect.any(Number) });
    expect(tabs.tabs.value[0]!.lastActiveAt).toBeGreaterThan(before.lastActiveAt);
    expect(tabs.mostRecentlyUsed(new Set(['node-1:a']))?.id).toBe('node-1:c');
    const changes = onChange.mock.calls.length;
    tabs.touch('missing');
    expect(onChange).toHaveBeenCalledTimes(changes);
  });

  it('keeps pinned tabs outside the LRU quota and restores every pin beyond the normal limit', () => {
    const { tabs, onEvict } = pinnedFixture(2);
    tabs.setPinned('node-1:a', true);
    tabs.remember(node.id, node, workspace('c'));
    tabs.remember(node.id, node, workspace('d'));
    expect(tabs.tabs.value.map((tab) => tab.workspaceId)).toEqual(['a', 'c', 'd']);
    expect(onEvict).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'b' }));
    for (const tab of [...tabs.tabs.value]) tabs.setPinned(tab.id, true);
    tabs.remember(node.id, node, workspace('e'));
    tabs.remember(node.id, node, workspace('f'));
    const snapshot = JSON.parse(JSON.stringify(tabs.tabs.value));
    tabs.restore(snapshot);
    expect(tabs.tabs.value.map((tab) => tab.workspaceId)).toEqual(['a', 'c', 'd', 'e', 'f']);
    tabs.remember(node.id, node, workspace('g'));
    expect(tabs.tabs.value.map((tab) => tab.workspaceId)).toEqual(['a', 'c', 'd', 'f', 'g']);
    expect(onEvict.mock.calls.every(([tab]) => tab.pinned !== true)).toBe(true);
  });

  it('retains the explicitly unpinned tab when the normal quota is full', () => {
    const { tabs, onEvict } = pinnedFixture(2);
    tabs.setPinned('node-1:a', true);
    tabs.remember(node.id, node, workspace('c'));
    tabs.setPinned('node-1:a', false);
    expect(tabs.tabs.value.map((tab) => tab.workspaceId)).toEqual(['a', 'c']);
    expect(onEvict).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'b' }));
    tabs.setPinned('node-1:a', true);
    tabs.remember(node.id, node, workspace('d'));
    tabs.move('node-1:a', 2);
    expect(tabs.tabs.value.map((tab) => tab.workspaceId)).toEqual(['d', 'a']);
    expect(tabs.tabs.value[1]?.pinned).toBe(false);
  });

  it('normalizes legacy snapshot order without truncating pins or mutating the snapshot', () => {
    const { tabs } = pinnedFixture(1);
    const base = tabs.tabs.value[0]!;
    const snapshot = [
      base,
      { ...base, id: 'pin-1', pinned: true },
      { ...base, id: 'normal-2' },
      { ...base, id: 'pin-2', pinned: true }
    ];
    tabs.restore(snapshot);
    expect(tabs.tabs.value.map((tab) => tab.id)).toEqual(['pin-1', 'pin-2', base.id]);
    expect(snapshot[0]?.id).toBe(base.id);
  });

  it('restores each tab session from snapshots, preserves it across activation and reordering, and clears it on close', () => {
    const tabs = createWorkspaceTabService({
      maxTabs: 3,
      tabId: (nodeId, workspaceId) => `${nodeId}:${workspaceId}`,
      workspaceLabel: (item) => item.id,
      nodeLabel: (item) => item.displayName ?? item.id,
      onEvict: vi.fn(),
      onChange: vi.fn()
    });
    tabs.remember(node.id, node, workspace('a'));
    tabs.rememberSession(node.id, 'a', 'session-a');
    tabs.remember(node.id, node, workspace('b'));
    tabs.rememberSession(node.id, 'b', 'session-b');
    tabs.remember(node.id, node, workspace('a'));
    tabs.move('node-1:b', 0);
    const snapshot = JSON.parse(JSON.stringify(tabs.tabs.value));
    tabs.restore(snapshot);
    expect(tabs.tabs.value.map((tab) => tab.workspaceId)).toEqual(['b', 'a']);
    expect(tabs.takeRestoredSelection(node.id, 'a')?.selectedSessionId).toBe('session-a');
    expect(tabs.takeRestoredSelection(node.id, 'a')?.selectedSessionId).toBe('session-a');
    tabs.remove(tabs.tabs.value[0]!);
    tabs.remember(node.id, node, workspace('b'));
    expect(tabs.takeRestoredSelection(node.id, 'b')).toBeUndefined();
    tabs.rememberSession(node.id, 'a');
    expect(tabs.takeRestoredSelection(node.id, 'a')).toBeUndefined();
    expect(tabs.tabs.value.find((tab) => tab.workspaceId === 'a')).not.toHaveProperty(
      'selectedSessionId'
    );
  });

  it('evicts the least recently used tab and appends the new tab', () => {
    const onEvict = vi.fn();
    const onChange = vi.fn();
    const tabs = createWorkspaceTabService({
      maxTabs: 2,
      tabId: (nodeId, workspaceId) => `${nodeId}:${workspaceId}`,
      workspaceLabel: (item) => item.id,
      nodeLabel: (item) => item.displayName ?? item.id,
      onEvict,
      onChange
    });

    tabs.restore([
      { id: 'node-1:a', nodeId: 'node-1', workspaceId: 'a', label: 'a', lastActiveAt: 1 },
      { id: 'node-1:b', nodeId: 'node-1', workspaceId: 'b', label: 'b', lastActiveAt: 2 }
    ]);
    tabs.remember(node.id, node, workspace('c'));

    expect(tabs.tabs.value.map((tab) => tab.workspaceId)).toEqual(['b', 'c']);
    expect(onEvict).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'a' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('appends new tabs and preserves display order when reactivating an existing tab', () => {
    const tabs = createWorkspaceTabService({
      maxTabs: 3,
      tabId: (nodeId, workspaceId) => `${nodeId}:${workspaceId}`,
      workspaceLabel: (item) => item.id,
      nodeLabel: (item) => item.displayName ?? item.id,
      onEvict: vi.fn(),
      onChange: vi.fn()
    });

    tabs.remember(node.id, node, workspace('a'));
    tabs.remember(node.id, node, workspace('b'));
    tabs.remember(node.id, node, workspace('a'));

    expect(tabs.tabs.value.map((tab) => tab.workspaceId)).toEqual(['a', 'b']);
    expect(tabs.tabs.value[0]?.lastActiveAt).toBeGreaterThan(tabs.tabs.value[1]?.lastActiveAt ?? 0);
  });

  it('uses the greatest restored activity time as the subsequent LRU baseline', () => {
    const tabs = createWorkspaceTabService({
      maxTabs: 3,
      tabId: (nodeId, workspaceId) => `${nodeId}:${workspaceId}`,
      workspaceLabel: (item) => item.id,
      nodeLabel: (item) => item.displayName ?? item.id,
      onEvict: vi.fn(),
      onChange: vi.fn()
    });
    tabs.restore([
      { id: 'node-1:a', nodeId: 'node-1', workspaceId: 'a', label: 'a', lastActiveAt: 40 }
    ]);
    tabs.remember(node.id, node, workspace('a'));

    expect(tabs.tabs.value[0]?.lastActiveAt).toBeGreaterThan(40);
  });

  it('preserves the caller-provided Node ID when the Node summary is not in memory', () => {
    const tabs = createWorkspaceTabService({
      maxTabs: 2,
      tabId: (nodeId, workspaceId) => `${nodeId}:${workspaceId}`,
      workspaceLabel: (item) => item.id,
      nodeLabel: (item) => item.displayName ?? item.id,
      onEvict: vi.fn(),
      onChange: vi.fn()
    });

    tabs.remember('removed-node', undefined, workspace('orphan'));

    expect(tabs.tabs.value[0]).toMatchObject({
      id: 'removed-node:orphan',
      nodeId: 'removed-node',
      workspaceId: 'orphan'
    });
  });

  it('preserves the cached Node label when updating a tab without a Node summary', () => {
    const tabs = createWorkspaceTabService({
      maxTabs: 2,
      tabId: (n, w) => `${n}:${w}`,
      workspaceLabel: (item) => item.id,
      nodeLabel: (item) => item.displayName ?? item.id,
      onEvict: vi.fn(),
      onChange: vi.fn()
    });
    tabs.restore([
      {
        id: 'node-1:a',
        nodeId: 'node-1',
        nodeLabel: 'Cached Node',
        workspaceId: 'a',
        label: 'a',
        lastActiveAt: 1
      }
    ]);
    tabs.remember('node-1', undefined, workspace('a'));
    expect(tabs.tabs.value[0]?.nodeLabel).toBe('Cached Node');
  });

  it('changes only display order when reordering tabs and preserves LRU activity times', () => {
    const onChange = vi.fn();
    const tabs = createWorkspaceTabService({
      maxTabs: 3,
      tabId: (n, w) => `${n}:${w}`,
      workspaceLabel: (item) => item.id,
      nodeLabel: (item) => item.displayName ?? item.id,
      onEvict: vi.fn(),
      onChange
    });
    tabs.restore([
      { id: 'node-1:a', nodeId: 'node-1', workspaceId: 'a', label: 'a', lastActiveAt: 10 },
      { id: 'node-1:b', nodeId: 'node-1', workspaceId: 'b', label: 'b', lastActiveAt: 20 },
      { id: 'node-1:c', nodeId: 'node-1', workspaceId: 'c', label: 'c', lastActiveAt: 30 }
    ]);

    tabs.move('node-1:c', 0);

    expect(tabs.tabs.value.map((tab) => tab.workspaceId)).toEqual(['c', 'a', 'b']);
    expect(tabs.tabs.value.map((tab) => tab.lastActiveAt)).toEqual([30, 10, 20]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('moves tabs one position in either direction and ignores boundary or missing targets', () => {
    const onChange = vi.fn();
    const tabs = createWorkspaceTabService({
      maxTabs: 3,
      tabId: (n, w) => `${n}:${w}`,
      workspaceLabel: (item) => item.id,
      nodeLabel: (item) => item.displayName ?? item.id,
      onEvict: vi.fn(),
      onChange
    });
    tabs.restore([
      { id: 'node-1:a', nodeId: 'node-1', workspaceId: 'a', label: 'a', lastActiveAt: 10 },
      { id: 'node-1:b', nodeId: 'node-1', workspaceId: 'b', label: 'b', lastActiveAt: 20 },
      { id: 'node-1:c', nodeId: 'node-1', workspaceId: 'c', label: 'c', lastActiveAt: 30 }
    ]);
    tabs.move('node-1:b', 0);
    expect(tabs.tabs.value.map((tab) => tab.workspaceId)).toEqual(['b', 'a', 'c']);
    tabs.move('node-1:b', 1);
    expect(tabs.tabs.value.map((tab) => tab.workspaceId)).toEqual(['a', 'b', 'c']);
    expect(tabs.tabs.value.map((tab) => tab.lastActiveAt)).toEqual([10, 20, 30]);
    tabs.move('node-1:a', -1);
    tabs.move('node-1:c', 3);
    tabs.move('missing', 0);
    expect(onChange).toHaveBeenCalledTimes(2);
    tabs.remove(tabs.tabs.value[1]!);
    expect(tabs.tabs.value.map((tab) => tab.workspaceId)).toEqual(['a', 'c']);
  });
});
