import { createHash } from 'node:crypto';
import {
  MODEL_USAGE_RETENTION_MS,
  personalUsageQuerySchema,
  type ModelUsageGrant,
  type ModelUsageRecord,
  type PersonalUsageQuery
} from '@myagentroam/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ModelUsageGrants } from '../../src/model-usage-grant.js';
import { ModelUsageQueryService, usageBucketRanges } from '../../src/model-usage-query.js';
import { ModelUsageStore } from '../../src/model-usage-store.js';

const NODE_ID = 'node-1';
const USER_ID = 42;
const NOW = 1_000_000_000;
const SCOPE_ID = '00000000-0000-0000-0000-000000000001';

describe('ModelUsageGrants', () => {
  it('issues verifiable grants with the node, user, scope, lifetime, and purpose domain', () => {
    const grants = new ModelUsageGrants(Buffer.from('test-signing-key'), () => NOW);
    const work = grants.issue(NODE_ID, USER_ID, 'work');
    const conversation = grants.issue(NODE_ID, USER_ID, 'conversation');

    expect(grants.verify(NODE_ID, work)).toMatchObject({
      audience: 'model-usage-v1',
      scopeId: work.scopeId,
      nodeId: NODE_ID,
      userId: USER_ID,
      mode: 'work',
      issuedAt: NOW,
      expiresAt: NOW + MODEL_USAGE_RETENTION_MS
    });
    expect(grants.verify(NODE_ID, conversation)).toMatchObject({
      scopeId: conversation.scopeId,
      mode: 'conversation'
    });
    expect(work.scopeId).not.toBe(conversation.scopeId);
  });

  it('rejects forged signatures, changed claims, scope mismatches, wrong nodes, and expired grants', () => {
    let now = NOW;
    const grants = new ModelUsageGrants(Buffer.from('test-signing-key'), () => now);
    const grant = grants.issue(NODE_ID, USER_ID, 'work');
    const [body, signature] = grant.token.split('.');
    const changedSignature = `${signature!.slice(0, -1)}${signature!.endsWith('a') ? 'b' : 'a'}`;
    const claims = JSON.parse(Buffer.from(body!, 'base64url').toString()) as {
      mode: string;
    };
    claims.mode = 'conversation';
    const changedBody = Buffer.from(JSON.stringify(claims)).toString('base64url');

    expect(
      grants.verify(NODE_ID, { ...grant, token: `${body}.${changedSignature}` })
    ).toBeUndefined();
    expect(
      grants.verify(NODE_ID, { ...grant, token: `${changedBody}.${signature}` })
    ).toBeUndefined();
    expect(
      grants.verify(NODE_ID, {
        ...grant,
        scopeId: '00000000-0000-0000-0000-000000000002'
      })
    ).toBeUndefined();
    expect(grants.verify('other-node', grant)).toBeUndefined();

    now = NOW + MODEL_USAGE_RETENTION_MS + 1;
    expect(grants.verify(NODE_ID, grant)).toBeUndefined();
  });

  it('rejects claims issued too far in the future', () => {
    const issuer = new ModelUsageGrants(Buffer.from('test-signing-key'), () => NOW + 3_600_001);
    const grant = issuer.issue(NODE_ID, USER_ID, 'work');
    const verifier = new ModelUsageGrants(Buffer.from('test-signing-key'), () => NOW);

    expect(verifier.verify(NODE_ID, grant)).toBeUndefined();
  });
});

