// @test-covers ee/server/src/node-control.ts
// @test-covers packages/server-core/src/model-usage-store.ts
import { describe, expect, it, vi } from 'vitest';
import {
  MODEL_USAGE_BATCH_BYTES,
  MODEL_USAGE_BATCH_LIMIT,
  modelUsageBatchSchema,
  type ModelUsageAck,
  type ModelUsageBatch,
  type ModelUsageGrant
} from '@myagentroam/protocol';
import { NODE_ID, NOW, USER_ID, withUsageControl } from './support/model-usage-control-fixture.js';

const capabilities = {
  platform: 'linux',
  architecture: 'x64',
  nodeVersion: 'v24',
  nodeAppVersion: '0.11.39',
  codex: { available: false },
  claudeCode: { available: false }
};

function entry(grant: ModelUsageGrant, recordId: string): ModelUsageBatch['entries'][number] {
  return {
    grant,
    record: {
      schemaVersion: 1,
      scopeId: grant.scopeId,
      recordId,
      requestId: recordId,
      revision: 1,
      runner: 'mar-agent',
      sessionId: 'session',
      runId: 'run',
      purpose: 'conversation',
      agentRole: 'root',
      startedAt: NOW - 1000,
      endedAt: NOW,
      state: 'succeeded',
      inputTokens: '7',
      outputTokens: '3',
      coverage: 'request'
    }
  };
}

