import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import mysql from 'mysql2/promise';
import { NodeDatabase } from '../../mar-node/src/database.js';
import { ModelUsageOutbox } from '../../mar-node/src/service/model-usage-outbox.js';
import { NodeModelUsageService } from '../../mar-node/src/service/model-usage-service.js';
import { normalizeMarAgentUsage } from '../../mar-node/src/runner/mar-agent/conversation-normalizer.js';
import { observeModelRequestUsage } from '../../mar-agent/src/agent-core/model/usage-observer.js';
import { ModelUsageGrants } from '../../packages/server-core/src/model-usage-grant.js';
import { ModelUsageStore } from '../../packages/server-core/src/model-usage-store.js';
import { ModelUsageQueryService } from '../../packages/server-core/src/model-usage-query.js';
import { registerModelUsageRoutes } from '../../packages/server-core/src/model-usage-routes.js';
import { MODEL_USAGE_MIGRATION } from '../../packages/server-core/src/model-usage-schema.js';
import { SESSION_COOKIE_NAME } from '../../packages/server-core/src/auth.js';
import { createEnvelope, type ModelUsageBatch } from '../../packages/protocol/src/index.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from './support/playwright-test-database.js';

const Fastify = createRequire(new URL('../../packages/server-core/package.json', import.meta.url))(
  'fastify'
);

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
