import { hourlyTriggers, dailyTriggers } from './scheduled-task-fixtures.js';
import { describe, expect, it } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import { ScheduledSessionStore } from '../../src/service/scheduled-session-store.js';

describe('scheduled session store', () => {
  it('filters schedule state before paging and binds the cursor to that filter', () => {
    const now = Date.parse('2026-11-25T08:00:00Z');
    const database = new NodeDatabase(':memory:', 'schedule-states', () => now);
    try {
      const workspace = database.saveWorkspace({
        path: '/states',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      for (const externalSessionId of ['existing', 'removed'])
        database.saveNativeSessionMetadata({
          runner: 'codex',
          externalSessionId,
          workspaceId: workspace.id
        });
      const store = new ScheduledSessionStore(database.raw, () => now);
      const create = (name: string, sessionId: string, enabled = true, ownerUserId = 1) =>
        store.create({
          name,
          sessionId,
          enabled,
          workspaceId: workspace.id,
          runner: 'codex',
          ownerUserId,
          objective: 'Check',
          triggers: dailyTriggers('09:00'),
          timezone: 'UTC'
        });
      const scheduled = [create('Active A', 'existing'), create('Active B', 'existing')];
      const paused = create('Paused', 'existing', false);
      const finished = create('Finished', 'existing');
      const unbound = create('Unbound', 'removed');
      database.raw
        .prepare('UPDATE scheduled_session_tasks SET next_run_at=NULL WHERE id=?')
        .run(finished.id);
      store.unbindSession('removed');
      const list = (state: 'scheduled' | 'paused' | 'finished' | 'unbound', cursor?: string) =>
        store.list(workspace.id, cursor, 1, undefined, undefined, undefined, state);
      const first = list('scheduled');
      expect(first.nextCursor).not.toBeNull();
      const second = list('scheduled', first.nextCursor!);
      expect([...first.tasks, ...second.tasks].map(({ id }) => id).sort()).toEqual(
        scheduled.map(({ id }) => id).sort()
      );
      expect(() => list('paused', first.nextCursor!)).toThrow('SCHEDULE_INVALID');
      expect(list('paused').tasks.map(({ id }) => id)).toEqual([paused.id]);
      expect(list('finished').tasks.map(({ id }) => id)).toEqual([finished.id]);
      expect(list('unbound').tasks.map(({ id }) => id)).toEqual([unbound.id]);

      create('Another owner', 'existing', true, 2);
      create('Another session', 'removed');
      const filter = { sessionId: 'existing', ownerUserId: 1, state: 'scheduled' as const };
      const [, lastId] = scheduled.map(({ id }) => id).sort();
      expect(store.listPage(workspace.id, filter, 0, 0)).toEqual({ total: 2, tasks: [] });
      const page = store.listPage(workspace.id, filter, 1, 1);
      expect(page.total).toBe(2);
      expect(page.tasks.map(({ id }) => id)).toEqual([lastId]);
      expect(store.listPage(workspace.id, filter, 2, 1)).toEqual({ total: 2, tasks: [] });
      expect(() => store.listPage(workspace.id, filter, -1, 1)).toThrow('SCHEDULE_INVALID');
    } finally {
      database.close();
    }
  });

  it('recomputes time only for changed rules or a transition from disabled to enabled', () => {
    let now = Date.parse('2026-10-23T00:00:00Z');
    const database = new NodeDatabase(':memory:', 'schedule-edit', () => now);
    try {
      const workspace = database.saveWorkspace({
        path: '/schedule-edit',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: 'editable',
        workspaceId: workspace.id
      });
      const store = new ScheduledSessionStore(database.raw, () => now);
      let task = store.create({
        sessionId: 'editable',
        workspaceId: workspace.id,
        runner: 'codex',
        ownerUserId: 1,
        objective: 'Original',
        name: 'Schedule',
        triggers: hourlyTriggers,
        timezone: 'UTC'
      });
      const dueAt = task.nextRunAt;
      now = Date.parse('2026-10-23T01:00:01Z');
      task = store.update(task.id, task.revision, { timezone: 'UTC' });
      expect(task.nextRunAt).toBe(dueAt);
      task = store.update(task.id, task.revision, { triggers: dailyTriggers('02:30') });
      expect(task.nextRunAt).toBe(Date.parse('2026-10-23T02:30:00Z'));
      task = store.update(task.id, task.revision, { timezone: 'Asia/Shanghai' });
      expect(task.nextRunAt).toBe(Date.parse('2026-10-23T18:30:00Z'));
      task = store.update(task.id, task.revision, { enabled: false });
      expect(task.nextRunAt).toBeNull();
      task = store.update(task.id, task.revision, {
        objective: 'Paused edit',
        triggers: hourlyTriggers
      });
      expect(task.nextRunAt).toBeNull();
      task = store.update(task.id, task.revision, { enabled: true });
      expect(task.nextRunAt).toBe(Date.parse('2026-10-23T02:00:00Z'));
    } finally {
      database.close();
    }
  });

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
        name: 'Schedule',
        triggers: dailyTriggers('01:30'),
        timezone: 'America/New_York'
      });
      expect(task.nextRunAt).toBe(Date.parse('2025-11-02T05:30:00Z'));
      now = Date.parse('2025-11-02T05:31:00Z');
      expect(store.claim(task.id, task.nextRunAt!, task.revision)).toBe(
        `${task.id}:${task.nextRunAt}`
      );
      expect(store.getById(task.id)?.nextRunAt).toBe(Date.parse('2025-11-03T06:30:00Z'));
      const paused = store.update(task.id, task.revision, { enabled: false });
      now = Date.parse('2025-11-02T06:10:00Z');
      const resumed = store.update(task.id, paused.revision, { enabled: true });
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
        name: 'Schedule',
        triggers: hourlyTriggers,
        timezone: 'UTC'
      });
      expect(store.getById(task.id)?.graceMinutes).toBe(0);
      expect(store.recentPage(task.id)).toEqual({
        occurrences: [],
        occurrenceTotal: 0,
        occurrencePage: 1
      });
      const ids: string[] = [];
      for (let index = 0; index < 25; index++) {
        now = store.getById(task.id)!.nextRunAt!;
        const id = store.claim(task.id, now, task.revision)!;
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
        now = store.getById(task.id)!.nextRunAt!;
        store.finish(store.claim(task.id, now, task.revision)!, 'SKIPPED');
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

  it('bounds pending proposals and keeps resolution with the setting owner', () => {
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
      name: 'Schedule',
      triggers: hourlyTriggers,
      timezone: 'UTC'
    });
    const proposal = store.propose(task, 2, { objective: 'Updated' });
    expect(() => store.resolveProposal(task.id, proposal, 2, true)).toThrow(
      'SCHEDULE_OWNER_REQUIRED'
    );
    expect(store.resolveProposal(task.id, proposal, 1, true).objective).toBe('Updated');
    expect(store.pendingProposals(task.id)).toEqual([]);
    for (let index = 0; index < 50; index++)
      store.propose(store.getById(task.id)!, 2, { objective: `Proposal ${index}` });
    expect(store.pendingProposals(task.id)).toHaveLength(50);
    expect(() => store.propose(store.getById(task.id)!, 2, { objective: 'Excess' })).toThrow(
      'SCHEDULE_PROPOSAL_LIMIT'
    );
    store.update(task.id, 2, { objective: 'Third' });
    expect(store.pendingProposals(task.id)).toEqual([]);
    const edited = store.update(task.id, 3, { name: 'Renamed' });
    expect(edited).toMatchObject({ ownerUserId: 1 });
    const nextProposal = store.propose(edited, 2, { objective: 'Fourth' });
    expect(() => store.resolveProposal(task.id, nextProposal, 2, true)).toThrow(
      'SCHEDULE_OWNER_REQUIRED'
    );
    expect(store.resolveProposal(task.id, nextProposal, 1, true).objective).toBe('Fourth');
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
      name: 'Schedule',
      triggers: hourlyTriggers,
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
      name: 'Schedule',
      triggers: hourlyTriggers,
      timezone: 'UTC'
    });
    const proposal = store.propose(task, 2, { objective: 'Inspect later' });
    const occurrence = store.claim(task.id, task.nextRunAt!, task.revision);

    expect(() => store.remove(task.id, task.revision + 1)).toThrow('SCHEDULE_REVISION_CONFLICT');
    expect(store.getById(task.id)).toBeDefined();
    expect(store.recent(task.id)).toHaveLength(1);
    expect(store.pendingProposals(task.id).map((row) => row['id'])).toEqual([proposal]);

    expect(() => store.remove(task.id, task.revision)).toThrow('SCHEDULE_IN_PROGRESS');
    expect(store.finish(occurrence!, 'SKIPPED')).toBe(true);
    store.remove(task.id, task.revision);
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
      name: 'Schedule',
      triggers: hourlyTriggers,
      timezone: 'UTC'
    });
    const current = store.update(task.id, task.revision, { objective: 'Updated' });
    expect(() => store.propose(task, 2, { objective: 'Stale proposal' })).toThrow(
      'SCHEDULE_REVISION_CONFLICT'
    );
    store.remove(current.id, current.revision);
    expect(() => store.propose(current, 2, { objective: 'Deleted proposal' })).toThrow(
      'SCHEDULE_NOT_FOUND'
    );
    database.close();
  });

  it('persists tasks, claims each occurrence once, and retains history on session removal', () => {
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
      name: 'Schedule',
      triggers: hourlyTriggers,
      timezone: 'UTC'
    });
    expect(task.nextRunAt).toBe(Date.parse('2025-01-01T01:00:00Z'));
    expect(task).toMatchObject({
      ownerUserId: 1,
      notifyOnTerminal: false
    });
    const edited = store.update(task.id, task.revision, { notifyOnTerminal: true });
    expect(edited).toMatchObject({
      ownerUserId: 1,
      notifyOnTerminal: true
    });
    now = task.nextRunAt as number;
    const occurrence = store.claim(task.id, now, edited.revision);
    expect(occurrence).toBe(`${task.id}:${now}`);
    expect(store.claim(task.id, now, edited.revision)).toBeUndefined();
    store.finish(occurrence as string, 'SKIPPED', 'SCHEDULE_SESSION_BUSY');
    expect(store.recent(task.id)).toMatchObject([
      { status: 'SKIPPED', code: 'SCHEDULE_SESSION_BUSY' }
    ]);
    expect(database.deleteSessionRecord('session-1')).toEqual({
      removed: true,
      schedulesChanged: true
    });
    expect(store.getById(task.id)).toMatchObject({
      sessionId: null,
      enabled: false,
      nextRunAt: null
    });
    expect(store.recent(task.id)).toHaveLength(1);
    database.close();
  });
});
