<script setup lang="ts" generic="Mode extends 'datetime' | 'datetimerange'">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  useId,
  useTemplateRef,
  watch,
  type Component
} from 'vue';
import { MarIcon } from '../../icons/index.js';
import type { MarIconName } from '../../icons/icon-shapes.js';
import { resolveMarIcon } from '../../icons/mar-icons.js';
import { useMarUiLocale } from '../../locale/index.js';
import { useMarFormControl } from '../form/form-context.js';
import '../form/field-frame.css';
import { usePopup } from '../popup/use-popup.js';
import '../popup/surface.css';
import MarCalendarMonth from './MarCalendarMonth.vue';
import { dateAtMonth, formatLocalDateTime, parseLocalDateTime } from './local-date-time.js';

type Value = (Mode extends 'datetimerange' ? [Date, Date] : Date) | null;
defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    type: Mode;
    modelValue?: Value | undefined;
    id?: string;
    disabled?: boolean | undefined;
    placeholder?: string;
    startPlaceholder?: string;
    endPlaceholder?: string;
    rangeSeparator?: string;
    clearable?: boolean;
    singlePanel?: boolean;
    validateEvent?: boolean;
    prefixIcon?: MarIconName | Component;
    clearIcon?: MarIconName | Component;
  }>(),
  { disabled: undefined, clearable: true }
);
defineSlots<{
  'prev-year'(): unknown;
  'prev-month'(): unknown;
  'next-month'(): unknown;
  'next-year'(): unknown;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: Value]; change: [value: Value] }>();
const locale = useMarUiLocale();
const field = useMarFormControl({
  id: () => props.id,
  disabled: () => props.disabled,
  validateEvent: () => props.validateEvent,
  validateModelChange: false
});
const range = computed(() => props.type === 'datetimerange');
const twoMonths = computed(() => range.value && !props.singlePanel);
const formatted = () =>
  Array.isArray(props.modelValue)
    ? props.modelValue.map(formatLocalDateTime)
    : [formatLocalDateTime(props.modelValue ?? undefined), ''];
const draft = ref(formatted());
let published = formatted();
let valueOnOpen = published;
const typed = ref(false);
let restoringFocus = false;
let unmounting = false;
const month = ref(dateAtMonth(new Date()));
const picked = ref<Date>();
const anchor = useTemplateRef<HTMLElement>('anchor');
const start = useTemplateRef<HTMLInputElement>('start');
const end = useTemplateRef<HTMLInputElement>('end');
const panel = useTemplateRef<HTMLElement>('panel');
const panelId = useId();
onBeforeUnmount(() => {
  unmounting = true;
});
const popup = usePopup(() => {
  if (unmounting) return;
  if (typed.value) publishTyped();
  picked.value = undefined;
  draft.value = [...published];
  if (differs(published, valueOnOpen)) notifyChange(parse(published));
});
const dates = computed(() => draft.value.map(parseLocalDateTime));
const valid = computed(
  () => !!dates.value[0] && (!range.value || (!!dates.value[1] && dates.value[0] <= dates.value[1]))
);

watch(
  () => props.modelValue,
  () => {
    const next = formatted();
    if (!differs(next, published)) return;
    published = next;
    if (popup.open.value) valueOnOpen = next;
    draft.value = [...next];
    typed.value = false;
    picked.value = undefined;
  }
);
watch(field.disabled, (disabled) => {
  if (disabled) {
    typed.value = false;
    popup.close();
  }
});

function show() {
  if (restoringFocus || field.disabled.value || popup.open.value || !anchor.value || !panel.value)
    return;
  valueOnOpen = published;
  month.value = dateAtMonth(dates.value[0] ?? new Date());
  popup.show(anchor.value, panel.value);
}

