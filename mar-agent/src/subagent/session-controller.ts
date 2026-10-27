import { waitMetadata, type ToolWaitInterrupt } from '../runtime/wait.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { AgentError, describeAgentError } from '../error.js';
import type { AgentReasoningEffort } from '../model/configuration.js';
import type { ExecutionResult } from '../runtime/contracts.js';
import type { AgentEvent } from '../runtime/events.js';
import type { SessionSource } from '../session/types.js';
import { SUBAGENT_LIMITS } from './limits.js';
import { parseAgentWaitTargets, SubagentWaitCoordinator, waitForAgentGroup } from './wait.js';
import type { SubagentManyOutput, SubagentManyOutputOptions } from './contracts.js';
import type {
  SubagentController,
  SubagentLatestActivity,
  SubagentLatestMessage,
  SubagentMessageOptions,
  SubagentOutputOptions,
  SubagentRunOptions,
  SubagentTaskInput,
  SubagentTaskSnapshot
} from './contracts.js';

const RECENT_TERMINAL_RESOURCE_LIMIT = 16;

export interface SubagentModelOption {
  readonly id: string;
  readonly name: string;
  readonly conversationModel?: boolean;
  readonly reasoningEfforts: readonly AgentReasoningEffort[];
  readonly defaultReasoningEffort: AgentReasoningEffort;
}

export interface SubagentTurnHandle extends AsyncIterable<AgentEvent> {
  readonly executionId: string;
  readonly turnId: string;
  /** True only after the child terminal event was durably appended. */
  readonly persistedEvents?: boolean;
  result(): Promise<ExecutionResult>;
  cancel(): void;
  enqueueMessage(message: string, delivery?: SubagentMessageDelivery): boolean;
}

/** Caller-owned correlation is opaque to Subagent; the adapter restores it at delivery. */
export interface SubagentOrigin {
  readonly signal: AbortSignal;
  readonly correlation: unknown;
}

export interface SubagentMessageDelivery {
  readonly messageId: string;
  readonly origin?: SubagentOrigin;
  readonly signal?: AbortSignal;
  applied(): void;
  settled?(status: 'cancelled' | 'failed'): void;
}

export interface SubagentMailboxMessage {
  readonly text: string;
  readonly delivery?: SubagentMessageDelivery;
}

export interface SubagentParentExecution {
  readonly executionId: string;
  readonly modelId: string;
  readonly reasoningEffort: AgentReasoningEffort;
  readonly models: ReadonlyMap<string, SubagentModelOption>;
  emitTerminal(snapshot: SubagentTaskSnapshot): Promise<void>;
  startTurn(input: {
    readonly sessionId: string;
    readonly prompt: string;
    readonly modelId: string;
    readonly reasoningEffort: AgentReasoningEffort;
    readonly role: SubagentTaskInput['role'];
    readonly initialMailbox: readonly SubagentMailboxMessage[];
    readonly turnId: string;
    readonly delivery?: SubagentMessageDelivery;
    readonly origin?: SubagentOrigin;
  }): Promise<SubagentTurnHandle>;
}

/** A native operation has its own provenance even when no parent Execution is active. */
export interface SubagentParentOperation extends Omit<SubagentParentExecution, 'executionId'> {
  readonly operationId: string;
  readonly executionId?: string;
  readonly ownerInstanceId?: string;
  readonly extensionId?: string;
  readonly signal: AbortSignal;
  readonly origin?: SubagentOrigin;
}

type SubagentParentContext = SubagentParentExecution | SubagentParentOperation;

interface SubagentHistoryRecord {
  readonly type: string;
  readonly payload: unknown;
  readonly turnId?: string;
}

export interface PersistedSubagentSession {
  readonly id: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly source: Extract<SessionSource, { type: 'subagent' }>;
  readonly records: readonly SubagentHistoryRecord[];
}

export interface SubagentSessionControllerBackend {
  createSession(input: {
    readonly title: string;
    readonly source: Extract<SessionSource, { type: 'subagent' }>;
  }): Promise<{ readonly id: string }>;
  deleteSession(sessionId: string): Promise<void>;
  /** Returns children in durable creation order. */
  listChildren(
    parentSessionId: string
  ): Promise<readonly Omit<PersistedSubagentSession, 'records'>[]>;
  loadChild(
    parentSessionId: string,
    sessionId: string
  ): Promise<PersistedSubagentSession | undefined>;
}

interface TurnState {
  readonly turnId: string;
  readonly ownerInstanceId?: string;
  readonly origin?: SubagentOrigin;
  readonly delivery?: SubagentMessageDelivery;
  readonly prompt: string;
  readonly start: SubagentParentExecution['startTurn'];
  readonly pendingMessages: SubagentMailboxMessage[];
  readonly handleReady: Promise<void>;
  readonly completion: Promise<void>;
  resolve(): void;
  resolveHandleReady(): void;
  handle?: SubagentTurnHandle;
  cancelRequested?: boolean;
}

type TurnView = Readonly<
  Omit<TurnState, 'pendingMessages' | 'resolve' | 'resolveHandleReady' | 'cancelRequested'>
>;
type TurnInput = Omit<
  TurnState,
  'handleReady' | 'completion' | 'resolve' | 'resolveHandleReady' | 'handle' | 'cancelRequested'
>;

interface SubagentTaskState {
  detailsEvicted?: boolean | undefined;
  restorable?: boolean | undefined;
  permissionStop?: ExecutionResult['permissionStop'] | undefined;
  readonly agentId: string;
  readonly description: string;
  readonly role: SubagentTaskInput['role'];
  readonly ownerInstanceId?: string | undefined;
  readonly extensionId?: string | undefined;
  status: SubagentTaskSnapshot['status'];
  modelId?: string | undefined;
  modelName?: string | undefined;
  reasoningEffort?: AgentReasoningEffort | undefined;
  latestMessage?: SubagentLatestMessage | undefined;
  latestActivity?: SubagentLatestActivity | undefined;
  messageRevision: number;
  observedMessageRevision: number;
  latestMessageActivityRevision: number;
  summary?: string | undefined;
  changedFiles: string[];
  verification: string[];
  evidence: Array<{ path: string; startLine?: number; endLine?: number }>;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  terminalPending: boolean;
  observedTerminalRevision: number;
  // Restored history has no live terminal revision and is not automatically replayed.
  terminalRevision?: number | undefined;
  resourceRevision: number;
  turn?: TurnState | undefined;
  controlTail?: Promise<unknown> | undefined;
  receipt?:
    | {
        messageId: string;
        turnId: string;
        deliveryStatus: 'accepted' | 'applied' | 'cancelled' | 'failed';
      }
    | undefined;
}

type TaskView = Omit<
  SubagentTaskState,
  'turn' | 'receipt' | 'changedFiles' | 'verification' | 'evidence'
> & {
  readonly turn?: TurnView | undefined;
  readonly receipt?: Readonly<NonNullable<SubagentTaskState['receipt']>> | undefined;
  readonly changedFiles: readonly string[];
  readonly verification: readonly string[];
  readonly evidence: readonly Readonly<SubagentTaskState['evidence'][number]>[];
};

/** Owns the mutable state and transitions of one child task. */
class SubagentTask {
  get detailsEvicted(): SubagentTaskState['detailsEvicted'] {
    return this.state.detailsEvicted;
  }
  get restorable(): SubagentTaskState['restorable'] {
    return this.state.restorable;
  }
  get permissionStop(): SubagentTaskState['permissionStop'] {
    return this.state.permissionStop;
  }
  get agentId(): SubagentTaskState['agentId'] {
    return this.state.agentId;
  }
  get description(): SubagentTaskState['description'] {
    return this.state.description;
  }
  get role(): SubagentTaskState['role'] {
    return this.state.role;
  }
  get ownerInstanceId(): SubagentTaskState['ownerInstanceId'] {
    return this.state.ownerInstanceId;
  }
  get extensionId(): SubagentTaskState['extensionId'] {
    return this.state.extensionId;
  }
  get status(): SubagentTaskState['status'] {
    return this.state.status;
  }
  get modelId(): SubagentTaskState['modelId'] {
    return this.state.modelId;
  }
  get modelName(): SubagentTaskState['modelName'] {
    return this.state.modelName;
  }
  get reasoningEffort(): SubagentTaskState['reasoningEffort'] {
    return this.state.reasoningEffort;
  }
  get latestMessage(): SubagentTaskState['latestMessage'] {
    return this.state.latestMessage;
  }
  get latestActivity(): SubagentTaskState['latestActivity'] {
    return this.state.latestActivity;
  }
  get messageRevision(): SubagentTaskState['messageRevision'] {
    return this.state.messageRevision;
  }
  get observedMessageRevision(): SubagentTaskState['observedMessageRevision'] {
    return this.state.observedMessageRevision;
  }
  get latestMessageActivityRevision(): SubagentTaskState['latestMessageActivityRevision'] {
    return this.state.latestMessageActivityRevision;
  }
  get summary(): SubagentTaskState['summary'] {
    return this.state.summary;
  }
  get changedFiles(): readonly string[] {
    return this.state.changedFiles;
  }
  get verification(): readonly string[] {
    return this.state.verification;
  }
  get evidence(): readonly Readonly<SubagentTaskState['evidence'][number]>[] {
    return this.state.evidence;
  }
  get errorCode(): SubagentTaskState['errorCode'] {
    return this.state.errorCode;
  }
  get errorMessage(): SubagentTaskState['errorMessage'] {
    return this.state.errorMessage;
  }
  get terminalPending(): SubagentTaskState['terminalPending'] {
    return this.state.terminalPending;
  }
  get observedTerminalRevision(): SubagentTaskState['observedTerminalRevision'] {
    return this.state.observedTerminalRevision;
  }
  get terminalRevision(): SubagentTaskState['terminalRevision'] {
    return this.state.terminalRevision;
  }
  get resourceRevision(): SubagentTaskState['resourceRevision'] {
    return this.state.resourceRevision;
  }
  get turn(): TurnView | undefined {
    return this.state.turn;
  }
  get controlTail(): SubagentTaskState['controlTail'] {
    return this.state.controlTail;
  }
  get receipt(): Readonly<NonNullable<SubagentTaskState['receipt']>> | undefined {
    return this.state.receipt;
  }

