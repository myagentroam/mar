<script setup lang="ts">
import { computed } from 'vue';

defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{ percentage?: number; showText?: boolean; strokeWidth?: number }>(),
  { percentage: 0, showText: true, strokeWidth: 6 }
);
const percentage = computed(() => Math.min(100, Math.max(0, props.percentage)));
</script>

<template>
  <div class="mar-ui-progress" :class="$attrs.class" :style="$attrs.style">
    <progress
      v-bind="{ ...$attrs, class: undefined, style: undefined }"
      :value="percentage"
      max="100"
      :style="{ '--progress-size': `${strokeWidth}px` }"
    />
    <span v-if="showText" aria-hidden="true">{{ percentage }}%</span>
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
progress {
  appearance: none;
  flex: 1;
  inline-size: 100%;
  min-inline-size: 0;
  block-size: var(--progress-size);
  border: 0;
  border-radius: 999px;
  background: var(--mar-ui-fill-soft);
  accent-color: var(--mar-ui-control-primary-bg);
}
progress::-webkit-progress-bar {
  border-radius: inherit;
  background: var(--mar-ui-fill-soft);
}
progress::-webkit-progress-value {
  border-radius: inherit;
  background: var(--mar-ui-control-primary-bg);
}
progress::-moz-progress-bar {
  border-radius: inherit;
  background: var(--mar-ui-control-primary-bg);
}
</style>
