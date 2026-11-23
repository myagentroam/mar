<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef } from 'vue';
import { MarIcon } from '../../icons/index.js';
import { useMarUiLocale } from '../../locale/index.js';
import { formatLocalDateTime } from './local-date-time.js';

const props = defineProps<{
  month: Date;
  adjacentMonth?: Date | undefined;
  dates: readonly (Date | undefined)[];
}>();
const emit = defineEmits<{ move: [offset: number]; pick: [date: Date]; navigate: [date: Date] }>();
const locale = useMarUiLocale();
const name = computed(() =>
  new Intl.DateTimeFormat(locale.value.datePicker.locale, {
    year: 'numeric',
    month: 'long'
  }).format(props.month)
);
const dayName = computed(
  () => new Intl.DateTimeFormat(locale.value.datePicker.locale, { weekday: 'short' })
);
const dates = computed(() =>
  Array.from({ length: 42 }, (_, index) => {
    const day = new Date(props.month);
    day.setDate(index + 1 - props.month.getDay());
    return day;
  })
);
const key = (date?: Date) => formatLocalDateTime(date).slice(0, 10);
const selection = computed(() => props.dates.map(key));
const grid = useTemplateRef<HTMLElement>('days');
const focusedDay = ref('');
const inMonth = (day: Date, month = props.month) =>
  day.getMonth() === month.getMonth() && day.getFullYear() === month.getFullYear();
const days = computed(() => {
  const [start, end] = selection.value;
  return dates.value.map((date) => {
    const id = key(date);
    const duplicate = props.adjacentMonth && inMonth(date, props.adjacentMonth);
    const selected = !duplicate && (id === start || id === end);
    const band =
      !duplicate && start && end && start < end && id >= start && id <= end
        ? id === start
          ? 'start'
          : id === end
            ? 'end'
            : 'middle'
        : undefined;
    return { date, id, selected, band };
  });
});
const active = computed(() => {
  const current = dates.value.find((day) => inMonth(day) && key(day) === focusedDay.value);
  return key(
    current ??
      props.dates.find((day) => day && inMonth(day)) ??
      dates.value.find((day) => key(day) === key(new Date()) && inMonth(day)) ??
      props.month
  );
});

async function navigate(event: KeyboardEvent, day: Date) {
  if (event.isComposing) return;
  const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
  if (offset === undefined) return;
  event.preventDefault();
  const next = new Date(day);
  next.setDate(day.getDate() + offset);
  if (!inMonth(next)) emit('navigate', next);
  else {
    focusedDay.value = key(next);
    await nextTick();
    grid.value?.querySelector<HTMLButtonElement>(`[data-day="${focusedDay.value}"]`)?.focus();
  }
}
</script>

<template>
  <div class="mar-ui-calendar-month">
    <div class="mar-ui-calendar-month__header">
      <button type="button" :aria-label="locale.datePicker.previousYear" @click="emit('move', -12)">
        <slot name="prev-year"><MarIcon name="chevrons-left" /></slot>
      </button>
      <button type="button" :aria-label="locale.datePicker.previousMonth" @click="emit('move', -1)">
        <slot name="prev-month"><MarIcon name="chevron-left" /></slot>
      </button>
      <strong aria-live="polite">{{ name }}</strong>
      <button type="button" :aria-label="locale.datePicker.nextMonth" @click="emit('move', 1)">
        <slot name="next-month"><MarIcon name="chevron-right" /></slot>
      </button>
      <button type="button" :aria-label="locale.datePicker.nextYear" @click="emit('move', 12)">
        <slot name="next-year"><MarIcon name="chevrons-right" /></slot>
      </button>
    </div>
    <div ref="days" class="mar-ui-calendar-month__days">
      <span
        v-for="day in dates.slice(0, 7)"
        :key="day.getDay()"
        class="mar-ui-calendar-month__weekday"
        aria-hidden="true"
        >{{ dayName.format(day) }}</span
      >
      <button
        v-for="{ date, id, selected, band } in days"
        :key="id"
        class="mar-ui-calendar-month__day"
        type="button"
        :data-outside="!inMonth(date)"
        :data-day="id"
        :tabindex="active === id ? 0 : -1"
        :aria-label="id"
        :aria-pressed="selected"
        :data-range-band="band"
        @click="emit('pick', date)"
        @focus="focusedDay = id"
        @keydown="navigate($event, date)"
      >
        <span class="mar-ui-calendar-month__day-number">{{ date.getDate() }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.mar-ui-calendar-month__header {
  display: flex;
  align-items: center;
  gap: 0.125rem;
}
strong {
  flex: 1;
  text-align: center;
  font-weight: 500;
}
.mar-ui-calendar-month__days {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  margin-block-start: 0.375rem;
  text-align: center;
  font-size: var(--mar-ui-font-size-input);
  font-weight: 400;
}
.mar-ui-calendar-month__weekday {
  color: var(--mar-ui-text-secondary);
  overflow: hidden;
}
button {
  min-inline-size: 0;
  min-block-size: 25px;
  display: grid;
  place-items: center;
  padding: 0.125rem;
  border: 0;
  border-radius: var(--mar-ui-radius-control);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
button[data-outside='true'] {
  color: var(--mar-ui-text-secondary);
}
.mar-ui-calendar-month__header button:hover,
.mar-ui-calendar-month__day:not([aria-pressed='true']):hover .mar-ui-calendar-month__day-number {
  background: var(--mar-ui-fill-row-hover);
}
.mar-ui-calendar-month__day {
  position: relative;
  min-block-size: 1.625rem;
  padding: 0;
}
.mar-ui-calendar-month__day[data-range-band]::before {
  content: '';
  position: absolute;
  inset: 2px 0;
  background: var(--mar-ui-fill-selection);
}
.mar-ui-calendar-month__day[data-range-band='start']::before {
  inset-inline-start: 50%;
}
.mar-ui-calendar-month__day[data-range-band='end']::before {
  inset-inline-end: 50%;
}
.mar-ui-calendar-month__day-number {
  position: relative;
  display: grid;
  place-items: center;
  inline-size: min(1.375rem, 100%);
  block-size: 1.375rem;
  border-radius: 50%;
}
.mar-ui-calendar-month__day[aria-pressed='true'] .mar-ui-calendar-month__day-number {
  background: var(--mar-ui-control-primary-bg);
  color: var(--mar-ui-control-primary-fg);
  font-weight: 700;
}
button:focus-visible {
  outline-offset: -2px;
}
</style>