  constructor(private readonly state: SubagentTaskState) {}
  acknowledgeMessage(revision: number): void {
    this.state.observedMessageRevision = Math.max(this.state.observedMessageRevision, revision);
  }
  acknowledgeTerminal(revision: number): void {
    this.state.observedTerminalRevision = Math.max(this.state.observedTerminalRevision, revision);
  }
  selectModel(model: { id: string; name: string; reasoningEffort?: AgentReasoningEffort }): void {
    this.state.modelId = model.id;
    this.state.modelName = model.name;
    if (model.reasoningEffort !== undefined) this.state.reasoningEffort = model.reasoningEffort;
  }
  setReceipt(receipt: NonNullable<SubagentTaskState['receipt']>): void {
    this.state.receipt = receipt;
  }
  updateDelivery(
    receipt: NonNullable<SubagentTaskState['receipt']>,
    status: 'applied' | 'cancelled' | 'failed'
  ): boolean {
    if (status !== 'applied' && receipt.deliveryStatus !== 'accepted') return false;
    receipt.deliveryStatus = status;
    return true;
  }
  requestCancel(expected: TurnView): void {
    const turn = this.state.turn;
    if (turn !== expected) return;
    if (turn.handle) turn.handle.cancel();
    else turn.cancelRequested = true;
  }
  attachHandle(expected: TurnView, handle: SubagentTurnHandle): void {
    const turn = this.state.turn;
    if (turn !== expected) return;
    turn.handle = handle;
  }
  cancelPending(expected: TurnView): void {
    const turn = this.state.turn;
    if (turn === expected && turn.cancelRequested) turn.handle!.cancel();
  }
  takePendingMessages(expected: TurnView): SubagentMailboxMessage[] {
    const turn = this.state.turn;
    return turn === expected ? turn.pendingMessages.splice(0) : [];
  }
  settleHandleReady(expected: TurnView): void {
    if (this.state.turn === expected) this.state.turn.resolveHandleReady();
  }
  settleCompletion(expected: TurnView): void {
    if (this.state.turn === expected) this.state.turn.resolve();
  }
  appendMessage(message: SubagentMailboxMessage): void {
    this.state.turn!.pendingMessages.push(message);
  }
  control<T>(operation: () => Promise<T>): Promise<T> {
    const result = (this.state.controlTail ?? Promise.resolve()).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.state.controlTail = tail;
    void tail.then(() => {
      if (this.state.controlTail === tail) delete this.state.controlTail;
    });
    return result;
  }
  cancelQueued(publish: boolean): void {
    this.state.status = 'cancelled';
    if (publish) this.state.terminalPending = true;
  }
  queueTurn(input: TurnInput, onComplete: () => void): TurnView {
    let resolve!: () => void;
    let resolveHandleReady!: () => void;
    const completion = new Promise<void>((done) => (resolve = done));
    const handleReady = new Promise<void>((done) => (resolveHandleReady = done));
    const turn: TurnState = {
      ...input,
      handleReady,
      completion,
      resolve: () => {
        onComplete();
        resolve();
      },
      resolveHandleReady
    };
    this.state.status = 'queued';
    this.state.restorable = false;
    delete this.state.summary;
    delete this.state.permissionStop;
    delete this.state.errorCode;
    delete this.state.errorMessage;
    this.state.changedFiles = [];
    this.state.verification = [];
    this.state.evidence = [];
    this.state.terminalPending = false;
    this.state.turn = turn;
    return turn;
  }
  markRunning(): void {
    this.state.status = 'running';
  }
  clearTurn(expected?: TurnView): void {
    if (expected === undefined || this.state.turn === expected) delete this.state.turn;
  }
  observeEvent(event: AgentEvent, revision: number): boolean {
    if (!observeAgentEvent(this.state, event)) return false;
    this.state.messageRevision++;
    this.state.latestMessageActivityRevision = revision;
    return true;
  }
  complete(
    result: ExecutionResult,
    terminal: 'completed' | 'failed' | 'cancelled' | undefined,
    persisted: boolean,
    previousActivity: SubagentTaskState['latestActivity'],
    previousRevision: number
  ): void {
    if (result.status === 'completed') {
      this.state.status = 'completed';
      this.state.summary = result.finalAnswer;
      if (result.permissionStop) this.state.permissionStop = result.permissionStop;
      else delete this.state.permissionStop;
    } else if (result.status === 'cancelled') this.state.status = 'cancelled';
    else {
      this.state.status = 'failed';
      this.state.errorCode = result.errorCode ?? 'MAR_AGENT_SUBAGENT_FAILED';
      this.state.errorMessage = result.errorMessage ?? 'Subagent execution failed.';
    }
    this.state.restorable =
      persisted &&
      terminal === this.state.status &&
      (previousActivity === undefined || this.state.latestActivity !== previousActivity) &&
      (this.state.latestMessage === undefined || this.state.messageRevision > previousRevision) &&
      (this.state.status !== 'completed' ||
        (this.state.latestMessage?.phase === 'final_answer' &&
          this.state.summary === this.state.latestMessage.text));
    this.state.terminalPending = true;
  }
  fail(error: unknown): void {
    const diagnostic = describeAgentError(error, 'MAR_AGENT_SUBAGENT_FAILED');
    this.state.status = 'failed';
    this.state.restorable = false;
    this.state.errorCode = diagnostic.code;
    this.state.errorMessage = diagnostic.message;
    this.state.terminalPending = true;
  }
  touch(revision: number, terminal = false): void {
    this.state.resourceRevision = revision;
    if (terminal) this.state.terminalRevision = revision;
  }
  terminalPublished(revision: number | undefined): void {
    if (this.state.terminalRevision === revision) this.state.terminalPending = false;
  }
  evictDetails(): void {
    for (const key of DETAIL_FIELDS) delete this.state[key];
    this.state.changedFiles = [];
    this.state.verification = [];
    this.state.evidence = [];
    this.state.detailsEvicted = true;
  }
  restoreDetails(restored: SubagentTaskState): void {
    for (const key of DETAIL_FIELDS) {
      if (key in restored) Object.assign(this.state, { [key]: restored[key] });
      else delete this.state[key];
    }
    delete this.state.detailsEvicted;
  }
  copyWaitState(): TaskView {
    return {
      ...this.state,
      changedFiles: [...this.state.changedFiles],
      verification: [...this.state.verification],
      evidence: this.state.evidence.map((item) => ({ ...item }))
    };
  }
}

const DETAIL_FIELDS = [
  'latestMessage',
  'latestActivity',
  'summary',
  'changedFiles',
  'verification',
  'evidence',
  'permissionStop',
  'errorMessage'
] as const;

type AgentActivity = {
  readonly state: SubagentTask;
  readonly kind: 'message' | 'completion';
};

