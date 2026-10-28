import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  MODEL_USAGE_OUTBOX_RETENTION_MS,
  type ModelUsageGrant,
  type ModelUsageRecord,
  type NodeEnvelope
} from '@myagentroam/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate, NodeDatabase } from '../../src/database.js';
import { NODE_SCHEMA_V13 } from '../../src/migrations/v013.js';
import { NODE_SCHEMA_MIGRATION_V14 } from '../../src/migrations/v014.js';
import { NODE_SCHEMA_MIGRATION_V15 } from '../../src/migrations/v015.js';
import { NODE_SCHEMA_MIGRATION_V16 } from '../../src/migrations/v016.js';
import { ModelUsageOutbox } from '../../src/service/model-usage-outbox.js';
import { NodeModelUsageService } from '../../src/service/model-usage-service.js';

const SCOPE_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_SCOPE_ID = '00000000-0000-0000-0000-000000000002';
const GRANT: ModelUsageGrant = { scopeId: SCOPE_ID, token: 'grant-token' };
const directories: string[] = [];
const outboxes: ModelUsageOutbox[] = [];

afterEach(async () => {
  for (const outbox of outboxes.splice(0)) outbox.disconnected();
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('model usage outbox schema', () => {
  it('migrates an existing Node database with the released ledger SQL layout', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(
        NODE_SCHEMA_V13.replace(
          /CREATE TABLE node_schema_migrations \([\s\S]*?\) STRICT;/,
          'CREATE TABLE node_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;'
        )
      );
      for (const migration of [
        NODE_SCHEMA_MIGRATION_V14,
        NODE_SCHEMA_MIGRATION_V15,
        NODE_SCHEMA_MIGRATION_V16
      ]) {
        database.exec(migration.sql);
      }
      for (let version = 13; version <= 16; version++)
        database.prepare('INSERT INTO node_schema_migrations VALUES (?, 1)').run(version);

      migrate(database);
      expect(
        database.prepare('SELECT version FROM node_schema_migrations ORDER BY version').all()
      ).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21].map((version) => ({ version })));
    } finally {
      database.close();
    }
  });

  it('creates and validates migration v017 through NodeDatabase', () => {
    const database = new NodeDatabase(':memory:', 'model-usage-v017');
    try {
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
        { version: 20 },
        { version: 21 }
      ]);
      expect(
        database.raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='model_usage_outbox'"
          )
          .get()
      ).toEqual({ name: 'model_usage_outbox' });
      expect(database.raw.prepare('PRAGMA table_info(model_usage_outbox)').all()).toEqual(
        expect.arrayContaining(
          [
            ['namespace', 0],
            ['record_id', 1],
            ['revision', 2],
            ['payload', 3],
            ['bytes', 4],
            ['updated_at', 5],
            ['ended_at', 6]
          ].map(([name, cid]) => expect.objectContaining({ name, cid }))
        )
      );
      expect(
        database.raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='model_usage_outbox_updated'"
          )
          .get()
      ).toEqual({ name: 'model_usage_outbox_updated' });
    } finally {
      database.close();
    }
  });
});

