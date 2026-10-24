import { translate } from '../service/locale-preference-service.js';

export function formatDateTime(value: number, timeZone?: string): string {
  const date = new Date(value);
  const parts =
    timeZone === undefined
      ? {
          year: date.getFullYear(),
          month: date.getMonth() + 1,
          day: date.getDate(),
          hour: date.getHours(),
          minute: date.getMinutes(),
          second: date.getSeconds()
        }
      : Object.fromEntries(
          new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23'
          })
            .formatToParts(date)
            .map(({ type, value }) => [type, value])
        );
  const pad = (part: string | number): string => String(part).padStart(2, '0');
  return `${String(parts.year).padStart(4, '0')}-${pad(parts.month!)}-${pad(parts.day!)} ${pad(parts.hour!)}:${pad(parts.minute!)}:${pad(parts.second!)}`;
}

export {
  formatDateTime as managementDateTime,
  formatDateTime as absoluteMessageTime,
  formatDateTime as absoluteSessionTime
};

export function workingElapsedLabel(elapsedMs: number): string {
  return translate('common.workingElapsed', { duration: preciseElapsedDurationLabel(elapsedMs) });
}

export function preciseElapsedDurationLabel(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0
    ? `${hours}h ${minutes}m ${seconds}s`
    : minutes > 0
      ? `${minutes}m ${seconds}s`
      : `${seconds}s`;
}