export class SubagentSessionController implements SubagentController {
  readonly #agents = new Map<string, SubagentTask>();
  // Discovery order is independent of the order in which history is requested.
  readonly #discovered = new Map<string, number>();
  readonly #loading = new Map<string, Promise<SubagentTask>>();
  readonly #readers = new Map<string, number>();
  #allReaders = 0;
  readonly #queue: SubagentTask[] = [];
  readonly #waiters = new SubagentWaitCoordinator<SubagentTask, AgentActivity>();
  readonly modelMessages: ToolWaitInterrupt = {
    pending: () =>
      [...this.#agents.values()].some(
        (state) => state.messageRevision > state.observedMessageRevision
      ),
    subscribe: (listener) => {
      const notify = (activity: AgentActivity) => {
        if (activity.kind === 'message') listener();
      };
      return this.#waiters.subscribeActivity(notify);
    }
  };
  readonly #nativeObservations = new Map<
    string,
    Map<string, { messageRevision: number; terminalRevision: number }>
  >();
  #activityRevision = 0;
  #resourceRevision = 0;
  #running = 0;
  #disposed = false;
  #creationBudget = { count: 0 };
  readonly #retainedExecution = new AsyncLocalStorage<{
    execution: SubagentParentContext;
    budget: { count: number };
    native?: boolean;
  }>();
  #execution: SubagentParentExecution | undefined;
  readonly #pendingDeliveries = new Set<{
    state: SubagentTask;
    ownerInstanceId?: string;
    receipt: NonNullable<SubagentTaskState['receipt']>;
    delivery: SubagentMessageDelivery;
    admitted: boolean;
  }>();

  private constructor(
    private readonly parentSessionId: string,
    private readonly rootSessionId: string,
    private readonly backend: SubagentSessionControllerBackend,
    readonly limits = { maxTasks: 16, maxConcurrent: 16 }
  ) {}

  static async open(input: {
    readonly parentSessionId: string;
    readonly rootSessionId: string;
    readonly backend: SubagentSessionControllerBackend;
    readonly limits?: { readonly maxTasks: number; readonly maxConcurrent: number };
  }): Promise<SubagentSessionController> {
    const controller = new SubagentSessionController(
      input.parentSessionId,
      input.rootSessionId,
      input.backend,
      input.limits
    );
    const sessions = await input.backend.listChildren(input.parentSessionId);
    // Map insertion order is creation order; values independently rank activity.
    for (const session of sessions) controller.#discovered.set(session.id, 0);
    for (const session of [...sessions].sort((a, b) =>
      a.lastActivityAt.localeCompare(b.lastActivityAt)
    )) {
      controller.#discovered.set(session.id, ++controller.#resourceRevision);
    }
    return controller;
  }

  async beginParentExecution(execution: SubagentParentExecution): Promise<void> {
    if (this.#disposed)
      throw new AgentError('MAR_AGENT_SUBAGENT_LIMIT', 'Subagent controller is disposed.');
    this.#execution = execution;
    this.#creationBudget = { count: 0 };
    for (const state of this.#agents.values()) await this.#publishTerminal(state);
    this.#releaseOldDetails();
  }

  /** A retained cell must not borrow a later model Execution's identity or task budget. */
  captureExecution(executionId?: string): SubagentController {
    const enter = this.captureParentFrame(executionId);
    return {
      run: (input, options) => enter(() => this.run(input, options)),
      message: (id, message, options) => enter(() => this.message(id, message, options)),
      output: (id, options) => this.output(id, options),
      outputAny: (options) => this.outputAny(options),
      outputMany: (ids, options) => this.outputMany(ids, options),
      cancel: (id) => this.cancel(id),
      listSessionResources: () => this.listSessionResources(),
      dispose: () => this.dispose()
    };
  }

  /** SDK physical tool ingress shares the same captured parent as its model controls. */
  captureParentFrame(executionId?: string): <Value>(run: () => Value) => Value {
    const execution = executionId === undefined ? this.#requireExecution() : this.#execution;
    if (!execution || (executionId !== undefined && execution.executionId !== executionId))
      throw new AgentError('MAR_AGENT_SUBAGENT_FAILED', 'Parent Execution source is unavailable.');
    const context = (executionId === undefined
      ? this.#retainedExecution.getStore()
      : undefined) ?? {
      execution,
      budget: this.#creationBudget
    };
    return (run) => this.#retainedExecution.run(context, run);
  }

  withOperation<T>(operation: SubagentParentOperation, run: () => T): T {
    operation.signal.throwIfAborted();
    if (!operation.operationId.trim())
      throw new AgentError('MAR_AGENT_SUBAGENT_FAILED', 'Parent operation identity is invalid.');
    return this.#retainedExecution.run(
      { execution: operation, budget: { count: 0 }, native: true },
      run
    );
  }

  async inspect(agentId: string): Promise<SubagentTaskSnapshot> {
    return this.#using([agentId], async () => {
      return this.#snapshot(await this.#find(agentId), { full: true });
    });
  }

  inspectAll(): readonly SubagentTaskSnapshot[] {
    if (this.#disposed)
      throw new AgentError('MAR_AGENT_DISPOSED', 'Subagent controller is disposed.');
    return this.#orderedStates().map((state) => this.#snapshot(state, { full: true }));
  }

  async list(signal?: AbortSignal): Promise<readonly SubagentTaskSnapshot[]> {
    return this.#using(undefined, async () => {
      await this.prepareAll(signal);
      return this.inspectAll();
    });
  }

  /** Full listing is explicit; ordinary opens and executions never require it. */
  async prepareAll(signal?: AbortSignal): Promise<void> {
    for (const id of this.#discovered.keys()) {
      signal?.throwIfAborted();
      await this.#restoreDiscovered(id);
    }
    signal?.throwIfAborted();
  }

  async prepareSessionResources(signal?: AbortSignal): Promise<void> {
    const candidates = [...this.#discovered]
      .filter(([id]) => {
        const state = this.#agents.get(id);
        return !state || isTerminalState(state);
      })
      .sort(
        ([a, ar], [b, br]) =>
          (this.#agents.get(b)?.resourceRevision ?? br) -
          (this.#agents.get(a)?.resourceRevision ?? ar)
      );
    let prepared = 0;
    for (const [id] of candidates) {
      signal?.throwIfAborted();
      const state = await this.#restoreDiscovered(id);
      if (state && isTerminalState(state) && ++prepared === RECENT_TERMINAL_RESOURCE_LIMIT) break;
    }
    signal?.throwIfAborted();
    this.#releaseOldDetails();
  }

  async #restoreDiscovered(agentId: string): Promise<SubagentTask | undefined> {
    try {
      return await this.#find(agentId);
    } catch (error) {
      if (!(error instanceof AgentError) || error.code !== 'MAR_AGENT_SUBAGENT_NOT_FOUND')
        throw error;
      this.#discovered.delete(agentId);
      return undefined;
    }
  }

  #orderedStates(): SubagentTask[] {
    return [...this.#discovered.keys()].flatMap((id) => {
      const state = this.#agents.get(id);
      return state ? [state] : [];
    });
  }

  collectModelUpdates(): readonly {
    snapshot: SubagentTaskSnapshot;
    truncated: boolean;
    acknowledge(): void;
  }[] {
    return [...this.#agents.values()]
      .filter(
        (state) =>
          state.messageRevision > state.observedMessageRevision ||
          (isTerminalState(state) &&
            state.terminalRevision !== undefined &&
            state.terminalRevision > state.observedTerminalRevision)
      )
      .sort((left, right) => left.resourceRevision - right.resourceRevision)
      .slice(0, SUBAGENT_LIMITS.agentWaitMaxAgents)
      .map((state) => {
        const messageRevision = state.messageRevision;
        const terminalRevision = isTerminalState(state) ? state.terminalRevision : undefined;
        const includeTerminalDetails =
          terminalRevision !== undefined && terminalRevision > state.observedTerminalRevision;
        const snapshot = this.#snapshot(state, {
          includeLatestMessage: messageRevision > state.observedMessageRevision,
          includeTerminalDetails,
          full: false
        });
        return {
          snapshot,
          truncated:
            snapshot.latestMessage?.truncated === true ||
            (includeTerminalDetails &&
              (snapshot.summary !== state.summary ||
                (snapshot.changedFiles?.length ?? 0) < state.changedFiles.length)),
          acknowledge: () => {
            state.acknowledgeMessage(messageRevision);
            if (includeTerminalDetails) state.acknowledgeTerminal(terminalRevision!);
          }
        };
      });
  }

  async cancelOwned(ownerInstanceId: string): Promise<void> {
    for (const pending of this.#pendingDeliveries)
      if (pending.ownerInstanceId === ownerInstanceId) pending.delivery.settled?.('cancelled');
    const results = await Promise.allSettled(
      [...this.#agents.values()]
        .filter((state) => state.turn?.ownerInstanceId === ownerInstanceId)
        .map((state) =>
          this.#control(state, async () => {
            if (state.turn?.ownerInstanceId === ownerInstanceId) await this.#cancelState(state);
          })
        )
    );
    const failure = results.find((result) => result.status === 'rejected');
    this.#nativeObservations.delete(ownerInstanceId);
    if (failure?.status === 'rejected') throw failure.reason;
  }

  endParentExecution(executionId: string): void {
    if (this.#execution?.executionId === executionId) this.#execution = undefined;
  }

  parentExecution(executionId: string): SubagentParentExecution | undefined {
    const execution = this.#retainedExecution.getStore()?.execution ?? this.#execution;
    return execution?.executionId === executionId ? { ...execution, executionId } : undefined;
  }

  async run(
    input: SubagentTaskInput,
    options: SubagentRunOptions = {}
  ): Promise<SubagentTaskSnapshot> {
    options.signal?.throwIfAborted();
    options.turnSignal?.throwIfAborted();
    if (
      options.waitFor !== undefined &&
      options.waitFor !== 'start' &&
      options.waitFor !== 'completion'
    )
      throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Task start wait is invalid.');
    const execution = this.#requireExecution();
    const native = this.#retainedExecution.getStore()?.native === true;
    validateTaskInput(input, native);
    if (
      !native &&
      (this.#retainedExecution.getStore()?.budget ?? this.#creationBudget).count >=
        this.limits.maxTasks
    )
      throw new AgentError('MAR_AGENT_SUBAGENT_LIMIT', 'Subagent task limit was reached.');
    const source: Extract<SessionSource, { type: 'subagent' }> = {
      type: 'subagent',
      parentSessionId: this.parentSessionId,
      rootSessionId: this.rootSessionId,
      ...(execution.executionId === undefined ? {} : { parentExecutionId: execution.executionId }),
      ...(native && 'operationId' in execution
        ? {
            parentOperationId: execution.operationId,
            ...(execution.ownerInstanceId === undefined
              ? {}
              : { ownerInstanceId: execution.ownerInstanceId }),
            ...(execution.extensionId === undefined ? {} : { extensionId: execution.extensionId })
          }
        : {}),
      role: input.role,
      description: input.description.trim()
    };
    const created = await this.backend.createSession({
      title: input.description.trim(),
      source
    });
    try {
      if (this.#disposed)
        throw new AgentError('MAR_AGENT_DISPOSED', 'Subagent controller is disposed.');
      this.#requireExecution();
      options.signal?.throwIfAborted();
      options.turnSignal?.throwIfAborted();
    } catch (error) {
      await this.#deleteUnstartedSession(created.id, error);
    }
    return this.#using([created.id], async () => {
      const state = new SubagentTask({
        agentId: created.id,
        description: source.description,
        role: input.role,
        ...(source.ownerInstanceId === undefined
          ? {}
          : { ownerInstanceId: source.ownerInstanceId }),
        ...(source.extensionId === undefined ? {} : { extensionId: source.extensionId }),

        status: 'queued',
        messageRevision: 0,
        observedMessageRevision: 0,
        latestMessageActivityRevision: 0,
        changedFiles: [],
        verification: [],
        evidence: [],
        terminalPending: false,
        observedTerminalRevision: -1,
        resourceRevision: ++this.#resourceRevision
      });
      if (!native) (this.#retainedExecution.getStore()?.budget ?? this.#creationBudget).count++;
      this.#agents.set(state.agentId, state);
      this.#discovered.set(state.agentId, state.resourceRevision);
      const knownModel = execution.models.get(input.modelId ?? execution.modelId);
      if (knownModel) {
        state.selectModel(knownModel);
      }
      try {
        const selected = resolveModel(execution, input);
        state.selectModel(selected);
      } catch (error) {
        this.#setFailure(state, error);
      }
      try {
        await options.onCreated?.(this.#receiptSnapshot(state));
        if (this.#disposed)
          throw new AgentError('MAR_AGENT_DISPOSED', 'Subagent controller is disposed.');
        this.#requireExecution();
        options.signal?.throwIfAborted();
      } catch (error) {
        await this.#deleteUnstartedSession(state.agentId, error);
      }
      if (state.status === 'failed') {
        await this.#publishTerminal(state);
        this.#observeTerminal(state);
        return this.#snapshot(state);
      }
      this.#queueTurn(
        state,
        input.prompt,
        execution,
        [],
        undefined,
        undefined,
        options.signal,
        options.turnSignal
      );
      if (options.waitFor === 'start' || (options.waitFor === undefined && input.background))
        return this.#receiptSnapshot(state);
      await waitForPromise(state.turn!.completion, options.signal);
      const includeLatestMessage = this.#hasUnreadMessage(state);
      const includeTerminalDetails = this.#observeTerminal(state);
      this.#observeLatestMessage(state);
      return this.#snapshot(state, { includeLatestMessage, includeTerminalDetails });
    });
  }

  async output(
    agentId: string,
    options: SubagentOutputOptions = {}
  ): Promise<SubagentTaskSnapshot> {
    return this.#using([agentId], async () => {
      options.signal?.throwIfAborted();
      const state = await this.#find(agentId);
      options.signal?.throwIfAborted();
      validateOutputOptions(options, this.#retainedExecution.getStore()?.native === true);
      if (options.untilSettled) {
        if (state.turn) await waitForPromise(state.turn.completion, options.signal);
        options.signal?.throwIfAborted();
        const includeLatestMessage = this.#hasUnreadMessage(state);
        const includeTerminalDetails = this.#observeTerminal(state);
        this.#observeLatestMessage(state);
        return {
          ...this.#snapshot(state, { includeLatestMessage, includeTerminalDetails }),
          waitOutcome: 'completion'
        };
      }
      if (options.waitMs === undefined || options.waitMs === 0)
        return {
          ...this.#snapshot(state, {
            includeLatestMessage: false,
            includeTerminalDetails: false
          }),
          waitOutcome: 'snapshot' as const
        };
      if (isTerminalState(state)) {
        const includeLatestMessage = this.#hasUnreadMessage(state);
        const includeTerminalDetails = this.#observeTerminal(state);
        this.#observeLatestMessage(state);
        return {
          ...this.#snapshot(state, { includeLatestMessage, includeTerminalDetails }),
          waitOutcome: 'completion' as const
        };
      }
      const waitFor = options.waitFor ?? 'completion';
      if (waitFor === 'message' && this.#hasUnreadMessage(state)) {
        this.#observeLatestMessage(state);
        return { ...this.#snapshot(state), waitOutcome: 'message' as const };
      }
      const waitMs = this.#retainedExecution.getStore()?.native
        ? options.waitMs
        : Math.max(options.waitMs, SUBAGENT_LIMITS.agentWaitWaitFloorMs);
      if (waitFor === 'completion') {
        const completed = await this.#waitForCompletion(
          state,
          waitMs,
          options.signal,
          options.waitInterrupt
        );
        options.signal?.throwIfAborted();
        const includeLatestMessage = this.#hasUnreadMessage(state);
        const includeTerminalDetails = completed ? this.#observeTerminal(state) : false;
        if (includeLatestMessage) this.#observeLatestMessage(state);
        return {
          ...this.#snapshot(state, { includeLatestMessage, includeTerminalDetails }),
          ...waitMetadata(
            completed ? 'completion' : options.waitInterrupt?.pending() ? 'interrupted' : 'timeout'
          )
        };
      }
      const activity = await this.#waitForMessageOrCompletion(
        [state],
        waitMs,
        options.signal,
        options.waitInterrupt
      );
      options.signal?.throwIfAborted();
      const includeLatestMessage =
        activity?.kind === 'message' ||
        (activity?.kind === 'completion' && this.#hasUnreadMessage(activity.state));
      const includeTerminalDetails =
        activity?.kind === 'completion' ? this.#observeTerminal(activity.state) : false;
      if (activity) this.#observeLatestMessage(activity.state);
      return {
        ...this.#snapshot(activity?.state ?? state, {
          includeLatestMessage,
          includeTerminalDetails
        }),
        ...waitMetadata(
          activity?.kind ?? (options.waitInterrupt?.pending() ? 'interrupted' : 'timeout')
        )
      };
    });
  }

  async outputAny(options: SubagentOutputOptions = {}): Promise<SubagentTaskSnapshot> {
    return this.#using(undefined, async () => {
      options.signal?.throwIfAborted();
      if (options.untilSettled)
        throw new AgentError(
          'MAR_AGENT_TOOL_INPUT_INVALID',
          'An unbounded wait requires an agent id.'
        );
      validateOutputOptions(options, this.#retainedExecution.getStore()?.native === true);
      const hasLive = [...this.#agents.values()].some((state) => !isTerminalState(state));
      if (!hasLive) {
        for (const id of [...this.#discovered.keys()].reverse()) {
          options.signal?.throwIfAborted();
          if (await this.#restoreDiscovered(id)) break;
        }
      }
      options.signal?.throwIfAborted();
      const states = this.#orderedStates();
      if (states.length === 0)
        throw new AgentError('MAR_AGENT_SUBAGENT_NOT_FOUND', 'Subagent was not found.');
      const live = states.filter(
        (state) => state.status === 'queued' || state.status === 'running'
      );
      if (options.waitMs === undefined || options.waitMs === 0)
        return {
          ...this.#snapshot(live.at(-1) ?? states.at(-1)!, {
            includeLatestMessage: false,
            includeTerminalDetails: false
          }),
          waitOutcome: 'snapshot' as const
        };
      if (live.length === 0) {
        const state = states.at(-1)!;
        const includeLatestMessage = this.#hasUnreadMessage(state);
        const includeTerminalDetails = this.#observeTerminal(state);
        this.#observeLatestMessage(state);
        return {
          ...this.#snapshot(state, { includeLatestMessage, includeTerminalDetails }),
          waitOutcome: 'completion' as const
        };
      }
      const waitFor = options.waitFor ?? 'completion';
      if (waitFor === 'message') {
        const pending = this.#oldestUnreadMessage(live);
        if (pending) {
          this.#observeLatestMessage(pending);
          return { ...this.#snapshot(pending), waitOutcome: 'message' as const };
        }
      }
      const waitMs = this.#retainedExecution.getStore()?.native
        ? options.waitMs
        : Math.max(options.waitMs, SUBAGENT_LIMITS.agentWaitWaitFloorMs);
      if (waitFor === 'message') {
        const activity = await this.#waitForMessageOrCompletion(
          live,
          waitMs,
          options.signal,
          options.waitInterrupt
        );
        options.signal?.throwIfAborted();
        const includeLatestMessage =
          activity?.kind === 'message' ||
          (activity?.kind === 'completion' && this.#hasUnreadMessage(activity.state));
        const includeTerminalDetails =
          activity?.kind === 'completion' ? this.#observeTerminal(activity.state) : false;
        if (activity) this.#observeLatestMessage(activity.state);
        return {
          ...this.#snapshot(activity?.state ?? live.at(-1)!, {
            includeLatestMessage,
            includeTerminalDetails
          }),
          ...waitMetadata(
            activity?.kind ?? (options.waitInterrupt?.pending() ? 'interrupted' : 'timeout')
          )
        };
      }
      const completed = await this.#waitForAnyCompletion(
        live,
        waitMs,
        options.signal,
        options.waitInterrupt
      );
      options.signal?.throwIfAborted();
      const state = completed ?? this.#oldestUnreadMessage(live) ?? live.at(-1)!;
      const includeLatestMessage = this.#hasUnreadMessage(state);
      const includeTerminalDetails = completed ? this.#observeTerminal(state) : false;
      if (includeLatestMessage) this.#observeLatestMessage(state);
      return {
        ...this.#snapshot(state, {
          includeLatestMessage,
          includeTerminalDetails
        }),
        ...waitMetadata(
          completed ? 'completion' : options.waitInterrupt?.pending() ? 'interrupted' : 'timeout'
        )
      };
    });
  }

  async outputMany(
    agentIds: readonly string[],
    options: SubagentManyOutputOptions = {}
  ): Promise<SubagentManyOutput> {
    options.signal?.throwIfAborted();
    const { agentIds: ids, mode = 'any' } = parseAgentWaitTargets(
      { agentIds, mode: options.mode },
      this.#retainedExecution.getStore()?.native ? Infinity : SUBAGENT_LIMITS.agentWaitMaxAgents
    );
    validateOutputOptions(options, this.#retainedExecution.getStore()?.native === true);
    if (!ids || 'untilSettled' in options)
      throw new AgentError(
        'MAR_AGENT_TOOL_INPUT_INVALID',
        'Group waits require a bounded deadline.'
      );
    return this.#using(ids, async () => {
      const states = await Promise.all(ids.map((id) => this.#find(id)));
      options.signal?.throwIfAborted();
      const waitFor = options.waitFor ?? 'completion';
      const targets = states.map((state) => ({
        state,
        turn: state.turn,
        view: copyWaitState(state),
        observation: this.#nativeObservation(state)
      }));
      const refresh = () => {
        for (const target of targets) {
          if (
            !isTerminalState(target.view) &&
            (target.state.turn === target.turn ||
              (target.state.turn === undefined && isTerminalState(target.state)))
          )
            target.view = copyWaitState(target.state);
        }
      };
      const unread = (target: (typeof targets)[number]) =>
        target.view.messageRevision >
        (target.observation?.messageRevision ?? target.state.observedMessageRevision);
      const ready = (target: (typeof targets)[number]) =>
        isTerminalState(target.view) || (waitFor === 'message' && unread(target));
      const { snapshot, satisfied } = await waitForAgentGroup({
        targets,
        mode,
        refresh,
        ready,
        waitMs:
          options.waitMs === undefined ||
          options.waitMs === 0 ||
          this.#retainedExecution.getStore()?.native
            ? options.waitMs
            : Math.max(options.waitMs, SUBAGENT_LIMITS.agentWaitWaitFloorMs),
        signal: options.signal,
        interrupt: options.waitInterrupt,
        subscribe: (notify) => {
          const listener = () => notify();
          return this.#waiters.subscribeActivity(listener);
        }
      });
      const pendingAgentIds = targets
        .filter((target) => !ready(target))
        .map((target) => target.state.agentId);
      const agents = targets.map((target): SubagentTaskSnapshot => {
        const { state, view, observation } = target;
        const terminal = isTerminalState(view);
        const outcome = snapshot
          ? 'snapshot'
          : terminal
            ? 'completion'
            : ready(target)
              ? 'message'
              : satisfied
                ? 'snapshot'
                : options.waitInterrupt?.pending()
                  ? 'interrupted'
                  : 'timeout';
        const includeLatestMessage = outcome !== 'snapshot' && unread(target);
        const includeTerminalDetails =
          outcome === 'completion' &&
          (observation
            ? observation.terminalRevision < view.resourceRevision
            : state.observedTerminalRevision < view.resourceRevision);
        const result: SubagentTaskSnapshot = {
          ...this.#snapshot(view, { includeLatestMessage, includeTerminalDetails }),
          ...(target.turn === undefined ? {} : { turnId: target.turn.turnId }),
          ...waitMetadata(outcome)
        };
        if (includeLatestMessage) {
          if (observation)
            observation.messageRevision = Math.max(
              observation.messageRevision,
              view.messageRevision
            );
          else state.acknowledgeMessage(view.messageRevision);
        }
        if (includeTerminalDetails) {
          if (observation)
            observation.terminalRevision = Math.max(
              observation.terminalRevision,
              view.resourceRevision
            );
          else state.acknowledgeTerminal(view.resourceRevision);
        }
        return result;
      });
      return {
        mode,
        waitFor,
        agents,
        pendingAgentIds,
        ...waitMetadata(
          snapshot
            ? 'snapshot'
            : !satisfied
              ? options.waitInterrupt?.pending()
                ? 'interrupted'
                : 'timeout'
              : agents.some((agent) => agent.waitOutcome === 'message')
                ? 'message'
                : 'completion'
        )
      };
    });
  }

  async message(
    agentId: string,
    message: string,
    options: SubagentMessageOptions = {}
  ): Promise<SubagentTaskSnapshot> {
    return this.#using([agentId], async () => {
      const execution = this.#requireExecution();
      if (
        typeof message !== 'string' ||
        message.trim().length === 0 ||
        (this.#retainedExecution.getStore()?.native !== true &&
          Buffer.byteLength(message) > SUBAGENT_LIMITS.subagentMessageMaxBytes) ||
        (options.delivery !== undefined &&
          options.delivery !== 'append' &&
          options.delivery !== 'replace')
      )
        throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Agent message input is invalid.');
      const state = await this.#find(agentId);
      return this.#control(state, async () => {
        this.#requireExecution();
        options.signal?.throwIfAborted();
        // Resolve before cancelling so an unavailable model does not stop valid work.
        const selected = resolveExistingModel(execution, state);
        if (options.delivery === 'replace') await this.#cancelState(state);
        this.#requireExecution();
        options.signal?.throwIfAborted();
        const turnId = state.turn?.turnId ?? randomUUID();
        const receipt = { messageId: randomUUID(), turnId, deliveryStatus: 'accepted' as const };
        const mutableReceipt: NonNullable<SubagentTaskState['receipt']> = receipt;
        const delivery = this.#createDelivery(state, execution, mutableReceipt, options.signal);
        try {
          if (state.status === 'running' && state.turn) {
            const turn = state.turn;
            const sendSignal =
              delivery.signal && options.signal
                ? AbortSignal.any([delivery.signal, options.signal])
                : (delivery.signal ?? options.signal);
            if (!turn.handle) await waitForPromise(turn.handleReady, sendSignal);
            this.#requireExecution();
            options.signal?.throwIfAborted();
            delivery.signal?.throwIfAborted();
            if (
              state.status === 'running' &&
              state.turn === turn &&
              turn.handle?.enqueueMessage(message, delivery)
            ) {
              delivery.accepted();
              state.setReceipt(mutableReceipt);
              return this.#messageReceiptSnapshot(state);
            }
            await waitForPromise(turn.completion, sendSignal);
          } else if (state.status === 'queued' && state.turn) {
            delivery.accepted();
            state.appendMessage({ text: message, delivery });
            state.setReceipt(mutableReceipt);
            return this.#messageReceiptSnapshot(state);
          }
          this.#requireExecution();
          options.signal?.throwIfAborted();
          delivery.signal?.throwIfAborted();
          state.selectModel(selected);
          // A closing turn may have rejected append; reserve a fresh identity for its successor.
          mutableReceipt.turnId = randomUUID();
          delivery.accepted();
          state.setReceipt(mutableReceipt);
          this.#queueTurn(
            state,
            message,
            execution,
            [],
            mutableReceipt.turnId,
            delivery,
            options.signal
          );
          return this.#messageReceiptSnapshot(state);
        } catch (error) {
          delivery.settled?.(
            options.signal?.aborted || ('signal' in execution && execution.signal.aborted)
              ? 'cancelled'
              : 'failed'
          );
          throw error;
        }
      });
    });
  }

  async cancel(agentId: string): Promise<SubagentTaskSnapshot> {
    return this.#using([agentId], async () => {
      const state = await this.#find(agentId);
      await this.#control(state, () => this.#cancelState(state));
      const includeLatestMessage = this.#hasUnreadMessage(state);
      const includeTerminalDetails = this.#observeTerminal(state);
      this.#observeLatestMessage(state);
      return this.#snapshot(state, { includeLatestMessage, includeTerminalDetails });
    });
  }

  #control<T>(state: SubagentTask, operation: () => Promise<T>): Promise<T> {
    return state.control(operation);
  }

  async #cancelState(state: SubagentTask): Promise<void> {
    if (state.status === 'queued' && state.turn) {
      const turn = state.turn;
      const index = this.#queue.indexOf(state);
      if (index >= 0) this.#queue.splice(index, 1);
      state.cancelQueued(true);
      this.#touchResource(state, true);
      this.#closeReceipt(state);
      await this.#publishTerminal(state);
      state.settleHandleReady(turn);
      state.settleCompletion(turn);
      this.#notifyCompletion(state);
      state.clearTurn(turn);
      this.#drain();
    } else if (state.status === 'running' && state.turn) {
      const turn = state.turn;
      const needsHandle = !turn.handle;
      state.requestCancel(turn);
      if (needsHandle) {
        await turn.handleReady;
      }
      await turn.completion;
    }
  }

  listSessionResources() {
    const states = [...this.#agents.values()];
    const active = states
      .filter((state) => state.status === 'queued' || state.status === 'running')
      .sort((left, right) => right.resourceRevision - left.resourceRevision);
    const terminal = states
      .filter((state) => state.status !== 'queued' && state.status !== 'running')
      .sort((left, right) => right.resourceRevision - left.resourceRevision)
      .slice(0, RECENT_TERMINAL_RESOURCE_LIMIT);
    return [...active, ...terminal].map((state) => ({
      agentId: state.agentId,
      status: state.status,
      description: state.description
    }));
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#pendingDeliveries) pending.delivery.settled?.('cancelled');
    for (const state of this.#queue.splice(0)) {
      const turn = state.turn;
      state.cancelQueued(false);
      this.#closeReceipt(state);
      if (turn) {
        state.settleHandleReady(turn);
        state.settleCompletion(turn);
      }
      this.#notifyCompletion(state);
      if (turn) state.clearTurn(turn);
    }
    for (const state of this.#agents.values()) {
      if (state.status !== 'running' || !state.turn) continue;
      state.requestCancel(state.turn);
    }
    await Promise.allSettled(
      [...this.#agents.values()].flatMap((state) =>
        state.turn === undefined ? [] : [state.turn.completion]
      )
    );
    this.#execution = undefined;
    this.#nativeObservations.clear();
  }

  #queueTurn(
    state: SubagentTask,
    prompt: string,
    execution: SubagentParentContext,
    pendingMessages: SubagentMailboxMessage[],
    turnId: string = randomUUID(),
    delivery?: SubagentMessageDelivery,
    signal?: AbortSignal,
    turnSignal?: AbortSignal
  ): void {
    const native =
      this.#retainedExecution.getStore()?.native === true && 'operationId' in execution
        ? execution
        : undefined;
    const sourceSignal =
      turnSignal ??
      (native === undefined
        ? undefined
        : signal === undefined
          ? native.signal
          : AbortSignal.any([native.signal, signal]));
    this.#touchResource(state);
    let turn!: TurnView;
    const abort = () => {
      void this.#control(state, async () => {
        if (state.turn === turn) await this.#cancelState(state);
      }).catch(() => undefined);
    };
    turn = state.queueTurn(
      {
        turnId,
        ...(native?.ownerInstanceId === undefined
          ? {}
          : { ownerInstanceId: native.ownerInstanceId }),
        ...(native?.origin === undefined
          ? {}
          : { origin: Object.freeze({ ...native.origin, signal: sourceSignal! }) }),
        ...(delivery === undefined ? {} : { delivery }),
        prompt,
        start: execution.startTurn,
        pendingMessages
      },
      () => sourceSignal?.removeEventListener('abort', abort)
    );
    sourceSignal?.addEventListener('abort', abort, { once: true });
    this.#queue.push(state);
    this.#drain();
    if (sourceSignal?.aborted) abort();
  }

  #drain(): void {
    while (!this.#disposed && this.#running < this.limits.maxConcurrent && this.#queue.length > 0) {
      const state = this.#queue.shift()!;
      const turn = state.turn;
      if (!turn || state.status !== 'queued') continue;
      state.markRunning();
      this.#touchResource(state);
      this.#running++;
      void this.#startAndConsumeTurn(state, turn);
    }
  }

  async #startAndConsumeTurn(state: SubagentTask, turn: TurnView): Promise<void> {
    try {
      const handle = await turn.start({
        turnId: turn.turnId,
        ...(turn.delivery === undefined ? {} : { delivery: turn.delivery }),
        ...(turn.origin === undefined ? {} : { origin: turn.origin }),
        sessionId: state.agentId,
        prompt: turn.prompt,
        modelId: state.modelId!,
        reasoningEffort: state.reasoningEffort!,
        role: state.role,
        initialMailbox: state.takePendingMessages(turn)
      });
      state.attachHandle(turn, handle);
    } catch (error) {
      state.settleHandleReady(turn);
      await this.#failTurn(state, turn, error);
      return;
    }
    state.cancelPending(turn);
    state.settleHandleReady(turn);
    await this.#consumeTurn(state, turn);
  }

  async #consumeTurn(state: SubagentTask, turn: TurnView): Promise<void> {
    const previousActivity = state.latestActivity;
    const previousMessageRevision = state.messageRevision;
    let terminal: 'completed' | 'failed' | 'cancelled' | undefined;
    try {
      const consume = (async () => {
        for await (const event of turn.handle!) {
          if (event.type === 'execution.completed') terminal = 'completed';
          else if (event.type === 'execution.failed') terminal = 'failed';
          else if (event.type === 'execution.cancelled') terminal = 'cancelled';
          if (!state.observeEvent(event, this.#activityRevision + 1)) continue;
          this.#activityRevision++;
          this.#touchResource(state);
          this.#notifyActivity({ state, kind: 'message' });
        }
      })();
      const [resultOutcome, consumeOutcome] = await Promise.allSettled([
        Promise.resolve().then(() => turn.handle!.result()),
        consume
      ]);
      if (resultOutcome.status === 'rejected') throw resultOutcome.reason;
      if (consumeOutcome.status === 'rejected') throw consumeOutcome.reason;
      const result = resultOutcome.value;
      state.complete(
        result,
        terminal,
        turn.handle!.persistedEvents === true,
        previousActivity,
        previousMessageRevision
      );
      this.#touchResource(state, true);
      this.#closeReceipt(state);
      await this.#publishTerminal(state);
    } catch (error) {
      this.#setFailure(state, error);
      this.#closeReceipt(state);
      await this.#publishTerminal(state);
    } finally {
      this.#closeReceipt(state);
      this.#running--;
      state.settleCompletion(turn);
      this.#notifyCompletion(state);
      state.clearTurn(turn);
      this.#drain();
    }
  }

  async #failTurn(state: SubagentTask, turn: TurnView, error: unknown): Promise<void> {
    this.#setFailure(state, error);
    this.#closeReceipt(state);
    this.#running--;
    state.settleCompletion(turn);
    state.clearTurn(turn);
    this.#notifyCompletion(state);
    await this.#publishTerminal(state);
    this.#drain();
  }

  #setFailure(state: SubagentTask, error: unknown): void {
    state.fail(error);
    this.#touchResource(state, true);
  }

  #touchResource(state: SubagentTask, terminal = false): void {
    state.touch(++this.#resourceRevision, terminal);
  }

  #waitForAnyCompletion(
    candidates: readonly SubagentTask[],
    waitMs: number,
    signal?: AbortSignal,
    interrupt?: ToolWaitInterrupt
  ): Promise<SubagentTask | undefined> {
    return this.#waiters.waitCompletion(
      (state) => candidates.includes(state),
      () => candidates.find(isTerminalState),
      waitMs,
      signal,
      interrupt
    );
  }

  #waitForCompletion(
    state: SubagentTask,
    waitMs: number,
    signal?: AbortSignal,
    interrupt?: ToolWaitInterrupt
  ): Promise<SubagentTask | undefined> {
    return this.#waiters.waitCompletion(
      (completed) => completed === state,
      () => (isTerminalState(state) ? state : undefined),
      waitMs,
      signal,
      interrupt
    );
  }

  #notifyCompletion(state: SubagentTask): void {
    this.#waiters.notifyCompletion(state);
    this.#notifyActivity({ state, kind: 'completion' });
  }

  #waitForMessageOrCompletion(
    candidates: readonly SubagentTask[],
    waitMs: number,
    signal?: AbortSignal,
    interrupt?: ToolWaitInterrupt
  ): Promise<AgentActivity | undefined> {
    return this.#waiters.waitActivity(
      (activity) => candidates.includes(activity.state),
      () => {
        const pending = this.#oldestUnreadMessage(candidates);
        if (pending) return { state: pending, kind: 'message' };
        const terminal = candidates.find(isTerminalState);
        return terminal ? { state: terminal, kind: 'completion' } : undefined;
      },
      waitMs,
      signal,
      interrupt
    );
  }

  #notifyActivity(activity: AgentActivity): void {
    this.#waiters.notifyActivity(activity);
  }

  #hasUnreadMessage(state: SubagentTask): boolean {
    return (
      state.messageRevision >
      (this.#nativeObservation(state)?.messageRevision ?? state.observedMessageRevision)
    );
  }

  #nativeObservation(
    state: SubagentTask
  ): { messageRevision: number; terminalRevision: number } | undefined {
    const context = this.#retainedExecution.getStore();
    if (!context?.native || !('operationId' in context.execution)) return undefined;
    const owner = context.execution.ownerInstanceId ?? context.execution.operationId;
    let observations = this.#nativeObservations.get(owner);
    if (!observations) this.#nativeObservations.set(owner, (observations = new Map()));
    let observation = observations.get(state.agentId);
    if (!observation)
      observations.set(state.agentId, (observation = { messageRevision: 0, terminalRevision: 0 }));
    return observation;
  }

  #oldestUnreadMessage(states: readonly SubagentTask[]): SubagentTask | undefined {
    return states
      .filter((state) => this.#hasUnreadMessage(state))
      .sort(
        (left, right) => left.latestMessageActivityRevision - right.latestMessageActivityRevision
      )
      .at(0);
  }

  #observeLatestMessage(state: SubagentTask): void {
    const native = this.#nativeObservation(state);
    if (native) native.messageRevision = state.messageRevision;
    else state.acknowledgeMessage(state.messageRevision);
  }

  #observeTerminal(state: SubagentTask): boolean {
    const native = this.#nativeObservation(state);
    if (native) {
      if (!isTerminalState(state) || native.terminalRevision === state.resourceRevision)
        return false;
      native.terminalRevision = state.resourceRevision;
      return true;
    }
    if (!isTerminalState(state) || state.observedTerminalRevision >= state.resourceRevision)
      return false;
    state.acknowledgeTerminal(state.resourceRevision);
    return true;
  }

  #createDelivery(
    state: SubagentTask,
    execution: SubagentParentContext,
    receipt: NonNullable<SubagentTaskState['receipt']>,
    signal?: AbortSignal
  ): SubagentMessageDelivery & { accepted(): void } {
    const native =
      this.#retainedExecution.getStore()?.native === true && 'operationId' in execution
        ? execution
        : undefined;
    const sourceSignal =
      native === undefined
        ? undefined
        : signal === undefined
          ? native.signal
          : AbortSignal.any([native.signal, signal]);
    const controller = new AbortController();
    const release = () => {
      sourceSignal?.removeEventListener('abort', abort);
      this.#pendingDeliveries.delete(pending);
    };
    const delivery: SubagentMessageDelivery & { accepted(): void } = {
      accepted: () => {
        pending.admitted = true;
      },
      messageId: receipt.messageId,
      ...(native?.origin === undefined ? {} : { origin: native.origin }),
      ...(native === undefined ? {} : { signal: controller.signal }),
      applied: () => {
        // A durable commit remains applied even if cancellation races its completion callback.
        state.updateDelivery(receipt, 'applied');
        release();
      },
      settled: (status) => {
        if (!state.updateDelivery(receipt, status)) return;
        controller.abort(new AgentError('MAR_AGENT_CANCELLED', 'Agent message was cancelled.'));
        release();
      }
    };
    const pending = {
      state,
      receipt,
      delivery,
      admitted: false,
      ...(native?.ownerInstanceId === undefined ? {} : { ownerInstanceId: native.ownerInstanceId })
    };
    const abort = () => delivery.settled?.('cancelled');
    this.#pendingDeliveries.add(pending);
    sourceSignal?.addEventListener('abort', abort, { once: true });
    if (sourceSignal?.aborted) abort();
    return delivery;
  }

  #closeReceipt(state: SubagentTask): void {
    for (const pending of this.#pendingDeliveries)
      if (
        pending.admitted &&
        pending.state === state &&
        pending.receipt.turnId === state.turn?.turnId
      )
        pending.delivery.settled?.(state.status === 'cancelled' ? 'cancelled' : 'failed');
  }

  async #deleteUnstartedSession(agentId: string, error: unknown): Promise<never> {
    this.#agents.delete(agentId);
    this.#discovered.delete(agentId);
    try {
      await this.backend.deleteSession(agentId);
    } catch (cleanupError) {
      const original = describeAgentError(error, 'MAR_AGENT_SUBAGENT_FAILED');
      const cleanup = describeAgentError(cleanupError, 'MAR_AGENT_SUBAGENT_FAILED');
      throw new AgentError(
        original.code,
        `${original.message} Cleanup also failed: ${cleanup.message}`,
        { cause: cleanupError }
      );
    }
    throw error;
  }

  async #using<T>(ids: readonly string[] | undefined, operation: () => Promise<T>): Promise<T> {
    if (ids === undefined) this.#allReaders++;
    else for (const id of ids) this.#readers.set(id, (this.#readers.get(id) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      if (ids === undefined) this.#allReaders--;
      else
        for (const id of ids) {
          const count = this.#readers.get(id)! - 1;
          if (count) this.#readers.set(id, count);
          else this.#readers.delete(id);
        }
    }
  }

  #releaseOldDetails(): void {
    if (this.#allReaders) return;
    const terminal = [...this.#agents.values()]
      .filter(isTerminalState)
      .sort((a, b) => b.resourceRevision - a.resourceRevision);
    for (const state of terminal.slice(RECENT_TERMINAL_RESOURCE_LIMIT)) {
      if (
        state.detailsEvicted ||
        !state.restorable ||
        state.turn ||
        state.controlTail ||
        this.#readers.has(state.agentId) ||
        this.#loading.has(state.agentId) ||
        state.terminalPending ||
        state.messageRevision > state.observedMessageRevision ||
        (state.terminalRevision !== undefined &&
          state.terminalRevision > state.observedTerminalRevision) ||
        [...this.#pendingDeliveries].some((pending) => pending.state === state)
      )
        continue;
      // Keep identity and cursors for old acknowledgements; only the disk-backed body unloads.
      state.evictDetails();
    }
  }

  async #find(agentId: string): Promise<SubagentTask> {
    if (this.#disposed)
      throw new AgentError('MAR_AGENT_DISPOSED', 'Subagent controller is disposed.');
    const known = this.#agents.get(agentId);
    if (known && !known.detailsEvicted) return known;
    const pending = this.#loading.get(agentId);
    if (pending) return pending;
    const load = (async () => {
      const persisted = await this.backend.loadChild(this.parentSessionId, agentId);
      if (this.#disposed)
        throw new AgentError('MAR_AGENT_DISPOSED', 'Subagent controller is disposed.');
      if (!persisted) {
        this.#agents.delete(agentId);
        this.#discovered.delete(agentId);
        throw new AgentError('MAR_AGENT_SUBAGENT_NOT_FOUND', 'Subagent was not found.');
      }
      const existing = this.#agents.get(agentId);
      if (existing && !existing.detailsEvicted) return existing;
      const restored = restoreAgentState(persisted);
      if (existing) {
        existing.restoreDetails(restored);
        return existing;
      }
      let revision = this.#discovered.get(agentId);
      if (revision === undefined) {
        revision = ++this.#resourceRevision;
        this.#discovered.set(agentId, revision);
      }
      restored.resourceRevision = revision;
      const task = new SubagentTask(restored);
      this.#agents.set(agentId, task);
      return task;
    })();
    this.#loading.set(agentId, load);
    try {
      return await load;
    } finally {
      if (this.#loading.get(agentId) === load) this.#loading.delete(agentId);
    }
  }

  #requireExecution(): SubagentParentContext {
    if (this.#disposed)
      throw new AgentError('MAR_AGENT_DISPOSED', 'Subagent controller is disposed.');
    const execution = this.#retainedExecution.getStore()?.execution ?? this.#execution;
    if (!execution)
      throw new AgentError(
        'MAR_AGENT_SUBAGENT_FAILED',
        'Subagent control requires an active parent execution.'
      );
    if ('signal' in execution) execution.signal.throwIfAborted();
    return execution;
  }

  #receiptSnapshot(state: SubagentTask): SubagentTaskSnapshot {
    return this.#snapshot(state, {
      includeLatestMessage: false,
      includeLatestActivity: false,
      includeTerminalDetails: false
    });
  }

  #messageReceiptSnapshot(state: SubagentTask): SubagentTaskSnapshot {
    // A follow-up starts a new observation boundary; messages from the preceding state
    // must not be returned later as fresh progress for the newly requested work.
    this.#observeLatestMessage(state);
    return this.#receiptSnapshot(state);
  }

  #snapshot(
    state: TaskView,
    options: {
      includeLatestMessage?: boolean;
      includeLatestActivity?: boolean;
      includeTerminalDetails?: boolean;
      full?: boolean;
    } = {}
  ): SubagentTaskSnapshot {
    const terminal =
      state.status === 'completed' ||
      state.status === 'failed' ||
      state.status === 'cancelled' ||
      state.status === 'interrupted';
    const includeLatestMessage = options.includeLatestMessage ?? true;
    const includeLatestActivity = options.includeLatestActivity ?? true;
    const includeTerminalDetails = options.includeTerminalDetails ?? true;
    const full = options.full ?? this.#retainedExecution.getStore()?.native === true;
    const latestMessage =
      !includeLatestMessage || state.latestMessage === undefined
        ? undefined
        : full
          ? { ...state.latestMessage }
          : projectLatestMessage(state.latestMessage, terminal);
    const summary =
      !includeTerminalDetails || state.summary === undefined
        ? undefined
        : full
          ? state.summary
          : truncateUtf8(state.summary, SUBAGENT_LIMITS.subagentSummaryMaxBytes);
    const omitDuplicateMessage =
      !full &&
      terminal &&
      latestMessage?.phase === 'final_answer' &&
      summary !== undefined &&
      summary === state.latestMessage?.text &&
      (state.receipt === undefined || state.receipt.turnId === latestMessage.turnId);
    return {
      agentId: state.agentId,
      description: state.description,
      status: state.status,
      ...(full && this.#retainedExecution.getStore()?.native === true
        ? {
            role: state.role,
            ...(state.extensionId === undefined ? {} : { extensionId: state.extensionId })
          }
        : {}),
      ...(includeTerminalDetails && state.permissionStop
        ? { permissionStop: state.permissionStop }
        : {}),
      ...state.receipt,
      ...(omitDuplicateMessage ? { turnId: latestMessage.turnId } : {}),
      ...(state.modelId === undefined ? {} : { modelId: state.modelId }),
      ...(state.modelName === undefined ? {} : { modelName: state.modelName }),
      ...(state.reasoningEffort === undefined ? {} : { reasoningEffort: state.reasoningEffort }),
      ...(latestMessage === undefined || omitDuplicateMessage ? {} : { latestMessage }),
      ...(!includeLatestActivity || state.latestActivity === undefined
        ? {}
        : { latestActivity: { ...state.latestActivity } }),
      ...(summary === undefined ? {} : { summary }),
      ...(!includeTerminalDetails || !terminal || state.changedFiles.length === 0
        ? {}
        : {
            changedFiles: full
              ? [...state.changedFiles]
              : state.changedFiles.slice(0, SUBAGENT_LIMITS.subagentChangedFilesMaxItems)
          }),
      ...(!full || !includeTerminalDetails || !terminal || state.verification.length === 0
        ? {}
        : { verification: [...state.verification] }),
      ...(!full || !includeTerminalDetails || !terminal || state.evidence.length === 0
        ? {}
        : { evidence: state.evidence.map((item) => ({ ...item })) }),
      ...(state.errorCode === undefined ? {} : { errorCode: state.errorCode }),
      ...(state.errorMessage === undefined ? {} : { errorMessage: state.errorMessage })
    };
  }

  async #publishTerminal(state: SubagentTask): Promise<void> {
    if (!state.terminalPending || !this.#execution) return;
    const revision = state.terminalRevision;
    try {
      await this.#execution.emitTerminal(this.#snapshot(state, { full: false }));
      state.terminalPublished(revision);
    } catch {
      // Keep the terminal transition pending for a later active parent Execution.
    }
  }
}

