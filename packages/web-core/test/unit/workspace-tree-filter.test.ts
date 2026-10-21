import { describe, expect, it } from 'vitest';
import type { NodeSummary, Workspace } from '../../src/model/workbench.js';
import { filterWorkspaceTree, groupWorkspaceTree } from '../../src/util/workspace-tree-filter.js';

function node(id: string, displayName: string): NodeSummary {
  return {
    id,
    displayName,
    registeredAddress: '127.0.0.1',
    platform: 'linux',
    architecture: 'x64',
    nodeAppVersion: '0.9.63',
    nodeVersion: 'v24.0.0',
    connected: true,
    disabled: false,
    capabilities: {}
  };
}

function workspace(
  id: string,
  displayName: string,
  path: string,
  groupName?: string | null
): Workspace {
  return {
    id,
    displayName,
    path,
    kind: 'DIRECTORY',
    ...(groupName === undefined ? {} : { groupName })
  };
}

describe('Workspace tree filter', () => {
  const nodes = [node('node-1', 'Engineering Host'), node('node-2', 'Operations')];
  const workspacesByNode: Readonly<Record<string, readonly Workspace[]>> = {
    'node-1': [
      workspace('workspace-1', 'Web Console', '/srv/engineering/web-console', 'Platform'),
      workspace('workspace-2', 'API', '/srv/engineering/api')
    ],
    'node-2': [workspace('workspace-3', 'Runbooks', '/srv/operations/runbooks', 'Operations')]
  };
  const filter = (query: string) =>
    filterWorkspaceTree(
      nodes,
      (nodeId) => workspacesByNode[nodeId] ?? [],
      (value) => value.displayName ?? value.id,
      (value) => value.displayName ?? value.id,
      query
    );

  it('returns every Node and Workspace when the filter is blank', () => {
    expect(filter('   ')).toEqual([
      { node: nodes[0], workspaces: workspacesByNode['node-1'] },
      { node: nodes[1], workspaces: workspacesByNode['node-2'] }
    ]);
  });

  it('keeps the matching Node and only its matching Workspace when filtering by display name', () => {
    expect(filter('console')).toEqual([
      {
        node: nodes[0],
        workspaces: [workspacesByNode['node-1']![0]]
      }
    ]);
  });

  it('matches Workspace paths case-insensitively', () => {
    expect(filter('OPERATIONS/RUN')).toEqual([
      {
        node: nodes[1],
        workspaces: [workspacesByNode['node-2']![0]]
      }
    ]);
  });

  it('keeps a matching Node without unrelated child Workspaces', () => {
    expect(filter(' host ')).toEqual([
      {
        node: nodes[0],
        workspaces: []
      }
    ]);
  });

  it('keeps an address-named Node without unrelated child Workspaces', () => {
    const addressNode = node('node-3', '127.0.0.1');
    const addressWorkspace = workspace('workspace-4', 'Project', '/srv/project');
    expect(
      filterWorkspaceTree(
        [addressNode],
        () => [addressWorkspace],
        (value) => value.displayName ?? value.id,
        (value) => value.displayName ?? value.id,
        '127'
      )
    ).toEqual([{ node: addressNode, workspaces: [] }]);
  });

  it('matches a Workspace group without unrelated Workspaces', () => {
    expect(filter('platform')).toEqual([
      { node: nodes[0], workspaces: [workspacesByNode['node-1']![0]] }
    ]);
  });

  it('puts grouped Workspaces first and ungrouped Workspaces last', () => {
    const first = workspace('workspace-1', 'First', '/first', 'Zebra');
    const second = workspace('workspace-2', 'Second', '/second', 'Alpha');
    const third = workspace('workspace-3', 'Third', '/third', null);
    const fourth = workspace('workspace-4', 'Fourth', '/fourth', 'Alpha');

    expect(groupWorkspaceTree([first, second, third, fourth])).toEqual([
      { groupName: 'Alpha', workspaces: [second, fourth] },
      { groupName: 'Zebra', workspaces: [first] },
      { groupName: null, workspaces: [third] }
    ]);
  });
});
