<script setup lang="ts">
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import MarIcon from '../common/MarIcon.vue';
import { marIcon } from '../../util/mar-icons.js';
import { computed, nextTick, ref, watch } from 'vue';
import type { NodeSummary, Workspace, WorkspaceTarget } from '../../model/workbench.js';
import { translate } from '../../service/locale-preference-service.js';
import { filterWorkspaceTree, groupWorkspaceTree } from '../../util/workspace-tree-filter.js';

const props = defineProps<{
  readonly nodes: readonly NodeSummary[];
  readonly expandedNodeIds: readonly string[];
  readonly workspaceTarget: WorkspaceTarget | undefined;
  readonly revealTarget?: WorkspaceTarget | undefined;
  readonly visible?: boolean;
  readonly draggingWorkspace: { readonly nodeId: string; readonly workspaceId: string } | undefined;
  readonly mobileViewport: boolean;
  readonly loading: boolean;
  readonly nodeLabel: (node: NodeSummary) => string;
  readonly workspaceLabel: (workspace: Workspace) => string;
  readonly workspaces: (nodeId: string) => readonly Workspace[];
}>();
const filterQuery = ref('');
const nodeTreeElement = ref<HTMLElement>();
const animateBranches = ref(false);

function enableBranchMotion(): void {
  animateBranches.value = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Only the render caused by an explicit toggle should animate.
  void nextTick(() => (animateBranches.value = false));
}

function enterBranch(element: Element): void {
  const branch = element as HTMLElement;
  branch.inert = false;
  branch.style.setProperty('--workspace-branch-height', `${branch.scrollHeight}px`);
}

function leaveBranch(element: Element): void {
  const branch = element as HTMLElement;
  branch.style.setProperty(
    '--workspace-branch-height',
    `${branch.getBoundingClientRect().height}px`
  );
  branch.inert = true;
}

function finishBranchMotion(element: Element): void {
  const branch = element as HTMLElement;
  branch.style.removeProperty('--workspace-branch-height');
  branch.inert = false;
}

const filterActive = computed(() => filterQuery.value.trim().length > 0);
const filteredNodes = computed(() =>
  filterWorkspaceTree(
    props.nodes,
    props.workspaces,
    props.nodeLabel,
    props.workspaceLabel,
    filterQuery.value
  )
);
const groupedNodes = computed(() =>
  filteredNodes.value.map((result) => ({
    ...result,
    groups: groupWorkspaceTree(result.workspaces)
  }))
);
const nodeExpanded = (nodeId: string) =>
  filterActive.value || props.expandedNodeIds.includes(nodeId);
const expandedWorkspaceGroupKeys = ref<readonly string[]>([]);
const workspaceDropTargetKey = ref<string>();
const workspaceDropPosition = ref<'before' | 'after'>();
const workspaceGroupDropTargetKey = ref<string>();
const draggingNodeId = ref<string>();
const nodeDropTargetId = ref<string>();
const nodeDropPosition = ref<'before' | 'after'>();
const workspaceNodeDropTargetId = ref<string>();
const nodeDragEnabled = computed(() => !props.mobileViewport && !filterActive.value);
const hoveredNodeId = ref<string>();
const focusedNodeId = ref<string>();
const hoveredWorkspaceKey = ref<string>();
const focusedWorkspaceKey = ref<string>();
const openNodeActionsId = ref<string>();
const openWorkspaceActionsKey = ref<string>();
const workspaceGroupMoveDialogVisible = ref(false);
const workspaceGroupMoveTarget = ref<{ readonly nodeId: string; readonly workspace: Workspace }>();
const workspaceGroupMoveName = ref<string | undefined>('');

function workspaceGroupKey(nodeId: string, groupName: string): string {
  return `${nodeId}:${groupName}`;
}

function workspaceKey(nodeId: string, workspaceId: string): string {
  return `${nodeId}:${workspaceId}`;
}

function canOrganizeWorkspaceGroups(node: NodeSummary): boolean {
  return node.workspaceCreatable === true;
}

function workspaceDropEnabled(node: NodeSummary, target?: Workspace): boolean {
  const dragging = props.draggingWorkspace;
  if (!nodeDragEnabled.value || dragging?.nodeId !== node.id) return false;
  const source = props
    .workspaces(node.id)
    .find((workspace) => workspace.id === dragging.workspaceId);
  if (source === undefined || source.id === target?.id) return false;
  return (
    target === undefined ||
    canOrganizeWorkspaceGroups(node) ||
    (source.groupName?.trim() || null) === (target.groupName?.trim() || null)
  );
}

function setWorkspaceDropTarget(event: DragEvent, node: NodeSummary, workspace: Workspace): void {
  clearWorkspaceDropTargets();
  if (!workspaceDropEnabled(node, workspace)) return;
  event.preventDefault();
  workspaceDropTargetKey.value = workspaceKey(node.id, workspace.id);
  const source = props
    .workspaces(node.id)
    .find((item) => item.id === props.draggingWorkspace?.workspaceId);
  if ((source?.groupName?.trim() || null) === (workspace.groupName?.trim() || null))
    workspaceDropPosition.value = dropPosition(event);
}

function setWorkspaceGroupDropTarget(event: DragEvent, node: NodeSummary, groupName: string): void {
  clearWorkspaceDropTargets();
  if (!workspaceDropEnabled(node) || !canOrganizeWorkspaceGroups(node)) return;
  event.preventDefault();
  workspaceGroupDropTargetKey.value = workspaceGroupKey(node.id, groupName);
}

function leaveWorkspaceDropTarget(event: DragEvent): void {
  const row = event.currentTarget as HTMLElement;
  if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return;
  clearWorkspaceDropTargets();
}

