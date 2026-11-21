<script setup lang="ts">
import { vMarLoading } from './index.js';
defineProps<{ readonly loading: boolean; readonly variant: 'page' | 'region' }>();
</script>

<template>
  <section
    v-mar-loading:[variant]="loading"
    class="page-loading-panel"
    :aria-busy="loading"
    :data-loading-variant="variant"
  >
    <div class="page-loading-content">
      <slot />
    </div>
  </section>
</template>

<style scoped>
/* Keep the loading target stationary while its content scrolls. */
.page-loading-panel {
  display: flex;
  isolation: isolate;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}

.page-loading-content {
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow: auto;
}
</style>
