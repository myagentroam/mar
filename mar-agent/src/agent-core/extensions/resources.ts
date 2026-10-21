import { MarAgentError } from '../error.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type CoreDisposer = () => void | Promise<void>;
export interface CoreResourceRegistration {
  readonly ready: Promise<void>;
  dispose(): Promise<void>;
}
export interface CoreResourceScope {
  effect(acquire: () => CoreDisposer | Promise<CoreDisposer>): CoreResourceRegistration;
}

/** An instance's managed resources, not an OS sandbox or a process-wide resource owner. */
export class ExtensionResourceScope implements CoreResourceScope {
  readonly instanceId = randomUUID();
  static readonly #initialization = new AsyncLocalStorage<{ active: boolean }>();

  static get initializing(): boolean {
    return this.#initialization.getStore()?.active === true;
  }

  static async initialize<T>(run: () => Promise<T>): Promise<T> {
    const frame = { active: true };
    return this.#initialization.run(frame, async () => {
      try {
        return await run();
      } finally {
        frame.active = false;
      }
    });
  }
  #state: 'STAGED' | 'ACTIVE' | 'RETIRING' | 'DISPOSED' = 'STAGED';
  readonly #controller = new AbortController();
  readonly #resources: CoreResourceRegistration[] = [];
  readonly #operations = new Set<Promise<unknown>>();
  readonly #activators = new Set<() => void>();
  #disposal: Promise<void> | undefined;

  get state() {
    return this.#state;
  }
  get signal() {
    return this.#controller.signal;
  }

  activate(): void {
    this.#assertOpen();
    if (this.#state === 'ACTIVE') return;
    this.#state = 'ACTIVE';
    for (const activate of this.#activators) activate();
    this.#activators.clear();
  }

  effect(acquire: () => CoreDisposer | Promise<CoreDisposer>): CoreResourceRegistration {
    this.#assertOpen();
    const acquired = Promise.resolve()
      .then(acquire)
      .then((release) => {
        if (typeof release !== 'function')
          throw new MarAgentError(
            'MAR_AGENT_EXTENSION_RESOURCE_INVALID',
            'Resource acquisition must return a disposer.'
          );
        return release;
      });
    let releasing: Promise<void> | undefined;
    const disposalFrame = new AsyncLocalStorage<boolean>();
    const registration: CoreResourceRegistration = {
      ready: acquired.then(() => undefined),
      dispose: () => {
        if (disposalFrame.getStore()) return Promise.resolve();
        releasing ??= acquired.then(
          async (release) => {
            if (typeof release !== 'function')
              throw new MarAgentError(
                'MAR_AGENT_EXTENSION_RESOURCE_INVALID',
                'Resource acquisition must return a disposer.'
              );
            await disposalFrame.run(true, release);
          },
          () => undefined
        );
        return releasing;
      }
    };
    // Acquisition errors remain observable through ready, without unhandled rejection noise.
    void registration.ready.catch(() => undefined);
    this.#resources.push(registration);
    return registration;
  }

  async run<T>(operation: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
    if (
      this.#state !== 'ACTIVE' &&
      !(this.#state === 'STAGED' && ExtensionResourceScope.initializing)
    )
      throw new MarAgentError('MAR_AGENT_EXTENSION_RETIRED', 'Extension is not active.');
    const signal = parent ? AbortSignal.any([this.signal, parent]) : this.signal;
    signal.throwIfAborted();
    const running = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation(signal);
    });
    this.#operations.add(running);
    try {
      const result = await running;
      signal.throwIfAborted();
      return result;
    } finally {
      this.#operations.delete(running);
    }
  }

  after(
    durationMs: number,
    callback: (signal: AbortSignal) => void | Promise<void>,
    onError: (error: unknown) => void = () => {}
  ): CoreResourceRegistration {
    return this.#timer(durationMs, false, callback, onError);
  }

  every(
    durationMs: number,
    callback: (signal: AbortSignal) => void | Promise<void>,
    onError: (error: unknown) => void = () => {}
  ): CoreResourceRegistration {
    return this.#timer(durationMs, true, callback, onError);
  }

  async sleep(durationMs: number, parent?: AbortSignal): Promise<void> {
    if (!Number.isFinite(durationMs) || durationMs < 0)
      throw new MarAgentError(
        'MAR_AGENT_EXTENSION_TIMER_INVALID',
        'Sleep duration must be finite and non-negative.'
      );
    return this.run(async (signal) => {
      const deadline = performance.now() + durationMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort!: () => void;
      try {
        await new Promise<void>((resolve, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          const schedule = () => {
            const remaining = deadline - performance.now();
            if (remaining <= 0) {
              resolve();
              return;
            }
            timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
          };
          schedule();
        });
      } finally {
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    }, parent);
  }

  /** Wait for acquisitions added by setup before publishing any callbacks. */
  async ready(): Promise<void> {
    let count = -1;
    while (count !== this.#resources.length) {
      count = this.#resources.length;
      await Promise.all(this.#resources.map((resource) => resource.ready));
    }
  }

  retire(): void {
    if (this.#state === 'DISPOSED') return;
    this.#state = 'RETIRING';
    this.#controller.abort();
    this.#activators.clear();
  }

  #timer(
    durationMs: number,
    repeat: boolean,
    callback: (signal: AbortSignal) => void | Promise<void>,
    onError: (error: unknown) => void
  ): CoreResourceRegistration {
    this.#assertOpen();
    if (!Number.isFinite(durationMs) || durationMs < 0 || (repeat && durationMs === 0))
      throw new MarAgentError(
        'MAR_AGENT_EXTENSION_TIMER_INVALID',
        'Timer duration must be finite and non-negative; repeating timers must be positive.'
      );
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timerController = new AbortController();
    const callbacks = new AsyncLocalStorage<boolean>();
    let running: Promise<void> | undefined;
    const schedule = () => {
      if (stopped || this.#state !== 'ACTIVE') return;
      const due = performance.now() + durationMs;
      const arm = () => {
        timer = setTimeout(
          () => {
            timer = undefined;
            if (stopped || this.#state !== 'ACTIVE') return;
            if (performance.now() < due) {
              arm();
              return;
            }
            running = this.run(async (signal) => {
              await callbacks.run(true, () => callback(signal));
            }, timerController.signal)
              .catch((error: unknown) => {
                if (!this.signal.aborted && !timerController.signal.aborted) onError(error);
              })
              .finally(() => {
                if (repeat) schedule();
              });
            void running.catch(() => undefined);
          },
          Math.min(Math.max(0, due - performance.now()), 2_147_483_647)
        );
        timer.unref?.();
      };
      arm();
    };
    const registration = this.effect(() => async () => {
      stopped = true;
      this.#activators.delete(schedule);
      if (timer !== undefined) clearTimeout(timer);
      timerController.abort();
      if (!callbacks.getStore()) await running;
    });
    if (this.#state === 'ACTIVE') schedule();
    else this.#activators.add(schedule);
    return registration;
  }

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.retire();
    this.#disposal = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.#operations]);
      let failures = 0;
      for (const resource of [...this.#resources].reverse()) {
        try {
          await resource.dispose();
        } catch {
          failures++;
        }
      }
      if (failures)
        throw new MarAgentError(
          'MAR_AGENT_EXTENSION_CLEANUP_FAILED',
          'Extension resource cleanup failed.',
          { details: { failures } }
        );
      this.#state = 'DISPOSED';
    });
    return this.#disposal;
  }

  #assertOpen(): void {
    if (this.#state === 'RETIRING' || this.#state === 'DISPOSED')
      throw new MarAgentError(
        'MAR_AGENT_EXTENSION_RETIRED',
        'Extension resource scope is retired.'
      );
  }
}
