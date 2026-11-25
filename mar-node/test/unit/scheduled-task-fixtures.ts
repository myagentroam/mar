import type { ScheduledTrigger } from '@myagentroam/protocol';

export const dailyTriggers = (...times: string[]): ScheduledTrigger[] =>
  times.map((time) => ({ kind: 'daily', time }));
export const hourlyTriggers = dailyTriggers(
  ...Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`)
);
