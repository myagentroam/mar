<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef } from 'vue';
import { MarIcon } from '../../icons/index.js';
import { useMarUiLocale } from '../../locale/index.js';
import { formatLocalDateTime } from './local-date-time.js';

const props = defineProps<{ month: Date; dates: readonly (Date | undefined)[] }>();
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
const grid = useTemplateRef<HTMLElement>('days');
const focusedDay = ref('');
const inMonth = (day: Date) =>
  day.getMonth() === props.month.getMonth() && day.getFullYear() === props.month.getFullYear();
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
      <span v-for="day in dates.slice(0, 7)" :key="day.getDay()" aria-hidden="true">{{
        dayName.format(day)
      }}</span>
      <button
        v-for="day in dates"
        :key="key(day)"
        type="button"
        :data-outside="!inMonth(day)"
        :data-day="key(day)"
        :tabindex="active === key(day) ? 0 : -1"
        :aria-label="key(day)"
        :aria-pressed="props.dates.some((date) => key(date) === key(day))"
        :data-between="
          props.dates[0] &&
          props.dates[1] &&
          key(day) > key(props.dates[0]) &&
          key(day) < key(props.dates[1])
        "
        @click="emit('pick', day)"
        @focus="focusedDay = key(day)"
        @keydown="navigate($event, day)"
      >
        {{ day.getDate() }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.mar-ui-calendar-month {
  min-inline-size: min(16rem, 100%);
}
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
}
span {
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
button:hover {
  background: var(--mar-ui-fill-row-hover);
}
button[data-between='true'],
button[aria-pressed='true'] {
  background: var(--mar-ui-fill-selection);
  color: var(--mar-ui-text-primary);
}
button[aria-pressed='true'] {
  font-weight: 700;
}
button:focus-visible {
  outline: 2px solid var(--mar-ui-color-brand);
  outline-offset: -2px;
}
</style>
