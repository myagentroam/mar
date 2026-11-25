import { scheduledTriggerLimit, scheduledTriggersSchema } from '@myagentroam/protocol';
import { describe, expect, it } from 'vitest';
import { legacyCronTimeGroups } from '../../src/migrations/v024-cron.js';
import {
  scheduledTimesAfter,
  suggestedScheduleDate
} from '../../src/service/scheduled-session-recurrence.js';
import { dailyTriggers } from './scheduled-task-fixtures.js';

const at = (iso: string) => Date.parse(iso);
const times = (body: unknown, zone: string, after: string, limit = 5) =>
  scheduledTimesAfter(scheduledTriggersSchema.parse(body), zone, at(after), limit);
const once = (date: string, time: string) => ({ kind: 'once', date, time });

describe('scheduled triggers', () => {
  it('preserves each date and time and reports all triggers for an overlapping minute once', () => {
    const triggers = [
      ...dailyTriggers('10:05', '20:30'),
      once('2026-11-25', '10:05'),
      once('2026-11-25', '14:30')
    ];
    expect(times(triggers, 'Asia/Shanghai', '2026-11-25T02:00:00Z', 4)).toEqual([
      { dueAt: at('2026-11-25T02:05:00Z'), matchedTriggers: [0, 2] },
      { dueAt: at('2026-11-25T06:30:00Z'), matchedTriggers: [3] },
      { dueAt: at('2026-11-25T12:30:00Z'), matchedTriggers: [1] },
      { dueAt: at('2026-11-26T02:05:00Z'), matchedTriggers: [0] }
    ]);
  });

  it('requires one exact time and accepts a date only for a one-time trigger', () => {
    for (const triggers of [
      [],
      [once('2026-02-29', '10:00')],
      [once('2028-02-29', '24:00')],
      [{ kind: 'once', time: '10:00' }],
      [{ kind: 'weekly', weekdays: [7], time: '10:00' }],
      [{ kind: 'monthly', monthDays: [1], time: '10:00', months: [1] }],
      [{ kind: 'daily', time: '10:00', date: '2028-01-01' }],
      [{ days: { kind: 'anyDay' }, times: { kind: 'grid', hours: [1], minutes: [0] } }],
      Array.from({ length: scheduledTriggerLimit + 1 }, () => once('2028-02-29', '10:00'))
    ]) {
      expect(scheduledTriggersSchema.safeParse(triggers).success).toBe(false);
    }
  });

  it('finds far-future dates and returns no successor after the exact one-time date', () => {
    const triggers = [once('2104-02-29', '00:00')];
    const date = '2104-02-29T00:00:00Z';
    expect(times(triggers, 'UTC', '2096-03-01T00:00:00Z')).toEqual([
      { dueAt: at(date), matchedTriggers: [0] }
    ]);
    expect(times(triggers, 'UTC', date)).toEqual([]);
    expect(times(triggers, 'UTC', '2104-03-01T00:00:00Z')).toEqual([]);
  });

  it('keeps weekly and monthly matches independent and skips a nonexistent month day', () => {
    expect(
      times(
        [
          { kind: 'weekly', weekdays: [1], time: '09:00' },
          { kind: 'monthly', monthDays: [1], time: '09:00' }
        ],
        'UTC',
        '2025-02-02T10:00:00Z',
        1
      )[0]?.dueAt
    ).toBe(at('2025-02-03T09:00:00Z'));
    expect(
      times(
        [{ kind: 'monthly', monthDays: [31], time: '10:00' }],
        'UTC',
        '2026-01-01T00:00:00Z',
        2
      ).map((slot) => slot.dueAt)
    ).toEqual([at('2026-01-31T10:00:00Z'), at('2026-03-31T10:00:00Z')]);
  });

  it('suggests the next available civil date in the selected zone, skipping a DST gap', () => {
    const zone = 'America/New_York';
    expect(suggestedScheduleDate('02:30', zone, at('2026-03-08T05:00:00Z'))).toBe('2026-03-09');
    expect(suggestedScheduleDate('22:00', zone, at('2026-03-08T05:00:00Z'))).toBe('2026-03-08');
    expect(suggestedScheduleDate('07:30', 'Asia/Shanghai', at('2026-03-08T00:00:00Z'))).toBe(
      '2026-03-09'
    );
  });

  it.each([
    [['02:30'], 'America/New_York', '2025-03-09T06:00:00Z', '2025-03-10T06:30:00Z'],
    [['01:30'], 'America/New_York', '2026-11-01T04:00:00Z', '2026-11-01T05:30:00Z'],
    [['01:30'], 'America/New_York', '2026-11-01T05:31:00Z', '2026-11-02T06:30:00Z'],
    [['01:59', '02:00'], 'America/New_York', '2025-11-02T05:59:00Z', '2025-11-02T07:00:00Z'],
    [
      ['01:15', '01:30', '02:00'],
      'America/New_York',
      '2025-11-02T06:10:00Z',
      '2025-11-02T07:00:00Z'
    ],
    [['01:45'], 'Australia/Lord_Howe', '2025-04-05T14:46:00Z', '2025-04-06T15:15:00Z'],
    [['02:15'], 'Australia/Lord_Howe', '2025-10-04T15:00:00Z', '2025-10-05T15:15:00Z'],
    [['09:00'], 'Asia/Kathmandu', '2025-01-01T03:14:00Z', '2025-01-01T03:15:00Z']
  ])('resolves wall-clock times %j in %s after %s', (clock, zone, after, expected) => {
    expect(times(dailyTriggers(...clock), zone, after, 1)[0]?.dueAt).toBe(at(expected));
  });
});

describe('immutable v24 cron migration input', () => {
  it('preserves field sets until the following version decides which tasks must pause', () => {
    expect(legacyCronTimeGroups('0 8 * * 1')).toEqual([
      {
        days: { kind: 'weekdays', weekdays: [1] },
        times: { kind: 'grid', hours: [8], minutes: [0] }
      }
    ]);
    expect(legacyCronTimeGroups('0 0 1,15 */2 *')).toEqual([
      {
        days: { kind: 'monthDays', monthDays: [1, 15], months: [1, 3, 5, 7, 9, 11] },
        times: { kind: 'grid', hours: [0], minutes: [0] }
      }
    ]);
    expect(legacyCronTimeGroups('0 10 1,29 2,3 7').map(({ days }) => days)).toEqual([
      { kind: 'monthDays', monthDays: [1, 29], months: [2, 3] },
      { kind: 'weekdays', weekdays: [0], months: [2, 3] }
    ]);
    for (const value of ['*/0 * * * *', '0 0 * * 8', `${'0,'.repeat(33)}0 * * * *`]) {
      expect(() => legacyCronTimeGroups(value)).toThrow('SCHEDULE_CRON_INVALID');
    }
  });
});