function projectLatestMessage(
  message: SubagentLatestMessage,
  terminal: boolean
): SubagentLatestMessage {
  const text = truncateCharacters(
    message.text,
    !terminal && message.phase === 'commentary'
      ? SUBAGENT_LIMITS.subagentRunningLatestMessageMaxCharacters
      : 10_000
  );
  return {
    ...message,
    text,
    truncated: message.truncated === true || text !== message.text
  };
}

function validateTaskInput(input: SubagentTaskInput, native = false): void {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.description !== 'string' ||
    typeof input.prompt !== 'string' ||
    (input.role !== 'general-purpose' && input.role !== 'explore') ||
    (input.reasoningEffort !== undefined && !isReasoningEffort(input.reasoningEffort)) ||
    input.parentSubagentId ||
    !input.description.trim() ||
    (!native && input.description.length > SUBAGENT_LIMITS.subagentDescriptionMaxCharacters) ||
    !input.prompt.trim() ||
    (!native && Buffer.byteLength(input.prompt) > SUBAGENT_LIMITS.subagentPromptMaxBytes)
  )
    throw new AgentError(
      input?.parentSubagentId
        ? 'MAR_AGENT_SUBAGENT_RECURSION_DISABLED'
        : 'MAR_AGENT_TOOL_INPUT_INVALID',
      input?.parentSubagentId ? 'Subagents cannot create subagents.' : 'Subagent task is invalid.'
    );
}

