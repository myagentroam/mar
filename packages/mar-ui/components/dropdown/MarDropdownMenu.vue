<script setup lang="ts">
import { inject, shallowRef } from 'vue';
import { dropdownContext } from './dropdown-context.js';
import '../popup/surface.css';

const dropdown = inject(dropdownContext);
const surface = dropdown?.surface ?? shallowRef(null);
</script>

<template>
  <div
    :id="dropdown?.menuId"
    ref="surface"
    role="menu"
    tabindex="-1"
    class="mar-ui-popup mar-ui-dropdown__popup"
    popover="manual"
    :aria-labelledby="dropdown?.triggerId.value"
  >
    <slot />
  </div>
</template>

<style scoped>
.mar-ui-dropdown__popup {
  min-width: min(10rem, calc(100vw - 16px));
}
</style>
