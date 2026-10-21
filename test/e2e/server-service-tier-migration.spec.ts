import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { CORE_MYSQL_MIGRATIONS } from '../../packages/server-core/src/mysql-schema.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from './support/playwright-test-database.js';

test('Conversation model migration backfills legacy models and preserves auxiliary use on retry', async () => {
  const database = resolvePlaywrightTestDatabase(`conversation_model_${randomUUID()}`);
  await createPlaywrightTestDatabase(database);
  const pool = mysql.createPool(database.databaseUrl);
  let connection: Awaited<ReturnType<typeof pool.getConnection>> | undefined;
  try {
    connection = await pool.getConnection();
    await connection.execute(`CREATE TABLE mar_agent_models (
      id varchar(128) PRIMARY KEY,
      default_reasoning_effort varchar(16) NOT NULL
    )`);
    await connection.execute("INSERT INTO mar_agent_models VALUES ('legacy','medium')");
    const migration = CORE_MYSQL_MIGRATIONS.find((entry) => entry.version === 25)!;
    await migration.up(connection);
    const [rows] = await connection.execute<RowDataPacket[]>('SELECT * FROM mar_agent_models');
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { id: 'legacy', default_reasoning_effort: 'medium', conversation_model: 1 }
    ]);
    await connection.execute("UPDATE mar_agent_models SET conversation_model=0 WHERE id='legacy'");
    await migration.up(connection);
    await connection.execute(
      "INSERT INTO mar_agent_models (id,default_reasoning_effort) VALUES ('new','high')"
    );
    const [preserved] = await connection.execute<RowDataPacket[]>(
      'SELECT id,conversation_model FROM mar_agent_models ORDER BY id'
    );
    expect(preserved.map((row) => ({ ...row }))).toEqual([
      { id: 'legacy', conversation_model: 0 },
      { id: 'new', conversation_model: 1 }
    ]);
  } finally {
    connection?.release();
    await pool.end();
    await dropPlaywrightTestDatabase(database);
  }
});

test('Responses service-tier migration upgrades legacy data and preserves explicit tiers on retry', async () => {
  const database = resolvePlaywrightTestDatabase(`service_tier_${randomUUID()}`);
  await createPlaywrightTestDatabase(database);
  const pool = mysql.createPool(database.databaseUrl);
  let connection: Awaited<ReturnType<typeof pool.getConnection>> | undefined;
  try {
    connection = await pool.getConnection();
    await connection.execute(`CREATE TABLE mar_agent_models (
      id varchar(128) PRIMARY KEY,
      protocol enum('OPENAI_RESPONSES','ANTHROPIC_MESSAGES') NOT NULL,
      credential json NOT NULL,
      fast_mode tinyint(1) NOT NULL DEFAULT 0
    )`);
    await connection.execute(`INSERT INTO mar_agent_models VALUES
      ('fast', 'OPENAI_RESPONSES', '{}', 1),
      ('default', 'OPENAI_RESPONSES', '{}', 0),
      ('anthropic', 'ANTHROPIC_MESSAGES', '{}', 0)`);
    const migration = CORE_MYSQL_MIGRATIONS.find((entry) => entry.version === 13)!;
    await migration.up(connection);
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT id,service_tier FROM mar_agent_models ORDER BY id'
    );
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { id: 'anthropic', service_tier: null },
      { id: 'default', service_tier: 'default' },
      { id: 'fast', service_tier: 'priority' }
    ]);
    await connection.execute(
      "UPDATE mar_agent_models SET service_tier='ultrafast' WHERE id='fast'"
    );
    await migration.up(connection);
    const [preserved] = await connection.execute<RowDataPacket[]>(
      "SELECT service_tier FROM mar_agent_models WHERE id='fast'"
    );
    expect(preserved[0]?.service_tier).toBe('ultrafast');
    for (const serviceTier of ['auto', 'default', 'flex', 'priority', 'fast', 'ultrafast']) {
      await connection.execute("UPDATE mar_agent_models SET service_tier=? WHERE id='default'", [
        serviceTier
      ]);
      const [stored] = await connection.execute<RowDataPacket[]>(
        "SELECT service_tier FROM mar_agent_models WHERE id='default'"
      );
      expect(stored[0]?.service_tier).toBe(serviceTier);
    }
  } finally {
    connection?.release();
    await pool.end();
    await dropPlaywrightTestDatabase(database);
  }
});

