import { describeAgentError } from '../error.js';
import type { AgentReasoningEffort } from '../model/configuration.js';
import type { ExecutionResult } from '../runtime/contracts.js';
import type { AgentEvent } from '../runtime/events.js';
import type {
  SubagentTaskInput,
  SubagentTaskSnapshot,
  SubagentLatestMessage,
  SubagentLatestActivity
} from './contracts.js';
import type {
  SubagentOrigin,
  SubagentMessageDelivery,
  SubagentMailboxMessage,
  SubagentParentExecution,
  SubagentTurnHandle
} from './turn-contracts.js';

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

export type TurnView = Readonly<
  Omit<TurnState, 'pendingMessages' | 'resolve' | 'resolveHandleReady' | 'cancelRequested'>
>;
type TurnInput = Omit<
  TurnState,
  'handleReady' | 'completion' | 'resolve' | 'resolveHandleReady' | 'handle' | 'cancelRequested'
>;

export interface SubagentTaskState {
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

export type TaskView = Omit<
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
export class SubagentTask {
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
  async runTurn(
    turn: TurnView,
    nextActivityRevision: () => number,
    onMessage: () => void,
    onTerminal: () => void
  ): Promise<'opening-failed' | 'settled'> {
    try {
      const handle = await turn.start({
        turnId: turn.turnId,
        ...(turn.delivery === undefined ? {} : { delivery: turn.delivery }),
        ...(turn.origin === undefined ? {} : { origin: turn.origin }),
        sessionId: this.agentId,
        prompt: turn.prompt,
        modelId: this.modelId!,
        reasoningEffort: this.reasoningEffort!,
        role: this.role,
        initialMailbox: this.#takePendingMessages(turn)
      });
      this.#attachHandle(turn, handle);
    } catch (error) {
      this.#settleHandleReady(turn);
      this.fail(error);
      onTerminal();
      return 'opening-failed';
    }
    this.#cancelPending(turn);
    this.#settleHandleReady(turn);
    const previousActivity = this.latestActivity;
    const previousMessageRevision = this.messageRevision;
    let terminal: 'completed' | 'failed' | 'cancelled' | undefined;
    try {
      const consume = (async () => {
        for await (const event of turn.handle!) {
          if (event.type === 'execution.completed') terminal = 'completed';
          else if (event.type === 'execution.failed') terminal = 'failed';
          else if (event.type === 'execution.cancelled') terminal = 'cancelled';
          if (this.observeEvent(event, nextActivityRevision())) onMessage();
        }
      })();
      const [result, stream] = await Promise.allSettled([
        Promise.resolve().then(() => turn.handle!.result()),
        consume
      ]);
      if (result.status === 'rejected') throw result.reason;
      if (stream.status === 'rejected') throw stream.reason;
      this.complete(
        result.value,
        terminal,
        turn.handle!.persistedEvents === true,
        previousActivity,
        previousMessageRevision
      );
    } catch (error) {
      this.fail(error);
    }
    onTerminal();
    return 'settled';
  }
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
  #attachHandle(expected: TurnView, handle: SubagentTurnHandle): void {
    const turn = this.state.turn;
    if (turn !== expected) return;
    turn.handle = handle;
  }
  #cancelPending(expected: TurnView): void {
    const turn = this.state.turn;
    if (turn === expected && turn.cancelRequested) turn.handle!.cancel();
  }
  #takePendingMessages(expected: TurnView): SubagentMailboxMessage[] {
    const turn = this.state.turn;
    return turn === expected ? turn.pendingMessages.splice(0) : [];
  }
  #settleHandleReady(expected: TurnView): void {
    if (this.state.turn === expected) this.state.turn.resolveHandleReady();
  }
  settleQueuedTurn(expected: TurnView): void {
    this.#settleHandleReady(expected);
    this.settleTurn(expected);
  }
  settleTurn(expected: TurnView): void {
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
  markRunning(expected: TurnView): boolean {
    if (this.state.turn !== expected || this.state.status !== 'queued') return false;
    this.state.status = 'running';
    return true;
  }
  releaseTurn(expected: TurnView): void {
    if (this.state.turn === expected) delete this.state.turn;
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

export function observeAgentEvent(state: SubagentTaskState, event: AgentEvent): boolean {
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
      if (
        !state.evidence.some(
          (item) =>
            item.path === evidence.path &&
            item.startLine === evidence.startLine &&
            item.endLine === evidence.endLine
        )
      )
        state.evidence.push(evidence);
    }
  } else if (event.toolName === 'exec') state.verification.push(event.summary);
  return false;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}
