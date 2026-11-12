import { createUuid } from '../util/uuid.js';
import type { PromptCompletionResponse } from '@myagentroam/protocol';
import type { ConversationTurn } from '../model/workbench.js';

export interface CompletionDraft {
  readonly text: string;
  readonly cursor: number;
}
export type CompletionTrigger = 'MANUAL' | 'AUTO';
export type CompletionAutomaticReason = 'ENTER' | 'REPLY' | 'TURN_END' | 'FOCUS';
interface CompletionCandidate {
  readonly kind: 'ready';
  readonly id: string;
  readonly draft: CompletionDraft;
  readonly suggestion: string;
  readonly expiresAt: number;
}
export type CompletionState =
  | { readonly kind: 'idle'; readonly notice?: 'empty' }
  | { readonly kind: 'pending'; readonly id: string; readonly previous?: CompletionCandidate }
  | CompletionCandidate;

export interface PromptCompletionOptions {
  readonly readDraft: () => CompletionDraft | undefined;
  readonly canRequest?: () => boolean;
  readonly canAutomaticRequest?: (reason: CompletionAutomaticReason) => boolean;
  readonly readContextRevision?: () => string;
  readonly request: (
    draft: CompletionDraft,
    signal: AbortSignal,
    trigger: CompletionTrigger
  ) => Promise<PromptCompletionResponse>;
  readonly apply: (draft: CompletionDraft, insertion: string) => boolean;
  readonly changed: () => void;
  readonly feedback: (reason: string, error?: unknown) => void;
  readonly now?: () => number;
}

/** Owns prediction intents and automatic scheduling; DOM and authorization remain with their owners. */
export class PromptCompletionService {
  state: CompletionState = { kind: 'idle' };
  private controller: AbortController | undefined;
  private gesture:
    | {
        readonly deadline: number;
        readonly draft: CompletionDraft;
        readonly timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private automaticTimer: ReturnType<typeof setTimeout> | undefined;
  private automaticKey: string | undefined;
  private automaticTerminalKey: string | undefined;
  private automaticPending: CompletionAutomaticReason | undefined;
  // A higher-priority event becoming stale must not consume a coalesced focus check.
  private focusPending = false;
  private entryDeadline: number | undefined;
  private requestCoverage: string | undefined;
  private lastRequestAt = -Infinity;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly options: PromptCompletionOptions) {
    this.now = options.now ?? Date.now;
  }

  get armed(): boolean {
    return this.gesture !== undefined;
  }

  get preview(): CompletionCandidate | undefined {
    const candidate =
      this.state.kind === 'ready'
        ? this.state
        : this.state.kind === 'pending'
          ? this.state.previous
          : undefined;
    return candidate && candidate.expiresAt > this.now() ? candidate : undefined;
  }

  tab(repeat = false): boolean {
    if (this.disposed || repeat) return true;
    if (this.state.kind === 'pending') {
      this.cancel();
      return true;
    }
    const draft = this.options.readDraft();
    if (!draft) return true;
    if (this.state.kind === 'ready') {
      this.accept();
      return true;
    }
    const gesture = this.gesture;
    this.clearGesture();
    if (gesture && sameDraft(draft, gesture.draft) && this.now() <= gesture.deadline) {
      void this.request();
      return true;
    }
    const timer = setTimeout(() => {
      if (this.gesture?.timer !== timer) return;
      this.clearGesture();
      this.scheduleAutomatic();
      this.options.changed();
    }, 300);
    this.gesture = { deadline: this.now() + 300, draft, timer };
    this.options.changed();
    return true;
  }

  automaticSignal(key: string, reason: 'REPLY' | 'TURN_END' = 'REPLY'): void {
    const observed = reason === 'TURN_END' ? this.automaticTerminalKey : this.automaticKey;
    if (this.disposed || key === observed) return;
    if (reason === 'TURN_END') this.automaticTerminalKey = key;
    else this.automaticKey = key;
    if (!key) {
      if (
        (reason === 'TURN_END' && this.automaticPending === 'TURN_END') ||
        (reason === 'REPLY' && this.automaticPending === 'REPLY')
      )
        this.automaticPending = this.focusPending ? 'FOCUS' : undefined;
    } else if (
      this.options.readDraft()?.text === '' &&
      (reason === 'TURN_END' || this.canRequest('AUTO', reason))
    ) {
      this.queueAutomatic(reason);
    }
    this.scheduleAutomatic();
  }

