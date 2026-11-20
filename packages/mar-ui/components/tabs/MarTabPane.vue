<script setup lang="ts">
import { inject } from 'vue';
import { tabsKey, type TabName } from './tabs-context.js';
defineProps<{ name: TabName; label: string }>();
const tabs = inject(tabsKey, undefined);
</script>

<template>
  <div
    class="mar-ui-tab-pane"
    role="tabpanel"
    :id="`${tabs?.id}-panel-${name}`"
    :aria-labelledby="`${tabs?.id}-tab-${name}`"
    :hidden="tabs?.active() !== name"
  >
    <slot />
  </div>
</template>

<style scoped>
.mar-ui-tab-pane[hidden] {
  /* Consumer layout (e.g. display: grid) only applies to the active panel. */
  display: none !important;
}
</style>
