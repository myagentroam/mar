<script setup lang="ts">
import {
  computed,
  inject,
  onScopeDispose,
  provide,
  shallowReactive,
  shallowRef,
  useId,
  watch
} from 'vue';
import Schema, { type ValidateError } from 'async-validator';
import { fieldControlKey, formKey, type FormItemProp, type FormItemRule } from './form-context.js';
import { useMarUiLocale } from '../../locale/index.js';

// Owns this field's label, error and outstanding validation. The form owns the field registry.
const props = withDefaults(
  defineProps<{
    label?: string;
    prop?: FormItemProp;
    for?: string;
    required?: boolean | undefined;
    showMessage?: boolean;
    validateEvent?: boolean;
  }>(),
  { required: undefined, showMessage: true, validateEvent: true }
);
const form = inject(formKey, undefined);
const locale = useMarUiLocale();
const uid = useId();
const errorId = `${uid}-error`;
const controls = shallowReactive(new Set<{ id(): string | undefined; validates(): boolean }>());
const labelTarget = computed(
  () => props.for ?? (controls.size === 1 ? [...controls][0]?.id() : undefined)
);
const error = shallowRef<string>();
const path = computed(() =>
  Array.isArray(props.prop) ? props.prop : (props.prop?.split('.') ?? [])
);
const key = computed(() => path.value.join('.'));

function atPath(value: unknown) {
  return path.value.reduce<unknown>(
    (current, segment) =>
      current !== null && typeof current === 'object'
        ? (current as Record<string, unknown>)[segment]
        : undefined,
    value
  );
}

const value = computed(() => atPath(form?.model()));
const rules = computed(() => {
  const all = form?.rules();
  const configured = (all?.[key.value] ?? atPath(all)) as FormItemRule | FormItemRule[] | undefined;
  const list = Array.isArray(configured) ? configured : configured ? [configured] : [];
  return props.required === undefined ? list : [...list, { required: props.required }];
});
const required = computed(() => rules.value.some((rule) => rule.required));
let revision = 0;

function clear() {
  revision++;
  error.value = undefined;
}

async function validate(trigger?: 'change' | 'blur') {
  const field = props.prop;
  if (!field || !key.value) return;
  const active = rules.value.flatMap(({ trigger: when, ...rule }) =>
    !trigger || !when || (Array.isArray(when) ? when.includes(trigger) : when === trigger)
      ? [rule]
      : []
  );
  if (!active.length) return;
  const version = ++revision;
  const validator = new Schema({ [key.value]: active });
  let message: string | undefined;
  try {
    await validator.validate(
      { [key.value]: value.value },
      { firstFields: true, suppressWarning: true }
    );
  } catch (failure) {
    const issue = (failure as { errors?: ValidateError[] }).errors?.[0]?.message;
    message = typeof issue === 'string' && issue ? issue : locale.value.invalidField;
  }
  if (version === revision) {
    error.value = message;
    form?.report(field, message === undefined, message ?? '');
  }
  return message;
}

provide(fieldControlKey, {
  register(control) {
    controls.add(control);
    return () => controls.delete(control);
  },
  invalid: () => error.value !== undefined,
  description: () => (error.value && props.showMessage ? errorId : undefined),
  change: () => {
    if (props.validateEvent) void validate('change');
  },
  blur: () => {
    if (props.validateEvent) void validate('blur');
  }
});
const unregister = form?.register({ key: () => key.value, validate, clear });
onScopeDispose(() => {
  clear();
  unregister?.();
});
watch(key, clear);
watch(
  value,
  () => {
    if (
      props.validateEvent &&
      (!controls.size || [...controls].some((control) => control.validates()))
    )
      void validate('change');
  },
  { deep: true, flush: 'post' }
);
</script>

<template>
  <div
    class="mar-ui-form-item"
    :class="{ 'mar-ui-form-item--invalid': error }"
    :role="!labelTarget && (label || $slots.label) ? 'group' : undefined"
    :aria-labelledby="!labelTarget && (label || $slots.label) ? `${uid}-label` : undefined"
  >
    <component
      :is="labelTarget ? 'label' : 'div'"
      v-if="label || $slots.label"
      :for="labelTarget"
      :id="`${uid}-label`"
      class="mar-ui-form-item__label"
    >
      <span v-if="required" class="mar-ui-form-item__required" aria-hidden="true"></span>
      <slot name="label">{{ label }}</slot>
    </component>
    <div class="mar-ui-form-item__content">
      <slot />
      <div v-if="error && showMessage" :id="errorId" class="mar-ui-form-item__error" role="alert">
        {{ error }}
      </div>
    </div>
  </div>
</template>
