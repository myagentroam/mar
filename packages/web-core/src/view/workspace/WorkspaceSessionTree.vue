<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import { showMessage } from '../../service/message-feedback-service.js';
import { errorMessage } from '../../util/error-presentation.js';

interface TreeNode {
  readonly id: string;
  readonly parentSessionId: string | null;
  readonly title: string;
  readonly runner: string;
  readonly status: 'RUNNING' | 'SLEEPING' | 'IDLE';
}
interface TreeResult {
  readonly rootSessionId: string;
  readonly nodes: readonly TreeNode[];
  readonly truncated: boolean;
}

const props = defineProps<{
  readonly active: boolean;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
}>();
const emit = defineEmits<{ close: []; open: [sessionId: string] }>();
const controller = new AbortController();
watch(
  () => props.active,
  (active) => {
    if (!active) controller.abort();
  }
);
const loading = ref(true);
const result = ref<TreeResult>();
const rows = computed(() => {
  const tree = result.value;
  if (!tree) return [];
  const children = new Map<string | null, TreeNode[]>();
  for (const node of tree.nodes) {
    const parent = node.id === tree.rootSessionId ? null : node.parentSessionId;
    const siblings = children.get(parent) ?? [];
    siblings.push(node);
    children.set(parent, siblings);
  }
  function hasActiveDescendant(node: TreeNode): boolean {
    return (children.get(node.id) ?? []).some(
      (child) => child.status !== 'IDLE' || hasActiveDescendant(child)
    );
  }
  const priority = { RUNNING: 0, SLEEPING: 1, IDLE: 2 };
  for (const siblings of children.values()) {
    siblings.sort(
      (a, b) =>
        Number(b.status !== 'IDLE' || hasActiveDescendant(b)) -
          Number(a.status !== 'IDLE' || hasActiveDescendant(a)) ||
        priority[a.status] - priority[b.status]
    );
  }
  const flattened: Array<{ node: TreeNode; branches: boolean[]; hasChildren: boolean }> = [];
  function visit(parent: string | null, branches: boolean[]): void {
    const siblings = children.get(parent) ?? [];
    for (const [index, node] of siblings.entries()) {
      const path = parent === null ? [] : [...branches, index < siblings.length - 1];
      flattened.push({ node, branches: path, hasChildren: children.has(node.id) });
      visit(node.id, path);
    }
  }
  visit(null, []);
  return flattened;
});
onMounted(async () => {
  try {
    const query = new URLSearchParams({ nodeId: props.nodeId, workspaceId: props.workspaceId });
    const snapshot = await props.request<TreeResult>(
      `/api/agent-sessions/${encodeURIComponent(props.sessionId)}/tree?${query}`,
      { signal: controller.signal }
    );
    if (!controller.signal.aborted) result.value = snapshot;
  } catch (error) {
    if (!controller.signal.aborted) {
      showMessage(errorMessage(error), 'error', error);
      emit('close');
    }
  } finally {
    if (!controller.signal.aborted) loading.value = false;
  }
});
onBeforeUnmount(() => controller.abort());
</script>

<template>
  <div v-loading="loading" class="session-tree" :aria-busy="loading">
    <ul v-if="result" class="session-tree-list">
      <li v-for="row in rows" :key="row.node.id" class="session-tree-row">
        <span v-if="row.branches.length === 0" class="session-tree-origin" aria-hidden="true">
          <span v-if="rows.length > 1" class="session-tree-origin-stem" />
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
        <button
          type="button"
          class="session-tree-node"
          :style="{ marginInlineStart: `${(row.branches.length + 1) * 1.25}rem` }"
          :aria-current="row.node.id === sessionId ? 'true' : undefined"
          :aria-label="`${row.node.title}, ${translate(`sessionGroups.status${row.node.status}`)}`"
          @click="emit('open', row.node.id)"
        >
          <span class="session-tree-title">{{ row.node.title }}</span>
          <el-tag
            class="session-tree-status"
            size="small"
            :type="row.node.status === 'RUNNING' ? 'success' : 'info'"
            >{{ translate(`sessionGroups.status${row.node.status}`) }}</el-tag
          >
        </button>
      </li>
    </ul>
    <p v-if="result?.truncated" class="session-tree-truncated">
      {{ translate('sessionGroups.treeTruncated') }}
    </p>
  </div>
</template>

<style scoped>
.session-tree[aria-busy='true'] {
  min-height: 4rem;
}
.session-tree {
  max-height: min(60vh, 32rem);
  overflow-y: auto;
}
.session-tree-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.session-tree-node {
  display: flex;
  flex: 1;
  min-width: 10rem;
  min-height: 2.25rem;
  align-items: center;
  gap: 0.75rem;
  padding: 0.375rem 0.75rem;
  border: 0;
  border-radius: var(--mar-radius-control);
  background: transparent;
  color: var(--mar-text-primary);
  font: inherit;
  cursor: pointer;
  text-align: start;
}
.session-tree-node:hover {
  color: var(--mar-color-brand-text);
}
.session-tree-node:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: -2px;
}
.session-tree-node[aria-current='true'] .session-tree-title {
  color: var(--mar-color-brand-text);
  font-weight: 600;
}
.session-tree-status {
  flex: none;
  margin-inline-start: auto;
  height: 20px;
  padding: 0 0.38rem;
  font-size: var(--mar-font-size-meta);
  line-height: 18px;
}
.session-tree-status.el-tag--success {
  --el-tag-text-color: var(--mar-color-success-text);
}
.session-tree-title {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  min-width: 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  line-height: 1.5;
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
.session-tree-origin::before {
  content: '';
  position: absolute;
  top: calc(50% - 0.5rem);
  height: 0.5rem;
  width: 100%;
  border-inline-start: 1px solid var(--mar-border-medium);
  border-bottom: 1px solid var(--mar-border-medium);
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
  width: 1.75rem;
  pointer-events: none;
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
}
.session-tree-branch.is-continuing.is-leaf::before {
  inset-inline-start: -1px;
}
</style>
