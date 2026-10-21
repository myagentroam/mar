import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { MarAgentError } from '../error.js';
import type { CoreOperationContext } from './operation.js';
import type { SessionSource } from '../session/types.js';
import { captureCorePromptInput, type CorePromptInput } from './prompt-input.js';
import type { CoreRequestSnapshot } from './model-request.js';
import type { CorePromptComposition, CorePromptFacts } from './prompt-composition.js';
import type { CoreSessionMessages, CoreSessionMessagesInput } from './session-messages.js';
export type {
  CoreSessionMessages,
  CoreSessionMessagesInput,
  CoreSessionMessage
} from './session-messages.js';

export interface CoreAppendInput {
  readonly content: string;
  readonly textBlocks?: readonly { readonly text: string }[];
  readonly visibility?: 'model' | 'transcript';
  /** Immediate records commit without scheduling an input or waking a model round. */
  readonly delivery?: 'boundary' | 'immediate';
  readonly attribution?: string;
}
export interface CoreInputSource {
  readonly operationId: string;
  readonly actor?: CoreOperationContext['actor'];
  readonly extensionId?: string;
  readonly ownerInstanceId?: string;
  readonly provenance?: string;
  /** Presentation intent only; it never changes the actual author or authority. */
  readonly modelAttribution?: 'none';
}
export interface CoreSubmitInput extends CorePromptInput {
  readonly provenance?: string;
  readonly modelAttribution?: 'none';
  readonly delivery?: 'boundary' | 'idle';
  readonly waitFor?: 'admission' | 'start' | 'commit';
  /** Explicit lifetime after admission; the Extension owner remains authoritative. */
  readonly queueSignal?: AbortSignal;
}
export interface CoreCompactInput {
  readonly focus?: string;
  readonly async?: boolean;
}
export type CoreSessionRequest =
  | { readonly kind: 'append'; readonly input: CoreAppendInput }
  | { readonly kind: 'submit'; readonly input: CoreSubmitInput }
  | { readonly kind: 'compact'; readonly input: CoreCompactInput };
export type CoreSessionOperationStatus =
  | 'queued'
  | 'accepted'
  | 'in-progress'
  | 'committed'
  | 'completed'
  | 'handled'
  | 'cancelled'
  | 'failed';
export interface CoreSessionReceipt {
  /** The actual committed record, absent before the writer has completed. */
  readonly recordId?: string;
  readonly operationId: string;
  readonly sequence: number;
  readonly kind: CoreSessionRequest['kind'];
  readonly status: CoreSessionOperationStatus;
  readonly executionId?: string;
  readonly errorCode?: string;
  readonly changed?: boolean;
  readonly handledValue?: unknown;
  readonly ownerInstanceId?: string;
  readonly extensionId?: string;
  readonly parentOperationId?: string;
}
export interface CoreSessionInspection {
  readonly sessionId: string;
  readonly epoch: number;
  readonly activeExecutionId?: string;
  readonly operations: readonly CoreSessionReceipt[];
}
export interface CoreSessionDescription {
  readonly sessionId: string;
  readonly source?: SessionSource;
  readonly cwd?: string;
  readonly root?: string;
  readonly modelId: string;
  readonly modelName: string;
  readonly startedAt: number;
  readonly userTurns: number;
}
export interface CoreSessionApi {
  captureRequest(input?: {
    readonly completed?: boolean;
  }): Promise<CoreRequestSnapshot | undefined>;
  inspect(): Promise<CoreSessionInspection>;
  describe(): Promise<CoreSessionDescription>;
  messages(input?: CoreSessionMessagesInput): Promise<CoreSessionMessages>;
  append(input: CoreAppendInput): Promise<CoreSessionReceipt>;
  submit(input: CoreSubmitInput): Promise<CoreSessionReceipt>;
  compact(input?: CoreCompactInput): Promise<CoreSessionReceipt>;
}
export interface CoreSessionActionResult {
  /** The physical boundary deliberately skipped a record before any commit. */
  readonly handled?: true;
  readonly changed: boolean;
  readonly recordId?: string;
  readonly modelChanged?: boolean;
  readonly executionId?: string;
}
export type CoreSessionAction = (
  request: CoreSessionRequest,
  call: CoreOperationContext,
  leaf: (
    request: CoreSessionRequest,
    call: CoreOperationContext
  ) => Promise<CoreSessionActionResult>
) => Promise<CoreSessionActionResult>;
export interface CoreSessionBackend {
  describe?(call: CoreOperationContext): Promise<CoreSessionDescription>;
  composePrompt?(
    facts: CorePromptFacts,
    call: CoreOperationContext
  ): Promise<CorePromptComposition>;
  captureRequest(
    call: CoreOperationContext,
    input?: { readonly completed?: boolean }
  ): Promise<CoreRequestSnapshot | undefined>;
  inspect(call: CoreOperationContext): Promise<CoreSessionInspection>;
  messages(
    input: CoreSessionMessagesInput,
    call: CoreOperationContext
  ): Promise<CoreSessionMessages>;
  enqueue(
    request: CoreSessionRequest,
    call: CoreOperationContext,
    action: CoreSessionAction
  ): Promise<CoreSessionReceipt>;
  own(instanceId: string): () => Promise<void>;
  handled(input: CoreSubmitInput, call: CoreOperationContext, value?: unknown): CoreSessionReceipt;
}

