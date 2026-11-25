import { scheduledTimeGroupSchema, type ScheduledTimeGroup } from '@myagentroam/protocol';

interface PickerRow<T> {
  id: number;
  value: T | null;
}

export interface TimeDraft {
  id: number;
  dayKind: ScheduledTimeGroup['days']['kind'];
  timeKind: ScheduledTimeGroup['times']['kind'];
  dates: PickerRow<Date>[];
  weekdays: number[];
  monthDays: number[];
  months: number[];
  times: PickerRow<string>[];
  hours: number[];
  minutes: number[];
}

function pickerRows<T>(values: T[]): PickerRow<T>[] {
  return values.length ? values.map((value, id) => ({ id, value })) : [{ id: 0, value: null }];
}

export function addPickerRow<T>(rows: PickerRow<T>[]): void {
  rows.push({ id: rows.at(-1)!.id + 1, value: null });
}

export function timeDraft(id: number, group?: ScheduledTimeGroup): TimeDraft {
  const days = group?.days;
  const times = group?.times;
  return {
    id,
    dayKind: days?.kind ?? 'anyDay',
    timeKind: times?.kind ?? 'times',
    // The picker uses browser-local Dates; the schedule stores calendar dates without a zone.
    dates: pickerRows(
      days?.kind === 'dates' ? days.dates.map((date) => new Date(`${date}T00:00:00`)) : []
    ),
    weekdays: days?.kind === 'weekdays' ? [...days.weekdays] : [],
    monthDays: days?.kind === 'monthDays' ? [...days.monthDays] : [],
    months: days !== undefined && days.kind !== 'dates' ? [...(days.months ?? [])] : [],
    times: pickerRows(times?.kind === 'times' ? times.times : []),
    hours: times?.kind === 'grid' ? [...times.hours] : [],
    minutes: times?.kind === 'grid' ? [...times.minutes] : []
  };
}

function calendarDate(date: Date | null) {
  if (!date) return null;
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseTimeDraft(draft: TimeDraft) {
  const months = draft.months.length ? draft.months : undefined;
  const days =
    draft.dayKind === 'dates'
      ? { kind: draft.dayKind, dates: draft.dates.map(({ value }) => calendarDate(value)) }
      : draft.dayKind === 'weekdays'
        ? { kind: draft.dayKind, weekdays: draft.weekdays, months }
        : draft.dayKind === 'monthDays'
          ? { kind: draft.dayKind, monthDays: draft.monthDays, months }
          : { kind: draft.dayKind, months };
  const times =
    draft.timeKind === 'times'
      ? { kind: draft.timeKind, times: draft.times.map(({ value }) => value) }
      : { kind: draft.timeKind, hours: draft.hours, minutes: draft.minutes };
  return scheduledTimeGroupSchema.safeParse({ days, times });
}