function clearWorkspaceDropTargets(): void {
  workspaceDropTargetKey.value = undefined;
  workspaceDropPosition.value = undefined;
  workspaceGroupDropTargetKey.value = undefined;
  workspaceNodeDropTargetId.value = undefined;
}
function groupExpanded(nodeId: string, groupName: string): boolean {
  return (
    filterActive.value ||
    expandedWorkspaceGroupKeys.value.includes(workspaceGroupKey(nodeId, groupName))
  );
}
function toggleGroup(nodeId: string, groupName: string): void {
  enableBranchMotion();
  const key = workspaceGroupKey(nodeId, groupName);
  expandedWorkspaceGroupKeys.value = expandedWorkspaceGroupKeys.value.includes(key)
    ? expandedWorkspaceGroupKeys.value.filter((value) => value !== key)
    : [...expandedWorkspaceGroupKeys.value, key];
}

const revealGroupName = computed(() => {
  const target = props.revealTarget;
  if (
    target === undefined ||
    target.nodeId !== props.workspaceTarget?.nodeId ||
    target.workspaceId !== props.workspaceTarget.workspaceId
  )
    return undefined;
  const workspace = props
    .workspaces(target.nodeId)
    .find((value) => value.id === target.workspaceId);
  return workspace === undefined ? undefined : workspace.groupName?.trim() || '';
});

watch(
  [() => props.revealTarget, revealGroupName],
  ([target, groupName]) => {
    if (target === undefined || groupName === undefined) return;
    expandedWorkspaceGroupKeys.value = groupName
      ? [workspaceGroupKey(target.nodeId, groupName)]
      : [];
  },
  { immediate: true }
);

watch(
  [() => props.revealTarget, revealGroupName, () => props.visible],
  async (_value, _previous, onCleanup) => {
    let cancelled = false;
    onCleanup(() => (cancelled = true));
    await nextTick();
    if (cancelled || props.visible === false || revealGroupName.value === undefined) return;
    const row = nodeTreeElement.value?.querySelector<HTMLElement>(
      '.workspace-branches li.selected > .workspace-branch-button'
    );
    if (row?.getClientRects().length)
      row.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  },
  { immediate: true, flush: 'post' }
);

const workspaceGroupMoveOptions = computed(() => {
  const target = workspaceGroupMoveTarget.value;
  if (target === undefined) return [];
  return groupWorkspaceTree(props.workspaces(target.nodeId))
    .map((group) => group.groupName)
    .filter((groupName): groupName is string => groupName !== null);
});

const workspaceGroupMoveNameTooLong = computed(
  () => (workspaceGroupMoveName.value?.trim().length ?? 0) > 128
);

function openWorkspaceGroupMoveDialog(nodeId: string, workspace: Workspace): void {
  workspaceGroupMoveTarget.value = { nodeId, workspace };
  workspaceGroupMoveName.value = workspace.groupName?.trim() ?? '';
  workspaceGroupMoveDialogVisible.value = true;
}

function closeWorkspaceGroupMoveDialog(): void {
  workspaceGroupMoveDialogVisible.value = false;
  workspaceGroupMoveTarget.value = undefined;
  workspaceGroupMoveName.value = '';
}

function saveWorkspaceGroupMove(): void {
  const target = workspaceGroupMoveTarget.value;
  if (target === undefined || workspaceGroupMoveNameTooLong.value) return;
  const groupName = workspaceGroupMoveName.value?.trim() || null;
  emit('moveWorkspaceGroup', target.nodeId, target.workspace, groupName);
  closeWorkspaceGroupMoveDialog();
}

const emit = defineEmits<{
  moveNode: [nodeId: string, targetIndex: number];
  moveWorkspace: [nodeId: string, workspaceId: string, direction: -1 | 1];
  toggleNode: [nodeId: string];
  refreshNodeWorkspaces: [nodeId: string];
  addWorkspace: [nodeId: string];
  openNodeDetails: [node: NodeSummary];
  openWorkspace: [nodeId: string, workspaceId: string];
  startWorkspaceDrag: [event: DragEvent, nodeId: string, workspaceId: string];
  endWorkspaceDrag: [];
  reorderWorkspace: [nodeId: string, workspace: Workspace, position: 'before' | 'after'];
  moveWorkspaceToGroup: [nodeId: string, groupName: string | null];
  moveWorkspaceGroup: [nodeId: string, workspace: Workspace, groupName: string | null];
  removeWorkspace: [nodeId: string, workspace: Workspace];
  openWorkspaceDetails: [nodeId: string, workspace: Workspace];
  renameWorkspace: [nodeId: string, workspace: Workspace];
}>();

function nodeCommand(node: NodeSummary, command: string): void {
  if (command === 'details') emit('openNodeDetails', node);
  else if (command === 'add') emit('addWorkspace', node.id);
  else if (command === 'refresh') emit('refreshNodeWorkspaces', node.id);
  else if (!filterActive.value && (command === 'up' || command === 'down'))
    emit(
      'moveNode',
      node.id,
      props.nodes.findIndex((item) => item.id === node.id) + (command === 'up' ? -1 : 1)
    );
}

function startNodeDrag(event: DragEvent, nodeId: string): void {
  if (!nodeDragEnabled.value) {
    event.preventDefault();
    return;
  }
  draggingNodeId.value = nodeId;
  if (event.dataTransfer !== null) {
    event.dataTransfer.setData('application/x-mar-node', nodeId);
    event.dataTransfer.effectAllowed = 'move';
  }
}

function endNodeDrag(): void {
  draggingNodeId.value = undefined;
  nodeDropTargetId.value = undefined;
  nodeDropPosition.value = undefined;
}