export interface SessionInputEntry {
  /** SDK-owned admission barrier, never accepted from Extension input. */
  nativeSteer?: { readonly ready: Promise<void>; recordId?: string };
  readonly request: CoreSessionRequest;
  readonly source: CoreOperationContext;
  readonly action: CoreSessionAction;
  receipt: CoreSessionReceipt;
  readonly parentMessage?: unknown;
  readonly started: Promise<void>;
  start(): void;
  readonly terminal: Promise<void>;
  complete(): void;
}

const physicalCommits = new WeakMap<SessionInputEntry, CoreSessionActionResult>();
/** Internal writer evidence survives errors after commit, without settling the operation early. */
export function recordSessionInputCommit(
  entry: SessionInputEntry,
  outcome: CoreSessionActionResult
): void {
  const previous = physicalCommits.get(entry);
  const committed = {
    ...previous,
    ...outcome,
    changed: !!previous?.changed || outcome.changed,
    modelChanged: !!previous?.modelChanged || (outcome.modelChanged ?? outcome.changed)
  };
  physicalCommits.set(entry, committed);
  entry.receipt = {
    ...entry.receipt,
    changed: committed.changed,
    ...(committed.recordId === undefined ? {} : { recordId: committed.recordId }),
    ...(committed.executionId === undefined ? {} : { executionId: committed.executionId })
  };
}

/** One Session FIFO shared by native writes and the existing parent mailbox. No model loop. */
export class SessionInputCoordinator {
  readonly #pending: SessionInputEntry[] = [];
  readonly #records: SessionInputEntry[] = [];
  readonly #current = new AsyncLocalStorage<SessionInputEntry>();
  #sequence = 0;
  #closed = false;
  #draining: Promise<boolean> | undefined;
  readonly #settled = new Map<string, 'completed' | 'failed' | 'cancelled'>();
  constructor(readonly diagnose: (receipt: CoreSessionReceipt) => void = () => {}) {}

