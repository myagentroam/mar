<script setup lang="ts">
import MarIcon from '../common/MarIcon.vue';
import { computed, ref, watch } from 'vue';
import { conversationThumbnailUrl } from '../../util/conversation-image-url.js';

const props = defineProps<{ source: string; name: string }>();
const emit = defineEmits<{
  click: [event: MouseEvent];
  unavailable: [source: string];
}>();
const failed = ref(false);
const thumbnail = computed(() => conversationThumbnailUrl(props.source));
watch(
  () => props.source,
  () => {
    failed.value = false;
  }
);
function open(event: MouseEvent): void {
  failed.value = false;
  emit('click', event);
}
function unavailable(): void {
  failed.value = true;
  emit('unavailable', thumbnail.value);
}
</script>

<template>
  <button
    type="button"
    class="conversation-user-image-button"
    :class="{ 'is-unavailable': failed || !source }"
    @click="open"
  >
    <img
      v-if="source && !failed"
      class="conversation-user-image"
      :src="thumbnail"
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
.conversation-user-image-button:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
.conversation-user-image {
  display: block;
  box-sizing: border-box;
  width: auto;
  height: auto;
  max-width: 160px;
  max-height: 120px;
  border: 1px solid color-mix(in srgb, var(--mar-color-brand) 26%, transparent);
  border-radius: 6px;
}
.conversation-user-image-button.is-unavailable {
  min-width: 2.5rem;
  min-height: 2.5rem;
  align-items: center;
  justify-content: center;
  border: 1px dashed color-mix(in srgb, var(--mar-color-brand) 46%, transparent);
  color: var(--mar-text-secondary);
}
.conversation-image-fallback {
  width: 1.25rem;
  height: 1.25rem;
}
</style>