function dragOverNode(event: DragEvent, node: NodeSummary): void {
  if (workspaceDropEnabled(node) && canOrganizeWorkspaceGroups(node)) {
    event.preventDefault();
    clearWorkspaceDropTargets();
    workspaceNodeDropTargetId.value = node.id;
    return;
  }
  if (
    !nodeDragEnabled.value ||
    draggingNodeId.value === undefined ||
    draggingNodeId.value === node.id
  )
    return;
  event.preventDefault();
  nodeDropTargetId.value = node.id;
  nodeDropPosition.value = dropPosition(event);
}

function dropPosition(event: DragEvent): 'before' | 'after' {
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
}

function leaveNode(event: DragEvent): void {
  const row = event.currentTarget as HTMLElement;
  if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return;
  nodeDropTargetId.value = undefined;
  nodeDropPosition.value = undefined;
  clearWorkspaceDropTargets();
}

function dropNode(event: DragEvent, node: NodeSummary): void {
  if (workspaceDropEnabled(node) && canOrganizeWorkspaceGroups(node)) {
    moveWorkspaceToGroup(node, null);
    return;
  }
  const sourceId = draggingNodeId.value;
  endNodeDrag();
  if (!nodeDragEnabled.value || sourceId === undefined || sourceId === node.id) return;
  const from = props.nodes.findIndex((item) => item.id === sourceId);
  const to = props.nodes.findIndex((item) => item.id === node.id);
  if (from < 0 || to < 0) return;
  const insertionIndex = to + (dropPosition(event) === 'after' ? 1 : 0);
  emit('moveNode', sourceId, insertionIndex - (from < insertionIndex ? 1 : 0));
}

function workspaceCommand(node: NodeSummary, workspace: Workspace, command: string): void {
  if (command === 'details') emit('openWorkspaceDetails', node.id, workspace);
  else if (command === 'rename') emit('renameWorkspace', node.id, workspace);
  else if (command === 'delete') emit('removeWorkspace', node.id, workspace);
  else if (command === 'move-group') openWorkspaceGroupMoveDialog(node.id, workspace);
  else if (!filterActive.value && (command === 'up' || command === 'down'))
    emit('moveWorkspace', node.id, workspace.id, command === 'up' ? -1 : 1);
}

function startWorkspaceDrag(event: DragEvent, node: NodeSummary, workspace: Workspace): void {
  if (!nodeDragEnabled.value) {
    event.preventDefault();
    return;
  }
  emit('startWorkspaceDrag', event, node.id, workspace.id);
}

function reorderWorkspace(event: DragEvent, node: NodeSummary, workspace: Workspace): void {
  clearWorkspaceDropTargets();
  if (workspaceDropEnabled(node, workspace))
    emit('reorderWorkspace', node.id, workspace, dropPosition(event));
}

function moveWorkspaceToGroup(node: NodeSummary, groupName: string | null): void {
  clearWorkspaceDropTargets();
  if (workspaceDropEnabled(node) && canOrganizeWorkspaceGroups(node))
    emit('moveWorkspaceToGroup', node.id, groupName);
}

function nodeActionsVisible(nodeId: string): boolean {
  return (
    props.mobileViewport ||
    hoveredNodeId.value === nodeId ||
    focusedNodeId.value === nodeId ||
    openNodeActionsId.value === nodeId
  );
}

function workspaceActionsVisible(nodeId: string, workspaceId: string): boolean {
  const key = workspaceKey(nodeId, workspaceId);
  return (
    props.mobileViewport ||
    hoveredWorkspaceKey.value === key ||
    focusedWorkspaceKey.value === key ||
    openWorkspaceActionsKey.value === key
  );
}

function clearFocus(event: FocusEvent, clear: () => void): void {
  const target = event.currentTarget;
  if (
    target instanceof HTMLElement &&
    event.relatedTarget instanceof Node &&
    target.contains(event.relatedTarget)
  )
    return;
  clear();
}

function triggerNodeActions(nodeId: string, target: HTMLElement): void {
  hoveredNodeId.value = nodeId;
  void nextTick(() => target.querySelector<HTMLButtonElement>('.tree-more-button')?.click());
}

function triggerWorkspaceActions(nodeId: string, workspaceId: string, target: HTMLElement): void {
  hoveredWorkspaceKey.value = workspaceKey(nodeId, workspaceId);
  void nextTick(() => target.querySelector<HTMLButtonElement>('.tree-more-button')?.click());
}

function openNodeActions(event: MouseEvent, nodeId: string): void {
  event.preventDefault();
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  triggerNodeActions(nodeId, target);
}

function openWorkspaceActions(event: MouseEvent, nodeId: string, workspaceId: string): void {
  event.preventDefault();
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  triggerWorkspaceActions(nodeId, workspaceId, target);
}

function toggleTreeNode(nodeId: string): void {
  enableBranchMotion();
  emit('toggleNode', nodeId);
}

function selectWorkspace(nodeId: string, workspaceId: string): void {
  emit('openWorkspace', nodeId, workspaceId);
}
</script>

