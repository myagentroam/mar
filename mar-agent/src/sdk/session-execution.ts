import type { ExtensionInputSource } from '../extensions/session-input.js';
import type { SubagentMailboxMessage } from '../subagent/session-controller.js';
import { AsyncQueue } from '../runtime/async-queue.js';
import { randomUUID } from 'node:crypto';
import { eventForPersistence } from '../runtime/event-projection.js';
import { ExecutionLoop } from '../runtime/execution.js';
import type { RoundToolScope } from '../tools/execution.js';
import { CompactCoordinator } from '../runtime/compaction/coordinator.js';
import { CompactRequests } from '../runtime/compaction/requests.js';
import { DEFAULT_COMPACTION_FOCUS } from '../runtime/compaction/history.js';
import type { ExecutionMode, ExecutionResult, AgentEvent } from './types.js';
import type { ModelAdapter, ModelTurnSession } from '../model/contracts.js';
import { AgentError } from '../error.js';
import type { SubagentMessageDelivery } from '../subagent/session-controller.js';
import type { SessionModelMessage } from '../session/model-request.js';
import type { ExecutionToolSources } from './extension-tools.js';
import type { ExecutionHandle } from './types.js';
import {
  createExecutionModelResources,
  createModelTurnSession,
  type ResolvedModelConfiguration
} from './model-runtime.js';

export interface InternalExecutionOptions {
  readonly publishHostEvents?: boolean;
  readonly signal?: AbortSignal;
  readonly inputSource?: 'parent_agent' | 'extension';
  readonly extensionSource?: ExtensionInputSource;
  readonly automaticInput?: boolean;
  readonly inputCommitted?: (recordId: string) => void;
  readonly promptAdmitted?: boolean;
  readonly modelText?: string;
  readonly inputContext?: readonly string[];
  readonly modelContext?: readonly string[];
  readonly initialMailbox?: readonly SubagentMailboxMessage[];
  readonly turnId?: string;
  readonly delivery?: SubagentMessageDelivery;
  readonly mcpExecutionScopeId?: string;
}

export interface InternalExecutionHandle extends ExecutionHandle {
  readonly persistedEvents: boolean;
  readonly turnId: string;
  enqueueMessage(message: string, delivery?: SubagentMessageDelivery): boolean;
}

export interface SessionExecutionContext {
  readonly executionId: string;
  readonly modelId: string;
  readonly mode: ExecutionMode;
  readonly models: ReadonlyMap<string, ResolvedModelConfiguration>;
  readonly instruction: string | undefined;
  readonly steer?:
    | ((input: import('./types.js').SteerInput) => Promise<import('./types.js').SteerResult>)
    | undefined;
  readonly compactRequests?: CompactRequests | undefined;
  readonly requestMessages?: { read(): readonly SessionModelMessage[] } | undefined;
  readonly appendedMessages?:
    { append(recordId: string, message: SessionModelMessage): void } | undefined;
  readonly toolSources?: ExecutionToolSources | undefined;
}

export type ExecutionEventPayload<T = AgentEvent> = T extends AgentEvent
  ? Omit<T, 'eventId' | 'sequence' | 'timestamp' | 'sessionId' | 'executionId' | 'turnId'>
  : never;

export interface ExecutionEventPorts {
  persist(event: AgentEvent, payload: AgentEvent): Promise<void>;
  publish?(event: AgentEvent): void | Promise<void>;
  hasRetainedLease?(): boolean;
}

interface ExecutionFinalization {
  readonly failed: boolean;
  readonly reason: unknown;
  releaseImageBytes(): void;
  revokeBindings(): void;
  closeToolSources(): void;
  detachAbort(): void;
  endParent(): void;
  deactivate(): void;
}

/** Resources and settlement of one Execution, independent of its Session identity. */
export class SessionExecution {
  #contextInvalid = false;
  #contextFailure: unknown;
  #bindings: Pick<
    { -readonly [K in keyof SessionExecutionContext]: SessionExecutionContext[K] },
    'steer' | 'compactRequests' | 'requestMessages' | 'appendedMessages' | 'toolSources'
  >;