  automaticBaseline(key?: string, terminalKey?: string): void {
    this.automaticKey = key;
    this.automaticTerminalKey = terminalKey;
    this.requestCoverage = undefined;
    this.automaticPending = undefined;
    this.focusPending = false;
    if (this.automaticTimer !== undefined) clearTimeout(this.automaticTimer);
    this.automaticTimer = undefined;
    if (this.entryDeadline !== undefined) {
      this.queueAutomatic('ENTER');
      this.scheduleAutomatic();
    }
  }

  automaticEnter(): void {
    if (this.disposed) return;
    this.lastRequestAt = -Infinity;
    this.entryDeadline = this.now() + 1000;
    this.queueAutomatic('ENTER');
    this.scheduleAutomatic();
  }

  automaticFocus(): void {
    if (
      this.disposed ||
      this.automaticKey === undefined ||
      this.options.readDraft()?.text !== '' ||
      !this.canRequest('AUTO', 'FOCUS') ||
      ((this.state.kind === 'pending' || this.preview) && this.requestCoverage === this.coverage())
    )
      return;
    this.focusPending = true;
    this.queueAutomatic('FOCUS');
    this.scheduleAutomatic();
  }

  automaticBlur(): void {
    this.focusPending = false;
    if (this.automaticPending !== 'TURN_END' && this.automaticPending !== 'ENTER')
      this.automaticPending = undefined;
    if (!this.automaticPending && this.automaticTimer !== undefined) {
      clearTimeout(this.automaticTimer);
      this.automaticTimer = undefined;
    }
  }

  private coverage(): string {
    return JSON.stringify([
      this.automaticKey,
      this.automaticTerminalKey,
      this.options.readContextRevision?.()
    ]);
  }

  private queueAutomatic(reason: CompletionAutomaticReason): void {
    if (this.entryDeadline !== undefined) this.automaticPending = 'ENTER';
    else if (reason === 'TURN_END' || this.automaticPending === 'TURN_END')
      this.automaticPending = 'TURN_END';
    else if (reason === 'REPLY' || this.automaticPending === 'REPLY')
      this.automaticPending = 'REPLY';
    else this.automaticPending = 'FOCUS';
  }

  wakeAutomatic(): void {
    this.scheduleAutomatic();
  }

  private scheduleAutomatic(): void {
    if (
      this.automaticTimer !== undefined ||
      !this.automaticPending ||
      this.disposed ||
      this.armed ||
      this.state.kind === 'pending'
    )
      return;
    const delay =
      this.entryDeadline === undefined
        ? Math.max(750, this.lastRequestAt + 15_000 - this.now())
        : Math.max(0, this.entryDeadline - this.now());
    this.automaticTimer = setTimeout(() => {
      this.automaticTimer = undefined;
      if (this.armed) return;
      const reason = this.automaticPending;
      if (!reason) return;
      // Entry and ending intents survive missing focus/readiness; replies are not replayed.
      if (!this.canRequest('AUTO', reason)) {
        if (reason !== 'TURN_END' && reason !== 'ENTER') {
          this.automaticPending = undefined;
          this.focusPending = false;
        }
        return;
      }
      this.automaticPending = undefined;
      this.focusPending = false;
      this.entryDeadline = undefined;
      if (
        (reason === 'FOCUS' || reason === 'ENTER') &&
        this.preview &&
        this.requestCoverage === this.coverage()
      )
        return;
      if (this.options.readDraft()?.text === '' && this.state.kind !== 'pending')
        void this.request('AUTO', reason);
    }, delay);
  }

  private canRequest(trigger: CompletionTrigger, reason: CompletionAutomaticReason): boolean {
    return trigger === 'AUTO' && this.options.canAutomaticRequest
      ? this.options.canAutomaticRequest(reason)
      : this.options.canRequest?.() !== false;
  }

