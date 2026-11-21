<script setup lang="ts">
import { MarButton } from '@myagentroam/mar-ui/button';
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import { MarIcon } from '@myagentroam/mar-ui/icons';

const contentId = useId();
const viewport = ref<HTMLElement>();
const content = ref<HTMLElement>();
const expanded = ref(false);
const overflowing = ref(false);
interface PreviewMotion {
  animation?: Animation;
  contentHeight?: number;
}
let observer: ResizeObserver | undefined;
let motion: PreviewMotion | undefined;

function measure() {
  const element = content.value!;
  const limit = Number.parseFloat(getComputedStyle(element).lineHeight) * 12;
  const height = element.getBoundingClientRect().height;
  overflowing.value = height > Math.ceil(limit);
  // Let the current layout take over if streamed text or reflow invalidates the measured endpoint.
  if (motion?.contentHeight !== undefined && motion.contentHeight !== height) cancelMotion();
}

function cancelMotion(): void {
  motion?.animation?.cancel();
  motion = undefined;
}

async function togglePreview(): Promise<void> {
  const element = viewport.value!;
  const duration = getComputedStyle(element).getPropertyValue('--mar-motion-duration-fast').trim();
  const durationMs = Number.parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000);
  if (!durationMs) {
    cancelMotion();
    expanded.value = !expanded.value;
    return;
  }

  // Read the visible height before cancelling so a reversal starts where the last motion stopped.
  const start = element.getBoundingClientRect().height;
  cancelMotion();
  const current: PreviewMotion = {};
  motion = current;
  expanded.value = !expanded.value;
  await nextTick();
  if (motion !== current) return;

  const end = element.getBoundingClientRect().height;
  if (start === end) {
    cancelMotion();
    return;
  }
  current.contentHeight = content.value!.getBoundingClientRect().height;
  current.animation = element.animate(
    { maxHeight: [`${start}px`, `${end}px`], overflow: ['hidden', 'hidden'] },
    { duration: durationMs, easing: 'ease', fill: 'both' }
  );
  current.animation.onfinish = () => {
    if (motion === current) cancelMotion();
  };
}

async function revealFocusedContent(event: FocusEvent) {
  if ((!motion && expanded.value) || !overflowing.value) return;
  cancelMotion();
  expanded.value = true;
  await nextTick();
  (event.target as Element).scrollIntoView({ block: 'nearest' });
}
onMounted(() => {
  observer = new ResizeObserver(measure);
  observer.observe(content.value!);
  measure();
});
onBeforeUnmount(() => {
  observer?.disconnect();
  cancelMotion();
});
</script>

<template>
  <div class="detail-preview">
    <div
      :id="contentId"
      ref="viewport"
      class="detail-preview-window"
      :class="{ 'is-collapsed': !expanded }"
      @focusin="revealFocusedContent"
    >
      <div ref="content" class="detail-preview-content"><slot /></div>
    </div>
    <MarButton
      v-if="overflowing"
      link
      class="detail-preview-toggle"
      :aria-expanded="expanded"
      :aria-controls="contentId"
      @click.stop="togglePreview"
    >
      <span class="detail-preview-toggle-content">
        <MarIcon
          name="chevron-down"
          class="detail-preview-toggle-icon"
          :class="{ 'is-expanded': expanded }"
          aria-hidden="true"
        />
        <span class="detail-preview-toggle-text">{{
          translate(
            expanded ? 'toolPresentation.detail.showLess' : 'toolPresentation.detail.showMore'
          )
        }}</span>
      </span>
    </MarButton>
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
  --mar-ui-action-icon-size: 1em;
  --mar-ui-button-hover-fg: var(--mar-text-primary);
  --mar-ui-button-active-fg: var(--mar-text-primary);
  margin: 0.375rem 0 0;
  padding: 0;
  border: 0;
  background: transparent;
  height: auto;
  font: inherit;
  font-weight: 400;
  color: var(--mar-text-secondary);
}
.detail-preview-toggle-content {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-block-size: 1lh;
}
.detail-preview-toggle-text {
  text-box: trim-both cap alphabetic;
}
.detail-preview-toggle-icon {
  transition: transform var(--mar-motion-duration-fast);
}
.detail-preview-toggle-icon.is-expanded {
  transform: rotate(180deg);
}
.detail-preview-toggle:focus-visible {
  outline: 1px solid var(--mar-color-brand);
  outline-offset: 2px;
}
</style>
