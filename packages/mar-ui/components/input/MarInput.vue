<script setup lang="ts">
import {
  computed,
  nextTick,
  ref,
  useTemplateRef,
  watch,
  watchPostEffect,
  type Component
} from 'vue';
import type { MarIconName } from '../../icons/icon-shapes.js';
import { resolveMarIcon } from '../../icons/mar-icons.js';
import { useMarUiLocale } from '../../locale/index.js';
import { useMarFormControl } from '../form/form-context.js';
import '../form/field-frame.css';

defineOptions({ inheritAttrs: false });

// Owns the native field and its adornments; form rules and labels belong to the caller.
const props = withDefaults(
  defineProps<{
    id?: string;
    modelValue?: string | number | null | undefined;
    type?: 'text' | 'password' | 'email' | 'number' | 'textarea';
    disabled?: boolean | undefined;
    validateEvent?: boolean;
    readonly?: boolean;
    clearable?: boolean;
    maxlength?: string | number;
    showWordLimit?: boolean;
    showPassword?: boolean;
    passwordToggleLabel?: string;
    rows?: string | number;
    resize?: 'none' | 'both' | 'horizontal' | 'vertical';
    autosize?: boolean | { minRows?: number; maxRows?: number };
    prefixIcon?: MarIconName | Component;
    suffixIcon?: MarIconName | Component;
    clearIcon?: MarIconName | Component;
  }>(),
  { type: 'text', disabled: undefined, validateEvent: true }
);

defineSlots<{
  prepend(): unknown;
  append(): unknown;
  prefix(): unknown;
  suffix(): unknown;
  'password-icon'(props: { visible: boolean }): unknown;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  input: [value: string];
  change: [value: string, event?: Event];
  clear: [event: MouseEvent];
}>();

const locale = useMarUiLocale();
const {
  id: inputId,
  disabled,
  ariaInvalid,
  describedBy,
  blur: validateBlur
} = useMarFormControl({
  id: () => props.id,
  disabled: () => props.disabled,
  validateEvent: () => props.validateEvent
});
const input = useTemplateRef<HTMLInputElement>('input');
const textarea = useTemplateRef<HTMLTextAreaElement>('textarea');
const field = computed(() => input.value ?? textarea.value);
const text = computed(() => String(props.modelValue ?? ''));
const isTextarea = computed(() => props.type === 'textarea');
const canClear = computed(() => props.clearable && !disabled.value && !props.readonly);
const canReveal = computed(
  () => props.type === 'password' && props.showPassword && !disabled.value
);
const passwordVisible = ref(false);
watch([canReveal, text], ([canReveal, text]) => {
  if (!canReveal || !text) passwordVisible.value = false;
});

const wordLimit = computed(() => {
  const limit = Number(props.maxlength);
  if (
    props.showWordLimit &&
    !disabled.value &&
    !props.readonly &&
    (props.type === 'text' || isTextarea.value) &&
    props.maxlength !== '' &&
    Number.isInteger(limit) &&
    limit >= 0
  )
    return limit;
  return undefined;
});
const overLimit = computed(
  () => wordLimit.value !== undefined && text.value.length > wordLimit.value
);

type NativeField = HTMLInputElement | HTMLTextAreaElement;
let composing: NativeField | undefined;
let pendingInput: string | undefined;

function focus(options?: FocusOptions) {
  field.value?.focus(options);
}

function restoreValue(target: NativeField) {
  if (field.value === target && composing !== target && target.value !== text.value) {
    target.value = text.value;
  }
}

watch(
  [field, text, () => props.type],
  ([target]) => {
    if (target) restoreValue(target);
  },
  { flush: 'post' }
);

async function onInput(event: Event) {
  const target = event.target as NativeField;
  const value = target.value;
  if (
    composing === target ||
    (event as InputEvent).isComposing ||
    value === (pendingInput ?? text.value)
  )
    return;
  pendingInput = value;
  emit('update:modelValue', value);
  emit('input', value);
  await nextTick();
  pendingInput = undefined;
  restoreValue(target);
}

function onCompositionStart(event: CompositionEvent) {
  composing = event.target as NativeField;
}

function onCompositionEnd(event: CompositionEvent) {
  if (composing !== event.target) return;
  composing = undefined;
  void onInput(event);
}

function onChange(event: Event) {
  const target = event.target as NativeField;
  // Some input methods commit on blur without a compositionend event.
  if (composing === target) {
    composing = undefined;
    void onInput(event);
  }
  emit('change', target.value, event);
}

async function clear(event: MouseEvent) {
  const target = field.value;
  if (!canClear.value || !target) return;
  target.value = '';
  emit('update:modelValue', '');
  emit('change', '');
  emit('clear', event);
  emit('input', '');
  focus();
  await nextTick();
  restoreValue(target);
}

