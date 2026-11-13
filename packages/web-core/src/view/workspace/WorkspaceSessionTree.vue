<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import type {
  NavigationSession,
  NavigationSnapshot
} from '../../service/session-navigation-projection.js';
import MarIcon from '../common/MarIcon.vue';
import BusyIndicator from '../common/BusyIndicator.vue';
import {
  formatRelativeSessionActivity,
  isKnownSessionActivityAt
} from '../../util/session-list.js';
import { absoluteSessionTime } from '../../util/time-presentation.js';

type TreeNode = NavigationSession;

const props = defineProps<{
  readonly sessionId: string;
  readonly tree: NavigationSnapshot['tree'] | undefined;
  readonly status: 'idle' | 'loading' | 'ready' | 'failed';
  readonly mainSessionId?: string | undefined;
  readonly asideSessionIds: readonly string[];
  readonly activeAsideId?: string | undefined;
}>();
const emit = defineEmits<{
  open: [sessionId: string, target: 'aside' | 'main'];
  retry: [];
  menu: [open: boolean];
}>();
const parentMenu = ref<{ handleClose: () => void }>();
const nodeMenus = ref<Array<{ handleClose: () => void }>>([]);
const hoveredSessionId = ref<string>();
const focusedSessionId = ref<string>();
const openMenuSessionId = ref<string>();
const hoverQuery =
  typeof window === 'undefined'
    ? undefined
    : window.matchMedia('(hover: hover) and (pointer: fine)');
const supportsHover = ref(hoverQuery?.matches ?? false);
function updateHoverSupport(): void {
  supportsHover.value = hoverQuery?.matches ?? false;
}
onMounted(() => hoverQuery?.addEventListener('change', updateHoverSupport));
onBeforeUnmount(() => hoverQuery?.removeEventListener('change', updateHoverSupport));
function actionsVisible(sessionId: string): boolean {
  return (
    !supportsHover.value ||
    hoveredSessionId.value === sessionId ||
    focusedSessionId.value === sessionId ||
    openMenuSessionId.value === sessionId
  );
}
function clearFocus(event: FocusEvent): void {
  if (
    event.currentTarget instanceof HTMLElement &&
    event.relatedTarget instanceof Node &&
    event.currentTarget.contains(event.relatedTarget)
  )
    return;
  focusedSessionId.value = undefined;
}
function updateMenu(sessionId: string, visible: boolean): void {
  if (visible) openMenuSessionId.value = sessionId;
  else if (openMenuSessionId.value === sessionId) openMenuSessionId.value = undefined;
  emit('menu', openMenuSessionId.value !== undefined);
}
function closeMenu(): void {
  parentMenu.value?.handleClose();
  for (const menu of nodeMenus.value) menu.handleClose();
}
defineExpose({ closeMenu });
const rows = computed(() => {
  const tree = props.tree;
  if (!tree) return [];
  const ids = new Set(tree.nodes.map((node) => node.id));
  const children = new Map<string | null, TreeNode[]>();
  for (const node of tree.nodes) {
    const parent =
      node.parentSessionId === tree.anchorSessionId || !ids.has(node.parentSessionId ?? '')
        ? null
        : node.parentSessionId;
    const siblings = children.get(parent) ?? [];
    siblings.push(node);
    children.set(parent, siblings);
  }
  const flattened: Array<{
    node: TreeNode;
    branches: boolean[];
    hasChildren: boolean;
    hasPreviousSibling: boolean;
    hasNextSibling: boolean;
  }> = [];
  function visit(parent: string | null, branches: boolean[], rootContinues = false): void {
    const siblings = children.get(parent) ?? [];
    for (const [index, node] of siblings.entries()) {
      const hasNextSibling = index < siblings.length - 1;
      const path = parent === null ? [] : [...branches, hasNextSibling];
      if (rootContinues && path.length > 0) path[0] = true;
      flattened.push({
        node,
        branches: path,
        hasChildren: children.has(node.id),
        hasPreviousSibling: index > 0,
        hasNextSibling
      });
      visit(node.id, path, parent === null ? hasNextSibling : rootContinues);
    }
  }
  visit(null, []);
  return flattened;
});
function activityDateTime(node: TreeNode): string | undefined {
  return isKnownSessionActivityAt(node.lastActivityAt)
    ? new Date(node.lastActivityAt).toISOString()
    : undefined;
}
function activityTitle(node: TreeNode): string | undefined {
  return isKnownSessionActivityAt(node.lastActivityAt)
    ? translate('presentation.lastActivity', { value: absoluteSessionTime(node.lastActivityAt) })
    : undefined;
}
function openContext(event: MouseEvent): void {
  event.preventDefault();
  const row = event.currentTarget as HTMLElement;
  row.querySelector<HTMLButtonElement>('.session-tree-node')?.focus({ preventScroll: true });
  void nextTick(() => row.querySelector<HTMLButtonElement>('.session-tree-actions')?.click());
}
</script>

