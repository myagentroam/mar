<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, useTemplateRef, watch, type Component } from 'vue';
import type { MarIconName } from '../../icons/icon-shapes.js';
import { resolveMarIcon } from '../../icons/mar-icons.js';
import { useMarUiLocale } from '../../locale/index.js';
import { useMarFormControl } from '../form/form-context.js';
import '../form/field-frame.css';
import { usePopup } from '../popup/use-popup.js';
import '../popup/surface.css';

defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    modelValue?: string | null;
    id?: string;
    placeholder?: string;
    format?: 'HH:mm';
    valueFormat?: 'HH:mm';
    disabled?: boolean | undefined;
    clearable?: boolean;
    prefixIcon?: MarIconName | Component;
    clearIcon?: MarIconName | Component;
  }>(),
  { disabled: undefined, clearable: true }
);
type TimeValue = string | null;
const emit = defineEmits<{ 'update:modelValue': [value: TimeValue]; change: [value: TimeValue] }>();
const locale = useMarUiLocale();
const field = useMarFormControl({
  id: () => props.id,
  disabled: () => props.disabled,
  validateModelChange: false
});
const input = useTemplateRef<HTMLInputElement>('time');
const anchor = useTemplateRef<HTMLElement>('anchor');
const panel = useTemplateRef<HTMLElement>('panel');
const popupId = useId();
const draft = ref(props.modelValue ?? '');
const typed = ref(false);
let published = props.modelValue || null;
let valueOnOpen = published;
let restoringFocus = false;
let unmounting = false;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const choices = [24, 60].map((length) =>
  Array.from({ length }, (_, index) => String(index).padStart(2, '0'))
);
onBeforeUnmount(() => {
  unmounting = true;
});
const popup = usePopup(() => {
  if (unmounting) return;
  if (typed.value && (timePattern.test(draft.value) || !draft.value)) publish(draft.value || null);
  typed.value = false;
  draft.value = published ?? '';
  if (published !== valueOnOpen) notifyChange();
});
watch(
  () => props.modelValue,
  (value) => {
    const next = value || null;
    if (next === published) return;
    published = next;
    if (popup.open.value) valueOnOpen = next;
    typed.value = false;
    draft.value = value ?? '';
  }
);
watch(field.disabled, (disabled) => {
  if (disabled) close();
});

function publish(next: TimeValue) {
  if (next !== published) {
    published = next;
    emit('update:modelValue', next);
  }
}
function notifyChange() {
  emit('change', published);
  void nextTick(field.change);
}
function close() {
  typed.value = false;
  draft.value = published ?? '';
  popup.close();
}
function restoreFocus() {
  restoringFocus = true;
  input.value?.focus();
  restoringFocus = false;
}
function cancel() {
  publish(valueOnOpen);
  close();
  restoreFocus();
}
function clear() {
  const changed = published !== null;
  publish(null);
  if (changed && !popup.open.value) notifyChange();
  close();
  restoreFocus();
}
async function show() {
  if (restoringFocus || field.disabled.value || popup.open.value || !anchor.value || !panel.value)
    return;
  valueOnOpen = published;
  popup.show(anchor.value, panel.value);
  await nextTick();
  for (const item of panel.value?.querySelectorAll<HTMLElement>('[aria-pressed=true]') ?? [])
    item.scrollIntoView({ block: 'nearest' });
}
function choose(index: number, value: string) {
  typed.value = false;
  const parts = (timePattern.test(draft.value) ? draft.value : '00:00').split(':');
  parts[index] = value;
  draft.value = parts.join(':');
  publish(draft.value);
}
async function openFromKeyboard() {
  await show();
  panel.value
    ?.querySelector<HTMLElement>('.mar-ui-time-picker__column button[tabindex="0"]')
    ?.focus();
}
function move(event: KeyboardEvent, column: number, index: number) {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  const group = (event.currentTarget as HTMLButtonElement).parentElement;
  const values = choices[column]!;
  const next = (values.length + index + (event.key === 'ArrowUp' ? -1 : 1)) % values.length;
  choose(column, values[next]!);
  group?.querySelectorAll('button')[next]?.focus();
}
function confirm() {
  if (timePattern.test(draft.value) || !draft.value) {
    popup.close();
    restoreFocus();
  }
}
function onInput(event: Event) {
  if ((event as InputEvent).isComposing) return;
  typed.value = true;
  void show();
}
function onInputKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    void openFromKeyboard();
  } else if (event.key === 'Enter' && event.keyCode !== 229) {
    event.preventDefault();
    if (popup.open.value) confirm();
    else void show();
  }
}
function onFocusOut(event: FocusEvent) {
  const next = event.relatedTarget as Node | null;
  if (anchor.value?.contains(next) || panel.value?.contains(next)) return;
  popup.close();
  field.blur();
}
</script>

