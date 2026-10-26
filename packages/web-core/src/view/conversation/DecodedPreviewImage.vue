<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import FilePreviewLoading from '../workspace/FilePreviewLoading.vue';
import {
  loadConversationImagePreview,
  type LoadedImagePreview
} from '../../service/conversation-image-preview-loader.js';

const props = defineProps<{
  readonly source: string;
  readonly name: string;
  readonly original?: boolean;
}>();
const emit = defineEmits<{ error: [source: string]; ready: [resized: boolean] }>();
const image = shallowRef<HTMLImageElement>();
const preview = shallowRef<LoadedImagePreview>();
const ready = ref(false);
const failed = ref(false);
const generation = ref(0);
const retry = ref(0);
const loading = computed(() => Boolean(props.source) && !ready.value && !failed.value);

function reset(): void {
  retry.value += 1;
}
watch(
  [() => props.source, () => props.original, retry],
  async (_, __, onCleanup) => {
    const current = ++generation.value;
    const controller = new AbortController();
    let loaded: LoadedImagePreview | undefined;
    ready.value = false;
    failed.value = false;
    preview.value = undefined;
    onCleanup(() => {
      controller.abort();
      generation.value += 1;
      loaded?.release();
    });
    if (!props.source) return;
    try {
      loaded = await loadConversationImagePreview(
        props.source,
        props.original === true,
        controller.signal
      );
      if (controller.signal.aborted || current !== generation.value) {
        loaded.release();
        return;
      }
      preview.value = loaded;
    } catch {
      if (controller.signal.aborted || current !== generation.value) return;
      failed.value = true;
      emit('error', props.source);
    }
  },
  { immediate: true, flush: 'sync' }
);

function unavailable(element: HTMLImageElement): void {
  if (element !== image.value || failed.value) return;
  ready.value = false;
  failed.value = true;
  emit('error', props.source);
}

async function loaded(event: Event): Promise<void> {
  const element = event.target as HTMLImageElement;
  const current = generation.value;
  try {
    await element.decode();
    if (current === generation.value && element === image.value) {
      ready.value = true;
      emit('ready', preview.value?.resized === true);
    }
  } catch {
    if (current === generation.value) unavailable(element);
  }
}
</script>

<template>
  <div
    class="decoded-preview-image"
    :class="{ 'is-original': original }"
    :aria-busy="loading"
    :tabindex="original ? 0 : undefined"
  >
    <FilePreviewLoading v-if="loading" />
    <img
      v-if="preview && !failed"
      v-show="ready"
      ref="image"
      :key="generation"
      class="attachment-preview-image"
      :src="preview.url"
      :alt="name"
      decoding="async"
      @load="loaded"
      @error="unavailable($event.target as HTMLImageElement)"
    />
    <div v-if="failed" class="image-preview-failure" role="alert">
      <span>{{ translate('generated.imagePreview.loadFailed') }}</span>
      <el-button @click="reset">{{ translate('generated.imagePreview.retry') }}</el-button>
    </div>
  </div>
</template>

<style scoped>
.decoded-preview-image {
  display: flex;
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  align-items: center;
  justify-content: center;
}
.attachment-preview-image {
  display: block;
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.decoded-preview-image.is-original {
  display: block;
  overflow: auto;
}
.is-original .attachment-preview-image {
  max-width: none;
  max-height: none;
  margin: auto;
}
.image-preview-failure {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  color: var(--mar-text-secondary);
}
</style>