describe('ModelUsageStore', () => {
  it('accepts replay of legacy records whose hashes precede zero-filling', async () => {
    const fixture = storeFixture();
    const grant = fixture.grants.issue(NODE_ID, USER_ID, 'work');
    const record = usageRecord({ scopeId: grant.scopeId, outputTokens: undefined });
    await fixture.store.consume(NODE_ID, batch(grant, record));
    const legacy = fixture.mysql.rows[0]!;
    legacy.record = record;
    legacy.payloadHash = createHash('sha256').update(JSON.stringify(record)).digest('hex');

    await expect(fixture.store.consume(NODE_ID, batch(grant, record))).resolves.toEqual(
      accepted(record)
    );
    expect(fixture.mysql.rows).toHaveLength(1);
    expect(legacy.record).toEqual(record);
  });

  it('records missing token fields as zero and preserves late authoritative usage', async () => {
    const fixture = storeFixture();
    const grant = fixture.grants.issue(NODE_ID, USER_ID, 'work');
    const missing = usageRecord({
      scopeId: grant.scopeId,
      inputTokens: undefined,
      outputTokens: undefined
    });
    await expect(fixture.store.consume(NODE_ID, batch(grant, missing))).resolves.toEqual(
      accepted(missing)
    );
    expect(fixture.mysql.rows[0]?.record).toMatchObject({
      inputTokens: '0',
      outputTokens: '0',
      cacheReadTokens: '0',
      cacheWriteTokens: '0',
      reasoningTokens: '0'
    });
    const revised = { ...missing, revision: 2, inputTokens: '17' };
    await expect(fixture.store.consume(NODE_ID, batch(grant, revised))).resolves.toEqual(
      accepted(revised)
    );
    expect(fixture.mysql.rows).toHaveLength(1);
    expect(fixture.mysql.rows[0]?.record).toMatchObject({ inputTokens: '17', outputTokens: '0' });
  });

  it('accepts a record idempotently, rejects a changed same revision, and updates higher revisions', async () => {
    const fixture = storeFixture();
    const grant = fixture.grants.issue(NODE_ID, USER_ID, 'work');
    const first = usageRecord({ scopeId: grant.scopeId });

    await expect(fixture.store.consume(NODE_ID, batch(grant, first))).resolves.toEqual(
      accepted(first)
    );
    await expect(fixture.store.consume(NODE_ID, batch(grant, first))).resolves.toEqual(
      accepted(first)
    );
    expect(fixture.mysql.rows).toHaveLength(1);
    expect(fixture.mysql.rows[0]).toMatchObject({ revision: 1, mode: 'work', outputTokens: '5' });

    const conflicting = usageRecord({ scopeId: grant.scopeId, outputTokens: '6' });
    await expect(fixture.store.consume(NODE_ID, batch(grant, conflicting))).resolves.toEqual({
      apiVersion: 1,
      results: [{ recordId: 'record-1', revision: 1, status: 'rejected', code: 'USAGE_CONFLICT' }]
    });
    expect(fixture.mysql.rows[0]).toMatchObject({ revision: 1, outputTokens: '5' });

    const revised = usageRecord({ scopeId: grant.scopeId, revision: 2, outputTokens: '8' });
    await expect(fixture.store.consume(NODE_ID, batch(grant, revised))).resolves.toEqual(
      accepted(revised)
    );
    expect(fixture.mysql.rows[0]).toMatchObject({ revision: 2, outputTokens: '8' });

    const old = usageRecord({ scopeId: grant.scopeId, outputTokens: '9' });
    await expect(fixture.store.consume(NODE_ID, batch(grant, old))).resolves.toEqual(accepted(old));
    expect(fixture.mysql.rows[0]).toMatchObject({ revision: 2, outputTokens: '8' });
  });

  it('rejects a deleted user before recording usage', async () => {
    const fixture = storeFixture();
    const grant = fixture.grants.issue(NODE_ID, USER_ID, 'conversation');
    fixture.mysql.users.delete(USER_ID);

    await expect(
      fixture.store.consume(NODE_ID, batch(grant, usageRecord({ scopeId: grant.scopeId })))
    ).resolves.toEqual({
      apiVersion: 1,
      results: [
        { recordId: 'record-1', revision: 1, status: 'rejected', code: 'USAGE_USER_DELETED' }
      ]
    });
    expect(fixture.mysql.rows).toEqual([]);
    expect(
      fixture.mysql.connection.execute.mock.calls.some(([sql]) =>
        String(sql).startsWith('INSERT INTO')
      )
    ).toBe(false);
  });

  it('rejects a grant used by another node', async () => {
    const fixture = storeFixture();
    const grant = fixture.grants.issue(NODE_ID, USER_ID, 'work');

    await expect(
      fixture.store.consume('other-node', batch(grant, usageRecord({ scopeId: grant.scopeId })))
    ).resolves.toEqual({
      apiVersion: 1,
      results: [
        { recordId: 'record-1', revision: 1, status: 'rejected', code: 'USAGE_GRANT_INVALID' }
      ]
    });
  });
});

