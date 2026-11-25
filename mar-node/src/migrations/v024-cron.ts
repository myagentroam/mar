type LegacyDays =
  | { readonly kind: 'dates'; readonly dates: readonly string[] }
  | { readonly kind: 'anyDay'; readonly months?: readonly number[] }
  | {
      readonly kind: 'weekdays';
      readonly weekdays: readonly number[];
      readonly months?: readonly number[];
    }
  | {
      readonly kind: 'monthDays';
      readonly monthDays: readonly number[];
      readonly months?: readonly number[];
    };

type LegacyTimes =
  | { readonly kind: 'times'; readonly times: readonly string[] }
  | {
      readonly kind: 'grid';
      readonly hours: readonly number[];
      readonly minutes: readonly number[];
    };

/** Persisted v24 format; keep independent of the current runtime schedule contract. */
export interface LegacyScheduledTimeGroup {
  readonly days: LegacyDays;
  readonly times: LegacyTimes;
}

/** Translate V23's parsed field sets without reinterpreting the old expression. */
export function legacyCronTimeGroups(cron: string): readonly LegacyScheduledTimeGroup[] {
  const parsed = parseCronExpression(cron);
  const months = parsed.monthWildcard ? {} : { months: [...parsed.month] };
  const times: LegacyTimes = {
    kind: 'grid',
    hours: [...parsed.hour],
    minutes: [...parsed.minute]
  };
  const days: LegacyDays[] = [];
  if (!parsed.dayOfMonthWildcard)
    days.push({ kind: 'monthDays', monthDays: [...parsed.dayOfMonth], ...months });
  if (!parsed.dayOfWeekWildcard)
    days.push({ kind: 'weekdays', weekdays: [...parsed.dayOfWeek], ...months });
  if (days.length === 0) days.push({ kind: 'anyDay', ...months });
  return days.map((selector) => ({ days: selector, times }));
}

interface ParsedCronExpression {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
  readonly dayOfMonthWildcard: boolean;
  readonly monthWildcard: boolean;
  readonly dayOfWeekWildcard: boolean;
}

function parseCronExpression(cron: string): ParsedCronExpression {
  const expression = cron.trim();
  const fields = expression.split(/\s+/);
  if (
    expression.length === 0 ||
    expression.length > 64 ||
    fields.length !== 5 ||
    fields.some((field) => field.length === 0)
  )
    throw new Error('SCHEDULE_CRON_INVALID');
  const minute = parseField(fields[0] ?? '', 0, 59);
  const hour = parseField(fields[1] ?? '', 0, 23);
  const dayOfMonth = parseField(fields[2] ?? '', 1, 31);
  const month = parseField(fields[3] ?? '', 1, 12);
  const dayOfWeek = parseField(fields[4] ?? '', 0, 7, (value) => (value === 7 ? 0 : value));
  return {
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dayOfMonth.values,
    month: month.values,
    dayOfWeek: dayOfWeek.values,
    dayOfMonthWildcard: minuteWildcard(dayOfMonth.values, 1, 31),
    monthWildcard: minuteWildcard(month.values, 1, 12),
    dayOfWeekWildcard: minuteWildcard(dayOfWeek.values, 0, 6)
  };
}

function parseField(
  field: string,
  min: number,
  max: number,
  normalize: (value: number) => number = (value) => value
): { readonly values: ReadonlySet<number> } {
  if (field.includes('?')) throw new Error('SCHEDULE_CRON_INVALID');
  const values = new Set<number>();
  for (const segment of field.split(',')) {
    if (segment.length === 0) throw new Error('SCHEDULE_CRON_INVALID');
    const parts = segment.split('/');
    if (parts.length > 2 || parts.some((part) => part.length === 0))
      throw new Error('SCHEDULE_CRON_INVALID');
    const base = parts[0] ?? '';
    const step = parts[1] === undefined ? 1 : exactInteger(parts[1], 1, max - min + 1);
    let start: number;
    let end: number;
    if (base === '*') {
      start = min;
      end = max;
    } else if (/^\d+-\d+$/.test(base)) {
      const range = base.split('-');
      start = exactInteger(range[0], min, max);
      end = exactInteger(range[1], min, max);
      if (start > end) throw new Error('SCHEDULE_CRON_INVALID');
    } else if (parts.length === 1 && /^\d+$/.test(base)) {
      start = exactInteger(base, min, max);
      end = start;
    } else {
      throw new Error('SCHEDULE_CRON_INVALID');
    }
    if (parts[1] !== undefined && start === end) throw new Error('SCHEDULE_CRON_INVALID');
    for (let value = start; value <= end; value += step) values.add(normalize(value));
  }
  if (values.size === 0) throw new Error('SCHEDULE_CRON_INVALID');
  return { values };
}

function exactInteger(value: string | undefined, min: number, max: number): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error('SCHEDULE_CRON_INVALID');
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max)
    throw new Error('SCHEDULE_CRON_INVALID');
  return number;
}

function minuteWildcard(values: ReadonlySet<number>, min: number, max: number): boolean {
  return values.size === max - min + 1;
}
