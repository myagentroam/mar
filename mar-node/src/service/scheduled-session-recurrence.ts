import type { ScheduledTimeGroup } from '@myagentroam/protocol';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// A Gregorian leap-day gap is at most eight years. Weekday and other month-day rules recur sooner.
const CALENDAR_SEARCH_DAYS = 8 * 366;

export interface ScheduledTime {
  readonly dueAt: number;
  readonly matchedGroups: readonly number[];
}

/** Node's wall-clock evaluator. Reads no runtime state; callers provide the clock and stored zone. */
export function scheduledTimesAfter(
  groups: readonly ScheduledTimeGroup[],
  timezone: string,
  after: number,
  limit: number
): readonly ScheduledTime[] {
  const formatter = scheduleFormatter(timezone, after);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('SCHEDULE_LIMIT_INVALID');
  const localStart = localParts(formatter, after).timestamp;
  const firstDay = Math.floor(localStart / DAY) * DAY;
  const offsetsByDay = new Map<number, ReadonlySet<number>>();
  const matches = new Map<number, number[]>();

  for (const [index, group] of groups.entries()) {
    const { days, times } = group;
    const minutes =
      times.kind === 'times'
        ? times.times.map((time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3)))
        : times.hours.flatMap((hour) => times.minutes.map((minute) => hour * 60 + minute));
    const orderedMinutes = [...new Set(minutes)].sort((a, b) => a - b);
    const dates =
      days.kind === 'dates'
        ? [...new Set(days.dates.map((date) => Date.parse(`${date}T00:00:00Z`)))].sort(
            (a, b) => a - b
          )
        : civilDays(firstDay);
    let count = 0;
    let horizon = firstDay + CALENDAR_SEARCH_DAYS * DAY;
    scan: for (const day of dates) {
      if (day < firstDay) continue;
      if (days.kind !== 'dates') {
        if (day > horizon) break;
        if (!matchesCalendarDay(days, day)) continue;
      }
      const offsets = offsetsByDay.get(day) ?? dayOffsets(formatter, day);
      offsetsByDay.set(day, offsets);
      for (const minute of orderedMinutes) {
        const localTime = day + minute * MINUTE;
        if (localTime < localStart) continue;
        const dueAt = earliestInstant(formatter, offsets, localTime);
        if (dueAt === undefined || dueAt <= after) continue;
        const previous = matches.get(dueAt);
        if (previous === undefined) matches.set(dueAt, [index]);
        else previous.push(index);
        if (++count === limit) break scan;
        horizon = day + CALENDAR_SEARCH_DAYS * DAY;
      }
    }
  }

  // Any group's (n + 1)th distinct result has at least n predecessors in the union.
  return [...matches.entries()]
    .sort(([a], [b]) => a - b)
    .slice(0, limit)
    .map(([dueAt, matchedGroups]) => ({ dueAt, matchedGroups }));
}

function* civilDays(firstDay: number): Generator<number> {
  // Yield the calendar cursor, even when nothing matches, so the caller can enforce its horizon.
  for (let day = firstDay; ; day += DAY) yield day;
}

function matchesCalendarDay(
  selector: Exclude<ScheduledTimeGroup['days'], { kind: 'dates' }>,
  day: number
): boolean {
  const date = new Date(day);
  if (selector.months !== undefined && !selector.months.includes(date.getUTCMonth() + 1))
    return false;
  if (selector.kind === 'weekdays') return selector.weekdays.includes(date.getUTCDay());
  if (selector.kind === 'monthDays') return selector.monthDays.includes(date.getUTCDate());
  return true;
}

export function assertScheduleTimezone(timezone: string): void {
  if (timezone.length < 1 || timezone.length > 128) throw new Error('SCHEDULE_TIMEZONE_INVALID');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error('SCHEDULE_TIMEZONE_INVALID');
  }
}

function scheduleFormatter(timezone: string, after: number): Intl.DateTimeFormat {
  assertScheduleTimezone(timezone);
  if (!Number.isSafeInteger(after) || after < 0 || after > 8.64e15)
    throw new Error('SCHEDULE_TIME_INVALID');
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
}

function dayOffsets(formatter: Intl.DateTimeFormat, day: number): ReadonlySet<number> {
  // The cursor is a civil date, encoded in UTC. Sample both sides of possible transitions.
  return new Set(
    [day - DAY, day, day + 2 * DAY].map((time) => localParts(formatter, time).timestamp - time)
  );
}

function earliestInstant(
  formatter: Intl.DateTimeFormat,
  offsets: ReadonlySet<number>,
  localTime: number
): number | undefined {
  let earliest: number | undefined;
  // Resolve a fold before comparing with "after": its later instant never replaces its first.
  for (const offset of offsets) {
    const candidate = localTime - offset;
    if (
      (earliest === undefined || candidate < earliest) &&
      localParts(formatter, candidate).timestamp === localTime
    )
      earliest = candidate;
  }
  return earliest;
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