for (const version of [21, 23]) {
  test(`X subscription endpoint migration v${version} preserves unrelated models and is idempotent`, async () => {
    const database = resolvePlaywrightTestDatabase(`xai_endpoint_${version}_${randomUUID()}`);
    await createPlaywrightTestDatabase(database);
    const pool = mysql.createPool(database.databaseUrl);
    let connection: Awaited<ReturnType<typeof pool.getConnection>> | undefined;
    try {
      connection = await pool.getConnection();
      await connection.execute(`CREATE TABLE mar_agent_models (
      id varchar(128) PRIMARY KEY,
      protocol varchar(32) NOT NULL,
      base_url varchar(2048) NOT NULL,
      credential json NOT NULL,
      hosted_web_search tinyint(1) NOT NULL,
      responses_transport json NOT NULL,
      responses_previous_response_id tinyint(1) NOT NULL,
      last_tested_at bigint,
      last_test_status varchar(32) NOT NULL,
      last_test_code varchar(128)
    )`);
      const proxy = 'https://cli-chat-proxy.grok.com/v1';
      const api = 'https://api.x.ai/v1';
      const from = version === 21 ? proxy : api;
      const to = version === 21 ? api : proxy;
      for (const [id, protocol, baseUrl, credential] of [
        [
          'subscription',
          'OPENAI_RESPONSES',
          from,
          { type: 'CREDENTIAL_REF', credentialId: 'x-credential' }
        ],
        ['inline', 'OPENAI_RESPONSES', from, { type: 'INLINE_API_KEY', value: 'fake-key' }],
        ['inline-target', 'OPENAI_RESPONSES', to, { type: 'INLINE_API_KEY', value: 'fake-key' }],
        [
          'other',
          'OPENAI_RESPONSES',
          'https://api.openai.com/v1',
          { type: 'CREDENTIAL_REF', credentialId: 'codex' }
        ],
        [
          'anthropic',
          'ANTHROPIC_MESSAGES',
          from,
          { type: 'CREDENTIAL_REF', credentialId: 'other' }
        ],
        [
          'already-target',
          'OPENAI_RESPONSES',
          to,
          { type: 'CREDENTIAL_REF', credentialId: 'x-credential' }
        ]
      ] as const) {
        await connection.execute('INSERT INTO mar_agent_models VALUES (?,?,?,?,?,?,?,?,?,?)', [
          id,
          protocol,
          baseUrl,
          JSON.stringify(credential),
          0,
          JSON.stringify({ transport: 'HTTP', httpVersion: '1.1' }),
          1,
          123,
          'SUCCEEDED',
          'OK'
        ]);
      }
      for (const [id, transport, continuation] of [
        ['subscription-ws', { transport: 'WEBSOCKET' }, 1],
        ['subscription-http-off', { transport: 'HTTP', httpVersion: '1.1' }, 0]
      ] as const) {
        await connection.execute('INSERT INTO mar_agent_models VALUES (?,?,?,?,?,?,?,?,?,?)', [
          id,
          'OPENAI_RESPONSES',
          from,
          JSON.stringify({ type: 'CREDENTIAL_REF', credentialId: 'x-credential' }),
          1,
          JSON.stringify(transport),
          continuation,
          123,
          'SUCCEEDED',
          'OK'
        ]);
      }
      const [before] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM mar_agent_models ORDER BY id'
      );
      const migration = CORE_MYSQL_MIGRATIONS.find((entry) => entry.version === version)!;
      await migration.up(connection);
      const [after] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM mar_agent_models ORDER BY id'
      );
      expect(after.map((row) => ({ ...row }))).toEqual(
        before.map((row) => ({
          ...row,
          ...(['subscription', 'subscription-ws', 'subscription-http-off'].includes(row.id)
            ? {
                base_url: to,
                last_tested_at: null,
                last_test_status: 'UNVERIFIED',
                last_test_code: null
              }
            : {})
        }))
      );
      await connection.execute(
        "UPDATE mar_agent_models SET last_test_status='SUCCEEDED',last_test_code='OK' WHERE id='subscription'"
      );
      const [retested] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM mar_agent_models ORDER BY id'
      );
      await migration.up(connection);
      const [retried] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM mar_agent_models ORDER BY id'
      );
      expect(retried).toEqual(retested);
    } finally {
      connection?.release();
      await pool.end();
      await dropPlaywrightTestDatabase(database);
    }
  });
}

test('Responses continuation migration clears only non-WebSocket flags and is idempotent', async () => {
  const database = resolvePlaywrightTestDatabase(`${process.env.MAR_TEST_RUN_ID}-continuation`);
  await createPlaywrightTestDatabase(database);
  const pool = mysql.createPool(database.databaseUrl);
  let connection: Awaited<ReturnType<typeof pool.getConnection>> | undefined;
  try {
    connection = await pool.getConnection();
    await connection.query(`CREATE TABLE mar_agent_models (
      id varchar(128) PRIMARY KEY,
      responses_transport json,
      responses_previous_response_id tinyint(1) NOT NULL,
      last_test_status varchar(32) NOT NULL
    )`);
    for (const [id, transport, enabled] of [
      ['websocket', { transport: 'WEBSOCKET' }, 1],
      ['websocket-off', { transport: 'WEBSOCKET' }, 0],
      ['http1', { transport: 'HTTP', httpVersion: '1.1' }, 1],
      ['http2', { transport: 'HTTP', httpVersion: '2' }, 1],
      ['http-off', { transport: 'HTTP', httpVersion: '1.1' }, 0],
      ['default-http', null, 1],
      ['default-http-off', null, 0]
    ] as const) {
      await connection.execute('INSERT INTO mar_agent_models VALUES (?,?,?,?)', [
        id,
        transport === null ? null : JSON.stringify(transport),
        enabled,
        'SUCCEEDED'
      ]);
    }
    const [before] = await connection.execute<RowDataPacket[]>(
      'SELECT * FROM mar_agent_models ORDER BY id'
    );
    const migration = CORE_MYSQL_MIGRATIONS.find((entry) => entry.version === 22)!;
    await migration.up(connection);
    const [after] = await connection.execute<RowDataPacket[]>(
      'SELECT * FROM mar_agent_models ORDER BY id'
    );
    expect(after.map((row) => ({ ...row }))).toEqual(
      before.map((row) => ({
        ...row,
        responses_previous_response_id: row.id === 'websocket' ? 1 : 0
      }))
    );
    await migration.up(connection);
    const [retried] = await connection.execute<RowDataPacket[]>(
      'SELECT * FROM mar_agent_models ORDER BY id'
    );
    expect(retried).toEqual(after);
  } finally {
    connection?.release();
    await pool.end();
    await dropPlaywrightTestDatabase(database);
  }
});
