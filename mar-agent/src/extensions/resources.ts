import { AgentError, materializeErrorStack } from '../error.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type ExtensionDisposer = () => void | Promise<void>;
export interface ExtensionResourceRegistration {
  readonly ready: Promise<void>;
  dispose(): Promise<void>;
}

/** Own one acquisition and release without retaining its payload or former owner after disposal. */
function createResourceRegistration(
  acquire: () => ExtensionDisposer | Promise<ExtensionDisposer>,
  settled: ((failed: boolean) => void) | undefined
): ExtensionResourceRegistration {
  let release: ExtensionDisposer | undefined;
  const ready = Promise.resolve()
    .then(acquire)
    .then((disposer) => {
      if (typeof disposer !== 'function')
        throw new AgentError(
          'MAR_AGENT_EXTENSION_RESOURCE_INVALID',
          'Resource acquisition must return a disposer.'
        );
      release = disposer;
    });
  let releasing: Promise<void> | undefined;
  const disposalFrame = new AsyncLocalStorage<boolean>();
  const finish = (failed: boolean) => {
    disposalFrame.disable();
    const notify = settled;
    settled = undefined;
    notify?.(failed);
  };
  return {
    ready,
    dispose: () => {
      if (disposalFrame.getStore()) return Promise.resolve();
      releasing ??= ready
        .then(
          async () => {
            const dispose = release;
            release = undefined;
            if (dispose) await disposalFrame.run(true, dispose);
          },
          () => undefined
        )
        .then(
          () => finish(false),
          (error) => {
            materializeErrorStack(error);
            finish(true);
            throw error;
          }
        );
      return releasing;
    }
  };
}

/**
 * Own one instance's live resources and pending acquisitions, not an OS sandbox or global owner.
 * Settled handles detach; readiness and cleanup failures remain observable without retaining payloads.
 */
export class ExtensionResourceScope {
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
  readonly #resources = new Set<ExtensionResourceRegistration>();
  readonly #acquisitions = new Set<Promise<void>>();
  #acquisitionFailure: { error: unknown } | undefined;
  #cleanupFailures = 0;
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

  effect(
    acquire: () => ExtensionDisposer | Promise<ExtensionDisposer>
  ): ExtensionResourceRegistration {
    this.#assertOpen();
    const registration: ExtensionResourceRegistration = createResourceRegistration(
      acquire,
      (failed) => {
        this.#resources.delete(registration);
        if (failed) this.#cleanupFailures++;
      }
    );
    const ready = registration.ready;
    this.#acquisitions.add(ready);
    // Readiness keeps the first acquisition failure, not a history of completed registrations.
    void ready.then(
      () => {
        this.#acquisitions.delete(ready);
      },
      (error) => {
        this.#acquisitions.delete(ready);
        materializeErrorStack(error);
        this.#acquisitionFailure ??= { error };
        // A failed acquisition owns no resource, even when its caller never explicitly disposes it.
        void registration.dispose();
      }
    );
    this.#resources.add(registration);
    return registration;
  }

  async run<T>(operation: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
    if (
      this.#state !== 'ACTIVE' &&
      !(this.#state === 'STAGED' && ExtensionResourceScope.initializing)
    )
      throw new AgentError('MAR_AGENT_EXTENSION_RETIRED', 'Extension is not active.');
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
  ): ExtensionResourceRegistration {
    return this.#timer(durationMs, false, callback, onError);
  }

  every(
    durationMs: number,
    callback: (signal: AbortSignal) => void | Promise<void>,
    onError: (error: unknown) => void = () => {}
  ): ExtensionResourceRegistration {
    return this.#timer(durationMs, true, callback, onError);
  }

  async sleep(durationMs: number, parent?: AbortSignal): Promise<void> {
    if (!Number.isFinite(durationMs) || durationMs < 0)
      throw new AgentError(
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
    while (this.#acquisitions.size) await Promise.all([...this.#acquisitions]);
    if (this.#acquisitionFailure) throw this.#acquisitionFailure.error;
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
  ): ExtensionResourceRegistration {
    this.#assertOpen();
    if (!Number.isFinite(durationMs) || durationMs < 0 || (repeat && durationMs === 0))
      throw new AgentError(
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
                if (stopped || !repeat || this.#state !== 'ACTIVE') callbacks.disable();
                else schedule();
                if (!repeat)
                  // Join running before releasing the one-shot registration; never await ourselves.
                  void running!
                    .then(
                      () => registration.dispose(),
                      () => registration.dispose()
                    )
                    .catch(() => undefined);
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
      // A callback releasing itself must retain its context until running settles.
      if (!callbacks.getStore()) {
        try {
          await running;
        } finally {
          callbacks.disable();
        }
      }
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
      for (const resource of [...this.#resources].reverse()) {
        try {
          await resource.dispose();
        } catch {
          // Each registration records its failure once, including earlier manual disposal.
        }
      }
      const failures = this.#cleanupFailures;
      if (failures)
        throw new AgentError(
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
      throw new AgentError('MAR_AGENT_EXTENSION_RETIRED', 'Extension resource scope is retired.');
  }
}