<template>
  <template v-if="nodes.length">
    <div class="workspace-tree-filter">
      <el-input
        v-model="filterQuery"
        clearable
        :aria-label="translate('generated.workspaceTree.filterNodeWorkspaces')"
        :placeholder="translate('generated.workspaceTree.filterNodeWorkspaces')"
        size="small"
        :clear-icon="marIcon('clear-input')"
      >
        <template #prefix><MarIcon name="search" /></template>
      </el-input>
    </div>
    <ul v-if="filteredNodes.length" ref="nodeTreeElement" class="node-tree">
      <li v-for="(result, nodeIndex) in groupedNodes" :key="result.node.id">
        <div
          :class="[
            'tree-node-row',
            {
              dragging: draggingNodeId === result.node.id,
              'drop-before': nodeDropTargetId === result.node.id && nodeDropPosition === 'before',
              'drop-after': nodeDropTargetId === result.node.id && nodeDropPosition === 'after',
              'drop-target': workspaceNodeDropTargetId === result.node.id,
              'actions-visible': nodeActionsVisible(result.node.id)
            }
          ]"
          @mouseenter="hoveredNodeId = result.node.id"
          @mouseleave="hoveredNodeId = undefined"
          @focusin="focusedNodeId = result.node.id"
          @focusout="clearFocus($event, () => (focusedNodeId = undefined))"
          @contextmenu="openNodeActions($event, result.node.id)"
          @dragover.stop="dragOverNode($event, result.node)"
          @dragleave="leaveNode"
          @drop.prevent.stop="dropNode($event, result.node)"
        >
          <button
            v-if="!filterActive"
            :class="['node-expand-button', { expanded: expandedNodeIds.includes(result.node.id) }]"
            :aria-expanded="nodeExpanded(result.node.id)"
            :aria-label="
              expandedNodeIds.includes(result.node.id)
                ? translate('generated.workspaceTree.collapseWorkspaces')
                : translate('generated.workspaceTree.expandWorkspaces')
            "
            type="button"
            @click="toggleTreeNode(result.node.id)"
          >
            <MarIcon name="chevron-right" class="tree-chevron" />
          </button>
          <span v-else class="node-expand-spacer" aria-hidden="true" />
          <button
            v-tooltip="nodeLabel(result.node)"
            :aria-label="nodeLabel(result.node)"
            class="tree-node"
            :draggable="nodeDragEnabled"
            @dragstart.stop="startNodeDrag($event, result.node.id)"
            @dragend.stop="endNodeDrag"
            type="button"
            @click="toggleTreeNode(result.node.id)"
          >
            <span class="tree-node-content">
              <span class="tree-node-icon" aria-hidden="true">
                <MarIcon name="node" class="tree-type-icon" />
                <span
                  :class="[
                    'state-dot',
                    result.node.connected && !result.node.disabled ? 'ready' : 'offline'
                  ]"
                />
              </span>
              <span>{{ nodeLabel(result.node) }}</span>
            </span>
          </button>
          <el-dropdown
            v-if="nodeActionsVisible(result.node.id)"
            class="tree-row-menu node-tree-actions"
            trigger="click"
            @command="nodeCommand(result.node, $event)"
            @visible-change="openNodeActionsId = $event ? result.node.id : undefined"
          >
            <button
              class="tree-more-button utility-control"
              :aria-label="translate('generated.workspaceTree.nodeActions')"
              type="button"
              @click.stop
            >
              <MarIcon name="more" />
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="details" :icon="marIcon('view')">{{
                  translate('generated.workspaceTree.nodeDetails')
                }}</el-dropdown-item>
                <el-dropdown-item
                  command="up"
                  :icon="marIcon('chevron-up')"
                  :disabled="filterActive || nodeIndex === 0"
                  >{{ translate('generated.workspaceTree.moveUp') }}</el-dropdown-item
                >
                <el-dropdown-item
                  command="down"
                  :icon="marIcon('chevron-down')"
                  :disabled="filterActive || nodeIndex === groupedNodes.length - 1"
                  >{{ translate('generated.workspaceTree.moveDown') }}</el-dropdown-item
                >
                <el-dropdown-item command="refresh" :icon="marIcon('refresh')">{{
                  translate('generated.workspaceTree.refreshWorkspaces')
                }}</el-dropdown-item>
                <el-dropdown-item
                  command="add"
                  :icon="marIcon('folder-add')"
                  :disabled="
                    result.node.disabled ||
                    !result.node.connected ||
                    (result.node.workspaceCreatable ?? result.node.manageable) === false
                  "
                  >{{ translate('generated.workspaceTree.addWorkspace') }}</el-dropdown-item
                >
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
        <!-- Reset branch motion when entering or leaving filter mode. -->
        <Transition
          :key="filterActive ? 'filtered' : 'browsing'"
          name="workspace-branch"
          :css="animateBranches"
          @enter="enterBranch"
          @before-leave="leaveBranch"
          @after-enter="finishBranchMotion"
          @after-leave="finishBranchMotion"
        >
          <ul v-if="nodeExpanded(result.node.id)" class="workspace-branches">
            <template v-for="group in result.groups" :key="group.groupName ?? '__ungrouped__'">
              <template v-if="group.groupName === null">
                <li
                  v-for="(workspace, workspaceIndex) in group.workspaces"
                  :key="workspace.id"
                  :class="{
                    dragging: draggingWorkspace?.workspaceId === workspace.id,
                    'drop-target':
                      workspaceDropTargetKey === workspaceKey(result.node.id, workspace.id) &&
                      workspaceDropPosition === undefined,
                    'drop-before':
                      workspaceDropTargetKey === workspaceKey(result.node.id, workspace.id) &&
                      workspaceDropPosition === 'before',
                    'drop-after':
                      workspaceDropTargetKey === workspaceKey(result.node.id, workspace.id) &&
                      workspaceDropPosition === 'after',
                    selected:
                      workspaceTarget?.nodeId === result.node.id &&
                      workspaceTarget.workspaceId === workspace.id
                  }"
                  :draggable="nodeDragEnabled"
                  @mouseenter="hoveredWorkspaceKey = workspaceKey(result.node.id, workspace.id)"
                  @mouseleave="hoveredWorkspaceKey = undefined"
                  @focusin="focusedWorkspaceKey = workspaceKey(result.node.id, workspace.id)"
                  @focusout="clearFocus($event, () => (focusedWorkspaceKey = undefined))"
                  @contextmenu="openWorkspaceActions($event, result.node.id, workspace.id)"
                  @dragend.stop="
                    clearWorkspaceDropTargets();
                    emit('endWorkspaceDrag');
                  "
                  @dragenter.stop="setWorkspaceDropTarget($event, result.node, workspace)"
                  @dragleave.stop="leaveWorkspaceDropTarget"
                  @dragover.stop="setWorkspaceDropTarget($event, result.node, workspace)"
                  @drop.prevent.stop="reorderWorkspace($event, result.node, workspace)"
                  @dragstart.stop="startWorkspaceDrag($event, result.node, workspace)"
                >
                  <button
                    v-tooltip="workspaceLabel(workspace)"
                    :aria-label="workspaceLabel(workspace)"
                    :class="{
                      selected:
                        workspaceTarget?.nodeId === result.node.id &&
                        workspaceTarget.workspaceId === workspace.id
                    }"
                    class="workspace-branch-button"
                    type="button"
                    @click="selectWorkspace(result.node.id, workspace.id)"
                  >
                    <span class="workspace-branch-content">
                      <span>{{ workspaceLabel(workspace) }}</span>
                    </span>
                  </button>
                  <el-dropdown
                    v-if="workspaceActionsVisible(result.node.id, workspace.id)"
                    class="tree-row-menu workspace-row-actions"
                    trigger="click"
                    @command="workspaceCommand(result.node, workspace, $event)"
                    @visible-change="
                      openWorkspaceActionsKey = $event
                        ? workspaceKey(result.node.id, workspace.id)
                        : undefined
                    "
                  >
                    <button
                      class="tree-more-button utility-control"
                      :aria-label="translate('generated.workspaceTree.workspaceActions')"
                      type="button"
                      @click.stop
                    >
                      <MarIcon name="more" />
                    </button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item command="details" :icon="marIcon('view')">{{
                          translate('generated.workspaceTree.workspaceDetails')
                        }}</el-dropdown-item>
                        <el-dropdown-item
                          command="up"
                          :icon="marIcon('chevron-up')"
                          :disabled="filterActive || workspaceIndex === 0"
                          >{{ translate('generated.workspaceTree.moveUp') }}</el-dropdown-item
                        >
                        <el-dropdown-item
                          command="down"
                          :icon="marIcon('chevron-down')"
                          :disabled="filterActive || workspaceIndex === group.workspaces.length - 1"
                          >{{ translate('generated.workspaceTree.moveDown') }}</el-dropdown-item
                        >
                        <el-dropdown-item
                          command="rename"
                          :icon="marIcon('edit')"
                          :disabled="workspace.manageable === false"
                          >{{ translate('generated.workspaceTree.rename') }}</el-dropdown-item
                        >
                        <el-dropdown-item
                          command="move-group"
                          :icon="marIcon('folder-add')"
                          :disabled="loading || !canOrganizeWorkspaceGroups(result.node)"
                          >{{
                            translate('generated.workspaceTree.moveWorkspaceToGroup')
                          }}</el-dropdown-item
                        >
                        <el-dropdown-item
                          command="delete"
                          :icon="marIcon('delete')"
                          :disabled="loading || !canOrganizeWorkspaceGroups(result.node)"
                          divided
                          >{{ translate('generated.workspaceTree.delete') }}</el-dropdown-item
                        >
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </li>
              </template>
              <li
                v-else
                :class="[
                  'workspace-group',
                  {
                    'drop-target':
                      workspaceGroupDropTargetKey ===
                      workspaceGroupKey(result.node.id, group.groupName)
                  }
                ]"
              >
                <button
                  v-tooltip="group.groupName"
                  :class="[
                    'workspace-group-toggle',
                    { expanded: groupExpanded(result.node.id, group.groupName) }
                  ]"
                  :aria-label="
                    groupExpanded(result.node.id, group.groupName)
                      ? translate('generated.workspaceTree.collapseWorkspaceGroup', {
                          value0: group.groupName
                        })
                      : translate('generated.workspaceTree.expandWorkspaceGroup', {
                          value0: group.groupName
                        })
                  "
                  :aria-expanded="groupExpanded(result.node.id, group.groupName)"
                  @dragenter.stop="
                    setWorkspaceGroupDropTarget($event, result.node, group.groupName)
                  "
                  @dragleave.stop="leaveWorkspaceDropTarget"
                  @dragover.stop="setWorkspaceGroupDropTarget($event, result.node, group.groupName)"
                  @drop.prevent.stop="moveWorkspaceToGroup(result.node, group.groupName)"
                  type="button"
                  @click="toggleGroup(result.node.id, group.groupName)"
                >
                  <MarIcon name="chevron-right" class="tree-chevron" />
                  <MarIcon
                    name="folder-open"
                    class="tree-type-icon"
                    aria-hidden="true"
                    v-if="groupExpanded(result.node.id, group.groupName)"
                  />
                  <MarIcon name="folder" class="tree-type-icon" aria-hidden="true" v-else />
                  <span>{{ group.groupName }}</span>
                </button>
                <Transition
                  name="workspace-branch"
                  :css="animateBranches"
                  @enter="enterBranch"
                  @before-leave="leaveBranch"
                  @after-enter="finishBranchMotion"
                  @after-leave="finishBranchMotion"
                >
                  <ul
                    v-if="groupExpanded(result.node.id, group.groupName)"
                    class="workspace-branches workspace-group-branches"
                  >
                    <li
                      v-for="(workspace, workspaceIndex) in group.workspaces"
                      :key="workspace.id"
                      :class="{
                        dragging: draggingWorkspace?.workspaceId === workspace.id,
                        'drop-target':
                          workspaceDropTargetKey === workspaceKey(result.node.id, workspace.id) &&
                          workspaceDropPosition === undefined,
                        'drop-before':
                          workspaceDropTargetKey === workspaceKey(result.node.id, workspace.id) &&
                          workspaceDropPosition === 'before',
                        'drop-after':
                          workspaceDropTargetKey === workspaceKey(result.node.id, workspace.id) &&
                          workspaceDropPosition === 'after',
                        selected:
                          workspaceTarget?.nodeId === result.node.id &&
                          workspaceTarget.workspaceId === workspace.id
                      }"
                      :draggable="nodeDragEnabled"
                      @mouseenter="hoveredWorkspaceKey = workspaceKey(result.node.id, workspace.id)"
                      @mouseleave="hoveredWorkspaceKey = undefined"
                      @focusin="focusedWorkspaceKey = workspaceKey(result.node.id, workspace.id)"
                      @focusout="clearFocus($event, () => (focusedWorkspaceKey = undefined))"
                      @contextmenu="openWorkspaceActions($event, result.node.id, workspace.id)"
                      @dragend.stop="
                        clearWorkspaceDropTargets();
                        emit('endWorkspaceDrag');
                      "
                      @dragenter.stop="setWorkspaceDropTarget($event, result.node, workspace)"
                      @dragleave.stop="leaveWorkspaceDropTarget"
                      @dragover.stop="setWorkspaceDropTarget($event, result.node, workspace)"
                      @drop.prevent.stop="reorderWorkspace($event, result.node, workspace)"
                      @dragstart.stop="startWorkspaceDrag($event, result.node, workspace)"
                    >
                      <button
                        v-tooltip="workspaceLabel(workspace)"
                        :aria-label="workspaceLabel(workspace)"
                        :class="{
                          selected:
                            workspaceTarget?.nodeId === result.node.id &&
                            workspaceTarget.workspaceId === workspace.id
                        }"
                        class="workspace-branch-button"
                        type="button"
                        @click="selectWorkspace(result.node.id, workspace.id)"
                      >
                        <span class="workspace-branch-content">
                          <span>{{ workspaceLabel(workspace) }}</span>
                        </span>
                      </button>
                      <el-dropdown
                        v-if="workspaceActionsVisible(result.node.id, workspace.id)"
                        class="tree-row-menu workspace-row-actions"
                        trigger="click"
                        @command="workspaceCommand(result.node, workspace, $event)"
                        @visible-change="
                          openWorkspaceActionsKey = $event
                            ? workspaceKey(result.node.id, workspace.id)
                            : undefined
                        "
                      >
                        <button
                          class="tree-more-button utility-control"
                          :aria-label="translate('generated.workspaceTree.workspaceActions')"
                          type="button"
                          @click.stop
                        >
                          <MarIcon name="more" />
                        </button>
                        <template #dropdown>
                          <el-dropdown-menu>
                            <el-dropdown-item command="details" :icon="marIcon('view')">{{
                              translate('generated.workspaceTree.workspaceDetails')
                            }}</el-dropdown-item>
                            <el-dropdown-item
                              command="up"
                              :icon="marIcon('chevron-up')"
                              :disabled="filterActive || workspaceIndex === 0"
                              >{{ translate('generated.workspaceTree.moveUp') }}</el-dropdown-item
                            >
                            <el-dropdown-item
                              command="down"
                              :icon="marIcon('chevron-down')"
                              :disabled="
                                filterActive || workspaceIndex === group.workspaces.length - 1
                              "
                              >{{ translate('generated.workspaceTree.moveDown') }}</el-dropdown-item
                            >
                            <el-dropdown-item
                              command="rename"
                              :icon="marIcon('edit')"
                              :disabled="workspace.manageable === false"
                              >{{ translate('generated.workspaceTree.rename') }}</el-dropdown-item
                            >
                            <el-dropdown-item
                              command="move-group"
                              :icon="marIcon('folder-add')"
                              :disabled="loading || !canOrganizeWorkspaceGroups(result.node)"
                              >{{
                                translate('generated.workspaceTree.moveWorkspaceToGroup')
                              }}</el-dropdown-item
                            >
                            <el-dropdown-item
                              command="delete"
                              :icon="marIcon('delete')"
                              :disabled="loading || !canOrganizeWorkspaceGroups(result.node)"
                              divided
                              >{{ translate('generated.workspaceTree.delete') }}</el-dropdown-item
                            >
                          </el-dropdown-menu>
                        </template>
                      </el-dropdown>
                    </li>
                  </ul>
                </Transition>
              </li>
            </template>
          </ul>
        </Transition>
      </li>
    </ul>
    <p v-else class="tree-filter-empty">
      {{ translate('generated.workspaceTree.noMatchingResources') }}
    </p>
    <p v-if="filteredNodes.length && workspaceTarget?.workspaceId === undefined" class="tree-foot">
      {{ translate('generated.workspaceTree.selectAWorkspaceToContinueInThe') }}
    </p>
  </template>
  <p v-else class="tree-empty">{{ translate('generated.workspaceTree.noNodes') }}</p>
  <el-dialog
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
    v-if="workspaceGroupMoveDialogVisible"
    v-model="workspaceGroupMoveDialogVisible"
    :title="translate('generated.workspaceTree.moveWorkspaceToGroup')"
    width="min(440px, calc(100vw - 32px))"
    @closed="closeWorkspaceGroupMoveDialog"
    :close-icon="marIcon('close')"
  >
    <div class="workspace-group-move-control">
      <el-select
        v-model="workspaceGroupMoveName"
        allow-create
        clearable
        default-first-option
        filterable
        :aria-label="translate('generated.workspaceTree.workspaceGroupName')"
        :placeholder="translate('generated.workspaceTree.workspaceGroupMovePlaceholder')"
        :clear-icon="marIcon('clear-input')"
        :suffix-icon="marIcon('chevron-down')"
      >
        <el-option
          v-for="groupName in workspaceGroupMoveOptions"
          :key="groupName"
          :label="groupName"
          :value="groupName"
        />
      </el-select>
    </div>
    <p class="workspace-group-move-hint">
      {{ translate('generated.workspaceTree.emptyWorkspaceGroupLeavesUngrouped') }}
    </p>
    <p v-if="workspaceGroupMoveNameTooLong" class="workspace-group-move-error">
      {{ translate('generated.workspaceTree.workspaceGroupNameTooLong') }}
    </p>
    <template #footer>
      <el-button @click="closeWorkspaceGroupMoveDialog">{{
        translate('generated.workspaceTree.cancel')
      }}</el-button>
      <el-button
        type="primary"
        :disabled="workspaceGroupMoveNameTooLong"
        @click="saveWorkspaceGroupMove"
        >{{ translate('generated.workspaceTree.save') }}</el-button
      >
    </template>
  </el-dialog>