function sizeTextarea(target: HTMLTextAreaElement, bounds: { minRows?: number; maxRows?: number }) {
  if (!target.getClientRects().length) return;
  const style = getComputedStyle(target);
  const lineHeight = parseFloat(style.lineHeight);
  const verticalPadding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const verticalBorder = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  target.style.height = '0px';
  target.style.overflowY = 'hidden';
  const minHeight = Math.max(1, bounds.minRows ?? 1) * lineHeight + verticalPadding;
  const maxHeight = Math.max(
    minHeight,
    (bounds.maxRows ?? Infinity) * lineHeight + verticalPadding
  );
  const height = Math.min(maxHeight, Math.max(minHeight, target.scrollHeight));
  target.style.height = `${Math.ceil(height + verticalBorder)}px`;
  target.style.overflowY = target.scrollHeight > target.clientHeight ? 'auto' : 'hidden';
}

watchPostEffect((onCleanup) => {
  const target = textarea.value;
  const autosize = props.autosize;
  if (!target || !autosize) return;
  const bounds = typeof autosize === 'object' ? autosize : {};
  let width: number | undefined;
  let frame = 0;
  const observer = new ResizeObserver(([entry]) => {
    if (entry && width !== entry.contentRect.width) {
      width = entry.contentRect.width;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => sizeTextarea(target, bounds));
    }
  });
  observer.observe(target);
  onCleanup(() => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    target.style.removeProperty('height');
    target.style.removeProperty('overflow-y');
  });
});

watch(
  [textarea, text, () => props.autosize, () => props.rows],
  ([target, , autosize]) => {
    if (target && autosize) sizeTextarea(target, typeof autosize === 'object' ? autosize : {});
  },
  { flush: 'post' }
);

defineExpose({
  input,
  textarea,
  focus,
  blur: () => field.value?.blur(),
  select: () => field.value?.select()
});
</script>

<template>
  <span
    class="mar-ui-input mar-ui-field-frame mar-ui-field-frame--inset"
    :data-invalid="overLimit || ariaInvalid($attrs['aria-invalid'])"
    :class="[
      $attrs.class,
      {
        'mar-ui-input--textarea': isTextarea,
        'mar-ui-input--over-limit': overLimit
      }
    ]"
    :style="$attrs.style"
  >
    <span v-if="!isTextarea && $slots.prepend" class="mar-ui-input__addon mar-ui-input__prepend">
      <slot name="prepend" />
    </span>
    <span class="mar-ui-input__body" @click.self="focus()">
      <template v-if="!isTextarea">
        <slot name="prefix" />
        <component
          :is="resolveMarIcon(prefixIcon)"
          v-if="prefixIcon"
          class="mar-ui-input__icon"
          aria-hidden="true"
        />
      </template>
      <textarea
        v-if="isTextarea"
        v-bind="{
          ...$attrs,
          'aria-invalid': ariaInvalid($attrs['aria-invalid']),
          'aria-describedby': describedBy($attrs['aria-describedby']),
          class: undefined,
          style: undefined
        }"
        :id="inputId"
        ref="textarea"
        class="mar-ui-input__field mar-ui-input__field--textarea"
        :rows="rows"
        :maxlength="maxlength"
        :disabled="disabled"
        :readonly="readonly"
        :style="{ resize: resize ?? (autosize ? 'none' : 'vertical') }"
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
        @input="onInput"
        @change="onChange"
        @blur="validateBlur"
      />
      <input
        v-else
        v-bind="{
          ...$attrs,
          'aria-invalid': ariaInvalid($attrs['aria-invalid']),
          'aria-describedby': describedBy($attrs['aria-describedby']),
          class: undefined,
          style: undefined
        }"
        :id="inputId"
        ref="input"
        class="mar-ui-input__field"
        :type="canReveal && passwordVisible ? 'text' : type"
        :maxlength="maxlength"
        :disabled="disabled"
        :readonly="readonly"
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
        @input="onInput"
        @change="onChange"
        @blur="validateBlur"
      />
      <span v-if="canClear || canReveal || wordLimit !== undefined" class="mar-ui-input__tools">
        <button
          v-if="canClear"
          v-show="text"
          type="button"
          class="mar-ui-input__action mar-ui-input__clear"
          :aria-label="locale.clear"
          @mousedown.prevent
          @click="clear"
        >
          <component :is="resolveMarIcon(clearIcon ?? 'clear-input')" aria-hidden="true" />
        </button>
        <button
          v-if="canReveal && text"
          type="button"
          class="mar-ui-input__action"
          :aria-label="passwordToggleLabel ?? 'Show password'"
          :aria-pressed="passwordVisible"
          @mousedown.prevent
          @click="passwordVisible = !passwordVisible"
        >
          <span class="mar-ui-input__action-icon" aria-hidden="true">
            <slot name="password-icon" :visible="passwordVisible">
              <component :is="resolveMarIcon(passwordVisible ? 'view' : 'view-off')" />
            </slot>
          </span>
        </button>
        <span v-if="wordLimit !== undefined" class="mar-ui-input__count">
          {{ text.length }} / {{ wordLimit }}
        </span>
      </span>
      <template v-if="!isTextarea">
        <slot name="suffix" />
        <component
          :is="resolveMarIcon(suffixIcon)"
          v-if="suffixIcon"
          class="mar-ui-input__icon"
          aria-hidden="true"
        />
      </template>
    </span>
    <span v-if="!isTextarea && $slots.append" class="mar-ui-input__addon mar-ui-input__append">
      <slot name="append" />
    </span>
  </span>
