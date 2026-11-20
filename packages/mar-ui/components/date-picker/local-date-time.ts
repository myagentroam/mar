const pad = (value: number) => String(value).padStart(2, '0');

export function formatLocalDateTime(date?: Date): string {
  if (!date || !Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Parse a calendar value in the browser's local time, not UTC; reject rolled-over days. */
export function parseLocalDateTime(text: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!match) return;
  const [, year, month, day, hour, minute, second = '00'] = match;
  const date = new Date(0);
  date.setFullYear(Number(year), Number(month) - 1, Number(day));
  date.setHours(Number(hour), Number(minute), Number(second), 0);
  return formatLocalDateTime(date) === `${year}-${month}-${day} ${hour}:${minute}:${second}`
    ? date
    : undefined;
}

export function dateAtMonth(date: Date, offset = 0): Date {
  const month = new Date(date);
  month.setDate(1);
  month.setMonth(month.getMonth() + offset);
  month.setHours(0, 0, 0, 0);
  return month;
}
