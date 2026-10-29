import {
  withMysqlTransaction,
  lockMysqlUsers,
  lockMysqlWorkspace,
  lockMysqlSkillSource,
  lockMysqlTemplateVersion
} from '../../src/mysql-reference-store.js';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CORE_MYSQL_BASELINE_VERSION,
  CORE_MYSQL_MIGRATIONS,
  CORE_MYSQL_SCHEMA,
  CORE_MYSQL_SCHEMA_V9,
  CORE_MYSQL_SCHEMA_V17
} from '../../src/mysql-schema.js';
import { MYSQL_MIGRATION_DEMO } from '../../src/mysql-migration-demo.js';
import { MODEL_USAGE_MIGRATION, MODEL_USAGE_SQL } from '../../src/model-usage-schema.js';
import {
  MYSQL_SESSION_SHARES_SCHEMA,
  MYSQL_SESSION_SHARES_CURRENT_SCHEMA
} from '../../src/mysql-session-shares-schema.js';
import {
  normalizeMysqlTableDefinition,
  mysqlSchemaWithoutForeignKeys,
  removeMysqlForeignKeys,
  assertMysqlNoForeignKeys,
  validateMysqlReferences,
  validateMysqlSchema
} from '../../src/mysql-schema-support.js';

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

describe('Core MySQL schema', () => {
  it('upgrades the usage query index once without changing the released usage migration', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 31)!;
    let definition = MODEL_USAGE_SQL;
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SHOW CREATE TABLE')) return [[{ 'Create Table': definition }], []];
      expect(sql).toContain('ALTER TABLE');
      definition = CORE_MYSQL_SCHEMA.model_usage_records!;
      return [[], []];
    });
    await migration.up({ query } as never);
    await migration.up({ query } as never);
    expect(query.mock.calls.filter(([sql]) => sql.startsWith('ALTER'))).toHaveLength(1);
    expect(definition).toContain(
      'KEY `model_usage_user_time` (`user_id`,`purpose`,`ended_at`,`source_key`,`started_at`,`received_at`)'
    );
    expect(MODEL_USAGE_MIGRATION.checksum).toBe(
      '570dbac3ec8f2b2f167ef8a044a63464ae717f0b224e373b8c29562f0f87a115'
    );
  });

  it.each(['before', 'after'] as const)(
    'retries the usage index migration when a DDL failure is reported %s commit',
    async (failure) => {
      const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 31)!;
      let definition = MODEL_USAGE_SQL;
      let fail = true;
      const query = vi.fn(async (sql: string) => {
        if (sql.startsWith('SHOW CREATE TABLE')) return [[{ 'Create Table': definition }], []];
        if (fail) {
          fail = false;
          if (failure === 'after') definition = CORE_MYSQL_SCHEMA.model_usage_records!;
          throw new Error('DDL_CONNECTION_LOST');
        }
        definition = CORE_MYSQL_SCHEMA.model_usage_records!;
        return [[], []];
      });
      await expect(migration.up({ query } as never)).rejects.toThrow('DDL_CONNECTION_LOST');
      await migration.up({ query } as never);
      expect(definition).toBe(CORE_MYSQL_SCHEMA.model_usage_records);
      expect(query.mock.calls.filter(([sql]) => sql.startsWith('ALTER'))).toHaveLength(
        failure === 'after' ? 1 : 2
      );
    }
  );

  it('rejects an unexpected usage schema before changing its index', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 31)!;
    const query = vi.fn(async () => [
      [{ 'Create Table': MODEL_USAGE_SQL.replace('varchar(32)', 'varchar(64)') }],
      []
    ]);
    await expect(migration.up({ query } as never)).rejects.toThrow(
      'SERVER_DATABASE_SCHEMA_MISMATCH'
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('cleans only Push clients transactionally and rolls back a failed attempt for retry', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 32)!;
    const pushClients = new Set(['legacy-client-a', 'legacy-client-b']);
    const businessRows = new Set(['notification-1', 'user-1']);
    let snapshot: Set<string> | undefined;
    let failAfterDelete = true;
    const query = vi.fn(async (sql: string) => {
      if (sql === 'START TRANSACTION') snapshot = new Set(pushClients);
      else if (sql === 'ROLLBACK') {
        pushClients.clear();
        snapshot?.forEach((client) => pushClients.add(client));
        snapshot = undefined;
      } else if (sql === 'COMMIT') snapshot = undefined;
      else throw new Error(`Unexpected migration query: ${sql}`);
      return [[], []];
    });
    const execute = vi.fn(async (sql: string) => {
      expect(sql).toBe('DELETE FROM web_push_clients');
      pushClients.clear();
      if (failAfterDelete) {
        failAfterDelete = false;
        throw new Error('PUSH_CLIENT_DELETE_FAILED');
      }
      return [{ affectedRows: 2 }, []];
    });
    const connection = { query, execute };

    await expect(migration.up(connection as never)).rejects.toThrow('PUSH_CLIENT_DELETE_FAILED');
    expect(pushClients).toEqual(new Set(['legacy-client-a', 'legacy-client-b']));
    expect(businessRows).toEqual(new Set(['notification-1', 'user-1']));
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['START TRANSACTION', 'ROLLBACK']);

    await migration.up(connection as never);
    expect(pushClients.size).toBe(0);
    expect(businessRows).toEqual(new Set(['notification-1', 'user-1']));
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'START TRANSACTION',
      'ROLLBACK',
      'START TRANSACTION',
      'COMMIT'
    ]);
  });

  it('adds nullable notification session groups once and validates the upgraded table on retries', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 33)!;
    const currentDefinition = CORE_MYSQL_SCHEMA.workbench_notifications!;
    let hasSessionGroup = false;
    let definition = currentDefinition.replace(
      "  `session_group` enum('MAIN','CHILD') DEFAULT NULL,\n",
      ''
    );
    const notificationRows = [{ id: 'existing-notification', read_at: 500, expires_at: 10_000 }];
    const originalRows = notificationRows.map((row) => ({ ...row }));
    const alter =
      "ALTER TABLE workbench_notifications ADD COLUMN session_group enum('MAIN','CHILD') DEFAULT NULL";
    const execute = vi.fn(async (sql: string) => {
      if (
        sql ===
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='workbench_notifications' AND COLUMN_NAME='session_group'"
      )
        return [hasSessionGroup ? [{ COLUMN_NAME: 'session_group' }] : [], []];
      if (sql === alter) {
        expect(hasSessionGroup).toBe(false);
        hasSessionGroup = true;
        definition = currentDefinition;
        return [[], []];
      }
      throw new Error(`Unexpected migration statement: ${sql}`);
    });
    const query = vi.fn(async (sql: string) => {
      expect(sql).toBe('SHOW CREATE TABLE `workbench_notifications`');
      return [[{ 'Create Table': definition }], []];
    });

    await migration.up({ execute, query } as never);
    await migration.up({ execute, query } as never);

    expect(migration.name).toBe('notification_session_groups');
    expect(hasSessionGroup).toBe(true);
    expect(definition).toBe(currentDefinition);
    expect(execute.mock.calls.map(([sql]) => sql)).toEqual([
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='workbench_notifications' AND COLUMN_NAME='session_group'",
      alter,
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='workbench_notifications' AND COLUMN_NAME='session_group'"
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(notificationRows).toEqual(originalRows);
  });

  it('adds recoverable share passwords once and validates retries without rewriting the prior migration', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 30)!;
    let added = false;
    const execute = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT'))
        return [added ? [{ COLUMN_NAME: 'encrypted_password' }] : [], []];
      expect(sql).toContain('ALTER TABLE session_shares ADD COLUMN encrypted_password');
      added = true;
      return [[], []];
    });
    const connection = {
      execute,
      query: vi.fn(async () => [
        [
          {
            'Create Table': added
              ? MYSQL_SESSION_SHARES_CURRENT_SCHEMA.session_shares
              : MYSQL_SESSION_SHARES_SCHEMA.session_shares
          }
        ],
        []
      ])
    };
    await migration.up(connection as never, 'enterprise');
    await migration.up(connection as never, 'enterprise');
    expect(execute.mock.calls.filter(([sql]) => sql.startsWith('ALTER'))).toHaveLength(1);
    expect(connection.query).toHaveBeenCalledTimes(2);
    expect(MYSQL_SESSION_SHARES_CURRENT_SCHEMA.session_shares).toBe(
      CORE_MYSQL_SCHEMA.session_shares
    );
    expect(CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 29)!.checksum).toBe(
      createHash('sha256').update(JSON.stringify(MYSQL_SESSION_SHARES_SCHEMA)).digest('hex')
    );
    connection.query.mockResolvedValueOnce([
      [{ 'Create Table': MYSQL_SESSION_SHARES_SCHEMA.session_shares }],
      []
    ]);
    await expect(migration.up(connection as never, 'enterprise')).rejects.toThrow();
  });
  it('adds and validates Session shares repeatably without rewriting the installation baseline', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 29)!;
    const connection = schemaConnection();
    await migration.up(connection as never, 'enterprise');
    await migration.up(connection as never, 'enterprise');
    const table = connection.definitions.get('session_shares')!;
    expect(table).toBe(MYSQL_SESSION_SHARES_SCHEMA.session_shares);
    expect(table).not.toContain('FOREIGN KEY');
    expect(table).toContain('`expires_at` bigint DEFAULT NULL');
    expect(table).toContain('`password_hash`');
    expect(table).toContain('`access_credential`');
    expect(CORE_MYSQL_SCHEMA_V9.session_shares).toBeUndefined();
  });
  it('adds and validates the multi-client Push table repeatably without physical foreign keys', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 27)!;
    const connection = schemaConnection();
    await migration.up(connection as never, 'enterprise');
    await migration.up(connection as never, 'enterprise');
    const table = connection.definitions.get('web_push_clients')!;
    expect(table).toBe(CORE_MYSQL_SCHEMA.web_push_clients);
    expect(table).toContain('UNIQUE KEY `uq_web_push_endpoint` (`endpoint_hash`)');
    expect(table).toContain('UNIQUE KEY `uq_web_push_token` (`token_hash`)');
    expect(table).not.toContain('FOREIGN KEY');
    expect(table).not.toMatch(/UNIQUE KEY[^\n]+\(`user_id`\)/u);
  });

  it('removes only retired deployment keys transactionally and repeats safely', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 26)!;
    const settings = new Map([
      ['marctl_management_key', 'old-hash'],
      ['marmgr_management_key', 'legacy-hash'],
      ['mail_smtp', 'unchanged']
    ]);
    const connection = {
      execute: vi.fn(async (sql: string) => {
        expect(sql).toBe(
          "DELETE FROM system_settings WHERE setting_key IN ('marctl_management_key','marmgr_management_key')"
        );
        settings.delete('marctl_management_key');
        settings.delete('marmgr_management_key');
        return [[], []];
      }),
      query: vi.fn(async (_sql: string) => [[], []]),
      release: vi.fn()
    };
    await migration.up(connection, 'enterprise');
    await migration.up(connection, 'enterprise');
    expect([...settings]).toEqual([['mail_smtp', 'unchanged']]);
    expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([
      'START TRANSACTION',
      'COMMIT',
      'START TRANSACTION',
      'COMMIT'
    ]);
  });

  it('rolls back failed deployment-key cleanup and permits retry', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 26)!;
    const connection = {
      execute: vi.fn().mockRejectedValueOnce(new Error('write failed')).mockResolvedValue([[], []]),
      query: vi.fn(async (_sql: string) => [[], []]),
      release: vi.fn()
    };
    await expect(migration.up(connection, 'enterprise')).rejects.toThrow('write failed');
    expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([
      'START TRANSACTION',
      'ROLLBACK'
    ]);
    await migration.up(connection, 'enterprise');
    expect(connection.query.mock.calls.at(-1)).toEqual(['COMMIT']);
  });

  it('adds conversation usage repeatably without changing an existing auxiliary model', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 25)!;
    let columnExists = false;
    const rows = [{ id: 'legacy', conversationModel: undefined as boolean | undefined }];
    const connection = {
      execute: vi.fn(async (sql: string) => {
        if (sql.startsWith('SELECT'))
          return [columnExists ? [{ COLUMN_NAME: 'conversation_model' }] : [], []];
        columnExists = true;
        for (const row of rows) row.conversationModel = true;
        return [[], []];
      }),
      query: vi.fn(async () => [[], []]),
      release: vi.fn()
    };
    await migration.up(connection, 'personal');
    expect(rows[0]?.conversationModel).toBe(true);
    rows[0]!.conversationModel = false;
    await migration.up(connection, 'personal');
    expect(rows[0]?.conversationModel).toBe(false);
    expect(connection.execute.mock.calls.filter(([sql]) => sql.startsWith('ALTER'))).toHaveLength(
      1
    );
    expect(CORE_MYSQL_SCHEMA.mar_agent_models).toContain(
      "`conversation_model` tinyint(1) NOT NULL DEFAULT '1'"
    );
  });
  it('adds the node upgrade snapshot repeatably and rejects incompatible columns', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 36)!;
    let column: Record<string, string> | undefined;
    const connection = {
      execute: vi.fn(async (sql: string) => {
        if (sql.startsWith('SELECT')) return [column === undefined ? [] : [column], []];
        column = { COLUMN_NAME: 'upgrade_snapshot', COLUMN_TYPE: 'json', IS_NULLABLE: 'YES' };
        return [[], []];
      })
    };
    await migration.up(connection as never, 'personal');
    await migration.up(connection as never, 'personal');
    expect(connection.execute.mock.calls.filter(([sql]) => sql.startsWith('ALTER'))).toHaveLength(
      1
    );
    expect(CORE_MYSQL_SCHEMA.nodes).toContain('`upgrade_snapshot` json DEFAULT NULL');
    column = { COLUMN_NAME: 'upgrade_snapshot', COLUMN_TYPE: 'text', IS_NULLABLE: 'YES' };
    await expect(migration.up(connection as never, 'personal')).rejects.toThrow(
      'SERVER_DATABASE_SCHEMA_INVALID'
    );
  });
  it('adds subagent usage disabled by default without overwriting later changes on retry', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ name }) => name === 'subagent_model_usage')!;
    let columnExists = false;
    const rows = [{ id: 'legacy', subagentModel: undefined as boolean | undefined }];
    const connection = {
      execute: vi.fn(async (sql: string) => {
        if (sql.startsWith('SELECT'))
          return [
            columnExists
              ? [
                  {
                    COLUMN_NAME: 'subagent_model',
                    COLUMN_TYPE: 'tinyint(1)',
                    IS_NULLABLE: 'NO',
                    COLUMN_DEFAULT: '0'
                  }
                ]
              : [],
            []
          ];
        columnExists = true;
        for (const row of rows) row.subagentModel = false;
        return [[], []];
      }),
      query: vi.fn(async () => [[], []]),
      release: vi.fn()
    };
    await migration.up(connection, 'personal');
    expect(rows[0]?.subagentModel).toBe(false);
    rows[0]!.subagentModel = true;
    await migration.up(connection, 'personal');
    expect(rows[0]?.subagentModel).toBe(true);
    expect(connection.execute.mock.calls.filter(([sql]) => sql.startsWith('ALTER'))).toHaveLength(
      1
    );
    expect(CORE_MYSQL_SCHEMA.mar_agent_models).toContain(
      "`subagent_model` tinyint(1) NOT NULL DEFAULT '0'"
    );
  });
  it('rejects an incompatible pre-existing subagent model column', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 35)!;
    const connection = {
      execute: vi.fn(async () => [
        [
          {
            COLUMN_NAME: 'subagent_model',
            COLUMN_TYPE: 'tinyint(1)',
            IS_NULLABLE: 'NO',
            COLUMN_DEFAULT: '1'
          }
        ],
        []
      ])
    };
    await expect(migration.up(connection as never, 'personal')).rejects.toThrow(
      'SERVER_DATABASE_SCHEMA_INVALID'
    );
  });
  it.each(['personal', 'enterprise'] as const)(
    'preserves the management key while migrating its setting name repeatably for %s',
    async (edition) => {
      const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 15)!;
      const original = { hash: 'a'.repeat(64), updatedAt: 123 };
      const settings = new Map([['marmgr_management_key', original]]);
      const connection = {
        execute: vi.fn(async (sql: string) => {
          if (sql.startsWith('SELECT'))
            return [[...settings.keys()].map((setting_key) => ({ setting_key })), []];
          const value = settings.get('marmgr_management_key');
          if (value !== undefined) {
            settings.set('marctl_management_key', value);
            settings.delete('marmgr_management_key');
          }
          return [[], []];
        }),
        query: vi.fn(async (_sql: string) => [[], []]),
        release: vi.fn()
      };
      await migration.up(connection, edition);
      await migration.up(connection, edition);
      expect([...settings]).toEqual([['marctl_management_key', original]]);
      expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([
        'START TRANSACTION',
        'COMMIT',
        'START TRANSACTION',
        'COMMIT'
      ]);
    }
  );

  it('rolls back management-key migration conflicts and write failures', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 15)!;
    for (const conflict of [true, false]) {
      const connection = {
        execute: vi.fn(async (sql: string) => {
          if (sql.startsWith('SELECT'))
            return [
              conflict
                ? [
                    { setting_key: 'marmgr_management_key' },
                    { setting_key: 'marctl_management_key' }
                  ]
                : [],
              []
            ];
          throw new Error('KEY_MIGRATION_WRITE_FAILED');
        }),
        query: vi.fn(async (_sql: string) => [[], []]),
        release: vi.fn()
      };
      await expect(migration.up(connection)).rejects.toThrow(
        conflict ? 'MARCTL_MANAGEMENT_KEY_MIGRATION_CONFLICT' : 'KEY_MIGRATION_WRITE_FAILED'
      );
      expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([
        'START TRANSACTION',
        'ROLLBACK'
      ]);
      if (conflict) expect(connection.execute).toHaveBeenCalledTimes(1);
    }
  });

  it.each([true, false])(
    'removes the high-density column repeatably when initially present=%s',
    async (initiallyPresent) => {
      const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 19)!;
      expect(migration.name).toBe('remove_high_density_compaction');
      let present = initiallyPresent;
      const execute = vi.fn(async (sql: string) => {
        if (sql.startsWith('SELECT COLUMN_NAME'))
          return [present ? [{ COLUMN_NAME: 'high_density_compaction' }] : [], []];
        expect(sql).toBe('ALTER TABLE mar_agent_models DROP COLUMN high_density_compaction');
        present = false;
        return [[], []];
      });
      await migration.up({ execute } as never);
      await migration.up({ execute } as never);
      expect(execute.mock.calls.filter(([sql]) => sql.startsWith('ALTER TABLE'))).toHaveLength(
        initiallyPresent ? 1 : 0
      );
      expect(CORE_MYSQL_SCHEMA.mar_agent_models).not.toContain('high_density_compaction');
      expect(CORE_MYSQL_SCHEMA_V9.mar_agent_models).toContain('high_density_compaction');
      expect(CORE_MYSQL_SCHEMA_V17.mar_agent_models).toContain('high_density_compaction');
    }
  );

  it('propagates a high-density column DDL failure and permits the same migration to retry', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 19)!;
    const failure = new Error('COLUMN_DROP_FAILED');
    const execute = vi
      .fn()
      .mockResolvedValueOnce([[{ COLUMN_NAME: 'high_density_compaction' }], []])
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce([[{ COLUMN_NAME: 'high_density_compaction' }], []])
      .mockResolvedValueOnce([[], []]);
    await expect(migration.up({ execute } as never)).rejects.toBe(failure);
    await migration.up({ execute } as never);
    expect(execute).toHaveBeenLastCalledWith(
      'ALTER TABLE mar_agent_models DROP COLUMN high_density_compaction'
    );
  });

  it('drops the legacy Responses encoding column only when present and repeats safely', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 16)!;
    let present = true;
    const connection = {
      execute: vi.fn(async (sql: string) => {
        if (sql.includes('information_schema'))
          return [present ? [{ COLUMN_NAME: 'responses_encoding' }] : [], []];
        present = false;
        return [[], []];
      }),
      query: vi.fn(async (_sql: string) => [[], []]),
      release: vi.fn()
    };

    await migration.up(connection);
    await migration.up(connection);

    expect(
      connection.execute.mock.calls.filter(([sql]) => sql.includes('information_schema'))
    ).toHaveLength(2);
    expect(connection.execute.mock.calls.filter(([sql]) => sql.startsWith('ALTER TABLE'))).toEqual([
      ['ALTER TABLE mar_agent_models DROP COLUMN responses_encoding']
    ]);
  });

  it('propagates a failed legacy Responses encoding column drop', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 16)!;
    const failure = new Error('RESPONSES_ENCODING_DROP_FAILED');
    const connection = {
      execute: vi.fn(async (sql: string) => {
        if (sql.includes('information_schema'))
          return [[{ COLUMN_NAME: 'responses_encoding' }], []];
        throw failure;
      }),
      query: vi.fn(async (_sql: string) => [[], []]),
      release: vi.fn()
    };

    await expect(migration.up(connection)).rejects.toBe(failure);
    expect(connection.execute.mock.calls).toHaveLength(2);
  });

  it('adds Workspace secret ownership in one repeatable ALTER and validates the target schema', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 17)!;
    const targetSchema = CORE_MYSQL_SCHEMA_V17.environment_secrets!;
    let workspaceColumnPresent = false;
    const connection = {
      execute: vi.fn(async (sql: string) => {
        if (sql.includes('information_schema.COLUMNS'))
          return [workspaceColumnPresent ? [{ COLUMN_NAME: 'workspace_id' }] : [], []];
        if (sql.startsWith('ALTER TABLE')) workspaceColumnPresent = true;
        return [[], []];
      }),
      query: vi.fn(async (sql: string) => {
        expect(sql).toBe('SHOW CREATE TABLE `environment_secrets`');
        return [[{ 'Create Table': targetSchema }], []];
      })
    };

    await migration.up(connection as never);
    await migration.up(connection as never);

    const alterStatements = connection.execute.mock.calls.filter(([sql]) =>
      sql.startsWith('ALTER TABLE')
    );
    expect(alterStatements).toHaveLength(1);
    expect(alterStatements[0]?.[0]).toContain('DROP CHECK environment_secrets_exact_owner');
    expect(alterStatements[0]?.[0]).toContain(
      "MODIFY scope enum('PERSONAL','ORGANIZATION','NODE','WORKSPACE') NOT NULL"
    );
    expect(alterStatements[0]?.[0]).toContain(
      'ADD COLUMN workspace_id varchar(128) DEFAULT NULL AFTER node_id'
    );
    expect(alterStatements[0]?.[0]).toContain(
      'ADD CONSTRAINT environment_secrets_workspace_fk FOREIGN KEY (workspace_id)'
    );
    expect(alterStatements[0]?.[0]).toContain(
      'ADD CONSTRAINT environment_secrets_exact_owner CHECK'
    );
    expect(connection.query).toHaveBeenCalledTimes(2);
  });

  it('rejects a v17 migration target whose SHOW CREATE TABLE does not match the catalog', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 17)!;
    const connection = {
      execute: vi.fn(async (sql: string) => {
        if (sql.includes('information_schema.COLUMNS'))
          return [[{ COLUMN_NAME: 'workspace_id' }], []];
        return [[], []];
      }),
      query: vi.fn(async () => [
        [{ 'Create Table': 'CREATE TABLE `environment_secrets` (`id` int)' }],
        []
      ])
    };

    await expect(migration.up(connection as never)).rejects.toThrow(
      'SERVER_DATABASE_SCHEMA_MISMATCH'
    );
  });

  it('adds standard service tiers repeatably and backfills legacy Fast transactionally', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 13)!;
    let added = false;
    const connection = {
      execute: vi.fn(async (sql: string) => {
        if (sql.includes('information_schema'))
          return [added ? [{ COLUMN_NAME: 'service_tier' }] : [], []];
        if (sql.startsWith('ALTER TABLE')) added = true;
        return [[], []];
      }),
      query: vi.fn(async (_sql: string) => [[], []]),
      release: vi.fn()
    };
    await migration.up(connection);
    await migration.up(connection);
    expect(
      connection.execute.mock.calls.filter(([sql]) => sql.startsWith('ALTER TABLE'))
    ).toHaveLength(1);
    expect(connection.execute.mock.calls.filter(([sql]) => sql.startsWith('UPDATE'))).toHaveLength(
      2
    );
    expect(connection.execute.mock.calls.find(([sql]) => sql.startsWith('UPDATE'))?.[0]).toContain(
      'service_tier IS NULL'
    );
    expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([
      'START TRANSACTION',
      'COMMIT',
      'START TRANSACTION',
      'COMMIT'
    ]);
    expect(CORE_MYSQL_SCHEMA_V9.mar_agent_models).not.toContain('service_tier');
    expect(CORE_MYSQL_SCHEMA_V17.mar_agent_models).toContain(
      "'flex','priority','fast','ultrafast'"
    );
  });

  it('rolls back a failed service-tier backfill and leaves the additive DDL retryable', async () => {
    const migration = CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 13)!;
    const connection = {
      execute: vi.fn(async (sql: string) => {
        if (sql.includes('information_schema')) return [[{ COLUMN_NAME: 'service_tier' }], []];
        throw new Error('BACKFILL_FAILED');
      }),
      query: vi.fn(async (_sql: string) => [[], []]),
      release: vi.fn()
    };
    await expect(migration.up(connection)).rejects.toThrow('BACKFILL_FAILED');
    expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([
      'START TRANSACTION',
      'ROLLBACK'
    ]);
  });

  it('freezes the complete common schema as Core v9', () => {
    expect(CORE_MYSQL_BASELINE_VERSION).toBe(9);
    expect(CORE_MYSQL_SCHEMA_V9.workbench_notifications).toContain(
      "enum('run','approval','plan','user-input')"
    );
    expect(CORE_MYSQL_SCHEMA.workbench_notifications).toContain(
      "enum('run','approval','plan','user-input','schedule','agent')"
    );
    expect(CORE_MYSQL_SCHEMA.workbench_notifications).toContain(
      "`session_group` enum('MAIN','CHILD') DEFAULT NULL"
    );
    expect(CORE_MYSQL_MIGRATIONS.map(({ version }) => version)).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
      33, 34, 35, 36
    ]);
    expect(CORE_MYSQL_SCHEMA.mail_templates).toContain('`kind` enum');
    expect(CORE_MYSQL_SCHEMA.mail_deliveries).toContain('`payload_hash` char(64)');
    expect(CORE_MYSQL_MIGRATIONS[8]?.name).toBe('workspace_environment_secrets');
    expect(CORE_MYSQL_MIGRATIONS[0]?.name).toBe('core_schema_v9');
    expect(CORE_MYSQL_MIGRATIONS[0]?.checksum).toBe(
      '266c5e07c949c69ed2eedbb885eedae2e64134d6490cec50f87ab71e75b33b56'
    );
    expect(CORE_MYSQL_MIGRATIONS[0]?.checksum).toBe(
      createHash('sha256').update(JSON.stringify(CORE_MYSQL_SCHEMA_V9)).digest('hex')
    );

    const names = new Set(Object.keys(CORE_MYSQL_SCHEMA));
    expect(names.has('users')).toBe(true);
    expect(names.has('audit_events')).toBe(true);
    expect(names.has('organizations')).toBe(false);
    expect(names.has('resource_grants')).toBe(false);
    expect(names.has('audit_conversation_payloads')).toBe(false);
    for (const ddl of Object.values(CORE_MYSQL_SCHEMA))
      for (const match of ddl.matchAll(/REFERENCES `([^`]+)`/gu))
        expect(names.has(match[1]!)).toBe(true);
  });

  it('creates and validates every Core v9 table idempotently', async () => {
    const database = schemaConnection();
    const baseline = CORE_MYSQL_MIGRATIONS[0]!;

    await baseline.up({ query: database.query } as never);
    await baseline.up({ query: database.query } as never);

    expect([...database.definitions.keys()].sort()).toEqual(
      Object.keys(CORE_MYSQL_SCHEMA_V9).sort()
    );
    expect(database.query.mock.calls.filter(([sql]) => sql.startsWith('CREATE TABLE')).length).toBe(
      Object.keys(CORE_MYSQL_SCHEMA_V9).length * 2
    );
  });

  it('refreshes the built-in notification templates through the v12 migration', async () => {
    const execute = vi.fn(async () => undefined);
    await CORE_MYSQL_MIGRATIONS[3]!.up({ execute } as never);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('UPDATE mail_templates SET subject=?,body=?'),
      expect.arrayContaining(['MyAgentRoam通知：{{title}}', '{{message}}'])
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('UPDATE mail_templates SET subject=?,body=?'),
      expect.arrayContaining(['MyAgentRoam notification: {{title}}', '{{message}}'])
    );
  });

  it('preserves the frozen model baseline while projecting the v34 settings storage', () => {
    expect(CORE_MYSQL_SCHEMA.workspaces).toContain('`group_name` varchar(128) DEFAULT NULL');
    expect(CORE_MYSQL_SCHEMA_V9.mar_agent_models).toContain(
      "`high_density_compaction` tinyint(1) NOT NULL DEFAULT '0'"
    );
    expect(CORE_MYSQL_SCHEMA.mar_agent_models).not.toContain('high_density_compaction');
    expect(CORE_MYSQL_SCHEMA_V9.mar_agent_models).toContain(
      "`fast_mode` tinyint(1) NOT NULL DEFAULT '0'"
    );
    for (const column of [
      'fast_mode',
      'service_tier',
      'hosted_web_search',
      'responses_transport',
      'responses_previous_response_id'
    ]) {
      expect(CORE_MYSQL_SCHEMA_V17.mar_agent_models).toContain(`\`${column}\``);
      expect(CORE_MYSQL_SCHEMA.mar_agent_models).not.toContain(`\`${column}\``);
    }
    expect(CORE_MYSQL_SCHEMA_V9.system_settings).toContain('`setting_key` varchar(128)');
    expect(CORE_MYSQL_SCHEMA.system_settings).toContain('`setting_key` varchar(191)');
    expect(CORE_MYSQL_SCHEMA.mar_agent_models).toContain(
      "`owner_type` enum('PERSONAL','ORGANIZATION') NOT NULL"
    );
    expect(CORE_MYSQL_SCHEMA_V9.mar_agent_models).toContain('`responses_encoding`');
    expect(CORE_MYSQL_SCHEMA.mar_agent_models).not.toContain('`responses_encoding`');
    expect(CORE_MYSQL_SCHEMA).toHaveProperty('mar_agent_image_models');
    expect(CORE_MYSQL_SCHEMA).toHaveProperty('user_mar_agent_image_model_orders');
    expect(CORE_MYSQL_SCHEMA).toHaveProperty('user_mar_agent_model_orders');
  });

  it('keeps the early Demo Migration isolated from the executable catalog', async () => {
    expect(MYSQL_MIGRATION_DEMO.version).toBeLessThan(CORE_MYSQL_BASELINE_VERSION);
    expect(CORE_MYSQL_MIGRATIONS).not.toContain(MYSQL_MIGRATION_DEMO);
    const query = vi.fn(async () => [[], []]);
    const execute = vi.fn(async () => [[], []]);

    await MYSQL_MIGRATION_DEMO.up({ query, execute } as never);

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('CREATE TABLE IF NOT EXISTS `mysql_migration_demo`')
    );
    expect(query).toHaveBeenNthCalledWith(2, 'START TRANSACTION');
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO `mysql_migration_demo`')
    );
    expect(query).toHaveBeenNthCalledWith(3, 'COMMIT');
  });

  it('rolls back failed Demo Migration data work and propagates the error', async () => {
    const failure = new Error('DEMO_WRITE_FAILED');
    const query = vi.fn(async () => [[], []]);
    const execute = vi.fn(async () => {
      throw failure;
    });

    await expect(MYSQL_MIGRATION_DEMO.up({ query, execute } as never)).rejects.toBe(failure);
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('does not ignore incompatible existing tables', async () => {
    const query = vi.fn(async () => [[{ 'Create Table': 'CREATE TABLE `wrong` (id int)' }], []]);
    await expect(
      validateMysqlSchema({ query }, { users: CORE_MYSQL_SCHEMA.users! })
    ).rejects.toThrow('SERVER_DATABASE_SCHEMA_MISMATCH');
  });

  it('ignores only table auto-increment counters and definition ordering', () => {
    expect(
      normalizeMysqlTableDefinition(
        'CREATE TABLE `x` (\n  `id` int\n) ENGINE=InnoDB AUTO_INCREMENT=42'
      )
    ).toBe(normalizeMysqlTableDefinition('CREATE TABLE `x` (\n  `id` int\n) ENGINE=InnoDB'));
    expect(
      normalizeMysqlTableDefinition('CREATE TABLE `x` (\n  `id` bigint\n) ENGINE=InnoDB')
    ).not.toBe(normalizeMysqlTableDefinition('CREATE TABLE `x` (\n  `id` int\n) ENGINE=InnoDB'));
  });

  it('normalizes redundant outer parentheses that MySQL adds to altered checks', () => {
    const expected = `CREATE TABLE \`x\` (
      CONSTRAINT \`x_owner\` CHECK (((\`owner_type\` = _utf8mb4'PERSONAL') and (\`owner_user_id\` is not null)) or ((\`owner_type\` = _utf8mb4'ORGANIZATION') and (\`owner_user_id\` is null)))
    ) ENGINE=InnoDB`;
    const altered = `CREATE TABLE \`x\` (
      CONSTRAINT \`x_owner\` CHECK ((((\`owner_type\` = _utf8mb4'PERSONAL') and (\`owner_user_id\` is not null)) or ((\`owner_type\` = _utf8mb4'ORGANIZATION') and (\`owner_user_id\` is null))))
    ) ENGINE=InnoDB`;
    expect(normalizeMysqlTableDefinition(altered)).toBe(normalizeMysqlTableDefinition(expected));
  });
});