</template>

<style scoped>
.node-tree {
  --workspace-tree-indent: 16px;
  --workspace-tree-leading: 4px;
  --workspace-tree-control: 12px;
  --workspace-tree-icon: 16px;
  --workspace-tree-arrow-content-gap: 4px;
  --workspace-tree-status-label-gap: 6px;
  --workspace-tree-label-leading: calc(
    var(--workspace-tree-control) + var(--workspace-tree-arrow-content-gap)
  );
  padding: 8px 0;
}

.workspace-group {
  list-style: none;
}

.workspace-branches > li.workspace-group {
  display: block;
  min-height: 0;
  margin: 0;
  padding-left: 0;
}

.workspace-branches > li.workspace-group:hover,
.workspace-branches > li.workspace-group:focus-within {
  background: transparent;
}

.workspace-group-toggle {
  display: grid;
  width: calc(100% - 12px);
  margin: 2px 6px;
  min-width: 0;
  min-height: 30px;
  grid-template-columns:
    var(--workspace-tree-control) var(--workspace-tree-icon)
    minmax(0, 1fr);
  align-items: center;
  column-gap: var(--workspace-tree-arrow-content-gap);
  border: 0;
  border-radius: var(--mar-radius-selection);
  background: transparent;
  color: var(--mar-text-secondary);
  padding: 4px 6px 4px calc(var(--workspace-tree-leading) + var(--workspace-tree-indent));
  text-align: left;
  font-weight: 400;
  cursor: pointer;
}

