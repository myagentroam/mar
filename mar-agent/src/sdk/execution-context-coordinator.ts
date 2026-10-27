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

/** Coordinates safe-point adoption of Compact and GC without owning Session state. */
export class ExecutionContextCoordinator {
  #boundary: number;
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
        'syncMcpWorldState' | 'recordEnvironment' | 'adoptGcCheckpoint'
      >;
      readonly compact: Pick<CompactCoordinator, 'pending' | 'checkpoint'>;
      readonly requests: Pick<CompactRequests, 'drain'>;
      readonly signal: AbortSignal;
      readonly window: number;
      readonly gc: Pick<ContextGcRuntime, 'run'>;
      readonly gcBase: Omit<
        ContextGcRuntimeInput,
        'system' | 'tools' | 'usage' | 'inlineMedia' | 'mediaView' | 'getActiveProcessIds'
      >;
      readonly child: boolean;
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
    includeSubagentUpdates: boolean;
    appendMailbox(): Promise<unknown>;
    appendSubagentUpdates(): Promise<void>;
    refreshTools(): void;
    updateEnvironment(): void;
  }): Promise<void> {
    await ports.appendMailbox();
    if (ports.includeSubagentUpdates) await ports.appendSubagentUpdates();
    ports.refreshTools();
    await this.ports.context.syncMcpWorldState(this.ports.messages.length);
    this.advanceBoundary();
    if (this.drainRequests()) await this.ports.compact.checkpoint(true);
    await this.ensureBudget();
    await this.ports.context.syncMcpWorldState(this.ports.messages.length);
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
    usage: ContextGcRuntimeInput['usage'] | undefined
  ): Promise<void> {
    this.advanceBoundary();
    const blocking = this.drainRequests();
    if (blocking) await this.ports.compact.checkpoint(true);
    else
      await this.ports.compact.checkpoint(false).catch(() => {
        this.ports.signal.throwIfAborted();
        this.ports.execution.assertContextValid();
      });
    if (!this.ports.compact.pending && !this.ports.child)
      await this.gc(round, usage, await this.ports.resources.gcCandidate(), true);
  }
  async gc(
    round: {
      readonly request: Pick<PreparedExecutionRound<RoundToolScope>['request'], 'system'>;
      readonly toolScope: Pick<RoundToolScope, 'tools'>;
    },
    usage: ContextGcRuntimeInput['usage'] | undefined,
    media: ContextGcRuntimeInput['inlineMedia'],
    includeProcesses = false
  ): Promise<boolean> {
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
