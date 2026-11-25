import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate, NODE_SCHEMA_MIGRATIONS } from '../../src/database.js';

function fixture(cron = '5 10,20 1 * 1', proposalCron = '55 8 * * 1-5') {
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
  db.prepare("UPDATE scheduled_session_proposals SET cron=? WHERE id='time-edit'").run(
    proposalCron
  );
  return db;
}

function migrateToV24(db: DatabaseSync): void {
  migrate(
    db,
    NODE_SCHEMA_MIGRATIONS.filter(({ version }) => version <= 24)
  );
}

describe('scheduled task migration', () => {
  it('retains exact startup schema checking for unrelated v24 indexes', () => {
    const db = fixture();
    try {
      migrate(db);
      db.exec('DROP INDEX scheduled_session_tasks_due');
      expect(() => NODE_SCHEMA_MIGRATIONS.at(-1)!.assert(db)).toThrow(
        'NODE_DATABASE_SCHEMA_INVALID:scheduled_session_tasks_due'
      );
    } finally {
      db.close();
    }
  });

  it.each(['explicit', 'month-restricted', 'hour-grid'])(
    'resets a %s schedule without conversion, skipping only work not yet submitted',
    (format) => {
      const db = fixture();
      try {
        migrateToV24(db);
        db.prepare("UPDATE scheduled_session_tasks SET time_groups=? WHERE id='legacy'").run(
          JSON.stringify([
            {
              days: {
                kind: 'weekdays',
                weekdays: [1, 5],
                ...(format === 'month-restricted' ? { months: [2] } : {})
              },
              times:
                format === 'hour-grid'
                  ? { kind: 'grid', hours: [9], minutes: [0] }
                  : { kind: 'times', times: ['09:00'] }
            }
          ])
        );
        db.exec(`INSERT INTO scheduled_session_occurrences
        (id,task_id,due_at,status,run_id,created_at,updated_at) VALUES
        ('claimed','legacy',300000,'CLAIMED',NULL,2,3),
        ('waiting','legacy',360000,'WAITING',NULL,2,3),
        ('submitting','legacy',420000,'SUBMITTING',NULL,2,3),
        ('submitted','legacy',480000,'SUBMITTED','submitted-run',2,3);`);
        migrate(db);

        expect(
          db
            .prepare(
              `SELECT name,objective,enabled,revision,next_run_at,triggers FROM scheduled_session_tasks
              WHERE id='legacy'`
            )
            .get()
        ).toMatchObject({
          name: 'Work',
          objective: 'Check',
          enabled: 0,
          revision: 5,
          next_run_at: null,
          triggers: '[]'
        });
        expect(
          db
            .prepare(
              `SELECT id,status,code,run_id FROM scheduled_session_occurrences
              WHERE id IN ('claimed','waiting','submitting','submitted') ORDER BY id`
            )
            .all()
        ).toEqual([
          { id: 'claimed', status: 'SKIPPED', code: 'SCHEDULE_TASK_CHANGED', run_id: null },
          { id: 'submitted', status: 'SUBMITTED', code: null, run_id: 'submitted-run' },
          { id: 'submitting', status: 'SUBMITTING', code: null, run_id: null },
          { id: 'waiting', status: 'SKIPPED', code: 'SCHEDULE_TASK_CHANGED', run_id: null }
        ]);
        expect(
          db
            .prepare("SELECT id,run_id FROM scheduled_session_occurrences WHERE id='previous'")
            .get()
        ).toEqual({ id: 'previous', run_id: 'run' });
        expect(
          db.prepare("SELECT id FROM scheduled_session_proposals WHERE task_id='legacy'").all()
        ).toEqual([]);
        for (const table of ['scheduled_session_tasks', 'scheduled_session_proposals']) {
          const columns = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all();
          expect(columns).toContainEqual({ name: 'triggers' });
          expect(columns).not.toContainEqual({ name: 'time_groups' });
        }
        migrate(db);
        expect(db.prepare('SELECT revision FROM scheduled_session_tasks').get()).toEqual({
          revision: 5
        });
      } finally {
        db.close();
      }
    }
  );

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
