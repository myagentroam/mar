import { AgentError } from '../error.js';
import {
  ExtensionRequestSnapshots,
  type ExtensionRequestSnapshot
} from '../extensions/model-request.js';
import type {
  ExtensionSessionBackend,
  SessionInputCoordinator
} from '../extensions/session-input.js';
import type { ModelAdapter } from '../model/contracts.js';
import type { ModelCredentialProvider } from '../model/configuration.js';
import type { SessionModelRequest as ModelRequest } from '../session/model-request.js';
import type { SessionStore } from '../session/store/contracts.js';
import {
  latestContextualWorldStateGeneration,
  parsePersistedContextualWorldState,
  type ContextualWorldState
} from '../runtime/context/world-state.js';
import { TodoStore } from '../tools/agent/todo.js';
import { createSessionToolScheduler } from '../tools/scheduler.js';
import type { ExecutionResult } from './types.js';
import type { AgentEvent } from '../runtime/events.js';
import type { ResolvedModelConfiguration } from './model-runtime.js';
import type { SessionExecution, SessionExecutionContext } from './session-execution.js';
import { SessionModelAdapters } from './session-model-adapters.js';

export class SessionRuntime {
  #executionContext: SessionExecutionContext | undefined;
  #todo: TodoStore | undefined;
  readonly scheduleTool = createSessionToolScheduler();
  readonly #modelAdapters: SessionModelAdapters;
  #contextualWorldState: ContextualWorldState | undefined;
  #inputs: SessionInputCoordinator | undefined;
  #requestSnapshots: ExtensionRequestSnapshots | undefined;
  #recordProjection: Promise<unknown> | undefined;
  #sessionBackend: (ExtensionSessionBackend & { kick(): void }) | undefined;
  readonly #executions = new Map<string, SessionExecution>();
  #activeExecutionId: string | undefined;
  readonly #eventObservers = new Set<(event: AgentEvent) => void>();

  constructor(
    readonly storedSession: Awaited<ReturnType<SessionStore['getSession']>>,
    generation: number,
    createAdapter: (
      modelId: string,
      models: ReadonlyMap<string, ResolvedModelConfiguration>
    ) => ModelAdapter,
    hasCustomAdapters: boolean,
    readonly onExecutionRegistered: (runtime: SessionRuntime) => void = () => {}
  ) {
    this.#modelAdapters = new SessionModelAdapters(generation, createAdapter, hasCustomAdapters);
  }

  adapter(modelId: string, models: ReadonlyMap<string, ResolvedModelConfiguration>): ModelAdapter {
    return this.#modelAdapters.getOrCreate(modelId, models);
  }

  refreshAdapters(generation: number, retained: ReadonlySet<ModelAdapter>): Promise<void> {
    return this.#modelAdapters.refresh(generation, retained);
  }