describe('Explicit MySQL references', () => {
  const released = {
    users: `CREATE TABLE \`users\` (
  \`id\` bigint NOT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB`,
    user_sessions: `CREATE TABLE \`user_sessions\` (
  \`user_id\` bigint NOT NULL,
  KEY \`user_fk\` (\`user_id\`),
  CONSTRAINT \`user_fk\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB`
  };
  function connection(
    options: { orphan?: boolean; failDdl?: boolean; wrongStructure?: boolean } = {}
  ) {
    const definitions = new Map(Object.entries(released));
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SHOW CREATE')) {
        const name = /`([^`]+)`/u.exec(sql)![1]!;
        return [
          [
            {
              'Create Table':
                options.wrongStructure && name === 'users'
                  ? 'CREATE TABLE users (bad int)'
                  : definitions.get(name)
            }
          ],
          []
        ];
      }
      if (sql.includes('AS orphan')) return [options.orphan ? [{ orphan: 1 }] : [], []];
      if (sql.includes('TABLE_CONSTRAINTS')) {
        const keys = definitions.get('user_sessions')!.includes('FOREIGN KEY')
          ? [{ TABLE_NAME: 'user_sessions', CONSTRAINT_NAME: 'user_fk' }]
          : [];
        return [keys, []];
      }
      if (sql.startsWith('ALTER')) {
        if (options.failDdl) throw new Error('DDL_FAILED');
        definitions.set('user_sessions', mysqlSchemaWithoutForeignKeys(released).user_sessions!);
        return [[], []];
      }
      throw new Error('UNEXPECTED_QUERY');
    });
    return { definitions, query };
  }

  it('preserves released catalogs and keeps current schemas free of physical foreign keys', () => {
    expect(CORE_MYSQL_MIGRATIONS.find(({ version }) => version === 18)?.name).toBe(
      'explicit_mysql_references'
    );
    for (const sql of Object.values(CORE_MYSQL_SCHEMA)) expect(sql).not.toContain('FOREIGN KEY');
    expect(CORE_MYSQL_SCHEMA_V17.user_sessions).toContain('FOREIGN KEY');
    expect(mysqlSchemaWithoutForeignKeys(released).user_sessions).toContain('KEY `user_fk`');
    expect(mysqlSchemaWithoutForeignKeys(released).user_sessions).not.toContain(',\n)');
  });

  it('removes only existing owned constraints and safely resumes partial DDL', async () => {
    const database = connection();
    await removeMysqlForeignKeys(database, released);
    await removeMysqlForeignKeys(database, released);
    await assertMysqlNoForeignKeys(database);
    expect(database.query.mock.calls.filter(([sql]) => sql.startsWith('ALTER'))).toEqual([
      ['ALTER TABLE `user_sessions` DROP FOREIGN KEY `user_fk`']
    ]);
    expect(database.query.mock.calls.flat().join(' ')).not.toContain('FOREIGN_KEY_CHECKS');
  });

  it.each([{ orphan: true }, { wrongStructure: true }])(
    'rejects broken data or structure before any DDL: %j',
    async (options) => {
      const database = connection(options);
      await expect(removeMysqlForeignKeys(database, released)).rejects.toThrow(
        /SERVER_DATABASE_(REFERENCE_INVALID|SCHEMA_MISMATCH)/
      );
      expect(database.query.mock.calls.some(([sql]) => sql.startsWith('ALTER'))).toBe(false);
    }
  );

  it('rejects undeclared constraints before changing the schema', async () => {
    const database = connection();
    database.definitions.set(
      'user_sessions',
      released.user_sessions.replace('CONSTRAINT `user_fk`', 'CONSTRAINT `unexpected`')
    );
    await expect(removeMysqlForeignKeys(database, released)).rejects.toThrow(
      'SERVER_DATABASE_SCHEMA_MISMATCH'
    );
    expect(database.query.mock.calls.some(([sql]) => sql.startsWith('ALTER'))).toBe(false);
  });

  it('propagates DDL failures and rejects physical keys or orphan references at startup', async () => {
    await expect(removeMysqlForeignKeys(connection({ failDdl: true }), released)).rejects.toThrow(
      'DDL_FAILED'
    );
    await expect(assertMysqlNoForeignKeys(connection())).rejects.toThrow(
      'SERVER_DATABASE_FOREIGN_KEYS_UNSUPPORTED'
    );
    await expect(validateMysqlReferences(connection({ orphan: true }), released)).rejects.toThrow(
      'SERVER_DATABASE_REFERENCE_INVALID'
    );
  });
});

describe('MySQL reference transactions', () => {
  it('locks sorted unique parents before the write and commits on the same connection', async () => {
    const events: string[] = [];
    const execute = vi.fn(async (_sql: string, values: unknown[] = []) => {
      events.push('parents');
      return [values.map((id) => ({ id })), []];
    });
    const connection = {
      execute,
      beginTransaction: async () => {
        events.push('begin');
      },
      commit: async () => {
        events.push('commit');
      },
      rollback: vi.fn(),
      release: () => {
        events.push('release');
      }
    };
    const pool = { getConnection: async () => connection };
    await withMysqlTransaction(pool as never, async (held) => {
      await lockMysqlUsers(held, [9, null, 2, 9, undefined]);
      expect(held).toBe(connection);
      events.push('write');
    });
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('ORDER BY id FOR SHARE'), [2, 9]);
    expect(events).toEqual(['begin', 'parents', 'write', 'commit', 'release']);
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it('rejects a missing user before writing and rolls back then releases', async () => {
    const connection = {
      execute: vi.fn(async () => [[], []]),
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn()
    };
    const write = vi.fn();
    await expect(
      withMysqlTransaction({ getConnection: async () => connection } as never, async (held) => {
        await lockMysqlUsers(held, [7]);
        write();
      })
    ).rejects.toThrow('USER_NOT_FOUND');
    expect(write).not.toHaveBeenCalled();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched workspace placement, disabled Skill sources and unrelated template versions', async () => {
    await expect(
      lockMysqlWorkspace(
        { execute: async () => [[{ workspace_id: 'w1', node_id: 'wrong' }], []] } as never,
        'w1',
        'n1'
      )
    ).rejects.toThrow('WORKSPACE_NOT_FOUND');
    await expect(
      lockMysqlSkillSource({ execute: async () => [[{ id: 's1', enabled: 0 }], []] } as never, 's1')
    ).rejects.toThrow('SKILL_SOURCE_DISABLED');
    const execute = vi.fn(async () => [[], []]);
    await expect(lockMysqlTemplateVersion({ execute } as never, 'v1', 't1')).rejects.toThrow(
      'CONVERSATION_TEMPLATE_VERSION_NOT_FOUND'
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('id=? AND template_id=? FOR SHARE'),
      ['v1', 't1']
    );
  });
});
