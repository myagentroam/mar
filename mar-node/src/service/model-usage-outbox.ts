import type { DatabaseSync } from 'node:sqlite';
import {
  MODEL_USAGE_BATCH_BYTES,
  MODEL_USAGE_BATCH_LIMIT,
  MODEL_USAGE_OUTBOX_RETENTION_MS,
  modelUsageAckSchema,
  modelUsageGrantSchema,
  modelUsageRecordSchema,
  type ModelUsageBatch,
  type ModelUsageGrant,
  type ModelUsageRecord,
  type NodeEnvelope
} from '@myagentroam/protocol';

const MAX_BYTES = 32 * 1024 * 1024;
interface UsageOutboxOptions {
  database: () => DatabaseSync | undefined;
  namespace: () => string | undefined;
  send: (type: string, payload: unknown) => void;
  diagnose: (code: string) => void;
  now?: () => number;
}

/** Durable, bounded, at-least-once delivery independent of browser subscriptions. */
export class ModelUsageOutbox {
  private enabled = false;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Map<string, number> | undefined;
  private attempts = 0;
  private readonly now: () => number;
  constructor(private readonly options: UsageOutboxOptions) {
    this.now = options.now ?? Date.now;
  }

  connected(payload: unknown): void {
    this.disconnected();
    const capability = (payload as { modelUsage?: { apiVersion?: unknown } } | null)?.modelUsage;
    this.enabled = capability?.apiVersion === 1;
    if (this.enabled) {
      this.recover();
      this.schedule(0);
    }
  }
  disconnected(): void {
    this.enabled = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.inFlight = undefined;
    this.attempts = 0;
  }

  record(grant: ModelUsageGrant, value: ModelUsageRecord): void {
    try {
      const database = this.options.database();
      const namespace = this.options.namespace();
      if (!database || !namespace) return;
      const record = modelUsageRecordSchema.parse(value);
      const parsedGrant = modelUsageGrantSchema.parse(grant);
      const payload = JSON.stringify({ grant: parsedGrant, record });
      const bytes = Buffer.byteLength(payload);
      this.expire(database);
      const current = database
        .prepare('SELECT revision,bytes FROM model_usage_outbox WHERE namespace=? AND record_id=?')
        .get(namespace, record.recordId);
      if (current && Number(current.revision) >= record.revision) return;
      const total = Number(
        database.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM model_usage_outbox').get()
          ?.bytes ?? 0
      );
      if (
        bytes > MODEL_USAGE_BATCH_BYTES / 2 ||
        total - Number(current?.bytes ?? 0) + bytes > MAX_BYTES
      ) {
        this.options.diagnose('USAGE_OUTBOX_FULL');
        return;
      }
      database
        .prepare(
          `INSERT INTO model_usage_outbox(namespace,record_id,revision,payload,bytes,updated_at,ended_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(namespace,record_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,bytes=excluded.bytes,updated_at=excluded.updated_at,ended_at=excluded.ended_at`
        )
        .run(
          namespace,
          record.recordId,
          record.revision,
          payload,
          bytes,
          this.now(),
          record.endedAt ?? null
        );
      if (this.enabled && !this.inFlight && !this.timer) this.schedule(250);
    } catch {
      this.options.diagnose('USAGE_OUTBOX_WRITE_FAILED');
    }
  }

  handle(envelope: NodeEnvelope): boolean {
    if (envelope.type !== 'usage.ack') return false;
    const parsed = modelUsageAckSchema.safeParse(envelope.payload);
    const namespace = this.options.namespace();
    const database = this.options.database();
    if (!parsed.success || !this.inFlight || !namespace || !database) return true;
    try {
      for (const result of parsed.data.results) {
        if (this.inFlight.get(result.recordId) !== result.revision) continue;
        database
          .prepare(
            'DELETE FROM model_usage_outbox WHERE namespace=? AND record_id=? AND revision=?'
          )
          .run(namespace, result.recordId, result.revision);
        if (result.status === 'rejected') this.options.diagnose(result.code ?? 'USAGE_REJECTED');
      }
      this.inFlight = undefined;
      this.attempts = 0;
      this.schedule(250);
    } catch {
      this.options.diagnose('USAGE_OUTBOX_ACK_FAILED');
    }
    return true;
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, delay);
    this.timer.unref();
  }
  private flush(): void {
    const database = this.options.database();
    const namespace = this.options.namespace();
    if (!this.enabled || !database || !namespace) return;
    try {
      this.expire(database);
      const rows = database
        .prepare(
          'SELECT payload FROM model_usage_outbox WHERE namespace=? AND ended_at IS NOT NULL ORDER BY updated_at,record_id LIMIT ?'
        )
        .all(namespace, MODEL_USAGE_BATCH_LIMIT);
      const entries: ModelUsageBatch['entries'] = [];
      let bytes = 100;
      for (const row of rows) {
        bytes += Buffer.byteLength(String(row.payload)) + 1;
        if (bytes > MODEL_USAGE_BATCH_BYTES) break;
        entries.push(JSON.parse(String(row.payload)) as ModelUsageBatch['entries'][number]);
      }
      if (!entries.length) {
        this.inFlight = undefined;
        return;
      }
      this.inFlight = new Map(entries.map(({ record }) => [record.recordId, record.revision]));
      this.options.send('usage.batch', { apiVersion: 1, entries });
      this.schedule(Math.min(60_000, 1000 * 2 ** Math.min(this.attempts++, 6)));
    } catch {
      this.options.diagnose('USAGE_OUTBOX_SEND_FAILED');
      this.schedule(30_000);
    }
  }
  private recover(): void {
    const database = this.options.database();
    const namespace = this.options.namespace();
    if (!database || !namespace) return;
    // Reconnect must not finalize requests that are still running.
    this.expire(database);
  }
  recoverInterrupted(): void {
    const database = this.options.database();
    const namespace = this.options.namespace();
    if (!database || !namespace) return;
    this.expire(database);
    const rows = database
      .prepare('SELECT payload FROM model_usage_outbox WHERE namespace=? AND ended_at IS NULL')
      .all(namespace);
    for (const row of rows) {
      const entry = JSON.parse(String(row.payload)) as ModelUsageBatch['entries'][number];
      this.record(entry.grant, {
        ...entry.record,
        revision: entry.record.revision + 1,
        state: 'interrupted',
        endedAt: Math.max(entry.record.startedAt, this.now())
      });
    }
  }
  private expire(database: DatabaseSync): void {
    const result = database
      .prepare('DELETE FROM model_usage_outbox WHERE updated_at<?')
      .run(this.now() - MODEL_USAGE_OUTBOX_RETENTION_MS);
    if (result.changes) this.options.diagnose('USAGE_OUTBOX_EXPIRED');
  }
}
