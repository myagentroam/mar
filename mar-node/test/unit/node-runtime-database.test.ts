import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import { migrate, NODE_SCHEMA_MIGRATIONS } from '../../src/database.js';
import { NODE_SCHEMA_MIGRATION_DEMO } from '../../src/migrations/demo.js';
import { NODE_SCHEMA_V13 } from '../../src/migrations/v013.js';
import { NODE_SCHEMA_MIGRATION_V14 } from '../../src/migrations/v014.js';
import { NODE_SCHEMA_MIGRATION_V15 } from '../../src/migrations/v015.js';
import { NODE_SCHEMA_MIGRATION_V16 } from '../../src/migrations/v016.js';
import { ScheduledSessionStore } from '../../src/service/scheduled-session-store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('Node SQLite session records', () => {
  it('backfills v18 creation parents and preserves relationships across metadata updates and restarts', async () => {
    const { path } = await databasePath('parent-migration');
    const original = new NodeDatabase(path, 'node-a');
    const workspace = original.saveWorkspace({
      path: '/parent-migration',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    for (const id of ['legacy', 'linked'])
      original.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: id,
        workspaceId: workspace.id,
        customTitle: id,
        sessionPrompt: 'Keep instructions',
        pinned: true,
        ...(id === 'linked' ? { parentSessionId: 'parent' } : {})
      });
    original.raw
      .prepare(
        "UPDATE agent_sessions SET metadata=json_remove(metadata, '$.parentSessionId') WHERE id='legacy'"
      )
      .run();
    original.raw.exec('DROP INDEX scheduled_session_occurrences_unfinished');
    original.raw.prepare('DELETE FROM node_schema_migrations WHERE version>=19').run();
    original.close();
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const reopened = new NodeDatabase(path, 'node-a');
      expect(reopened.getSessionRecord('legacy')?.metadata).toMatchObject({
        parentSessionId: null,
        customTitle: 'legacy',
        sessionPrompt: 'Keep instructions'
      });
      expect(reopened.getSessionRecord('linked')?.metadata).toMatchObject({
        parentSessionId: 'parent',
        customTitle: iteration === 0 ? 'linked' : 'Renamed'
      });
      expect(reopened.raw.prepare('PRAGMA foreign_key_list(agent_sessions)').all()).toEqual([]);
      reopened.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: 'linked',
        workspaceId: workspace.id,
        customTitle: 'Renamed',
        parentSessionId: 'other-parent'
      });
      expect(reopened.getSessionRecord('linked')?.metadata.parentSessionId).toBe('parent');
      reopened.close();
    }
  });
  it('creates only one session table in a new database, keyed by the native ID', async () => {
    const database = await createDatabase('node-a');
    expect(
      database.raw.prepare('SELECT version FROM node_schema_migrations ORDER BY version').all()
    ).toEqual([
      { version: 13 },
      { version: 14 },
      { version: 15 },
      { version: 16 },
      { version: 17 },
      { version: 18 },
      { version: 19 },
      { version: 20 }
    ]);
    expect(foreignKeyList(database.raw)).toEqual([]);
    expect(database.raw.prepare('PRAGMA table_info(agent_sessions)').all()).toEqual(
      expect.arrayContaining(
        ['id', 'workspace_id', 'runner', 'pin_order', 'metadata'].map((name) =>
          expect.objectContaining({ name })
        )
      )
    );
    expect(
      database.raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'native_session_metadata'"
        )
        .get()
    ).toBeUndefined();
    expect(
      database.raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('conversation_template_versions','conversation_template_publish_jobs','hosted_conversations','conversation_files') ORDER BY name"
        )
        .all()
    ).toEqual([
      { name: 'conversation_files' },
      { name: 'conversation_template_publish_jobs' },
      { name: 'conversation_template_versions' },
      { name: 'hosted_conversations' }
    ]);
    expect(database.raw.prepare('PRAGMA table_info(hosted_conversations)').all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'pinned_at' }),
        expect.objectContaining({ name: 'title_source', dflt_value: "'CUSTOM'" })
      ])
    );
    const hostedConversationTable = database.raw
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='hosted_conversations'")
      .get() as { readonly sql: string };
    expect(hostedConversationTable.sql).toContain("title_source IN ('DEFAULT','AUTO','CUSTOM')");
    expect(database.raw.prepare('PRAGMA table_info(hosted_conversations)').all()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'recoverable_until' })])
    );
    expect(database.raw.prepare('PRAGMA table_info(hosted_conversation_messages)').all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'user_text_present', dflt_value: '1' })
      ])
    );
    expect(
      database.saveRunnerDefaults({
        runner: 'opencode',
        model: 'opencode/model',
        effort: '',
        access: 'default'
      })
    ).toMatchObject({ runner: 'opencode', effort: '' });
    expect(
      database.saveRunnerDefaults({
        runner: 'mar-agent',
        model: 'coding',
        effort: 'medium',
        access: 'full-access'
      })
    ).toMatchObject({ runner: 'mar-agent', access: 'full-access' });
    const workspace = database.saveWorkspace({
      path: '/mar-agent-workspace',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveNativeSessionMetadata({
      runner: 'mar-agent',
      externalSessionId: 'mar-agent-session',
      workspaceId: workspace.id,
      customTitle: 'MAR Agent session'
    });
    expect(
      database.getNativeSessionMetadata('mar-agent', 'mar-agent-session', workspace.id)
    ).toMatchObject({ customTitle: 'MAR Agent session' });
    expect(
      database.raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'")
        .get()
    ).toBeUndefined();
    expect(
      database.raw
        .prepare("SELECT name FROM sqlite_temp_master WHERE type = 'table' AND name = 'run_events'")
        .get()
    ).toBeUndefined();
    database.close();
  });

  it('reopens the current v20 database after a Node restart', async () => {
    const { path } = await databasePath('current-reopen');
    const first = new NodeDatabase(path, 'node-a');
    const workspace = first.saveWorkspace({
      path: '/reopen-workspace',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    first.close();

    const reopened = new NodeDatabase(path, 'node-a');
    expect(
      reopened.raw.prepare('SELECT version FROM node_schema_migrations ORDER BY version').all()
    ).toEqual([
      { version: 13 },
      { version: 14 },
      { version: 15 },
      { version: 16 },
      { version: 17 },
      { version: 18 },
      { version: 19 },
      { version: 20 }
    ]);
    expect(foreignKeyList(reopened.raw)).toEqual([]);
    expect(reopened.getWorkspace(workspace.id)).toMatchObject({ path: '/reopen-workspace' });
    reopened.close();
  });

  it('backfills missing Session Prompt metadata from v17 and preserves records across repeated reopen', async () => {
    const { path } = await databasePath('v17-session-prompt');
    const original = new NodeDatabase(path, 'node-a');
    const workspace = original.saveWorkspace({
      path: '/v17-session-prompt',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    original.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: 'legacy-thread',
      workspaceId: workspace.id,
      customTitle: 'Preserved title',
      runnerTitle: 'Preserved Runner title',
      pinned: true
    });
    const legacyMetadata = {
      version: 1,
      customTitle: 'Preserved title',
      runnerTitle: 'Preserved Runner title',
      runnerTitlePending: false,
      model: null,
      effort: null,
      access: null
    };
    original.raw
      .prepare('UPDATE agent_sessions SET metadata=? WHERE id=?')
      .run(JSON.stringify(legacyMetadata), 'legacy-thread');
    original.raw.exec('DROP INDEX scheduled_session_occurrences_unfinished');
    original.raw.prepare('DELETE FROM node_schema_migrations WHERE version>=18').run();
    original.close();

    const upgraded = new NodeDatabase(path, 'node-a');
    expect(
      upgraded.raw.prepare('SELECT version FROM node_schema_migrations ORDER BY version').all()
    ).toEqual([
      { version: 13 },
      { version: 14 },
      { version: 15 },
      { version: 16 },
      { version: 17 },
      { version: 18 },
      { version: 19 },
      { version: 20 }
    ]);
    expect(upgraded.getNativeSessionMetadata('codex', 'legacy-thread', workspace.id)).toMatchObject(
      {
        customTitle: 'Preserved title',
        runnerTitle: 'Preserved Runner title',
        sessionPrompt: null,
        pinnedAt: 1,
        pinOrder: 0
      }
    );
    const migratedMetadata = upgraded.raw
      .prepare('SELECT metadata FROM agent_sessions WHERE id=?')
      .get('legacy-thread') as { readonly metadata: string };
    expect(JSON.parse(migratedMetadata.metadata)).toEqual({
      ...legacyMetadata,
      sessionPrompt: null,
      parentSessionId: null
    });
    upgraded.close();

    const reopened = new NodeDatabase(path, 'node-a');
    expect(
      reopened.raw.prepare('SELECT metadata FROM agent_sessions WHERE id=?').get('legacy-thread')
    ).toEqual(migratedMetadata);
    expect(reopened.getWorkspace(workspace.id)).toMatchObject({ path: '/v17-session-prompt' });
    reopened.close();
  });

  it('downgrades the exact empty obsolete v16 schema without deleting other records', async () => {
    const { path } = await databasePath('obsolete-v16-empty');
    const old = obsoleteV16Database(path);
    old.exec(`
      INSERT INTO workspaces (id,path,kind,created_at,updated_at)
      VALUES ('kept','/kept','DIRECTORY',1,1);
    `);
    old.close();

    const restored = new NodeDatabase(path, 'node-a');
    expect(
      restored.raw.prepare('SELECT version FROM node_schema_migrations ORDER BY version').all()
    ).toEqual([
      { version: 13 },
      { version: 14 },
      { version: 15 },
      { version: 16 },
      { version: 17 },
      { version: 18 },
      { version: 19 },
      { version: 20 }
    ]);
    expect(restored.getWorkspace('kept')).toMatchObject({ path: '/kept' });
    expect(
      (
        restored.raw.prepare('PRAGMA table_info(scheduled_session_tasks)').all() as {
          name: string;
        }[]
      ).map((column) => column.name)
    ).not.toContain('notify_user_id');
    restored.close();

    const reopened = new NodeDatabase(path, 'node-a');
    expect(reopened.getWorkspace('kept')).toMatchObject({ path: '/kept' });
    reopened.close();
  });

  it('keeps an obsolete v16 database with tasks untouched instead of losing recipients', async () => {
    const { path } = await databasePath('obsolete-v16-task');
    const old = obsoleteV16Database(path);
    old.exec(`
      INSERT INTO workspaces (id,path,kind,created_at,updated_at)
      VALUES ('w','/schedule','DIRECTORY',1,1);
      INSERT INTO agent_sessions (id,workspace_id,runner,metadata)
      VALUES ('s','w','codex','{}');
      INSERT INTO scheduled_session_tasks
        (id,session_id,workspace_id,runner,owner_user_id,notify_user_id,
         objective,cron,timezone,enabled,revision,created_at,updated_at)
      VALUES ('t','s','w','codex',17,19,'Check','0 * * * *','UTC',1,1,1,1);
    `);
    old.close();

    expect(() => new NodeDatabase(path, 'node-a')).toThrow('NODE_DATABASE_DOWNGRADE_UNSAFE');
    const unchanged = new DatabaseSync(path, { readOnly: true });
    expect(
      unchanged.prepare('SELECT version FROM node_schema_migrations ORDER BY version').all()
    ).toEqual([{ version: 13 }, { version: 14 }, { version: 15 }, { version: 16 }]);
    expect(
      unchanged.prepare('SELECT owner_user_id,notify_user_id FROM scheduled_session_tasks').get()
    ).toEqual({ owner_user_id: 17, notify_user_id: 19 });
    unchanged.close();
  });

  it('rejects a different v16 schema without modifying its ledger or columns', async () => {
    const { path } = await databasePath('unknown-v16');
    const old = obsoleteV16Database(path);
    old.exec('CREATE TABLE unknown_future (id INTEGER PRIMARY KEY) STRICT');
    old.close();
    expect(() => new NodeDatabase(path, 'node-a')).toThrow('NODE_DATABASE_VERSION_UNSUPPORTED');
    const unchanged = new DatabaseSync(path, { readOnly: true });
    expect(
      unchanged.prepare('SELECT version FROM node_schema_migrations ORDER BY version').all()
    ).toEqual([{ version: 13 }, { version: 14 }, { version: 15 }, { version: 16 }]);
    expect(
      (
        unchanged.prepare('PRAGMA table_info(scheduled_session_tasks)').all() as {
          name: string;
        }[]
      ).map((column) => column.name)
    ).toContain('notify_user_id');
    unchanged.close();
  });

  it('rebuilds every historical foreign-key table without losing business data or indexes', () => {
    const database = createV15Database();
    seedV15Relations(database);
    const before = relationSnapshot(database);

    migrate(database, [
      NODE_SCHEMA_MIGRATION_V14,
      NODE_SCHEMA_MIGRATION_V15,
      NODE_SCHEMA_MIGRATION_V16
    ]);
    expect(relationSnapshot(database)).toEqual(before);
    expect(foreignKeyList(database)).toEqual([]);
    expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all()
    ).toEqual([
      { name: 'conversation_files_conversation_updated' },
      { name: 'conversation_template_publish_jobs_status' },
      { name: 'conversation_template_publish_jobs_template' },
      { name: 'conversation_template_versions_template_status' },
      { name: 'hosted_conversations_template' },
      { name: 'hosted_conversations_user_pin_activity' },
      { name: 'scheduled_session_occurrences_recent' },
      { name: 'scheduled_session_proposals_pending' },
      { name: 'scheduled_session_tasks_due' }
    ]);

    migrate(database, [
      NODE_SCHEMA_MIGRATION_V14,
      NODE_SCHEMA_MIGRATION_V15,
      NODE_SCHEMA_MIGRATION_V16
    ]);
    expect(relationSnapshot(database)).toEqual(before);
    expect(
      database.prepare('SELECT version FROM node_schema_migrations ORDER BY version').all()
    ).toEqual([{ version: 13 }, { version: 14 }, { version: 15 }, { version: 16 }]);
    database.close();
  });

  it('upgrades an append-column terminal schema and preserves every terminal field', () => {
    const database = createV15Database();
    database.exec(`
      INSERT INTO workspaces (id,path,kind,git_summary,created_at,updated_at,preserve_git_config)
      VALUES ('terminal-workspace','/terminal-workspace','DIRECTORY',NULL,1,1,1);
      PRAGMA foreign_keys=OFF;
      ALTER TABLE terminal_sessions RENAME TO _legacy_terminal_sessions;
      CREATE TABLE terminal_sessions (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('RUNNING', 'EXITED', 'CLOSED')),
        exit_code INTEGER,
        rows INTEGER NOT NULL CHECK (rows > 0 AND rows <= 1000),
        cols INTEGER NOT NULL CHECK (cols > 0 AND cols <= 1000),
        latest_sequence INTEGER NOT NULL CHECK (latest_sequence >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL
      ) STRICT;
      INSERT INTO terminal_sessions
        (id,profile_id,state,exit_code,rows,cols,latest_sequence,created_at,updated_at,workspace_id)
      VALUES ('terminal-legacy','profile-legacy','EXITED',17,40,120,9,10,11,'terminal-workspace');
      DROP TABLE _legacy_terminal_sessions;
      PRAGMA foreign_keys=ON;
    `);

    migrate(database, [
      NODE_SCHEMA_MIGRATION_V14,
      NODE_SCHEMA_MIGRATION_V15,
      NODE_SCHEMA_MIGRATION_V16
    ]);
    expect(database.prepare('SELECT * FROM terminal_sessions').all()).toEqual([
      {
        id: 'terminal-legacy',
        workspace_id: 'terminal-workspace',
        profile_id: 'profile-legacy',
        state: 'EXITED',
        exit_code: 17,
        rows: 40,
        cols: 120,
        latest_sequence: 9,
        created_at: 10,
        updated_at: 11
      }
    ]);
    expect(
      (database.prepare('PRAGMA table_info(terminal_sessions)').all() as { name: string }[]).map(
        (column) => column.name
      )
    ).toEqual([
      'id',
      'workspace_id',
      'profile_id',
      'state',
      'exit_code',
      'rows',
      'cols',
      'latest_sequence',
      'created_at',
      'updated_at'
    ]);
    expect(foreignKeyList(database)).toEqual([]);
    database.close();
  });

  it('removes all empty obsolete tables while preserving the v15 ledger until v16 commits', () => {
    const database = createV15Database();
    for (const table of [
      'worktree_snapshots',
      'worktree_shares',
      'share_invitations',
      'share_participants',
      'share_sessions'
    ])
      database.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY) STRICT`);
    database.exec('CREATE INDEX worktree_shares_open_workspace_idx ON worktree_shares(id)');

    migrate(database, [
      NODE_SCHEMA_MIGRATION_V14,
      NODE_SCHEMA_MIGRATION_V15,
      NODE_SCHEMA_MIGRATION_V16
    ]);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('worktree_snapshots','worktree_shares','share_invitations','share_participants','share_sessions')"
        )
        .all()
    ).toEqual([]);
    expect(foreignKeyList(database)).toEqual([]);
    database.close();
  });

  it('rejects a non-empty obsolete table without changing the source database', () => {
    const database = createV15Database();
    database.exec(
      "CREATE TABLE worktree_snapshots (id TEXT PRIMARY KEY) STRICT; INSERT INTO worktree_snapshots VALUES ('snapshot-1')"
    );

    expect(() =>
      migrate(database, [
        NODE_SCHEMA_MIGRATION_V14,
        NODE_SCHEMA_MIGRATION_V15,
        NODE_SCHEMA_MIGRATION_V16
      ])
    ).toThrow('NODE_DATABASE_OBSOLETE_TABLE_NOT_EMPTY:worktree_snapshots');
    expect(
      database.prepare('SELECT version FROM node_schema_migrations ORDER BY version').all()
    ).toEqual([{ version: 13 }, { version: 14 }, { version: 15 }]);
    expect(database.prepare('SELECT * FROM worktree_snapshots').all()).toEqual([
      { id: 'snapshot-1' }
    ]);
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name LIKE '_node_v16_%'").all()
    ).toEqual([]);
    database.close();
  });

  it('upgrades the missing agent_runs reference that previously blocked Workspace removal', () => {
    const database = createV15Database();
    database.exec(`
      INSERT INTO workspaces(id,path,kind,created_at,updated_at)
      VALUES ('legacy-workspace','/legacy-workspace','DIRECTORY',1,1);
      CREATE TABLE worktree_snapshots (
        id TEXT PRIMARY KEY,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL
      ) STRICT;
    `);
    expect(() =>
      database.prepare('DELETE FROM workspaces WHERE id=?').run('legacy-workspace')
    ).toThrow('no such table: main.agent_runs');
    migrate(database);
    expect(
      database.prepare("SELECT 1 FROM sqlite_master WHERE name='worktree_snapshots'").get()
    ).toBeUndefined();
    expect(
      database.prepare('DELETE FROM workspaces WHERE id=?').run('legacy-workspace').changes
    ).toBe(1);
    expect(foreignKeyList(database)).toEqual([]);
    database.close();
  });

  it('rejects and rolls back a future migration that attempts to introduce a foreign key', () => {
    const database = new NodeDatabase(':memory:', 'future-key');
    expect(() =>
      migrate(database.raw, [
        ...NODE_SCHEMA_MIGRATIONS,
        {
          version: NODE_SCHEMA_MIGRATIONS.at(-1)!.version + 1,
          sql: 'CREATE TABLE future_key (id TEXT PRIMARY KEY,workspace_id TEXT REFERENCES workspaces(id)) STRICT',
          assert: () => undefined
        }
      ])
    ).toThrow('NODE_DATABASE_SCHEMA_INVALID:foreign_keys:future_key');
    expect(
      database.raw.prepare("SELECT 1 FROM sqlite_master WHERE name='future_key'").get()
    ).toBeUndefined();
    expect(
      database.raw.prepare('SELECT version FROM node_schema_migrations ORDER BY version').all()
    ).toEqual([
      { version: 13 },
      { version: 14 },
      { version: 15 },
      { version: 16 },
      { version: 17 },
      { version: 18 },
      { version: 19 },
      { version: 20 }
    ]);
    expect(foreignKeyList(database.raw)).toEqual([]);
    database.close();
  });

  it('checks Workspace parents and rejects reassignment of a scheduled session', () => {
    const database = new NodeDatabase(':memory:', 'parent-checks');
    expect(() =>
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: 'missing',
        workspaceId: 'missing'
      })
    ).toThrow('WORKSPACE_NOT_FOUND');
    expect(() =>
      database.saveTerminalSession({
        id: 'missing',
        workspaceId: 'missing',
        profileId: 'shell',
        state: 'RUNNING',
        exitCode: null,
        rows: 24,
        cols: 80,
        latestSequence: 0,
        createdAt: 1,
        updatedAt: 1
      })
    ).toThrow('WORKSPACE_NOT_FOUND');
    const workspace = database.saveWorkspace({
      path: '/parent-check',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: 'scheduled',
      workspaceId: workspace.id
    });
    new ScheduledSessionStore(database.raw).create({
      sessionId: 'scheduled',
      workspaceId: workspace.id,
      runner: 'codex',
      ownerUserId: 1,
      objective: 'Check',
      cron: '0 * * * *',
      timezone: 'UTC'
    });
    expect(() =>
      database.saveNativeSessionMetadata({
        runner: 'opencode',
        externalSessionId: 'scheduled',
        workspaceId: workspace.id
      })
    ).toThrow('SCHEDULE_SESSION_MISMATCH');
    expect(database.listSessionRecords(workspace.id)).toMatchObject([
      { id: 'scheduled', runner: 'codex' }
    ]);
    database.close();
  });

  it('rejects unknown tables, extra structure, extra indexes, triggers, and dangling relations before v16', () => {
    const cases = [
      {
        label: 'unknown table',
        setup: (database: DatabaseSync) =>
          database.exec('CREATE TABLE unknown_future (id INTEGER PRIMARY KEY) STRICT'),
        error: 'NODE_DATABASE_SCHEMA_INVALID:table:unknown_future'
      },
      {
        label: 'extra column',
        setup: (database: DatabaseSync) =>
          database.exec('ALTER TABLE scheduled_session_tasks ADD COLUMN future TEXT'),
        error: 'NODE_DATABASE_SCHEMA_INVALID:scheduled_session_tasks'
      },
      {
        label: 'extra index',
        setup: (database: DatabaseSync) =>
          database.exec('CREATE INDEX unexpected_workspace_index ON workspaces(path)'),
        error: 'NODE_DATABASE_SCHEMA_INVALID'
      },
      {
        label: 'trigger',
        setup: (database: DatabaseSync) =>
          database.exec(
            'CREATE TRIGGER unexpected_workspace_trigger AFTER INSERT ON workspaces BEGIN SELECT 1; END'
          ),
        error: 'NODE_DATABASE_SCHEMA_INVALID:triggers'
      },
      {
        label: 'dangling relation',
        setup: (database: DatabaseSync) => {
          database.exec('PRAGMA foreign_keys=OFF');
          database.exec(
            "INSERT INTO agent_sessions (id,workspace_id,runner,metadata) VALUES ('dangling','missing-workspace','codex','{}')"
          );
          database.exec('PRAGMA foreign_keys=ON');
        },
        error: 'NODE_DATABASE_SCHEMA_INVALID:foreign_keys'
      }
    ] as const;

    for (const testCase of cases) {
      const database = createV15Database();
      testCase.setup(database);
      expect(() =>
        migrate(database, [
          NODE_SCHEMA_MIGRATION_V14,
          NODE_SCHEMA_MIGRATION_V15,
          NODE_SCHEMA_MIGRATION_V16
        ])
      ).toThrow(testCase.error);
      expect(
        database.prepare('SELECT version FROM node_schema_migrations ORDER BY version').all()
      ).toEqual([{ version: 13 }, { version: 14 }, { version: 15 }]);
      database.close();
    }
  });

  it('rolls back a failed v16 rebuild without changing data or the migration ledger', () => {
    const database = createV15Database();
    seedV15Relations(database);
    const before = relationSnapshot(database);
    const failingV16 = {
      ...NODE_SCHEMA_MIGRATION_V16,
      assert: () => {
        throw new Error('synthetic v16 failure');
      }
    };

    expect(() =>
      migrate(database, [NODE_SCHEMA_MIGRATION_V14, NODE_SCHEMA_MIGRATION_V15, failingV16])
    ).toThrow('synthetic v16 failure');
    expect(relationSnapshot(database)).toEqual(before);
    expect(
      database.prepare('SELECT version FROM node_schema_migrations ORDER BY version').all()
    ).toEqual([{ version: 13 }, { version: 14 }, { version: 15 }]);
    expect(foreignKeyList(database).length).toBeGreaterThan(0);
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name LIKE '_node_v16_%'").all()
    ).toEqual([]);
    database.close();
  });

  it('rejects a v14 database missing a scheduled task index', async () => {
    const { path } = await databasePath('schedule-index-missing');
    const first = new NodeDatabase(path, 'node-a');
    first.raw.exec('DROP INDEX scheduled_session_tasks_due');
    first.close();
    expect(() => new NodeDatabase(path, 'node-a')).toThrow('NODE_DATABASE_SCHEMA_INVALID');
  });

  it('rejects databases older than the compatibility baseline or without a version record', async () => {
    const { path } = await databasePath('unsupported');
    const legacy = new DatabaseSync(path);
    legacy.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY) STRICT;');
    legacy.close();
    expect(() => new NodeDatabase(path, 'node-a')).toThrow('NODE_DATABASE_VERSION_UNSUPPORTED');
  });

  it.each([1, 2, 3, 4])(
    'compacts a complete v%s-v12 ledger into the v13 baseline without changing application data',
    async (firstVersion) => {
      const { path } = await databasePath(`legacy-ledger-${firstVersion}`);
      const first = new NodeDatabase(path, 'node-a');
      const workspace = first.saveWorkspace({
        path: '/legacy-workspace',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      first.raw.exec(
        'DROP TABLE model_usage_outbox; DROP TABLE scheduled_session_proposals; DROP TABLE scheduled_session_occurrences; DROP TABLE scheduled_session_tasks;'
      );
      first.raw.prepare('DELETE FROM node_schema_migrations').run();
      for (let version = firstVersion; version <= 12; version++)
        first.raw.prepare('INSERT INTO node_schema_migrations VALUES (?, 1)').run(version);
      first.close();

      const reopened = new NodeDatabase(path, 'node-a');
      expect(reopened.raw.prepare('SELECT version FROM node_schema_migrations').all()).toEqual([
        { version: 13 },
        { version: 14 },
        { version: 15 },
        { version: 16 },
        { version: 17 },
        { version: 18 },
        { version: 19 },
        { version: 20 }
      ]);
      expect(reopened.getWorkspace(workspace.id)).toMatchObject({ path: '/legacy-workspace' });
      reopened.close();
    }
  );

  it('upgrades the released v12 SQLite schema and preserves Workspace and Session records', async () => {
    const { path } = await databasePath('released-v12');
    const legacy = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    legacy.exec(
      await readFile(new URL('../fixtures/node-v12-schema.sql', import.meta.url), 'utf8')
    );
    for (let version = 4; version <= 12; version++)
      legacy.prepare('INSERT INTO node_schema_migrations VALUES (?, 1)').run(version);
    legacy
      .prepare(
        "INSERT INTO workspaces (id,path,kind,created_at,updated_at) VALUES ('w','/legacy','DIRECTORY',1,1)"
      )
      .run();
    legacy
      .prepare(
        "INSERT INTO agent_sessions (id,workspace_id,runner,metadata) VALUES ('session','w','codex','{}')"
      )
      .run();
    legacy.close();

    for (let reopen = 0; reopen < 2; reopen++) {
      const upgraded = new NodeDatabase(path, 'node-a');
      expect(upgraded.raw.prepare('SELECT version FROM node_schema_migrations').all()).toEqual([
        { version: 13 },
        { version: 14 },
        { version: 15 },
        { version: 16 },
        { version: 17 },
        { version: 18 },
        { version: 19 },
        { version: 20 }
      ]);
      expect(upgraded.getWorkspace('w')?.path).toBe('/legacy');
      expect(
        upgraded.raw.prepare("SELECT id,runner FROM agent_sessions WHERE id='session'").get()
      ).toEqual({
        id: 'session',
        runner: 'codex'
      });
      expect(upgraded.raw.prepare('PRAGMA integrity_check').get()).toEqual({
        integrity_check: 'ok'
      });
      expect(upgraded.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      upgraded.close();
    }
  });

  it('leaves the released v12 migration ledger intact when its schema is incomplete', async () => {
    const { path } = await databasePath('invalid-released-v12');
    const legacy = new DatabaseSync(path);
    legacy.exec(
      await readFile(new URL('../fixtures/node-v12-schema.sql', import.meta.url), 'utf8')
    );
    for (let version = 4; version <= 12; version++)
      legacy.prepare('INSERT INTO node_schema_migrations VALUES (?, 1)').run(version);
    legacy.exec('DROP INDEX hosted_conversations_template');
    legacy.close();

    expect(() => new NodeDatabase(path, 'node-a')).toThrow(
      'NODE_DATABASE_SCHEMA_INVALID:hosted_conversations_template'
    );
    const unchanged = new DatabaseSync(path);
    expect(
      unchanged.prepare('SELECT version FROM node_schema_migrations ORDER BY version').all()
    ).toEqual(Array.from({ length: 9 }, (_, index) => ({ version: index + 4 })));
    unchanged.close();
  });

  it('rejects a database with the correct version but an incomplete baseline schema', async () => {
    const { path } = await databasePath('invalid-baseline');
    const legacy = new DatabaseSync(path);
    legacy.exec(
      'CREATE TABLE node_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;'
    );
    legacy.prepare('INSERT INTO node_schema_migrations VALUES (13, 13)').run();
    legacy.close();
    expect(() => new NodeDatabase(path, 'node-a')).toThrow(
      'NODE_DATABASE_SCHEMA_INVALID:agent_sessions'
    );
  });

  it('creates a record on the first local setting, keeps it after unpinning, and can swap pin order', async () => {
    const database = await createDatabase('node-a');
    const workspace = database.saveWorkspace({
      path: '/workspace',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    expect(database.listSessionRecords(workspace.id)).toEqual([]);

    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: 'thread-1',
      workspaceId: workspace.id,
      customTitle: 'Session one',
      pinned: true
    });
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: 'thread-2',
      workspaceId: workspace.id,
      pinned: true
    });
    expect(
      database.listSessionRecords(workspace.id).map((record) => [record.id, record.pinOrder])
    ).toEqual([
      ['thread-2', 0],
      ['thread-1', 1]
    ]);

    database.movePinnedSession('thread-1', 'up');
    expect(
      database.listSessionRecords(workspace.id).map((record) => [record.id, record.pinOrder])
    ).toEqual([
      ['thread-1', 0],
      ['thread-2', 1]
    ]);
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: 'thread-2',
      workspaceId: workspace.id,
      pinned: false
    });
    expect(database.listSessionRecords(workspace.id)).toHaveLength(2);
    expect(
      database.getNativeSessionMetadata('codex', 'thread-2', workspace.id)?.pinOrder
    ).toBeNull();
    database.close();
  });

  it('removes a workspace and its scheduled/session/MCP children while preserving terminal history', () => {
    const database = new NodeDatabase(':memory:', 'node-workspace-removal');
    const workspaceA = database.saveWorkspace({
      id: 'workspace-a',
      path: '/workspace-a',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const workspaceB = database.saveWorkspace({
      id: 'workspace-b',
      path: '/workspace-b',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: 'session-a',
      workspaceId: workspaceA.id
    });
    database.saveNativeSessionMetadata({
      runner: 'opencode',
      externalSessionId: 'session-b',
      workspaceId: workspaceB.id
    });
    const store = new ScheduledSessionStore(database.raw);
    const taskA = store.create({
      sessionId: 'session-a',
      workspaceId: workspaceA.id,
      runner: 'codex',
      ownerUserId: 1,
      objective: 'Workspace A task',
      cron: '0 * * * *',
      timezone: 'UTC'
    });
    const taskB = store.create({
      sessionId: 'session-b',
      workspaceId: workspaceB.id,
      runner: 'opencode',
      ownerUserId: 1,
      objective: 'Workspace B task',
      cron: '0 * * * *',
      timezone: 'UTC'
    });
    store.claim(taskA.sessionId, taskA.nextRunAt!, taskA.revision);
    store.propose(taskA, 2, { objective: 'Workspace A proposal' });
    store.claim(taskB.sessionId, taskB.nextRunAt!, taskB.revision);
    database.saveTerminalSession({
      id: 'terminal-a',
      workspaceId: workspaceA.id,
      profileId: 'profile-a',
      state: 'EXITED',
      exitCode: 0,
      rows: 24,
      cols: 80,
      latestSequence: 4,
      createdAt: 1,
      updatedAt: 1
    });
    database.saveTerminalSession({
      id: 'terminal-b',
      workspaceId: workspaceB.id,
      profileId: 'profile-b',
      state: 'EXITED',
      exitCode: 0,
      rows: 24,
      cols: 80,
      latestSequence: 5,
      createdAt: 1,
      updatedAt: 1
    });
    const entry = {
      id: 'workspace-entry',
      sourceId: 'official',
      scope: 'ENTERPRISE',
      serverName: 'example/workspace',
      displayName: 'Workspace MCP',
      description: 'Test MCP',
      version: '1.0.0',
      featured: false,
      tags: ['test'] as string[],
      runtime: { transport: 'STDIO', command: 'npx', args: [] as string[] },
      createdAt: 1,
      updatedAt: 1
    } as const;
    database.saveMcpInstallation({
      targetKind: 'NODE',
      entry,
      enabled: true,
      configuration: {}
    });
    database.saveMcpInstallation({
      targetKind: 'WORKSPACE',
      targetId: workspaceA.id,
      entry,
      enabled: true,
      configuration: {}
    });
    database.saveMcpInstallation({
      targetKind: 'WORKSPACE',
      targetId: workspaceB.id,
      entry: { ...entry, id: 'workspace-entry-b', serverName: 'example/workspace-b' },
      enabled: true,
      configuration: {}
    });

    database.raw.exec(`CREATE TRIGGER fail_workspace_delete BEFORE DELETE ON workspaces
      BEGIN SELECT RAISE(ABORT,'synthetic Workspace deletion failure'); END`);
    expect(() => database.removeWorkspace(workspaceA.id)).toThrow(
      'synthetic Workspace deletion failure'
    );
    expect(database.getWorkspace(workspaceA.id)).toBeDefined();
    expect(database.getNativeSessionMetadata('codex', 'session-a', workspaceA.id)).toBeDefined();
    expect(store.getById(taskA.id)).toBeDefined();
    expect(store.recent(taskA.id)).toHaveLength(1);
    expect(store.pendingProposals(taskA.id)).toHaveLength(1);
    expect(database.getTerminalSession('terminal-a')).toMatchObject({ workspaceId: workspaceA.id });
    expect(database.listMcpInstallations('WORKSPACE', workspaceA.id)).toHaveLength(1);
    database.raw.exec('DROP TRIGGER fail_workspace_delete');
    expect(database.removeWorkspace(workspaceA.id)).toMatchObject({ id: workspaceA.id });
    expect(database.getWorkspace(workspaceA.id)).toBeUndefined();
    expect(database.getWorkspace(workspaceB.id)).toBeDefined();
    expect(database.getNativeSessionMetadata('codex', 'session-a', workspaceA.id)).toBeUndefined();
    expect(database.getNativeSessionMetadata('opencode', 'session-b', workspaceB.id)).toBeDefined();
    expect(store.getById(taskA.id)).toBeUndefined();
    expect(store.recent(taskA.id)).toEqual([]);
    expect(store.pendingProposals(taskA.id)).toEqual([]);
    expect(store.getById(taskB.id)).toBeDefined();
    expect(database.getTerminalSession('terminal-a')).toMatchObject({ workspaceId: null });
    expect(database.getTerminalSession('terminal-b')).toMatchObject({ workspaceId: workspaceB.id });
    expect(database.listMcpInstallations('WORKSPACE', workspaceA.id)).toEqual([]);
    expect(database.listMcpInstallations('WORKSPACE', workspaceB.id)).toHaveLength(1);
    expect(database.listMcpInstallations('NODE')).toHaveLength(1);
    database.close();
  });

  it('deletes a session record and all scheduled children without affecting another session', () => {
    const database = new NodeDatabase(':memory:', 'node-session-removal');
    const workspace = database.saveWorkspace({
      id: 'workspace-session-removal',
      path: '/workspace-session-removal',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: 'session-remove-a',
      workspaceId: workspace.id
    });
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: 'session-remove-b',
      workspaceId: workspace.id
    });
    const store = new ScheduledSessionStore(database.raw);
    const taskA = store.create({
      sessionId: 'session-remove-a',
      workspaceId: workspace.id,
      runner: 'codex',
      ownerUserId: 1,
      objective: 'Remove A',
      cron: '0 * * * *',
      timezone: 'UTC'
    });
    const taskB = store.create({
      sessionId: 'session-remove-b',
      workspaceId: workspace.id,
      runner: 'codex',
      ownerUserId: 1,
      objective: 'Keep B',
      cron: '0 * * * *',
      timezone: 'UTC'
    });
    store.claim(taskA.sessionId, taskA.nextRunAt!, taskA.revision);
    store.propose(taskA, 2, { objective: 'Remove A proposal' });

    expect(database.deleteSessionRecord('session-remove-a')).toBe(true);
    expect(database.deleteSessionRecord('session-remove-a')).toBe(false);
    expect(store.getById(taskA.id)).toBeUndefined();
    expect(store.recent(taskA.id)).toEqual([]);
    expect(store.pendingProposals(taskA.id)).toEqual([]);
    expect(store.getById(taskB.id)).toBeDefined();
    expect(
      database.getNativeSessionMetadata('codex', 'session-remove-b', workspace.id)
    ).toBeDefined();
    database.close();
  });

  it('rejects unsupported migration histories without applying migrations', async () => {
    for (const versions of [
      [99],
      [13, 15],
      Array.from({ length: 8 }, (_, index) => index + 4),
      Array.from({ length: 8 }, (_, index) => index + 5),
      [4, 5, 7, 8, 9, 10, 11, 12]
    ]) {
      const { path } = await databasePath(`history-${versions.join('-')}`);
      const database = new NodeDatabase(path, 'node-a');
      database.raw.prepare('DELETE FROM node_schema_migrations').run();
      for (const version of versions)
        database.raw.prepare('INSERT INTO node_schema_migrations VALUES (?, 1)').run(version);
      database.close();
      expect(() => new NodeDatabase(path, 'node-a')).toThrow(
        versions[0] === 13
          ? 'NODE_DATABASE_MIGRATION_HISTORY_INVALID'
          : 'NODE_DATABASE_VERSION_UNSUPPORTED'
      );
    }
  });

  it('rejects a baseline whose current schema is missing a required index', async () => {
    const { path } = await databasePath('missing-index');
    const database = new NodeDatabase(path, 'node-a');
    database.raw.exec('DROP INDEX hosted_conversations_template');
    database.close();
    expect(() => new NodeDatabase(path, 'node-a')).toThrow(
      'NODE_DATABASE_SCHEMA_INVALID:hosted_conversations_template'
    );
  });

  it('rejects a v13 table with intact columns but a narrower Runner constraint', async () => {
    const { path } = await databasePath('invalid-runner-constraint');
    const original = new NodeDatabase(path, 'node-a');
    original.raw.exec(`DROP TABLE runner_defaults;
      CREATE TABLE runner_defaults (
        runner TEXT PRIMARY KEY CHECK (runner IN ('mar-agent')),
        model TEXT NOT NULL, effort TEXT NOT NULL, access TEXT NOT NULL
      ) STRICT;`);
    original.close();
    expect(() => new NodeDatabase(path, 'node-a')).toThrow(
      'NODE_DATABASE_SCHEMA_INVALID:runner_defaults:runner'
    );
  });

  it('adds the terminal notification default without a separate recipient column at v15', () => {
    const database = new DatabaseSync(':memory:');
    migrate(database, [NODE_SCHEMA_MIGRATION_V14]);
    database.exec(`
      INSERT INTO workspaces (id,path,kind,created_at,updated_at)
      VALUES ('w','/schedule','DIRECTORY',1,1);
      INSERT INTO agent_sessions (id,workspace_id,runner,metadata)
      VALUES ('s','w','codex','{}');
      INSERT INTO scheduled_session_tasks
        (id,session_id,workspace_id,runner,owner_user_id,objective,cron,timezone,enabled,revision,created_at,updated_at)
      VALUES ('t','s','w','codex',17,'Check','0 * * * *','UTC',1,1,1,1);
    `);
    migrate(database, [NODE_SCHEMA_MIGRATION_V14, NODE_SCHEMA_MIGRATION_V15]);
    migrate(database, [NODE_SCHEMA_MIGRATION_V14, NODE_SCHEMA_MIGRATION_V15]);
    expect(
      database.prepare('SELECT owner_user_id,notify_on_terminal FROM scheduled_session_tasks').get()
    ).toEqual({ owner_user_id: 17, notify_on_terminal: 0 });
    expect(
      (
        database.prepare('PRAGMA table_info(scheduled_session_tasks)').all() as { name: string }[]
      ).map((column) => column.name)
    ).not.toContain('notify_user_id');
    database.close();
  });

  it('rejects a development database with the discarded recipient column', async () => {
    const { path } = await databasePath('obsolete-recipient');
    const database = new NodeDatabase(path, 'node-a');
    database.raw.exec('ALTER TABLE scheduled_session_tasks ADD COLUMN notify_user_id INTEGER;');
    database.close();
    expect(() => new NodeDatabase(path, 'node-a')).toThrow('NODE_DATABASE_SCHEMA_INVALID');
  });

  it('keeps the demo outside the production catalog and supports transactional v14 migration', () => {
    expect(NODE_SCHEMA_MIGRATIONS).not.toContain(NODE_SCHEMA_MIGRATION_DEMO);
    const database = new DatabaseSync(':memory:');
    migrate(database, []);
    const v14 = {
      version: 14,
      sql: 'CREATE TABLE future_example (id INTEGER PRIMARY KEY) STRICT;',
      assert: (raw: DatabaseSync) => {
        if (!raw.prepare("SELECT 1 FROM sqlite_master WHERE name='future_example'").get())
          throw new Error('NODE_DATABASE_SCHEMA_INVALID:future_example');
      }
    };
    expect(() =>
      migrate(database, [
        {
          ...v14,
          assert: () => {
            throw new Error('synthetic failure');
          }
        }
      ])
    ).toThrow('synthetic failure');
    expect(database.prepare('SELECT version FROM node_schema_migrations').all()).toEqual([
      { version: 13 }
    ]);
    expect(
      database.prepare("SELECT 1 FROM sqlite_master WHERE name='future_example'").get()
    ).toBeUndefined();
    migrate(database, [v14]);
    migrate(database, [v14]);
    expect(
      database.prepare('SELECT version FROM node_schema_migrations ORDER BY version').all()
    ).toEqual([{ version: 13 }, { version: 14 }]);
    expect(() => migrate(database, [{ ...v14, version: 15 }])).toThrow(
      'NODE_DATABASE_MIGRATION_CATALOG_INVALID'
    );
    database.prepare('UPDATE node_schema_migrations SET version=15 WHERE version=14').run();
    expect(() => migrate(database, [v14, { ...v14, version: 15, sql: 'SELECT 1;' }])).toThrow(
      'NODE_DATABASE_MIGRATION_HISTORY_INVALID'
    );
    database.close();
  });
});

async function databasePath(label: string): Promise<{ path: string }> {
  const directory = await mkdtemp(join(tmpdir(), `mar-node-${label}-`));
  directories.push(directory);
  return { path: join(directory, 'node-runtime.sqlite') };
}

async function createDatabase(nodeId: string): Promise<NodeDatabase> {
  const { path } = await databasePath('records');
  return new NodeDatabase(path, nodeId);
}

function createV15Database(): DatabaseSync {
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  migrate(database, [NODE_SCHEMA_MIGRATION_V14, NODE_SCHEMA_MIGRATION_V15]);
  return database;
}

function seedV15Relations(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO workspaces (id,path,kind,git_summary,created_at,updated_at,preserve_git_config)
    VALUES ('workspace-1','/workspace-1','DIRECTORY',NULL,1,1,1),
           ('workspace-2','/workspace-2','DIRECTORY',NULL,1,1,1);
    INSERT INTO agent_sessions (id,workspace_id,runner,pin_order,metadata)
    VALUES ('session-1','workspace-1','codex',NULL,'{}'),
           ('session-2','workspace-2','opencode',NULL,'{}');
    INSERT INTO conversation_template_versions
      (id,template_id,version_number,draft_revision,status,storage_key,manifest,content_hash,
       manifest_hash,file_count,total_bytes,host_policy_version,published_by_user_id,published_at,
       reference_count,mcp_config_hash)
    VALUES ('version-1','template-1',1,1,'AVAILABLE','version_1','{}','${'a'.repeat(64)}',
            '${'b'.repeat(64)}',0,0,1,7,1,1,'${'c'.repeat(64)}');
    INSERT INTO conversation_template_publish_jobs
      (id,template_id,draft_revision,stage,status,version_id,error_code,error_summary,
       requested_by_user_id,draft,created_at,updated_at)
    VALUES ('publish-1','template-1',1,'REGISTERED','SUCCEEDED','version-1',NULL,NULL,7,'{}',1,1);
    INSERT INTO hosted_conversations
      (id,user_storage_key,conversation_storage_key,client_request_id,node_id,session_id,
       template_id,template_name,active_version_id,title,status,model_id,template_deleted,
       used_bytes,max_bytes,created_at,updated_at,last_activity_at,pinned_at,title_source)
    VALUES ('conversation-1','user-1','conversation_1',NULL,'node-1','hosted-session-1',
            'template-1','Template','version-1','Title','ACTIVE','model-1',0,4,1000,1,1,1,NULL,'CUSTOM');
    INSERT INTO conversation_files
      (id,conversation_id,category,relative_path,display_name,mime_type,size,source,turn_id,item_id,created_at,updated_at)
    VALUES ('file-1','conversation-1','OUTPUT','result.txt','result.txt','text/plain',4,'AGENT',NULL,NULL,1,1);
    INSERT INTO hosted_conversation_messages
      (conversation_id,client_message_id,run_id,status,created_at,updated_at,user_text_present)
    VALUES ('conversation-1','message-1','run-1','SUCCEEDED',1,1,1);
    INSERT INTO scheduled_session_tasks
      (id,session_id,workspace_id,runner,owner_user_id,objective,cron,timezone,enabled,revision,
       next_run_at,created_at,updated_at,notify_on_terminal)
    VALUES ('task-1','session-1','workspace-1','codex',7,'Inspect','0 * * * *','UTC',1,2,3600,1,1,1);
    INSERT INTO scheduled_session_occurrences
      (id,task_id,due_at,status,code,run_id,created_at,updated_at)
    VALUES ('occurrence-1','task-1',3600,'SUCCEEDED','DONE','run-1',1,1);
    INSERT INTO scheduled_session_proposals
      (id,task_id,proposed_by_user_id,base_revision,objective,cron,timezone,status,created_at,resolved_at)
    VALUES ('proposal-1','task-1',8,2,'Inspect later',NULL,NULL,'PENDING',1,NULL);
    INSERT INTO terminal_sessions
      (id,workspace_id,profile_id,state,exit_code,rows,cols,latest_sequence,created_at,updated_at)
    VALUES ('terminal-1','workspace-1','profile-1','EXITED',0,24,80,3,1,1);
    INSERT INTO mcp_installations
      (target_kind,target_id,catalog_entry_id,server_name,display_name,version,enabled,runtime,configuration,installed_at)
    VALUES ('WORKSPACE','workspace-1','entry-1','server-1','Server 1','1.0.0',1,
            '{"transport":"STDIO","command":"npx","args":[]}','{}',1);
  `);
}

