import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate, NodeDatabase, NODE_SCHEMA_MIGRATIONS } from '../../src/database.js';
import { NodeConnector } from '../../src/connector.js';
import { ScheduledSessionCoordinator } from '../../src/service/scheduled-session-coordinator.js';
import {
  ScheduledSessionStore,
  type ScheduledSessionTask
} from '../../src/service/scheduled-session-store.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'schedule-recovery-'));
  directories.push(directory);
  const path = join(directory, 'node-runtime.sqlite');
  let now = Date.parse('2025-01-01T00:00:00Z');
  const clock = () => now;
  const database = new NodeDatabase(path, 'node-a', clock);
  const workspace = database.saveWorkspace({
    path: directory,
    kind: 'DIRECTORY',
    gitSummary: null
  });
  const store = new ScheduledSessionStore(database.raw, clock);
  const tasks = ['thread-a', 'thread-b'].map((sessionId) => {
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: sessionId,
      workspaceId: workspace.id
    });
    return store.create({
      sessionId,
      workspaceId: workspace.id,
      runner: 'codex',
      ownerUserId: 7,
      objective: 'Check status',
      cron: '0 * * * *',
      timezone: 'UTC'
    });
  });
  return {
    path,
    database,
    store,
    tasks,
    clock,
    setNow: (value: number) => {
      now = value;
    }
  };
}

