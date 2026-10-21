import { MarAgentError } from '../../error.js';
import type { ModelEvent, ModelRequest, ModelTurnSession } from '../../model/contracts.js';
import { countModelTokens } from '../token-budget.js';
import type { CoreCompactDiagnostic } from '../../extensions/compaction.js';

const COMPACTION_TIMEOUT_MS = 600_000;
const COMPACTION_PROGRESS_INTERVAL_MS = 30_000;

export interface CompactionProgress {
  state: 'STARTED' | 'PROGRESS' | 'FINISHED';
  elapsedMs: number;
  inputTokensEstimate: number;
  modelRequests: number;
  eventCounts: Partial<Record<ModelEvent['type'], number>>;
  textDeltaCharacters: number;
  firstOutputAfterMs?: number;
  lastOutputAfterMs?: number;
  timedOut: boolean;
  extension?: CoreCompactDiagnostic;
  extensionOutcome?: 'HANDLED' | 'DECLINED' | 'INVALID_RESULT' | 'FAILED';
}

/** One deadline spans all model attempts and recovery waits for a single compaction. */
export class CompactionOperation {
  readonly #controller = new AbortController();
  readonly signal: AbortSignal;
  readonly #startedAt = Date.now();
  readonly #deadline: ReturnType<typeof setTimeout>;
  readonly #progressTimer: ReturnType<typeof setInterval>;
  #closed = false;
  #tail = Promise.resolve();
  #inputTokensEstimate = 0;
  #modelRequests = 0;
  #eventCounts: CompactionProgress['eventCounts'] = {};
  #textDeltaCharacters = 0;
  #firstOutputAfterMs: number | undefined;
  #lastOutputAfterMs: number | undefined;
  #extension: CoreCompactDiagnostic | undefined;
  #extensionOutcome: CompactionProgress['extensionOutcome'];

  constructor(
    parent: AbortSignal,
    private readonly record: (progress: CompactionProgress) => void | Promise<void>
  ) {
    this.signal = AbortSignal.any([parent, this.#controller.signal]);
    this.#deadline = setTimeout(
      () =>
        this.#controller.abort(
          new MarAgentError(
            'MAR_AGENT_MODEL_TIMEOUT',
            'Compaction exceeded its total time limit; the previous context was retained.',
            { details: { reason: 'COMPACTION_DEADLINE_EXCEEDED' } }
          )
        ),
      COMPACTION_TIMEOUT_MS
    );
    this.#deadline.unref();
    this.#progressTimer = setInterval(() => {
      void this.report('PROGRESS');
    }, COMPACTION_PROGRESS_INTERVAL_MS);
    this.#progressTimer.unref();
  }

  async *start(
    model: Pick<ModelTurnSession, 'start'>,
    request: ModelRequest
  ): AsyncIterable<ModelEvent> {
    this.signal.throwIfAborted();
    this.#modelRequests++;
    this.#inputTokensEstimate =
      countModelTokens(request.system) +
      request.messages.reduce((sum, message) => sum + countModelTokens(message.content), 0);
    await this.report(this.#modelRequests === 1 ? 'STARTED' : 'PROGRESS');
    let completed = false;
    try {
      for await (const event of model.start(request, this.signal)) {
        this.signal.throwIfAborted();
        this.#eventCounts[event.type] = (this.#eventCounts[event.type] ?? 0) + 1;
        if (event.type === 'completed') completed = event.reason === 'completed';
        if (event.type === 'text.delta') this.#textDeltaCharacters += event.delta.length;
        if (
          (event.type === 'text.delta' && event.delta.length > 0) ||
          ((event.type === 'text.completed' || event.type === 'reasoning.summary') &&
            event.text.length > 0)
        ) {
          this.#lastOutputAfterMs = Math.max(0, Date.now() - this.#startedAt);
          this.#firstOutputAfterMs ??= this.#lastOutputAfterMs;
        }
        yield event;
      }
      this.signal.throwIfAborted();
      if (!completed)
        throw new MarAgentError(
          'MAR_AGENT_COMPACT_FAILED',
          'Compaction did not return a complete response.'
        );
    } catch (error) {
      this.signal.throwIfAborted();
      throw error;
    }
  }

  /** External generation shares this operation's deadline, including the default fallback. */
  async generate<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => run(this.signal)),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(this.signal.reason);
          this.signal.addEventListener('abort', abort, { once: true });
          if (this.signal.aborted) abort();
        })
      ]);
    } finally {
      if (abort) this.signal.removeEventListener('abort', abort);
    }
  }

  async observeExtension(diagnostic: CoreCompactDiagnostic): Promise<void> {
    if (this.#closed || this.signal.aborted) return;
    if (diagnostic.modelRequests < (this.#extension?.modelRequests ?? 0)) return;
    this.#extension = { ...diagnostic };
    await this.report('PROGRESS');
  }

  async finishExtension(
    outcome: NonNullable<CompactionProgress['extensionOutcome']>
  ): Promise<void> {
    if (this.#closed) return;
    this.#extensionOutcome = outcome;
    await this.report('PROGRESS');
  }

  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#deadline);
    clearInterval(this.#progressTimer);
    await this.report('FINISHED');
  }

  private report(state: CompactionProgress['state']): Promise<void> {
    const progress: CompactionProgress = {
      state,
      elapsedMs: Math.max(0, Date.now() - this.#startedAt),
      inputTokensEstimate: this.#modelRequests
        ? this.#inputTokensEstimate
        : (this.#extension?.inputTokensEstimateAfter ?? this.#inputTokensEstimate),
      modelRequests: this.#modelRequests + (this.#extension?.modelRequests ?? 0),
      ...(this.#extension ? { extension: { ...this.#extension } } : {}),
      ...(this.#extensionOutcome ? { extensionOutcome: this.#extensionOutcome } : {}),
      eventCounts: { ...this.#eventCounts },
      textDeltaCharacters: this.#textDeltaCharacters,
      ...(this.#firstOutputAfterMs === undefined
        ? {}
        : { firstOutputAfterMs: this.#firstOutputAfterMs }),
      ...(this.#lastOutputAfterMs === undefined
        ? {}
        : { lastOutputAfterMs: this.#lastOutputAfterMs }),
      timedOut: this.#controller.signal.aborted
    };
    this.#tail = this.#tail.then(() => this.record(progress)).catch(() => undefined);
    return this.#tail;
  }
}
