<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import { showMessage } from '../../service/message-feedback-service.js';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { errorMessage } from '../../util/error-presentation.js';
import { marIcon } from '../../util/mar-icons.js';

interface TreeNode {
  readonly id: string;
  readonly parentSessionId: string | null;
  readonly title: string;
  readonly runner: string;
}
interface TreeResult {
  readonly rootSessionId: string;
  readonly nodes: readonly TreeNode[];
  readonly truncated: boolean;
}

const props = defineProps<{
  readonly modelValue: boolean;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
}>();
const emit = defineEmits<{ close: []; open: [sessionId: string] }>();
const controller = new AbortController();
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
  const flattened: Array<{ node: TreeNode; branches: boolean[] }> = [];
  function visit(parent: string | null, branches: boolean[]): void {
    const siblings = children.get(parent) ?? [];
    for (const [index, node] of siblings.entries()) {
      const path = parent === null ? [] : [...branches, index < siblings.length - 1];
      flattened.push({ node, branches: path });
      visit(node.id, path);
    }
  }
  visit(null, []);
  return flattened;
});
onMounted(async () => {
  try {
    const query = new URLSearchParams({ nodeId: props.nodeId, workspaceId: props.workspaceId });
    result.value = await props.request<TreeResult>(
      `/api/agent-sessions/${encodeURIComponent(props.sessionId)}/tree?${query}`,
      { signal: controller.signal }
    );
  } catch (error) {
    if (!controller.signal.aborted) {
      showMessage(errorMessage(error), 'error', error);
      emit('close');
    }
  } finally {
    loading.value = false;
  }
});
onBeforeUnmount(() => controller.abort());
</script>

<template>
  <el-dialog
    v-if="modelValue"
    :model-value="modelValue"
    :title="translate('sessionGroups.tree')"
    :close-icon="marIcon('close')"
    width="min(520px, calc(100vw - 32px))"
    @update:model-value="emit('close')"
    @vue:mounted="mountMobileDialogReturn"
    @vue:before-unmount="unmountMobileDialogReturn"
  >
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
          <button
            type="button"
            class="session-tree-node"
            :style="{ marginInlineStart: `${(row.branches.length + 1) * 1.25}rem` }"
            :aria-current="row.node.id === sessionId ? 'true' : undefined"
            :aria-label="row.node.title"
            @click="emit('open', row.node.id)"
          >
            <span class="session-tree-title">{{ row.node.title }}</span>
          </button>
        </li>
      </ul>
      <p v-if="result?.truncated" class="session-tree-truncated">
        {{ translate('sessionGroups.treeTruncated') }}
      </p>
    </div>
  </el-dialog>
</template>

<style scoped>
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
  min-height: 2.25rem;
  align-items: center;
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
  border-end-start-radius: 0.25rem;
}
.session-tree-origin-stem {
  position: absolute;
  top: 50%;
  bottom: 0;
  border-inline-start: 1px solid var(--mar-border-medium);
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
  inset-inline-start: -1px;
  top: 0;
  height: 50%;
  width: 100%;
  border-inline-start: 1px solid var(--mar-border-medium);
  border-bottom: 1px solid var(--mar-border-medium);
}
</style>
