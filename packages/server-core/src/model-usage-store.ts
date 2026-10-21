import { createHash } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import {
  MODEL_USAGE_RETENTION_MS,
  MODEL_USAGE_BATCH_BYTES,
  modelUsageBatchSchema,
  type ModelUsageAck,
  type ModelUsageBatch,
  type ModelUsageRecord
} from '@myagentroam/protocol';
import { withMysqlTransaction } from './mysql-reference-store.js';
import { ModelUsageGrants } from './model-usage-grant.js';
import { recordedUsage } from './model-usage-record.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function usageModelKey(record: ModelUsageRecord): string {
  return JSON.stringify([
    record.runner,
    record.provider ?? '',
    record.actualModel ?? record.requestedModel ?? ''
  ]);
}

export class ModelUsageStore {
  private lastCleanup = 0;
  constructor(
    readonly pool: Pool,
    readonly grants: ModelUsageGrants,
    private readonly now = Date.now
  ) {}

  async cleanup(): Promise<void> {
    await this.pool.execute(
      'DELETE FROM model_usage_records WHERE COALESCE(ended_at,started_at) < ? LIMIT 1000',
      [this.now() - MODEL_USAGE_RETENTION_MS]
    );
  }

  async consume(nodeId: string, value: unknown): Promise<ModelUsageAck> {
    if (Buffer.byteLength(JSON.stringify(value)) > MODEL_USAGE_BATCH_BYTES)
      throw new Error('USAGE_BATCH_INVALID');
    const batch = modelUsageBatchSchema.parse(value);
    const results: ModelUsageAck['results'] = [];
    for (const entry of batch.entries) results.push(await this.accept(nodeId, entry));
    if (this.now() - this.lastCleanup >= 300_000) {
      await this.cleanup();
      this.lastCleanup = this.now();
    }
    return { apiVersion: 1, results };
  }

  private async accept(
    nodeId: string,
    entry: ModelUsageBatch['entries'][number]
  ): Promise<ModelUsageAck['results'][number]> {
    const record = recordedUsage(entry.record);
    const base = { recordId: record.recordId, revision: record.revision };
    const reject = (code: NonNullable<ModelUsageAck['results'][number]['code']>) => ({
      ...base,
      status: 'rejected' as const,
      code
    });
    const claims = this.grants.verify(nodeId, entry.grant);
    if (!claims || record.scopeId !== claims.scopeId) return reject('USAGE_GRANT_INVALID');
    const now = this.now();
    if ((record.endedAt ?? record.startedAt) < now - MODEL_USAGE_RETENTION_MS)
      return reject('USAGE_EXPIRED');
    if (
      record.startedAt < claims.issuedAt - 3_600_000 ||
      (record.endedAt ?? record.startedAt) > now + 3_600_000
    )
      return reject('USAGE_TIME_INVALID');
    const source = hash(JSON.stringify([nodeId, record.recordId]));
    const payload = JSON.stringify(record);
    // Hash source facts so zero-filling does not conflict with pre-existing replay hashes.
    const payloadHash = hash(JSON.stringify(entry.record));
    const identity = hash(
      JSON.stringify([
        claims.userId,
        claims.scopeId,
        record.requestId,
        record.sessionId,
        record.runId,
        record.runner,
        record.startedAt,
        record.purpose,
        record.agentRole,
        record.modelConfigurationId,
        record.requestedModel,
        record.provider
      ])
    );
    return withMysqlTransaction(this.pool, async (connection) => {
      // Pair the user lock with the existing user-deletion transaction.
      const [users] = await connection.execute<RowDataPacket[]>(
        'SELECT id FROM users WHERE id=? FOR UPDATE',
        [claims.userId]
      );
      if (users.length !== 1) return reject('USAGE_USER_DELETED');
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT revision,payload_hash,identity_hash FROM model_usage_records WHERE source_key=? FOR UPDATE',
        [source]
      );
      const previous = rows[0];
      if (previous) {
        if (
          previous.identity_hash !== identity ||
          (Number(previous.revision) === record.revision && previous.payload_hash !== payloadHash)
        )
          return reject('USAGE_CONFLICT');
        if (Number(previous.revision) >= record.revision)
          return { ...base, status: 'accepted' as const };
      }
      const modelName = record.modelName ?? record.actualModel ?? record.requestedModel ?? '';
      if (previous) {
        await connection.execute(
          `UPDATE model_usage_records SET revision=?,payload_hash=?,model_key=?,model_name=?,ended_at=?,received_at=?,input_tokens=?,output_tokens=?,record=CAST(? AS JSON) WHERE source_key=?`,
          [
            record.revision,
            payloadHash,
            usageModelKey(record),
            modelName,
            record.endedAt ?? null,
            now,
            record.inputTokens ?? null,
            record.outputTokens ?? null,
            payload,
            source
          ]
        );
      } else {
        await connection.execute(
          `INSERT INTO model_usage_records
          (source_key,user_id,source_node_id,record_id,revision,payload_hash,identity_hash,runner,mode,purpose,model_key,model_name,started_at,ended_at,received_at,input_tokens,output_tokens,record)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CAST(? AS JSON))`,
          [
            source,
            claims.userId,
            nodeId,
            record.recordId,
            record.revision,
            payloadHash,
            identity,
            record.runner,
            claims.mode,
            record.purpose,
            usageModelKey(record),
            modelName,
            record.startedAt,
            record.endedAt ?? null,
            now,
            record.inputTokens ?? null,
            record.outputTokens ?? null,
            payload
          ]
        );
      }
      return { ...base, status: 'accepted' as const };
    });
  }
}
