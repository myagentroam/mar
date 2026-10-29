import { AgentError } from '../error.js';
import type { ExtensionResourceScope } from './resources.js';
import type { ExtensionOperationRunner } from './operation.js';

export interface ExtensionServiceConsumer {
  readonly run: ExtensionOperationRunner;
  readonly onDispose: (dispose: () => void | Promise<void>) => void;
}

export interface ExtensionServiceKey<T> {
  readonly id: string;
  readonly scope: 'agent' | 'session';
  /** Compile-time service contract; never examined at runtime. */
  readonly contract?: (implementation: T) => T;
  /** Bind a service to the framework-owned consuming Session scope. */
  readonly bindConsumer?: (implementation: T, consumer: ExtensionServiceConsumer) => T;
}
export interface ExtensionServiceRegistry {
  provide<T>(key: ExtensionServiceKey<T>, implementation: T): void;
  replace<T>(key: ExtensionServiceKey<T>, implementation: T): void;
  wrap<T>(key: ExtensionServiceKey<T>, factory: (below: T) => T): void;
  consume<T>(key: ExtensionServiceKey<T>, options?: { readonly optional?: boolean }): T | undefined;
}

/** A composition's typed values, not a dynamic IoC container or dependency solver. */
export class ExtensionServices {
  readonly #entries = new Map<
    string,
    {
      value: unknown;
      owner: ExtensionResourceScope;
      bindConsumer?: (value: unknown, consumer: ExtensionServiceConsumer) => unknown;
    }[]
  >();
  constructor(
    readonly scope: 'agent' | 'session',
    readonly parent?: ExtensionServices
  ) {}

  has(key: { readonly id: string; readonly scope: 'agent' | 'session' }): boolean {
    return this.#find(key) !== undefined;
  }
  resolve<T>(key: ExtensionServiceKey<T>): T | undefined {
    return this.#find(key)?.value as T | undefined;
  }
  hasOwned(
    key: { readonly id: string; readonly scope: 'agent' | 'session' },
    owner: ExtensionResourceScope
  ): boolean {
    return (
      key.scope === this.scope &&
      (this.#entries.get(key.id)?.some((entry) => entry.owner === owner) ?? false)
    );
  }

  bind(owner: ExtensionResourceScope, run?: ExtensionOperationRunner): ExtensionServiceRegistry {
    const consume = <T>(
      key: ExtensionServiceKey<T>,
      options?: { readonly optional?: boolean }
    ): T | undefined => {
      const entry = this.#find(key);
      if (!entry && !options?.optional)
        throw new AgentError(
          'MAR_AGENT_EXTENSION_DEPENDENCY_MISSING',
          'Required service is unavailable.'
        );
      if (!entry) return undefined;
      if (!entry.bindConsumer) return entry.value as T;
      if (!run)
        throw new AgentError(
          'MAR_AGENT_EXTENSION_SERVICE_SCOPE',
          'Service requires a Session consumer.'
        );
      return entry.bindConsumer(entry.value, {
        run,
        onDispose: (dispose) => {
          owner.effect(() => dispose);
        }
      }) as T;
    };
    const publish = <T>(key: ExtensionServiceKey<T>, value: T, replace: boolean): void => {
      if (key.scope !== this.scope)
        throw new AgentError(
          'MAR_AGENT_EXTENSION_SERVICE_SCOPE',
          'Service publication uses the wrong scope.'
        );
      if (!key.id.trim())
        throw new AgentError('MAR_AGENT_EXTENSION_SERVICE_INVALID', 'Service key is empty.');
      const entries = this.#entries.get(key.id) ?? [];
      if (entries.length && !replace)
        throw new AgentError(
          'MAR_AGENT_EXTENSION_SERVICE_CONFLICT',
          'Service is already provided.'
        );
      if (!entries.length && replace)
        throw new AgentError(
          'MAR_AGENT_EXTENSION_DEPENDENCY_MISSING',
          'Service replacement has no lower provider.'
        );
      const binder = key.bindConsumer;
      const entry = {
        value,
        owner,
        ...(binder
          ? {
              bindConsumer: (implementation: unknown, consumer: ExtensionServiceConsumer) =>
                binder(implementation as T, consumer)
            }
          : {})
      };
      owner.effect(() => () => {
        const index = entries.indexOf(entry);
        if (index !== -1) entries.splice(index, 1);
      });
      entries.push(entry);
      this.#entries.set(key.id, entries);
    };
    return {
      provide: (key, value) => publish(key, value, false),
      replace: (key, value) => publish(key, value, true),
      wrap: <T>(key: ExtensionServiceKey<T>, factory: (below: T) => T) => {
        const entry = this.#find(key);
        if (!entry)
          throw new AgentError(
            'MAR_AGENT_EXTENSION_DEPENDENCY_MISSING',
            'Service wrapper has no lower provider.'
          );
        publish(key, factory(entry.value as T), true);
      },
      consume
    };
  }

  #find(key: { readonly id: string; readonly scope: 'agent' | 'session' }):
    | {
        value: unknown;
        bindConsumer?: (value: unknown, consumer: ExtensionServiceConsumer) => unknown;
      }
    | undefined {
    if (key.scope === this.scope) return this.#entries.get(key.id)?.at(-1);
    return this.parent ? this.parent.#find(key) : undefined;
  }
}
