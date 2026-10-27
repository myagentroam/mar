import {
  cloneCoreJson,
  type ExtensionCheckpoint,
  type ExtensionJsonValue
} from '../session/extension-checkpoint.js';
export {
  cloneCoreJson,
  type ExtensionCheckpoint,
  type ExtensionJsonValue
} from '../session/extension-checkpoint.js';
import { AgentError } from '../error.js';
import type {
  ExtensionCallbackRunner,
  ExtensionOperationContext,
  ExtensionOperationRunner
} from './operation.js';
import type { ExtensionResourceRegistration } from './resources.js';
import { ExtensionResourceScope } from './resources.js';

/** Storage is installed by the application; lifecycle remains scoped by the extension. */
export type ExtensionStoreBackend = (
  directory: string,
  run: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>
) => ExtensionStoreApi;

export interface ExtensionCheckpointApi {
  get(input: { readonly key: string }): Promise<ExtensionCheckpoint>;
  set(input: {
    readonly key: string;
    readonly value: ExtensionJsonValue;
    readonly expectedRevision?: number;
  }): Promise<ExtensionCheckpoint>;
  delete(input: {
    readonly key: string;
    readonly expectedRevision?: number;
  }): Promise<ExtensionCheckpoint>;
}
export interface ExtensionCheckpointBackend {
  read(
    extensionId: string,
    key: string,
    call: ExtensionOperationContext
  ): Promise<ExtensionCheckpoint>;
  write(
    extensionId: string,
    key: string,
    value: ExtensionJsonValue | undefined,
    expectedRevision: number | undefined,
    call: ExtensionOperationContext
  ): Promise<ExtensionCheckpoint>;
}
export interface ExtensionStateChange {
  readonly key: string;
  readonly revision: number;
  readonly value?: ExtensionJsonValue;
}
export interface ExtensionStateApi {
  read(key: string): Promise<ExtensionJsonValue | undefined>;
  write(key: string, value: ExtensionJsonValue): Promise<number>;
  delete(key: string): Promise<number>;
  watch(
    handler: (change: ExtensionStateChange, call: ExtensionOperationContext) => void | Promise<void>
  ): ExtensionResourceRegistration;
}
export interface ExtensionDataApi {
  readonly store?: ExtensionStoreApi;
  readonly state: ExtensionStateApi;
  readonly checkpoint?: ExtensionCheckpointApi;
}

export function bindCoreData(
  state: ExtensionState,
  store: ExtensionStoreBackend | undefined,
  directory: string | undefined,
  checkpoint: ExtensionCheckpointBackend | undefined,
  extensionId: string,
  run: ExtensionOperationRunner
): ExtensionDataApi {
  return {
    ...(directory === undefined
      ? {}
      : { store: store!(directory, (operation) => run((call) => operation(call.signal))) }),
    state: {
      read: (key) => run(async () => state.read(key)),
      write: (key, value) => run((call) => state.write(key, value, call)),
      delete: (key) => run((call) => state.write(key, undefined, call)),
      watch: (handler) => state.watch(handler)
    },
    ...(checkpoint
      ? {
          checkpoint: {
            get: (input) => run((call) => checkpoint.read(extensionId, input.key, call)),
            set: (input) =>
              run((call) =>
                checkpoint.write(extensionId, input.key, input.value, input.expectedRevision, call)
              ),
            delete: (input) =>
              run((call) =>
                checkpoint.write(extensionId, input.key, undefined, input.expectedRevision, call)
              )
          }
        }
      : {})
  };
}

export interface ExtensionStoreCommit {
  readonly expectedRevision?: number;
  readonly writes: readonly { readonly key: string; readonly value?: ExtensionJsonValue }[];
}
export interface ExtensionStoreApi {
  get(input: { readonly key: string }): Promise<ExtensionCheckpoint>;
  keys(): Promise<{ readonly revision: number; readonly keys: readonly string[] }>;
  set(input: {
    readonly key: string;
    readonly value: ExtensionJsonValue;
    readonly expectedRevision?: number;
  }): Promise<ExtensionCheckpoint>;
  delete(input: {
    readonly key: string;
    readonly expectedRevision?: number;
  }): Promise<ExtensionCheckpoint>;
  commit(input: ExtensionStoreCommit): Promise<{ readonly revision: number }>;
}

/** Explicit reactive state, not a proxy over the Session or a second persistence mechanism. */
export class ExtensionState {
  readonly #values = new Map<string, ExtensionJsonValue>();
  readonly #observers: ((
    change: ExtensionStateChange,
    call: ExtensionOperationContext
  ) => void | Promise<void>)[] = [];
  #revision = 0;
  constructor(
    readonly scope: ExtensionResourceScope,
    readonly diagnose: () => void,
    readonly callback: ExtensionCallbackRunner = async (call, run) => run(call)
  ) {}
  read(key: string): ExtensionJsonValue | undefined {
    const value = this.#values.get(key);
    return value === undefined ? undefined : cloneCoreJson(value);
  }
  async write(
    key: string,
    value: ExtensionJsonValue | undefined,
    call: ExtensionOperationContext
  ): Promise<number> {
    if (typeof key !== 'string')
      throw new AgentError('MAR_AGENT_EXTENSION_DATA_INVALID', 'State key must be a string.');
    const committed = value === undefined ? undefined : cloneCoreJson(value);
    if (committed === undefined) this.#values.delete(key);
    else this.#values.set(key, committed);
    const revision = ++this.#revision;
    const change: ExtensionStateChange = {
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
    handler: (change: ExtensionStateChange, call: ExtensionOperationContext) => void | Promise<void>
  ): ExtensionResourceRegistration {
    const registration = this.scope.effect(() => () => {
      const index = this.#observers.indexOf(handler);
      if (index !== -1) this.#observers.splice(index, 1);
    });
    this.#observers.push(handler);
    return registration;
  }
}
