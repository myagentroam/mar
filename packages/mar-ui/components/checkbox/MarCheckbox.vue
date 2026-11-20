<script setup lang="ts">
import { computed, inject, nextTick, useId } from 'vue';
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
    size?: 'small' | 'default';
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
  <span class="mar-ui-checkbox" :data-size="size" :class="$attrs.class" :style="$attrs.style">
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
  min-block-size: 32px;
  color: var(--mar-ui-text-primary);
  font-size: var(--mar-ui-font-size-body);
  vertical-align: middle;
}
.mar-ui-checkbox[data-size='small'] {
  min-block-size: var(--mar-ui-compact-control-size);
  font-size: var(--mar-ui-font-size-meta);
}
input {
  inline-size: 14px;
  block-size: 14px;
  margin: 0;
  flex: none;
  accent-color: var(--mar-ui-color-brand);
}
label,
input {
  cursor: pointer;
}
input:disabled,
input:disabled + label {
  color: var(--mar-ui-text-disabled);
  cursor: not-allowed;
}
input:focus-visible {
  outline: 2px solid var(--mar-ui-color-brand);
  outline-offset: 2px;
}
@supports not (accent-color: auto) {
  input:checked {
    outline: 1px solid var(--mar-ui-color-brand);
  }
}
</style>