describe('scheduled session restart recovery', () => {
  it('recovers the entire startup set before new claims and does not recover on control reconnect', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const ids = f.tasks.map((task, index) => {
      const id = f.store.claim(task.sessionId, task.nextRunAt!, task.revision)!;
      if (index === 1) f.store.finish(id, 'SUBMITTED', undefined, 'old-run');
      return id;
    });
    f.database.close();
    const now = Date.parse('2025-01-01T02:00:00Z');
    vi.setSystemTime(now);
    const database = new NodeDatabase(f.path, 'node-a');
    const store = new ScheduledSessionStore(database.raw);
    const connector = new NodeConnector({
      database,
      reconnect: false,
      configPath: join(f.path, '..', 'node-config.json'),
      config: {
        serverUrl: 'https://server.example.test',
        allowedRoots: [],
        dataDirectory: join(f.path, '..'),
        nodeId: 'node-a',
        credential: 'test-only'
      },
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: false }
      }
    });
    const internals = connector as unknown as {
      createDirectTransferService(): Promise<undefined>;
      computerUseEnablement: { initialize(): void };
      controlChannel: { connect(): void };
      terminalChannel: { connect(): void };
      connectionLifecycle: { connected(): void };
      workbenchEventService: { publish(event: unknown): void };
      scheduledSessions: { options: { authorize: () => Promise<never> } };
    };
    vi.spyOn(internals, 'createDirectTransferService').mockResolvedValue(undefined);
    vi.spyOn(internals.computerUseEnablement, 'initialize').mockImplementation(() => undefined);
    vi.spyOn(internals.controlChannel, 'connect').mockImplementation(() => undefined);
    vi.spyOn(internals.terminalChannel, 'connect').mockImplementation(() => undefined);
    const published = vi.spyOn(internals.workbenchEventService, 'publish');
    const recovery = vi.spyOn(ScheduledSessionStore.prototype, 'recoverInterrupted');
    const actualClaim = ScheduledSessionStore.prototype.claim;
    vi.spyOn(ScheduledSessionStore.prototype, 'claim').mockImplementation(function (
      this: ScheduledSessionStore,
      ...args
    ) {
      for (const id of ids)
        expect(
          database.raw
            .prepare('SELECT status FROM scheduled_session_occurrences WHERE id=?')
            .get(id)
        ).toMatchObject({ status: 'FAILED' });
      return actualClaim.apply(this, args);
    });
    internals.scheduledSessions.options.authorize = vi.fn(async () => {
      throw new Error('SCHEDULE_AUTH_DENIED');
    });
    try {
      await connector.start();
      await vi.waitFor(() =>
        expect(internals.scheduledSessions.options.authorize).toHaveBeenCalledTimes(2)
      );
      expect(recovery).toHaveBeenCalledOnce();
      const notifications = () =>
        published.mock.calls
          .map(([event]) => event as { payload: { event?: { payload: Record<string, unknown> } } })
          .flatMap((event) => (event.payload.event ? [event.payload.event.payload] : []))
          .filter((event) => event['code'] === 'SCHEDULE_RESTART_OUTCOME_UNKNOWN');
      expect(notifications()).toEqual([]);
      internals.connectionLifecycle.connected();
      expect(notifications()).toHaveLength(2);
      expect(
        notifications()
          .map((event) => event['notificationId'])
          .sort()
      ).toEqual(f.tasks.map((task, index) => `schedule:${task.id}:${ids[index]}`).sort());
      expect(
        notifications().every(
          (event) => event['kind'] === 'SCHEDULE_FAILED' && event['userId'] === 7
        )
      ).toBe(true);
      const activeId = store.claim(
        f.tasks[0]!.sessionId,
        store.get(f.tasks[0]!.sessionId)!.nextRunAt!,
        1
      )!;
      store.finish(activeId, 'SUBMITTED', undefined, 'current-run');
      internals.connectionLifecycle.connected();
      expect(recovery).toHaveBeenCalledOnce();
      expect(notifications()).toHaveLength(2);
      expect(store.recent(f.tasks[0]!.id)[0]).toMatchObject({
        id: activeId,
        status: 'SUBMITTED',
        run_id: 'current-run'
      });
    } finally {
      await connector.stop();
      vi.restoreAllMocks();
    }
  });

  it.each([
    'claimed-before-submit',
    'submitted-before-bookkeeping',
    'submitted-before-terminal'
  ] as const)(
    'fails an uncertain %s once without replay and allows the next cycle',
    async (window) => {
      vi.useFakeTimers();
      const f = await fixture();
      const task = f.tasks[0]!;
      f.setNow(task.nextRunAt!);
      const occurrenceId = f.store.claim(task.sessionId, task.nextRunAt!, task.revision)!;
      const sideEffects = window === 'claimed-before-submit' ? [] : [occurrenceId];
      if (window === 'submitted-before-terminal')
        f.store.finish(occurrenceId, 'SUBMITTED', undefined, 'original-run');
      const nextRunAt = f.store.get(task.sessionId)!.nextRunAt!;
      f.database.close();
      const database = new NodeDatabase(f.path, 'node-a', f.clock);
      const store = new ScheduledSessionStore(database.raw, f.clock);
      const notify = vi.fn();
      const authorize = vi.fn(async () => ({ secretEnvironment: {} }));
      const submit = vi.fn(async (_task: ScheduledSessionTask, id: string) => {
        sideEffects.push(id);
        return { runId: 'next-run' };
      });
      const coordinator = new ScheduledSessionCoordinator({
        store: () => store,
        busy: () => false,
        authorize,
        submit,
        emitNotification: notify,
        sessionTitle: (id) => id,
        now: f.clock
      });
      try {
        coordinator.recoverInterrupted();
        coordinator.recoverInterrupted();
        expect(store.recent(task.id)[0]).toMatchObject({
          id: occurrenceId,
          task_id: task.id,
          due_at: task.nextRunAt,
          status: 'FAILED',
          code: 'SCHEDULE_RESTART_OUTCOME_UNKNOWN',
          run_id: window === 'submitted-before-terminal' ? 'original-run' : null
        });
        expect(store.get(task.sessionId)?.nextRunAt).toBe(nextRunAt);
        expect(notify).not.toHaveBeenCalled();
        coordinator.connected();
        coordinator.connected();
        expect(notify).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            event: expect.objectContaining({
              eventType: 'notification',
              payload: expect.objectContaining({
                notificationId: 'schedule:' + task.id + ':' + occurrenceId,
                code: 'SCHEDULE_RESTART_OUTCOME_UNKNOWN',
                kind: 'SCHEDULE_FAILED'
              })
            })
          })
        );
        expect(authorize).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
        expect(sideEffects).toEqual(window === 'claimed-before-submit' ? [] : [occurrenceId]);
        coordinator.start();
        f.setNow(nextRunAt);
        await vi.advanceTimersByTimeAsync(nextRunAt - task.nextRunAt!);
        expect(submit).toHaveBeenCalled();
        expect(store.recent(task.id)[0]).toMatchObject({ status: 'SUBMITTED', run_id: 'next-run' });
        expect(sideEffects.filter((id) => id === occurrenceId)).toHaveLength(
          window === 'claimed-before-submit' ? 0 : 1
        );
        coordinator.connected();
        const count = notify.mock.calls.length;
        coordinator.connected();
        expect(notify).toHaveBeenCalledTimes(count);
        expect(store.recent(task.id)[0]).toMatchObject({ status: 'SUBMITTED', run_id: 'next-run' });
      } finally {
        coordinator.stop();
        database.close();
      }
    }
  );

  it.each([0, 3])(
    'uses the partial index for the final recovery SQL with %i leftovers and many terminal rows',
    async (leftovers) => {
      const f = await fixture();
      try {
        const insert = f.database.raw.prepare(
          'INSERT INTO scheduled_session_occurrences (id,task_id,due_at,status,code,run_id,created_at,updated_at) VALUES (?,?,?,?,?,?,0,0)'
        );
        f.database.raw.exec('BEGIN');
        for (let i = 0; i < 5000; i++)
          insert.run(
            'terminal-' + i,
            f.tasks[1]!.id,
            i,
            ['SUCCEEDED', 'FAILED', 'SKIPPED'][i % 3]!,
            'original-code',
            'original-run'
          );
        for (let i = 0; i < leftovers; i++)
          insert.run(
            'leftover-' + i,
            f.tasks[0]!.id,
            i,
            i % 2 === 0 ? 'CLAIMED' : 'SUBMITTED',
            null,
            i % 2 === 0 ? null : 'retained-run'
          );
        f.database.raw.exec('COMMIT');
        const originalPrepare = f.database.raw.prepare.bind(f.database.raw);
        let plan: unknown[] = [];
        const prepare = vi.spyOn(f.database.raw, 'prepare').mockImplementation((sql) => {
          if (sql.startsWith('UPDATE scheduled_session_occurrences')) {
            plan = originalPrepare('EXPLAIN QUERY PLAN ' + sql).all(
              'SCHEDULE_RESTART_OUTCOME_UNKNOWN',
              f.clock()
            );
            console.info(JSON.stringify({ leftovers, terminalRows: 5000, sql, plan }));
          }
          return originalPrepare(sql);
        });
        const recovered = f.store.recoverInterrupted();
        const sql = prepare.mock.calls
          .map(([text]) => text)
          .find((text) => /^UPDATE scheduled_session_occurrences/u.test(text))!;
        expect(sql).toBeTruthy();
        expect(JSON.stringify(plan)).toMatch(
          /SEARCH scheduled_session_occurrences USING (?:COVERING )?INDEX scheduled_session_occurrences_unfinished/u
        );
        expect(recovered).toHaveLength(leftovers);
        expect(
          f.database.raw
            .prepare('SELECT COUNT(*) AS count FROM scheduled_session_occurrences WHERE task_id=?')
            .get(f.tasks[1]!.id)
        ).toMatchObject({ count: 5000 });
        expect(f.store.recent(f.tasks[1]!.id)[0]).toMatchObject({
          code: 'original-code',
          run_id: 'original-run',
          updated_at: 0
        });
        expect(f.store.recoverInterrupted()).toEqual([]);
        expect(
          f.database.raw
            .prepare(
              "SELECT COUNT(*) AS count FROM scheduled_session_occurrences WHERE status IN ('CLAIMED','SUBMITTED')"
            )
            .get()
        ).toMatchObject({ count: 0 });
      } finally {
        f.database.close();
      }
    }
  );

  it('rolls recovery back on failure and keeps the existing terminal retention boundary', async () => {
    const f = await fixture();
    try {
      const task = f.tasks[0]!;
      for (let i = 0; i < 105; i++) {
        const due = f.store.get(task.sessionId)!.nextRunAt!;
        f.setNow(due);
        f.store.claim(task.sessionId, due, task.revision);
      }
      f.database.raw.exec(
        "CREATE TRIGGER fail_recovery BEFORE UPDATE ON scheduled_session_occurrences WHEN NEW.status='FAILED' BEGIN SELECT RAISE(ABORT, 'recovery-injected'); END"
      );
      expect(() => f.store.recoverInterrupted()).toThrow('recovery-injected');
      expect(
        f.database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM scheduled_session_occurrences WHERE status='CLAIMED'"
          )
          .get()
      ).toMatchObject({ count: 105 });
      f.database.raw.exec('DROP TRIGGER fail_recovery');
      expect(f.store.recoverInterrupted()).toHaveLength(105);
      expect(f.store.recentPage(task.id).occurrenceTotal).toBe(100);
      expect(f.store.recent(task.id, 100).every((row) => row['status'] === 'FAILED')).toBe(true);
    } finally {
      f.database.close();
    }
  });

  it('migrates v19 transactionally, preserves records and reopens without recreating the partial index', async () => {
    const f = await fixture();
    const task = f.tasks[0]!;
    const occurrenceId = f.store.claim(task.sessionId, task.nextRunAt!, task.revision)!;
    f.store.finish(occurrenceId, 'SUBMITTED', undefined, 'existing-run');
    f.database.close();
    const raw = new DatabaseSync(f.path);
    try {
      raw.exec(
        'DROP INDEX IF EXISTS scheduled_session_occurrences_unfinished; DELETE FROM node_schema_migrations WHERE version=20'
      );
      const migration = NODE_SCHEMA_MIGRATIONS.find((entry) => entry.version === 20)!;
      expect(migration).toBeDefined();
      expect(() =>
        migrate(raw, [
          ...NODE_SCHEMA_MIGRATIONS.filter((entry) => entry.version < 20),
          {
            ...migration,
            assert: () => {
              throw new Error('migration-injected');
            }
          }
        ])
      ).toThrow('migration-injected');
      expect(
        raw.prepare('SELECT MAX(version) AS version FROM node_schema_migrations').get()
      ).toMatchObject({ version: 19 });
      expect(
        raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='scheduled_session_occurrences_unfinished'"
          )
          .get()
      ).toBeUndefined();
      migrate(raw);
      const schemaVersion = raw.prepare('PRAGMA schema_version').get();
      migrate(raw);
      expect(raw.prepare('PRAGMA schema_version').get()).toEqual(schemaVersion);
    } finally {
      raw.close();
    }
    const reopened = new NodeDatabase(f.path, 'node-a', f.clock);
    try {
      expect(new ScheduledSessionStore(reopened.raw).recent(task.id)[0]).toMatchObject({
        id: occurrenceId,
        status: 'SUBMITTED',
        run_id: 'existing-run'
      });
      expect(
        reopened.raw.prepare('SELECT MAX(version) AS version FROM node_schema_migrations').get()
      ).toMatchObject({ version: 20 });
      expect(
        reopened.raw.prepare("PRAGMA index_list('scheduled_session_occurrences')").all()
      ).toContainEqual(
        expect.objectContaining({ name: 'scheduled_session_occurrences_unfinished', partial: 1 })
      );
    } finally {
      reopened.close();
    }
  });
});