describe('ModelUsageQueryService', () => {
  it('bounds the model filter to the stored identity length', () => {
    const model = 'm'.repeat(800);
    expect(personalUsageQuerySchema.safeParse(query({ model })).success).toBe(true);
    expect(personalUsageQuerySchema.safeParse(query({ model: `${model}x` })).success).toBe(false);
  });

  it('keeps positive range and 90-day limits for future queries', () => {
    const range = { ...query(), from: NOW, to: NOW + MODEL_USAGE_RETENTION_MS };
    expect(personalUsageQuerySchema.safeParse(range).success).toBe(true);
    for (const duration of [0, -1, MODEL_USAGE_RETENTION_MS + 1]) {
      expect(personalUsageQuerySchema.safeParse({ ...range, to: NOW + duration }).success).toBe(
        false
      );
    }
  });

  it('reads both rolling totals in one scan without applying the selected chart filters', async () => {
    const fixture = queryFixture();
    fixture.connection.execute.mockResolvedValueOnce([
      [
        {
          recent: '0',
          inputTokens: '9007199254740993',
          outputTokens: '2',
          cacheReadTokens: '7',
          cacheWriteTokens: '3',
          requests: '2',
          completeRequests: '2'
        },
        {
          recent: 1,
          inputTokens: '11',
          outputTokens: '5',
          cacheReadTokens: '4',
          cacheWriteTokens: '1',
          requests: '1',
          completeRequests: '1'
        }
      ],
      []
    ]);
    const service = new ModelUsageQueryService(fixture.pool as never, () => NOW);
    const overview = await service.overview(
      USER_ID,
      query({ runner: 'codex', model: 'selected-model', mode: 'conversation', purpose: 'compact' })
    );
    expect(overview.last24Hours).toMatchObject({
      inputTokens: '11',
      outputTokens: '5',
      totalTokens: '16',
      cacheReadTokens: '4',
      cacheWriteTokens: '1',
      requests: '1'
    });
    expect(overview.last7Days).toMatchObject({
      inputTokens: '9007199254741004',
      outputTokens: '7',
      totalTokens: '9007199254741011',
      cacheReadTokens: '11',
      cacheWriteTokens: '4',
      requests: '3',
      completeRequests: '3'
    });
    const rollingReads = fixture.connection.execute.mock.calls.filter(
      ([sql]) => sql.includes('SUM(input_tokens)') && !sql.includes('GROUP BY bucket')
    );
    expect(rollingReads).toHaveLength(1);
    expect(rollingReads[0]?.[1]).toEqual([
      NOW - 86_400_000,
      USER_ID,
      'compact',
      NOW - 7 * 86_400_000,
      NOW
    ]);
    expect(fixture.connection.beginTransaction).toHaveBeenCalledTimes(1);
    expect(fixture.connection.commit).toHaveBeenCalledTimes(1);
    expect(fixture.connection.release).toHaveBeenCalledTimes(1);
  });

  it('returns empty rolling totals when the seven-day scan has no records', async () => {
    const fixture = queryFixture();
    fixture.connection.execute.mockResolvedValueOnce([[], []]);
    const overview = await new ModelUsageQueryService(fixture.pool as never, () => NOW).overview(
      USER_ID,
      query()
    );
    for (const totals of [overview.last24Hours, overview.last7Days]) {
      expect(totals).toMatchObject({
        inputTokens: '0',
        outputTokens: '0',
        totalTokens: '0',
        requests: '0',
        cacheReadTokens: '0',
        cacheWriteTokens: '0',
        completeRequests: '0',
        partialRequests: '0',
        unknownRequests: '0'
      });
    }
  });

  it.each([undefined, 'compact', 'prompt_completion'] as const)(
    'isolates overview, chart and record queries to purpose %s',
    async (purpose) => {
      const fixture = queryFixture();
      const service = new ModelUsageQueryService(fixture.pool as never, () => NOW);
      const selected = query(purpose ? { purpose } : {});
      await service.overview(USER_ID, selected);
      await service.records(USER_ID, selected);
      const reads = fixture.connection.execute.mock.calls;
      const ledgerReads = reads.filter(([sql]) => sql.includes('FROM model_usage_records'));
      expect(ledgerReads.length).toBeGreaterThan(3);
      for (const [sql, values] of ledgerReads) {
        expect(sql).toContain('purpose=?');
        expect(values).toContain(purpose ?? 'conversation');
      }
    }
  );

  it('returns a real filtered total and supports direct page jumps within a single read transaction', async () => {
    const rows = Array.from({ length: 61 }, (_, index) => userRecord(index + 1));
    const execute = vi.fn(async (sql: string, _values: unknown[]) => {
      if (sql.includes('COUNT(*) AS CHAR')) return [[{ total: '61' }], []];
      const offset = Number(sql.match(/OFFSET (\d+)/u)?.[1] ?? 0);
      return [rows.slice(offset, offset + 21), []];
    });
    const connection = {
      execute,
      query: vi.fn(),
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn()
    };
    const service = new ModelUsageQueryService(
      { getConnection: async () => connection } as never,
      () => NOW
    );
    const selected = query({ runner: 'codex' });
    const page = await service.records(USER_ID, selected, undefined, 4);
    expect(page).toMatchObject({ total: '61', page: 4, nextCursor: null });
    expect(page.records.map((record) => record.recordId)).toEqual(['record-user-61']);
    expect(execute.mock.calls[1]?.[0]).toContain('OFFSET 60');
    expect(execute.mock.calls[0]?.[1]).toEqual(execute.mock.calls[1]?.[1]);
    expect(execute.mock.calls[0]?.[1]).toContain('codex');
    expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
    const clamped = await service.records(USER_ID, selected, undefined, 5);
    expect(clamped.page).toBe(4);
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER])
      await expect(service.records(USER_ID, selected, undefined, invalid)).rejects.toMatchObject({
        code: 'USAGE_QUERY_INVALID'
      });
  });
  it('rolls back a failed page read and releases its connection', async () => {
    const fixture = queryFixture();
    fixture.connection.execute.mockRejectedValueOnce(new Error('database failed'));
    const service = new ModelUsageQueryService(fixture.pool as never, () => NOW);
    await expect(service.records(USER_ID, query(), undefined, 1)).rejects.toThrow(
      'database failed'
    );
    expect(fixture.connection.rollback).toHaveBeenCalledTimes(1);
    expect(fixture.connection.release).toHaveBeenCalledTimes(1);
  });
  it('returns 20 records and anchors the next cursor to the last visible record', async () => {
    const rows = Array.from({ length: 21 }, (_, index) => userRecord(index + 1));
    let reads = 0;
    const connection = {
      query: vi.fn(async () => [[], []]),
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
      execute: vi.fn(async (sql: string, _values: unknown[]) =>
        sql.includes('COUNT(*) AS CHAR')
          ? [[{ total: '21' }], []]
          : [reads++ === 0 ? rows : [rows[20]], []]
      )
    };
    const pool = { getConnection: vi.fn(async () => connection) };
    const service = new ModelUsageQueryService(pool as never, () => NOW);
    const first = await service.records(USER_ID, query());
    expect(first.records).toHaveLength(20);
    expect(first.records.at(-1)?.recordId).toBe('record-user-20');
    expect(connection.execute.mock.calls[1]?.[0]).toContain('LIMIT 21');
    expect(first.total).toBe('21');
    expect(first.nextCursor).not.toBeNull();
    const second = await service.records(USER_ID, query(), first.nextCursor!);
    expect(connection.execute.mock.calls[3]?.[1].slice(-3)).toEqual([
      rows[19]!.ended_at,
      rows[19]!.ended_at,
      rows[19]!.source_key
    ]);
    expect(second.records.map((row) => row.recordId)).toEqual(['record-user-21']);
    expect(second.nextCursor).toBeNull();
  });

  it('accepts ranges ending in the future and preserves exact BigInt totals', async () => {
    const fixture = queryFixture();
    const service = new ModelUsageQueryService(fixture.pool as never, () => NOW);
    const validQuery = query({ from: NOW - 86_400_000, to: NOW + 7 * 86_400_000 });

    const overview = await service.overview(USER_ID, validQuery);
    const expected = (BigInt(fixture.bigInput) + BigInt(fixture.bigOutput)).toString();
    expect(overview.last24Hours).toMatchObject({
      inputTokens: fixture.bigInput,
      outputTokens: fixture.bigOutput,
      cacheReadTokens: fixture.cacheReadTokens,
      cacheWriteTokens: '0',
      totalTokens: expected
    });
    expect(overview.selected.totalTokens).toBe(expected);
    expect(overview.selected.cacheReadTokens).toBe(fixture.cacheReadTokens);
    expect(overview.buckets.at(-1)?.to).toBe(NOW);
    expect(overview.buckets[0]?.cacheReadTokens).toBe(fixture.cacheReadTokens);
    expect(overview.runners[0]?.cacheReadTokens).toBe(fixture.cacheReadTokens);
    expect(overview.models[0]?.cacheReadTokens).toBe(fixture.cacheReadTokens);
    const metadataCall = fixture.connection.execute.mock.calls.find(([sql]) =>
      String(sql).includes('MIN(started_at) AS firstRecordedAt')
    );
    expect(metadataCall?.[1]?.at(-1)).toBe(NOW);

    const records = await service.records(USER_ID, validQuery);
    expect(records.records[0]).toMatchObject({
      recordId: 'record-user-42',
      totalTokens: expected,
      mode: 'work'
    });
  });

  it.each([null, '0'])('returns zero for missing aggregate cache values: %s', async (cache) => {
    const fixture = queryFixture(cache);
    const overview = await new ModelUsageQueryService(fixture.pool as never, () => NOW).overview(
      USER_ID,
      query()
    );
    for (const total of [
      overview.last24Hours,
      overview.last7Days,
      overview.selected,
      ...overview.buckets,
      ...overview.runners,
      ...overview.models
    ])
      expect(total.cacheReadTokens).toBe('0');
  });

  it('returns zero-filled legacy records and sums the available input and output', async () => {
    const fixture = queryFixture();
    const row = userRecord(USER_ID);
    row.record = JSON.stringify(usageRecord({ inputTokens: undefined, outputTokens: '5' }));
    fixture.connection.execute.mockImplementation(async (sql: string) =>
      sql.includes('COUNT(*) AS CHAR') ? [[{ total: '1' }], []] : [[row], []]
    );
    const result = await new ModelUsageQueryService(fixture.pool as never, () => NOW).records(
      USER_ID,
      query()
    );
    expect(result.records[0]).toMatchObject({
      inputTokens: '0',
      outputTokens: '5',
      totalTokens: '5',
      cacheReadTokens: '0',
      cacheWriteTokens: '0',
      reasoningTokens: '0'
    });
  });

  it('caps future range ends at the current snapshot before reading records', async () => {
    const fixture = queryFixture();
    const service = new ModelUsageQueryService(fixture.pool as never, () => NOW);

    await service.records(USER_ID, query({ to: NOW + 7 * 86_400_000 }));

    const recordsCall = fixture.connection.execute.mock.calls.find(([sql]) =>
      String(sql).includes('SELECT source_key,ended_at,mode,record')
    );
    expect(recordsCall?.[1]).toEqual([USER_ID, NOW - 86_400_000, NOW, 'conversation']);
  });

  it('returns an empty result for an entirely future range', async () => {
    const fixture = queryFixture();
    fixture.connection.execute.mockImplementation(async (sql: string) =>
      sql.includes('CAST(COUNT(*) AS CHAR)') ? [[{ total: '0' }], []] : [[], []]
    );
    const service = new ModelUsageQueryService(fixture.pool as never, () => NOW);
    const selected = query({ from: NOW + 86_400_000, to: NOW + 2 * 86_400_000 });

    const overview = await service.overview(USER_ID, selected);
    expect(overview.buckets).toEqual([]);
    expect(overview.selected.requests).toBe('0');
    const records = await service.records(USER_ID, selected);
    expect(records).toMatchObject({ total: '0', records: [], nextCursor: null });
    const recordsCall = fixture.connection.execute.mock.calls.find(([sql]) =>
      sql.includes('SELECT source_key,ended_at,mode,record')
    );
    expect(recordsCall?.[1]).toEqual([USER_ID, selected.from, NOW, 'conversation']);
  });

  it('accepts a cursor for the same query regardless of parameter property order', async () => {
    const fixture = queryFixture();
    const service = new ModelUsageQueryService(fixture.pool as never, () => NOW);
    const reorderedQuery = {
      timeZone: 'UTC',
      to: NOW,
      from: NOW - 86_400_000
    } as PersonalUsageQuery;
    const cursor = Buffer.from(
      JSON.stringify({
        userId: USER_ID,
        query: reorderedQuery,
        time: NOW - 500,
        key: 'a'.repeat(64)
      })
    ).toString('base64url');

    await expect(service.records(USER_ID, query(), cursor)).resolves.toBeDefined();
  });

  it('filters records by user so one user cannot receive another user’s usage', async () => {
    const fixture = queryFixture();
    const service = new ModelUsageQueryService(fixture.pool as never, () => NOW);
    const queryValue = query({ from: NOW - 86_400_000, to: NOW });

    const first = await service.records(7, queryValue);
    const second = await service.records(8, queryValue);

    expect(first.records.map((record) => record.recordId)).toEqual(['record-user-7']);
    expect(second.records.map((record) => record.recordId)).toEqual(['record-user-8']);
    expect(
      fixture.connection.execute.mock.calls
        .filter(([sql]) => sql.includes('SELECT source_key'))
        .map(([, values]) => values?.[0])
    ).toEqual([7, 8]);
  });

  it('uses local calendar boundaries across spring-forward and fall-back DST transitions', () => {
    const springFrom = Date.parse('2024-03-09T00:00:00-05:00');
    const springTo = Date.parse('2024-03-11T00:00:00-04:00');
    const fallFrom = Date.parse('2024-11-02T00:00:00-04:00');
    const fallTo = Date.parse('2024-11-04T00:00:00-05:00');

    expect(
      usageBucketRanges(springFrom, springTo, 'America/New_York').map(
        (range) => range.to - range.from
      )
    ).toEqual([24 * 60 * 60 * 1_000, 23 * 60 * 60 * 1_000]);
    expect(
      usageBucketRanges(fallFrom, fallTo, 'America/New_York').map((range) => range.to - range.from)
    ).toEqual([24 * 60 * 60 * 1_000, 25 * 60 * 60 * 1_000]);
  });

  it('enforces the protocol query window limit before querying', () => {
    const base = { from: 0, timeZone: 'UTC' };
    expect(
      personalUsageQuerySchema.safeParse({ ...base, to: MODEL_USAGE_RETENTION_MS }).success
    ).toBe(true);
    expect(
      personalUsageQuerySchema.safeParse({ ...base, to: MODEL_USAGE_RETENTION_MS + 1 }).success
    ).toBe(false);
  });
});

