import type {
  ExtensionEnvironmentBackend,
  ExtensionEnvironmentKey,
  ExtensionEnvironmentSet
} from '../extensions/environment.js';
import { validateEnvironmentInput } from '../extensions/environment.js';
import type { ExtensionOperationContext } from '../extensions/operation.js';
import type { LocalProcessSpawnRequest } from '../process/contracts.js';

/** Session-owned overlay, shared by native and model/programmatic process starts. */
export class LocalSessionEnvironment implements ExtensionEnvironmentBackend {
  readonly #sessions = new Map<string, Map<string, { key: string; value: string | undefined }>>();
  constructor(
    private readonly base: NodeJS.ProcessEnv,
    private readonly executionEnvironment: (
      executionId?: string
    ) => Readonly<Record<string, string>> | undefined,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}
  #key(key: string): string {
    return this.platform === 'win32' ? key.toUpperCase() : key;
  }
  #read(environment: NodeJS.ProcessEnv, key: string): string | undefined {
    if (this.platform !== 'win32')
      return Object.hasOwn(environment, key) ? environment[key] : undefined;
    const name = Object.keys(environment).find((name) => this.#key(name) === this.#key(key));
    return name === undefined ? undefined : environment[name];
  }
  async get(
    input: ExtensionEnvironmentKey,
    call: ExtensionOperationContext
  ): Promise<string | undefined> {
    validateEnvironmentInput(input);
    call.signal.throwIfAborted();
    const overlay = this.#sessions.get(call.sessionId)?.get(this.#key(input.key));
    if (overlay) return overlay.value;
    const execution = this.executionEnvironment(call.executionId);
    if (execution && Object.keys(execution).some((key) => this.#key(key) === this.#key(input.key)))
      return this.#read(execution, input.key);
    return this.#read(this.base, input.key);
  }
  async set(input: ExtensionEnvironmentSet, call: ExtensionOperationContext) {
    validateEnvironmentInput(input);
    call.signal.throwIfAborted();
    const key = this.#key(input.key);
    const entries = this.#sessions.get(call.sessionId) ?? new Map();
    const before = entries.get(key);
    const changed = !before || before.value !== input.value;
    // The tombstone is a real change even if the current lower layer happens to be unset.
    entries.set(key, { key: input.key, value: input.value });
    this.#sessions.set(call.sessionId, entries);
    return { changed };
  }
  forProcess(request: LocalProcessSpawnRequest): LocalProcessSpawnRequest {
    const execution = this.executionEnvironment(request.owner?.executionId);
    const entries = request.owner && this.#sessions.get(request.owner.sessionId);
    if (
      execution === undefined &&
      !entries?.size &&
      (this.platform !== 'win32' || request.environmentOverrides === undefined)
    )
      return request;
    const environment: NodeJS.ProcessEnv = { ...request.environment };
    const overrides: NodeJS.ProcessEnv = {};
    const assign = (key: string, value: string | undefined) => {
      if (this.platform === 'win32') {
        for (const current of Object.keys(environment))
          if (this.#key(current) === this.#key(key)) delete environment[current];
        for (const current of Object.keys(overrides))
          if (this.#key(current) === this.#key(key)) delete overrides[current];
      }
      Object.defineProperty(overrides, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true
      });
      if (value === undefined) delete environment[key];
      else
        Object.defineProperty(environment, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true
        });
    };
    for (const [key, value] of Object.entries(execution ?? {})) assign(key, value);
    for (const entry of entries?.values() ?? []) assign(entry.key, entry.value);
    for (const [key, value] of Object.entries(request.environmentOverrides ?? {}))
      assign(key, value);
    return {
      ...request,
      environment,
      environmentOverrides: overrides,
      ...(request.environmentKeys === undefined
        ? {}
        : {
            environmentKeys: [
              ...new Set(
                [
                  ...request.environmentKeys,
                  ...Object.keys(execution ?? {}),
                  ...Object.keys(request.environmentOverrides ?? {}),
                  ...[...(entries?.values() ?? [])].map((entry) => entry.key)
                ]
                  .map((key) =>
                    this.platform === 'win32'
                      ? Object.keys(environment).find((name) => this.#key(name) === this.#key(key))
                      : key
                  )
                  .filter(
                    (key): key is string => key !== undefined && environment[key] !== undefined
                  )
              )
            ]
          })
    };
  }
  clearSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }
  clear(): void {
    this.#sessions.clear();
  }
}
