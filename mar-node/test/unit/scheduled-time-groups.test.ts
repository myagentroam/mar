import { scheduledTimeGroupsSchema } from '@myagentroam/protocol';
import { describe, expect, it } from 'vitest';
import { legacyCronTimeGroups } from '../../src/migrations/v024-cron.js';
import { scheduledTimesAfter } from '../../src/service/scheduled-session-recurrence.js';

const at = (iso: string) => Date.parse(iso);
const times = (body: unknown, zone: string, after: string, limit = 5) =>
  scheduledTimesAfter(scheduledTimeGroupsSchema.parse(body), zone, at(after), limit);
const explicit = (dates: string[], times: string[]) => ({
  days: { kind: 'dates', dates },
  times: { kind: 'times', times }
});

describe('scheduled time groups', () => {
  it('keeps date/time pairings and emits overlapping groups once', () => {
    const groups = [
      explicit(['2026-11-25', '2026-11-26'], ['10:05', '20:30']),
      explicit(['2026-11-25'], ['10:05', '14:30'])
    ];
    expect(times(groups, 'Asia/Shanghai', '2026-11-25T02:00:00Z', 4)).toEqual([
      { dueAt: at('2026-11-25T02:05:00Z'), matchedGroups: [0, 1] },
      { dueAt: at('2026-11-25T06:30:00Z'), matchedGroups: [1] },
      { dueAt: at('2026-11-25T12:30:00Z'), matchedGroups: [0] },
      { dueAt: at('2026-11-26T02:05:00Z'), matchedGroups: [0] }
    ]);
  });

  it('validates real dates, numeric selectors and minute precision at ingress', () => {
    for (const groups of [
      [],
      [explicit(['2026-02-29'], ['10:00'])],
      [explicit(['2028-02-29'], ['24:00'])],
      [{ days: { kind: 'weekdays', weekdays: [7] }, times: { kind: 'times', times: ['10:00'] } }],
      Array.from({ length: 17 }, () => explicit(['2028-02-29'], ['10:00']))
    ])
      expect(scheduledTimeGroupsSchema.safeParse(groups).success).toBe(false);
  });

  it('finds far-future dates and returns no successor once they expire', () => {
    const groups = [explicit(['2064-02-29'], ['00:00'])];
    const date = '2064-02-29T00:00:00Z';
    expect(times(groups, 'UTC', '2026-01-01T00:00:00Z')).toEqual([
      { dueAt: at(date), matchedGroups: [0] }
    ]);
    expect(times(groups, 'UTC', date)).toEqual([]);
  });

  it('skips nonexistent local times and does not reissue a folded wall-clock minute', () => {
    const groups = [explicit(['2026-03-08', '2026-11-01'], ['01:30', '02:30'])];
    const zone = 'America/New_York';
    expect(times(groups, zone, '2026-03-08T05:00:00Z').map((slot) => slot.dueAt)).toEqual([
      at('2026-03-08T06:30:00Z'),
      at('2026-11-01T05:30:00Z'),
      at('2026-11-01T07:30:00Z')
    ]);
    expect(times(groups, zone, '2026-11-01T06:15:00Z').map((slot) => slot.dueAt)).toEqual([
      at('2026-11-01T07:30:00Z')
    ]);
  });

  it('takes the first ambiguous minute even across a 30-minute fold', () => {
    expect(
      times([explicit(['2026-04-05'], ['01:50'])], 'Australia/Lord_Howe', '2026-04-04T10:00:00Z')
    ).toEqual([{ dueAt: at('2026-04-04T14:50:00Z'), matchedGroups: [0] }]);
  });

  it('skips months without the requested day', () => {
    expect(
      times(
        [
          {
            days: { kind: 'monthDays', months: [2], monthDays: [29] },
            times: { kind: 'times', times: ['10:00'] }
          }
        ],
        'UTC',
        '2026-01-01T00:00:00Z',
        2
      ).map((slot) => slot.dueAt)
    ).toEqual([at('2028-02-29T10:00:00Z'), at('2032-02-29T10:00:00Z')]);
  });

  it.each([
    [
      '*/15 9-20 * * 1-5',
      'Asia/Shanghai',
      '2026-11-25T02:00:00Z',
      [
        '2026-11-25T02:15:00Z',
        '2026-11-25T02:30:00Z',
        '2026-11-25T02:45:00Z',
        '2026-11-25T03:00:00Z',
        '2026-11-25T03:15:00Z'
      ]
    ],
    [
      '0 10 1,29 2,3 7',
      'America/New_York',
      '2026-02-01T00:00:00Z',
      [
        '2026-02-01T15:00:00Z',
        '2026-02-08T15:00:00Z',
        '2026-02-15T15:00:00Z',
        '2026-02-22T15:00:00Z',
        '2026-03-01T15:00:00Z'
      ]
    ],
    [
      '30 1 * * *',
      'America/New_York',
      '2026-11-01T04:00:00Z',
      [
        '2026-11-01T05:30:00Z',
        '2026-11-02T06:30:00Z',
        '2026-11-03T06:30:00Z',
        '2026-11-04T06:30:00Z',
        '2026-11-05T06:30:00Z'
      ]
    ],
    [
      '0 10 1-31 11 1,7',
      'UTC',
      '2026-11-25T00:00:00Z',
      [
        '2026-11-29T10:00:00Z',
        '2026-11-30T10:00:00Z',
        '2027-11-01T10:00:00Z',
        '2027-11-07T10:00:00Z',
        '2027-11-08T10:00:00Z'
      ]
    ]
  ])('preserves legacy cron successors for %s in %s', (cron, zone, start, expected) => {
    const groups = scheduledTimeGroupsSchema.parse(legacyCronTimeGroups(cron));
    const next = scheduledTimesAfter(groups, zone, at(start), 5);
    expect(next.map((value) => value.dueAt)).toEqual(expected.map(at));
  });
});
