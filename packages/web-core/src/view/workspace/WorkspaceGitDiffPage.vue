<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { filePreviewErrorSummary } from '../../util/error-presentation.js';
import type { WorkspaceFileTab } from '../../util/workspace-file-tab.js';
import type { FileNavigationRequest } from './CodeFileEditor.vue';
import GitDiffViewer from './GitDiffViewer.vue';

const props = defineProps<{
  readonly tab: WorkspaceFileTab;
  readonly active: boolean;
  readonly load: (tab: WorkspaceFileTab, signal?: AbortSignal) => Promise<unknown>;
  readonly codeNavigationEnabled?: boolean;
}>();

const emit = defineEmits<{
  viewed: [];
  close: [];
  download: [diff: unknown];
  moveFile: [direction: -1 | 1];
  preview: [diff: unknown];
  edit: [];
  navigateSymbol: [symbol: string];
  navigateFile: [request: FileNavigationRequest];
}>();

const diff = ref<unknown>();
const viewer = ref<{
  $el?: HTMLElement;
  focus(): void;
  openFind(): boolean;
  selectAll(): boolean;
  toggleEdit(): 'CHANGED' | 'UNAVAILABLE';
  canClose(): Promise<boolean>;
}>();
const loading = ref(false);
const loadError = shallowRef<unknown>();
watch(
  () => [props.active, diff.value],
  () => {
    if (
      props.active &&
      diff.value &&
      viewer.value?.$el?.getClientRects().length &&
      document.visibilityState === 'visible' &&
      document.hasFocus()
    )
      emit('viewed');
  },
  { flush: 'post' }
);
let requestGeneration = 0;
let controller: AbortController | undefined;

async function load(): Promise<void> {
  controller?.abort();
  controller = new AbortController();
  const generation = ++requestGeneration;
  diff.value = undefined;
  loadError.value = undefined;
  loading.value = true;
  try {
    const nextDiff = await props.load(props.tab, controller.signal);
    if (generation === requestGeneration) diff.value = nextDiff;
  } catch (error) {
    if (generation === requestGeneration) {
      loadError.value = error;
    }
  } finally {
    if (generation === requestGeneration) loading.value = false;
  }
}

watch(
  () => props.tab.identity,
  () => void load(),
  { immediate: true }
);

onBeforeUnmount(() => {
  controller?.abort();
  requestGeneration += 1;
});

defineExpose({
  focus: () => viewer.value?.focus(),
  openFind: () => viewer.value?.openFind() ?? false,
  selectAll: () => viewer.value?.selectAll() ?? false,
  toggleEdit: () => viewer.value?.toggleEdit() ?? 'UNAVAILABLE',
  canClose: () => viewer.value?.canClose() ?? Promise.resolve(true)
});
</script>

<template>
  <GitDiffViewer
    ref="viewer"
    :active="props.active"
    :code-navigation-enabled="
      props.codeNavigationEnabled === true && props.tab.kind === 'WORKTREE_DIFF'
    "
    :diff="diff"
    :embedded="true"
    @pointerup="props.active && !loading && emit('viewed')"
    :load-failed="loadError !== undefined"
    :load-error-message="
      loadError === undefined ? undefined : filePreviewErrorSummary(loadError, props.tab.path)
    "
    :loading="loading"
    :path="props.tab.path"
    :paths="props.tab.paths ?? [props.tab.path]"
    :preview-enabled="props.tab.kind !== 'TOOL_CHANGE_DIFF'"
    :source="
      props.tab.kind === 'TOOL_CHANGE_DIFF'
        ? 'TOOL_CHANGE'
        : props.tab.kind === 'HISTORY_DIFF'
          ? 'HISTORY'
          : 'WORKING_TREE'
    "
    @close="emit('close')"
    @download="emit('download', diff)"
    @edit="emit('edit')"
    @move-file="emit('moveFile', $event)"
    @navigate-file="emit('navigateFile', $event)"
    @navigate-symbol="emit('navigateSymbol', $event)"
    @preview="emit('preview', diff)"
    @retry="load"
  />
</template>
