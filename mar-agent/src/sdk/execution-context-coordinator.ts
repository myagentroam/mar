import { AgentError } from '../error.js';
import { AGENT_EXECUTION_POLICY } from '../runtime/execution-policy.js';
import type { ContextGcRuntime, ContextGcRuntimeInput } from '../runtime/context/gc-runtime.js';
import type { SessionModelMessage } from '../session/model-request.js';
import type { PreparedExecutionRound } from '../runtime/execution.js';
import type { RoundToolScope } from '../tools/execution.js';
import type { CompactCoordinator, CompactFlight } from '../runtime/compaction/coordinator.js';
import type { CompactRequests } from '../runtime/compaction/requests.js';
import type { SessionExecution } from './session-execution.js';
import type { ExecutionModelLifecycle } from './execution-model-lifecycle.js';
import type { createExecutionModelContext } from './execution-model-context.js';
import type { ResourceInputProjection } from './resource-input.js';
import type { ContextGcMode } from '../model/configuration.js';
import { THOUGHT_TOOL_NAME } from '../tools/agent/thought.js';

type GcRound = {
  readonly request: Pick<PreparedExecutionRound<RoundToolScope>['request'], 'system'>;
  readonly toolScope: Pick<RoundToolScope, 'tools'>;
};
type GcUsage = ContextGcRuntimeInput['usage'] | undefined;

/** Coordinates safe-point adoption of Compact and GC without owning Session state. */
export class ExecutionContextCoordinator {
  #boundary: number;
  #thought: { readonly callIds: readonly string[]; readonly usage: GcUsage } | undefined;
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
      this.#thought = thoughtCallIds.length === 0 ? undefined : { callIds: thoughtCallIds, usage };
      if (this.#thought === undefined && !this.ports.compact.pending)
        this.ports.gc.skipRollout(usage, this.ports.window);
    }
  }
  /** Merge a one-round Thought trigger with the existing dispatch-time hard limit. */
  async prepareRequestGc(
    round: GcRound,
    messages: readonly SessionModelMessage[],
    usage: GcUsage,
    media: ContextGcRuntimeInput['inlineMedia']
  ): Promise<boolean> {
    const pending = this.#thought;
    this.#thought = undefined;
    const thought =
      pending !== undefined &&
      messages.some(
        (message) =>
          message.role === 'tool_call' &&
          message.name === THOUGHT_TOOL_NAME &&
          message.callId !== undefined &&
          pending.callIds.includes(message.callId)
      );
    const hardLimit = media?.reason === 'HARD_LIMIT';
    if (!thought && !hardLimit) return false;
    // The image hard limit keeps its own usage source even when a Thought also triggers GC.
    return this.gc(round, hardLimit ? usage : pending?.usage, media, thought);
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
