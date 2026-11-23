<script setup lang="ts">
import { computed, inject, nextTick, useId } from 'vue';
import { MarIcon } from '../../icons/index.js';
import { useMarFormControl } from '../form/form-context.js';
import { checkboxGroupKey, type CheckboxValue } from './checkbox-context.js';

defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    modelValue?: boolean;
    id?: string;
    disabled?: boolean | undefined;
    value?: CheckboxValue;
    label?: CheckboxValue;
  }>(),
  { disabled: undefined }
);
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; change: [value: boolean] }>();
const group = inject(checkboxGroupKey, undefined);
const fallbackId = useId();
const field = group
  ? undefined
  : useMarFormControl({ id: () => props.id, disabled: () => props.disabled });
const id = computed(() => field?.id.value ?? props.id ?? fallbackId);
const disabled = computed(() => props.disabled || group?.disabled() || field?.disabled.value);
const value = computed(() => props.value ?? props.label);
const checked = computed(() =>
  group && value.value !== undefined ? group.checked(value.value) : !!props.modelValue
);

async function change(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  if (group) {
    if (value.value !== undefined) group.select(value.value, input.checked);
  } else {
    emit('update:modelValue', input.checked);
    emit('change', input.checked);
  }
  await nextTick();
  input.checked = checked.value;
}
</script>

<template>
  <span class="mar-ui-checkbox" :class="$attrs.class" :style="$attrs.style">
    <span class="mar-ui-checkbox__box">
      <input
        v-bind="{ ...$attrs, class: undefined, style: undefined }"
        :id="id"
        type="checkbox"
        :name="group?.id"
        :checked="checked"
        :disabled="disabled"
        :aria-invalid="field?.ariaInvalid($attrs['aria-invalid'])"
        :aria-describedby="field?.describedBy($attrs['aria-describedby'])"
        @change="change"
        @blur="field?.blur()"
      />
      <MarIcon class="mar-ui-checkbox__check" name="check" :size="12" aria-hidden="true" />
    </span>
    <label v-if="$slots.default || label !== undefined" :for="id"
      ><slot>{{ label }}</slot></label
    >
  </span>
</template>

<style scoped>
.mar-ui-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-block-size: var(--mar-ui-compact-control-size, 24px);
  color: var(--mar-ui-text-primary);
  font-size: var(--mar-ui-font-size-control);
  vertical-align: middle;
}
.mar-ui-checkbox__box {
  display: inline-grid;
  place-items: center;
  flex: none;
}
input {
  grid-area: 1 / 1;
  inline-size: 14px;
  block-size: 14px;
  margin: 0;
}
.mar-ui-checkbox__check {
  display: none;
  grid-area: 1 / 1;
  color: var(--mar-ui-control-primary-fg);
  pointer-events: none;
}
label {
  display: block;
  color: inherit;
  font: inherit;
  font-weight: 400;
}
label,
input {
  cursor: pointer;
}
input:disabled,
.mar-ui-checkbox:has(input:disabled) > label {
  color: var(--mar-ui-text-disabled);
  cursor: not-allowed;
}
@media (forced-colors: none) {
  input {
    appearance: none;
    /* The outline alone identifies an unchecked box. */
    border: 1px solid color-mix(in srgb, var(--mar-ui-border-medium) 60%, var(--mar-ui-text-muted));
    border-radius: min(3px, var(--mar-ui-radius-control));
    background: var(--mar-ui-bg-panel);
  }
  .mar-ui-checkbox:hover input:enabled:not(:checked) {
    border-color: color-mix(in srgb, var(--mar-ui-border-medium) 45%, var(--mar-ui-text-muted));
  }
  input:checked {
    border-color: var(--mar-ui-control-primary-bg);
    background: var(--mar-ui-control-primary-bg);
  }
  input:checked + .mar-ui-checkbox__check {
    display: block;
  }
  input:disabled {
    border-color: var(--mar-ui-border-subtle);
    background: var(--mar-ui-fill-soft);
  }
  input:disabled + .mar-ui-checkbox__check {
    color: var(--mar-ui-text-disabled);
  }
}
</style>