function resolveModel(
  execution: SubagentParentContext,
  input: SubagentTaskInput
): SubagentModelOption & { reasoningEffort: AgentReasoningEffort } {
  const modelId = input.modelId ?? execution.modelId;
  const model = execution.models.get(modelId);
  if (!model || model.conversationModel === false)
    throw new AgentError(
      'MAR_AGENT_SUBAGENT_MODEL_UNAVAILABLE',
      'Selected model is unavailable for subagents.'
    );
  if (
    input.reasoningEffort !== undefined &&
    !model.reasoningEfforts.includes(input.reasoningEffort)
  )
    throw new AgentError(
      'MAR_AGENT_SUBAGENT_REASONING_EFFORT_UNAVAILABLE',
      'Selected reasoning effort is unavailable for the subagent model.',
      {
        details: {
          modelId,
          reasoningEffort: input.reasoningEffort,
          supportedReasoningEfforts: model.reasoningEfforts
        }
      }
    );
  const reasoningEffort =
    input.reasoningEffort ??
    (model.reasoningEfforts.includes(execution.reasoningEffort)
      ? execution.reasoningEffort
      : model.defaultReasoningEffort);
  return { ...model, reasoningEffort };
}

function resolveExistingModel(
  execution: SubagentParentContext,
  state: Pick<SubagentTaskState, 'modelId' | 'reasoningEffort'>
): SubagentModelOption & { reasoningEffort: AgentReasoningEffort } {
  const model = execution.models.get(state.modelId ?? execution.modelId);
  if (!model)
    throw new AgentError(
      'MAR_AGENT_SUBAGENT_MODEL_UNAVAILABLE',
      'The subagent model is no longer available.'
    );
  return {
    ...model,
    reasoningEffort:
      state.reasoningEffort && model.reasoningEfforts.includes(state.reasoningEffort)
        ? state.reasoningEffort
        : model.defaultReasoningEffort
  };
}

