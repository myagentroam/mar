<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { translate } from '../../service/locale-preference-service.js';

const contentId = useId();
const content = ref<HTMLElement>();
const expanded = ref(false);
const overflowing = ref(false);
let observer: ResizeObserver | undefined;

function measure() {
  const element = content.value!;
  const limit = Number.parseFloat(getComputedStyle(element).lineHeight) * 12;
  overflowing.value = element.getBoundingClientRect().height > Math.ceil(limit);
}
async function revealFocusedContent(event: FocusEvent) {
  if (expanded.value || !overflowing.value) return;
  expanded.value = true;
  await nextTick();
  (event.target as Element).scrollIntoView({ block: 'nearest' });
}
onMounted(() => {
  observer = new ResizeObserver(measure);
  observer.observe(content.value!);
  measure();
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div class="detail-preview">
    <div
      :id="contentId"
      class="detail-preview-window"
      :class="{ 'is-collapsed': !expanded }"
      @focusin="revealFocusedContent"
    >
      <div ref="content" class="detail-preview-content"><slot /></div>
    </div>
    <el-button
      v-if="overflowing"
      link
      class="detail-preview-toggle"
      :aria-expanded="expanded"
      :aria-controls="contentId"
      @click.stop="expanded = !expanded"
      >{{
        translate(
          expanded ? 'toolPresentation.detail.showLess' : 'toolPresentation.detail.showMore'
        )
      }}</el-button
    >
  </div>
</template>

<style scoped>
.detail-preview,
.detail-preview-window,
.detail-preview-content {
  min-width: 0;
}
.detail-preview-window.is-collapsed {
  max-height: calc(var(--mar-font-size-detail) * 1.65 * 12);
  overflow: hidden;
}
.detail-preview-toggle {
  margin: 0.375rem 0 0;
  padding: 0;
  height: auto;
  font: inherit;
  font-weight: 400;
  color: var(--mar-text-secondary);
}
.detail-preview-toggle:focus-visible {
  outline: 1px solid var(--mar-color-brand);
  outline-offset: 2px;
}
</style>
