<script setup lang="ts">
defineProps<{ readonly loading: boolean }>();
</script>

<template>
  <section v-loading="loading" class="page-loading-panel" :aria-busy="loading">
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