describe('ModelUsageOutbox', () => {
  it('persists running usage and recovers it as an interrupted revision after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-model-usage-outbox-restart-'));
    directories.push(directory);
    const path = join(directory, 'node.sqlite');
    const firstDatabase = new NodeDatabase(path, 'node-1');
    const first = createHarness(firstDatabase, 'node-1', 1_000);
    try {
      first.outbox.record(GRANT, usageRecord({ state: 'running', endedAt: undefined }));
      expect(readPayload(firstDatabase, 'node-1', 'record-1')?.record).toMatchObject({
        revision: 1,
        state: 'running'
      });
    } finally {
      firstDatabase.close();
    }

    const restartedDatabase = new NodeDatabase(path, 'node-1');
    const restarted = createHarness(restartedDatabase, 'node-1', 5_000);
    try {
      restarted.outbox.recoverInterrupted();
      expect(readPayload(restartedDatabase, 'node-1', 'record-1')?.record).toMatchObject({
        revision: 2,
        state: 'interrupted',
        startedAt: 1_000,
        endedAt: 5_000
      });
      expect(restarted.diagnostics).toEqual([]);
    } finally {
      restartedDatabase.close();
    }
  });

  it('does not send while disconnected and requires the v1 handshake capability', async () => {
    vi.useFakeTimers();
    const database = new NodeDatabase(':memory:', 'model-usage-handshake');
    const harness = createHarness(database, 'node-1');
    try {
      harness.outbox.connected({ modelUsage: { apiVersion: 1 } });
      harness.outbox.record(GRANT, usageRecord());
      harness.outbox.disconnected();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.sent).toEqual([]);

      harness.outbox.connected({ modelUsage: { apiVersion: 2 } });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.sent).toEqual([]);

      harness.outbox.connected({ modelUsage: { apiVersion: 1 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.sent).toHaveLength(1);
      expect(harness.sent[0]?.payload).toMatchObject({
        apiVersion: 1,
        entries: [
          {
            record: { recordId: 'record-1', revision: 1, state: 'succeeded' }
          }
        ]
      });
    } finally {
      database.close();
    }
  });

  it('keeps running records on disk but only batches terminal records', async () => {
    vi.useFakeTimers();
    const database = new NodeDatabase(':memory:', 'model-usage-running');
    const harness = createHarness(database, 'node-1');
    try {
      harness.outbox.connected({ modelUsage: { apiVersion: 1 } });
      harness.outbox.record(GRANT, usageRecord({ state: 'running', endedAt: undefined }));
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.sent).toEqual([]);
      expect(readPayload(database, 'node-1', 'record-1')?.record.state).toBe('running');

      harness.outbox.record(GRANT, usageRecord({ revision: 2 }));
      await vi.advanceTimersByTimeAsync(250);
      expect(harness.sent).toHaveLength(1);
      expect(harness.sent[0]?.payload).toMatchObject({
        entries: [{ record: { recordId: 'record-1', revision: 2, state: 'succeeded' } }]
      });
    } finally {
      database.close();
    }
  });

  it('keeps updated rows when an old ACK arrives and handles current and duplicate ACKs idempotently', async () => {
    vi.useFakeTimers();
    const database = new NodeDatabase(':memory:', 'model-usage-ack');
    const harness = createHarness(database, 'node-1');
    try {
      harness.outbox.connected({ modelUsage: { apiVersion: 1 } });
      harness.outbox.record(GRANT, usageRecord());
      await vi.advanceTimersByTimeAsync(250);
      expect(harness.sent[0]?.payload).toMatchObject({
        entries: [{ record: { recordId: 'record-1', revision: 1 } }]
      });

      harness.outbox.record(GRANT, usageRecord({ revision: 2, outputTokens: '8' }));
      expect(readPayload(database, 'node-1', 'record-1')?.record).toMatchObject({
        revision: 2,
        outputTokens: '8'
      });

      expect(
        harness.outbox.handle(ack([{ recordId: 'record-1', revision: 1, status: 'accepted' }]))
      ).toBe(true);
      expect(readPayload(database, 'node-1', 'record-1')?.record.revision).toBe(2);

      await vi.advanceTimersByTimeAsync(250);
      expect(harness.sent).toHaveLength(2);
      expect(harness.sent[1]?.payload).toMatchObject({
        entries: [{ record: { recordId: 'record-1', revision: 2, outputTokens: '8' } }]
      });

      const currentAck = ack([{ recordId: 'record-1', revision: 2, status: 'accepted' }]);
      expect(harness.outbox.handle(currentAck)).toBe(true);
      expect(readPayload(database, 'node-1', 'record-1')).toBeUndefined();
      expect(harness.outbox.handle(currentAck)).toBe(true);
      expect(readPayload(database, 'node-1', 'record-1')).toBeUndefined();
      expect(harness.outbox.handle({ ...currentAck, type: 'other' })).toBe(false);
    } finally {
      database.close();
    }
  });

  it('retries an in-flight batch until the matching ACK arrives', async () => {
    vi.useFakeTimers();
    const database = new NodeDatabase(':memory:', 'model-usage-retry');
    const harness = createHarness(database, 'node-1');
    try {
      harness.outbox.connected({ modelUsage: { apiVersion: 1 } });
      harness.outbox.record(GRANT, usageRecord());
      await vi.advanceTimersByTimeAsync(250);
      expect(harness.sent).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.sent).toHaveLength(2);
      expect(harness.sent[1]?.payload).toMatchObject({
        entries: [{ record: { recordId: 'record-1', revision: 1 } }]
      });

      harness.outbox.handle(ack([{ recordId: 'record-1', revision: 1, status: 'accepted' }]));
      expect(readPayload(database, 'node-1', 'record-1')).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('diagnoses rejected ACKs with the server code', async () => {
    vi.useFakeTimers();
    const database = new NodeDatabase(':memory:', 'model-usage-rejected');
    const harness = createHarness(database, 'node-1');
    try {
      harness.outbox.connected({ modelUsage: { apiVersion: 1 } });
      harness.outbox.record(GRANT, usageRecord());
      await vi.advanceTimersByTimeAsync(250);

      expect(
        harness.outbox.handle(
          ack([
            {
              recordId: 'record-1',
              revision: 1,
              status: 'rejected',
              code: 'USAGE_EXPIRED'
            }
          ])
        )
      ).toBe(true);
      expect(harness.diagnostics).toEqual(['USAGE_EXPIRED']);
      expect(readPayload(database, 'node-1', 'record-1')).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('diagnoses and removes rows that exceed outbox retention', async () => {
    vi.useFakeTimers();
    const database = new NodeDatabase(':memory:', 'model-usage-expired');
    const harness = createHarness(database, 'node-1', MODEL_USAGE_OUTBOX_RETENTION_MS + 1_000);
    try {
      database.raw
        .prepare(
          'INSERT INTO model_usage_outbox(namespace,record_id,revision,payload,bytes,updated_at,ended_at) VALUES (?,?,?,?,?,?,?)'
        )
        .run('node-1', 'expired-record', 1, '{}', 2, 1, 1);

      harness.outbox.connected({ modelUsage: { apiVersion: 1 } });
      expect(harness.diagnostics).toEqual(['USAGE_OUTBOX_EXPIRED']);
      expect(readPayload(database, 'node-1', 'expired-record')).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('expires stale running rows before restart recovery can finalize them', () => {
    const database = new NodeDatabase(':memory:', 'model-usage-stale-running');
    const harness = createHarness(database, 'node-1', MODEL_USAGE_OUTBOX_RETENTION_MS + 1_000);
    try {
      const payload = JSON.stringify({
        grant: GRANT,
        record: usageRecord({ state: 'running', endedAt: undefined })
      });
      database.raw
        .prepare(
          'INSERT INTO model_usage_outbox(namespace,record_id,revision,payload,bytes,updated_at,ended_at) VALUES (?,?,?,?,?,?,?)'
        )
        .run('node-1', 'record-1', 1, payload, Buffer.byteLength(payload), 1, null);

      harness.outbox.recoverInterrupted();

      expect(harness.diagnostics).toEqual(['USAGE_OUTBOX_EXPIRED']);
      expect(readPayload(database, 'node-1', 'record-1')).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('diagnoses a full outbox without dropping the existing row', () => {
    const database = new NodeDatabase(':memory:', 'model-usage-capacity');
    const harness = createHarness(database, 'node-1');
    try {
      database.raw
        .prepare(
          'INSERT INTO model_usage_outbox(namespace,record_id,revision,payload,bytes,updated_at,ended_at) VALUES (?,?,?,?,?,?,?)'
        )
        .run('node-1', 'large-row', 1, '{}', 32 * 1024 * 1024, 1_000, 1_000);

      harness.outbox.record(GRANT, usageRecord());
      expect(harness.diagnostics).toEqual(['USAGE_OUTBOX_FULL']);
      expect(
        database.raw
          .prepare('SELECT record_id FROM model_usage_outbox WHERE namespace=? ORDER BY record_id')
          .all('node-1')
      ).toEqual([{ record_id: 'large-row' }]);
    } finally {
      database.close();
    }
  });

  it('isolates rows and ACK deletion by namespace', async () => {
    vi.useFakeTimers();
    const database = new NodeDatabase(':memory:', 'model-usage-namespaces');
    const first = createHarness(database, 'namespace-a');
    const second = createHarness(database, 'namespace-b');
    try {
      first.outbox.record(GRANT, usageRecord());
      second.outbox.record(GRANT, usageRecord());
      expect(readPayload(database, 'namespace-a', 'record-1')?.record).toMatchObject({
        revision: 1
      });
      expect(readPayload(database, 'namespace-b', 'record-1')?.record).toMatchObject({
        revision: 1
      });

      first.outbox.connected({ modelUsage: { apiVersion: 1 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(first.sent).toHaveLength(1);
      expect(second.sent).toEqual([]);
      first.outbox.handle(ack([{ recordId: 'record-1', revision: 1, status: 'accepted' }]));

      expect(readPayload(database, 'namespace-a', 'record-1')).toBeUndefined();
      expect(readPayload(database, 'namespace-b', 'record-1')?.record).toMatchObject({
        revision: 1
      });
    } finally {
      database.close();
    }
  });
});

describe('NodeModelUsageService', () => {
  it('does not bind a grant whose outer scope differs from its signed claims', () => {
    const recorded: { grant: ModelUsageGrant; record: ModelUsageRecord }[] = [];
    const service = new NodeModelUsageService(
      () =>
        ({
          record: (grant: ModelUsageGrant, record: ModelUsageRecord) =>
            recorded.push({ grant, record })
        }) as never,
      () => 'node-1'
    );
    const claims = {
      audience: 'model-usage-v1',
      scopeId: SCOPE_ID,
      nodeId: 'node-1',
      userId: 42,
      mode: 'work',
      issuedAt: 1_000,
      expiresAt: 2_000
    };
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');

    service.bind(
      'run-1',
      { scopeId: OTHER_SCOPE_ID, token: `${body}.signature` },
      'session-1',
      'mar-agent'
    );
    service.record('run-1', usageRecord());

    expect(recorded).toEqual([]);
  });
});

interface Harness {
  readonly outbox: ModelUsageOutbox;
  readonly sent: { type: string; payload: unknown }[];
  readonly diagnostics: string[];
  readonly clock: { value: number };
}

function createHarness(database: NodeDatabase, namespace: string, initialNow = 1_000): Harness {
  const sent: { type: string; payload: unknown }[] = [];
  const diagnostics: string[] = [];
  const clock = { value: initialNow };
  const outbox = new ModelUsageOutbox({
    database: () => database.raw,
    namespace: () => namespace,
    send: (type, payload) => sent.push({ type, payload }),
    diagnose: (code) => diagnostics.push(code),
    now: () => clock.value
  });
  outboxes.push(outbox);
  return { outbox, sent, diagnostics, clock };
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
    startedAt: 1_000,
    endedAt: 2_000,
    state: 'succeeded',
    inputTokens: '10',
    outputTokens: '5',
    coverage: 'request',
    ...overrides
  };
}

function ack(
  results: readonly {
    recordId: string;
    revision: number;
    status: 'accepted' | 'rejected';
    code?:
      | 'USAGE_GRANT_INVALID'
      | 'USAGE_EXPIRED'
      | 'USAGE_USER_DELETED'
      | 'USAGE_CONFLICT'
      | 'USAGE_TIME_INVALID';
  }[]
): NodeEnvelope {
  return {
    version: 2,
    id: 'usage-ack-1',
    type: 'usage.ack',
    payload: { apiVersion: 1, results }
  };
}

function readPayload(
  database: NodeDatabase,
  namespace: string,
  recordId: string
): { grant: ModelUsageGrant; record: ModelUsageRecord } | undefined {
  const row = database.raw
    .prepare('SELECT payload FROM model_usage_outbox WHERE namespace=? AND record_id=?')
    .get(namespace, recordId) as { payload: string } | undefined;
  return row === undefined
    ? undefined
    : (JSON.parse(row.payload) as { grant: ModelUsageGrant; record: ModelUsageRecord });
}
