import type { SessionRecord, SessionStore } from './store/contracts.js';
import { compactSummaryFromCheckpoint, isAgentEvent } from './record-projection.js';

export interface AgentSessionContextUsage {
  inputTokens: number;
  gcCount: number;
  /** Measured input decreases since Compact; undefined when GC usage is not yet paired. */
  gcReclaimedTokens?: number;
}

const MAX_CACHED_SESSIONS = 256;
type HistoryPage = Awaited<ReturnType<SessionStore['readPage']>>;

interface GcStatisticsCache {
  readonly cursor: Pick<SessionRecord, 'sequence' | 'recordId'>;
  readonly statistics: Omit<AgentSessionContextUsage, 'inputTokens'>;
  readonly refreshOnUsage: boolean;
}

/** Rebuild GC totals only when GC, its measured request, or retained history changes. */
export class SessionContextUsageReader {
  private readonly cache = new Map<string, GcStatisticsCache>();
  private readonly reading = new Map<string, Promise<AgentSessionContextUsage | undefined>>();

  constructor(private readonly store: Pick<SessionStore, 'readPage'>) {}

  async read(sessionId: string): Promise<AgentSessionContextUsage | undefined> {
    let pending = this.reading.get(sessionId);
    if (!pending) {
      pending = this.readOnce(sessionId);
      this.reading.set(sessionId, pending);
    }
    try {
      const result = await pending;
      return result === undefined ? undefined : { ...result };
    } finally {
      if (this.reading.get(sessionId) === pending) this.reading.delete(sessionId);
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.reading.values());
    this.cache.clear();
  }

  private remember(sessionId: string, entry: GcStatisticsCache): void {
    this.cache.delete(sessionId);
    this.cache.set(sessionId, entry);
    if (this.cache.size > MAX_CACHED_SESSIONS) this.cache.delete(this.cache.keys().next().value!);
  }

  private async reusable(
    sessionId: string,
    page: HistoryPage,
    cached: GcStatisticsCache
  ): Promise<boolean> {
    for (;;) {
      for (const record of page.records.toReversed()) {
        if (record.sequence <= cached.cursor.sequence)
          return (
            record.sequence === cached.cursor.sequence && record.recordId === cached.cursor.recordId
          );
        if (
          compactSummaryFromCheckpoint(record) !== undefined ||
          record.type === 'context.gc.completed'
        )
          return false;
        if (
          cached.refreshOnUsage &&
          ((isAgentEvent(record.payload) &&
            record.payload.type === 'usage.updated' &&
            record.payload.purpose !== 'compact') ||
            (record.type === 'model.attempt' &&
              isRecord(record.payload) &&
              record.payload.purpose === 'EXECUTION'))
        )
          return false;
      }
      if (page.previousBeforeSequence === undefined) return false;
      page = await this.store.readPage(sessionId, {
        limit: 1000,
        beforeSequence: page.previousBeforeSequence
      });
    }
  }

