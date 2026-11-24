<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { MarIcon } from '@myagentroam/mar-ui/icons';

defineProps<{ label: string; loading: boolean; icon?: string | undefined }>();
const clip = ref<HTMLElement>();
const text = ref<HTMLElement>();
const overflowing = ref(false);
let observer: ResizeObserver | undefined;

onMounted(() => {
  const box = clip.value!;
  const title = text.value!;
  observer = new ResizeObserver(() => {
    overflowing.value = box.scrollWidth > box.clientWidth;
  });
  observer.observe(box);
  observer.observe(title);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <span class="browser-tab-label">
    <span class="browser-tab-icon" aria-hidden="true">
      <MarBusyIndicator v-if="loading" />
      <img v-else-if="icon" :src="`data:image/png;base64,${icon}`" alt="" />
      <MarIcon v-else name="web" />
    </span>
    <span ref="clip" class="browser-tab-clip" :class="{ 'is-overflowing': overflowing }">
      <span ref="text" class="browser-tab-text">{{ label }}</span>
    </span>
  </span>
</template>

<style scoped>
.browser-tab-label {
  display: flex;
  min-inline-size: 0;
  align-items: center;
  gap: 0.375rem;
}
.browser-tab-icon {
  display: grid;
  place-items: center;
  flex: none;
  inline-size: 16px;
  block-size: 16px;
  font-size: 16px;
}
.browser-tab-icon img {
  inline-size: 100%;
  block-size: 100%;
  object-fit: contain;
}
.browser-tab-clip {
  min-inline-size: 0;
  overflow: hidden;
  white-space: nowrap;
}
.browser-tab-clip.is-overflowing {
  mask-image: linear-gradient(to right, #000 calc(100% - 1rem), transparent);
}
.browser-tab-clip.is-overflowing:dir(rtl) {
  mask-image: linear-gradient(to left, #000 calc(100% - 1rem), transparent);
}
.browser-tab-text {
  display: inline-block;
  text-box: trim-both text;
}
</style>
