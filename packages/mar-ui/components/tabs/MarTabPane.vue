<script setup lang="ts">
import { inject } from 'vue';
import { tabsKey } from './tabs-context.js';
import { tabStripIdentity, type TabName } from './tab-types.js';

defineProps<{ name: TabName; label: string; description?: string | undefined }>();
const tabs = inject(tabsKey, undefined);
</script>

<template>
  <div
    class="mar-ui-tab-pane"
    role="tabpanel"
    :id="tabs && tabStripIdentity(tabs.id, name).panel"
    :aria-labelledby="tabs && tabStripIdentity(tabs.id, name).tab"
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
