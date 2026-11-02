import type { ClientToolDefinition } from '../../tools/contracts.js';
import type { SessionModelMessage as ModelMessage } from '../../session/model-request.js';
import { isDeepStrictEqual } from 'node:util';
import type { ModelUsage } from '../../model/contracts.js';
import {
  ContextGcCheckpointCache,
  contextGcReplacementKey,
  type ContextGcCheckpointDraft,
  type ContextGcPlatform
} from '../../session/context-gc-checkpoint.js';
import type { SessionStore } from '../../session/store/contracts.js';
import type { SessionRecord } from '../../session/record-contract.js';
import { contextGcEligibleUsage, inspectContextGc } from './gc.js';
import { buildContextProjection, type ContextProjection } from './projection.js';

type ContextGcStore = Pick<SessionStore, 'readExecutionState' | 'commitContextGc' | 'readPage'>;

export interface ContextGcRuntimeInput {
  readonly inlineMedia?: import('../../session/inline-media.js').InlineMediaGcCandidate | undefined;
  readonly store: ContextGcStore;
  readonly sessionId: string;
  readonly records?: readonly SessionRecord[];
  readonly mediaView?: (messages: readonly ModelMessage[]) => readonly ModelMessage[];
  readonly system: string;
  readonly tools: readonly ClientToolDefinition[];
  readonly modelId: string;
  readonly modelProtocol?: string;
  readonly responsesConfigurationUpdates?: boolean;
  readonly contextWindowTokens: number;
  readonly usage: ModelUsage;
  readonly workspace: string;
  readonly platform: ContextGcPlatform;
  readonly activeProcessIds?: ReadonlySet<string>;
  readonly getActiveProcessIds?: () => Promise<ReadonlySet<string>>;
}

export interface ContextGcCommitResult {
  readonly records: readonly SessionRecord[];
  readonly projection: ContextProjection;
}

interface ContextGcAttempt {
  readonly result: ContextGcCommitResult | false;
  readonly retryAfterRollouts?: number;
}

/** Only scheduling metadata survives a call; records and validation caches do not. */
export class ContextGcRuntime {
  #scope = '';
  #lastUsage: number | undefined;
  #failures = 0;
  #remaining = 0;

  reset(): void {
    this.#scope = '';
    this.#lastUsage = undefined;
    this.#failures = 0;
    this.#remaining = 0;
  }