.workspace-group-toggle:hover,
.workspace-group-toggle:focus-visible {
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}

.workspace-group.drop-target > .workspace-group-toggle,
.workspace-branches > li.drop-target:not(.workspace-group) {
  background: var(--mar-color-brand-selected);
}

.workspace-group-toggle .tree-chevron {
  grid-column: 1;
  flex: 0 0 auto;
  font-size: var(--workspace-tree-control);
}

.workspace-group-toggle > span {
  grid-column: 3;
  margin-left: calc(
    var(--workspace-tree-status-label-gap) - var(--workspace-tree-arrow-content-gap)
  );
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-group-toggle.expanded .tree-chevron,
.node-expand-button.expanded .tree-chevron {
  transform: rotate(90deg);
}

.tree-chevron {
  transition: transform var(--mar-motion-duration-collapse) var(--mar-motion-easing-collapse);
}

.workspace-branch-enter-active,
.workspace-branch-leave-active {
  overflow: hidden;
  transition: height var(--mar-motion-duration-collapse) var(--mar-motion-easing-collapse);
}

.workspace-branch-enter-from,
.workspace-branch-leave-to {
  height: 0;
}

.workspace-branch-enter-to,
.workspace-branch-leave-from {
  height: var(--workspace-branch-height);
}

@media (prefers-reduced-motion: reduce) {
  .tree-chevron,
  .workspace-branch-enter-active,
  .workspace-branch-leave-active {
    transition: none;
  }
}

.workspace-branches.workspace-group-branches {
  padding-left: 0;
}

.workspace-branches.workspace-group-branches > li {
  padding-left: calc(var(--workspace-tree-leading) + var(--workspace-tree-indent) * 2);
}

.workspace-group-move-hint,
.workspace-group-move-error {
  margin: 8px 0 0;
  font-size: var(--mar-font-size-body);
}

.workspace-group-move-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.workspace-group-move-control :deep(.el-select) {
  flex: 1 1 auto;
}

.workspace-group-move-hint {
  color: var(--mar-text-tertiary);
}

.workspace-group-move-error {
  color: var(--el-color-danger);
}

.workspace-tree-filter {
  padding: 8px 8px 0;
}

.workspace-tree-filter :deep(.el-input) {
  width: 100%;
}

.tree-node {
  display: block;
  width: 100%;
  min-width: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--mar-text-primary);
  padding: 4px 7px 4px 0;
  min-height: 30px;
  font-weight: 400;
  text-align: left;
  cursor: pointer;
}