  bindViews(
    views: Partial<
      Pick<SessionExecutionContext, 'requestMessages' | 'appendedMessages' | 'toolSources'>
    >
  ): void {
    Object.assign(this.#bindings, views);
  }

  acceptSteer(steer: NonNullable<SessionExecutionContext['steer']>): void {
    this.#bindings = { ...this.#bindings, steer };
  }

  stopSteer(): void {
    delete this.#bindings.steer;
  }

  retireCompactRequests(reason: unknown): void {
    this.compactRequests.close(reason);
    delete this.#bindings.compactRequests;
  }

  revokeViews(reason: unknown): void {
    delete this.#bindings.requestMessages;
    this.retireCompactRequests(reason);
    delete this.#bindings.appendedMessages;
    delete this.#bindings.steer;
  }

  detachToolSources(): void {
    delete this.#bindings.toolSources;
  }

  invalidateContext(error: unknown): void {
    if (this.#contextInvalid) return;
    this.#contextInvalid = true;
    this.#contextFailure = error;
  }

  assertContextValid(): void {
    if (this.#contextInvalid) throw this.#contextFailure;
  }
  readonly controller = new AbortController();
  readonly events = new AsyncQueue<AgentEvent>();
  readonly compact = new CompactCoordinator();
  readonly compactRequests: CompactRequests;
  readonly context: SessionExecutionContext;
  private resultPromise: Promise<ExecutionResult> | undefined;
  private readonly modelResources: ReturnType<typeof createExecutionModelResources>;
  private eventTail = Promise.resolve();
  private terminalAdmitted = false;
  private releaseLease: (() => Promise<void>) | undefined;
  private eventSequence = 0;
  private persistedTerminal = false;
  private completionAdmitted = false;
  private appendedMessages: { readonly recordId: string; readonly message: SessionModelMessage }[] =
    [];
  private messageTarget: SessionModelMessage[] | undefined;
  private mainLoop: ExecutionLoop<RoundToolScope> | undefined;

  constructor(
    readonly sessionId: string,
    readonly executionId: string,
    readonly turnId: string,
    readonly kind: ExecutionMode | 'compact',
    readonly source: 'user' | 'subagent',
    readonly snapshot: {
      readonly modelId: string;
      readonly mode: ExecutionMode;
      readonly models: ReadonlyMap<string, ResolvedModelConfiguration>;
      readonly generation: number;
      readonly instruction: string | undefined;
    },
    activeAdapters: Parameters<typeof createExecutionModelResources>[0]
  ) {
    this.compactRequests = new CompactRequests(executionId, () =>
      this.compact.assertNotReentrant()
    );
    this.#bindings = { compactRequests: this.compactRequests };
    const owner = this;
    this.context = Object.freeze({
      executionId,
      modelId: snapshot.modelId,
      mode: snapshot.mode,
      models: snapshot.models,
      instruction: snapshot.instruction,
      get compactRequests() {
        return owner.#bindings.compactRequests;
      },
      get steer() {
        return owner.#bindings.steer;
      },
      get requestMessages() {
        return owner.#bindings.requestMessages;
      },
      get appendedMessages() {
        return owner.#bindings.appendedMessages;
      },
      get toolSources() {
        return owner.#bindings.toolSources;
      }
    });
    this.modelResources = createExecutionModelResources(activeAdapters);
  }

  openMainTurn(adapter: ModelAdapter, ownsAdapter: boolean): ModelTurnSession {
    return this.modelResources.openTurn(adapter, ownsAdapter);
  }

  async runMainLoop(options: ConstructorParameters<typeof ExecutionLoop<RoundToolScope>>[0]) {
    const loop = new ExecutionLoop<RoundToolScope>(options);
    this.mainLoop = loop;
    return loop.run();
  }

  async prepare(input: {
    acquireLease(): Promise<Parameters<SessionExecution['adoptLease']>[0]>;
    waitForInputs(): Promise<void>;
    bindCommittedInputs(): void;
    refreshAdapters(): Promise<void>;
  }): Promise<void> {
    this.controller.signal.throwIfAborted();
    this.adoptLease(await input.acquireLease());
    await input.waitForInputs();
    input.bindCommittedInputs();
    await input.refreshAdapters();
  }

  get finalAnswer(): string | undefined {
    return this.mainLoop?.finalAnswer;
  }

  async withCompactTurn<T>(
    adapter: ModelAdapter,
    run: (turn: ModelTurnSession) => Promise<T>
  ): Promise<T> {
    const turn = createModelTurnSession(adapter);
    let failed = false;
    try {
      return await run(turn);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        await turn.close();
      } catch (error) {
        // A cleanup failure cannot replace the generation failure.
        if (!failed) throw error;
      }
    }
  }

  async closeModelTurns(reason: unknown): Promise<void> {
    let failed = false;
    let failure: unknown;
    try {
      await this.compact.close(reason);
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      await this.modelResources.close();
    } catch (error) {
      if (!failed) failure = error;
      failed = true;
    }
    if (failed) throw failure;
  }

  appendCommittedMessage(recordId: string, message: SessionModelMessage): void {
    this.appendedMessages.push({ recordId, message });
    this.messageTarget?.push(message);
  }

  connectMessageProjection(
    messages: SessionModelMessage[],
    restoredIds: ReadonlySet<string>
  ): void {
    for (const pending of this.appendedMessages)
      if (!restoredIds.has(pending.recordId)) messages.push(pending.message);
    this.appendedMessages.length = 0;
    this.messageTarget = messages;
  }

  clearAppendedMessages(): void {
    this.appendedMessages.length = 0;
  }
  get appendBoundary(): number {
    return this.appendedMessages.length;
  }
  appendedAfter(boundary: number, restoredIds: ReadonlySet<string>): SessionModelMessage[] {
    return this.appendedMessages
      .slice(boundary)
      .filter((entry) => !restoredIds.has(entry.recordId))
      .map((entry) => entry.message);
  }

  orderEvent<T>(action: () => Promise<T>, advance = true): Promise<T> {
    const operation = this.eventTail.then(action);
    if (advance)
      this.eventTail = operation.then(
        () => undefined,
        () => undefined
      );
    return operation;
  }

  emit(
    event: ExecutionEventPayload,
    ports: ExecutionEventPorts,
    assertLive?: () => void
  ): Promise<void> {
    assertLive?.();
    const full = {
      ...event,
      eventId: randomUUID(),
      sequence: ++this.eventSequence,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      executionId: this.executionId,
      turnId: this.turnId
    } as AgentEvent;
    return this.orderEvent(async () => {
      assertLive?.();
      if (full.type === 'tool.output' && this.terminalAdmitted) return;
      if (full.type === 'execution.completed') {
        this.controller.signal.throwIfAborted();
        this.completionAdmitted = true;
      }
      if (
        full.type === 'execution.completed' ||
        full.type === 'execution.failed' ||
        full.type === 'execution.cancelled'
      )
        this.terminalAdmitted = true;
      const persistent = eventForPersistence(full);
      let committedTerminal = false;
      const retainedToolEvent =
        this.terminalAdmitted &&
        (full.type === 'tool.started' ||
          full.type === 'tool.completed' ||
          full.type === 'tool.failed') &&
        full.parentCallId !== undefined &&
        ports.hasRetainedLease?.() === true;
      if (persistent !== undefined && (this.hasLease || retainedToolEvent)) {
        await ports.persist(full, persistent);
        if (
          full.type === 'execution.completed' ||
          full.type === 'execution.failed' ||
          full.type === 'execution.cancelled'
        )
          committedTerminal = this.persistedTerminal = true;
      }
      if (full.type === 'tool.output') this.events.pushIfWaiting(full);
      else this.events.push(full);
      this.compactRequests.publish(full);
      try {
        await ports.publish?.(full);
      } catch (error) {
        if (!committedTerminal) throw error;
        try {
          process.emitWarning(
            new AgentError(
              'MAR_AGENT_HOST_EVENT_PUBLICATION_FAILED',
              `Host publication of ${full.type} failed for Execution ${this.executionId}.`,
              {
                details: {
                  sessionId: this.sessionId,
                  executionId: this.executionId,
                  eventId: full.eventId,
                  eventType: full.type
                }
              }
            )
          );
        } catch {
          // A diagnostic sink must not change a committed outcome.
        }
      }
    }, full.type !== 'tool.output');
  }

  adoptLease(release: () => Promise<void>): void {
    this.releaseLease = release;
  }

  get hasLease(): boolean {
    return this.releaseLease !== undefined;
  }

  async releaseSessionLease(): Promise<void> {
    const release = this.releaseLease;
    this.releaseLease = undefined;
    await release?.();
  }

  async finish(input: ExecutionFinalization): Promise<void> {
    let failed = false;
    let failure: unknown;
    const attemptSync = (action: () => void) => {
      try {
        action();
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    };
    const attempt = async (action: () => void | Promise<void>) => {
      try {
        await action();
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    };
    attemptSync(input.releaseImageBytes);
    attemptSync(input.revokeBindings);
    this.messageTarget = undefined;
    this.appendedMessages.length = 0;
    attemptSync(input.closeToolSources);
    attemptSync(input.detachAbort);
    await attempt(() => this.closeModelTurns(input.reason));
    await attempt(input.endParent);
    await attempt(() => this.releaseSessionLease());
    attemptSync(input.deactivate);
    this.events.close();
    if (failed && !input.failed) throw failure;
  }

  start(input: {
    readonly scope: (run: () => Promise<ExecutionResult>) => Promise<ExecutionResult>;
    readonly prepareProgram: () => Promise<
      | { readonly inputHandled: true }
      | {
          run(focus?: string, signal?: AbortSignal): Promise<void>;
          performManualCompact(
            run: (focus: string | undefined, signal: AbortSignal) => Promise<void>
          ): Promise<unknown>;
          finalAnswer(): string;
          permissionStop(): ExecutionResult['permissionStop'];
        }
    >;
    readonly beforeFailure: (error: unknown) => Promise<void>;
    readonly diagnostic: (error: unknown) => { code: string; message: string };
    readonly emit: (event: ExecutionEventPayload) => Promise<void>;
    readonly endParent: () => void;
    readonly finalize: (failed: boolean) => Promise<void>;
    readonly settle: (status: ExecutionResult['status']) => void;
  }): void {
    const result = input.scope(async () => {
      let failed = false;
      try {
        const program = await input.prepareProgram();
        if ('inputHandled' in program) {
          this.controller.signal.throwIfAborted();
          await input.emit({ type: 'execution.completed' });
          return {
            executionId: this.executionId,
            status: 'completed',
            finalAnswer: '',
            inputHandled: true
          };
        }
        if (this.kind === 'compact')
          await program.performManualCompact((focus, signal) =>
            program.run(focus ?? DEFAULT_COMPACTION_FOCUS, signal)
          );
        else await program.run();
        this.controller.signal.throwIfAborted();
        const permissionStop = program.permissionStop();
        const result = {
          finalAnswer: this.kind === 'compact' || permissionStop ? '' : program.finalAnswer(),
          ...(permissionStop ? { permissionStop } : {})
        };
        input.endParent();
        await input.emit({
          type: 'execution.completed',
          ...(result.permissionStop ? { permissionStop: result.permissionStop } : {})
        });
        return { executionId: this.executionId, status: 'completed', ...result };
      } catch (error) {
        failed = true;
        await input.beforeFailure(error);
        input.endParent();
        const finalAnswer = this.kind === 'compact' ? '' : (this.finalAnswer ?? '');
        if (this.controller.signal.aborted) {
          await input.emit({ type: 'execution.cancelled' }).catch(() => undefined);
          return { executionId: this.executionId, status: 'cancelled', finalAnswer };
        }
        const diagnostic = input.diagnostic(error);
        await input.emit({ type: 'execution.failed', ...diagnostic }).catch(() => undefined);
        return {
          executionId: this.executionId,
          status: 'failed',
          finalAnswer,
          errorCode: diagnostic.code,
          errorMessage: diagnostic.message
        };
      } finally {
        await input.finalize(failed);
      }
    });
    this.resultPromise = result;
    void result.then(
      (outcome) => input.settle(outcome.status),
      () => input.settle('failed')
    );
  }

  join(): Promise<ExecutionResult> | undefined {
    return this.resultPromise;
  }

  handle(
    enqueueMessage: (message: string, delivery?: SubagentMessageDelivery) => boolean
  ): InternalExecutionHandle {
    const owner = this;
    return {
      get persistedEvents() {
        return owner.persistedTerminal;
      },
      executionId: this.executionId,
      turnId: this.turnId,
      [Symbol.asyncIterator]: () => this.events[Symbol.asyncIterator](),
      result: () => {
        this.events.discardIfUnobserved();
        return this.resultPromise!;
      },
      cancel: () => owner.cancel(new AgentError('MAR_AGENT_CANCELLED', 'Execution was cancelled.')),
      enqueueMessage
    };
  }

  cancel(reason?: unknown): void {
    if (this.completionAdmitted) return;
    this.controller.abort(reason);
  }
}
