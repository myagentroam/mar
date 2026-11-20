<script setup lang="ts">
import { inject, onBeforeUnmount, useId } from 'vue';
import { optionContext, type OptionValue } from './option-context.js';

const props = defineProps<{ value: OptionValue; label?: string | number; disabled?: boolean }>();
const id = useId();
const choice = {
  id,
  get value() {
    return props.value;
  },
  get label() {
    return props.label ?? String(props.value);
  },
  get disabled() {
    return props.disabled;
  }
};
const select = inject(optionContext);
const unregister = select?.register(choice);
if (unregister) onBeforeUnmount(unregister);
</script>

<template>
  <div
    :id="id"
    class="mar-ui-option"
    role="option"
    :aria-selected="select?.selected(choice) ?? false"
    :aria-disabled="disabled || undefined"
    :class="{ 'mar-ui-option--active': select?.active(choice) }"
    @mousedown.prevent
    @click="select?.choose(choice)"
  >
    {{ choice.label }}
  </div>
</template>

<style scoped>
.mar-ui-option {
  display: flex;
  align-items: center;
  min-height: var(--mar-ui-compact-control-size);
  padding-inline: var(--mar-ui-compact-option-padding-inline);
  cursor: pointer;
}
.mar-ui-option[aria-selected='true'] {
  background: var(--mar-ui-fill-selection);
}
.mar-ui-option:not([aria-selected='true'], [aria-disabled='true']):hover {
  background: var(--mar-ui-fill-row-hover);
}
.mar-ui-option--active:not([aria-disabled='true']) {
  outline: var(--mar-ui-select-option-focus, none);
  outline-offset: -2px;
}
.mar-ui-option[aria-disabled='true'] {
  color: var(--mar-ui-text-disabled);
  cursor: not-allowed;
}
</style>