async function focusCalendar(date?: Date) {
  show();
  if (date) {
    const first = month.value;
    const last = dateAtMonth(first, twoMonths.value ? 1 : 0);
    if (date < first) month.value = dateAtMonth(date);
    else if (date >= dateAtMonth(last, 1))
      month.value = dateAtMonth(date, twoMonths.value ? -1 : 0);
  }
  await nextTick();
  if (!popup.open.value) return;
  const selector = date
    ? `[data-day="${formatLocalDateTime(date).slice(0, 10)}"][data-outside="false"]`
    : 'button[data-day][tabindex="0"]';
  panel.value?.querySelector<HTMLButtonElement>(selector)?.focus();
}

function onInputKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    void focusCalendar(event.target === end.value ? dates.value[1] : dates.value[0]);
  } else if (event.key === 'Enter' && event.keyCode !== 229) {
    event.preventDefault();
    if (valid.value || !draft.value.some(Boolean)) confirm();
    else show();
  }
}

function differs(left: string[], right: string[]) {
  return left.some((text, index) => text !== right[index]);
}

function parse(parts: string[]): Value {
  const [first, second] = parts.map(parseLocalDateTime);
  return (range.value ? (first && second ? [first, second] : null) : (first ?? null)) as Value;
}

function notifyChange(value: Value) {
  emit('change', value);
  void nextTick(field.change);
}

function publish(value: Value) {
  const normalized = Array.isArray(value)
    ? value.map(formatLocalDateTime)
    : [formatLocalDateTime(value ?? undefined), ''];
  if (!differs(normalized, published)) return false;
  published = normalized;
  emit('update:modelValue', value);
  return true;
}

function publishTyped() {
  typed.value = false;
  if (valid.value || !draft.value.some(Boolean)) publish(parse(draft.value));
}

function restoreFocus() {
  restoringFocus = true;
  start.value?.focus();
  restoringFocus = false;
}

function confirm() {
  if (typed.value && (valid.value || !draft.value.some(Boolean)) && !popup.open.value) {
    const value = parse(draft.value);
    typed.value = false;
    if (publish(value)) notifyChange(value);
    draft.value = [...published];
  }
  popup.close();
  restoreFocus();
}

function clear() {
  typed.value = false;
  const changed = publish(null);
  draft.value = [...published];
  if (changed && !popup.open.value) notifyChange(null);
  popup.close();
  restoreFocus();
}

function cancel() {
  typed.value = false;
  popup.close();
  restoreFocus();
}

function pick(day: Date) {
  typed.value = false;
  const date = new Date(day);
  if (!range.value) {
    const old = dates.value[0];
    if (old) date.setHours(old.getHours(), old.getMinutes(), old.getSeconds());
    draft.value[0] = formatLocalDateTime(date);
  } else if (!picked.value) {
    picked.value = date;
    draft.value = [formatLocalDateTime(date), ''];
  } else {
    const [from, to] = +picked.value <= +date ? [picked.value, date] : [date, picked.value];
    draft.value = [formatLocalDateTime(from), formatLocalDateTime(to)];
    picked.value = undefined;
  }
  if (valid.value) publish(parse(draft.value));
}

function setTime(index: number, event: Event) {
  const time = (event.currentTarget as HTMLInputElement).value;
  const date = dates.value[index];
  if (time && date) {
    draft.value[index] =
      `${formatLocalDateTime(date).slice(0, 10)} ${time.length === 5 ? `${time}:00` : time}`;
    if (valid.value) publish(parse(draft.value));
  }
}

function onFocusOut(event: FocusEvent) {
  const target = event.relatedTarget as Node | null;
  if (anchor.value?.contains(target) || panel.value?.contains(target)) return;
  if (target) popup.close();
  field.blur();
}
</script>

