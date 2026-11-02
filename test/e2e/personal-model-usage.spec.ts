import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import mysql from 'mysql2/promise';
import { NodeDatabase } from '../../mar-node/src/database.js';
import { ModelUsageOutbox } from '../../mar-node/src/service/model-usage-outbox.js';
import { NodeModelUsageService } from '../../mar-node/src/service/model-usage-service.js';
import { normalizeMarAgentUsage } from '../../mar-node/src/runner/mar-agent/conversation-normalizer.js';
import { observeModelRequestUsage } from '../../mar-agent/src/model/usage-observer.js';
import { ModelUsageGrants } from '../../packages/server-core/src/model-usage-grant.js';
import { ModelUsageStore } from '../../packages/server-core/src/model-usage-store.js';
import { ModelUsageQueryService } from '../../packages/server-core/src/model-usage-query.js';
import { registerModelUsageRoutes } from '../../packages/server-core/src/model-usage-routes.js';
import {
  MODEL_USAGE_MIGRATION,
  MODEL_USAGE_CONFIGURATION_MIGRATION,
  MODEL_USAGE_QUERY_INDEX_MIGRATION
} from '../../packages/server-core/src/model-usage-schema.js';
import { SESSION_COOKIE_NAME } from '../../packages/server-core/src/auth.js';
import {
  createEnvelope,
  personalUsageQuerySchema,
  type ModelUsageBatch,
  type ModelUsageRecord
} from '../../packages/protocol/src/index.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from './support/playwright-test-database.js';

const Fastify = createRequire(new URL('../../packages/server-core/package.json', import.meta.url))(
  'fastify'
);