  get hasPending(): boolean {
    return this.#pending.length > 0;
  }
  get boundarySize(): number {
    return this.#pending.length;
  }
  get hasIdleBarrier(): boolean {
    return this.#pending.some(
      (entry) =>
        entry.receipt.status !== 'cancelled' &&
        !entry.source.signal.aborted &&
        entry.request.kind === 'submit' &&
        entry.request.input.delivery === 'idle'
    );
  }
  restoreSteer(recordId: string, text: string, source: CoreOperationContext): void {
    const index = this.#pending.findIndex((entry) => entry.nativeSteer?.recordId === recordId);
    const previous = this.#pending[index];
    if (
      previous &&
      !previous.source.signal.aborted &&
      !['cancelled', 'failed'].includes(previous.receipt.status)
    )
      return;
    const entry = this.#record(
      { kind: 'submit', input: { text } },
      source,
      (request, call, next) => next(request, call),
      'accepted'
    );
    entry.nativeSteer = { recordId, ready: Promise.resolve() };
    if (index >= 0) this.#pending[index] = entry;
    else this.#pending.unshift(entry);
  }
  get hasBoundaryPending(): boolean {
    const head = this.#pending.find(
      (entry) => entry.receipt.status !== 'cancelled' && !entry.source.signal.aborted
    );
    return !!head && (head.request.kind !== 'submit' || head.request.input.delivery !== 'idle');
  }
  get executing(): boolean {
    return this.#current.getStore()?.receipt.status === 'in-progress';
  }
  get hasBoundaryCompactPending(): boolean {
    for (const entry of this.#pending) {
      if (entry.receipt.status === 'cancelled' || entry.source.signal.aborted) continue;
      if (entry.request.kind === 'submit' && entry.request.input.delivery === 'idle') return false;
      if (entry.request.kind === 'compact') return true;
    }
    return false;
  }
  currentCompact(): CoreSessionReceipt | undefined {
    const entry = this.#current.getStore();
    return entry?.request.kind === 'compact' && entry.receipt.status === 'in-progress'
      ? Object.freeze({ ...entry.receipt })
      : undefined;
  }
  inspect(): readonly CoreSessionReceipt[] {
    return this.#records.map((entry) => Object.freeze({ ...entry.receipt }));
  }

  async performAppend(
    input: CoreAppendInput,
    call: CoreOperationContext,
    action: CoreSessionAction,
    leaf: (
      entry: SessionInputEntry,
      request: CoreSessionRequest,
      call: CoreOperationContext
    ) => Promise<CoreSessionActionResult>
  ): Promise<CoreSessionReceipt> {
    const entry = this.#record({ kind: 'append', input }, call, action, 'accepted');
    await this.#execute(entry, call, leaf);
    return Object.freeze({ ...entry.receipt });
  }

  /** SDK manual/automatic compaction shares the same active receipt as queued compaction. */
  recordCompactCommit(outcome: CoreSessionActionResult): void {
    const entry = this.#current.getStore();
    if (!entry || entry.request.kind !== 'compact')
      throw new MarAgentError(
        'MAR_AGENT_SESSION_INPUT_INVALID',
        'No active compaction owns this commit.'
      );
    recordSessionInputCommit(entry, outcome);
  }

  async performCompact(
    input: CoreCompactInput,
    call: CoreOperationContext,
    action: (commit: (outcome: CoreSessionActionResult) => void) => Promise<CoreSessionActionResult>
  ): Promise<CoreSessionActionResult> {
    const existing = this.currentCompact() ? this.#current.getStore() : undefined;
    const entry =
      existing ??
      this.accept(
        { kind: 'compact', input },
        call,
        (request, effective, next) => next(request, effective),
        'queued'
      );
    if (!existing) {
      this.#pending.splice(this.#pending.indexOf(entry), 1);
      entry.receipt = {
        ...entry.receipt,
        status: 'in-progress',
        ...(call.executionId ? { executionId: call.executionId } : {})
      };
    }
    const commit = (outcome: CoreSessionActionResult) => {
      entry.receipt = {
        ...entry.receipt,
        changed: !!entry.receipt.changed || outcome.changed,
        ...(outcome.executionId ? { executionId: outcome.executionId } : {})
      };
    };
    try {
      const outcome = await this.#current.run(entry, () => action(commit));
      if (!existing)
        this.#finish(entry, 'completed', {
          ...outcome,
          changed: !!entry.receipt.changed || outcome.changed
        });
      return outcome;
    } catch (error) {
      if (!existing)
        this.#finish(
          entry,
          call.signal.aborted ? 'cancelled' : 'failed',
          undefined,
          error instanceof MarAgentError ? error.code : 'MAR_AGENT_SESSION_INPUT_FAILED'
        );
      throw error;
    } finally {
      if (!existing) physicalCommits.delete(entry);
    }
  }

  accept(
    request: CoreSessionRequest,
    source: CoreOperationContext,
    action: CoreSessionAction,
    status: 'accepted' | 'queued',
    parentMessage?: unknown
  ): SessionInputEntry {
    const entry = this.#record(request, source, action, status, parentMessage);
    this.#pending.push(entry);
    return entry;
  }

  handled(input: CoreSubmitInput, call: CoreOperationContext, value?: unknown): CoreSessionReceipt {
    const entry = this.#record(
      { kind: 'submit', input },
      call,
      (request, effective, next) => next(request, effective),
      'accepted'
    );
    this.#finish(entry, 'handled', { changed: false });
    if (value !== undefined) entry.receipt = { ...entry.receipt, handledValue: value };
    return Object.freeze({ ...entry.receipt });
  }

  #record(
    request: CoreSessionRequest,
    source: CoreOperationContext,
    action: CoreSessionAction,
    status: 'accepted' | 'queued',
    parentMessage?: unknown
  ): SessionInputEntry {
    if (this.#closed)
      throw new MarAgentError(
        'MAR_AGENT_SESSION_INPUT_CLOSED',
        'Session input coordinator is closed.'
      );
    source.signal.throwIfAborted();
    validateCoreSessionRequest(request);
    let complete!: () => void;
    let started!: () => void;
    const entry: SessionInputEntry = {
      request: structuredClone(request),
      source,
      action,
      receipt: {
        operationId: source.operationId || randomUUID(),
        sequence: ++this.#sequence,
        kind: request.kind,
        status,
        ...(source.ownerInstanceId ? { ownerInstanceId: source.ownerInstanceId } : {}),
        ...(source.extensionId ? { extensionId: source.extensionId } : {}),
        ...(source.parentOperationId ? { parentOperationId: source.parentOperationId } : {})
      },
      ...(parentMessage === undefined ? {} : { parentMessage }),
      started: new Promise<void>((resolve) => {
        started = resolve;
      }),
      start: () => started(),
      terminal: new Promise<void>((resolve) => {
        complete = resolve;
      }),
      complete: () => {
        source.signal.removeEventListener('abort', abort);
        started();
        complete();
      }
    };
    const abort = () => {
      if (entry.receipt.status === 'queued' || entry.receipt.status === 'accepted')
        this.#finish(entry, 'cancelled');
    };
    source.signal.addEventListener('abort', abort, { once: true });
    this.#records.push(entry);
    this.#trim();
    return entry;
  }

  drain(
    leaf: (
      entry: SessionInputEntry,
      request: CoreSessionRequest,
      call: CoreOperationContext
    ) => Promise<CoreSessionActionResult>,
    execution?: {
      readonly executionId: string;
      readonly turnId: string;
      readonly signal: AbortSignal;
      /** An already authorized idle launch restores older durable input before its own prompt. */
      readonly restoring?: true;
    },
    limit = Number.POSITIVE_INFINITY
  ): Promise<boolean> {
    if (this.#draining && (!this.executing || !execution?.restoring))
      return this.executing ? Promise.resolve(false) : this.#draining;
    const drain = async () => {
      let changed = false;
      let consumed = 0;
      while (this.#pending.length && consumed++ < limit) {
        const head = this.#pending[0]!;
        // Accepted guidance is never permission to launch a new idle execution.
        if (!execution && head.nativeSteer) {
          this.#pending.shift();
          this.#finish(head, 'cancelled');
          continue;
        }
        // An idle prompt is a new Turn, not a mailbox delivery into the active Turn.
        // Preserve the single FIFO: entries behind it cannot overtake it.
        if (
          execution &&
          head.request.kind === 'submit' &&
          head.request.input.delivery === 'idle' &&
          !head.source.signal.aborted &&
          head.receipt.status !== 'cancelled'
        )
          break;
        const entry = this.#pending.shift()!;
        if (entry.receipt.status === 'cancelled' || entry.source.signal.aborted) {
          this.#finish(entry, 'cancelled');
          continue;
        }
        const { executionId: _oldExecution, turnId: _oldTurn, ...identity } = entry.source;
        const call = Object.freeze({
          ...identity,
          signal: execution
            ? AbortSignal.any([entry.source.signal, execution.signal])
            : entry.source.signal,
          ...(execution ? { executionId: execution.executionId, turnId: execution.turnId } : {})
        });
        const executing = this.#execute(entry, call, leaf);
        if (execution && entry.request.kind === 'compact' && entry.request.input.async) {
          // Keep the receipt in progress while the main loop reaches adoption checkpoints.
          void executing.catch(() => undefined);
          await Promise.race([entry.started, executing]);
          continue;
        }
        const applied = await executing;
        changed ||= applied;
      }
      return changed;
    };
    if (this.#draining) return drain();
    this.#draining = drain().finally(() => {
      this.#draining = undefined;
    });
    return this.#draining;
  }

  async #execute(
    entry: SessionInputEntry,
    call: CoreOperationContext,
    leaf: (
      entry: SessionInputEntry,
      request: CoreSessionRequest,
      call: CoreOperationContext
    ) => Promise<CoreSessionActionResult>
  ): Promise<boolean> {
    entry.receipt = {
      ...entry.receipt,
      status: 'in-progress',
      ...(call.executionId ? { executionId: call.executionId } : {})
    };
    let changed = false;
    let effects = 0;
    let committed: CoreSessionActionResult | undefined;
    try {
      if (entry.nativeSteer) {
        await entry.nativeSteer.ready;
        call.signal.throwIfAborted();
        if (!entry.nativeSteer.recordId) {
          this.#finish(entry, 'handled', { changed: false });
          return false;
        }
      }
      const outcome = await this.#current.run(entry, () =>
        entry.action(entry.request, call, async (request, effective) => {
          validateCoreSessionRequest(request);
          effective.signal.throwIfAborted();
          const returned = await leaf(entry, request, effective);
          const outcome = physicalCommits.get(entry) ?? returned;
          effects++;
          committed = { ...outcome, changed: !!committed?.changed || outcome.changed };
          changed ||= outcome.modelChanged ?? outcome.changed;
          return outcome;
        })
      );
      const physical = physicalCommits.get(entry);
      if (physical) {
        committed = physical;
        changed ||= physical.modelChanged ?? physical.changed;
      } else if (!effects) changed ||= outcome.modelChanged ?? outcome.changed;
      this.#finish(
        entry,
        (committed ?? outcome).handled && !committed?.changed
          ? 'handled'
          : effects || physical
            ? entry.request.kind === 'submit'
              ? 'committed'
              : entry.request.kind === 'append'
                ? 'committed'
                : 'completed'
            : 'handled',
        committed ?? outcome
      );
    } catch (error) {
      committed = physicalCommits.get(entry) ?? committed;
      changed ||= (committed?.modelChanged ?? committed?.changed) || !!entry.receipt.changed;
      this.#finish(
        entry,
        call.signal.aborted ? 'cancelled' : 'failed',
        committed,
        error instanceof MarAgentError ? error.code : 'MAR_AGENT_SESSION_INPUT_FAILED'
      );
      if (entry.nativeSteer?.recordId) throw error;
    } finally {
      physicalCommits.delete(entry);
    }
    return changed;
  }

  async idle(): Promise<void> {
    await this.#draining;
    await Promise.all(
      this.#records
        .filter((entry) => entry.receipt.status === 'in-progress')
        .map((entry) => entry.terminal)
    );
  }
  async retire(instanceId?: string): Promise<void> {
    if (!instanceId) this.#closed = true;
    const owned = this.#records.filter(
      (entry) => !instanceId || entry.source.ownerInstanceId === instanceId
    );
    for (const entry of owned)
      if (entry.receipt.status === 'queued' || entry.receipt.status === 'accepted')
        this.#finish(entry, 'cancelled');
    await Promise.all(
      owned.filter((entry) => entry.receipt.status === 'in-progress').map((entry) => entry.terminal)
    );
  }
  startExecution(entry: SessionInputEntry, executionId: string): void {
    entry.receipt = { ...entry.receipt, executionId };
    entry.start();
  }
  settleExecution(executionId: string, status: 'completed' | 'failed' | 'cancelled'): void {
    this.#settled.set(executionId, status);
    if (this.#settled.size > 200) this.#settled.delete(this.#settled.keys().next().value!);
    for (const entry of this.#records)
      if (
        entry.request.kind === 'submit' &&
        entry.receipt.executionId === executionId &&
        entry.receipt.status === 'committed'
      )
        entry.receipt = { ...entry.receipt, status };
    this.#trim();
  }
  #finish(
    entry: SessionInputEntry,
    status: CoreSessionOperationStatus,
    outcome?: CoreSessionActionResult,
    errorCode?: string
  ): void {
    entry.receipt = {
      ...entry.receipt,
      status,
      ...(outcome
        ? {
            changed: outcome.changed,
            ...(outcome.recordId === undefined ? {} : { recordId: outcome.recordId }),
            ...(outcome.executionId ? { executionId: outcome.executionId } : {})
          }
        : {}),
      ...(errorCode ? { errorCode } : {})
    };
    if (status === 'committed' && entry.request.kind === 'submit' && entry.receipt.executionId) {
      const settled = this.#settled.get(entry.receipt.executionId);
      if (settled) entry.receipt = { ...entry.receipt, status: settled };
    }
    entry.complete();
    if (status === 'failed') this.diagnose(Object.freeze({ ...entry.receipt }));
    this.#trim();
  }
  #trim(): void {
    while (this.#records.length > 200) {
      const index = this.#records.findIndex(
        (entry) =>
          !['queued', 'accepted', 'in-progress'].includes(entry.receipt.status) &&
          !(entry.receipt.status === 'committed' && entry.request.kind === 'submit')
      );
      if (index === -1) break;
      this.#records.splice(index, 1);
    }
  }
}