function relationSnapshot(database: DatabaseSync): Record<string, unknown> {
  return {
    workspaces: database.prepare('SELECT * FROM workspaces ORDER BY id').all(),
    sessions: database.prepare('SELECT * FROM agent_sessions ORDER BY id').all(),
    versions: database.prepare('SELECT * FROM conversation_template_versions ORDER BY id').all(),
    publishJobs: database
      .prepare('SELECT * FROM conversation_template_publish_jobs ORDER BY id')
      .all(),
    conversations: database.prepare('SELECT * FROM hosted_conversations ORDER BY id').all(),
    files: database.prepare('SELECT * FROM conversation_files ORDER BY id').all(),
    messages: database
      .prepare(
        'SELECT * FROM hosted_conversation_messages ORDER BY conversation_id, client_message_id'
      )
      .all(),
    tasks: database.prepare('SELECT * FROM scheduled_session_tasks ORDER BY id').all(),
    occurrences: database.prepare('SELECT * FROM scheduled_session_occurrences ORDER BY id').all(),
    proposals: database.prepare('SELECT * FROM scheduled_session_proposals ORDER BY id').all(),
    terminals: database.prepare('SELECT * FROM terminal_sessions ORDER BY id').all(),
    mcp: database
      .prepare('SELECT * FROM mcp_installations ORDER BY target_kind, target_id, server_name')
      .all()
  };
}

function foreignKeyList(database: DatabaseSync): readonly unknown[] {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all() as { name: string }[];
  return tables.flatMap(({ name }) =>
    database.prepare(`PRAGMA foreign_key_list("${name.replaceAll('"', '""')}")`).all()
  );
}

function obsoleteV16Database(path: string): DatabaseSync {
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  database.exec(
    `${NODE_SCHEMA_V13}
     ${NODE_SCHEMA_MIGRATION_V14.sql}
     ALTER TABLE scheduled_session_tasks
     ADD COLUMN notify_user_id INTEGER NOT NULL DEFAULT 1 CHECK (notify_user_id > 0);
     ${NODE_SCHEMA_MIGRATION_V15.sql}`
  );
  database.prepare('INSERT INTO node_schema_migrations VALUES (?, 1)').run(13);
  database.prepare('INSERT INTO node_schema_migrations VALUES (?, 1)').run(14);
  database.prepare('INSERT INTO node_schema_migrations VALUES (?, 1)').run(15);
  database.prepare('INSERT INTO node_schema_migrations VALUES (?, 1)').run(16);
  return database;
}