<template>
  <div
    class="mar-ui-date-picker"
    :class="$attrs.class"
    :style="$attrs.style"
    @keydown.esc="
      (event) => {
        if (!event.isComposing && popup.open.value) {
          event.stopPropagation();
          event.preventDefault();
          cancel();
        }
      }
    "
    @focusout="onFocusOut"
  >
    <div
      ref="anchor"
      class="mar-ui-date-picker__field mar-ui-field-frame"
      :data-range="range"
      :data-expanded="popup.open.value"
      :data-disabled="field.disabled.value"
      :data-invalid="field.ariaInvalid($attrs['aria-invalid'])"
    >
      <button
        class="mar-ui-date-picker__action"
        type="button"
        :disabled="field.disabled.value"
        :aria-label="locale.datePicker.calendar"
        :aria-expanded="popup.open.value"
        :aria-controls="panelId"
        @pointerdown.prevent
        @click="show"
        @keydown.enter.prevent="focusCalendar()"
        @keydown.space.prevent="focusCalendar()"
      >
        <component :is="resolveMarIcon(prefixIcon ?? 'calendar')" />
      </button>
      <input
        ref="start"
        v-bind="{ ...$attrs, class: undefined, style: undefined }"
        :id="field.id.value"
        v-model="draft[0]"
        class="mar-ui-date-picker__input"
        :aria-label="
          range ? (startPlaceholder ?? locale.datePicker.start) : ($attrs['aria-label'] as string)
        "
        :aria-describedby="field.describedBy($attrs['aria-describedby'])"
        :aria-invalid="field.ariaInvalid($attrs['aria-invalid'])"
        :placeholder="range ? (startPlaceholder ?? locale.datePicker.start) : placeholder"
        :disabled="field.disabled.value"
        @focus="show"
        @click="show"
        @input="typed = true"
        @keydown="onInputKeydown"
      />
      <template v-if="range">
        <span class="mar-ui-date-picker__separator" aria-hidden="true">{{
          rangeSeparator ?? '–'
        }}</span>
        <input
          ref="end"
          v-model="draft[1]"
          class="mar-ui-date-picker__input"
          :aria-label="endPlaceholder ?? locale.datePicker.end"
          :placeholder="endPlaceholder ?? locale.datePicker.end"
          :disabled="field.disabled.value"
          @focus="show"
          @click="show"
          @input="typed = true"
          @keydown="onInputKeydown"
        />
      </template>
      <button
        v-if="clearable !== false && !field.disabled.value && draft.some(Boolean)"
        class="mar-ui-date-picker__action mar-ui-date-picker__clear"
        type="button"
        :aria-label="locale.clear"
        @pointerdown.prevent
        @click="clear"
      >
        <component :is="resolveMarIcon(clearIcon ?? 'clear-input')" />
      </button>
    </div>
    <div
      :id="panelId"
      ref="panel"
      class="mar-ui-popup mar-ui-date-picker__popup"
      :class="twoMonths ? 'mar-ui-date-picker__popup--range' : ''"
      popover="manual"
      role="dialog"
      :aria-label="locale.datePicker.calendar"
    >
      <div class="mar-ui-popup__content">
        <div class="mar-ui-date-picker__months">
          <MarCalendarMonth
            v-for="index in twoMonths ? [0, 1] : [0]"
            :key="index"
            :month="dateAtMonth(month, index)"
            :adjacent-month="twoMonths ? dateAtMonth(month, 1 - index) : undefined"
            :dates="dates"
            @move="month = dateAtMonth(month, $event)"
            @pick="pick"
            @navigate="focusCalendar"
          >
            <template #prev-month
              ><slot name="prev-month"><MarIcon name="chevron-left" /></slot
            ></template>
            <template #next-month
              ><slot name="next-month"><MarIcon name="chevron-right" /></slot
            ></template>
            <template #prev-year
              ><slot name="prev-year"><MarIcon name="chevrons-left" /></slot
            ></template>
            <template #next-year
              ><slot name="next-year"><MarIcon name="chevrons-right" /></slot
            ></template>
          </MarCalendarMonth>
        </div>
        <div class="mar-ui-date-picker__footer">
          <input
            v-for="index in range ? [0, 1] : [0]"
            :key="index"
            type="time"
            step="1"
            :value="formatLocalDateTime(dates[index]).slice(11)"
            :disabled="!dates[index]"
            :aria-label="
              range
                ? index
                  ? locale.datePicker.endTime
                  : locale.datePicker.startTime
                : locale.datePicker.time
            "
            @change="setTime(index, $event)"
          />
          <button type="button" :disabled="!valid" @click="confirm">
            {{ locale.datePicker.confirm }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mar-ui-date-picker {
  display: inline-block;
  min-inline-size: 0;
  inline-size: min(13rem, 100%);
  max-inline-size: 100%;
}
.mar-ui-date-picker:has([data-range='true']) {
  inline-size: min(29rem, 100%);
  container: mar-date-range / inline-size;
}
.mar-ui-date-picker__field {
  display: flex;
  align-items: center;
  min-block-size: var(--mar-ui-compact-control-size, 24px);
  box-sizing: border-box;
}
.mar-ui-date-picker__input {
  flex: 1;
  min-inline-size: 0;
  inline-size: 0;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--mar-ui-text-primary);
  font: inherit;
  font-size: var(--mar-ui-font-size-control);
}
[data-range='true'] .mar-ui-date-picker__input {
  text-align: center;
}
.mar-ui-date-picker__input::placeholder {
  color: var(--mar-ui-text-secondary);
  font-weight: 400;
}
.mar-ui-date-picker__action {
  display: grid;
  place-items: center;
  flex: 0 0 26px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--mar-ui-text-secondary);
  cursor: pointer;
}
.mar-ui-date-picker__separator {
  padding-inline: 0.375rem;
  color: var(--mar-ui-text-secondary);
}
@container mar-date-range (inline-size < 20rem) {
  .mar-ui-date-picker__field[data-range='true'] {
    display: grid;
    grid-template-columns: 2rem minmax(0, 1fr) auto;
    grid-template-rows: repeat(2, minmax(var(--mar-ui-compact-control-size, 24px), auto));
  }
  [data-range='true'] .mar-ui-date-picker__input {
    inline-size: 100%;
    text-align: start;
  }
  .mar-ui-date-picker__separator {
    grid-area: 2 / 1;
    padding-inline: 0;
    text-align: center;
  }
  .mar-ui-date-picker__separator + .mar-ui-date-picker__input {
    grid-area: 2 / 2;
  }
  .mar-ui-date-picker__clear {
    grid-area: 1 / 3 / span 2;
    inline-size: 26px;
  }
}
.mar-ui-date-picker__popup {
  --mar-ui-popup-padding: 0.625rem;
  inline-size: min(18rem, calc(100vw - 16px));
}
.mar-ui-date-picker__popup--range {
  inline-size: min(34rem, calc(100vw - 16px));
}
.mar-ui-date-picker__months {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
  gap: 0.5rem;
}
.mar-ui-date-picker__footer {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  justify-content: flex-end;
  padding-block-start: 0.625rem;
  margin-block-start: 0.5rem;
  border-block-start: 1px solid var(--mar-ui-border-subtle);
  font-size: var(--mar-ui-font-size-control);
}
.mar-ui-date-picker__footer > * {
  min-inline-size: 0;
  border: 1px solid var(--mar-ui-input-border);
  border-radius: var(--mar-ui-radius-control);
  padding: 0.25rem 0.375rem;
  background: var(--mar-ui-bg-panel);
  color: var(--mar-ui-text-primary);
  font: inherit;
}
button:disabled,
input:disabled {
  color: var(--mar-ui-text-disabled);
  cursor: not-allowed;
}
button:focus-visible,
.mar-ui-date-picker__footer input:focus-visible {
  outline: 2px solid var(--mar-ui-control-focus);
  outline-offset: -2px;
}
</style>