test('Personal usage configuration migration preserves boundary totals and covers metadata and paging counts', async () => {
  const database = resolvePlaywrightTestDatabase(`usage_query_${randomUUID()}`);
  await createPlaywrightTestDatabase(database);
  const pool = mysql.createPool(database.databaseUrl);
  const now = Date.now();
  const day = 86_400_000;
  const calls: { sql: string; values: (string | number)[] }[] = [];
  const observedPool = {
    async getConnection() {
      const connection = await pool.getConnection();
      return {
        query: connection.query.bind(connection),
        beginTransaction: connection.beginTransaction.bind(connection),
        commit: connection.commit.bind(connection),
        rollback: connection.rollback.bind(connection),
        release: connection.release.bind(connection),
        execute(sql: string, values: (string | number)[]) {
          calls.push({ sql, values });
          return connection.execute(sql, values);
        }
      };
    }
  };
  const service = new ModelUsageQueryService(observedPool as unknown as mysql.Pool, () => now);
  const query = { from: now - 7 * day, to: now, timeZone: 'Asia/Shanghai' };
  const filtered = {
    ...query,
    runner: 'codex' as const,
    model: JSON.stringify(['codex', '', 'selected']),
    mode: 'conversation' as const
  };
  let sequence = 0;
  async function insert(
    endedAt: number | undefined,
    inputTokens: string,
    options: Partial<ModelUsageRecord> & {
      userId?: number;
      receivedAt?: number;
      modelKey?: string;
      mode?: 'work' | 'conversation';
    } = {}
  ) {
    const {
      userId = 1,
      receivedAt = now - 5,
      modelKey = 'ordinary',
      mode = 'work',
      ...fields
    } = options;
    const id = String(++sequence).padStart(64, '0');
    const record: ModelUsageRecord = {
      schemaVersion: 1,
      recordId: id,
      requestId: id,
      revision: 1,
      scopeId: randomUUID(),
      runner: 'mar-agent',
      sessionId: 'session',
      runId: 'run',
      modelName: 'Fixture model',
      purpose: 'conversation',
      agentRole: 'root',
      startedAt: (endedAt ?? now) - 100,
      endedAt,
      state: endedAt === undefined ? 'running' : 'succeeded',
      inputTokens,
      outputTokens: '2',
      cacheReadTokens: '3',
      cacheWriteTokens: '1',
      coverage: 'request',
      ...fields
    };
    await pool.execute(
      `INSERT INTO model_usage_records
      (source_key,user_id,source_node_id,record_id,revision,payload_hash,identity_hash,runner,mode,purpose,
       model_key,model_name,started_at,ended_at,received_at,input_tokens,output_tokens,record)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        userId,
        'fixture-node',
        id,
        1,
        '0'.repeat(64),
        '0'.repeat(64),
        record.runner,
        mode,
        record.purpose,
        modelKey,
        record.modelName!,
        record.startedAt,
        endedAt ?? null,
        receivedAt,
        inputTokens,
        '2',
        JSON.stringify(record)
      ]
    );
  }
  try {
    const connection = await pool.getConnection();
    try {
      await MODEL_USAGE_MIGRATION.up(connection);
      await MODEL_USAGE_QUERY_INDEX_MIGRATION.up(connection);
    } finally {
      connection.release();
    }
    await insert(now - 7 * day - 1, '1');
    await insert(now - 7 * day, '10');
    await insert(now - day, '20');
    await insert(now - day - 1, '30');
    await insert(now - 1, '9007199254740993', {
      runner: 'codex',
      modelKey: 'selected',
      actualModel: 'selected',
      mode: 'conversation'
    });
    await insert(now, '40');
    await insert(now - 3, '50', { receivedAt: now + 1 });
    await insert(now - 2, '60', { receivedAt: now });
    await insert(undefined, '0', { startedAt: now - 90 * day });
    await insert(undefined, '0', { startedAt: now - 90 * day - 1 });
    await insert(undefined, '0', { startedAt: now });
    await insert(now - 1, '100', { purpose: 'compact' });
    await insert(now - 1, '1000', { userId: 2 });
    const connectionAfter = await pool.getConnection();
    try {
      await MODEL_USAGE_CONFIGURATION_MIGRATION.up(connectionAfter);
      await MODEL_USAGE_CONFIGURATION_MIGRATION.up(connectionAfter);
    } finally {
      connectionAfter.release();
    }
    calls.length = 0;
    const afterOverview = await service.overview(1, filtered);
    const afterRecords = await service.records(1, query);
    expect(afterOverview).toMatchObject({
      firstRecordedAt: now - 90 * day,
      lastReceivedAt: now,
      last24Hours: {
        inputTokens: '9007199254741123',
        outputTokens: '8',
        requests: '4',
        cacheReadTokens: '12',
        cacheWriteTokens: '4'
      },
      last7Days: {
        inputTokens: '9007199254741163',
        outputTokens: '12',
        requests: '6',
        cacheReadTokens: '18',
        cacheWriteTokens: '6'
      },
      selected: { inputTokens: '9007199254740993', requests: '1' }
    });
    expect(afterRecords.total).toBe('6');
    expect(afterRecords.records).toHaveLength(6);
    const metadata = calls.find(({ sql }) => sql.includes('MIN(started_at)'))!;
    const count = calls.find(({ sql }) => sql.includes('CAST(COUNT(*) AS CHAR)'))!;
    for (const { sql, values } of [metadata, count]) {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>('EXPLAIN ' + sql, values);
      // The optimizer may prefer the smaller covering index for an unfiltered count.
      expect(['model_usage_user_time', 'model_usage_user_model_time']).toContain(rows[0]?.key);
      if (rows[0]?.key === 'model_usage_user_time')
        expect(String(rows[0]?.Extra).split('; ')).toContain('Using index');
    }
    const empty = await service.overview(3, query);
    expect(empty.last24Hours.requests).toBe('0');
    expect(empty.last7Days.requests).toBe('0');
    expect(empty.firstRecordedAt).toBeNull();
    expect(empty.lastReceivedAt).toBeNull();
  } finally {
    await pool.end();
    await dropPlaywrightTestDatabase(database);
  }
});

test('Personal usage separates model configurations while preserving native Runner groups and historical records', async () => {
  const database = resolvePlaywrightTestDatabase(`usage_models_${randomUUID()}`);
  await createPlaywrightTestDatabase(database);
  const pool = mysql.createPool(database.databaseUrl);
  const now = Date.now();
  const grants = new ModelUsageGrants(Buffer.from('isolated-model-usage-key'), () => now);
  const store = new ModelUsageStore(pool, grants, () => now);
  const calls: { sql: string; values: (string | number | null)[] }[] = [];
  const service = new ModelUsageQueryService(
    {
      async getConnection() {
        const connection = await pool.getConnection();
        return {
          query: connection.query.bind(connection),
          beginTransaction: connection.beginTransaction.bind(connection),
          commit: connection.commit.bind(connection),
          rollback: connection.rollback.bind(connection),
          release: connection.release.bind(connection),
          execute(sql: string, values: (string | number | null)[]) {
            calls.push({ sql, values });
            return connection.execute(sql, values);
          }
        };
      }
    } as mysql.Pool,
    () => now
  );
  const grant = grants.issue('usage-node', 1, 'work');
  const query = { from: now - 86_400_000, to: now, timeZone: 'Asia/Shanghai' };
  const base: ModelUsageRecord = {
    schemaVersion: 1,
    recordId: 'personal',
    requestId: 'personal',
    revision: 1,
    scopeId: grant.scopeId,
    runner: 'mar-agent',
    sessionId: 'session',
    runId: 'run',
    modelConfigurationId: 'personal-model',
    modelName: 'Terra Personal',
    provider: 'OPENAI_RESPONSES',
    requestedModel: 'terra',
    actualModel: 'terra',
    purpose: 'conversation',
    agentRole: 'root',
    startedAt: now - 2000,
    endedAt: now - 1000,
    state: 'succeeded',
    inputTokens: '20',
    outputTokens: '2',
    cacheReadTokens: '10',
    cacheWriteTokens: '1',
    coverage: 'request'
  };
  const records: ModelUsageRecord[] = [
    base,
    { ...base, recordId: 'org-1', modelConfigurationId: 'org-model', modelName: 'Terra Org' },
    { ...base, recordId: 'org-2', modelConfigurationId: 'org-model', modelName: 'Terra Renamed' },
    { ...base, recordId: 'fast', modelConfigurationId: 'fast-model', modelName: 'Terra Fast' },
    // IDs are case-sensitive even when the historical ledger uses a case-insensitive collation.
    {
      ...base,
      recordId: 'other-config',
      modelConfigurationId: 'ORG-model',
      modelName: 'Terra Renamed'
    },
    {
      ...base,
      recordId: 'other-actual',
      modelConfigurationId: 'org-model',
      actualModel: 'terra-v2'
    },
    { ...base, recordId: 'other-provider', modelConfigurationId: 'org-model', provider: 'other' },
    { ...base, recordId: 'legacy', modelConfigurationId: undefined },
    { ...base, recordId: 'codex-1', runner: 'codex', modelConfigurationId: undefined },
    { ...base, recordId: 'codex-2', runner: 'codex', modelConfigurationId: undefined },
    { ...base, recordId: 'claude', runner: 'claude-code', modelConfigurationId: undefined },
    {
      ...base,
      recordId: 'long-a',
      provider: '\\'.repeat(250),
      modelConfigurationId: '模型"\\-a',
      modelName: 'Long A'
    },
    {
      ...base,
      recordId: 'long-b',
      provider: '\\'.repeat(250),
      modelConfigurationId: '模型"\\-b',
      modelName: 'Long B'
    }
  ];
  const expectedGroups = [
    ['personal'],
    ['org-1', 'org-2', 'other-actual'],
    ['fast'],
    ['other-config'],
    ['other-provider'],
    ['legacy'],
    ['codex-1', 'codex-2'],
    ['claude'],
    ['long-a'],
    ['long-b']
  ];
  try {
    const connection = await pool.getConnection();
    try {
      await connection.query('CREATE TABLE users (id bigint unsigned PRIMARY KEY)');
      await connection.query('INSERT INTO users VALUES (1),(2)');
      await MODEL_USAGE_MIGRATION.up(connection);
      await MODEL_USAGE_QUERY_INDEX_MIGRATION.up(connection);
    } finally {
      connection.release();
    }
    const ack = await store.consume('usage-node', {
      apiVersion: 1,
      entries: records.map((record) => ({ grant, record }))
    });
    expect(ack.results.every((result) => result.status === 'accepted')).toBe(true);
    // Simulate the released native-model key without touching recorded payloads or hashes.
    for (const record of records) {
      await pool.execute('UPDATE model_usage_records SET model_key=? WHERE record_id=?', [
        JSON.stringify([
          record.runner,
          record.provider ?? '',
          record.actualModel ?? record.requestedModel ?? ''
        ]),
        record.recordId
      ]);
    }
    const [before] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT source_key,payload_hash,identity_hash,record FROM model_usage_records ORDER BY source_key'
    );
    const migrationConnection = await pool.getConnection();
    try {
      const [oldKeys] = await pool.query<mysql.RowDataPacket[]>(
        'SELECT source_key,model_key FROM model_usage_records ORDER BY source_key'
      );
      await expect(
        MODEL_USAGE_CONFIGURATION_MIGRATION.up({
          query: async (sql: string) => {
            const result = await migrationConnection.query(sql);
            if (sql.startsWith('UPDATE model_usage_records SET model_key='))
              throw new Error('injected failure');
            return result;
          },
          execute: migrationConnection.execute.bind(migrationConnection),
          release: () => {}
        })
      ).rejects.toThrow('injected failure');
      const [rolledBack] = await pool.query<mysql.RowDataPacket[]>(
        'SELECT source_key,model_key FROM model_usage_records ORDER BY source_key'
      );
      expect(rolledBack).toEqual(oldKeys);
      await MODEL_USAGE_CONFIGURATION_MIGRATION.up(migrationConnection);
      await MODEL_USAGE_CONFIGURATION_MIGRATION.up(migrationConnection);
    } finally {
      migrationConnection.release();
    }
    const [after] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT source_key,payload_hash,identity_hash,record FROM model_usage_records ORDER BY source_key'
    );
    expect(after).toEqual(before);
    expect(
      (
        await store.consume('usage-node', {
          apiVersion: 1,
          entries: records.map((record) => ({ grant, record }))
        })
      ).results.every((result) => result.status === 'accepted')
    ).toBe(true);
    // Existing records acquire the configuration identity in their indexed key.
    const [nativeKeys] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT DISTINCT model_key FROM model_usage_records WHERE runner=? AND model_name=?',
      ['mar-agent', 'Terra Org']
    );
    expect(nativeKeys).toHaveLength(1);
    expect(nativeKeys[0]?.model_key).toBe(
      JSON.stringify(['mar-agent', 'OPENAI_RESPONSES', 'org-model'])
    );
    const overview = await service.overview(1, query);
    expect(overview.models).toHaveLength(expectedGroups.length);
    expect(overview.selected).toMatchObject({ requests: '13', totalTokens: '286' });
    const longKeys = overview.models
      .filter((model) => model.label === 'Long A' || model.label === 'Long B')
      .map((model) => model.key);
    expect(longKeys).toHaveLength(2);
    expect(longKeys[0]!.slice(0, 512)).toBe(longKeys[1]!.slice(0, 512));
    expect(longKeys[0]).not.toBe(longKeys[1]);
    const longA = overview.models.find((model) => model.label === 'Long A')!;
    expect(longA.key).toBe(JSON.stringify(['mar-agent', '\\'.repeat(250), '模型"\\-a']));
    const actualGroups: string[][] = [];
    for (const model of overview.models) {
      const selectedQuery = { ...query, model: model.key };
      expect(personalUsageQuerySchema.safeParse(selectedQuery).success).toBe(true);
      const details = await service.records(1, selectedQuery);
      const ids = details.records.map((record) => record.recordId).sort();
      actualGroups.push(ids);
      const filtered = await service.overview(1, selectedQuery);
      expect(filtered.models).toEqual([model]);
      expect(filtered.selected).toEqual(modelTotals(model));
      expect(details.total).toBe(String(ids.length));
      expect(model).toMatchObject({
        requests: String(ids.length),
        totalTokens: String(22 * ids.length),
        cacheReadTokens: String(10 * ids.length),
        cacheWriteTokens: String(ids.length)
      });
      expect(details.records.some((record) => record.modelName === model.label)).toBe(true);
      expect((await service.records(2, selectedQuery)).records).toEqual([]);
    }
    expect(actualGroups).toEqual(expect.arrayContaining(expectedGroups));
    const longReplay = {
      ...records.find((record) => record.recordId === 'long-a')!,
      recordId: 'long-new'
    };
    expect(
      (
        await store.consume('usage-node', {
          apiVersion: 1,
          entries: [{ grant, record: longReplay }]
        })
      ).results[0]?.status
    ).toBe('accepted');
    expect(
      (await service.records(1, { ...query, model: longA.key })).records
        .map((record) => record.recordId)
        .sort()
    ).toEqual(['long-a', 'long-new']);
    expect(overview.models.filter((model) => model.label === 'Terra Renamed')).toHaveLength(2);
    for (const runner of ['codex', 'claude-code']) {
      const model = overview.models.find(
        (group) => group.key === JSON.stringify([runner, 'OPENAI_RESPONSES', 'terra'])
      );
      expect(model).toBeDefined();
    }
    // A selective configuration query must not scan all of this user's native-model records.
    await pool.execute(
      `INSERT INTO model_usage_records
      (source_key,user_id,source_node_id,record_id,revision,payload_hash,identity_hash,runner,mode,purpose,
       model_key,model_name,started_at,ended_at,received_at,input_tokens,output_tokens,record)
      WITH RECURSIVE sequence AS (SELECT 1 AS n UNION ALL SELECT n+1 FROM sequence WHERE n<150)
      SELECT SHA2(CONCAT('noise-',a.n,'-',b.n),256),1,'usage-node',CONCAT('noise-',a.n,'-',b.n),1,REPEAT('0',64),REPEAT('0',64),
        'mar-agent','work','conversation',?,'Unrelated configuration',?,?,?,20,2,
        JSON_SET(CAST(? AS JSON),'$.modelConfigurationId','noise-config','$.recordId',CONCAT('noise-',a.n,'-',b.n))
      FROM sequence a CROSS JOIN sequence b`,
      [
        JSON.stringify(['mar-agent', 'OPENAI_RESPONSES', 'noise-config']),
        base.startedAt,
        base.endedAt!,
        now,
        JSON.stringify(base)
      ]
    );
    await pool.query('ANALYZE TABLE model_usage_records');
    const org = overview.models.find(
      (model) => JSON.parse(model.key)[2] === 'org-model' && model.requests === '3'
    )!;
    calls.length = 0;
    await service.overview(1, { ...query, model: org.key });
    await service.records(1, { ...query, model: org.key }, undefined, 1);
    const filteredReads = calls.filter(({ sql }) => sql.includes('BINARY model_key=BINARY ?'));
    expect(filteredReads).toHaveLength(3);
    const plans: string[] = [];
    for (const { sql, values } of filteredReads) {
      const [plan] = await pool.execute<mysql.RowDataPacket[]>('EXPLAIN ' + sql, values);
      expect(plan[0]?.key).toBe('model_usage_user_model_time');
      expect(['ref', 'range']).toContain(plan[0]?.type);
      expect(Number(plan[0]?.rows)).toBeLessThan(10);
      plans.push(`${plan[0]?.key}/${plan[0]?.type}/${plan[0]?.rows}`);
    }
    console.log(`Selective query EXPLAIN (key/type/estimated rows): ${plans.join(', ')}`);
    const durations: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await service.overview(1, { ...query, model: org.key });
      await service.records(1, { ...query, model: org.key }, undefined, 1);
      durations.push(performance.now() - start);
    }
    console.log(
      `Selective overview+page over 22514 rows, five samples (ms): ${durations.map((ms) => ms.toFixed(1)).join(', ')}`
    );

    // Rolling totals and metadata stay unfiltered even when a model is selected.
    const unfilteredReads = calls.filter(({ values }) => !values.includes(org.key));
    calls.length = 0;
    const defaultOverview = await service.overview(1, query);
    const defaultPage = await service.records(1, query, undefined, 1);
    expect(defaultOverview.selected.requests).toBe('22514');
    expect(defaultPage.total).toBe('22514');
    expect(defaultPage.records).toHaveLength(20);
    expect(calls.length).toBeGreaterThan(0);
    unfilteredReads.push(...calls);
    for (const { sql, values } of unfilteredReads) {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        'EXPLAIN FORMAT=JSON ' + sql,
        values
      );
      const tables = usagePlanTables(JSON.parse(String(rows[0]?.EXPLAIN)));
      expect(tables.length).toBeGreaterThan(0);
      for (const table of tables) {
        // Exclude the model-first index from the candidate set, not just today's chosen plan.
        expect(table.possible_keys ?? []).not.toContain('model_usage_user_model_time');
        expect(table.key).not.toBe('model_usage_user_model_time');
      }
    }
  } finally {
    await pool.end();
    await dropPlaywrightTestDatabase(database);
  }
});

function usagePlanTables(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(usagePlanTables);
  if (value === null || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  return [
    ...(node.table_name === 'model_usage_records' ? [node] : []),
    ...Object.values(node).flatMap(usagePlanTables)
  ];
}

function modelTotals({
  key: _key,
  label: _label,
  ...totals
}: Awaited<ReturnType<ModelUsageQueryService['overview']>>['models'][number]) {
  return totals;
}

test('Personal usage carries SDK facts through durable delivery, MySQL revisions and private HTTP queries', async () => {
  const database = resolvePlaywrightTestDatabase(`usage_${randomUUID()}`);
  await createPlaywrightTestDatabase(database);
  const pool = mysql.createPool(database.databaseUrl);
  const node = new NodeDatabase(':memory:', 'usage-node');
  const app = Fastify();
  const now = Date.now();
  const grants = new ModelUsageGrants(Buffer.from('isolated-usage-test-signing-key'), () => now);
  const store = new ModelUsageStore(pool, grants, () => now);
  const diagnostics: string[] = [];
  const batches: ModelUsageBatch[] = [];
  const sends: Promise<void>[] = [];
  let deliveryError: unknown;
  let dropAck = true;
  const outbox = new ModelUsageOutbox({
    database: () => node.raw,
    namespace: () => 'test-server:usage-node',
    now: () => now,
    diagnose: (code) => diagnostics.push(code),
    send: (_type, payload) => {
      batches.push(payload as ModelUsageBatch);
      sends.push(
        store
          .consume('usage-node', payload)
          .then((ack) => {
            if (!dropAck) outbox.handle(createEnvelope('usage.ack', ack));
          })
          .catch((error) => {
            deliveryError = error;
          })
      );
    }
  });
  try {
    const connection = await pool.getConnection();
    try {
      await connection.query('CREATE TABLE users (id bigint unsigned PRIMARY KEY)');
      await connection.query('INSERT INTO users VALUES (1),(2)');
      await MODEL_USAGE_MIGRATION.up(connection);
      await MODEL_USAGE_MIGRATION.up(connection);
      await MODEL_USAGE_QUERY_INDEX_MIGRATION.up(connection);
      await MODEL_USAGE_QUERY_INDEX_MIGRATION.up(connection);
      await MODEL_USAGE_CONFIGURATION_MIGRATION.up(connection);
      await MODEL_USAGE_CONFIGURATION_MIGRATION.up(connection);
    } finally {
      connection.release();
    }
    const binding = new NodeModelUsageService(
      () => outbox,
      () => 'usage-node'
    );
    binding.bind('run', grants.issue('usage-node', 1, 'work'), 'session', 'mar-agent');
    const model = {
      id: 'model',
      name: 'Test model',
      protocol: 'OPENAI_RESPONSES' as const,
      modelId: 'test-model',
      baseUrl: 'http://127.0.0.1',
      contextWindowTokens: 1000,
      maxOutputTokens: 100,
      inputCapabilities: ['TEXT' as const],
      outputCapabilities: ['TEXT'] as ['TEXT'],
      reasoningEfforts: [],
      titleGeneration: false,
      codeMode: false,
      hostedWebSearch: false,
      enabled: true
    };
    // The provider is a deterministic fake; metering, SQLite, MySQL and HTTP are real.
    for await (const _event of observeModelRequestUsage(
      async function* () {
        yield {
          type: 'usage' as const,
          usage: { totalInputTokens: 20, outputTokens: 4, cacheReadTokens: 10 }
        };
        yield { type: 'completed' as const, reason: 'completed' as const };
      },
      {
        system: '',
        messages: [],
        tools: [],
        onModelUsage: (usage) =>
          binding.record(
            'run',
            normalizeMarAgentUsage({
              ...usage,
              sessionId: 'session',
              purpose: 'conversation',
              agentRole: 'root'
            })
          )
      },
      model,
      new AbortController().signal,
      () => now - 100
    )) {
      void _event;
    }
    expect(node.raw.prepare('SELECT COUNT(*) AS n FROM model_usage_outbox').get()?.n).toBe(1);
    expect(batches).toHaveLength(0);
    outbox.connected({ modelUsage: { apiVersion: 1 } });
    await expect.poll(() => batches.length).toBe(1);
    await Promise.all(sends);
    expect(deliveryError).toBeUndefined();
    outbox.disconnected();
    dropAck = false;
    outbox.connected({ modelUsage: { apiVersion: 1 } });
    await expect
      .poll(() => node.raw.prepare('SELECT COUNT(*) AS n FROM model_usage_outbox').get()?.n)
      .toBe(0);
    expect(deliveryError).toBeUndefined();
    const entry = batches[0]!.entries[0]!;
    expect(
      (
        await store.consume('usage-node', {
          apiVersion: 1,
          entries: [{ ...entry, record: { ...entry.record, revision: 3, outputTokens: '7' } }]
        })
      ).results[0]?.status
    ).toBe('accepted');
    registerModelUsageRoutes({
      app,
      database: {
        findCurrentUserSession: (token) =>
          ['1', '2'].includes(token)
            ? {
                userId: Number(token),
                username: `user-${token}`,
                isAdmin: false,
                sessionHash: token,
                mustChangePassword: false,
                csrfTokenHash: ''
              }
            : undefined
      },
      usage: new ModelUsageQueryService(pool, () => now)
    });
    const query = new URLSearchParams({
      from: String(now - 86400000),
      to: String(now),
      timeZone: 'Asia/Shanghai'
    });
    const url = `/api/me/usage/overview?${query}`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    const mine = await app.inject({ url, headers: { cookie: `${SESSION_COOKIE_NAME}=1` } });
    expect(mine.statusCode).toBe(200);
    expect(mine.headers['cache-control']).toBe('no-store');
    expect(mine.json().last24Hours).toMatchObject({ totalTokens: '27', requests: '1' });
    expect(mine.json().selected).toEqual(mine.json().last24Hours);
    for (const totals of [
      mine.json().last24Hours,
      mine.json().last7Days,
      mine.json().selected,
      ...mine.json().buckets,
      ...mine.json().runners,
      ...mine.json().models
    ]) {
      if (totals.requests === '0') continue;
      expect(totals.cacheReadTokens).toBe('10');
      expect(totals.cacheWriteTokens).toBe('0');
    }
    expect(mine.json().lastReceivedAt).toBe(now);
    expect(
      (await app.inject({ url, headers: { cookie: `${SESSION_COOKIE_NAME}=2` } })).json().selected
        .requests
    ).toBe('0');
    expect(
      (
        await app.inject({
          url: `${url}&userId=2`,
          headers: { cookie: `${SESSION_COOKIE_NAME}=1` }
        })
      ).statusCode
    ).toBe(400);
    const details = (
      await app.inject({
        url: `/api/me/usage/records?${query}`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=1` }
      })
    ).json();
    expect(details.records).toHaveLength(1);
    expect(details.records[0]).toMatchObject({
      totalTokens: '27',
      cacheReadTokens: '10',
      revision: 3
    });
    expect(details.records[0]).not.toHaveProperty('grant');
    expect(details.records[0]).not.toHaveProperty('source_node_id');
    const additional = Array.from({ length: 60 }, (_, index) => ({
      grant: entry.grant,
      record: {
        ...entry.record,
        recordId: `pagination-${index}`,
        requestId: `pagination-${index}`,
        revision: 1,
        runner: 'codex' as const,
        purpose: 'compact' as const
      }
    }));
    expect(
      (await store.consume('usage-node', { apiVersion: 1, entries: additional })).results.every(
        (result) => result.status === 'accepted'
      )
    ).toBe(true);
    const readPage = async (page: number, suffix = '', user = '1') => {
      const response = await app.inject({
        url: `/api/me/usage/records?${query}&page=${page}${suffix}`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${user}` }
      });
      expect(response.statusCode).toBe(200);
      return response.json();
    };
    const defaultPage = await readPage(1);
    expect(defaultPage).toMatchObject({ total: '1', page: 1 });
    expect(
      defaultPage.records.every((record: { purpose: string }) => record.purpose === 'conversation')
    ).toBe(true);
    const firstPage = await readPage(1, '&purpose=compact');
    const lastPage = await readPage(3, '&purpose=compact');
    expect(firstPage).toMatchObject({ total: '60', page: 1 });
    expect(firstPage.records).toHaveLength(20);
    expect(lastPage).toMatchObject({ total: '60', page: 3 });
    expect(lastPage.records).toHaveLength(20);
    expect((await readPage(99, '&purpose=compact')).page).toBe(3);
    const filtered = await readPage(3, '&runner=codex&purpose=compact');
    expect(filtered).toMatchObject({ total: '60', page: 3 });
    expect(filtered.records).toHaveLength(20);
    expect((await readPage(1, '', '2')).total).toBe('0');
    const allPages = await Promise.all(
      [1, 2, 3].map((number) => readPage(number, '&purpose=compact'))
    );
    expect(
      new Set(
        allPages.flatMap((page) =>
          page.records.map((record: { ledgerId: string }) => record.ledgerId)
        )
      ).size
    ).toBe(60);
    const prediction = {
      grant: entry.grant,
      record: {
        ...entry.record,
        recordId: 'prediction',
        requestId: 'prediction',
        revision: 1,
        purpose: 'prompt_completion' as const
      }
    };
    expect(
      (await store.consume('usage-node', { apiVersion: 1, entries: [prediction] })).results[0]
        ?.status
    ).toBe('accepted');
    for (const [purpose, requests] of [
      ['conversation', '1'],
      ['compact', '60'],
      ['prompt_completion', '1']
    ]) {
      const response = await app.inject({
        url: `${url}&purpose=${purpose}`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=1` }
      });
      expect(response.statusCode).toBe(200);
      for (const metric of ['last24Hours', 'last7Days', 'selected'])
        expect(response.json()[metric].requests).toBe(requests);
    }
    for (const invalid of ['0', '-1', '1.5', '9007199254740991', '2&cursor=invalid']) {
      expect(
        (
          await app.inject({
            url: `/api/me/usage/records?${query}&page=${invalid}`,
            headers: { cookie: `${SESSION_COOKIE_NAME}=1` }
          })
        ).statusCode
      ).toBe(400);
    }
    for (const [revision, cacheReadTokens] of [
      [4, undefined],
      [5, '0']
    ] as const) {
      const updated = await store.consume('usage-node', {
        apiVersion: 1,
        entries: [
          {
            ...entry,
            record: {
              ...entry.record,
              revision,
              outputTokens: '7',
              cacheReadTokens,
              cacheWriteTokens: revision === 5 ? '5' : undefined
            }
          }
        ]
      });
      expect(updated.results[0]?.status).toBe('accepted');
      const totalsResponse = await app.inject({
        url: `/api/me/usage/overview?${query}&runner=mar-agent`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=1` }
      });
      expect(totalsResponse.statusCode).toBe(200);
      expect(totalsResponse.json().selected.cacheReadTokens).toBe(cacheReadTokens ?? '0');
      expect(totalsResponse.json().selected.cacheWriteTokens).toBe(revision === 5 ? '5' : '0');
      expect(totalsResponse.json().selected.totalTokens).toBe('27');
      const cacheRecords = await readPage(1, '&runner=mar-agent');
      expect(cacheRecords.records[0].cacheReadTokens).toBe(cacheReadTokens ?? '0');
      const allTotals = await app.inject({
        url: `/api/me/usage/overview?${query}`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=1` }
      });
      expect(allTotals.json().selected.cacheReadTokens).toBe(cacheReadTokens ?? '0');
    }
    const subagent = {
      grant: entry.grant,
      record: {
        ...entry.record,
        recordId: 'subagent',
        requestId: 'subagent',
        revision: 1,
        purpose: 'conversation' as const,
        agentRole: 'subagent' as const,
        inputTokens: '3',
        outputTokens: '2',
        cacheReadTokens: '0'
      }
    };
    expect(
      (await store.consume('usage-node', { apiVersion: 1, entries: [subagent] })).results[0]?.status
    ).toBe('accepted');
    const conversations = await app.inject({
      url,
      headers: { cookie: `${SESSION_COOKIE_NAME}=1` }
    });
    expect(conversations.json().selected).toMatchObject({ requests: '2', totalTokens: '32' });
    const missing = {
      ...entry.record,
      recordId: 'missing-counters',
      requestId: 'missing-counters',
      revision: 1,
      purpose: 'other' as const,
      state: 'cancelled' as const,
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      reasoningTokens: undefined
    };
    expect(
      (
        await store.consume('usage-node', {
          apiVersion: 1,
          entries: [{ grant: entry.grant, record: missing }]
        })
      ).results[0]?.status
    ).toBe('accepted');
    const otherOverview = async () =>
      (
        await app.inject({
          url: url + '&purpose=other',
          headers: { cookie: SESSION_COOKIE_NAME + '=1' }
        })
      ).json();
    const zero = await otherOverview();
    for (const totals of [zero.last24Hours, zero.last7Days, zero.selected, ...zero.buckets]) {
      expect(totals).toMatchObject({
        inputTokens: '0',
        outputTokens: '0',
        totalTokens: '0',
        cacheReadTokens: '0',
        cacheWriteTokens: '0',
        unknownRequests: '0',
        partialRequests: '0'
      });
    }
    const stored = await pool.query('SELECT record FROM model_usage_records WHERE record_id=?', [
      missing.recordId
    ]);
    expect((stored[0] as { record: unknown }[])[0]?.record).toMatchObject({
      inputTokens: '0',
      outputTokens: '0',
      cacheReadTokens: '0',
      cacheWriteTokens: '0',
      reasoningTokens: '0'
    });
    // Legacy missing fields use the same zero convention without rewriting old rows.
    await pool.execute(
      'UPDATE model_usage_records SET input_tokens=NULL,output_tokens=5,record=CAST(? AS JSON) WHERE record_id=?',
      [JSON.stringify({ ...missing, outputTokens: '5' }), missing.recordId]
    );
    expect((await otherOverview()).selected).toMatchObject({
      inputTokens: '0',
      outputTokens: '5',
      totalTokens: '5',
      cacheReadTokens: '0',
      cacheWriteTokens: '0',
      completeRequests: '1',
      partialRequests: '0',
      unknownRequests: '0'
    });
    const legacy = await readPage(1, '&purpose=other');
    expect(legacy.records[0]).toMatchObject({
      inputTokens: '0',
      outputTokens: '5',
      totalTokens: '5',
      cacheReadTokens: '0',
      cacheWriteTokens: '0',
      reasoningTokens: '0'
    });
    await pool.query('DELETE FROM model_usage_records WHERE user_id=1');
    await pool.query('DELETE FROM users WHERE id=1');
    expect((await store.consume('usage-node', batches[0])).results[0]?.code).toBe(
      'USAGE_USER_DELETED'
    );
    expect(diagnostics).toEqual([]);
  } finally {
    outbox.disconnected();
    await Promise.all(sends);
    await app.close();
    node.close();
    await pool.end();
    await dropPlaywrightTestDatabase(database);
  }
});