  async run(input: ContextGcRuntimeInput): Promise<ContextGcCommitResult | false> {
    const scope = JSON.stringify([
      input.sessionId,
      input.modelId,
      input.modelProtocol,
      input.contextWindowTokens
    ]);
    if (scope !== this.#scope) {
      this.reset();
      this.#scope = scope;
    }
    const mediaRequired = input.inlineMedia !== undefined && input.inlineMedia.reason !== 'TEXT_GC';
    const usage = mediaRequired
      ? (input.usage.contextInputTokens ?? input.usage.inputTokens ?? 0)
      : contextGcEligibleUsage(input.usage, input.contextWindowTokens);
    if (usage === undefined) {
      this.#lastUsage = undefined;
      this.#failures = 0;
      this.#remaining = 0;
      return false;
    }
    if (this.#lastUsage !== undefined && usage < this.#lastUsage) {
      this.#failures = 0;
      this.#remaining = 0;
    }
    this.#lastUsage = usage;
    const maximumInterval = usage / input.contextWindowTokens >= 0.8 ? 2 : 8;
    this.#remaining = Math.min(this.#remaining, maximumInterval - 1);
    if (this.#remaining > 0 && !mediaRequired) {
      this.#remaining--;
      return false;
    }
    const attempt = await attemptContextGc(input);
    if (attempt.result) {
      this.#failures = 0;
      this.#remaining = 0;
    } else {
      this.#failures = Math.min(3, this.#failures + 1);
      this.#remaining =
        Math.min(2 ** this.#failures, maximumInterval, attempt.retryAfterRollouts ?? Infinity) - 1;
    }
    return attempt.result;
  }
}

/**
 * Runs the deterministic planner and commits its checkpoint. Planning and
 * commit failures are opportunistic no-ops unless the checkpoint is confirmed
 * durable after an ambiguous append result.
 */
export async function tryCommitContextGc(
  input: ContextGcRuntimeInput
): Promise<ContextGcCommitResult | false> {
  return (await attemptContextGc(input)).result;
}

async function attemptContextGc(input: ContextGcRuntimeInput): Promise<ContextGcAttempt> {
  const mediaRequired = input.inlineMedia !== undefined && input.inlineMedia.reason !== 'TEXT_GC';
  const contextUsage = mediaRequired
    ? (input.usage.contextInputTokens ?? input.usage.inputTokens ?? 0)
    : contextGcEligibleUsage(input.usage, input.contextWindowTokens);
  if (contextUsage === undefined) return { result: false };
  let deferred: ContextGcAttempt = { result: false };
  let draft: ContextGcCheckpointDraft;
  let records: readonly SessionRecord[];
  try {
    records =
      input.records ?? (await input.store.readExecutionState(input.sessionId)).contextRecords;
    const checkpointCache = new ContextGcCheckpointCache();
    const projection = buildContextProjection(records, checkpointCache);
    const messages = projection.entries.map((entry) => entry.message);
    const inspection = inspectContextGc({
      ...(input.inlineMedia ? { inlineMedia: input.inlineMedia } : {}),
      records,
      checkpointCache,
      messages: input.mediaView?.(messages) ?? messages,
      messageSources: projection.entries.map((entry) => entry.record),
      system: input.system,
      tools: input.tools,
      modelId: input.modelId,
      ...(input.modelProtocol === undefined ? {} : { modelProtocol: input.modelProtocol }),
      ...(input.responsesConfigurationUpdates === undefined
        ? {}
        : { responsesConfigurationUpdates: input.responsesConfigurationUpdates }),
      contextWindowTokens: input.contextWindowTokens,
      usage: input.usage,
      workspace: input.workspace,
      platform: input.platform,
      activeProcessIds: input.activeProcessIds ?? (await input.getActiveProcessIds?.()) ?? new Set()
    });
    if (inspection.retryAfterRollouts !== undefined)
      deferred = {
        ...deferred,
        retryAfterRollouts: inspection.retryAfterRollouts
      };
    const plan = inspection.plan;
    if (!plan) return deferred;
    draft = plan.draft;
  } catch {
    return deferred;
  }
  try {
    const committed = await input.store.commitContextGc(input.sessionId, draft, records);
    return {
      ...deferred,
      result: await matchingCheckpointWasPersisted(
        input.store,
        input.sessionId,
        draft,
        records,
        committed
      )
    };
  } catch (commitError) {
    try {
      return {
        ...deferred,
        result: await matchingCheckpointWasPersisted(input.store, input.sessionId, draft, records)
      };
    } catch {
      // Keep the deferred result when the post-failure checkpoint cannot be read.
    }
    void commitError;
    return deferred;
  }
}

async function matchingCheckpointWasPersisted(
  store: ContextGcStore,
  sessionId: string,
  draft: ContextGcCheckpointDraft,
  records: readonly SessionRecord[],
  committed?: SessionRecord
): Promise<ContextGcCommitResult | false> {
  const record =
    committed ??
    (
      await store.readPage(sessionId, {
        limit: 1,
        beforeSequence: draft.boundarySequence + 2
      })
    ).records[0];
  if (record?.sequence !== draft.boundarySequence + 1 || record.type !== 'context.gc.completed')
    return false;
  const updatedRecords = [...records, record];
  const projection = buildContextProjection(updatedRecords);
  if (committed) return { records: updatedRecords, projection };
  const payload = projection.checkpoint;
  const latest = payload ? { payload } : undefined;
  if (
    latest?.payload.boundarySequence !== draft.boundarySequence ||
    !isDeepStrictEqual(latest.payload.base, draft.base) ||
    !isDeepStrictEqual(latest.payload.trigger, draft.trigger) ||
    !isDeepStrictEqual(latest.payload.inlineMedia, draft.inlineMedia) ||
    !isDeepStrictEqual(latest.payload.metrics, draft.metrics)
  )
    return false;
  const persisted = new Map(
    latest.payload.replacements.map((replacement) => [
      contextGcReplacementKey(replacement),
      replacement
    ])
  );
  const matches = draft.replacements.every((replacement) => {
    const value = persisted.get(contextGcReplacementKey(replacement));
    return value !== undefined && isDeepStrictEqual(value, replacement);
  });
  return matches ? { records: updatedRecords, projection } : false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
