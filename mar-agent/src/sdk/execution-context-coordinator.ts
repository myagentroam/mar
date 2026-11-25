import { AgentError } from '../error.js';
import { AGENT_EXECUTION_POLICY } from '../runtime/execution-policy.js';
import type { ContextGcRuntime, ContextGcRuntimeInput } from '../runtime/context/gc-runtime.js';
import { modelContextUsage } from '../runtime/context/gc-admission.js';
import type { SessionModelMessage } from '../session/model-request.js';
import type { SessionRecord } from '../session/record-contract.js';
import { isAgentEvent } from '../session/record-projection.js';
import type { PreparedExecutionRound } from '../runtime/execution.js';
import type { RoundToolScope } from '../tools/execution.js';
import type { CompactCoordinator, CompactFlight } from '../runtime/compaction/coordinator.js';
import type { CompactRequests } from '../runtime/compaction/requests.js';
import type { SessionExecution } from './session-execution.js';
import type { ExecutionModelLifecycle } from './execution-model-lifecycle.js';
import type { createExecutionModelContext } from './execution-model-context.js';
import type { ResourceInputProjection } from './resource-input.js';
import type { ContextGcMode } from '../model/configuration.js';
import { THOUGHT_TOOL_NAME } from '../runtime/context/thought-contract.js';

type GcRound = {
  readonly request: Pick<PreparedExecutionRound<RoundToolScope>['request'], 'system'>;
  readonly toolScope: Pick<RoundToolScope, 'tools'>;
};
type GcUsage = ContextGcRuntimeInput['usage'] | undefined;
type NaturalTurnGc = { readonly usage: GcUsage };

/** Restore the preceding natural Turn's GC trigger without extending request calibration. */
export function previousNaturalTurnGc(
  records: readonly SessionRecord[],
  model: { readonly id: string; readonly contextWindowTokens: number }
): NaturalTurnGc | undefined {
  const terminalIndex = records.findLastIndex(
    (record) =>
      record.type === 'execution.started' ||
      record.type === 'execution.completed' ||
      record.type === 'execution.cancelled' ||
      record.type === 'execution.failed'
  );
  const terminal = records[terminalIndex];
  const event = terminal?.payload;
  if (
    terminal?.type !== 'execution.completed' ||
    !terminal.executionId ||
    !isAgentEvent(event) ||
    event.type !== 'execution.completed' ||
    event.permissionStop !== undefined
  )
    return undefined;

  let hasAnswer = false;
  let usage: GcUsage;
  let canUseUsage = true;
  for (let index = terminalIndex - 1; index >= 0; index--) {
    const record = records[index]!;
    if (record.type === 'context.gc.completed') canUseUsage = false;
    if (record.executionId !== terminal.executionId) continue;
    const payload = record.payload;
    if (record.type === 'execution.started') break;
    // A Compact base can replace the execution header in restored context records.
    if (record.type === 'execution.header' || record.type === 'compact.completed') {
      const header = payload as
        { mode?: string; modelId?: string; contextWindowTokens?: number } | undefined;
      if (!hasAnswer || header?.mode === 'compact') return undefined;
      return {
        usage:
          header?.modelId === model.id && header.contextWindowTokens === model.contextWindowTokens
            ? usage
            : undefined
      };
    }
    if (!isAgentEvent(payload)) continue;
    if (
      payload.type === 'message.completed' &&
      payload.phase === 'final_answer' &&
      typeof payload.text === 'string' &&
      payload.text.trim()
    )
      hasAnswer = true;
    if (
      canUseUsage &&
      !usage &&
      payload.type === 'usage.updated' &&
      payload.purpose !== 'compact'
    ) {
      const tokens = modelContextUsage(payload);
      if (tokens !== undefined) usage = { contextInputTokens: tokens };
    }
  }
  return undefined;
}

/** Coordinates safe-point adoption of Compact and GC without owning Session state. */
export class ExecutionContextCoordinator {
  #boundary: number;
  #thoughtCallIds: readonly string[] = [];
  #naturalTurnGc: NaturalTurnGc | undefined;
  constructor(
    private readonly ports: {
      readonly initialBoundary: number;
      readonly messages: SessionModelMessage[];
      readonly resources: Pick<
        ResourceInputProjection,
        'hasPendingImages' | 'gcCandidate' | 'historyView'
      >;
      readonly execution: Pick<SessionExecution, 'appendBoundary' | 'assertContextValid'>;
      readonly model: Pick<ExecutionModelLifecycle, 'tokens'>;
      readonly context: Pick<
        ReturnType<typeof createExecutionModelContext>,
        'syncCatalogWorldState' | 'recordEnvironment' | 'adoptGcCheckpoint'
      >;
      readonly compact: Pick<CompactCoordinator, 'pending' | 'checkpoint'>;
      readonly requests: Pick<CompactRequests, 'drain'>;
      readonly signal: AbortSignal;
      readonly window: number;
      readonly contextGcMode: ContextGcMode;
      readonly naturalTurnGc?: NaturalTurnGc | undefined;
      readonly gc: Pick<ContextGcRuntime, 'run' | 'skipRollout'>;
      readonly gcBase: Omit<
        ContextGcRuntimeInput,
        'system' | 'tools' | 'usage' | 'inlineMedia' | 'mediaView' | 'getActiveProcessIds'
      >;
      start(input?: { focus?: string; async?: boolean }): CompactFlight;
      wait(input?: { focus?: string; async?: boolean }): Promise<boolean>;
      activeProcesses(): Promise<ReadonlySet<string>>;
    }
  ) {
    this.#boundary = ports.initialBoundary;
    this.#naturalTurnGc = ports.naturalTurnGc;
  }

