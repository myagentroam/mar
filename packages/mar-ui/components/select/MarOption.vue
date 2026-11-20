<script setup lang="ts">
import { computed, inject, onBeforeUnmount, useId } from 'vue';
import { MarIconGraphic } from '../../icons/mar-icons.js';
import { optionContext, optionGroupId, type Choice, type OptionValue } from './option-context.js';

const props = defineProps<{
  id?: string;
  value: OptionValue;
  label?: string | number;
  disabled?: boolean;
}>();
const generatedId = useId();
const choice: Choice = {
  get id() {
    return props.id ?? generatedId;
  },
  group: inject(optionGroupId, undefined),
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
const selected = computed(() => select?.selected(choice) ?? false);
const unregister = select?.register(choice);
if (unregister) onBeforeUnmount(unregister);
</script>

<template>
  <div
    :id="choice.id"
    :hidden="select && !select.visible(choice)"
    class="mar-ui-option"
    role="option"
    :aria-selected="selected"
    :aria-disabled="(select?.disabled(choice) ?? disabled) || undefined"
    :class="{ 'mar-ui-option--active': select?.active(choice) }"
    @pointermove="
      ($event.pointerType === 'mouse' || $event.pointerType === 'pen') && select?.pointAt(choice)
    "
    @mousedown.prevent
    @click.prevent="select?.choose(choice)"
  >
    <div class="mar-ui-option__content">
      <slot>{{ choice.label }}</slot>
    </div>
    <MarIconGraphic
      v-if="selected && select?.multiple()"
      name="check"
      class="mar-ui-option__check"
    />
  </div>
</template>

<style scoped>
.mar-ui-option {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  min-height: var(--mar-ui-compact-control-size);
  padding-inline: var(--mar-ui-compact-option-padding-inline);
  cursor: pointer;
}
.mar-ui-option[hidden] {
  display: none;
}
.mar-ui-option__content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mar-ui-option__check {
  flex: none;
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
