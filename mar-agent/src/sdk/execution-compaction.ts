import { splitContextualPrompt } from '../runtime/context/contextual-blocks.js';
import { compactSnapshotAnchor } from '../runtime/compaction/retained-context.js';
import { buildCompactedHistory } from '../runtime/compaction/history.js';
import type { SessionModelMessage } from '../session/model-request.js';
import type { SessionRecord } from '../session/record-contract.js';
import type { SessionStore } from '../session/store/contracts.js';
import type { ClientToolDefinition } from '../tools/contracts.js';
import type { EnvironmentContextState } from '../prompts/core.js';
import type { CompactCoordinator } from '../runtime/compaction/coordinator.js';
import type { ResolvedModelConfiguration } from './model-runtime.js';
import type { ExecutionEventPayload } from './session-execution.js';
import type { ResourceInputProjection } from './resource-input.js';
import type { createExecutionModelContext } from './execution-model-context.js';
import type { generateExecutionCompaction } from './execution-compact-generation.js';
import { commitExecutionCompaction } from './execution-compact-commit.js';

type Snapshot = Parameters<typeof generateExecutionCompaction>[0]['snapshot'];

/** Snapshots one Compact prefix, generates a candidate and adopts only its committed checkpoint. */
export function createExecutionCompaction(ports: {
  readonly mode: 'run' | 'plan' | 'compact';
  readonly sessionId: string;
  readonly executionId: string;
  readonly turnId: string;
  readonly model: Pick<ResolvedModelConfiguration, 'id' | 'contextWindowTokens'>;
  readonly messages: SessionModelMessage[];
  readonly pendingInputs: Map<string, SessionRecord>;
  readonly messageSources: WeakMap<SessionModelMessage, SessionRecord>;
  readonly modelContext: Pick<
    ReturnType<typeof createExecutionModelContext>,
    'worldState' | 'compactInputs' | 'replaceCompactMessages' | 'adoptCompactCheckpoint'
  >;
  readonly resourceInput: Pick<ResourceInputProjection, 'checkpoint'>;
  readonly store: Pick<SessionStore, 'compact'>;
  readonly coordinator: Pick<CompactCoordinator, 'waiting'>;
  readonly userTokenLimit: number;
  boundary(): number;
  updateBoundary(value: number): void;
  snapshotTools(): readonly ClientToolDefinition[];
  usage(): Snapshot['latestUsage'];
  effort(): Snapshot['reasoningEffort'];
  environment(): EnvironmentContextState;
  compose(
    tools: readonly ClientToolDefinition[]
  ): Promise<Parameters<typeof splitContextualPrompt>[0]>;
  generate(
    snapshot: Snapshot,
    compactionId: string,
    signal: AbortSignal
  ): ReturnType<typeof generateExecutionCompaction>;
  retainedResources(): Promise<string | undefined>;
  withProjection<T>(action: () => Promise<T>): Promise<T>;
  recordCommit(recordId: string): void;
  invalidateContext(error: unknown): void;
  invalidateUsage(): void;
  emit(event: ExecutionEventPayload): Promise<void>;
}) {
  return async (
    input: { readonly focus?: string; readonly async?: boolean },
    signal: AbortSignal,
    prepare: () => Promise<void>,
    compactionId: string
  ): Promise<boolean> => {
    const { messages, modelContext } = ports;
    if (messages.length < 2) return false;
    const cutoff = Math.min(ports.boundary(), messages.length);
    const current = messages[cutoff - 1]!;
    const retainCurrent =
      ports.mode !== 'compact' && current.role === 'user' && current.contextKind === undefined;
    const prefix = messages.slice(0, cutoff - (retainCurrent ? 1 : 0));
    if (
      !prefix.some(
        (message) =>
          message.role !== 'user' ||
          message.contextKind === undefined ||
          message.contextKind === 'summary'
      )
    )
      return false;
    const history = structuredClone(prefix).map(({ images: _images, ...message }) => message);
    const prefixInputs = modelContext.compactInputs(prefix);
    const tools = structuredClone(ports.snapshotTools());
    const generation = modelContext.worldState.generation;
    const usage = ports.usage();
    const effort = ports.effort();
    const anchorRecordId = prefix
      .map((message) => ports.messageSources.get(message)?.recordId ?? message.metadata?.recordId)
      .findLast((id) => id !== undefined);
    const visibleAnchor = compactSnapshotAnchor(prefix, ports.messageSources);
    const anchor = {
      ...(anchorRecordId ? { anchorRecordId } : {}),
      ...(visibleAnchor ? { anchor: visibleAnchor } : {})
    };
    const composition = splitContextualPrompt(await ports.compose(tools));
    await ports.emit({
      type: 'context.compacting',
      compactionId,
      async: input.async === true,
      stage: 'GENERATING',
      ...anchor
    });
    const candidate = await ports.generate(
      {
        history,
        system: composition.system,
        ...(composition.systemBlocks === undefined
          ? {}
          : { systemBlocks: composition.systemBlocks }),
        tools,
        contextWindowTokens: ports.model.contextWindowTokens,
        latestUsage: usage,
        reasoningEffort: effort,
        ...(input.focus === undefined ? {} : { focus: input.focus }),
        reason: ports.mode === 'compact' ? 'manual' : 'automatic',
        promptCacheKey: ports.sessionId
      },
      compactionId,
      signal
    );
    await ports.emit({
      type: 'context.compacting',
      compactionId,
      async: !ports.coordinator.waiting && input.async === true,
      stage: ports.coordinator.waiting ? 'WAITING' : 'READY',
      ...anchor
    });
    await prepare();
    signal.throwIfAborted();
    const resources = await ports.retainedResources();
    const replacementHistory = buildCompactedHistory(
      candidate.summary,
      prefixInputs,
      ports.userTokenLimit
    );
    let committed = false;
    let retained: SessionModelMessage[];
    try {
      const result = await commitExecutionCompaction({
        store: ports.store,
        sessionId: ports.sessionId,
        signal,
        prefix,
        messages,
        generation,
        messageSources: ports.messageSources,
        checkpoint: (value) => ports.resourceInput.checkpoint(value),
        withProjection: ports.withProjection,
        currentGeneration: () => modelContext.worldState.generation,
        recordCommit: (recordId) => {
          committed = true;
          ports.recordCommit(recordId);
        },
        replace: (value) => {
          modelContext.replaceCompactMessages(replacementHistory, value);
          ports.updateBoundary(messages.length - value.length);
        },
        draft: () => ({
          summary: candidate.summary,
          replacementHistory,
          pendingInputs: [...ports.pendingInputs.values()],
          snapshotMessageCount: prefix.length,
          ...(anchorRecordId ? { snapshotRecordId: anchorRecordId } : {}),
          automatic: ports.mode !== 'compact',
          environment: ports.environment(),
          modelId: ports.model.id,
          contextWindowTokens: ports.model.contextWindowTokens,
          ...(candidate.usage === undefined ? {} : { usage: candidate.usage }),
          executionId: ports.executionId,
          turnId: ports.turnId
        })
      });
      retained = result.retained;
      await modelContext.adoptCompactCheckpoint(
        result.record.recordId,
        replacementHistory,
        retained,
        resources
      );
      ports.invalidateUsage();
    } catch (error) {
      if (committed) ports.invalidateContext(error);
      throw error;
    }
    await ports.emit({
      type: 'context.compacted',
      compactionId,
      async: input.async === true,
      retainedContext: retained.length > 0,
      ...anchor
    });
    return true;
  };
}