function restoreAgentState(session: PersistedSubagentSession): SubagentTaskState {
  const delivered = session.records.findLast(
    (record) =>
      (record.type === 'turn.user' || record.type === 'extension.input') &&
      isRecord(record.payload) &&
      typeof record.payload.messageId === 'string' &&
      typeof record.turnId === 'string'
  );
  const latestExecutionStart = session.records.findLastIndex(
    (record) => eventType(record) === 'execution.started'
  );
  const currentRecords =
    latestExecutionStart < 0 ? session.records : session.records.slice(latestExecutionStart);
  const header = session.records.findLast(
    (record) => record.type === 'execution.header' && isRecord(record.payload)
  )?.payload as Record<string, unknown> | undefined;
  const terminal = currentRecords.findLast((record) =>
    ['execution.completed', 'execution.failed', 'execution.cancelled'].includes(
      eventType(record) ?? ''
    )
  );
  const terminalType = eventType(terminal);
  const state: SubagentTaskState = {
    restorable: true,
    agentId: session.id,
    description: session.source.description,
    role: session.source.role,
    ...(session.source.ownerInstanceId === undefined
      ? {}
      : { ownerInstanceId: session.source.ownerInstanceId }),
    ...(session.source.extensionId === undefined
      ? {}
      : { extensionId: session.source.extensionId }),
    status:
      terminalType === 'execution.completed'
        ? 'completed'
        : terminalType === 'execution.failed'
          ? 'failed'
          : terminalType === 'execution.cancelled'
            ? 'cancelled'
            : 'interrupted',
    ...(delivered && isRecord(delivered.payload)
      ? {
          receipt: {
            messageId: delivered.payload.messageId as string,
            turnId: delivered.turnId!,
            deliveryStatus: 'applied' as const
          }
        }
      : {}),
    ...(typeof header?.modelId === 'string' ? { modelId: header.modelId } : {}),
    ...(typeof header?.modelName === 'string' ? { modelName: header.modelName } : {}),
    ...(isReasoningEffort(header?.reasoningEffort)
      ? { reasoningEffort: header.reasoningEffort }
      : {}),
    messageRevision: 0,
    observedMessageRevision: 0,
    latestMessageActivityRevision: 0,
    changedFiles: [],
    verification: [],
    evidence: [],
    terminalPending: false,
    observedTerminalRevision: -1,
    resourceRevision: 0
  };
  if (terminalType === 'execution.completed' && terminal) {
    const event = terminal.payload as Extract<AgentEvent, { type: 'execution.completed' }>;
    if (event.permissionStop) state.permissionStop = event.permissionStop;
  }
  for (const record of currentRecords) {
    if (
      !isRecord(record.payload) ||
      !['message.completed', 'tool.started', 'tool.completed', 'tool.failed'].includes(
        eventType(record) ?? ''
      )
    )
      continue;
    const event = record.payload as unknown as AgentEvent;
    if (observeAgentEvent(state, event)) state.messageRevision++;
  }
  state.observedMessageRevision = state.messageRevision;
  if (state.status === 'completed' && state.latestMessage?.phase === 'final_answer')
    state.summary = state.latestMessage.text;
  if (state.status === 'failed' && terminal && isRecord(terminal.payload)) {
    if (typeof terminal.payload.code === 'string') state.errorCode = terminal.payload.code;
    if (typeof terminal.payload.message === 'string') state.errorMessage = terminal.payload.message;
  }
  return state;
}

