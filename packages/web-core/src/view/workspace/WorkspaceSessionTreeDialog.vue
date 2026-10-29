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
  const flattened: Array<{ node: TreeNode; depth: number }> = [];
  function visit(parent: string | null, depth: number): void {
    for (const node of children.get(parent) ?? []) {
      flattened.push({ node, depth });
      visit(node.id, depth + 1);
    }
  }
  visit(null, 0);
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
        <li v-for="row in rows" :key="row.node.id">
          <button
            type="button"
            class="session-tree-node utility-control"
            :style="{ paddingInlineStart: `${row.depth * 1.25 + 0.5}rem` }"
            :aria-current="row.node.id === sessionId ? 'true' : undefined"
            @click="emit('open', row.node.id)"
          >
            <span class="session-tree-title">{{ row.node.title }}</span>
            <span class="session-tree-runner">{{ row.node.runner }}</span>
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
.session-tree {
  min-height: 4rem;
  max-height: min(60vh, 36rem);
  overflow-y: auto;
}
.session-tree-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.session-tree-node {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem;
  text-align: start;
}
.session-tree-node[aria-current='true'] {
  background: var(--mar-surface-hover);
}
.session-tree-title {
  min-width: 0;
  flex: 1;
  overflow-wrap: anywhere;
}
.session-tree-runner,
.session-tree-truncated {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
}
</style>
