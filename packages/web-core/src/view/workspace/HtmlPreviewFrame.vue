<script setup lang="ts">
import { ref, watch } from 'vue';
import FilePreviewLoading from './FilePreviewLoading.vue';

const props = defineProps<{ url?: string | undefined; loading: boolean; title: string }>();
const emit = defineEmits<{ load: [frame: HTMLIFrameElement] }>();
const loaded = ref(false);
watch(
  () => props.url,
  () => {
    loaded.value = false;
  }
);
function onLoad(event: Event): void {
  loaded.value = true;
  if (event.target instanceof HTMLIFrameElement) emit('load', event.target);
}
</script>

<template>
  <div class="html-preview-body">
    <FilePreviewLoading v-if="loading || (url && !loaded)" variant="page" overlay />
    <iframe
      v-if="url"
      class="html-preview-frame"
      :src="url"
      :title="title"
      sandbox="allow-scripts allow-same-origin"
      referrerpolicy="no-referrer"
      @load="onLoad"
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
</style>
