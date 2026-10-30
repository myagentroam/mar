import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate, NODE_SCHEMA_MIGRATIONS } from '../../src/database.js';
import { NODE_SCHEMA_MIGRATION_V23 } from '../../src/migrations/v023.js';

function fixture() {
  const database = new DatabaseSync(':memory:');
  migrate(
    database,
    NODE_SCHEMA_MIGRATIONS.filter(({ version }) => version <= 22)
  );
  database.exec(
    "INSERT INTO workspaces (id,path,kind,created_at,updated_at) VALUES ('w','/fixture','DIRECTORY',1,1)"
  );
  const metadata = [
    { version: 1, model: 'internal-config', effort: 'high', customTitle: 'Keep title' },
    { version: 1, model: null, access: 'auto' },
    { version: 1, effort: '' },
    { version: 1, model: 'old', modelId: 'already-selected' }
  ];
  metadata.forEach((value, index) =>
    database
      .prepare(
        "INSERT INTO agent_sessions (id,workspace_id,runner,metadata) VALUES (?, 'w', 'mar-agent', ?)"
      )
      .run(`s${index}`, JSON.stringify(value))
  );
  const settings = {
    other: { model: 'unrelated' },
    runnerDefaults: {
      'mar-agent': { model: 'internal-default', effort: 'xhigh', access: 'auto' },
      codex: { model: 'codex-model', effort: 'high', access: 'on-request' },
      'claude-code': { model: null, effort: '', access: 'default' },
      opencode: { model: 'old', modelId: 'provider/selected', effort: '', access: 'default' }
    }
  };
  database.prepare('UPDATE node_settings SET settings=? WHERE id=1').run(JSON.stringify(settings));
  const snapshot = () => ({
    metadata: database.prepare('SELECT id,metadata FROM agent_sessions ORDER BY id').all(),
    settings: database.prepare('SELECT settings FROM node_settings').get(),
    version: database.prepare('SELECT max(version) AS version FROM node_schema_migrations').get()
  });
  return { database, metadata, settings, snapshot };
}

describe('Node modelId migration', () => {
  it('renames only model selection keys, preserves values and reopens idempotently', () => {
    const { database, settings, snapshot } = fixture();
    try {
      migrate(database);
      expect(snapshot().metadata.map((row) => JSON.parse(String(row.metadata)))).toEqual([
        { version: 1, modelId: 'internal-config', effort: 'high', customTitle: 'Keep title' },
        { version: 1, modelId: null, access: 'auto' },
        { version: 1, effort: '' },
        { version: 1, modelId: 'already-selected' }
      ]);
      expect(JSON.parse(String(snapshot().settings?.settings))).toEqual({
        other: settings.other,
        runnerDefaults: {
          'mar-agent': { modelId: 'internal-default', effort: 'xhigh', access: 'auto' },
          codex: { modelId: 'codex-model', effort: 'high', access: 'on-request' },
          'claude-code': { modelId: null, effort: '', access: 'default' },
          opencode: { modelId: 'provider/selected', effort: '', access: 'default' }
        }
      });
      const migrated = snapshot();
      migrate(database);
      expect(snapshot()).toEqual(migrated);
      expect(migrated.version).toEqual({ version: 23 });
    } finally {
      database.close();
    }
  });

  it('rolls back all JSON changes and the version if the migration fails', () => {
    const { database, snapshot } = fixture();
    try {
      const original = snapshot();
      expect(() =>
        migrate(database, [
          ...NODE_SCHEMA_MIGRATIONS.filter(({ version }) => version <= 22),
          {
            ...NODE_SCHEMA_MIGRATION_V23,
            sql: `${NODE_SCHEMA_MIGRATION_V23.sql}\nINSERT INTO missing_model_id_table VALUES (1);`
          }
        ])
      ).toThrow();
      expect(snapshot()).toEqual(original);
      migrate(database);
      expect(snapshot().version).toEqual({ version: 23 });
    } finally {
      database.close();
    }
  });
});
