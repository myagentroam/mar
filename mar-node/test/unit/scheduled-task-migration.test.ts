import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate, NODE_SCHEMA_MIGRATIONS } from '../../src/database.js';
import { ScheduledSessionStore } from '../../src/service/scheduled-session-store.js';
import { dailyGroups } from './scheduled-task-fixtures.js';

function fixture(cron = '5 10,20 1 * 1') {
  const db = new DatabaseSync(':memory:');
  migrate(
    db,
    NODE_SCHEMA_MIGRATIONS.filter(({ version }) => version <= 23)
  );
  db.exec(`INSERT INTO workspaces (id,path,kind,created_at,updated_at) VALUES ('w','/v24','DIRECTORY',1,1);
    INSERT INTO agent_sessions (id,workspace_id,runner,metadata) VALUES ('s','w','codex','{"version":1,"customTitle":"Work"}');
    INSERT INTO scheduled_session_proposals(id,task_id,proposed_by_user_id,base_revision,objective,cron,status,created_at)
      VALUES ('objective-edit','legacy',8,4,'Proposed',NULL,'PENDING',2),
        ('time-edit','legacy',8,4,NULL,'55 8 * * 1-5','PENDING',3);
    INSERT INTO scheduled_session_occurrences (id,task_id,due_at,status,run_id,created_at,updated_at)
      VALUES ('previous','legacy',120000,'SUCCEEDED','run',2,3),
        ('unknown-target','legacy',60000,'SKIPPED',NULL,2,3);`);
  db.prepare(
    `INSERT INTO scheduled_session_tasks (id,session_id,workspace_id,runner,owner_user_id,objective,cron,timezone,
    enabled,revision,next_run_at,created_at,updated_at,notify_on_terminal) VALUES ('legacy','s','w','codex',7,'Check',?,'UTC',1,4,36000000,1,2,1)`
  ).run(cron);
  return db;
}

describe('scheduled task migration', () => {
  it('reopens v24 with both kinds of proposals and keeps old execution facts without inventing snapshots', () => {
    const db = fixture();
    try {
      migrate(db);
      const seq = db.prepare('PRAGMA schema_version').get();
      migrate(db);
      expect(db.prepare('PRAGMA schema_version').get()).toEqual(seq);
      for (const table of ['scheduled_session_tasks', 'scheduled_session_proposals'])
        expect(
          db.prepare(`SELECT name FROM pragma_table_info('${table}') WHERE name='cron'`).get()
        ).toBeUndefined();
      const store = new ScheduledSessionStore(db, () => 0);
      expect(store.getById('legacy')).toMatchObject({
        ownerUserId: 7,
        revision: 4,
        nextRunAt: 36000000,
        name: 'Work',
        notifyOnTerminal: true,
        groups: [
          {
            days: { kind: 'monthDays', monthDays: [1] },
            times: { kind: 'grid', hours: [10, 20], minutes: [5] }
          },
          {
            days: { kind: 'weekdays', weekdays: [1] },
            times: { kind: 'grid', hours: [10, 20], minutes: [5] }
          }
        ]
      });
      expect(store.pendingProposals('legacy')).toMatchObject([
        { id: 'time-edit', base_revision: 4, time_groups: expect.any(String) },
        { id: 'objective-edit', base_revision: 4, time_groups: null }
      ]);
      expect(store.recent('legacy')).toMatchObject([
        { run_id: 'run', execution_session_id: 's', task_snapshot: null },
        { run_id: null, execution_session_id: null, task_snapshot: null }
      ]);
      expect(store.history('w', { taskId: 'legacy', sessionId: 's' })).toMatchObject({
        total: 1,
        items: [{ occurrenceId: 'previous' }]
      });
      expect(store.history('w', { taskId: 'legacy', sessionId: 'unrelated' })).toEqual({
        total: 0,
        items: []
      });
      const sibling = store.create({
        sessionId: 's',
        workspaceId: 'w',
        runner: 'codex',
        ownerUserId: 7,
        name: 'Another',
        objective: 'Separate prompt',
        groups: dailyGroups('10:00'),
        timezone: 'UTC'
      });
      const a = store.claim('legacy', 36000000, 4);
      const b = store.claim(sibling.id, 36000000, 1);
      expect(a).toEqual('legacy:36000000');
      expect(b).toEqual(`${sibling.id}:36000000`);
      expect(JSON.parse(String(store.recent(sibling.id)[0]?.task_snapshot))).toMatchObject({
        objective: 'Separate prompt',
        revision: 1,
        matchedGroups: [0]
      });
    } finally {
      db.close();
    }
  });

  it('rolls back schema and rows when a legacy expression cannot be converted', () => {
    const db = fixture('invalid');
    try {
      expect(() => migrate(db)).toThrow(
        'NODE_DATABASE_SCHEDULE_MIGRATION_INVALID:scheduled_session_tasks:legacy'
      );
      expect(
        db.prepare('SELECT max(version) AS version FROM node_schema_migrations').get()
      ).toMatchObject({ version: 23 });
      expect(db.prepare('SELECT cron,revision FROM scheduled_session_tasks').get()).toMatchObject({
        cron: 'invalid',
        revision: 4
      });
      expect(
        db.prepare("SELECT run_id FROM scheduled_session_occurrences WHERE id='previous'").get()
      ).toMatchObject({ run_id: 'run' });
    } finally {
      db.close();
    }
  });

  it('rejects an orphaned legacy occurrence instead of discarding it during migration', () => {
    const db = fixture();
    try {
      db.prepare(
        "UPDATE scheduled_session_occurrences SET task_id='missing' WHERE id='previous'"
      ).run();
      expect(() => migrate(db)).toThrow(
        'NODE_DATABASE_SCHEMA_INVALID:relations:scheduled_session_occurrences'
      );
      expect(
        db.prepare('SELECT max(version) AS version FROM node_schema_migrations').get()
      ).toEqual({
        version: 23
      });
      expect(
        db
          .prepare("SELECT task_id,run_id FROM scheduled_session_occurrences WHERE id='previous'")
          .get()
      ).toEqual({ task_id: 'missing', run_id: 'run' });
    } finally {
      db.close();
    }
  });
});