export function validateCoreSessionRequest(request: CoreSessionRequest): void {
  if (request?.kind === 'submit') captureCorePromptInput(request.input);
  if (
    !request ||
    !request.input ||
    !['append', 'submit', 'compact'].includes(request.kind) ||
    (request.kind === 'append' &&
      (typeof request.input.content !== 'string' ||
        'agentId' in request.input ||
        (request.input.delivery !== undefined &&
          request.input.delivery !== 'boundary' &&
          request.input.delivery !== 'immediate') ||
        (request.input.visibility !== undefined &&
          request.input.visibility !== 'model' &&
          request.input.visibility !== 'transcript') ||
        (request.input.textBlocks !== undefined &&
          (!Array.isArray(request.input.textBlocks) ||
            !Array.from(request.input.textBlocks).every(
              (block) => block && typeof block.text === 'string'
            ) ||
            request.input.textBlocks.map((block) => block.text).join('') !==
              request.input.content)) ||
        (request.input.attribution !== undefined &&
          typeof request.input.attribution !== 'string'))) ||
    (request.kind === 'submit' &&
      (typeof request.input.text !== 'string' ||
        (!request.input.text.trim() && request.input.modelText === undefined) ||
        (request.input.delivery !== undefined &&
          request.input.delivery !== 'boundary' &&
          request.input.delivery !== 'idle') ||
        (request.input.waitFor !== undefined &&
          request.input.waitFor !== 'admission' &&
          request.input.waitFor !== 'start' &&
          request.input.waitFor !== 'commit') ||
        (request.input.modelText !== undefined && typeof request.input.modelText !== 'string') ||
        (request.input.context !== undefined &&
          (!Array.isArray(request.input.context) ||
            !request.input.context.every((text) => typeof text === 'string'))) ||
        (request.input.provenance !== undefined && typeof request.input.provenance !== 'string') ||
        (request.input.modelAttribution !== undefined &&
          request.input.modelAttribution !== 'none'))) ||
    (request.kind === 'compact' &&
      ((request.input.focus !== undefined && typeof request.input.focus !== 'string') ||
        (request.input.async !== undefined && typeof request.input.async !== 'boolean')))
  )
    throw new MarAgentError('MAR_AGENT_SESSION_INPUT_INVALID', 'Session input is invalid.');
}
