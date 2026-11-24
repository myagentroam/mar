import { expect, test } from '@playwright/test';
import mysql from 'mysql2/promise';
import {
  MODEL_CONTEXT_GC_MODE_MIGRATION,
  MODEL_SETTINGS_MIGRATION
} from '../../packages/server-core/src/model-settings-migration.js';
import type { MysqlMigrationConnection } from '../../packages/server-core/src/mysql-migration-contracts.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from './support/playwright-test-database.js';

test('model GC settings migrate once without changing effective modes or unrelated settings', async () => {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-model-gc`);
  await createPlaywrightTestDatabase(target);
  const connection = await mysql.createConnection(target.databaseUrl);
  const migration = connection as unknown as MysqlMigrationConnection;
  try {
    await connection.query(
      'CREATE TABLE system_settings (setting_key varchar(191) PRIMARY KEY, setting_value json NOT NULL, updated_at bigint NOT NULL)'
    );
    await connection.query('CREATE TABLE mar_agent_models (id varchar(128) PRIMARY KEY)');
    const models = {
      enabled: [{ gcEnabled: true }, 'auto'],
      disabled: [{ gcEnabled: false }, 'off'],
      unspecified: [{}, 'auto'],
      thought: [{ gcEnabled: false, contextGcMode: 'with_thought' }, 'with_thought'],
      current: [{ contextGcMode: 'off' }, 'off']
    } as const;
    for (const [id, [fields]] of Object.entries(models)) {
      await connection.execute('INSERT INTO mar_agent_models VALUES (?)', [id]);
      await connection.execute('INSERT INTO system_settings VALUES (?,?,42)', [
        `mar_agent_model_config:${id}`,
        JSON.stringify({ version: 1, unifiedCompact: true, ...fields })
      ]);
    }
    await connection.execute('INSERT INTO system_settings VALUES (?,?,42)', [
      'unrelated',
      JSON.stringify({ gcEnabled: false })
    ]);
    const read = async () => {
      const [rows] = await connection.execute<mysql.RowDataPacket[]>(
        'SELECT setting_key, setting_value, updated_at FROM system_settings ORDER BY setting_key'
      );
      return Object.fromEntries(
        rows.map(({ setting_key, setting_value, updated_at }) => [
          setting_key,
          {
            value: typeof setting_value === 'string' ? JSON.parse(setting_value) : setting_value,
            updatedAt: Number(updated_at)
          }
        ])
      );
    };
    const before = await read();
    await expect(
      MODEL_CONTEXT_GC_MODE_MIGRATION.up({
        query: migration.query.bind(connection),
        execute: async (sql, values) => {
          const result = await migration.execute.call(connection, sql, values);
          if (sql.startsWith('UPDATE system_settings')) throw new Error('INJECTED_GC_FAILURE');
          return result;
        },
        release: () => undefined
      })
    ).rejects.toThrow('INJECTED_GC_FAILURE');
    expect(await read()).toEqual(before);
    await MODEL_CONTEXT_GC_MODE_MIGRATION.up(migration);
    const after = await read();
    for (const [id, [, contextGcMode]] of Object.entries(models))
      expect(after[`mar_agent_model_config:${id}`]).toEqual({
        value: { version: 1, unifiedCompact: true, contextGcMode },
        updatedAt: 42
      });
    expect(after.unrelated).toEqual(before.unrelated);
    await MODEL_CONTEXT_GC_MODE_MIGRATION.up(migration);
    expect(await read()).toEqual(after);
  } finally {
    await connection.end();
    await dropPlaywrightTestDatabase(target);
  }
});

test('model settings backfill resumes after DDL interruption and rejects missing or conflicting facts', async () => {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-model-settings-migration`);
  await createPlaywrightTestDatabase(target);
  const connection = await mysql.createConnection(target.databaseUrl);
  const migrationConnection = connection as unknown as MysqlMigrationConnection;
  try {
    await connection.query(
      'CREATE TABLE system_settings (setting_key varchar(128) NOT NULL PRIMARY KEY, setting_value json NOT NULL, updated_at bigint NOT NULL)'
    );
    await connection.query(
      "CREATE TABLE mar_agent_models (id varchar(128) PRIMARY KEY, protocol enum('OPENAI_RESPONSES','ANTHROPIC_MESSAGES') NOT NULL, base_url varchar(2048) NOT NULL, credential json NOT NULL, fast_mode tinyint NOT NULL, service_tier varchar(20), hosted_web_search tinyint NOT NULL, responses_transport json, responses_previous_response_id tinyint NOT NULL)"
    );
    const id = 'x'.repeat(128);
    await connection.execute('INSERT INTO mar_agent_models VALUES (?,?,?,?,?,?,?,?,?)', [
      id,
      'OPENAI_RESPONSES',
      'https://api.openai.com/v1',
      JSON.stringify({ type: 'CREDENTIAL_REF', credentialId: 'cred' }),
      1,
      'default',
      1,
      JSON.stringify({ transport: 'HTTP', httpVersion: '2' }),
      1
    ]);
    const interruptedBackfill = {
      query: migrationConnection.query.bind(connection),
      execute: async (sql: string, values?: (string | number | null)[]) => {
        const result = await migrationConnection.execute.call(connection, sql, values);
        if (sql.startsWith('INSERT INTO system_settings'))
          throw new Error('INJECTED_BACKFILL_FAILURE');
        return result;
      },
      release: () => undefined
    } satisfies MysqlMigrationConnection;
    await expect(MODEL_SETTINGS_MIGRATION.up(interruptedBackfill)).rejects.toThrow(
      'INJECTED_BACKFILL_FAILURE'
    );
    const [rolledBack] = await connection.execute<mysql.RowDataPacket[]>(
      'SELECT setting_key FROM system_settings'
    );
    expect(rolledBack).toEqual([]);
    await connection.execute(
      "INSERT INTO system_settings VALUES (?,JSON_OBJECT('version',1,'hostedWebSearch',false,'serviceTier','default','responsesPreviousResponseId',false),1)",
      [`mar_agent_model_config:${id}`]
    );
    await expect(MODEL_SETTINGS_MIGRATION.up(migrationConnection)).rejects.toThrow(
      'MAR_AGENT_MODEL_CONFIG_INVALID'
    );
    await connection.execute('DELETE FROM system_settings WHERE setting_key=?', [
      `mar_agent_model_config:${id}`
    ]);
    await connection.execute(
      "UPDATE mar_agent_models SET protocol='ANTHROPIC_MESSAGES' WHERE id=?",
      [id]
    );
    await expect(MODEL_SETTINGS_MIGRATION.up(migrationConnection)).rejects.toThrow(
      'MAR_AGENT_MODEL_CONFIG_INVALID'
    );
    await connection.execute("UPDATE mar_agent_models SET protocol='OPENAI_RESPONSES' WHERE id=?", [
      id
    ]);
    let drops = 0;
    const interrupted = {
      query: migrationConnection.query.bind(connection),
      execute: async (sql: string, values?: (string | number | null)[]) => {
        if (sql.startsWith('ALTER TABLE mar_agent_models DROP COLUMN') && ++drops === 2)
          throw new Error('INJECTED_DDL_FAILURE');
        return migrationConnection.execute.call(connection, sql, values);
      },
      release: () => undefined
    } satisfies MysqlMigrationConnection;
    await expect(MODEL_SETTINGS_MIGRATION.up(interrupted)).rejects.toThrow('INJECTED_DDL_FAILURE');
    const key = `mar_agent_model_config:${id}`;
    const [saved] = await connection.execute<mysql.RowDataPacket[]>(
      'SELECT setting_value FROM system_settings WHERE setting_key=?',
      [key]
    );
    expect(saved).toHaveLength(1);
    const savedDocument = saved[0]!['setting_value'];
    expect(typeof savedDocument === 'string' ? JSON.parse(savedDocument) : savedDocument).toEqual({
      version: 1,
      hostedWebSearch: true,
      serviceTier: 'default',
      responsesTransport: { transport: 'HTTP', httpVersion: '2' },
      responsesPreviousResponseId: true
    });
    await connection.execute('UPDATE mar_agent_models SET hosted_web_search=0 WHERE id=?', [id]);
    await expect(MODEL_SETTINGS_MIGRATION.up(migrationConnection)).rejects.toThrow(
      'MAR_AGENT_MODEL_CONFIG_INVALID'
    );
    await connection.execute('UPDATE mar_agent_models SET hosted_web_search=1 WHERE id=?', [id]);
    await connection.execute('DELETE FROM system_settings WHERE setting_key=?', [key]);
    await expect(MODEL_SETTINGS_MIGRATION.up(migrationConnection)).rejects.toThrow(
      'MAR_AGENT_MODEL_CONFIG_INVALID'
    );
    await connection.execute('INSERT INTO system_settings VALUES (?,?,?)', [
      key,
      typeof savedDocument === 'string' ? savedDocument : JSON.stringify(savedDocument),
      1
    ]);
    await MODEL_SETTINGS_MIGRATION.up(migrationConnection);
    const [columns] = await connection.execute<mysql.RowDataPacket[]>(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mar_agent_models'"
    );
    expect(columns.map((row) => row['COLUMN_NAME'])).not.toContain('service_tier');
    await MODEL_SETTINGS_MIGRATION.up(migrationConnection);
  } finally {
    await connection.end();
    await dropPlaywrightTestDatabase(target);
  }
});

