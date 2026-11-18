<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue';
import FilePreviewLoading from './FilePreviewLoading.vue';

// Owns iframe navigation and swaps a loaded replacement without moving its DOM node.
const props = defineProps<{
  url?: string | undefined;
  loading: boolean;
  title: string;
  retainOnReload?: boolean;
}>();
const emit = defineEmits<{ load: [frame: HTMLIFrameElement] }>();
type Frame = { readonly id: number; readonly url: string };
const visible = shallowRef<Frame>();
const pending = shallowRef<Frame>();
const frames = computed(() =>
  [visible.value, pending.value].filter((frame) => frame !== undefined)
);
const rendering = computed(() => pending.value !== undefined);
let nextId = 0;

watch(
  () => props.url,
  (url) => {
    if (!props.retainOnReload) visible.value = undefined;
    pending.value = url ? { id: nextId++, url } : undefined;
  },
  { immediate: true }
);
function onLoad(frame: Frame, event: Event): void {
  if (!(event.target instanceof HTMLIFrameElement)) return;
  if (frame === pending.value) {
    visible.value = frame;
    pending.value = undefined;
  } else if (frame !== visible.value) return;
  emit('load', event.target);
}

defineExpose({ rendering });
</script>

<template>
  <div class="html-preview-body">
    <FilePreviewLoading v-if="!visible && (loading || rendering)" variant="page" overlay />
    <iframe
      v-for="frame in frames"
      :key="frame.id"
      class="html-preview-frame"
      :class="{ 'is-pending': frame === pending, 'is-buffered': visible && frame === pending }"
      :src="frame.url"
      :title="title"
      :inert="frame === pending"
      sandbox="allow-scripts allow-same-origin"
      referrerpolicy="no-referrer"
      @load="onLoad(frame, $event)"
    />
  </div>
</template>

<style scoped>
.html-preview-body {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
}
iframe {
  width: 100%;
  flex: 1;
  min-height: 0;
  border: 0;
  background: white;
}
.is-pending {
  visibility: hidden;
}
.is-buffered {
  position: absolute;
  inset: 0;
  height: 100%;
}
</style>
