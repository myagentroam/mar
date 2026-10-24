import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  CORE_MYSQL_BASELINE_VERSION,
  CORE_MYSQL_MIGRATIONS,
  CORE_MYSQL_SCHEMA,
  CORE_MYSQL_SCHEMA_V9,
  validateCoreMysqlDatabase
} from '../../packages/server-core/src/mysql-schema.js';
import { validateMysqlSchema } from '../../packages/server-core/src/mysql-schema-support.js';
import {
  ENTERPRISE_MYSQL_BASELINE_VERSION,
  ENTERPRISE_MYSQL_MIGRATIONS,
  ENTERPRISE_MYSQL_SCHEMA,
  ENTERPRISE_MYSQL_SCHEMA_V4,
  validateEnterpriseMysqlDatabase
} from '../../ee/server/src/mysql/enterprise-migrations.js';
import { MYSQL_MIGRATION_DEMO } from '../../packages/server-core/src/mysql-migration-demo.js';

function schemaConnection() {
  const definitions = new Map<string, string>();
  const query = vi.fn(async (sql: string) => {
    const create = /^CREATE TABLE IF NOT EXISTS `([^`]+)`/u.exec(sql);
    if (create) {
      definitions.set(create[1]!, sql.replace(' IF NOT EXISTS', ''));
      return [[], []];
    }
    const name = /^SHOW CREATE TABLE `([^`]+)`/u.exec(sql)?.[1];
    return [[{ 'Create Table': definitions.get(name ?? '') }], []];
  });
  return { definitions, query };
}

describe.each([
  ['Core', validateCoreMysqlDatabase],
  ['Enterprise', validateEnterpriseMysqlDatabase]
] as const)('%s Session share startup references', (_edition, validate) => {
  it.each([
    { reference: 'valid', owner: 42, node: 'share-node', workspace: 'share-workspace' },
    { reference: 'missing owner', owner: 43, node: 'share-node', workspace: 'share-workspace' },
    { reference: 'missing Node', owner: 42, node: 'missing-node', workspace: 'share-workspace' },
    {
      reference: 'missing Workspace',
      owner: 42,
      node: 'share-node',
      workspace: 'missing-workspace'
    },
    {
      reference: 'Workspace on another Node',
      owner: 42,
      node: 'share-node',
      workspace: 'other-workspace'
    }
  ])('validates $reference share references against relational fixtures', async (share) => {
    const fixture = new DatabaseSync(':memory:');
    try {
      fixture.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY);
        CREATE TABLE nodes (id TEXT PRIMARY KEY);
        CREATE TABLE workspaces (workspace_id TEXT, node_id TEXT, PRIMARY KEY (node_id, workspace_id));
        CREATE TABLE session_shares (user_id INTEGER, node_id TEXT, workspace_id TEXT);
        INSERT INTO users VALUES (42);
        INSERT INTO nodes VALUES ('share-node'), ('other-node');
        INSERT INTO workspaces VALUES ('other-workspace', 'other-node');
      `);
      // Keep the Workspace present when its Node is missing to isolate the Node predicate.
      fixture
        .prepare('INSERT INTO workspaces VALUES (?, ?)')
        .run('share-workspace', share.reference === 'missing Node' ? 'missing-node' : 'share-node');
      fixture
        .prepare('INSERT INTO session_shares VALUES (?, ?, ?)')
        .run(share.owner, share.node, share.workspace);
      const query = vi.fn(async (sql: string) => {
        const table = /^SHOW CREATE TABLE `([^`]+)`/u.exec(sql)?.[1];
        if (table)
          return [
            [{ 'Create Table': { ...CORE_MYSQL_SCHEMA, ...ENTERPRISE_MYSQL_SCHEMA }[table] }],
            []
          ];
        // Execute the production share query, not a precomputed orphan result.
        // The MySQL integration suite separately covers the real startup boundary.
        return [sql.includes('FROM session_shares') ? fixture.prepare(sql).all() : [], []];
      });
      const validation = validate({ query, execute: vi.fn(), release: vi.fn() });
      if (share.reference === 'valid') {
        await expect(validation).resolves.toBeUndefined();
      } else {
        await expect(validation).rejects.toThrow('SERVER_DATABASE_REFERENCE_INVALID');
      }
    } finally {
      fixture.close();
    }
  });
});

