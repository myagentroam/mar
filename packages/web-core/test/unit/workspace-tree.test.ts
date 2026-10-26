import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceTreeService } from '../../src/service/workspace-tree-service.js';
import type { NodeSummary } from '../../src/model/workbench.js';

function workspace(id: string) {
  return { id, path: `/tmp/${id}`, kind: 'DIRECTORY' as const };
}

describe('Web Workspace Resource Tree State', () => {
  function fixture() {
    const persist = vi.fn();
    const tree = createWorkspaceTreeService({
      persist
    });
    return { tree, persist };
  }

  const nodes = ['a', 'b', 'c'].map((id) => ({ id }) as NodeSummary);

  it('reveals only the target Node without changing cached resources or restricting manual toggles', () => {
    const { tree, persist } = fixture();
    tree.restore(['a'], {});
    tree.cacheWorkspaces('b', [workspace('target')]);
    tree.revealWorkspace({ nodeId: 'b', workspaceId: 'target' });
    const firstIntent = tree.revealTarget.value;
    expect(tree.expandedNodeIds.value).toEqual(['b']);
    expect(firstIntent).toEqual({ nodeId: 'b', workspaceId: 'target' });
    expect(tree.workspacesForNode('b')).toEqual([workspace('target')]);

    tree.toggleNode('b');
    expect(tree.expandedNodeIds.value).toEqual([]);
    tree.toggleNode('a');
    tree.toggleNode('b');
    expect(tree.expandedNodeIds.value).toEqual(['a', 'b']);
    tree.revealWorkspace({ nodeId: 'b', workspaceId: 'target' });
    expect(tree.expandedNodeIds.value).toEqual(['b']);
    expect(tree.revealTarget.value).not.toBe(firstIntent);
    tree.revealWorkspace({ nodeId: 'b', workspaceId: 'target' });
    expect(tree.expandedNodeIds.value).toEqual(['b']);
    expect(persist).not.toHaveBeenCalled();
  });

  it('reads each host resource cache without any foreground Node selection', () => {
    const { tree } = fixture();
    tree.cacheWorkspaces('a', [workspace('workspace-a')]);
    tree.cacheWorkspaces('b', [workspace('workspace-b')]);
    expect(tree.workspacesForNode('a').map((value) => value.id)).toEqual(['workspace-a']);
    expect(tree.workspacesForNode('b').map((value) => value.id)).toEqual(['workspace-b']);
    expect(tree.workspacesForNode('unknown')).toEqual([]);
  });

  it('Restores unique Node positions without mutating facts and appends newly visible Nodes', () => {
    const { tree } = fixture();
    tree.restore(['b'], {}, ['b', 'b', '', 'a', 42] as never);
    expect(tree.nodeOrder.value).toEqual(['b', 'a']);
    expect(tree.orderedNodes(nodes).map((node) => node.id)).toEqual(['b', 'a', 'c']);
    expect(nodes.map((node) => node.id)).toEqual(['a', 'b', 'c']);
    expect(tree.orderedNodes([nodes[2]!, nodes[0]!, nodes[1]!]).map((node) => node.id)).toEqual([
      'b',
      'a',
      'c'
    ]);
    tree.removeNode('b');
    expect(tree.nodeOrder.value).toEqual(['a']);
  });

  it('Moves Nodes through one persistence entry and ignores boundaries and stale targets', () => {
    const { tree, persist } = fixture();
    tree.moveNode(nodes, 'a', 2);
    expect(tree.orderedNodes(nodes).map((node) => node.id)).toEqual(['b', 'c', 'a']);
    tree.moveNode(nodes, 'a', 1);
    expect(tree.nodeOrder.value).toEqual(['b', 'a', 'c']);
    expect(persist).toHaveBeenCalledTimes(2);
    for (const position of [-1, 3, 1.5, NaN, 1]) tree.moveNode(nodes, 'a', position);
    tree.moveNode(nodes, 'missing', 0);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(tree.expandedNodeIds.value).toEqual([]);
  });

  it('Moves Workspaces only among siblings, including ungrouped siblings, without changing groups', () => {
    const { tree, persist } = fixture();
    const values = [
      { ...workspace('a'), groupName: 'team' },
      workspace('u'),
      { ...workspace('b'), groupName: 'team' },
      { ...workspace('c'), groupName: 'other' },
      workspace('v')
    ];
    tree.cacheWorkspaces('node', values);
    tree.moveWorkspace('node', 'a', 1);
    expect(tree.orderedWorkspaces('node').map((item) => item.id)).toEqual([
      'u',
      'b',
      'a',
      'c',
      'v'
    ]);
    tree.moveWorkspace('node', 'v', -1);
    expect(
      tree
        .orderedWorkspaces('node')
        .filter((item) => !item.groupName)
        .map((item) => item.id)
    ).toEqual(['v', 'u']);
    for (const [id, direction] of [
      ['b', -1],
      ['a', 1],
      ['c', 1],
      ['missing', -1]
    ] as const)
      tree.moveWorkspace('node', id, direction);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(tree.workspacesForNode('node')).toEqual(values);
    tree.cacheWorkspaces('node', values);
    expect(
      tree
        .orderedWorkspaces('node')
        .filter((item) => item.groupName === 'team')
        .map((item) => item.id)
    ).toEqual(['b', 'a']);
  });

  it('Merging discovery results preserves existing order and appends new Workspaces', () => {
    const tree = createWorkspaceTreeService({
      persist: vi.fn()
    });
    tree.restore([], { 'node-1': ['b', 'a'] });

    tree.cacheWorkspaces('node-1', [workspace('a'), workspace('b'), workspace('c')]);

    expect(tree.orderedWorkspaces('node-1').map((item) => item.id)).toEqual(['b', 'a', 'c']);
  });

  it('Drag reordering persists only for a valid target on the same Node', () => {
    const persist = vi.fn();
    const tree = createWorkspaceTreeService({
      persist
    });
    tree.cacheWorkspaces('node-1', [workspace('a'), workspace('b')]);
    tree.draggingWorkspace.value = { nodeId: 'node-1', workspaceId: 'a' };

    tree.reorder('node-1', 'b');

    expect(tree.orderedWorkspaces('node-1').map((item) => item.id)).toEqual(['b', 'a']);
    expect(persist).toHaveBeenCalledOnce();
    expect(tree.draggingWorkspace.value).toBeUndefined();
  });

  it.each([
    ['a', 'b', 'before', ['a', 'b', 'c'], 0],
    ['a', 'b', 'after', ['b', 'a', 'c'], 1],
    ['c', 'a', 'before', ['c', 'a', 'b'], 1],
    ['c', 'a', 'after', ['a', 'c', 'b'], 1],
    ['b', 'c', 'after', ['a', 'c', 'b'], 1],
    ['b', 'a', 'before', ['b', 'a', 'c'], 1]
  ] as const)(
    'Places %s %s %s without off-by-one moves',
    (source, target, position, expected, writes) => {
      const { tree, persist } = fixture();
      tree.cacheWorkspaces('node', ['a', 'b', 'c'].map(workspace));
      tree.startDrag({ dataTransfer: null } as DragEvent, 'node', source);
      tree.reorder('node', target, position);
      expect(tree.orderedWorkspaces('node').map((item) => item.id)).toEqual(expected);
      expect(persist).toHaveBeenCalledTimes(writes);
      expect(tree.draggingWorkspace.value).toBeUndefined();
    }
  );

  it('Removing a host clears only its own resource-tree cache and ordering', () => {
    const tree = createWorkspaceTreeService({
      persist: vi.fn()
    });
    tree.cacheWorkspaces('node-2', [workspace('cached')]);
    tree.restore(['node-1', 'node-2'], { 'node-2': ['cached'] });

    expect(tree.workspacesForNode('node-1')).toEqual([]);
    tree.cacheWorkspaces('node-1', [workspace('cached-selected')]);
    expect(tree.workspacesForNode('node-1')).toEqual([workspace('cached-selected')]);
    tree.removeNode('node-2');

    expect(tree.workspacesByNode.value['node-2']).toBeUndefined();
    expect(tree.workspaceOrderByNode.value['node-2']).toBeUndefined();
    expect(tree.expandedNodeIds.value).toEqual(['node-1']);
  });
});