describe('Node model usage acknowledgements', () => {
  it('decodes each batch once and accepts a replay with the explicit coverage default', async () => {
    await withUsageControl(async ({ mysql, grants, receive }) => {
      await receive('capabilities', capabilities);
      const { grant, record } = entry(grants.issue(NODE_ID, USER_ID, 'work'), 'first');
      const { coverage, ...withoutCoverage } = record;
      const expected = [
        {
          type: 'usage.ack',
          payload: {
            apiVersion: 1,
            results: [{ recordId: 'first', revision: 1, status: 'accepted' }]
          }
        }
      ];
      const decode = vi.spyOn(modelUsageBatchSchema, 'safeParse');
      try {
        expect(
          await receive('usage.batch', {
            apiVersion: 1,
            entries: [{ grant, record: withoutCoverage }]
          })
        ).toMatchObject(expected);
        expect(decode).toHaveBeenCalledTimes(1);

        expect(
          await receive('usage.batch', {
            apiVersion: 1,
            entries: [{ grant, record: { coverage, ...withoutCoverage } }]
          })
        ).toMatchObject(expected);
        expect(decode).toHaveBeenCalledTimes(2);
        expect(mysql.rows.size).toBe(1);
      } finally {
        decode.mockRestore();
      }
    });
  });

  it('rejects a malformed entry or too many entries before processing any entry', async () => {
    await withUsageControl(async ({ mysql, grants, receive }) => {
      await receive('capabilities', capabilities);
      const valid = entry(grants.issue(NODE_ID, USER_ID, 'work'), 'valid');
      const malformed = { ...valid, record: { ...valid.record, inputTokens: '-1' } };
      const verify = vi.spyOn(grants, 'verify');
      for (const entries of [[valid, malformed], Array(MODEL_USAGE_BATCH_LIMIT + 1).fill(valid)]) {
        expect(await receive('usage.batch', { apiVersion: 1, entries })).toMatchObject([
          { type: 'error', payload: { code: 'USAGE_RECORD_INVALID' } }
        ]);
      }
      expect(verify).not.toHaveBeenCalled();
      expect(mysql.pool.getConnection).not.toHaveBeenCalled();
      expect(mysql.rows.size).toBe(0);
    });
  });

  it('rejects a structurally valid batch over the UTF-8 byte limit before processing entries', async () => {
    await withUsageControl(async ({ mysql, grants, receive }) => {
      await receive('capabilities', capabilities);
      const grant = grants.issue(NODE_ID, USER_ID, 'work');
      const text = '界'.repeat(256);
      const batch = {
        apiVersion: 1,
        entries: Array.from({ length: MODEL_USAGE_BATCH_LIMIT }, (_, index) => {
          const { record } = entry(grant, `entry-${index}`);
          return {
            grant,
            record: {
              ...record,
              modelConfigurationId: text,
              modelName: text,
              provider: text,
              requestedModel: text,
              actualModel: text,
              responseId: text
            }
          };
        })
      };
      const payload = JSON.stringify(batch);
      expect(payload.length).toBeLessThan(MODEL_USAGE_BATCH_BYTES);
      expect(Buffer.byteLength(payload)).toBeGreaterThan(MODEL_USAGE_BATCH_BYTES);
      const verify = vi.spyOn(grants, 'verify');

      expect(await receive('usage.batch', batch)).toMatchObject([
        { type: 'error', payload: { code: 'USAGE_STORAGE_UNAVAILABLE' } }
      ]);
      expect(verify).not.toHaveBeenCalled();
      expect(mysql.pool.getConnection).not.toHaveBeenCalled();
      expect(mysql.rows.size).toBe(0);
    });
  });

  it('acknowledges each committed batch entry and its replay despite separate retention failures', async () => {
    await withUsageControl(async ({ mysql, grants, warnings, receive }) => {
      const grant = grants.issue(NODE_ID, USER_ID, 'work');
      const otherGrant = grants.issue('different-node', USER_ID, 'work');
      const batch: ModelUsageBatch = {
        apiVersion: 1,
        entries: [entry(grant, 'first'), entry(otherGrant, 'denied'), entry(grant, 'last')]
      };
      const expected: ModelUsageAck = {
        apiVersion: 1,
        results: [
          { recordId: 'first', revision: 1, status: 'accepted' },
          { recordId: 'denied', revision: 1, status: 'rejected', code: 'USAGE_GRANT_INVALID' },
          { recordId: 'last', revision: 1, status: 'accepted' }
        ]
      };

      const beforeCapabilities = await receive('usage.batch', batch);
      expect(beforeCapabilities).toMatchObject([
        { type: 'error', payload: { code: 'NODE_UPGRADE_REQUIRED' } }
      ]);
      expect(mysql.pool.getConnection).not.toHaveBeenCalled();
      await receive('capabilities', capabilities);

      expect(mysql.cleanupRowCounts).toEqual([0]); // Startup maintenance ran independently.
      mysql.failCleanup = true;
      const replies = await receive('usage.batch', batch);
      expect(mysql.rows.size).toBe(2);

      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(warnings).toHaveBeenCalledExactlyOnceWith('MODEL_USAGE_CLEANUP_FAILED');
      expect(replies).toMatchObject([{ type: 'usage.ack', payload: expected }]);

      expect(await receive('usage.batch', batch)).toMatchObject([
        { type: 'usage.ack', payload: expected }
      ]);
      expect(mysql.rows.size).toBe(2);
      expect(mysql.cleanupRowCounts).toEqual([0, 2]);
    });
  });

  it.each(['insert', 'commit'] as const)(
    'reports a usage %s failure as storage unavailable without a success ACK',
    async (phase) => {
      await withUsageControl(async ({ mysql, grants, receive }) => {
        const grant = grants.issue(NODE_ID, USER_ID, 'work');
        const batch: ModelUsageBatch = { apiVersion: 1, entries: [entry(grant, 'first')] };
        await receive('capabilities', capabilities);
        mysql.failWrite = phase;

        const replies = await receive('usage.batch', batch);
        expect(replies).toMatchObject([
          { type: 'error', payload: { code: 'USAGE_STORAGE_UNAVAILABLE' } }
        ]);
        expect(JSON.stringify(replies)).not.toContain('FIXTURE_');
        expect(mysql.rows.size).toBe(0);
        expect(mysql.cleanupRowCounts).toEqual([0]);

        mysql.failWrite = undefined;
        expect(await receive('usage.batch', batch)).toMatchObject([
          {
            type: 'usage.ack',
            payload: {
              apiVersion: 1,
              results: [{ recordId: 'first', revision: 1, status: 'accepted' }]
            }
          }
        ]);
        expect(mysql.rows.size).toBe(1);
      });
    }
  );
});