  async request(
    trigger: CompletionTrigger = 'MANUAL',
    reason: CompletionAutomaticReason = 'REPLY'
  ): Promise<void> {
    if (this.disposed || !this.canRequest(trigger, reason)) return;
    const draft = this.options.readDraft();
    if (!draft || this.state.kind === 'pending') return;
    const previous = trigger === 'AUTO' ? this.preview : undefined;
    this.clearState();
    this.requestCoverage = this.coverage();
    this.lastRequestAt = this.now();
    const controller = new AbortController();
    this.controller = controller;
    const id = createUuid();
    this.state = { kind: 'pending', id, ...(previous ? { previous } : {}) };
    if (previous) this.expireCandidate(previous);
    this.options.changed();
    try {
      const result = await this.options.request(draft, controller.signal, trigger);
      if (!this.current(controller, draft)) return;
      if (result.status === 'ready' && result.expiresAt > this.now()) {
        this.state = {
          kind: 'ready',
          id,
          draft,
          suggestion: result.suggestion,
          expiresAt: result.expiresAt
        };
        this.expireCandidate(this.state);
      } else {
        const showEmpty = trigger === 'MANUAL' && result.status === 'empty';
        this.state = showEmpty ? { kind: 'idle', notice: 'empty' } : { kind: 'idle' };
        if (this.expiry !== undefined) clearTimeout(this.expiry);
        this.expiry = undefined;
        if (showEmpty)
          this.expiry = setTimeout(() => {
            this.expiry = undefined;
            if (this.state.kind === 'idle' && this.state.notice === 'empty') {
              this.state = { kind: 'idle' };
              this.options.changed();
            }
          }, 3_000);
        else if (
          trigger === 'MANUAL' &&
          result.status === 'skipped' &&
          result.reason !== 'STALE_CONTEXT'
        )
          this.options.feedback(result.reason);
      }
    } catch (error) {
      if (!this.current(controller, draft)) return;
      this.state = { kind: 'idle' };
      if (error instanceof Error && error.name === 'AbortError') return;
      if (trigger === 'MANUAL') this.options.feedback('PROMPT_COMPLETION_FAILED', error);
    } finally {
      if (this.controller === controller) {
        this.controller = undefined;
        this.scheduleAutomatic();
      }
      this.options.changed();
    }
  }

  accept(): boolean {
    const state = this.state;
    if (state.kind !== 'ready') return false;
    const valid = state.expiresAt > this.now() && sameDraft(this.options.readDraft(), state.draft);
    // Remove the preview before the editing transaction emits native input/selection events.
    this.cancel();
    if (!valid) return false;
    const applied = this.options.apply(state.draft, state.suggestion);
    if (!applied) this.options.feedback('PROMPT_COMPLETION_INSERT_UNSUPPORTED');
    return applied;
  }

  cancel(): boolean {
    const active = this.state.kind !== 'idle' || this.armed;
    const hadNotice = this.state.kind === 'idle' && this.state.notice !== undefined;
    this.clearState();
    if (active || hadNotice) this.options.changed();
    return active;
  }

  private clearState(): void {
    this.clearGesture();
    if (this.automaticTimer !== undefined) clearTimeout(this.automaticTimer);
    this.automaticTimer = undefined;
    this.automaticPending = undefined;
    this.focusPending = false;
    this.entryDeadline = undefined;
    if (this.expiry !== undefined) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.controller?.abort();
    this.controller = undefined;
    this.state = { kind: 'idle' };
  }

  private expireCandidate(candidate: CompletionCandidate): void {
    if (this.expiry !== undefined) clearTimeout(this.expiry);
    this.expiry = setTimeout(
      () => {
        this.expiry = undefined;
        if (this.state.kind === 'ready' && this.state.id === candidate.id)
          this.state = { kind: 'idle' };
        else if (this.state.kind === 'pending' && this.state.previous?.id === candidate.id)
          this.state = { kind: 'pending', id: this.state.id };
        this.options.changed();
      },
      Math.max(0, candidate.expiresAt - this.now())
    );
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  private current(controller: AbortController, draft: CompletionDraft): boolean {
    if (this.disposed || controller.signal.aborted || this.controller !== controller) return false;
    if (!sameDraft(this.options.readDraft(), draft)) {
      this.cancel();
      return false;
    }
    return true;
  }

  private clearGesture(): void {
    if (this.gesture) clearTimeout(this.gesture.timer);
    this.gesture = undefined;
  }
}

function sameDraft(left: CompletionDraft | undefined, right: CompletionDraft): boolean {
  return left?.text === right.text;
}

/** Only public assistant progress and terminal transitions can signal automatic prediction. */
export function promptCompletionAutomaticKey(turns: readonly ConversationTurn[]): string {
  const turn = turns.at(-1);
  if (!turn) return '';
  let assistant: { id: string; text: string } | undefined;
  for (const item of [...turn.items].reverse()) {
    const payload = item.payload;
    if (
      item.kind === 'assistant_message' &&
      typeof payload === 'object' &&
      payload !== null &&
      'text' in payload &&
      typeof payload.text === 'string' &&
      payload.text.trim()
    ) {
      assistant = { id: item.id, text: payload.text };
      break;
    }
  }
  const terminal = promptCompletionAutomaticTerminalKey(turns) !== '';
  if (!assistant && !terminal) return '';
  return JSON.stringify([turn.id, terminal ? turn.status : null, assistant?.id, assistant?.text]);
}

/** A terminal version does not change when final reply text arrives late. */
export function promptCompletionAutomaticTerminalKey(turns: readonly ConversationTurn[]): string {
  const turn = turns.at(-1);
  return turn && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'LOST'].includes(turn.status)
    ? JSON.stringify([turn.id, turn.status])
    : '';
}