interface StoredUsageRow {
  sourceKey: string;
  userId: number;
  nodeId: string;
  recordId: string;
  revision: number;
  payloadHash: string;
  identityHash: string;
  mode: string;
  outputTokens: string | null;
  record: ModelUsageRecord;
  endedAt: number | null;
  startedAt: number;
}

class FakeUsageMysql {
  readonly users = new Set([USER_ID]);
  readonly rows: StoredUsageRow[] = [];
  readonly connection = {
    beginTransaction: vi.fn(async () => undefined),
    execute: vi.fn((sql: string, values: readonly unknown[] = []) => this.execute(sql, values)),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn()
  };
  readonly pool = {
    execute: vi.fn((sql: string, values: readonly unknown[] = []) => this.execute(sql, values)),
    getConnection: vi.fn(async () => this.connection)
  };

  private async execute(sql: string, values: readonly unknown[]): Promise<[unknown, unknown]> {
    if (sql.startsWith('SELECT id FROM users')) {
      return [this.users.has(Number(values[0])) ? [{ id: Number(values[0]) }] : [], []];
    }
    if (sql.startsWith('SELECT revision,payload_hash,identity_hash')) {
      const row = this.rows.find((candidate) => candidate.sourceKey === String(values[0]));
      return [
        row
          ? [
              {
                revision: row.revision,
                payload_hash: row.payloadHash,
                identity_hash: row.identityHash
              }
            ]
          : [],
        []
      ];
    }
    if (sql.startsWith('INSERT INTO model_usage_records')) {
      const [
        sourceKey,
        userId,
        nodeId,
        recordId,
        revision,
        payloadHash,
        identityHash,
        ,
        mode,
        ,
        ,
        ,
        startedAt,
        endedAt,
        ,
        ,
        outputTokens,
        payload
      ] = values;
      const record = JSON.parse(String(payload)) as ModelUsageRecord;
      this.rows.push({
        sourceKey: String(sourceKey),
        userId: Number(userId),
        nodeId: String(nodeId),
        recordId: String(recordId),
        revision: Number(revision),
        payloadHash: String(payloadHash),
        identityHash: String(identityHash),
        mode: String(mode),
        outputTokens: outputTokens == null ? null : String(outputTokens),
        record,
        endedAt: endedAt == null ? null : Number(endedAt),
        startedAt: Number(startedAt)
      });
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith('UPDATE model_usage_records SET')) {
      const [revision, payloadHash, , , endedAt, , , outputTokens, payload, sourceKey] = values;
      const row = this.rows.find((candidate) => candidate.sourceKey === String(sourceKey));
      if (row) {
        row.revision = Number(revision);
        row.payloadHash = String(payloadHash);
        row.outputTokens = outputTokens == null ? null : String(outputTokens);
        row.record = JSON.parse(String(payload)) as ModelUsageRecord;
        row.endedAt = endedAt == null ? null : Number(endedAt);
      }
      return [{ affectedRows: row ? 1 : 0 }, []];
    }
    if (sql.startsWith('DELETE FROM model_usage_records')) {
      const threshold = Number(values[0]);
      const retained = this.rows.filter((row) => (row.endedAt ?? row.startedAt) >= threshold);
      const affectedRows = this.rows.length - retained.length;
      this.rows.splice(0, this.rows.length, ...retained);
      return [{ affectedRows }, []];
    }
    throw new Error(`UNEXPECTED_SQL:${sql}`);
  }
}