.tree-node-content {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: var(--workspace-tree-icon) minmax(0, 1fr);
  align-items: center;
  column-gap: var(--workspace-tree-status-label-gap);
}

.tree-node.selected {
  color: var(--mar-color-brand-text);
}

.tree-node-content > small {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
}

.tree-node-content > span:last-child,
.workspace-branch-content > span {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-type-icon {
  flex: 0 0 auto;
  width: var(--workspace-tree-icon);
  height: var(--workspace-tree-icon);
  font-size: var(--workspace-tree-icon);
  color: var(--mar-text-tertiary);
}

.tree-node-icon {
  position: relative;
  display: inline-flex;
  width: var(--workspace-tree-icon);
  height: var(--workspace-tree-icon);
}

.state-dot {
  position: absolute;
  right: -2px;
  bottom: -1px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--mar-text-faint);
}

.state-dot.ready {
  background: var(--mar-color-success-text);
}

.state-dot.offline {
  background: var(--mar-color-warning-text);
}

.workspace-branches {
  display: flow-root;
  margin: 0;
  padding: 0;
  list-style: none;
}

.workspace-branches:empty {
  display: none;
}

.workspace-branches > li {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: center;
  min-height: 30px;
  margin: 2px 6px;
  padding-left: calc(var(--workspace-tree-leading) + var(--workspace-tree-indent));
  border-radius: var(--mar-radius-selection);
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}