it.each([21, 22, 23])(
  'rolls back model configuration migration v%s on failure',
  async (version) => {
    const migration = CORE_MYSQL_MIGRATIONS.find((entry) => entry.version === version)!;
    const query = vi.fn(async () => [[], []]);
    const execute = vi.fn(async () => {
      throw new Error('TEST_MIGRATION_FAILURE');
    });
    await expect(migration.up({ query, execute } as never)).rejects.toThrow(
      'TEST_MIGRATION_FAILURE'
    );
    expect(query.mock.calls).toEqual([['START TRANSACTION'], ['ROLLBACK']]);
    expect(execute).toHaveBeenCalledTimes(1);
  }
);

it('rolls back managed identity retirement and does not drop its table when DML fails', async () => {
  const up = ENTERPRISE_MYSQL_MIGRATIONS.find(({ version }) => version === 9)!.up;
  const query = vi.fn(async (_sql: string) => [[], []]);
  const execute = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT TABLE_NAME')) return [[{ TABLE_NAME: 'server_managed_nodes' }], []];
    if (sql.includes('UPDATE nodes')) throw new Error('FIXTURE_RETIREMENT_FAILED');
    return [[], []];
  });
  await expect(up({ query, execute, release: vi.fn() })).rejects.toThrow(
    'FIXTURE_RETIREMENT_FAILED'
  );
  expect(query.mock.calls.map(([sql]) => sql)).toEqual(['START TRANSACTION', 'ROLLBACK']);
});

it('can retry committed identity retirement when the table drop fails', async () => {
  const up = ENTERPRISE_MYSQL_MIGRATIONS.find(({ version }) => version === 9)!.up;
  let dropFails = true;
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('DROP TABLE') && dropFails) {
      dropFails = false;
      throw new Error('FIXTURE_DROP_FAILED');
    }
    return [[], []];
  });
  const execute = vi.fn(async (sql: string) =>
    sql.startsWith('SELECT TABLE_NAME') ? [[{ TABLE_NAME: 'server_managed_nodes' }], []] : [[], []]
  );
  const connection = { query, execute, release: vi.fn() };
  await expect(up(connection)).rejects.toThrow('FIXTURE_DROP_FAILED');
  await expect(up(connection)).resolves.toBeUndefined();
  expect(query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(2);
  expect(query.mock.calls.filter(([sql]) => sql.startsWith('DROP TABLE'))).toHaveLength(2);
});

