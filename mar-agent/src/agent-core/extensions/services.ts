import { MarAgentError } from '../error.js';
import type { CoreResourceScope } from './resources.js';

export interface CoreServiceKey<T> {
  readonly id: string;
  readonly scope: 'agent' | 'session';
  /** Compile-time service contract; never examined at runtime. */
  readonly contract?: (implementation: T) => T;
}
export interface CoreServiceRegistry {
  provide<T>(key: CoreServiceKey<T>, implementation: T): void;
  replace<T>(key: CoreServiceKey<T>, implementation: T): void;
  wrap<T>(key: CoreServiceKey<T>, factory: (below: T) => T): void;
  consume<T>(key: CoreServiceKey<T>, options?: { readonly optional?: boolean }): T | undefined;
}

/** A composition's typed values, not a dynamic IoC container or dependency solver. */
export class ExtensionServices {
  readonly #entries = new Map<string, { value: unknown; owner: CoreResourceScope }[]>();
  constructor(
    readonly scope: 'agent' | 'session',
    readonly parent?: ExtensionServices
  ) {}

  has(key: { readonly id: string; readonly scope: 'agent' | 'session' }): boolean {
    return this.#find(key) !== undefined;
  }
  hasOwned(
    key: { readonly id: string; readonly scope: 'agent' | 'session' },
    owner: CoreResourceScope
  ): boolean {
    return (
      key.scope === this.scope &&
      (this.#entries.get(key.id)?.some((entry) => entry.owner === owner) ?? false)
    );
  }

  bind(owner: CoreResourceScope): CoreServiceRegistry {
    const consume = <T>(
      key: CoreServiceKey<T>,
      options?: { readonly optional?: boolean }
    ): T | undefined => {
      const entry = this.#find(key);
      if (!entry && !options?.optional)
        throw new MarAgentError(
          'MAR_AGENT_EXTENSION_DEPENDENCY_MISSING',
          'Required service is unavailable.'
        );
      return entry?.value as T | undefined;
    };
    const publish = <T>(key: CoreServiceKey<T>, value: T, replace: boolean): void => {
      if (key.scope !== this.scope)
        throw new MarAgentError(
          'MAR_AGENT_EXTENSION_SERVICE_SCOPE',
          'Service publication uses the wrong scope.'
        );
      if (!key.id.trim())
        throw new MarAgentError('MAR_AGENT_EXTENSION_SERVICE_INVALID', 'Service key is empty.');
      const entries = this.#entries.get(key.id) ?? [];
      if (entries.length && !replace)
        throw new MarAgentError(
          'MAR_AGENT_EXTENSION_SERVICE_CONFLICT',
          'Service is already provided.'
        );
      if (!entries.length && replace)
        throw new MarAgentError(
          'MAR_AGENT_EXTENSION_DEPENDENCY_MISSING',
          'Service replacement has no lower provider.'
        );
      const entry = { value, owner };
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
      wrap: <T>(key: CoreServiceKey<T>, factory: (below: T) => T) => {
        const entry = this.#find(key);
        if (!entry)
          throw new MarAgentError(
            'MAR_AGENT_EXTENSION_DEPENDENCY_MISSING',
            'Service wrapper has no lower provider.'
          );
        publish(key, factory(entry.value as T), true);
      },
      consume
    };
  }

  #find(key: {
    readonly id: string;
    readonly scope: 'agent' | 'session';
  }): { value: unknown } | undefined {
    if (key.scope === this.scope) return this.#entries.get(key.id)?.at(-1);
    return this.parent ? this.parent.#find(key) : undefined;
  }
}
