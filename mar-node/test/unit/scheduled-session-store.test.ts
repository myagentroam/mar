import { describe, expect, it } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import {
  nextScheduledAt,
  parseScheduledCron
} from '../../src/service/scheduled-session-recurrence.js';
import { ScheduledSessionStore } from '../../src/service/scheduled-session-store.js';

describe('scheduled session recurrence', () => {
  it('accepts simple and advanced five-field cron forms', () => {
    expect(parseScheduledCron('15 * * * *')).toEqual({ kind: 'HOURLY', minute: 15 });
    expect(parseScheduledCron('30 9 * * *')).toEqual({ kind: 'DAILY', minute: 30, hour: 9 });
    expect(parseScheduledCron('0 8 * * 1')).toEqual({
      kind: 'WEEKLY',
      minute: 0,
      hour: 8,
      weekday: 1
    });
    expect(parseScheduledCron('*/15 9-17 * * 1-5')).toEqual({
      kind: 'CRON',
      expression: '*/15 9-17 * * 1-5'
    });
    expect(parseScheduledCron('0 0 1,15 */2 *')).toEqual({
      kind: 'CRON',
      expression: '0 0 1,15 */2 *'
    });
    expect(() => parseScheduledCron('0 0 31 2 *')).not.toThrow('SCHEDULE_CRON_INVALID');
    expect(() => parseScheduledCron('*/0 * * * *')).toThrow('SCHEDULE_CRON_INVALID');
    expect(() => parseScheduledCron('0 0 * * 8')).toThrow('SCHEDULE_CRON_INVALID');
    expect(() => parseScheduledCron(`${'0,'.repeat(33)}0 * * * *`)).toThrow(
      'SCHEDULE_CRON_INVALID'
    );
  });

  it('skips a missing local time and runs a repeated local time once', () => {
    const spring = Date.parse('2025-03-09T06:00:00Z');
    expect(nextScheduledAt('30 2 * * *', 'America/New_York', spring)).toBe(
      Date.parse('2025-03-10T06:30:00Z')
    );
    const firstFall = Date.parse('2025-11-02T05:30:00Z');
    expect(nextScheduledAt('30 1 * * *', 'America/New_York', firstFall)).toBe(
      Date.parse('2025-11-03T06:30:00Z')
    );
  });

  it('supports ranges, steps and standard day-of-month/day-of-week matching', () => {
    expect(nextScheduledAt('*/15 9-17 * * 1-5', 'UTC', Date.parse('2025-01-03T16:50:00Z'))).toBe(
      Date.parse('2025-01-03T17:00:00Z')
    );
    expect(nextScheduledAt('0 9 1 * 1', 'UTC', Date.parse('2025-02-02T10:00:00Z'))).toBe(
      Date.parse('2025-02-03T09:00:00Z')
    );
  });

  it.each([
    ['30 1 * * *', 'America/New_York', '2025-11-02T05:31:00Z', '2025-11-03T06:30:00Z'],
    ['* * * * *', 'America/New_York', '2025-11-02T05:59:00Z', '2025-11-02T07:00:00Z'],
    ['*/15 * * * *', 'America/New_York', '2025-11-02T06:10:00Z', '2025-11-02T07:00:00Z'],
    ['45 1 * * *', 'Australia/Lord_Howe', '2025-04-05T14:46:00Z', '2025-04-06T15:15:00Z'],
    ['15 2 * * *', 'Australia/Lord_Howe', '2025-10-04T15:00:00Z', '2025-10-05T15:15:00Z'],
    ['0 9 * * *', 'Asia/Kathmandu', '2025-01-01T03:14:00Z', '2025-01-01T03:15:00Z'],
    ['0 0 1 1 *', 'UTC', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'],
    ['0 0 29 2 *', 'UTC', '2096-03-01T00:00:00Z', '2104-02-29T00:00:00Z'],
    ['0 0 31 2 1', 'UTC', '2025-02-01T00:00:00Z', '2025-02-03T00:00:00Z']
  ])('selects one local occurrence for %s in %s after %s', (cron, zone, after, expected) => {
    expect(nextScheduledAt(cron, zone, Date.parse(after))).toBe(Date.parse(expected));
  });

  it('rejects an impossible date without reducing the search horizon', () => {
    expect(() => nextScheduledAt('0 0 31 2 *', 'UTC', Date.parse('2025-01-01T00:00:00Z'))).toThrow(
      'SCHEDULE_NEXT_TIME_UNAVAILABLE'
    );
  });
});

describe('scheduled session store', () => {
  it('advances a delayed DST claim and re-enabled task beyond the repeated local minute', () => {
    let now = Date.parse('2025-11-02T05:00:00Z');
    const database = new NodeDatabase(':memory:', 'node-dst', () => now);
    try {
      const workspace = database.saveWorkspace({
        path: '/schedule-dst',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: 'dst',
        workspaceId: workspace.id
      });
      const store = new ScheduledSessionStore(database.raw, () => now);
      const task = store.create({
        sessionId: 'dst',
        workspaceId: workspace.id,
        runner: 'codex',
        ownerUserId: 1,
        objective: 'Inspect',
        cron: '30 1 * * *',
        timezone: 'America/New_York'
      });
      expect(task.nextRunAt).toBe(Date.parse('2025-11-02T05:30:00Z'));
      now = Date.parse('2025-11-02T05:31:00Z');
      expect(store.claim(task.sessionId, task.nextRunAt!, task.revision)).toBe(
        `${task.id}:${task.nextRunAt}`
      );
      expect(store.get(task.sessionId)?.nextRunAt).toBe(Date.parse('2025-11-03T06:30:00Z'));
      const paused = store.update(task.sessionId, task.revision, { enabled: false });
      now = Date.parse('2025-11-02T06:10:00Z');
      const resumed = store.update(task.sessionId, paused.revision, { enabled: true });
      expect(resumed.nextRunAt).toBe(Date.parse('2025-11-03T06:30:00Z'));
    } finally {
      database.close();
    }
  });

  it('queries ten occurrences per page with stable totals, terminal retention, and last-page clamping', () => {
    let now = Date.parse('2025-01-01T00:00:00Z');
    const database = new NodeDatabase(':memory:', 'node-schedule-pages', () => now);
    try {
      const workspace = database.saveWorkspace({
        path: '/schedule-pages',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: 'paged-session',
        workspaceId: workspace.id
      });
      const store = new ScheduledSessionStore(database.raw, () => now);
      const task = store.create({
        sessionId: 'paged-session',
        workspaceId: workspace.id,
        runner: 'codex',
        ownerUserId: 1,
        objective: 'Inspect',
        cron: '0 * * * *',
        timezone: 'UTC'
      });
      expect(store.recentPage(task.id)).toEqual({
        occurrences: [],
        occurrenceTotal: 0,
        occurrencePage: 1
      });
      const ids: string[] = [];
      for (let index = 0; index < 25; index++) {
        now = store.get(task.sessionId)!.nextRunAt!;
        const id = store.claim(task.sessionId, now, task.revision)!;
        ids.unshift(id);
        store.finish(id, 'SUCCEEDED');
      }
      for (const [page, expected] of [
        [1, ids.slice(0, 10)],
        [2, ids.slice(10, 20)],
        [3, ids.slice(20)]
      ] as const) {
        const result = store.recentPage(task.id, page);
        expect(result).toMatchObject({ occurrenceTotal: 25, occurrencePage: page });
        expect(result.occurrences.map((item) => item['id'])).toEqual(expected);
      }
      expect(store.recentPage(task.id, Number.MAX_SAFE_INTEGER)).toEqual(
        store.recentPage(task.id, 3)
      );
      for (let index = 25; index < 106; index++) {
        now = store.get(task.sessionId)!.nextRunAt!;
        store.finish(store.claim(task.sessionId, now, task.revision)!, 'SKIPPED');
      }
      expect(store.recentPage(task.id, 99)).toMatchObject({
        occurrenceTotal: 100,
        occurrencePage: 10
      });
      expect(store.recentPage('unknown', 3)).toEqual({
        occurrences: [],
        occurrenceTotal: 0,
        occurrencePage: 1
      });
    } finally {
      database.close();
    }
  });

  it('bounds pending proposals and lets the latest editor resolve them', () => {
    const database = new NodeDatabase(':memory:', 'node-proposals');
    const workspace = database.saveWorkspace({
      path: '/scheduled-proposals',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: 'session-proposals',
      workspaceId: workspace.id
    });
    const store = new ScheduledSessionStore(database.raw);
    const task = store.create({
      sessionId: 'session-proposals',
      workspaceId: workspace.id,
      runner: 'codex',
      ownerUserId: 1,
      objective: 'Original',
      cron: '0 * * * *',
      timezone: 'UTC'
    });
    const proposal = store.propose(task, 2, { objective: 'Updated' });
    expect(() => store.resolveProposal(task.sessionId, proposal, 2, true)).toThrow(
      'SCHEDULE_OWNER_REQUIRED'
    );
    expect(store.resolveProposal(task.sessionId, proposal, 1, true).objective).toBe('Updated');
    expect(store.pendingProposals(task.id)).toEqual([]);
    for (let index = 0; index < 50; index++)
      store.propose(store.get(task.sessionId)!, 2, { objective: `Proposal ${index}` });
    expect(store.pendingProposals(task.id)).toHaveLength(50);
    expect(() => store.propose(store.get(task.sessionId)!, 2, { objective: 'Excess' })).toThrow(
      'SCHEDULE_PROPOSAL_LIMIT'
    );
    store.update(task.sessionId, 2, { objective: 'Third' });
    expect(store.pendingProposals(task.id)).toEqual([]);
    const edited = store.update(task.sessionId, 3, { ownerUserId: 2 });
    expect(edited).toMatchObject({ ownerUserId: 2 });
    const nextProposal = store.propose(edited, 1, { objective: 'Fourth' });
    expect(() => store.resolveProposal(task.sessionId, nextProposal, 1, true)).toThrow(
      'SCHEDULE_OWNER_REQUIRED'
    );
    expect(store.resolveProposal(task.sessionId, nextProposal, 2, true).objective).toBe('Fourth');
    database.close();
  });

  it('checks the session, workspace, and runner parents before creating a task', () => {
    const database = new NodeDatabase(':memory:', 'node-schedule-create');
    const workspace = database.saveWorkspace({
      id: 'workspace-a',
      path: '/schedule-create-a',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const otherWorkspace = database.saveWorkspace({
      id: 'workspace-b',
      path: '/schedule-create-b',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: 'session-a',
      workspaceId: workspace.id
    });
    database.raw
      .prepare('INSERT INTO agent_sessions (id,workspace_id,runner,metadata) VALUES (?,?,?,?)')
      .run('session-missing-workspace', 'missing-workspace', 'codex', '{}');
    const store = new ScheduledSessionStore(database.raw);
    const input = {
      sessionId: 'session-a',
      workspaceId: workspace.id,
      runner: 'codex' as const,
      ownerUserId: 1,
      objective: 'Inspect',
      cron: '0 * * * *',
      timezone: 'UTC'
    };

    expect(() => store.create({ ...input, sessionId: 'missing-session' })).toThrow(
      'SESSION_NOT_FOUND'
    );
    expect(() =>
      store.create({
        ...input,
        sessionId: 'session-missing-workspace',
        workspaceId: 'missing-workspace'
      })
    ).toThrow('WORKSPACE_NOT_FOUND');
    expect(() => store.create({ ...input, workspaceId: otherWorkspace.id })).toThrow(
      'SCHEDULE_SESSION_MISMATCH'
    );
    expect(() => store.create({ ...input, runner: 'opencode' })).toThrow(
      'SCHEDULE_SESSION_MISMATCH'
    );
    expect(
      database.raw.prepare('SELECT COUNT(*) AS count FROM scheduled_session_tasks').get()
    ).toEqual({
      count: 0
    });
    database.close();
  });

  it('does not delete children when remove encounters a revision conflict', () => {
    const now = Date.parse('2025-01-01T00:00:00Z');
    const database = new NodeDatabase(':memory:', 'node-schedule-remove', () => now);
    const workspace = database.saveWorkspace({
      id: 'workspace-remove',
      path: '/schedule-remove',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: 'session-remove',
      workspaceId: workspace.id
    });
    const store = new ScheduledSessionStore(database.raw, () => now);
    const task = store.create({
      sessionId: 'session-remove',
      workspaceId: workspace.id,
      runner: 'codex',
      ownerUserId: 1,
      objective: 'Inspect',
      cron: '0 * * * *',
      timezone: 'UTC'
    });
    const proposal = store.propose(task, 2, { objective: 'Inspect later' });
    const occurrence = store.claim(task.sessionId, task.nextRunAt!, task.revision);

    expect(() => store.remove(task.sessionId, task.revision + 1)).toThrow(
      'SCHEDULE_REVISION_CONFLICT'
    );
    expect(store.getById(task.id)).toBeDefined();
    expect(store.recent(task.id)).toHaveLength(1);
    expect(store.pendingProposals(task.id).map((row) => row['id'])).toEqual([proposal]);

    store.remove(task.sessionId, task.revision);
    expect(store.getById(task.id)).toBeUndefined();
    expect(store.recent(task.id)).toEqual([]);
    expect(store.pendingProposals(task.id)).toEqual([]);
    expect(occurrence).toBe(`${task.id}:${task.nextRunAt}`);
    database.close();
  });

  it('rejects proposals made from deleted or stale task objects', () => {
    const database = new NodeDatabase(':memory:', 'node-schedule-proposal-stale');
    const workspace = database.saveWorkspace({
      id: 'workspace-proposal-stale',
      path: '/schedule-proposal-stale',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: 'session-proposal-stale',
      workspaceId: workspace.id
    });
    const store = new ScheduledSessionStore(database.raw);
    const task = store.create({
      sessionId: 'session-proposal-stale',
      workspaceId: workspace.id,
      runner: 'codex',
      ownerUserId: 1,
      objective: 'Original',
      cron: '0 * * * *',
      timezone: 'UTC'
    });
    const current = store.update(task.sessionId, task.revision, { objective: 'Updated' });
    expect(() => store.propose(task, 2, { objective: 'Stale proposal' })).toThrow(
      'SCHEDULE_REVISION_CONFLICT'
    );
    store.remove(current.sessionId, current.revision);
    expect(() => store.propose(current, 2, { objective: 'Deleted proposal' })).toThrow(
      'SCHEDULE_NOT_FOUND'
    );
    database.close();
  });

  it('persists tasks, claims each occurrence once, and cascades on session removal', () => {
    let now = Date.parse('2025-01-01T00:00:00Z');
    const database = new NodeDatabase(':memory:', 'node-a', () => now);
    const workspace = database.saveWorkspace({
      path: '/scheduled-test',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: 'session-1',
      workspaceId: workspace.id,
      pinned: true
    });
    const store = new ScheduledSessionStore(database.raw, () => now);
    const task = store.create({
      sessionId: 'session-1',
      workspaceId: workspace.id,
      runner: 'codex',
      ownerUserId: 1,
      objective: 'Inspect the project',
      cron: '0 * * * *',
      timezone: 'UTC'
    });
    expect(task.nextRunAt).toBe(Date.parse('2025-01-01T01:00:00Z'));
    expect(task).toMatchObject({
      ownerUserId: 1,
      notifyOnTerminal: false
    });
    const edited = store.update(task.sessionId, task.revision, {
      ownerUserId: 2,
      notifyOnTerminal: true
    });
    expect(edited).toMatchObject({
      ownerUserId: 2,
      notifyOnTerminal: true
    });
    now = task.nextRunAt as number;
    const occurrence = store.claim(task.sessionId, now, edited.revision);
    expect(occurrence).toBe(`${task.id}:${now}`);
    expect(store.claim(task.sessionId, now, edited.revision)).toBeUndefined();
    store.finish(occurrence as string, 'SKIPPED', 'SCHEDULE_SESSION_BUSY');
    expect(store.recent(task.id)).toMatchObject([
      { status: 'SKIPPED', code: 'SCHEDULE_SESSION_BUSY' }
    ]);
    database.deleteSessionRecord(task.sessionId);
    expect(store.get(task.sessionId)).toBeUndefined();
    expect(store.recent(task.id)).toEqual([]);
    database.close();
  });
});
