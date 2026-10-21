import { isDeepStrictEqual } from 'node:util';
import type { ClientToolDefinition, ModelUsage } from '../../model/contracts.js';
import {
  ContextGcCheckpointCache,
  contextGcMinimumUsageGrowth,
  contextGcReplacementKey,
  type ContextGcCheckpointDraft,
  type ContextGcCheckpointPayload,
  type ContextGcPlatform
} from '../../session/context-gc-checkpoint.js';
import { JsonlSessionStore, type SessionRecord } from '../../session/store/index.js';
import { CONTEXT_GC_POLICY, contextGcEligibleUsage, inspectContextGc } from './gc.js';
import { buildContextProjection, type ContextProjection } from './projection.js';

export interface ContextGcRuntimeInput {
  readonly store: JsonlSessionStore;
  readonly sessionId: string;
  readonly records?: readonly SessionRecord[];
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
  readonly checkpointTrigger?: ContextGcCheckpointPayload['trigger'];
  readonly protectedCandidatesPending?: boolean;
  readonly retryAfterRollouts?: number;
}

/** Only scheduling metadata survives a call; records and validation caches do not. */
export class ContextGcRuntime {
  #scope = '';
  #lastUsage: number | undefined;
  #checkpoint:
    | {
        readonly trigger: ContextGcCheckpointPayload['trigger'];
        readonly protectedCandidatesPending: boolean;
      }
    | undefined;
  #rolloutsSinceCheckpoint = 0;
  #failures = 0;
  #remaining = 0;

  reset(): void {
    this.#scope = '';
    this.#lastUsage = undefined;
    this.#checkpoint = undefined;
    this.#rolloutsSinceCheckpoint = 0;
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
    const usage = contextGcEligibleUsage(input.usage, input.contextWindowTokens);
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
    if (this.#checkpoint) this.#rolloutsSinceCheckpoint++;
    const maximumInterval = usage / input.contextWindowTokens >= 0.8 ? 2 : 8;
    this.#remaining = Math.min(this.#remaining, maximumInterval - 1);
    if (this.#remaining > 0) {
      this.#remaining--;
      return false;
    }
    if (
      this.#checkpoint?.trigger.modelId === input.modelId &&
      this.#checkpoint.trigger.contextWindowTokens === input.contextWindowTokens &&
      !this.#checkpoint.protectedCandidatesPending &&
      this.#rolloutsSinceCheckpoint < CONTEXT_GC_POLICY.largeExecProtectionRollouts &&
      usage - this.#checkpoint.trigger.contextInputTokens <
        contextGcMinimumUsageGrowth(input.contextWindowTokens)
    )
      return false;
    const attempt = await attemptContextGc(input);
    if (attempt.result) {
      this.#checkpoint = {
        trigger: { ...attempt.result.projection.checkpoint!.trigger },
        protectedCandidatesPending:
          attempt.result.projection.checkpoint!.metrics.protectedCandidateTokens > 0
      };
      this.#rolloutsSinceCheckpoint = 0;
      this.#failures = 0;
      this.#remaining = 1;
    } else {
      if (attempt.checkpointTrigger)
        this.#checkpoint = {
          trigger: { ...attempt.checkpointTrigger },
          protectedCandidatesPending: attempt.protectedCandidatesPending === true
        };
      if (attempt.checkpointTrigger) this.#rolloutsSinceCheckpoint = 0;
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
  const contextUsage = contextGcEligibleUsage(input.usage, input.contextWindowTokens);
  if (contextUsage === undefined) return { result: false };
  let deferred: ContextGcAttempt = { result: false };
  let draft: ContextGcCheckpointDraft;
  let records: readonly SessionRecord[];
  try {
    records =
      input.records ?? (await input.store.readExecutionState(input.sessionId)).contextRecords;
    const checkpointCache = new ContextGcCheckpointCache();
    const previous = checkpointCache.read(records, undefined, input.workspace);
    if (previous) {
      deferred = {
        ...deferred,
        checkpointTrigger: previous.payload.trigger,
        protectedCandidatesPending: previous.payload.metrics.protectedCandidateTokens > 0
      };
      const rolloutGrowth = records.filter(
        (record) =>
          record.sequence > previous.record.sequence &&
          record.type === 'model.attempt' &&
          isRecord(record.payload) &&
          record.payload.purpose === 'EXECUTION' &&
          record.payload.state === 'SUCCEEDED'
      ).length;
      const minimumRollouts =
        previous.payload.metrics.protectedCandidateTokens > 0
          ? 2
          : CONTEXT_GC_POLICY.largeExecProtectionRollouts;
      if (
        rolloutGrowth < minimumRollouts &&
        contextUsage - previous.payload.trigger.contextInputTokens <
          contextGcMinimumUsageGrowth(input.contextWindowTokens)
      )
        return deferred;
    }
    const projection = buildContextProjection(records, input.workspace, checkpointCache);
    const inspection = inspectContextGc({
      records,
      checkpointCache,
      messages: projection.entries.map((entry) => entry.message),
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
        protectedCandidatesPending: true,
        retryAfterRollouts: inspection.retryAfterRollouts
      };
    else if (!inspection.plan) deferred = { ...deferred, protectedCandidatesPending: false };
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
        input.workspace,
        records,
        committed
      )
    };
  } catch (commitError) {
    try {
      return {
        ...deferred,
        result: await matchingCheckpointWasPersisted(
          input.store,
          input.sessionId,
          draft,
          input.workspace,
          records
        )
      };
    } catch {
      // Keep the deferred result when the post-failure checkpoint cannot be read.
    }
    void commitError;
    return deferred;
  }
}

async function matchingCheckpointWasPersisted(
  store: JsonlSessionStore,
  sessionId: string,
  draft: ContextGcCheckpointDraft,
  workspace: string,
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
  const projection = buildContextProjection(updatedRecords, workspace);
  if (committed) return { records: updatedRecords, projection };
  const payload = projection.checkpoint;
  const latest = payload ? { payload } : undefined;
  if (
    latest?.payload.boundarySequence !== draft.boundarySequence ||
    !isDeepStrictEqual(latest.payload.base, draft.base) ||
    !isDeepStrictEqual(latest.payload.trigger, draft.trigger) ||
    !isDeepStrictEqual(latest.payload.economics, draft.economics) ||
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