for (const interruption of [1, 2, 3, 4, 5]) {
  test(`model settings migration resumes after completed drop ${interruption}`, async () => {
    const runId = process.env['MAR_TEST_RUN_ID'];
    if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
    const target = resolvePlaywrightTestDatabase(`${runId}-model-settings-drop-${interruption}`);
    await createPlaywrightTestDatabase(target);
    const connection = await mysql.createConnection(target.databaseUrl);
    const migration = connection as unknown as MysqlMigrationConnection;
    try {
      await connection.query(
        'CREATE TABLE system_settings (setting_key varchar(128) NOT NULL PRIMARY KEY, setting_value json NOT NULL, updated_at bigint NOT NULL)'
      );
      await connection.query(
        "CREATE TABLE mar_agent_models (id varchar(128) PRIMARY KEY, protocol enum('OPENAI_RESPONSES','ANTHROPIC_MESSAGES') NOT NULL, base_url varchar(2048) NOT NULL, credential json NOT NULL, fast_mode tinyint NOT NULL, service_tier varchar(20), hosted_web_search tinyint NOT NULL, responses_transport json, responses_previous_response_id tinyint NOT NULL)"
      );
      await connection.execute('INSERT INTO mar_agent_models VALUES (?,?,?,?,?,?,?,?,?)', [
        'model',
        'OPENAI_RESPONSES',
        'https://api.openai.com/v1',
        JSON.stringify({ type: 'CREDENTIAL_REF', credentialId: 'cred' }),
        1,
        null,
        1,
        null,
        0
      ]);
      let drops = 0;
      const interrupted = {
        query: migration.query.bind(connection),
        execute: async (sql: string, values?: (string | number | null)[]) => {
          const result = await migration.execute.call(connection, sql, values);
          if (
            sql.startsWith('ALTER TABLE mar_agent_models DROP COLUMN') &&
            ++drops === interruption
          )
            throw new Error('INJECTED_DDL_FAILURE');
          return result;
        },
        release: () => undefined
      } satisfies MysqlMigrationConnection;
      await expect(MODEL_SETTINGS_MIGRATION.up(interrupted)).rejects.toThrow(
        'INJECTED_DDL_FAILURE'
      );
      await MODEL_SETTINGS_MIGRATION.up(migration);
      const [rows] = await connection.execute<mysql.RowDataPacket[]>(
        'SELECT setting_value FROM system_settings WHERE setting_key=?',
        ['mar_agent_model_config:model']
      );
      const value = rows[0]?.['setting_value'];
      expect(typeof value === 'string' ? JSON.parse(value) : value).toEqual({
        version: 1,
        hostedWebSearch: true,
        serviceTier: 'priority',
        responsesPreviousResponseId: false
      });
    } finally {
      await connection.end();
      await dropPlaywrightTestDatabase(target);
    }
  });
}