  get boundary(): number {
    return this.#boundary;
  }
  setBoundary(value: number): void {
    this.#boundary = value;
  }
  advanceBoundary(): void {
    if (!this.ports.resources.hasPendingImages(this.ports.messages.slice(this.#boundary)))
      this.#boundary = this.ports.messages.length;
  }
  drainRequests(): boolean {
    return this.ports.requests.drain((input) =>
      this.ports.start({
        ...(input.prompt === undefined ? {} : { focus: input.prompt }),
        async: input.async === true
      })
    );
  }
  async prepareInputs(ports: {
    includeSessionContext: boolean;
    appendMailbox(): Promise<unknown>;
    appendSessionContext(): Promise<void>;
    refreshTools(): void;
    updateEnvironment(): void;
  }): Promise<void> {
    await ports.appendMailbox();
    if (ports.includeSessionContext) await ports.appendSessionContext();
    ports.refreshTools();
    await this.ports.context.syncCatalogWorldState(this.ports.messages.length);
    this.advanceBoundary();
    if (this.drainRequests()) await this.ports.compact.checkpoint(true);
    await this.ensureBudget();
    await this.ports.context.syncCatalogWorldState(this.ports.messages.length);
    ports.updateEnvironment();
    await this.ports.context.recordEnvironment();
  }
  async ensureBudget(): Promise<void> {
    const { model, compact, window, signal, execution } = this.ports;
    const percent = model.tokens === undefined ? undefined : (model.tokens * 100) / window;
    if (percent !== undefined && percent >= AGENT_EXECUTION_POLICY.automaticCompactionPercent) {
      const hadPending = compact.pending;
      let compacted: boolean;
      try {
        compacted = await this.ports.wait();
      } catch (error) {
        signal.throwIfAborted();
        execution.assertContextValid();
        if (!hadPending) throw error;
        this.advanceBoundary();
        compacted = await this.ports.wait();
      }
      if (!compacted)
        throw new AgentError(
          'MAR_AGENT_CONTEXT_LIMIT',
          'Provider usage reached the compaction threshold but no history can be compacted.'
        );
    } else {
      const adopted = await compact.checkpoint(false).catch(() => {
        signal.throwIfAborted();
        execution.assertContextValid();
      });
      if (
        !adopted &&
        percent !== undefined &&
        percent >= AGENT_EXECUTION_POLICY.backgroundCompactionPercent &&
        !compact.pending
      )
        this.ports.start({ async: true });
    }
  }
  async checkpoint(
    round: PreparedExecutionRound<RoundToolScope>,
    usage: GcUsage,
    thoughtCallIds: readonly string[] = []
  ): Promise<void> {
    this.advanceBoundary();
    const blocking = this.drainRequests();
    if (blocking) await this.ports.compact.checkpoint(true);
    else
      await this.ports.compact.checkpoint(false).catch(() => {
        this.ports.signal.throwIfAborted();
        this.ports.execution.assertContextValid();
      });
    if (this.ports.contextGcMode === 'auto' && !this.ports.compact.pending)
      await this.gc(round, usage, await this.ports.resources.gcCandidate(), true);
    if (this.ports.contextGcMode === 'with_thought') {
      this.#thoughtCallIds = thoughtCallIds;
      if (thoughtCallIds.length === 0 && !this.ports.compact.pending)
        this.ports.gc.skipRollout(usage, this.ports.window);
    }
  }
  invalidateNaturalTurnGc(): void {
    this.#naturalTurnGc = undefined;
  }
  /** Combine one-shot regular triggers with the dispatch-time image hard limit. */
  async prepareRequestGc(
    round: GcRound,
    messages: readonly SessionModelMessage[],
    latestUsage: GcUsage,
    media: ContextGcRuntimeInput['inlineMedia']
  ): Promise<boolean> {
    const pending = this.#thoughtCallIds;
    this.#thoughtCallIds = [];
    const naturalTurn = this.#naturalTurnGc;
    this.invalidateNaturalTurnGc();
    const thought =
      pending.length > 0 &&
      messages.some(
        (message) =>
          message.role === 'tool_call' &&
          message.name === THOUGHT_TOOL_NAME &&
          message.callId !== undefined &&
          pending.includes(message.callId)
      );
    const hardLimit = media?.reason === 'HARD_LIMIT';
    if (!thought && !naturalTurn && !hardLimit) return false;
    const usage = naturalTurn && !thought ? naturalTurn.usage : latestUsage;
    return this.gc(round, usage, media, thought || naturalTurn?.usage !== undefined);
  }
  async gc(
    round: GcRound,
    usage: GcUsage,
    media: ContextGcRuntimeInput['inlineMedia'],
    includeProcesses = false
  ): Promise<boolean> {
    if (this.ports.contextGcMode === 'off' || this.ports.compact.pending) return false;
    this.ports.signal.throwIfAborted();
    const appendBoundary = this.ports.execution.appendBoundary;
    const committed = await this.ports.gc.run({
      ...this.ports.gcBase,
      inlineMedia: media,
      mediaView: (messages) => this.ports.resources.historyView(messages),
      system: round.request.system,
      tools: round.toolScope.tools,
      usage: usage ?? {},
      ...(includeProcesses ? { getActiveProcessIds: () => this.ports.activeProcesses() } : {})
    });
    if (!committed) return false;
    await this.ports.context.adoptGcCheckpoint(committed, appendBoundary);
    return true;
  }
}
