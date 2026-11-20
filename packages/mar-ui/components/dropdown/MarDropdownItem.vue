<script setup lang="ts">
import { inject, type Component } from 'vue';
import type { MarIconName } from '../../icons/icon-shapes.js';
import { resolveMarIcon } from '../../icons/mar-icons.js';
import { dropdownContext, type Command } from './dropdown-context.js';

const props = defineProps<{
  command?: Command;
  disabled?: boolean;
  divided?: boolean;
  icon?: MarIconName | Component;
}>();
const dropdown = inject(dropdownContext);
</script>

<template>
  <button
    type="button"
    role="menuitem"
    tabindex="-1"
    class="mar-ui-dropdown-item"
    :class="{ 'mar-ui-dropdown-item--divided': divided }"
    :disabled="disabled"
    :aria-disabled="disabled || undefined"
    @click="!disabled && props.command !== undefined && dropdown?.run(props.command)"
  >
    <component :is="resolveMarIcon(icon)" v-if="icon" aria-hidden="true" />
    <slot />
  </button>
</template>

<style scoped>
.mar-ui-dropdown-item {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-height: var(--mar-ui-compact-control-size);
  padding: 0.25rem 0.75rem;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}
.mar-ui-dropdown-item--divided {
  margin-top: 4px;
  border-top: 1px solid var(--mar-ui-overlay-border);
}
.mar-ui-dropdown-item:enabled:is(:hover, :focus-visible) {
  background: var(--mar-ui-fill-row-hover);
}
.mar-ui-dropdown-item:focus-visible {
  outline: 2px solid var(--mar-ui-color-brand);
  outline-offset: -2px;
}
.mar-ui-dropdown-item:disabled {
  color: var(--mar-ui-text-disabled);
  cursor: not-allowed;
}
</style>