.workspace-branches > li:hover,
.workspace-branches > li:focus-within {
  background: var(--mar-fill-row-hover);
}

.workspace-branches > li:hover > .workspace-branch-button,
.workspace-branches > li:focus-within > .workspace-branch-button {
  color: var(--mar-text-primary);
}

.workspace-branches > li.selected {
  background: var(--mar-fill-selection);
}

.workspace-branches > li.selected:hover,
.workspace-branches > li.selected:focus-within {
  background: var(--mar-fill-selection);
}

.workspace-branches > li.selected .workspace-branch-button {
  color: var(--mar-text-primary);
  font-weight: 400;
}

.workspace-branches > li.dragging {
  opacity: 0.45;
}

.workspace-branches .workspace-branch-button {
  flex: 1;
  min-width: 0;
  width: 100%;
  overflow: hidden;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--mar-text-secondary);
  padding: 4px 6px 4px var(--workspace-tree-label-leading);
  min-height: 30px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: grab;
}

.workspace-branches .workspace-branch-button:active {
  cursor: grabbing;
}

@media (min-width: 768px) {
  .workspace-branches .workspace-branch-button {
    font-size: calc(var(--mar-font-size-body) - 1px);
  }
}

.tree-more-button {
  --mar-action-icon-size: 14px;
  display: inline-grid;
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  place-items: center;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--mar-text-secondary);
  cursor: pointer;
}

.tree-more-button:disabled {
  cursor: not-allowed;
}

.workspace-branch-content {
  display: block;
  min-width: 0;
}

.tree-node-row {
  display: grid;
  min-width: 0;
  grid-template-columns: var(--workspace-tree-control) minmax(0, 1fr);
  align-items: center;
  column-gap: var(--workspace-tree-arrow-content-gap);
  margin: 2px 6px;
  padding-left: var(--workspace-tree-leading);
  border-radius: var(--mar-radius-selection);
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}

.tree-node-row.actions-visible {
  grid-template-columns:
    var(--workspace-tree-control) minmax(0, 1fr)
    24px;
}

.tree-node-row.dragging {
  opacity: 0.5;
}

.tree-node-row.drop-target,
.tree-node-row.drop-target:hover,
.tree-node-row.drop-target:focus-within {
  background: var(--mar-color-brand-selected);
}

.tree-node-row.drop-before,
.workspace-branches > li.drop-before {
  box-shadow: inset 0 2px var(--el-color-primary);
}

.tree-node-row.drop-after,
.workspace-branches > li.drop-after {
  box-shadow: inset 0 -2px var(--el-color-primary);
}

.tree-node-row:hover,
.tree-node-row:focus-within {
  background: var(--mar-fill-row-hover);
}

.tree-node-row:hover .tree-node,
.tree-node-row:focus-within .tree-node {
  color: var(--mar-text-primary);
}

.node-expand-button {
  display: inline-grid;
  width: var(--workspace-tree-control);
  height: 30px;
  flex: 0 0 auto;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--mar-text-tertiary);
  padding: 0;
  cursor: pointer;
}

.node-expand-button :deep(.mar-icon) {
  font-size: var(--workspace-tree-control);
}

.node-expand-spacer {
  width: var(--workspace-tree-control);
  height: 30px;
  flex: 0 0 auto;
}

.node-expand-button:hover,
.node-expand-button:focus-visible {
  color: var(--mar-text-primary);
}

.tree-node-row.selected {
  background: var(--mar-fill-selection);
}

.tree-node-row.selected:hover,
.tree-node-row.selected:focus-within {
  background: var(--mar-fill-selection);
}

.tree-node-row.selected .tree-node {
  color: var(--mar-text-primary);
}

.tree-node-row.selected .tree-type-icon {
  color: var(--mar-text-primary);
}

.tree-node:focus-visible,
.node-expand-button:focus-visible,
.workspace-group-toggle:focus-visible,
.workspace-branch-button:focus-visible {
  outline: 1px solid var(--mar-color-brand);
  outline-offset: -1px;
}

.tree-node-row .tree-node {
  min-width: 0;
}

.node-tree-actions {
  display: inline-flex;
  gap: 1px;
  padding-right: 3px;
}

.workspace-row-actions {
  flex: 0 0 auto;
  padding-right: 3px;
}

.tree-empty,
.tree-foot,
.tree-filter-empty {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
  line-height: 1.5;
}

.tree-empty,
.tree-filter-empty {
  margin: 1rem 0.9rem;
  text-align: center;
}

.tree-foot {
  margin: 0 0.9rem;
  padding: 0.25rem 0.1rem 0;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
  line-height: 1.5;
}

@media (max-width: 767px) {
  .node-row span:not(.state-dot),
  .node-row code {
    display: none;
  }
}
</style>

<style scoped>
.node-tree-actions :deep(.icon-button) {
  width: 23px;
  height: 23px;
  border-radius: 4px;
}
</style>
