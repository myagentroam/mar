import { scheduledTriggerSchema, type ScheduledTrigger } from '@myagentroam/protocol';

/** Editable fields for one trigger; calendar dates are independent of the browser time zone. */
export interface TriggerDraft {
  id: number;
  kind: ScheduledTrigger['kind'];
  time: string | null;
  date: Date | null;
  suggestedDate: Date | null;
  weekdays: number[];
  monthDays: number[];
}

export const pickerDate = (date: string) => new Date(`${date}T00:00:00`);

export function triggerDraft(id: number, trigger?: ScheduledTrigger): TriggerDraft {
  return {
    id,
    kind: trigger?.kind ?? 'once',
    time: trigger?.time ?? null,
    date: trigger?.kind === 'once' ? pickerDate(trigger.date) : null,
    suggestedDate: null,
    weekdays: trigger?.kind === 'weekly' ? [...trigger.weekdays] : [],
    monthDays: trigger?.kind === 'monthly' ? [...trigger.monthDays] : []
  };
}

function calendarDate(date: Date | null) {
  if (!date) return null;
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((number, index) => String(number).padStart(index === 0 ? 4 : 2, '0'))
    .join('-');
}

export function parseTriggerDraft({
  kind,
  time,
  date,
  suggestedDate,
  weekdays,
  monthDays
}: TriggerDraft): ReturnType<typeof scheduledTriggerSchema.safeParse> {
  return scheduledTriggerSchema.safeParse({
    kind,
    time,
    ...(kind === 'once' ? { date: calendarDate(date ?? suggestedDate) } : {}),
    ...(kind === 'weekly' ? { weekdays: weekdays } : {}),
    ...(kind === 'monthly' ? { monthDays: monthDays } : {})
  });
}
