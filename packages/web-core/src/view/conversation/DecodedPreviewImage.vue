<script setup lang="ts">
import { MarButton } from '@myagentroam/mar-ui/button';
import { computed, ref, shallowRef, watch } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import ImagePreviewViewport from '../common/ImagePreviewViewport.vue';
import FilePreviewLoading from '../workspace/FilePreviewLoading.vue';
import {
  loadConversationImagePreview,
  type LoadedImagePreview
} from '../../service/conversation-image-preview-loader.js';

const props = defineProps<{
  readonly source: string;
  readonly name: string;
  readonly original?: boolean;
  readonly direct?: boolean | undefined;
}>();
const emit = defineEmits<{ error: [source: string]; ready: [resized: boolean] }>();
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
  [() => props.source, () => props.original, () => props.direct, retry],
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
        controller.signal,
        props.direct
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

function unavailable(current: number): void {
  if (current !== generation.value || failed.value) return;
  ready.value = false;
  failed.value = true;
  emit('error', props.source);
}

async function loaded(element: HTMLImageElement): Promise<void> {
  const current = generation.value;
  try {
    await element.decode();
    if (current === generation.value && !failed.value) {
      ready.value = true;
      emit('ready', preview.value?.resized === true);
    }
  } catch {
    unavailable(current);
  }
}
</script>

<template>
  <div class="decoded-preview-image" :aria-busy="loading">
    <FilePreviewLoading v-if="loading" />
    <ImagePreviewViewport
      v-if="preview && !failed"
      :key="generation"
      :src="preview.url"
      :alt="name"
      :ready="ready"
      image-class="attachment-preview-image"
      @load="loaded"
      @error="unavailable(generation)"
    >
      <template v-if="$slots.actions" #actions>
        <slot name="actions" />
      </template>
    </ImagePreviewViewport>
    <div v-if="failed" class="image-preview-failure" role="alert">
      <span>{{ translate('generated.imagePreview.loadFailed') }}</span>
      <MarButton @click="reset">{{ translate('generated.imagePreview.retry') }}</MarButton>
    </div>
  </div>
</template>

<style scoped>
.decoded-preview-image {
  display: grid;
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template: minmax(0, 1fr) / minmax(0, 1fr);
  place-items: center;
}
.decoded-preview-image > * {
  grid-area: 1 / 1;
}
.image-preview-failure {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  color: var(--mar-text-secondary);
}
</style>