function observeAgentEvent(state: SubagentTaskState, event: AgentEvent): boolean {
  if (event.type === 'message.completed') {
    state.latestMessage = latestMessageFromEvent(event);
    state.latestActivity = {
      kind: 'message',
      timestamp: event.timestamp,
      phase: event.phase
    };
    return true;
  }
  if (event.type === 'tool.started') {
    state.latestActivity = {
      kind: 'tool',
      timestamp: event.timestamp,
      toolName: event.toolName,
      status: 'started'
    };
    return false;
  }
  if (event.type === 'tool.failed') {
    state.latestActivity = {
      kind: 'tool',
      timestamp: event.timestamp,
      toolName: event.toolName,
      status: 'failed'
    };
    return false;
  }
  if (event.type !== 'tool.completed') return false;
  state.latestActivity = {
    kind: 'tool',
    timestamp: event.timestamp,
    toolName: event.toolName,
    status: 'completed'
  };
  if (event.toolName === 'apply_patch' && isRecord(event.data)) {
    const data = event.data as Record<string, unknown>;
    const files = Array.isArray(data.files) ? data.files : [];
    for (const file of files) {
      if (!isRecord(file)) continue;
      for (const path of [file.path, file.targetPath])
        if (typeof path === 'string' && path.length > 0 && !state.changedFiles.includes(path))
          state.changedFiles.push(path);
    }
  } else if (event.toolName === 'read' && isRecord(event.data)) {
    const data = event.data as Record<string, unknown>;
    const results = Array.isArray(data.results) ? data.results : [];
    for (const result of results) {
      if (!isRecord(result) || typeof result.path !== 'string' || result.error !== undefined)
        continue;
      const evidence = {
        path: result.path,
        ...(isPositiveInteger(result.startLine) ? { startLine: result.startLine } : {}),
        ...(isPositiveInteger(result.endLine) ? { endLine: result.endLine } : {})
      };
      if (!state.evidence.some((item) => JSON.stringify(item) === JSON.stringify(evidence)))
        state.evidence.push(evidence);
    }
  } else if (event.toolName === 'exec') state.verification.push(event.summary);
  return false;
}

