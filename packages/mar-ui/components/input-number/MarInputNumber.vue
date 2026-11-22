<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue';
import { MarIcon } from '../../icons/index.js';
import { useMarUiLocale } from '../../locale/index.js';
import { useMarFormControl } from '../form/form-context.js';
import '../form/field-frame.css';

defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    modelValue?: number | null | undefined;
    id?: string;
    min?: number | undefined;
    max?: number | undefined;
    step?: number;
    stepStrictly?: boolean;
    controls?: boolean;
    validateEvent?: boolean;
    disabled?: boolean | undefined;
  }>(),
  { step: 1, controls: true, disabled: undefined }
);
const emit = defineEmits<{
  'update:modelValue': [value: number | null];
  change: [value: number | null, previous: number | null];
}>();
const locale = useMarUiLocale();
const field = useMarFormControl({
  id: () => props.id,
  disabled: () => props.disabled,
  validateEvent: () => props.validateEvent,
  validateModelChange: false
});
const input = useTemplateRef<HTMLInputElement>('input');
const text = ref(String(props.modelValue ?? ''));
let committed = props.modelValue ?? null;
let editing = false;
watch(
  () => props.modelValue,
  (value) => {
    if (!editing) {
      committed = value ?? null;
      text.value = String(value ?? '');
    }
  }
);
const incrementDisabled = computed(
  () =>
    field.disabled.value ||
    (props.modelValue != null && props.max !== undefined && props.modelValue >= props.max)
);
const decrementDisabled = computed(
  () =>
    field.disabled.value ||
    (props.modelValue != null && props.min !== undefined && props.modelValue <= props.min)
);

function normalize(value: number) {
  const next = props.stepStrictly ? Math.round(value / props.step) * props.step : value;
  return Math.min(
    props.max ?? Infinity,
    Math.max(props.min ?? -Infinity, Number(next.toPrecision(15)))
  );
}

async function commit(value: number | null) {
  const previous = committed;
  editing = false;
  if (value !== props.modelValue) emit('update:modelValue', value);
  if (value !== previous) emit('change', value, previous);
  await nextTick();
  committed = props.modelValue ?? null;
  text.value = String(props.modelValue ?? '');
  if (input.value) input.value.value = text.value;
  if (value !== previous) field.change();
}

function edit(event: Event) {
  const target = event.currentTarget as HTMLInputElement;
  editing = true;
  text.value = target.value;
  emit(
    'update:modelValue',
    Number.isFinite(target.valueAsNumber) ? normalize(target.valueAsNumber) : null
  );
}

function fromInput() {
  const target = input.value;
  if (!target || !editing) return;
  void commit(Number.isFinite(target.valueAsNumber) ? normalize(target.valueAsNumber) : null);
}

function step(direction: number) {
  if (direction > 0 ? incrementDisabled.value : decrementDisabled.value) return;
  const value = input.value?.valueAsNumber;
  void commit(
    normalize((Number.isFinite(value) ? value! : (props.modelValue ?? 0)) + direction * props.step)
  );
}

function preventWheelStep(event: WheelEvent) {
  const field = event.currentTarget as HTMLInputElement;
  if (field.ownerDocument.activeElement === field) event.preventDefault();
}
</script>

<template>
  <div
    class="mar-ui-input-number mar-ui-field-frame"
    :class="$attrs.class"
    :style="$attrs.style"
    :data-disabled="field.disabled.value"
    :data-invalid="field.ariaInvalid($attrs['aria-invalid'])"
  >
    <button
      v-if="controls"
      type="button"
      tabindex="-1"
      :aria-label="locale.decrease"
      :disabled="decrementDisabled"
      @pointerdown.prevent
      @click="step(-1)"
    >
      <slot name="decrease-icon"><MarIcon name="subtract" /></slot>
    </button>
    <input
      ref="input"
      v-bind="{ ...$attrs, class: undefined, style: undefined }"
      :id="field.id.value"
      type="number"
      :value="text"
      :min="min"
      :max="max"
      :step="stepStrictly ? props.step : 'any'"
      :disabled="field.disabled.value"
      :aria-invalid="field.ariaInvalid($attrs['aria-invalid'])"
      :aria-describedby="field.describedBy($attrs['aria-describedby'])"
      @input="edit"
      @change="fromInput"
      @keydown.enter="fromInput"
      @blur="field.blur()"
      @keydown.up.prevent="step(1)"
      @keydown.down.prevent="step(-1)"
      @wheel="preventWheelStep"
    />
    <button
      v-if="controls"
      type="button"
      tabindex="-1"
      :aria-label="locale.increase"
      :disabled="incrementDisabled"
      @pointerdown.prevent
      @click="step(1)"
    >
      <slot name="increase-icon"><MarIcon name="plus" /></slot>
    </button>
  </div>
</template>

<style scoped>
.mar-ui-input-number {
  display: inline-flex;
  box-sizing: border-box;
  inline-size: 150px;
  max-inline-size: 100%;
  min-block-size: var(--mar-ui-compact-control-size, 24px);
  overflow: hidden;
}
input {
  flex: 1;
  min-inline-size: 0;
  appearance: textfield;
  border: 0;
  outline: 0;
  padding: 0 0.5rem;
  color: var(--mar-ui-text-primary);
  background: transparent;
  font: inherit;
  font-size: var(--mar-ui-font-size-control);
  line-height: 1.4;
  text-align: center;
}
input::-webkit-inner-spin-button,
input::-webkit-outer-spin-button {
  appearance: none;
  margin: 0;
}
button {
  display: grid;
  place-items: center;
  flex: 0 0 30px;
  border: 0;
  background: var(--mar-ui-bg-subtle);
  color: var(--mar-ui-text-secondary);
  padding: 0;
  cursor: pointer;
}
button:first-child {
  border-inline-end: 1px solid var(--mar-ui-input-border);
}
button:last-child {
  border-inline-start: 1px solid var(--mar-ui-input-border);
}
button:not(:disabled):hover {
  color: var(--mar-ui-control-link-hover);
}
button:disabled,
input:disabled {
  color: var(--mar-ui-text-disabled);
  cursor: not-allowed;
}
</style>
