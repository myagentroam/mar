<script setup lang="ts">
import { MarIcon } from '@myagentroam/mar-ui/icons';
import { computed, ref, watch } from 'vue';
import { observeGifThumbnail } from '../../service/conversation-image-preview-loader.js';
import { conversationThumbnailUrl } from '../../util/conversation-image-url.js';

const props = defineProps<{ source: string; name: string; direct?: boolean | undefined }>();
const emit = defineEmits<{
  click: [event: MouseEvent];
  unavailable: [source: string];
}>();
const failed = ref(false);
const thumbnail = computed(() => conversationThumbnailUrl(props.source, props.direct));
const imageElement = ref<HTMLImageElement>();
const gifSource = computed(() =>
  props.direct && props.source.startsWith('/api/') ? props.source : undefined
);
const gifUrl = ref<string>();
watch(
  [imageElement, gifSource],
  ([element, source], _old, onCleanup) => {
    gifUrl.value = undefined;
    if (element && source)
      onCleanup(observeGifThumbnail(element, source, (url) => (gifUrl.value = url), unavailable));
  },
  { flush: 'post' }
);
watch(thumbnail, () => {
  failed.value = false;
});
function open(event: MouseEvent): void {
  failed.value = false;
  emit('click', event);
}
function unavailable(): void {
  failed.value = true;
  emit('unavailable', props.source);
}
</script>

<template>
  <button
    type="button"
    class="conversation-user-image-button"
    :class="{ 'is-unavailable': failed || !source, 'is-pending': gifSource && !gifUrl }"
    @click="open"
  >
    <img
      v-if="source && !failed"
      ref="imageElement"
      class="conversation-user-image"
      :src="gifSource ? gifUrl : thumbnail"
      :alt="name"
      loading="lazy"
      @error="unavailable"
    />
    <MarIcon name="image" v-else class="conversation-image-fallback" aria-hidden="true" />
  </button>
</template>

<style scoped>
.conversation-user-image-button {
  display: inline-flex;
  max-width: 160px;
  max-height: 120px;
  padding: 0;
  overflow: hidden;
  border: 0;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}
.conversation-user-image {
  display: block;
  box-sizing: border-box;
  width: auto;
  height: auto;
  max-width: 160px;
  max-height: 120px;
  border: 1px solid var(--mar-conversation-border);
  border-radius: 6px;
}
.conversation-user-image-button:is(.is-unavailable, .is-pending) {
  min-width: 2.5rem;
  min-height: 2.5rem;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--mar-border-medium);
  color: var(--mar-text-secondary);
}
.conversation-image-fallback {
  width: 1.25rem;
  height: 1.25rem;
}
</style>