  static stageModelReconfiguration(
    sessions: readonly SessionRuntime[],
    models: ReadonlyMap<string, ResolvedModelConfiguration>,
    active: ReadonlySet<ModelAdapter>,
    assertOpen: () => void
  ): Promise<(generation: number) => void> {
    return SessionModelAdapters.stageReconfiguration(
      sessions.map((session) => session.#modelAdapters),
      models,
      active,
      assertOpen
    );
  }

  collectActiveModelAdapters(target: Set<ModelAdapter>): void {
    this.#modelAdapters.collectActiveReferences(target);
  }
  collectModelCredentialProviders(target: Set<ModelCredentialProvider>): void {
    this.#modelAdapters.collectCredentialProviders(target);
  }
  hasModelAdapter(adapter: ModelAdapter): boolean {
    return this.#modelAdapters.hasReference(adapter);
  }
  takeAdaptersForClose(): readonly ModelAdapter[] {
    return this.#modelAdapters.drain();
  }
  static closeModelAdapters(sessions: readonly SessionRuntime[]): Promise<void> {
    return SessionModelAdapters.closeSessions(sessions.map((session) => session.#modelAdapters));
  }

  retireInputs(): Promise<unknown> | undefined {
    return this.#inputs?.retire();
  }
  getOrCreateInputs(create: () => SessionInputCoordinator): SessionInputCoordinator {
    return (this.#inputs ??= create());
  }
  resetAfterClear(generation: number): void {
    this.#modelAdapters.setGeneration(generation);
    this.#todo = undefined;
    this.#contextualWorldState = undefined;
    this.#inputs = undefined;
    this.#requestSnapshots = undefined;
  }

  recordRequest(modelId: string, request: ModelRequest): ExtensionRequestSnapshot {
    return (this.#requestSnapshots ??= new ExtensionRequestSnapshots()).record(modelId, request);
  }
  completeRequest(snapshot: ExtensionRequestSnapshot): void {
    this.#requestSnapshots?.complete(snapshot);
  }
  captureRequest(input: Parameters<ExtensionRequestSnapshots['capture']>[0]) {
    return this.#requestSnapshots?.capture(input);
  }
  resolveRequest(snapshot: ExtensionRequestSnapshot) {
    if (!this.#requestSnapshots)
      throw new AgentError('MAR_AGENT_MODEL_SNAPSHOT_INVALID', 'Request snapshot is unavailable.');
    return this.#requestSnapshots.resolve(snapshot);
  }

  async withRecordProjection<T>(action: () => Promise<T>): Promise<T> {
    const pending = (this.#recordProjection ?? Promise.resolve())
      .catch(() => undefined)
      .then(action);
    this.#recordProjection = pending;
    try {
      return await pending;
    } finally {
      if (this.#recordProjection === pending) this.#recordProjection = undefined;
    }
  }

  async joinRecordProjection(): Promise<void> {
    await this.#recordProjection?.catch(() => undefined);
  }

  get sourceType(): 'user' | 'subagent' {
    return this.storedSession.source.type;
  }

  restoreTodo(snapshot: Parameters<typeof TodoStore.restore>[0], retained: boolean): TodoStore {
    if (!retained) this.#todo = TodoStore.restore(snapshot);
    return (this.#todo ??= TodoStore.restore(snapshot));
  }

  async restoreExecutionState(
    store: Pick<
      SessionStore,
      'readExecutionState' | 'readContextualWorldState' | 'hasRetainedSessionLease'
    >,
    writerOwner: object
  ) {
    const sessionId = this.storedSession.id;
    const state = await store.readExecutionState(sessionId);
    const todo = this.restoreTodo(
      state.todo,
      store.hasRetainedSessionLease(sessionId, writerOwner)
    );
    const generation = latestContextualWorldStateGeneration(state.contextRecords);
    const persisted = parsePersistedContextualWorldState(
      await store.readContextualWorldState(sessionId)
    );
    const world =
      this.#contextualWorldState?.generation === generation &&
      this.#contextualWorldState !== undefined
        ? this.#contextualWorldState
        : persisted?.generation === generation && persisted !== undefined
          ? persisted
          : {
              generation,
              initialized: false,
              instructionSnapshot: undefined,
              resourceSnapshot: undefined,
              entries: []
            };
    this.#contextualWorldState = world;
    return { todo, contextRecords: state.contextRecords, generation, world };
  }

  get sessionBackend(): (ExtensionSessionBackend & { kick(): void }) | undefined {
    return this.#sessionBackend;
  }
  ensureSessionBackend(create: () => ExtensionSessionBackend & { kick(): void }): void {
    this.#sessionBackend ??= create();
  }

  get execution(): SessionExecutionContext | undefined {
    return this.#executionContext;
  }
  bindExecutionContext(context: SessionExecutionContext): void {
    this.#executionContext = context;
  }
  unbindExecutionContext(context: SessionExecutionContext): void {
    if (this.#executionContext === context) this.#executionContext = undefined;
  }
  get contextualWorldState(): ContextualWorldState | undefined {
    return this.#contextualWorldState;
  }
  updateContextualWorldState(state: ContextualWorldState): void {
    this.#contextualWorldState = state;
  }

  get activeExecutionId(): string | undefined {
    return this.#activeExecutionId;
  }

  subscribe(listener: (event: AgentEvent) => void) {
    const observer = (event: AgentEvent) => listener(structuredClone(event));
    this.#eventObservers.add(observer);
    const terminal =
      this.#activeExecutionId === undefined
        ? undefined
        : this.#executions.get(this.#activeExecutionId)?.observedTerminal;
    return {
      ...(this.#activeExecutionId === undefined
        ? {}
        : { activeExecutionId: this.#activeExecutionId }),
      ...(terminal === undefined ? {} : { terminalEvent: structuredClone(terminal) }),
      unsubscribe: () => {
        this.#eventObservers.delete(observer);
      }
    };
  }

  publishEvent(event: AgentEvent): void {
    for (const listener of [...this.#eventObservers]) {
      if (!this.#eventObservers.has(listener)) continue;
      try {
        listener(event);
      } catch {
        /* Observers cannot change the owning Execution. */
      }
    }
  }

  assertCanExecute(): void {
    if (this.#activeExecutionId !== undefined)
      throw new AgentError(
        'MAR_AGENT_EXECUTION_ACTIVE',
        'Session already has an active execution.'
      );
  }

  registerExecution(execution: SessionExecution): void {
    this.assertCanExecute();
    this.#executions.set(execution.executionId, execution);
    this.#activeExecutionId = execution.executionId;
    this.onExecutionRegistered(this);
  }

  deactivateExecution(execution: SessionExecution): void {
    if (
      this.#executions.get(execution.executionId) === execution &&
      this.#activeExecutionId === execution.executionId
    )
      this.#activeExecutionId = undefined;
  }

  unregisterExecution(execution: SessionExecution): void {
    if (this.#executions.get(execution.executionId) === execution)
      this.#executions.delete(execution.executionId);
  }

  cancelExecution(executionId: string): void {
    this.#executions.get(executionId)?.cancel();
  }

  joinExecution(executionId: string): Promise<ExecutionResult> | undefined {
    return this.#executions.get(executionId)?.join();
  }

  cancelExecutions(): void {
    for (const execution of this.#executions.values()) execution.cancel();
  }

  joinExecutions(): Promise<PromiseSettledResult<ExecutionResult>[]> {
    return Promise.allSettled(
      [...this.#executions.values()].flatMap((execution) => {
        const result = execution.join();
        return result === undefined ? [] : [result];
      })
    );
  }
}
