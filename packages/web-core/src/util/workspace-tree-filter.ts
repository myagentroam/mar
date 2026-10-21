import type { NodeSummary, Workspace } from '../model/workbench.js';

export interface FilteredWorkspaceTreeNode {
  readonly node: NodeSummary;
  readonly workspaces: readonly Workspace[];
}

export interface GroupedWorkspaceTree {
  readonly groupName: string | null;
  readonly workspaces: readonly Workspace[];
}

export function filterWorkspaceTree(
  nodes: readonly NodeSummary[],
  workspaces: (nodeId: string) => readonly Workspace[],
  nodeLabel: (node: NodeSummary) => string,
  workspaceLabel: (workspace: Workspace) => string,
  query: string
): readonly FilteredWorkspaceTreeNode[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0)
    return nodes.map((node) => ({ node, workspaces: workspaces(node.id) }));

  return nodes.flatMap((node) => {
    const nodeMatches = includesQuery(nodeLabel(node), normalizedQuery);
    const nodeWorkspaces = workspaces(node.id);
    const matchedWorkspaces = nodeWorkspaces.filter(
      (workspace) =>
        includesQuery(workspaceLabel(workspace), normalizedQuery) ||
        includesQuery(workspace.path, normalizedQuery) ||
        includesQuery(workspace.groupName ?? '', normalizedQuery)
    );
    return nodeMatches || matchedWorkspaces.length > 0
      ? [{ node, workspaces: matchedWorkspaces }]
      : [];
  });
}

export function groupWorkspaceTree(
  workspaces: readonly Workspace[]
): readonly GroupedWorkspaceTree[] {
  const groups = new Map<string | null, Workspace[]>();
  for (const workspace of workspaces) {
    const groupName = workspace.groupName?.trim() || null;
    const values = groups.get(groupName) ?? [];
    values.push(workspace);
    groups.set(groupName, values);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => {
      if (left === null) return right === null ? 0 : 1;
      if (right === null) return -1;
      return left.localeCompare(right);
    })
    .map(([groupName, values]) => ({ groupName, workspaces: values }));
}

function includesQuery(value: string, normalizedQuery: string): boolean {
  return value.toLocaleLowerCase().includes(normalizedQuery);
}