<template>
  <div class="session-tree" :aria-busy="tree === undefined && status !== 'failed'">
    <div
      v-if="tree === undefined && status !== 'failed'"
      class="session-tree-loading"
      role="status"
      :aria-label="translate('common.loading')"
    >
      <BusyIndicator class="mar-read-loading-indicator" />
    </div>
    <p v-if="status === 'failed' || (status === 'ready' && tree === null)" role="status">
      {{ translate('sessionGroups.treeUnavailable') }}
      <el-button link @click="emit('retry')">{{ translate('sessionGroups.retry') }}</el-button>
    </p>
    <div
      v-if="tree?.parent"
      class="session-tree-parent"
      @mouseenter="hoveredSessionId = tree.parent.id"
      @mouseleave="hoveredSessionId = undefined"
      @focusin="focusedSessionId = tree.parent.id"
      @focusout="clearFocus"
      @contextmenu="openContext"
    >
      <span>{{ translate('sessionGroups.parent') }}</span>
      <div class="session-tree-item" :class="{ 'is-current': tree.parent.id === mainSessionId }">
        <button
          type="button"
          class="session-tree-node"
          :aria-current="tree.parent.id === mainSessionId ? 'true' : undefined"
          :aria-label="`${tree.parent.title}, ${translate(`sessionGroups.status${tree.parent.status}`)}`"
          @click="emit('open', tree.parent.id, 'aside')"
        >
          <span v-tooltip="tree.parent.title" class="session-tree-title">{{
            tree.parent.title
          }}</span>
          <span
            v-if="tree.parent.status !== 'IDLE'"
            class="mar-session-activity"
            :class="tree.parent.status === 'RUNNING' ? 'managed_active' : 'tree-sleeping'"
            aria-hidden="true"
            ><i
          /></span>
          <time
            class="session-tree-time"
            v-tooltip="activityTitle(tree.parent)"
            :datetime="activityDateTime(tree.parent)"
            >{{ formatRelativeSessionActivity(tree.parent.lastActivityAt) }}</time
          >
        </button>
        <span v-if="tree.parent.id === mainSessionId" class="session-tree-location">{{
          translate('sessionGroups.inMain')
        }}</span>
        <span v-else-if="tree.parent.id === activeAsideId" class="session-tree-location">{{
          translate('sessionGroups.inActiveAside')
        }}</span>
        <span v-else-if="asideSessionIds.includes(tree.parent.id)" class="session-tree-location">{{
          translate('sessionGroups.inAside')
        }}</span>
        <el-dropdown
          v-if="actionsVisible(tree.parent.id)"
          ref="parentMenu"
          trigger="click"
          popper-class="session-tree-menu"
          @visible-change="updateMenu(tree.parent.id, $event)"
          @command="emit('open', tree!.parent!.id, $event)"
        >
          <button
            type="button"
            class="mar-icon-button mar-icon-action mar-icon-action--inline session-tree-actions"
            v-tooltip="translate('sessionGroups.actions')"
            :aria-label="translate('sessionGroups.actions')"
          >
            <MarIcon name="more" />
          </button>
          <template #dropdown
            ><el-dropdown-menu>
              <el-dropdown-item command="aside"
                ><MarIcon name="split" />{{
                  translate('sessionGroups.openAside')
                }}</el-dropdown-item
              >
              <el-dropdown-item command="main"
                ><MarIcon name="conversation" />{{
                  translate('sessionGroups.openMain')
                }}</el-dropdown-item
              >
            </el-dropdown-menu></template
          >
        </el-dropdown>
      </div>
    </div>
    <p v-if="tree && rows.length === 0">{{ translate('sessionGroups.noDescendants') }}</p>
    <ul v-if="tree && rows.length > 0" class="session-tree-list">
      <li
        v-for="row in rows"
        :key="row.node.id"
        class="session-tree-row"
        @mouseenter="hoveredSessionId = row.node.id"
        @mouseleave="hoveredSessionId = undefined"
        @focusin="focusedSessionId = row.node.id"
        @focusout="clearFocus"
        @contextmenu="openContext"
      >
        <span v-if="row.branches.length === 0" class="session-tree-origin" aria-hidden="true">
          <span v-if="row.hasPreviousSibling" class="session-tree-origin-stem is-incoming" />
          <span v-if="row.hasNextSibling || row.hasChildren" class="session-tree-origin-stem" />
        </span>
        <span
          v-for="(continues, level) in row.branches"
          :key="level"
          aria-hidden="true"
          class="session-tree-branch"
          :class="{ 'is-continuing': continues, 'is-leaf': level === row.branches.length - 1 }"
          :style="{ insetInlineStart: `${level * 1.25 + 0.75}rem` }"
        />
        <span
          v-if="row.branches.length > 0 && row.hasChildren"
          class="session-tree-child-stem"
          aria-hidden="true"
          :style="{ insetInlineStart: `${row.branches.length * 1.25 + 0.75}rem` }"
        />
        <span
          class="session-tree-marker"
          aria-hidden="true"
          :style="{ insetInlineStart: `${row.branches.length * 1.25 + 0.75}rem` }"
        />
        <div
          class="session-tree-item"
          :class="{ 'is-current': row.node.id === mainSessionId }"
          :style="{ marginInlineStart: `${(row.branches.length + 1) * 1.25}rem` }"
        >
          <button
            type="button"
            class="session-tree-node"
            :aria-current="row.node.id === mainSessionId ? 'true' : undefined"
            :aria-label="`${row.node.title}, ${translate(`sessionGroups.status${row.node.status}`)}`"
            @click="emit('open', row.node.id, 'aside')"
          >
            <span v-tooltip="row.node.title" class="session-tree-title">{{ row.node.title }}</span>
            <span v-if="row.node.id === mainSessionId" class="session-tree-location">{{
              translate('sessionGroups.inMain')
            }}</span>
            <span v-else-if="row.node.id === activeAsideId" class="session-tree-location">{{
              translate('sessionGroups.inActiveAside')
            }}</span>
            <span v-else-if="asideSessionIds.includes(row.node.id)" class="session-tree-location">{{
              translate('sessionGroups.inAside')
            }}</span>
            <span
              v-if="row.node.status !== 'IDLE'"
              class="mar-session-activity"
              :class="row.node.status === 'RUNNING' ? 'managed_active' : 'tree-sleeping'"
              aria-hidden="true"
              ><i />
            </span>
            <time
              v-tooltip="activityTitle(row.node)"
              class="session-tree-time"
              :datetime="activityDateTime(row.node)"
              >{{ formatRelativeSessionActivity(row.node.lastActivityAt) }}</time
            >
          </button>
          <el-dropdown
            v-if="actionsVisible(row.node.id)"
            ref="nodeMenus"
            trigger="click"
            popper-class="session-tree-menu"
            @visible-change="updateMenu(row.node.id, $event)"
            @command="emit('open', row.node.id, $event)"
          >
            <button
              type="button"
              class="mar-icon-button mar-icon-action mar-icon-action--inline session-tree-actions"
              v-tooltip="translate('sessionGroups.actions')"
              :aria-label="translate('sessionGroups.actions')"
              @click.stop
            >
              <MarIcon name="more" />
            </button>
            <template #dropdown
              ><el-dropdown-menu>
                <el-dropdown-item command="aside"
                  ><MarIcon name="split" />{{
                    translate('sessionGroups.openAside')
                  }}</el-dropdown-item
                >
                <el-dropdown-item command="main"
                  ><MarIcon name="conversation" />{{
                    translate('sessionGroups.openMain')
                  }}</el-dropdown-item
                >
              </el-dropdown-menu></template
            >
          </el-dropdown>
        </div>
      </li>
    </ul>
    <p v-if="tree?.truncated" class="session-tree-truncated">
      {{ translate('sessionGroups.treeTruncated') }}
    </p>
  </div>
