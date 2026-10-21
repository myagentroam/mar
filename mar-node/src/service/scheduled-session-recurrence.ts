export type ScheduledCadence =
  | { readonly kind: 'HOURLY'; readonly minute: number }
  | { readonly kind: 'DAILY'; readonly minute: number; readonly hour: number }
  | {
      readonly kind: 'WEEKLY';
      readonly minute: number;
      readonly hour: number;
      readonly weekday: number;
    }
  | { readonly kind: 'CRON'; readonly expression: string };

export function parseScheduledCron(cron: string): ScheduledCadence {
  const parsed = parseCronExpression(cron);
  if (
    parsed.dayOfMonthWildcard &&
    parsed.monthWildcard &&
    /^\d+$/.test(parsed.fields[0] ?? '') &&
    (parsed.fields[1] === '*' || /^\d+$/.test(parsed.fields[1] ?? '')) &&
    (parsed.fields[4] === '*' || /^\d+$/.test(parsed.fields[4] ?? ''))
  ) {
    const minute = exactInteger(parsed.fields[0], 0, 59);
    const hour = parsed.fields[1] === '*' ? undefined : exactInteger(parsed.fields[1], 0, 23);
    const weekdayValue =
      parsed.fields[4] === '*' ? undefined : exactInteger(parsed.fields[4], 0, 7);
    if (hour === undefined && weekdayValue === undefined) return { kind: 'HOURLY', minute };
    if (hour !== undefined && weekdayValue === undefined) return { kind: 'DAILY', minute, hour };
    if (hour !== undefined && weekdayValue !== undefined)
      return { kind: 'WEEKLY', minute, hour, weekday: weekdayValue === 7 ? 0 : weekdayValue };
  }
  return { kind: 'CRON', expression: parsed.expression };
}

export function assertScheduleTimezone(timezone: string): void {
  if (timezone.length < 1 || timezone.length > 128) throw new Error('SCHEDULE_TIMEZONE_INVALID');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error('SCHEDULE_TIMEZONE_INVALID');
  }
}

export function nextScheduledAt(cron: string, timezone: string, after: number): number {
  const schedule = parseCronExpression(cron);
  assertScheduleTimezone(timezone);
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('SCHEDULE_TIME_INVALID');
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const previousKey = localKey(formatter, after);
  let candidate = Math.floor(after / 60_000) * 60_000 + 60_000;
  for (let index = 0; index < 8 * 366 * 24 * 60; index++, candidate += 60_000) {
    const local = localParts(formatter, candidate);
    if (matches(schedule, local) && local.key !== previousKey) return candidate;
  }
  throw new Error('SCHEDULE_NEXT_TIME_UNAVAILABLE');
}

interface ParsedCronExpression {
  readonly expression: string;
  readonly fields: readonly string[];
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
    expression,
    fields,
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

function localParts(formatter: Intl.DateTimeFormat, time: number) {
  const fields = Object.fromEntries(
    formatter.formatToParts(time).map((part) => [part.type, part.value])
  );
  const hour = Number(fields['hour']);
  const minute = Number(fields['minute']);
  const day = Number(fields['day']);
  const month = Number(fields['month']);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    fields['weekday'] ?? ''
  );
  return {
    hour,
    minute,
    day,
    month,
    weekday,
    key: `${fields['year']}-${fields['month']}-${fields['day']}T${fields['hour']}:${fields['minute']}`
  };
}

function matches(
  schedule: ParsedCronExpression,
  local: {
    readonly hour: number;
    readonly minute: number;
    readonly day: number;
    readonly month: number;
    readonly weekday: number;
  }
): boolean {
  if (
    !schedule.minute.has(local.minute) ||
    !schedule.hour.has(local.hour) ||
    !schedule.month.has(local.month)
  )
    return false;
  const dayOfMonthMatches = schedule.dayOfMonth.has(local.day);
  const dayOfWeekMatches = schedule.dayOfWeek.has(local.weekday);
  const dayMatches =
    schedule.dayOfMonthWildcard && schedule.dayOfWeekWildcard
      ? true
      : schedule.dayOfMonthWildcard
        ? dayOfWeekMatches
        : schedule.dayOfWeekWildcard
          ? dayOfMonthMatches
          : dayOfMonthMatches || dayOfWeekMatches;
  return dayMatches;
}

function localKey(formatter: Intl.DateTimeFormat, time: number): string {
  return localParts(formatter, time).key;
}
