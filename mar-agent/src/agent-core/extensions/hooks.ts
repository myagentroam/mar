import { AsyncLocalStorage } from 'node:async_hooks';
import type { CoreCallbackRunner, CoreOperationContext } from './operation.js';
import type { CoreResourceRegistration } from './resources.js';
import { ExtensionResourceScope } from './resources.js';

export interface CoreHookOptions {
  readonly reentry?: 'skip-active' | 'allow';
}
export interface CoreHookDiagnostic {
  readonly code: 'MAR_AGENT_EXTENSION_OBSERVER_FAILED';
  readonly operationId: string;
}
export type CoreInterceptor<Input, Output> = (
  input: Input,
  call: CoreOperationContext,
  next: (input: Input) => Promise<Output>
) => Output | Promise<Output>;

interface Interception {
  readonly owner: ExtensionResourceScope;
  readonly handler: CoreInterceptor<unknown, unknown>;
  readonly reentry: 'skip-active' | 'allow';
}
interface Observation {
  readonly owner: ExtensionResourceScope;
  readonly reentry: 'skip-active' | 'allow';
  readonly handler: (fact: unknown, call: CoreOperationContext) => void | Promise<void>;
}

/** Typed domain chains with per-dispatch snapshots and async-ancestor reentry tracking. */
export class ExtensionHooks<
  Operations extends { [Key in keyof Operations]: { input: unknown; output: unknown } },
  Facts extends object
> {
  readonly #interceptors = new Map<keyof Operations, Interception[]>();
  readonly #observers = new Map<keyof Facts, Observation[]>();
  readonly #active = new AsyncLocalStorage<
    readonly { entry: Interception | Observation; active: boolean }[]
  >();

  constructor(
    readonly diagnose: (diagnostic: CoreHookDiagnostic) => void = () => {},
    readonly callback: CoreCallbackRunner = async (call, run) => run(call)
  ) {}

  /** Internal physical callback ingress; unrelated dispatch must not inherit reentry suppression. */
  independent<Value>(run: () => Value): Value {
    return this.#active.run([], run);
  }

  /** Avoid materializing public views when no active interceptor can consume them. */
  hasInterceptors(key: keyof Operations): boolean {
    return this.#interceptors.get(key)?.some((entry) => entry.owner.state === 'ACTIVE') ?? false;
  }

  intercept<Key extends keyof Operations>(
    owner: ExtensionResourceScope,
    key: Key,
    handler: CoreInterceptor<Operations[Key]['input'], Operations[Key]['output']>,
    options: CoreHookOptions = {}
  ): CoreResourceRegistration {
    const entry: Interception = {
      owner,
      handler: handler as CoreInterceptor<unknown, unknown>,
      reentry: options.reentry ?? 'skip-active'
    };
    const entries = this.#interceptors.get(key) ?? [];
    const registration = owner.effect(() => () => {
      const index = entries.indexOf(entry);
      if (index !== -1) entries.splice(index, 1);
    });
    entries.push(entry);
    this.#interceptors.set(key, entries);
    return registration;
  }

  observe<Key extends keyof Facts>(
    owner: ExtensionResourceScope,
    key: Key,
    handler: (fact: Facts[Key], call: CoreOperationContext) => void | Promise<void>,
    options: CoreHookOptions = {}
  ): CoreResourceRegistration {
    const entry: Observation = {
      owner,
      handler: handler as Observation['handler'],
      reentry: options.reentry ?? 'skip-active'
    };
    const entries = this.#observers.get(key) ?? [];
    const registration = owner.effect(() => () => {
      const index = entries.indexOf(entry);
      if (index !== -1) entries.splice(index, 1);
    });
    entries.push(entry);
    this.#observers.set(key, entries);
    return registration;
  }

  async invoke<Key extends keyof Operations>(
    key: Key,
    input: Operations[Key]['input'],
    call: CoreOperationContext,
    leaf: (
      input: Operations[Key]['input'],
      call: CoreOperationContext
    ) => Promise<Operations[Key]['output']>
  ): Promise<Operations[Key]['output']> {
    call.signal.throwIfAborted();
    const snapshot = [...(this.#interceptors.get(key) ?? [])].filter(
      (entry) => entry.owner.state === 'ACTIVE'
    );
    const dispatch = async (
      index: number,
      value: unknown,
      signal: AbortSignal
    ): Promise<unknown> => {
      signal.throwIfAborted();
      const entry = snapshot[index];
      if (!entry)
        return leaf(value as Operations[Key]['input'], Object.freeze({ ...call, signal }));
      const ancestors = this.#active.getStore() ?? [];
      if (
        entry.reentry === 'skip-active' &&
        ancestors.some((frame) => frame.active && frame.entry === entry)
      )
        return dispatch(index + 1, value, signal);
      return entry.owner.run(async (signal) => {
        const frame = { entry, active: true };
        return this.#active.run([...ancestors, frame], async () => {
          const controller = new AbortController();
          const effectiveSignal = AbortSignal.any([signal, controller.signal]);
          const pending = new Set<Promise<void>>();
          try {
            return await this.callback(
              Object.freeze({ ...call, signal: effectiveSignal }),
              (effective) =>
                entry.handler(value, effective, (nextValue) => {
                  const result = dispatch(index + 1, nextValue, effective.signal);
                  const settled = result.then(
                    () => undefined,
                    () => undefined
                  );
                  pending.add(settled);
                  void settled.then(() => pending.delete(settled));
                  return result;
                })
            );
          } catch (error) {
            controller.abort();
            throw error;
          } finally {
            while (pending.size) await Promise.all([...pending]);
            frame.active = false;
          }
        });
      }, signal);
    };
    return (await dispatch(0, input, call.signal)) as Operations[Key]['output'];
  }

  hasObservers<Key extends keyof Facts>(key: Key): boolean {
    return (this.#observers.get(key) ?? []).some((entry) => entry.owner.state === 'ACTIVE');
  }

  async emit<Key extends keyof Facts>(
    key: Key,
    fact: Facts[Key],
    call: CoreOperationContext,
    settled = false
  ): Promise<void> {
    const snapshot = [...(this.#observers.get(key) ?? [])].filter(
      (entry) => entry.owner.state === 'ACTIVE'
    );
    for (const entry of snapshot) {
      if (!settled) call.signal.throwIfAborted();
      const ancestors = this.#active.getStore() ?? [];
      if (
        entry.reentry === 'skip-active' &&
        ancestors.some((frame) => frame.active && frame.entry === entry)
      )
        continue;
      try {
        // Each observer gets its own copy, never writable authoritative state or another observer's view.
        await entry.owner.run(
          async (signal) => {
            const frame = { entry, active: true };
            await this.#active.run([...ancestors, frame], async () => {
              try {
                await this.callback(
                  Object.freeze({ ...call, signal: AbortSignal.any([signal, call.signal]) }),
                  (effective) => entry.handler(structuredClone(fact), effective),
                  settled
                );
              } finally {
                frame.active = false;
              }
            });
          },
          settled ? undefined : call.signal
        );
      } catch {
        if (!settled) call.signal.throwIfAborted();
        try {
          this.diagnose({
            code: 'MAR_AGENT_EXTENSION_OBSERVER_FAILED',
            operationId: call.operationId
          });
        } catch {
          /* A diagnostic sink must not change an already completed fact. */
        }
      }
    }
  }
}
