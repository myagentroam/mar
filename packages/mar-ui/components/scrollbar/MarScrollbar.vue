<script setup lang="ts">
defineProps<{ always?: boolean; maxHeight?: string | number }>();
</script>

<template>
  <div
    class="mar-ui-scrollbar"
    :style="{ maxBlockSize: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight }"
  >
    <slot />
  </div>
</template>

<style scoped>
.mar-ui-scrollbar {
  overflow: auto;
  min-block-size: 0;
}
</style>
