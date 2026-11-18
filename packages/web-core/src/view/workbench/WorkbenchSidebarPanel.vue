<script setup lang="ts">
// Shared desktop sidebar shell; consumers own content, scrolling and mobile presentation.
import { ref } from 'vue';

defineProps<{ readonly collapsed: boolean }>();
const element = ref<HTMLElement>();
defineExpose({ element });
</script>

<template>
  <aside ref="element" class="mar-workbench-sidebar" :class="{ collapsed }">
    <slot />
  </aside>
</template>

<style scoped>
@media (min-width: 768px) {
  .mar-workbench-sidebar {
    position: fixed;
    z-index: 3;
    box-sizing: border-box;
    inset: 9px auto 9px calc(var(--mar-activity-rail-width) + 9px);
    width: calc(var(--mar-workbench-sidebar-width) - 9px);
    border: 0;
    border-right: 1px solid var(--mar-workbench-divider);
    border-radius: calc(var(--mar-radius-surface) - 1px) 0 0 calc(var(--mar-radius-surface) - 1px);
    background: var(--mar-bg-panel);
    transition:
      width var(--mar-motion-duration-collapse) var(--mar-motion-easing-collapse),
      visibility 0s;
  }

  .mar-workbench-sidebar.collapsed {
    width: 0;
    overflow: hidden;
    border: 0;
    visibility: hidden;
    pointer-events: none;
    transition-delay: 0s, var(--mar-motion-duration-collapse);
  }
}

@media (prefers-reduced-motion: reduce) {
  .mar-workbench-sidebar {
    transition: none;
  }
}
</style>
