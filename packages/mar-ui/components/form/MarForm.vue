<script setup lang="ts">
import { provide } from 'vue';
import { formKey, type Field, type FormItemProp, type FormRules } from './form-context.js';
import './form.css';

// Owns the live field registry and explicit validation; items own their individual errors.
const props = defineProps<{
  model?: object;
  rules?: FormRules | undefined;
  disabled?: boolean;
  labelPosition?: 'top' | 'left' | 'right';
  labelWidth?: string | number;
  hideRequiredAsterisk?: boolean;
}>();
const emit = defineEmits<{
  validate: [prop: FormItemProp, valid: boolean, message: string];
}>();
const fields = new Set<Field>();
provide(formKey, {
  model: () => props.model,
  rules: () => props.rules,
  disabled: () => props.disabled,
  register(field) {
    fields.add(field);
    return () => fields.delete(field);
  },
  report: (...args) => emit('validate', ...args)
});

function selected(prop?: FormItemProp) {
  const key = Array.isArray(prop) ? prop.join('.') : prop;
  return [...fields].filter((field) => field.key() && (!key || field.key() === key));
}

async function validateField(prop?: FormItemProp) {
  const errors: Record<string, string> = {};
  for (const field of selected(prop)) {
    const message = await field.validate();
    const key = field.key();
    if (message && key) errors[key] = message;
  }
  if (Object.keys(errors).length) throw errors;
  return true;
}

defineExpose({
  validate: () => validateField(),
  validateField,
  clearValidate: (prop?: FormItemProp) => selected(prop).forEach((field) => field.clear())
});
</script>

<template>
  <form
    class="mar-ui-form"
    :class="[
      `mar-ui-form--${labelPosition ?? 'right'}`,
      { 'mar-ui-form--hide-required': hideRequiredAsterisk }
    ]"
    :style="{
      '--mar-ui-form-label-width': typeof labelWidth === 'number' ? `${labelWidth}px` : labelWidth
    }"
  >
    <slot />
  </form>
</template>