<template>
  <div
    class="mar-ui-time-picker"
    :class="$attrs.class"
    :style="$attrs.style"
    @focusout="onFocusOut"
    @keydown.esc="
      (event) => {
        if (!event.isComposing && popup.open.value) {
          event.stopPropagation();
          event.preventDefault();
          cancel();
        }
      }
    "
  >
    <div
      ref="anchor"
      class="mar-ui-time-picker__field mar-ui-field-frame"
      :data-disabled="field.disabled.value"
      :data-expanded="popup.open.value"
      :data-invalid="field.ariaInvalid($attrs['aria-invalid'])"
    >
      <button
        type="button"
        :aria-label="locale.datePicker.time"
        :aria-controls="popupId"
        :aria-expanded="popup.open.value"
        :disabled="field.disabled.value"
        @pointerdown.prevent
        @focus="show"
        @click="show"
      >
        <component :is="resolveMarIcon(prefixIcon ?? 'clock')" />
      </button>
      <input
        ref="time"
        v-bind="{ ...$attrs, class: undefined, style: undefined }"
        :id="field.id.value"
        v-model="draft"
        type="text"
        :placeholder="placeholder"
        :disabled="field.disabled.value"
        :aria-invalid="field.ariaInvalid($attrs['aria-invalid'])"
        :aria-describedby="field.describedBy($attrs['aria-describedby'])"
        @focus="show"
        @click="show"
        @input="onInput"
        @keydown="onInputKeydown"
      />
      <button
        v-if="clearable !== false && draft && !field.disabled.value"
        type="button"
        :aria-label="locale.clear"
        @pointerdown.prevent
        @click="clear"
      >
        <component :is="resolveMarIcon(clearIcon ?? 'clear-input')" />
      </button>
    </div>
    <div
      :id="popupId"
      ref="panel"
      class="mar-ui-popup mar-ui-time-picker__popup"
      popover="manual"
      role="dialog"
      :aria-label="locale.datePicker.time"
    >
      <div class="mar-ui-popup__content">
        <div class="mar-ui-time-picker__columns">
          <div
            v-for="(column, index) in choices"
            :key="index"
            class="mar-ui-time-picker__column"
            role="group"
            :aria-label="index === 0 ? locale.datePicker.hours : locale.datePicker.minutes"
          >
            <button
              v-for="(choice, choiceIndex) in column"
              :key="choice"
              type="button"
              :aria-pressed="draft.split(':')[index] === choice"
              :tabindex="
                (timePattern.test(draft) ? draft.split(':')[index] === choice : choiceIndex === 0)
                  ? 0
                  : -1
              "
              @keydown="move($event, index, choiceIndex)"
              @click="choose(index, choice)"
            >
              {{ choice }}
            </button>
          </div>
        </div>
        <div class="mar-ui-time-picker__footer">
          <button type="button" @click="cancel">{{ locale.datePicker.cancel }}</button>
          <button type="button" :disabled="!timePattern.test(draft)" @click="confirm">
            {{ locale.datePicker.confirm }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mar-ui-time-picker {
  display: inline-block;
  inline-size: 10rem;
  max-inline-size: 100%;
}
.mar-ui-time-picker__field {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  box-sizing: border-box;
  min-block-size: var(--mar-ui-compact-control-size, 24px);
  padding-inline: 0.5rem;
}
.mar-ui-time-picker__field:not([data-disabled='true']) {
  color: var(--mar-ui-text-secondary);
}
input {
  min-inline-size: 0;
  flex: 1;
  border: 0;
  padding: 0;
  outline: 0;
  color: var(--mar-ui-text-primary);
  background: transparent;
  font: inherit;
  font-size: var(--mar-ui-font-size-meta);
}
input:disabled {
  color: var(--mar-ui-text-disabled);
}
button {
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 0;
  cursor: pointer;
}
button:focus-visible {
  outline: 2px solid var(--mar-ui-control-focus);
}
.mar-ui-time-picker__popup {
  inline-size: 10rem;
  font-size: var(--mar-ui-font-size-meta);
}
.mar-ui-time-picker__columns {
  display: flex;
}
.mar-ui-time-picker__column {
  flex: 1;
  max-block-size: 10rem;
  overflow: auto;
  scrollbar-width: thin;
}
.mar-ui-time-picker__column + .mar-ui-time-picker__column {
  border-inline-start: 1px solid var(--mar-ui-border-subtle);
}
.mar-ui-time-picker__column button {
  inline-size: 100%;
  min-block-size: var(--mar-ui-compact-control-size, 24px);
  font: inherit;
}
.mar-ui-time-picker__column button:hover {
  background: var(--mar-ui-fill-row-hover);
}
.mar-ui-time-picker__column button[aria-pressed='true'] {
  background: var(--mar-ui-fill-selection);
}
.mar-ui-time-picker__footer {
  display: flex;
  justify-content: flex-end;
  padding: 0.375rem 0.625rem 0;
  border-block-start: 1px solid var(--mar-ui-border-subtle);
}
.mar-ui-time-picker__footer button {
  color: var(--mar-ui-control-link-text);
  font: inherit;
}
button:disabled {
  color: var(--mar-ui-text-disabled);
  cursor: not-allowed;
}
</style>
