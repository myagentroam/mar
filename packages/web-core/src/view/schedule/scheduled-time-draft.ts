import { scheduledTimeGroupSchema, type ScheduledTimeGroup } from '@myagentroam/protocol';

export interface TimeDraft {
  id: number;
  dayKind: ScheduledTimeGroup['days']['kind'];
  timeKind: ScheduledTimeGroup['times']['kind'];
  dates: string;
  weekdays: number[];
  monthDays: string;
  months: string;
  times: string;
  hours: string;
  minutes: string;
}

export function timeDraft(id: number, group?: ScheduledTimeGroup): TimeDraft {
  const days = group?.days;
  const times = group?.times;
  return {
    id,
    dayKind: days?.kind ?? 'anyDay',
    timeKind: times?.kind ?? 'times',
    dates: days?.kind === 'dates' ? days.dates.join(', ') : '',
    weekdays: days?.kind === 'weekdays' ? [...days.weekdays] : [],
    monthDays: days?.kind === 'monthDays' ? days.monthDays.join(', ') : '',
    months: days !== undefined && days.kind !== 'dates' ? (days.months?.join(', ') ?? '') : '',
    times: times?.kind === 'times' ? times.times.join(', ') : '',
    hours: times?.kind === 'grid' ? times.hours.join(', ') : '',
    minutes: times?.kind === 'grid' ? times.minutes.join(', ') : ''
  };
}
const tokens = (text: string) => text.trim().split(/\s*[,，]\s*|\s+/);
const numbers = (text: string) =>
  tokens(text).map((item) => (/^\d+$/.test(item) ? Number(item) : NaN));

export function parseTimeDraft(draft: TimeDraft) {
  const months = draft.months.trim() ? numbers(draft.months) : undefined;
  const days =
    draft.dayKind === 'dates'
      ? { kind: draft.dayKind, dates: tokens(draft.dates) }
      : draft.dayKind === 'weekdays'
        ? { kind: draft.dayKind, weekdays: draft.weekdays, months }
        : draft.dayKind === 'monthDays'
          ? { kind: draft.dayKind, monthDays: numbers(draft.monthDays), months }
          : { kind: draft.dayKind, months };
  const times =
    draft.timeKind === 'times'
      ? { kind: draft.timeKind, times: tokens(draft.times) }
      : { kind: draft.timeKind, hours: numbers(draft.hours), minutes: numbers(draft.minutes) };
  return scheduledTimeGroupSchema.safeParse({ days, times });
}
