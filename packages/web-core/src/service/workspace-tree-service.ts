import { ref } from 'vue';
import type { NodeSummary, Workspace, WorkspaceTarget } from '../model/workbench.js';

export interface WorkspaceTreeStateOptions {
  readonly persist: () => void;
}

export function createWorkspaceTreeService(options: WorkspaceTreeStateOptions) {
  const expandedNodeIds = ref<string[]>([]);
  const revealTarget = ref<WorkspaceTarget>();
  const nodeOrder = ref<readonly string[]>([]);
  const workspacesByNode = ref<Record<string, readonly Workspace[]>>({});
  const workspaceOrderByNode = ref<Record<string, readonly string[]>>({});
  const draggingWorkspace = ref<{ readonly nodeId: string; readonly workspaceId: string }>();

  function restore(
    expandedIds: readonly string[],
    orderByNode: Readonly<Record<string, readonly string[]>>,
    orderedNodeIds: readonly string[] = []
  ): void {
    expandedNodeIds.value = [...expandedIds];
    nodeOrder.value = [
      ...new Set(orderedNodeIds.filter((id) => typeof id === 'string' && id.length > 0))
    ];
    workspaceOrderByNode.value = Object.fromEntries(
      Object.entries(orderByNode).flatMap(([nodeId, values]) =>
        typeof nodeId === 'string' && Array.isArray(values)
          ? [[nodeId, values.filter((id): id is string => typeof id === 'string')] as const]
          : []
      )
    );
  }

  function orderedNodes(nodes: readonly NodeSummary[]): readonly NodeSummary[] {
    const positions = new Map(nodeOrder.value.map((id, index) => [id, index]));
    return [...nodes].sort(
      (left, right) =>
        (positions.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (positions.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    );
  }

  function moveNode(nodes: readonly NodeSummary[], nodeId: string, targetIndex: number): void {
    const order = orderedNodes(nodes).map((node) => node.id);
    const from = order.indexOf(nodeId);
    if (
      !Number.isInteger(targetIndex) ||
      from < 0 ||
      targetIndex < 0 ||
      targetIndex >= order.length ||
      from === targetIndex
    )
      return;
    order.splice(from, 1);
    order.splice(targetIndex, 0, nodeId);
    nodeOrder.value = order;
    options.persist();
  }

  function cacheWorkspaces(nodeId: string, values: readonly Workspace[]): void {
    workspacesByNode.value = { ...workspacesByNode.value, [nodeId]: values };
    const ids = values.map((workspace) => workspace.id);
    const previous = workspaceOrderByNode.value[nodeId] ?? [];
    workspaceOrderByNode.value = {
      ...workspaceOrderByNode.value,
      [nodeId]: [
        ...previous.filter((workspaceId) => ids.includes(workspaceId)),
        ...ids.filter((workspaceId) => !previous.includes(workspaceId))
      ]
    };
  }

  function workspacesForNode(nodeId: string): readonly Workspace[] {
    return workspacesByNode.value[nodeId] ?? [];
  }

  function orderedWorkspaces(nodeId: string): readonly Workspace[] {
    const order = workspaceOrderByNode.value[nodeId] ?? [];
    const positions = new Map(order.map((workspaceId, index) => [workspaceId, index]));
    return [...workspacesForNode(nodeId)].sort(
      (left, right) =>
        (positions.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (positions.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    );
  }

  function toggleNode(nodeId: string): boolean {
    if (expandedNodeIds.value.includes(nodeId)) {
      expandedNodeIds.value = expandedNodeIds.value.filter((id) => id !== nodeId);
      return false;
    }
    expandedNodeIds.value = [...expandedNodeIds.value, nodeId];
    return true;
  }

  function revealWorkspace(target: WorkspaceTarget): void {
    if (expandedNodeIds.value.length !== 1 || expandedNodeIds.value[0] !== target.nodeId)
      expandedNodeIds.value = [target.nodeId];
    // A fresh intent also reveals an already active Tab without reactivating it.
    revealTarget.value = { nodeId: target.nodeId, workspaceId: target.workspaceId };
  }

  function startDrag(event: DragEvent, nodeId: string, workspaceId: string): void {
    draggingWorkspace.value = { nodeId, workspaceId };
    const transfer = event.dataTransfer;
    if (transfer === null) return;
    transfer.setData('text/plain', workspaceId);
    transfer.effectAllowed = 'move';
  }

  function endDrag(): void {
    draggingWorkspace.value = undefined;
  }

  function reorder(nodeId: string, targetId: string, position?: 'before' | 'after'): void {
    const dragging = draggingWorkspace.value;
    endDrag();
    if (dragging === undefined || dragging.nodeId !== nodeId || dragging.workspaceId === targetId)
      return;
    setWorkspacePosition(nodeId, dragging.workspaceId, targetId, position);
  }

  function moveWorkspace(nodeId: string, workspaceId: string, direction: -1 | 1): void {
    const values = orderedWorkspaces(nodeId);
    const source = values.find((workspace) => workspace.id === workspaceId);
    if (source === undefined || (direction !== -1 && direction !== 1)) return;
    const groupName = source.groupName?.trim() || null;
    const siblings = values.filter(
      (workspace) => (workspace.groupName?.trim() || null) === groupName
    );
    const target = siblings[siblings.indexOf(source) + direction];
    if (target !== undefined) setWorkspacePosition(nodeId, workspaceId, target.id);
  }

  function setWorkspacePosition(
    nodeId: string,
    workspaceId: string,
    targetId: string,
    position?: 'before' | 'after'
  ): void {
    const order = orderedWorkspaces(nodeId).map((workspace) => workspace.id);
    const from = order.indexOf(workspaceId);
    const to = order.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    const insertionIndex =
      position === undefined ? to : to + (position === 'after' ? 1 : 0) - (from < to ? 1 : 0);
    if (insertionIndex === from) return;
    order.splice(from, 1);
    order.splice(insertionIndex, 0, workspaceId);
    workspaceOrderByNode.value = { ...workspaceOrderByNode.value, [nodeId]: order };
    options.persist();
  }

  function removeNode(nodeId: string): void {
    nodeOrder.value = nodeOrder.value.filter((id) => id !== nodeId);
    const cachedWorkspaces = { ...workspacesByNode.value };
    delete cachedWorkspaces[nodeId];
    workspacesByNode.value = cachedWorkspaces;
    const cachedOrder = { ...workspaceOrderByNode.value };
    delete cachedOrder[nodeId];
    workspaceOrderByNode.value = cachedOrder;
    expandedNodeIds.value = expandedNodeIds.value.filter((id) => id !== nodeId);
  }

  return {
    expandedNodeIds,
    revealTarget,
    revealWorkspace,
    nodeOrder,
    orderedNodes,
    moveNode,
    moveWorkspace,
    workspacesByNode,
    workspaceOrderByNode,
    draggingWorkspace,
    restore,
    cacheWorkspaces,
    workspacesForNode,
    orderedWorkspaces,
    toggleNode,
    startDrag,
    endDrag,
    reorder,
    removeNode
  };
}
