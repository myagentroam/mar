<script setup lang="ts" generic="Value extends RadioValue">
import { provide, useId } from 'vue';
import { useMarFormControl } from '../form/form-context.js';
import { radioGroupKey, type RadioValue } from './radio-context.js';

const props = withDefaults(
  defineProps<{
    modelValue?: Value | readonly string[] | undefined;
    id?: string;
    disabled?: boolean | undefined;
  }>(),
  { disabled: undefined }
);
const emit = defineEmits<{ 'update:modelValue': [value: Value]; change: [value: Value] }>();
const field = useMarFormControl({ id: () => props.id, disabled: () => props.disabled });

provide(radioGroupKey, {
  name: useId(),
  disabled: () => field.disabled.value,
  checked: (value) => props.modelValue === value,
  select(value) {
    emit('update:modelValue', value as Value);
    emit('change', value as Value);
  }
});
</script>

<template>
  <div
    :id="field.id.value"
    class="mar-ui-radio-group"
    role="radiogroup"
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
.mar-ui-radio-group {
  display: flex;
  flex-wrap: wrap;
  gap: 0 1rem;
}
.mar-ui-radio-group:has(> :deep(.mar-ui-radio--button)) {
  gap: 0;
}
</style>
