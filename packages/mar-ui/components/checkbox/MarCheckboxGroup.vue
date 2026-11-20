<script setup lang="ts" generic="Value extends CheckboxValue">
import { provide, useId } from 'vue';
import { useMarFormControl } from '../form/form-context.js';
import { checkboxGroupKey, type CheckboxValue } from './checkbox-context.js';

const props = withDefaults(
  defineProps<{ modelValue: readonly Value[]; id?: string; disabled?: boolean | undefined }>(),
  { disabled: undefined }
);
const emit = defineEmits<{ 'update:modelValue': [value: Value[]]; change: [value: Value[]] }>();
const field = useMarFormControl({ id: () => props.id, disabled: () => props.disabled });
const name = useId();

provide(checkboxGroupKey, {
  id: name,
  disabled: () => field.disabled.value,
  checked: (value) => props.modelValue.includes(value as Value),
  select(value, checked) {
    const current = props.modelValue;
    const next = checked ? [...current, value as Value] : current.filter((item) => item !== value);
    emit('update:modelValue', next);
    emit('change', next);
  }
});
</script>

<template>
  <div
    :id="field.id.value"
    class="mar-ui-checkbox-group"
    role="group"
    :aria-invalid="field.ariaInvalid($attrs['aria-invalid'])"
    :aria-describedby="field.describedBy($attrs['aria-describedby'])"
    @focusout="
      (e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null))
          field.blur();
      }
    "
  >
    <slot />
  </div>
</template>

<style scoped>
.mar-ui-checkbox-group {
  display: flex;
  flex-wrap: wrap;
  gap: 0 1rem;
}
</style>
