<script setup lang="ts">
import type { MarIconName } from '../../util/icon-shapes.js';
import { MarIconGraphic } from '../../util/mar-icons.js';

withDefaults(defineProps<{ name: MarIconName; size?: number | string; animated?: boolean }>(), {
  size: '1em',
  animated: true
});
</script>

<template>
  <MarIconGraphic
    :name="name"
    :size="size"
    :class="{
      'mar-icon--spinning': animated && (name === 'loading-action' || name === 'loading-content')
    }"
  />
</template>

<style scoped>
.mar-icon--spinning {
  animation: mar-icon-spin 1.4s linear infinite;
}
@keyframes mar-icon-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .mar-icon--spinning {
    animation: none;
  }
}
</style>
