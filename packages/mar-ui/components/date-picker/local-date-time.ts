const pad = (value: number) => String(value).padStart(2, '0');

export function formatLocalDate(date?: Date): string {
  if (!date || !Number.isFinite(date.getTime())) return '';
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatLocalDateTime(date?: Date): string {
  const day = formatLocalDate(date);
  if (!date || !day) return '';
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function parseLocalDate(text: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return;
  const [, year, month, day] = match;
  const date = new Date(0);
  date.setFullYear(Number(year), Number(month) - 1, Number(day));
  date.setHours(0, 0, 0, 0);
  return formatLocalDate(date) === match[0] ? date : undefined;
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