function eventType(record: SubagentHistoryRecord | undefined): string | undefined {
  return record && isRecord(record.payload) && typeof record.payload.type === 'string'
    ? record.payload.type
    : undefined;
}

function latestMessageFromEvent(
  event: Extract<AgentEvent, { type: 'message.completed' }>
): SubagentLatestMessage {
  const text = event.text;
  return {
    itemId: event.itemId,
    turnId: event.turnId ?? '',
    phase: event.phase,
    text,
    timestamp: event.timestamp,
    truncated: text !== event.text
  };
}

function isReasoningEffort(value: unknown): value is AgentReasoningEffort {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'ultra'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function truncateCharacters(value: string, maximumCharacters: number): string {
  const characters = [...value];
  return characters.length <= maximumCharacters
    ? value
    : characters.slice(0, maximumCharacters).join('');
}

function validateOutputOptions(options: SubagentOutputOptions, native = false): void {
  if (
    (options.untilSettled !== undefined && options.untilSettled !== true) ||
    (options.untilSettled === true && options.waitFor === 'message') ||
    (options.waitFor !== undefined &&
      options.waitFor !== 'completion' &&
      options.waitFor !== 'message') ||
    (options.waitMs !== undefined &&
      (!Number.isSafeInteger(options.waitMs) ||
        options.waitMs < SUBAGENT_LIMITS.agentWaitMinWaitMs ||
        (!native && options.waitMs > SUBAGENT_LIMITS.agentWaitMaxWaitMs)))
  )
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Task wait is invalid.');
}

function isTerminalState(state: Pick<SubagentTaskState, 'status'>): boolean {
  return (
    state.status === 'completed' ||
    state.status === 'failed' ||
    state.status === 'cancelled' ||
    state.status === 'interrupted'
  );
}

function waitForPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (result: { value: T } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if ('error' in result) reject(result.error);
      else resolve(result.value);
    };
    const abort = () =>
      finish({
        error:
          signal.reason ?? new AgentError('MAR_AGENT_EXECUTION_CANCELLED', 'Execution cancelled.')
      });
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => finish({ value }),
      (error: unknown) => finish({ error })
    );
    if (signal.aborted) abort();
  });
}

/** Retain the waited Turn's evidence when the live Session moves on to another Turn. */
function copyWaitState(state: SubagentTask): TaskView {
  return state.copyWaitState();
}
