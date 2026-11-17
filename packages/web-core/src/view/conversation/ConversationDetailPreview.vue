<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import MarIcon from '../common/MarIcon.vue';

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
    >
      <MarIcon
        name="chevron-down"
        class="detail-preview-toggle-icon"
        :class="{ 'is-expanded': expanded }"
        aria-hidden="true"
      />{{
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
  --el-button-hover-link-text-color: var(--mar-conversation-text);
  --el-button-active-color: var(--mar-conversation-text);
  margin: 0.375rem 0 0;
  padding: 0;
  border: 0;
  background: transparent;
  height: auto;
  font: inherit;
  font-weight: 400;
  color: var(--mar-conversation-muted);
}
.detail-preview-toggle-icon {
  margin-inline-end: 0.25rem;
}
.detail-preview-toggle-icon.is-expanded {
  transform: rotate(180deg);
}
.detail-preview-toggle:focus-visible {
  outline: 1px solid var(--mar-color-brand);
  outline-offset: 2px;
}
</style>
