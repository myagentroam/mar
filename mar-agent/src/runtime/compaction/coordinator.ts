import { AsyncLocalStorage } from 'node:async_hooks';
import { AgentError } from '../../error.js';

export interface CompactFlight {
  readonly id: string;
  readonly focus: string | undefined;
  readonly result: Promise<boolean>;
}

/** One generation and adoption lane, with installation released only by a safe checkpoint. */
export class CompactCoordinator {
  readonly #owner = new AsyncLocalStorage<string>();
  #flight:
    | (CompactFlight & {
        ready: Promise<void>;
        release(): void;
        controller: AbortController;
        prepared: boolean;
        settled: boolean;
        waiting: boolean;
      })
    | undefined;

  get pending(): boolean {
    return this.#flight !== undefined;
  }
  get waiting(): boolean {
    return this.#flight?.waiting === true;
  }

  assertNotReentrant(): void {
    if (this.#owner.getStore())
      throw new AgentError('MAR_AGENT_COMPACT_REENTRANT', 'Recursive compaction is not allowed.');
  }

  start(
    id: string,
    focus: string | undefined,
    run: (prepare: () => Promise<void>, signal: AbortSignal) => Promise<boolean>
  ): CompactFlight {
    this.assertNotReentrant();
    if (this.#flight) {
      if (focus !== undefined && focus !== this.#flight.focus)
        throw new AgentError(
          'MAR_AGENT_COMPACT_CONFLICT',
          'A different compaction is already active.'
        );
      return this.#flight;
    }
    let ready!: () => void;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    const flight = {
      id,
      focus,
      controller,
      prepared: false,
      settled: false,
      waiting: false,
      release,
      ready: new Promise<void>((resolve) => {
        ready = resolve;
      }),
      result: undefined as unknown as Promise<boolean>
    };
    this.#flight = flight;
    const abort = () => release();
    controller.signal.addEventListener('abort', abort, { once: true });
    flight.result = this.#owner.run(id, async () => {
      try {
        return await run(async () => {
          controller.signal.throwIfAborted();
          flight.prepared = true;
          ready();
          await gate;
          controller.signal.throwIfAborted();
        }, controller.signal);
      } finally {
        flight.settled = true;
        ready();
        controller.signal.removeEventListener('abort', abort);
      }
    });
    // The result remains observable at the next checkpoint, including asynchronous failures.
    void flight.result.catch(() => undefined);
    return flight;
  }

  async checkpoint(wait: boolean): Promise<boolean | undefined> {
    const flight = this.#flight;
    if (!flight || (!wait && !flight.prepared && !flight.settled)) return undefined;
    flight.waiting ||= wait;
    try {
      await flight.ready;
      flight.release();
      return await flight.result;
    } finally {
      if (this.#flight === flight) this.#flight = undefined;
    }
  }

  async close(reason: unknown): Promise<void> {
    const flight = this.#flight;
    if (!flight) return;
    flight.controller.abort(reason);
    await this.checkpoint(true).catch(() => undefined);
  }
}
