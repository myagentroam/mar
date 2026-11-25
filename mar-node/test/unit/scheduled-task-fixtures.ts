import type { ScheduledTimeGroup } from '@myagentroam/protocol';

export const hourlyGroups: ScheduledTimeGroup[] = [
  {
    days: { kind: 'anyDay' },
    times: {
      kind: 'grid',
      hours: Array.from({ length: 24 }, (_, hour) => hour),
      minutes: [0]
    }
  }
];
export const dailyGroups = (...times: string[]): ScheduledTimeGroup[] => [
  { days: { kind: 'anyDay' }, times: { kind: 'times', times } }
];