  private async readOnce(sessionId: string): Promise<AgentSessionContextUsage | undefined> {
    const page = await this.store.readPage(sessionId, { limit: 1000 });
    let inputTokens: number | undefined;
    for (const record of page.records.toReversed()) {
      if (!isAgentEvent(record.payload)) continue;
      if (record.payload.type === 'context.compacted') {
        if (record.payload.retainedContext === true) return undefined;
        inputTokens = 0;
        break;
      }
      if (record.payload.type === 'usage.updated' && record.payload.purpose !== 'compact') {
        const tokens = record.payload.contextInputTokens ?? record.payload.inputTokens;
        if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0) {
          inputTokens = tokens;
          break;
        }
      }
    }
    if (inputTokens === undefined) return undefined;
    const usage = { inputTokens };
    const tail = page.records.at(-1)!;
    const cursor = { sequence: tail.sequence, recordId: tail.recordId };
    const cached = this.cache.get(sessionId);
    if (cached && (await this.reusable(sessionId, page, cached))) {
      this.remember(sessionId, { ...cached, cursor });
      return { ...usage, ...cached.statistics };
    }
    let gcCount = 0;
    let gcReclaimedTokens = 0;
    let tokensKnown = true;
    let nextInputTokens: number | undefined;
    let nextModelId: string | undefined;
    let nextExecutionId: string | undefined;
    let requestInputTokens: number | undefined;
    let requestEnded = false;
    let newerRequestStarted = false;
    let nextInputMutable = false;
    let refreshOnUsage = false;
    let permanentlyUnavailable = false;
    const statistics = (): AgentSessionContextUsage => {
      const statistics = { gcCount, ...(tokensKnown ? { gcReclaimedTokens } : {}) };
      this.remember(sessionId, {
        cursor,
        statistics,
        refreshOnUsage: refreshOnUsage && !permanentlyUnavailable
      });
      return { ...usage, ...statistics };
    };
    let countPage = page;
    for (;;) {
      for (const record of countPage.records.toReversed()) {
        if (compactSummaryFromCheckpoint(record) !== undefined) return statistics();
        if (
          record.type === 'execution.header' &&
          record.executionId === nextExecutionId &&
          isRecord(record.payload)
        )
          nextModelId =
            typeof record.payload.modelId === 'string' ? record.payload.modelId : undefined;
        if (
          isAgentEvent(record.payload) &&
          record.payload.type === 'usage.updated' &&
          record.payload.purpose !== 'compact'
        ) {
          const tokens = record.payload.contextInputTokens ?? record.payload.inputTokens;
          if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0) {
            requestInputTokens ??= tokens;
            nextInputTokens = tokens;
            nextModelId = undefined;
            nextExecutionId = record.executionId;
            nextInputMutable = false;
          }
        }
        if (
          record.type === 'model.attempt' &&
          isRecord(record.payload) &&
          record.payload.purpose === 'EXECUTION' &&
          (record.payload.state === 'SUCCEEDED' || record.payload.state === 'FAILED')
        )
          requestEnded = true;
        if (
          record.type === 'model.attempt' &&
          isRecord(record.payload) &&
          record.payload.state === 'STARTED' &&
          record.payload.purpose === 'EXECUTION'
        ) {
          // Reverse traversal preserves the last usage update within each request.
          if (requestInputTokens !== undefined) {
            nextInputTokens = requestInputTokens;
            nextInputMutable = !requestEnded && !newerRequestStarted;
          }
          requestInputTokens = undefined;
          requestEnded = false;
          newerRequestStarted = true;
        }
        if (
          record.type === 'context.gc.completed' &&
          isRecord(record.payload) &&
          typeof record.payload.generation === 'number' &&
          Number.isSafeInteger(record.payload.generation) &&
          record.payload.generation > 0
        ) {
          const latest = gcCount === 0;
          gcCount ||= record.payload.generation;
          const trigger = isRecord(record.payload.trigger) ? record.payload.trigger : undefined;
          const before = trigger?.contextInputTokens;
          const measuredBefore =
            typeof trigger?.usageSequence === 'number' &&
            trigger.usageSequence > 0 &&
            typeof before === 'number' &&
            Number.isSafeInteger(before) &&
            before >= 0;
          if (
            measuredBefore &&
            nextInputTokens !== undefined &&
            (nextModelId === undefined || nextModelId === trigger.modelId)
          )
            gcReclaimedTokens += Math.max(0, before - nextInputTokens);
          else tokensKnown = false;
          if (
            !measuredBefore ||
            (!latest && nextInputTokens === undefined) ||
            (nextInputTokens !== undefined &&
              nextModelId !== undefined &&
              nextModelId !== trigger?.modelId)
          )
            permanentlyUnavailable = true;
          if (latest) refreshOnUsage = nextInputTokens === undefined || nextInputMutable;
          nextInputTokens = undefined;
          nextModelId = undefined;
          nextExecutionId = undefined;
          requestInputTokens = undefined;
          requestEnded = false;
          newerRequestStarted = false;
          nextInputMutable = false;
          if (record.payload.generation === 1) return statistics();
        }
      }
      if (countPage.previousBeforeSequence === undefined) return statistics();
      countPage = await this.store.readPage(sessionId, {
        limit: 1000,
        beforeSequence: countPage.previousBeforeSequence
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
