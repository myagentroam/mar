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
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const start = localParts(formatter, after);
  const dayMs = 24 * 60 * 60_000;
  const limit = Math.floor(after / 60_000) * 60_000 + 8 * 366 * dayMs;
  const firstDay = Date.UTC(start.year, start.month - 1, start.day);
  const hours = [...schedule.hour].sort((a, b) => a - b);
  const minutes = [...schedule.minute].sort((a, b) => a - b);
  // These are calendar dates represented in UTC, not fixed-length local days.
  for (let day = firstDay; day <= limit + dayMs; day += dayMs) {
    const date = new Date(day);
    if (!matchesDate(schedule, date)) continue;
    // Sample both sides of this date to include offsets on either side of a
    // transition, including half-hour folds and whole-day calendar jumps.
    const offsets = new Set(
      [day - dayMs, day, day + 2 * dayMs].map(
        (time) => localParts(formatter, time).timestamp - time
      )
    );
    for (const hour of hours) {
      if (day === firstDay && hour < start.hour) continue;
      for (const minute of minutes) {
        if (day === firstDay && hour === start.hour && minute < start.minute) continue;
        const localTime = day + (hour * 60 + minute) * 60_000;
        let earliest = Infinity;
        for (const offset of offsets) {
          const candidate = localTime - offset;
          if (localParts(formatter, candidate).timestamp === localTime) {
            earliest = Math.min(earliest, candidate);
          }
        }
        // Resolve an ambiguous minute before filtering by after: the second
        // physical occurrence must never become a replacement for the first.
        if (earliest > after && earliest <= limit) return earliest;
      }
    }
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
  const year = Number(fields['year']);
  return {
    year,
    hour,
    minute,
    day,
    month,
    timestamp: Date.UTC(year, month - 1, day, hour, minute)
  };
}

function matchesDate(schedule: ParsedCronExpression, date: Date): boolean {
  if (!schedule.month.has(date.getUTCMonth() + 1)) return false;
  const dayOfMonthMatches = schedule.dayOfMonth.has(date.getUTCDate());
  const dayOfWeekMatches = schedule.dayOfWeek.has(date.getUTCDay());
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