function storeFixture() {
  const mysql = new FakeUsageMysql();
  const grants = new ModelUsageGrants(Buffer.from('test-signing-key'), () => NOW);
  const store = new ModelUsageStore(mysql.pool as never, grants, () => NOW);
  return { mysql, grants, store };
}

interface QueryRow {
  source_key: string;
  ended_at: number;
  mode: 'work' | 'conversation';
  record: string;
}

class FakeQueryMysql {
  readonly bigInput = '900719925474099312345678901234567890';
  cacheReadTokens: string | null = (BigInt(this.bigInput) / 4n).toString();
  readonly bigOutput = '12345678901234567890123456789012345678';
  readonly pool = {
    execute: vi.fn((sql: string, values: readonly unknown[] = []) => this.execute(sql, values)),
    getConnection: vi.fn(async () => this.connection)
  };
  readonly connection = {
    query: vi.fn(async (_sql: string) => [[], []]),
    execute: vi.fn((sql: string, values: readonly unknown[] = []) => this.execute(sql, values)),
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn()
  };

  private async execute(sql: string, values: readonly unknown[]): Promise<[unknown, unknown]> {
    if (sql.includes('MIN(started_at) AS firstRecordedAt')) {
      return [[{ firstRecordedAt: NOW - 10_000, lastReceivedAt: NOW - 500 }], []];
    }
    if (sql.includes('GROUP BY bucket,runner,BINARY model_key')) {
      return [
        [
          {
            bucket: 0,
            runner: 'mar-agent',
            model_key: '["mar-agent","provider","model"]',
            model_name: 'Test model',
            inputTokens: this.bigInput,
            outputTokens: this.bigOutput,
            cacheReadTokens: this.cacheReadTokens,
            cacheWriteTokens: '0',
            requests: '1',
            completeRequests: '1',
            partialRequests: '0',
            unknownRequests: '0'
          }
        ],
        []
      ];
    }
    if (sql.includes('COALESCE(SUM(input_tokens)')) {
      return [
        [
          {
            recent: 1,
            inputTokens: this.bigInput,
            outputTokens: this.bigOutput,
            cacheReadTokens: this.cacheReadTokens,
            cacheWriteTokens: '0',
            requests: '1',
            completeRequests: '1',
            partialRequests: '0',
            unknownRequests: '0'
          }
        ],
        []
      ];
    }
    if (sql.includes('CAST(COUNT(*) AS CHAR) AS total')) return [[{ total: '1' }], []];
    if (sql.includes('SELECT source_key,ended_at,mode,record')) {
      const userId = Number(values[0]);
      return [[userRecord(userId)], []];
    }
    throw new Error(`UNEXPECTED_SQL:${sql}`);
  }
}

