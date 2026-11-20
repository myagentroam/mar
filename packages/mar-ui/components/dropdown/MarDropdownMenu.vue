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
    :class="dropdown?.popupClass.value"
    :style="[dropdown?.popupStyle.value]"
    popover="manual"
    :aria-labelledby="$attrs['aria-label'] ? undefined : dropdown?.triggerId.value"
  >
    <div class="mar-ui-popup__content"><slot /></div>
  </div>
</template>

<style scoped>
.mar-ui-dropdown__popup {
  min-width: min(10rem, calc(100vw - 16px));
  padding-inline: 0;
}
</style>
