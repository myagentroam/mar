import { MarAgentError } from '../error.js';
import type { CoreCallbackRunner, CoreOperationContext } from './operation.js';
import type { CoreResourceRegistration } from './resources.js';
import { ExtensionResourceScope } from './resources.js';

export type CoreJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CoreJsonValue[]
  | { readonly [key: string]: CoreJsonValue };
export interface CoreCheckpoint {
  readonly revision: number;
  readonly value?: CoreJsonValue;
}
export interface CoreCheckpointApi {
  get(input: { readonly key: string }): Promise<CoreCheckpoint>;
  set(input: {
    readonly key: string;
    readonly value: CoreJsonValue;
    readonly expectedRevision?: number;
  }): Promise<CoreCheckpoint>;
  delete(input: {
    readonly key: string;
    readonly expectedRevision?: number;
  }): Promise<CoreCheckpoint>;
}
export interface CoreCheckpointBackend {
  read(extensionId: string, key: string, call: CoreOperationContext): Promise<CoreCheckpoint>;
  write(
    extensionId: string,
    key: string,
    value: CoreJsonValue | undefined,
    expectedRevision: number | undefined,
    call: CoreOperationContext
  ): Promise<CoreCheckpoint>;
}
export interface CoreStateChange {
  readonly key: string;
  readonly revision: number;
  readonly value?: CoreJsonValue;
}
export interface CoreStateApi {
  read(key: string): Promise<CoreJsonValue | undefined>;
  write(key: string, value: CoreJsonValue): Promise<number>;
  delete(key: string): Promise<number>;
  watch(
    handler: (change: CoreStateChange, call: CoreOperationContext) => void | Promise<void>
  ): CoreResourceRegistration;
}
export interface CoreDataApi {
  readonly store?: CoreStoreApi;
  readonly state: CoreStateApi;
  readonly checkpoint?: CoreCheckpointApi;
}

export interface CoreStoreCommit {
  readonly expectedRevision?: number;
  readonly writes: readonly { readonly key: string; readonly value?: CoreJsonValue }[];
}
export interface CoreStoreApi {
  get(input: { readonly key: string }): Promise<CoreCheckpoint>;
  keys(): Promise<{ readonly revision: number; readonly keys: readonly string[] }>;
  set(input: {
    readonly key: string;
    readonly value: CoreJsonValue;
    readonly expectedRevision?: number;
  }): Promise<CoreCheckpoint>;
  delete(input: {
    readonly key: string;
    readonly expectedRevision?: number;
  }): Promise<CoreCheckpoint>;
  commit(input: CoreStoreCommit): Promise<{ readonly revision: number }>;
}

export function cloneCoreJson(value: unknown): CoreJsonValue {
  try {
    const ancestors = new Set<object>();
    const copy = (value: unknown): CoreJsonValue => {
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value !== 'object' || !value || ancestors.has(value)) throw new Error();
      ancestors.add(value);
      try {
        if (Array.isArray(value)) return Array.from(value, copy);
        if (Object.prototype.toString.call(value) !== '[object Object]') throw new Error();
        // Define own JSON keys, including __proto__, without assigning to a prototype setter.
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
      } finally {
        ancestors.delete(value);
      }
    };
    return copy(value);
  } catch {
    throw new MarAgentError(
      'MAR_AGENT_EXTENSION_DATA_INVALID',
      'Extension data must be serializable JSON.'
    );
  }
}

/** Explicit reactive state, not a proxy over the Session or a second persistence mechanism. */
export class ExtensionState {
  readonly #values = new Map<string, CoreJsonValue>();
  readonly #observers: ((
    change: CoreStateChange,
    call: CoreOperationContext
  ) => void | Promise<void>)[] = [];
  #revision = 0;
  constructor(
    readonly scope: ExtensionResourceScope,
    readonly diagnose: () => void,
    readonly callback: CoreCallbackRunner = async (call, run) => run(call)
  ) {}
  read(key: string): CoreJsonValue | undefined {
    const value = this.#values.get(key);
    return value === undefined ? undefined : cloneCoreJson(value);
  }
  async write(
    key: string,
    value: CoreJsonValue | undefined,
    call: CoreOperationContext
  ): Promise<number> {
    if (typeof key !== 'string')
      throw new MarAgentError('MAR_AGENT_EXTENSION_DATA_INVALID', 'State key must be a string.');
    const committed = value === undefined ? undefined : cloneCoreJson(value);
    if (committed === undefined) this.#values.delete(key);
    else this.#values.set(key, committed);
    const revision = ++this.#revision;
    const change: CoreStateChange = {
      key,
      revision,
      ...(committed !== undefined ? { value: cloneCoreJson(committed) } : {})
    };
    if (this.scope.state === 'ACTIVE')
      for (const observer of [...this.#observers]) {
        try {
          await this.scope.run(
            (signal) =>
              this.callback(Object.freeze({ ...call, signal }), (effective) =>
                observer(structuredClone(change), effective)
              ),
            call.signal
          );
        } catch {
          call.signal.throwIfAborted();
          this.diagnose();
        }
      }
    return revision;
  }
  watch(
    handler: (change: CoreStateChange, call: CoreOperationContext) => void | Promise<void>
  ): CoreResourceRegistration {
    const registration = this.scope.effect(() => () => {
      const index = this.#observers.indexOf(handler);
      if (index !== -1) this.#observers.splice(index, 1);
    });
    this.#observers.push(handler);
    return registration;
  }
}