</template>

<style scoped>
.mar-ui-input {
  display: inline-flex;
  align-items: stretch;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: var(--mar-ui-compact-control-size, 24px);
  font-size: var(--mar-ui-font-size-meta);
  font-weight: 400;
}
.mar-ui-input--textarea {
  font-size: var(--mar-ui-font-size-input);
}
.mar-ui-input:where(:has(> .mar-ui-input__body > .mar-ui-input__field:enabled)) {
  color: var(--mar-ui-text-secondary);
}
.mar-ui-input__body {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 0.375rem;
  min-width: 0;
  padding-inline: 7px;
}
.mar-ui-input--textarea .mar-ui-input__body {
  display: block;
  padding: 0;
}
.mar-ui-input__field {
  flex: 1 1 0;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--mar-ui-text-primary);
  font: inherit;
  line-height: 1.4;
}
.mar-ui-input__field--textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  padding: 0.3125rem 11px;
}
.mar-ui-input__field::placeholder {
  color: var(--mar-ui-text-secondary);
}
.mar-ui-input__field:disabled {
  color: inherit;
  cursor: inherit;
}
.mar-ui-input__icon {
  flex: none;
  pointer-events: none;
}
.mar-ui-input__tools {
  display: inline-flex;
  gap: 0.375rem;
  align-items: center;
  flex: none;
}
.mar-ui-input--textarea .mar-ui-input__tools:not(:empty) {
  display: flex;
  justify-content: flex-end;
  padding-block-end: 0.25rem;
  padding-inline: 11px;
}
.mar-ui-input__count {
  color: var(--mar-ui-text-secondary);
  font-size: var(--mar-ui-font-size-meta);
  white-space: nowrap;
}
.mar-ui-input--over-limit .mar-ui-input__count {
  color: var(--mar-ui-control-color-danger);
}
.mar-ui-input__action {
  display: inline-grid;
  place-items: center;
  width: max(24px, 1.5em);
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--mar-ui-radius-control);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.mar-ui-input__action-icon {
  display: inline-flex;
}
.mar-ui-input__clear {
  visibility: hidden;
}
.mar-ui-input:is(:hover, :focus-within) .mar-ui-input__clear {
  visibility: visible;
}
.mar-ui-input__action:focus-visible {
  outline: 2px solid var(--mar-ui-control-focus);
}
.mar-ui-input__addon {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  margin-block: 1px;
  padding-inline: 0.625rem;
  background: var(--mar-ui-fill-soft);
}
.mar-ui-input__prepend {
  margin-inline-start: 1px;
  border-inline-end: 1px solid var(--mar-ui-input-border);
  border-start-start-radius: var(--mar-ui-radius-control);
  border-end-start-radius: var(--mar-ui-radius-control);
}
.mar-ui-input__append {
  margin-inline-end: 1px;
  border-inline-start: 1px solid var(--mar-ui-input-border);
  border-start-end-radius: var(--mar-ui-radius-control);
  border-end-end-radius: var(--mar-ui-radius-control);
}
.mar-ui-input__addon:has(> .mar-ui-button) {
  align-items: stretch;
  padding-inline: 0;
}
.mar-ui-input__addon > :deep(.mar-ui-button) {
  --mar-ui-button-bg: transparent;
  --mar-ui-button-disabled-bg: transparent;
  min-block-size: 0;
  padding-block: 0;
  border: 0;
  border-radius: inherit;
}
.mar-ui-input__addon > :deep(.mar-ui-button:focus-visible) {
  outline-offset: -2px;
}
@media (hover: none) {
  .mar-ui-input__clear {
    visibility: visible;
  }
}
</style>