function queryFixture(cacheReadTokens?: string | null) {
  const mysql = new FakeQueryMysql();
  if (cacheReadTokens !== undefined) mysql.cacheReadTokens = cacheReadTokens;
  mysql.connection.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SET TRANSACTION')) return [[], []];
    if (sql === 'START TRANSACTION') return [[], []];
    throw new Error(`UNEXPECTED_QUERY:${sql}`);
  });
  return {
    pool: mysql.pool,
    connection: mysql.connection,
    bigInput: mysql.bigInput,
    cacheReadTokens: mysql.cacheReadTokens,
    bigOutput: mysql.bigOutput
  };
}

function query(overrides: Partial<PersonalUsageQuery> = {}): PersonalUsageQuery {
  return {
    from: NOW - 86_400_000,
    to: NOW,
    timeZone: 'UTC',
    ...overrides
  };
}

function usageRecord(overrides: Partial<ModelUsageRecord> = {}): ModelUsageRecord {
  return {
    schemaVersion: 1,
    recordId: 'record-1',
    requestId: 'request-1',
    revision: 1,
    scopeId: SCOPE_ID,
    runner: 'mar-agent',
    sessionId: 'session-1',
    runId: 'run-1',
    modelConfigurationId: 'configuration-1',
    modelName: 'Test model',
    provider: 'test-provider',
    requestedModel: 'requested-model',
    purpose: 'conversation',
    agentRole: 'root',
    startedAt: NOW - 1_000,
    endedAt: NOW - 500,
    state: 'succeeded',
    inputTokens: '10',
    outputTokens: '5',
    coverage: 'request',
    ...overrides
  };
}

function batch(grant: ModelUsageGrant, record: ModelUsageRecord) {
  return { apiVersion: 1 as const, entries: [{ grant, record }] };
}

function accepted(record: ModelUsageRecord) {
  return {
    apiVersion: 1 as const,
    results: [{ recordId: record.recordId, revision: record.revision, status: 'accepted' as const }]
  };
}

function userRecord(userId: number): QueryRow {
  const record = usageRecord({
    recordId: `record-user-${userId}`,
    inputTokens: '900719925474099312345678901234567890',
    outputTokens: '12345678901234567890123456789012345678'
  });
  return {
    source_key: `${String(userId).padStart(2, '0')}${'a'.repeat(62)}`,
    ended_at: NOW - 500,
    mode: 'work',
    record: JSON.stringify(record)
  };
}