describe('Server MySQL installation baselines', () => {
  it('preserves the shared Core v9 baseline and appends the scheduled notification migration', async () => {
    expect(CORE_MYSQL_BASELINE_VERSION).toBe(9);
    expect(CORE_MYSQL_MIGRATIONS.map(({ version }) => version)).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32
    ]);
    expect(CORE_MYSQL_MIGRATIONS[2]?.name).toBe('mail_templates_and_deliveries');
    expect(CORE_MYSQL_MIGRATIONS[3]?.name).toBe('mail_template_notification_titles');
    expect(CORE_MYSQL_MIGRATIONS[0]?.name).toBe('core_schema_v9');
    expect(CORE_MYSQL_MIGRATIONS[0]?.checksum).toBe(
      '266c5e07c949c69ed2eedbb885eedae2e64134d6490cec50f87ab71e75b33b56'
    );
    expect(CORE_MYSQL_MIGRATIONS[0]?.checksum).toBe(
      createHash('sha256').update(JSON.stringify(CORE_MYSQL_SCHEMA_V9)).digest('hex')
    );
    const notificationSql =
      "ALTER TABLE workbench_notifications MODIFY kind enum('run','approval','plan','user-input','schedule') NOT NULL";
    expect(CORE_MYSQL_MIGRATIONS[1]?.name).toBe('scheduled_session_notifications');
    expect(CORE_MYSQL_MIGRATIONS[1]?.checksum).toBe(
      createHash('sha256').update(notificationSql).digest('hex')
    );
    expect(CORE_MYSQL_MIGRATIONS[6]?.name).toBe('marctl_management_key');
    expect(CORE_MYSQL_MIGRATIONS[7]?.name).toBe('remove_responses_encoding');
    const execute = vi.fn(async () => undefined);
    await CORE_MYSQL_MIGRATIONS[1]?.up({ execute });
    expect(execute).toHaveBeenCalledWith(notificationSql);
    expect(CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 19)?.name).toBe(
      'remove_high_density_compaction'
    );
    expect(CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 22)?.name).toBe(
      'responses_websocket_only_continuation'
    );
    expect(CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 26)?.name).toBe(
      'remove_marctl_management_key'
    );
    expect(CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 27)?.name).toBe(
      'web_push_clients'
    );
    expect(CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 28)?.name).toBe(
      'notification_channels'
    );
    expect(CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 29)?.name).toBe(
      'session_shares'
    );
    expect(CORE_MYSQL_MIGRATIONS.at(-1)?.name).toBe('mobile_only_web_push_clients');
    expect(CORE_MYSQL_SCHEMA).toHaveProperty('session_shares');
    expect(CORE_MYSQL_SCHEMA.mar_agent_models).not.toContain('high_density_compaction');
    expect(CORE_MYSQL_SCHEMA).toHaveProperty('users');
    expect(CORE_MYSQL_SCHEMA).not.toHaveProperty('organizations');
    expect(CORE_MYSQL_SCHEMA).not.toHaveProperty('resource_grants');
  });

  it('keeps Enterprise v4 immutable and appends root-scope migrations', () => {
    expect(ENTERPRISE_MYSQL_BASELINE_VERSION).toBe(4);
    expect(ENTERPRISE_MYSQL_MIGRATIONS.map(({ version }) => version)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(ENTERPRISE_MYSQL_MIGRATIONS[0]?.name).toBe('enterprise_schema_v4');
    expect(ENTERPRISE_MYSQL_MIGRATIONS[0]?.minimumCoreVersion).toBe(9);
    expect(ENTERPRISE_MYSQL_MIGRATIONS[0]?.checksum).toBe(
      'ddef90086c86c6eb18012d4f15a7d740aa2345974f3278ab6ee00e7e068a8ad5'
    );
    expect(ENTERPRISE_MYSQL_MIGRATIONS[0]?.checksum).toBe(
      createHash('sha256').update(JSON.stringify(ENTERPRISE_MYSQL_SCHEMA_V4)).digest('hex')
    );
    expect(ENTERPRISE_MYSQL_MIGRATIONS.at(-1)?.minimumCoreVersion).toBe(19);
    for (const sql of Object.values(ENTERPRISE_MYSQL_SCHEMA))
      expect(sql).not.toContain('FOREIGN KEY');
    expect(ENTERPRISE_MYSQL_SCHEMA).toHaveProperty('organizations');
    expect(ENTERPRISE_MYSQL_SCHEMA).toHaveProperty('resource_grants');
    expect(ENTERPRISE_MYSQL_SCHEMA.audit_conversation_payloads).toContain(
      '`user_message` mediumtext'
    );
    expect(ENTERPRISE_MYSQL_SCHEMA).not.toHaveProperty('users');
    expect(ENTERPRISE_MYSQL_SCHEMA).not.toHaveProperty('workspaces');
    expect(ENTERPRISE_MYSQL_SCHEMA).not.toHaveProperty('server_managed_nodes');
    expect(ENTERPRISE_MYSQL_SCHEMA.resource_grants).toContain("'IMAGE_MODEL'");
    expect(ENTERPRISE_MYSQL_SCHEMA.resource_grants).not.toContain('grant_authority');
    expect(ENTERPRISE_MYSQL_SCHEMA.resource_grants).not.toContain("'ENTERPRISE'");
    for (const ddl of Object.values(ENTERPRISE_MYSQL_SCHEMA)) {
      for (const match of ddl.matchAll(/REFERENCES `([^`]+)`/gu))
        expect(
          Object.hasOwn(ENTERPRISE_MYSQL_SCHEMA, match[1]!) ||
            Object.hasOwn(CORE_MYSQL_SCHEMA, match[1]!)
        ).toBe(true);
    }
  });

  it('creates and validates all Enterprise v4 tables on repeat runs', async () => {
    const database = schemaConnection();
    const baseline = ENTERPRISE_MYSQL_MIGRATIONS[0]!;

    await baseline.up({ query: database.query } as never);
    await baseline.up({ query: database.query } as never);

    expect([...database.definitions.keys()].sort()).toEqual(
      Object.keys(ENTERPRISE_MYSQL_SCHEMA_V4).sort()
    );
    expect(database.query.mock.calls.filter(([sql]) => sql.startsWith('CREATE TABLE')).length).toBe(
      Object.keys(ENTERPRISE_MYSQL_SCHEMA_V4).length * 2
    );
  });

  it('projects activated enterprise data to root organization in one transaction', async () => {
    const query = vi.fn(async () => [[], []]);
    const execute = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT ever_activated')) return [[{ ever_activated: 1 }], []];
      if (sql.includes("setting_key='mar_agent_credentials'")) return [[], []];
      if (sql.includes('AS legacy_count')) return [[{ legacy_count: 1 }], []];
      if (sql.startsWith('SELECT id FROM organizations')) return [[{ id: 1 }], []];
      return [[], []];
    });

    await ENTERPRISE_MYSQL_MIGRATIONS[1]!.up({ query, execute } as never);

    expect(query).toHaveBeenNthCalledWith(1, 'START TRANSACTION');
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE skill_sources SET scope=?'),
      ['ORGANIZATION', 1, null, 'ORGANIZATION:1:']
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("target_key='ORGANIZATION:1' WHERE target_type='ENTERPRISE'")
    );
    const preflightSql = execute.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(preflightSql).toContain(
      'BINARY target.repository_identity=BINARY legacy.repository_identity'
    );
    expect(preflightSql).toContain('BINARY target.skill_path=BINARY legacy.skill_path');
    expect(preflightSql).toContain('BINARY target.server_name=BINARY legacy.server_name');
    expect(query).toHaveBeenLastCalledWith('COMMIT');
  });

  it('does not require a fixed admin for an empty unactivated enterprise database', async () => {
    const query = vi.fn(async () => [[], []]);
    const execute = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT ever_activated')) return [[{ ever_activated: 0 }], []];
      if (sql.includes("setting_key='mar_agent_credentials'")) return [[], []];
      if (sql.includes('AS legacy_count')) return [[{ legacy_count: 0 }], []];
      return [[], []];
    });

    await ENTERPRISE_MYSQL_MIGRATIONS[1]!.up({ query, execute } as never);

    expect(execute.mock.calls.some(([sql]) => String(sql).includes("username='admin'"))).toBe(
      false
    );
    expect(query).toHaveBeenLastCalledWith('COMMIT');
  });

  it('rolls back conflicting root grant projections before schema changes', async () => {
    const query = vi.fn(async () => [[], []]);
    const execute = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT ever_activated')) return [[{ ever_activated: 1 }], []];
      if (sql.includes("setting_key='mar_agent_credentials'")) return [[], []];
      if (sql.includes('AS legacy_count')) return [[{ legacy_count: 1 }], []];
      if (sql.startsWith('SELECT id FROM organizations')) return [[{ id: 1 }], []];
      if (sql.startsWith('SELECT enterprise_grant.id')) return [[{ id: 'conflict' }], []];
      return [[], []];
    });

    await expect(ENTERPRISE_MYSQL_MIGRATIONS[1]!.up({ query, execute } as never)).rejects.toThrow(
      'RESOURCE_GRANT_SCOPE_MIGRATION_CONFLICT'
    );
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('rolls back catalog ownership collisions before updating legacy rows', async () => {
    const query = vi.fn(async () => [[], []]);
    const execute = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT ever_activated')) return [[{ ever_activated: 1 }], []];
      if (sql.includes("setting_key='mar_agent_credentials'")) return [[], []];
      if (sql.includes('AS legacy_count')) return [[{ legacy_count: 1 }], []];
      if (sql.startsWith('SELECT id FROM organizations')) return [[{ id: 1 }], []];
      if (sql.includes('FROM skill_sources legacy')) return [[{ id: 'duplicate-source' }], []];
      return [[], []];
    });

    await expect(ENTERPRISE_MYSQL_MIGRATIONS[1]!.up({ query, execute } as never)).rejects.toThrow(
      'CATALOG_SCOPE_MIGRATION_CONFLICT'
    );
    expect(execute.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE skill_sources'))).toBe(
      false
    );
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('keeps the Core Demo Migration out of both runtime catalogs', async () => {
    expect(MYSQL_MIGRATION_DEMO.version).toBeLessThan(CORE_MYSQL_BASELINE_VERSION);
    expect(CORE_MYSQL_MIGRATIONS).not.toContain(MYSQL_MIGRATION_DEMO);
    expect(ENTERPRISE_MYSQL_MIGRATIONS).not.toContain(MYSQL_MIGRATION_DEMO);
  });

  it('rejects incompatible existing Enterprise tables rather than masking them', async () => {
    const query = vi.fn(async () => [[{ 'Create Table': 'CREATE TABLE `wrong` (id int)' }], []]);
    await expect(
      validateMysqlSchema({ query }, { organizations: ENTERPRISE_MYSQL_SCHEMA.organizations! })
    ).rejects.toThrow('SERVER_DATABASE_SCHEMA_MISMATCH');
  });
});
