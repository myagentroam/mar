import { createHash } from 'node:crypto';
import type { ModelUsageRecord } from '@myagentroam/protocol';

export type RunnerUsageFact = Omit<ModelUsageRecord, 'scopeId' | 'runner' | 'runId' | 'sessionId'>;
export type RunnerUsageValues = Omit<
  RunnerUsageFact,
  | 'schemaVersion'
  | 'recordId'
  | 'requestId'
  | 'revision'
  | 'startedAt'
  | 'endedAt'
  | 'state'
  | 'coverage'
>;
export function usageToken(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : undefined;
}
export function usageTokenSum(...values: (string | undefined)[]): string | undefined {
  return values.some((value) => value === undefined)
    ? undefined
    : values.reduce((sum, value) => sum + BigInt(value!), 0n).toString();
}

/** Neutral revision tracking; native token semantics remain inside each Runner normalizer. */
export class RunnerUsageTracker {
  private readonly records = new Map<string, RunnerUsageFact>();
  constructor(
    private readonly identity: string,
    private readonly publish: (record: RunnerUsageFact) => void,
    private readonly now = Date.now
  ) {}
  snapshot(
    id: string,
    values: RunnerUsageValues,
    complete: boolean,
    coverage: 'request' | 'partial' = 'request'
  ): void {
    const previous = this.records.get(id);
    const timestamp = this.now();
    const recordId = createHash('sha256')
      .update(JSON.stringify([this.identity, id]))
      .digest('hex');
    const record: RunnerUsageFact = {
      ...previous,
      ...values,
      // Identity is immutable once the first snapshot has been published.
      ...(previous
        ? { modelConfigurationId: previous.modelConfigurationId, provider: previous.provider }
        : {}),
      schemaVersion: 1,
      recordId,
      requestId: recordId,
      revision: (previous?.revision ?? 0) + 1,
      startedAt: previous?.startedAt ?? timestamp,
      state: complete ? 'succeeded' : (previous?.state ?? 'running'),
      coverage,
      ...(complete ? { endedAt: previous?.endedAt ?? timestamp } : {})
    };
    if (
      previous &&
      JSON.stringify({ ...record, revision: 0 }) === JSON.stringify({ ...previous, revision: 0 })
    )
      return;
    this.records.set(id, record);
    if (!previous || record.state !== 'running') this.publish(record);
  }
  finish(state: 'succeeded' | 'failed' | 'cancelled'): void {
    for (const [id, previous] of this.records) {
      if (previous.state !== 'running') continue;
      const record = {
        ...previous,
        revision: previous.revision + 1,
        state,
        endedAt: Math.max(previous.startedAt, this.now())
      };
      this.records.set(id, record);
      this.publish(record);
    }
  }
}