</template>

<style scoped>
.session-tree-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-block-size: 5rem;
}

.session-tree-parent {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.25rem 0.5rem;
}
.session-tree-item {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  margin-block: 2px;
  padding-inline-end: 0.25rem;
  border-radius: var(--mar-radius-control);
}
.session-tree-row > .session-tree-item {
  min-inline-size: min(12rem, 100%);
}
.session-tree-item > .el-dropdown {
  flex: none;
}
.session-tree-location {
  flex: none;
  color: var(--el-text-color-secondary);
  font-size: var(--mar-font-size-meta);
}
.session-tree-actions {
  display: inline-grid;
  flex: none;
  width: var(--mar-utility-control-size);
  height: var(--mar-utility-control-size);
  align-self: center;
  place-items: center;
  padding: 0;
  border-radius: var(--mar-radius-control);
}
.tree-sleeping i {
  background: var(--el-color-warning);
}
.session-tree[aria-busy='true'] {
  min-height: 4rem;
}
.session-tree-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.session-tree-node {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: var(--mar-session-row-min-height);
  align-items: center;
  gap: 0.5rem;
  padding: var(--mar-session-row-padding-block) 0.5rem;
  border: 0;
  border-radius: var(--mar-radius-control);
  background: transparent;
  color: var(--mar-text-primary);
  font: inherit;
  font-size: var(--mar-font-size-body);
  cursor: pointer;
  text-align: start;
}
.session-tree-row:hover > .session-tree-item,
.session-tree-item:hover,
.session-tree-item:focus-within,
.session-tree-item:has([aria-expanded='true']) {
  background: var(--mar-fill-row-hover);
}
.session-tree-item.is-current {
  background: var(--mar-fill-selection);
}
.session-tree-node:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: -2px;
}
.session-tree-node[aria-current='true'] .session-tree-time {
  color: var(--mar-text-secondary);
}
.session-tree-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.5;
}
.session-tree-time {
  flex: none;
  color: var(--mar-text-faint);
  font-size: var(--mar-font-size-meta);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
}
.session-tree-truncated {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
}
.session-tree-row {
  position: relative;
  display: flex;
}
.session-tree-origin {
  position: absolute;
  inset-inline-start: 0.75rem;
  top: 0;
  bottom: 0;
  width: 0.5rem;
  pointer-events: none;
}
.session-tree-origin-stem,
.session-tree-child-stem {
  position: absolute;
  top: 50%;
  bottom: 0;
  border-inline-start: 1px solid var(--mar-border-medium);
  pointer-events: none;
}
.session-tree-branch {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1.25rem;
  pointer-events: none;
}
.session-tree-origin-stem.is-incoming {
  top: 0;
  bottom: 50%;
}
.session-tree-branch.is-continuing {
  border-inline-start: 1px solid var(--mar-border-medium);
}
.session-tree-branch.is-leaf::before {
  content: '';
  position: absolute;
  inset-inline-start: 0;
  top: 0;
  height: 50%;
  width: 100%;
  border-inline-start: 1px solid var(--mar-border-medium);
  border-bottom: 1px solid var(--mar-border-medium);
  border-end-start-radius: var(--mar-radius-control);
}
.session-tree-branch.is-continuing.is-leaf::before {
  inset-inline-start: -1px;
}
.session-tree-marker {
  position: absolute;
  top: 50%;
  width: 8px;
  height: 8px;
  box-sizing: border-box;
  transform: translate(-50%, -50%);
  border: 1.5px solid var(--mar-text-tertiary);
  border-radius: 50%;
  background: var(--mar-control-bg-color-overlay);
  box-shadow: 0 0 0 3px var(--mar-control-bg-color-overlay);
  pointer-events: none;
}
</style>
