import type { CompactInput, ExecutionHandle, ExecutionResult } from '../../sdk/types.js';
import type { MarAgentEvent } from '../events.js';
import { AsyncQueue } from '../async-queue.js';
import { MarAgentError, describeMarAgentError } from '../../error.js';
import type { CompactFlight } from './coordinator.js';

/** External handles represent an operation inside its owning main Execution, not another loop. */
export class CompactRequests {
  #closed = false;
  #blocking = false;
  #join: ((input: CompactInput) => CompactFlight | undefined) | undefined;
  readonly #pending: {
    input: CompactInput;
    settle(flight: CompactFlight): void;
    fail(error: unknown): void;
    cancelled(): boolean;
  }[] = [];
  readonly #observers = new Set<(event: MarAgentEvent) => void>();
  constructor(
    readonly executionId: string,
    readonly assertAdmission: () => void
  ) {}

  request(input: CompactInput): ExecutionHandle {
    this.assertAdmission();
    if (this.#closed)
      throw new MarAgentError('MAR_AGENT_SESSION_INPUT_CLOSED', 'Execution is finishing.');
    if (
      Object.entries(input).some(
        ([key, value]) => value !== undefined && !['prompt', 'async'].includes(key)
      )
    )
      throw new MarAgentError(
        'MAR_AGENT_COMPACT_CONFLICT',
        'An active compaction uses its owning execution configuration.'
      );
    if (input.async !== undefined && typeof input.async !== 'boolean')
      throw new MarAgentError(
        'MAR_AGENT_SESSION_INPUT_INVALID',
        'Compaction async mode is invalid.'
      );
    const queue = new AsyncQueue<MarAgentEvent>();
    let resolve!: (value: ExecutionResult) => void;
    const result = new Promise<ExecutionResult>((settle) => {
      resolve = settle;
    });
    let settled = false;
    let operationId: string | undefined;
    const observe = (event: MarAgentEvent) => {
      if ('compactionId' in event && event.compactionId === operationId) queue.push(event);
    };
    this.#observers.add(observe);
    const finish = (status: ExecutionResult['status'], error?: unknown) => {
      if (settled) return;
      settled = true;
      const diagnostic =
        error === undefined ? undefined : describeMarAgentError(error, 'MAR_AGENT_COMPACT_FAILED');
      resolve({
        executionId: this.executionId,
        status,
        finalAnswer: '',
        ...(diagnostic ? { errorCode: diagnostic.code, errorMessage: diagnostic.message } : {})
      });
      this.#observers.delete(observe);
      queue.close();
    };
    const pending = {
      input: { ...input },
      cancelled: () => settled,
      settle: (flight: CompactFlight) => {
        operationId = flight.id;
        void flight.result.then(
          (changed) =>
            finish(
              changed ? 'completed' : 'failed',
              changed
                ? undefined
                : new MarAgentError('MAR_AGENT_CONTEXT_LIMIT', 'No history can be compacted.')
            ),
          (error) => finish('failed', error)
        );
      },
      fail: (error: unknown) => finish('failed', error)
    };
    try {
      const flight = this.#join?.(input);
      if (flight) {
        pending.settle(flight);
        this.#blocking ||= input.async !== true;
      } else this.#pending.push(pending);
    } catch (error) {
      pending.fail(error);
    }
    return {
      executionId: this.executionId,
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
      result: () => {
        queue.discardIfUnobserved();
        return result;
      },
      cancel: () => finish('cancelled')
    };
  }

  publish(event: MarAgentEvent): void {
    for (const observer of this.#observers) observer(event);
  }

  bind(join: (input: CompactInput) => CompactFlight | undefined): void {
    this.#join = join;
  }

  drain(start: (input: CompactInput) => CompactFlight): boolean {
    let blocking = this.#blocking;
    this.#blocking = false;
    for (const pending of this.#pending.splice(0)) {
      if (pending.cancelled()) continue;
      try {
        pending.settle(start(pending.input));
        blocking ||= pending.input.async !== true;
      } catch (error) {
        pending.fail(error);
      }
    }
    return blocking;
  }

  seal(): void {
    this.#closed = true;
  }
  close(error: unknown): void {
    this.seal();
    for (const pending of this.#pending.splice(0)) pending.fail(error);
  }
}
