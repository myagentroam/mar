<script setup lang="ts">
import { computed } from 'vue';

defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    percentage?: number;
    showText?: boolean;
    strokeWidth?: number;
    indeterminate?: boolean;
  }>(),
  { percentage: 0, showText: true, strokeWidth: 6 }
);
const percentage = computed(() => Math.min(100, Math.max(0, props.percentage)));
</script>

<template>
  <div class="mar-ui-progress" :class="$attrs.class" :style="$attrs.style">
    <div class="mar-ui-progress__track" :style="{ '--progress-size': `${strokeWidth}px` }">
      <progress
        v-bind="{ ...$attrs, class: undefined, style: undefined }"
        :value="indeterminate ? undefined : percentage"
        max="100"
      />
      <span v-if="indeterminate" class="mar-ui-progress__segment" aria-hidden="true" />
    </div>
    <span v-if="showText && !indeterminate" aria-hidden="true">{{ percentage }}%</span>
  </div>
</template>

<style scoped>
.mar-ui-progress {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--mar-ui-text-secondary);
  font-size: var(--mar-ui-font-size-meta);
}
.mar-ui-progress__track {
  position: relative;
  flex: 1;
  min-inline-size: 0;
  block-size: var(--progress-size);
  border-radius: 999px;
  overflow: clip;
  background: var(--mar-ui-fill-soft);
}
progress {
  display: block;
  appearance: none;
  inline-size: 100%;
  block-size: 100%;
  border: 0 solid;
  border-radius: 999px;
  overflow: clip;
  background: transparent;
  accent-color: var(--mar-ui-control-primary-bg);
}
/* Keep the native indeterminate semantics even where the UA does not paint a fill. */
progress:indeterminate {
  opacity: 0;
}
progress::-webkit-progress-bar {
  background: transparent;
}
progress::-webkit-progress-value {
  border-radius: 999px;
  background: var(--mar-ui-control-primary-bg);
}
progress::-moz-progress-bar {
  border-radius: 999px;
  background: var(--mar-ui-control-primary-bg);
}
.mar-ui-progress__segment {
  position: absolute;
  inset-block: 0;
  inset-inline-start: 0;
  inline-size: 30%;
  border-radius: inherit;
  background: var(--mar-ui-control-primary-bg);
  pointer-events: none;
  animation: mar-progress-slide 1.5s ease-in-out infinite alternate;
}
.mar-ui-progress__segment:dir(rtl) {
  --mar-progress-travel: -233.33%;
}
@media (prefers-reduced-motion: reduce) {
  .mar-ui-progress__segment {
    animation: none;
    inset-inline-start: 35%;
  }
}
@keyframes mar-progress-slide {
  to {
    translate: var(--mar-progress-travel, 233.33%);
  }
}
</style>
