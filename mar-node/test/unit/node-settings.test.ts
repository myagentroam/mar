import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { migrate, NODE_SCHEMA_MIGRATIONS, NodeDatabase } from '../../src/database.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

it('migrates existing Git policies and Runner defaults into settings without retaining legacy storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-node-settings-'));
  directories.push(root);
  const path = join(root, 'node.sqlite');
  const legacy = new DatabaseSync(path);
  migrate(
    legacy,
    NODE_SCHEMA_MIGRATIONS.filter(({ version }) => version < 21)
  );
  legacy.exec(`
    INSERT INTO workspaces (id,path,kind,created_at,updated_at,preserve_git_config)
    VALUES ('preserve','/preserve','DIRECTORY',1,2,1), ('inject','/inject','DIRECTORY',3,4,0);
    INSERT INTO runner_defaults (runner,model,effort,access) VALUES
      ('codex','retained-model','high','full-access'), ('opencode','provider/model','','default');
  `);
  legacy.close();
  for (let iteration = 0; iteration < 2; iteration++) {
    const database = new NodeDatabase(path, 'node-settings');
    try {
      expect(database.getNodeSettings()).toEqual({
        runnerDefaults: {
          codex: { modelId: 'retained-model', effort: 'high', access: 'full-access' },
          opencode: { modelId: 'provider/model', effort: '', access: 'default' }
        }
      });
      expect(database.getRunnerDefaults()).toEqual([
        { runner: 'codex', modelId: 'retained-model', effort: 'high', access: 'full-access' },
        { runner: 'opencode', modelId: 'provider/model', effort: '', access: 'default' }
      ]);
      for (const [id, preserveGitConfig] of [
        ['preserve', true],
        ['inject', false]
      ] as const) {
        expect(database.getWorkspace(id)?.settings).toEqual({
          git: { preserveGitConfig, includeParentRepository: true }
        });
        expect(database.getWorkspace(id)?.preserveGitConfig).toBe(preserveGitConfig);
      }
      expect(
        database.raw.prepare("SELECT 1 FROM sqlite_master WHERE name='runner_defaults'").get()
      ).toBeUndefined();
      const columns = database.raw
        .prepare('PRAGMA table_info(workspaces)')
        .all()
        .map((column) => column.name);
      expect(columns).not.toContain('preserve_git_config');
      expect(columns).not.toContain('include_parent_repository');
      expect(
        database.raw
          .prepare('SELECT created_at,updated_at FROM workspaces WHERE id=?')
          .get('inject')
      ).toEqual({ created_at: 3, updated_at: 4 });
    } finally {
      database.close();
    }
  }
});

it('patches only owned settings and keeps new defaults and unrelated configuration across reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-settings-patch-'));
  directories.push(root);
  const path = join(root, 'node.sqlite');
  const database = new NodeDatabase(path, 'node-settings');
  const workspace = database.saveWorkspace({ path: '/new', kind: 'DIRECTORY', gitSummary: null });
  expect(workspace.settings).toEqual({
    git: { preserveGitConfig: false, includeParentRepository: true }
  });
  expect(database.getRunnerDefaults()).toEqual([]);
  database.raw.prepare('UPDATE node_settings SET settings=? WHERE id=1').run(
    JSON.stringify({
      future: { enabled: false, extra: 'keep' },
      runnerDefaults: { codex: { modelId: 'old', effort: 'low', access: 'auto' } }
    })
  );
  database.raw
    .prepare('UPDATE workspaces SET settings=json_patch(settings, ?) WHERE id=?')
    .run(
      JSON.stringify({ future: { enabled: false }, git: { futurePolicy: 'keep' } }),
      workspace.id
    );
  database.saveRunnerDefaults({
    runner: 'codex',
    modelId: 'new',
    effort: 'high',
    access: 'full-access'
  });
  database.saveRunnerDefaults({
    runner: 'opencode',
    modelId: 'second',
    effort: '',
    access: 'default'
  });
  database.setWorkspaceGitPolicy(workspace.id, true, false);
  database.setWorkspaceGitPolicy(workspace.id, false);
  database.saveWorkspace({ path: workspace.path, kind: 'DIRECTORY', gitSummary: null });
  expect(() => database.raw.exec("UPDATE node_settings SET settings='[]'")).toThrow();
  expect(() => database.raw.exec("UPDATE workspaces SET settings='[]'")).toThrow();
  database.close();
  const reopened = new NodeDatabase(path, 'node-settings');
  try {
    expect(reopened.getNodeSettings()).toEqual({
      future: { enabled: false, extra: 'keep' },
      runnerDefaults: {
        codex: { modelId: 'new', effort: 'high', access: 'full-access' },
        opencode: { modelId: 'second', effort: '', access: 'default' }
      }
    });
    expect(reopened.getWorkspace(workspace.id)?.settings).toEqual({
      future: { enabled: false },
      git: { preserveGitConfig: false, includeParentRepository: false, futurePolicy: 'keep' }
    });
    expect(reopened.getWorkspace(workspace.id)?.includeParentRepository).toBe(false);
    expect(reopened.getRunnerDefaults()).toEqual([
      { runner: 'codex', modelId: 'new', effort: 'high', access: 'full-access' },
      { runner: 'opencode', modelId: 'second', effort: '', access: 'default' }
    ]);
  } finally {
    reopened.close();
  }
});

it('rolls back settings DDL, copied data and migration history together on failure', () => {
  const database = new DatabaseSync(':memory:');
  const previous = NODE_SCHEMA_MIGRATIONS.filter(({ version }) => version < 21);
  const settingsMigration = NODE_SCHEMA_MIGRATIONS.find(({ version }) => version === 21)!;
  try {
    migrate(database, previous);
    database.exec("INSERT INTO runner_defaults VALUES ('codex','keep','high','auto')");
    expect(() =>
      migrate(database, [
        ...previous,
        {
          ...settingsMigration,
          assert: () => {
            throw new Error('TEST_SETTINGS_MIGRATION_FAILURE');
          }
        }
      ])
    ).toThrow('TEST_SETTINGS_MIGRATION_FAILURE');
    expect(
      database.prepare("SELECT 1 FROM sqlite_master WHERE name='node_settings'").get()
    ).toBeUndefined();
    expect(database.prepare('SELECT model FROM runner_defaults').get()).toEqual({ model: 'keep' });
    expect(
      database.prepare('SELECT MAX(version) AS version FROM node_schema_migrations').get()
    ).toEqual({ version: 20 });
    expect(
      database
        .prepare('PRAGMA table_info(workspaces)')
        .all()
        .some((column) => column.name === 'settings')
    ).toBe(false);
    migrate(database);
    const before = database.prepare('SELECT settings FROM node_settings').get();
    migrate(database);
    expect(database.prepare('SELECT settings FROM node_settings').get()).toEqual(before);
    expect(JSON.parse(String(before?.settings)).runnerDefaults.codex.modelId).toBe('keep');
  } finally {
    database.close();
  }
});
