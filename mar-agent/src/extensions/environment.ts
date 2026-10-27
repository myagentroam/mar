import { AgentError } from '../error.js';
import type { ExtensionOperationContext } from './operation.js';

import type { ExtensionHooks } from './hooks.js';

export interface ExtensionEnvironmentKey {
  readonly key: string;
  readonly signal?: AbortSignal;
}
export interface ExtensionEnvironmentSet extends ExtensionEnvironmentKey {
  readonly value?: string;
}
export interface ExtensionEnvironmentChange {
  readonly changed: boolean;
}
export interface ExtensionEnvironmentApi {
  get(input: ExtensionEnvironmentKey): Promise<string | undefined>;
  set(input: ExtensionEnvironmentSet): Promise<ExtensionEnvironmentChange>;
}
export interface ExtensionEnvironmentBackend {
  get(input: ExtensionEnvironmentKey, call: ExtensionOperationContext): Promise<string | undefined>;
  set(
    input: ExtensionEnvironmentSet,
    call: ExtensionOperationContext
  ): Promise<ExtensionEnvironmentChange>;
}
export interface ExtensionEnvironmentCompletion {
  readonly operation: 'get' | 'set';
  readonly changed?: boolean;
}
export function validateEnvironmentInput(input: ExtensionEnvironmentKey): void {
  if (
    !input ||
    typeof input.key !== 'string' ||
    !input.key ||
    input.key.includes('=') ||
    input.key.includes('\0') ||
    ('value' in input &&
      input.value !== undefined &&
      (typeof input.value !== 'string' || input.value.includes('\0')))
  )
    throw new AgentError(
      'MAR_AGENT_ENVIRONMENT_INPUT_INVALID',
      'Environment variable input is invalid.'
    );
}
export function bindCoreEnvironment(
  backend: ExtensionEnvironmentBackend,
  run: <Value>(
    operation: (call: ExtensionOperationContext) => Promise<Value>,
    signal?: AbortSignal
  ) => Promise<Value>,
  hooks: Pick<
    ExtensionHooks<DomainEnvironmentOperations, DomainEnvironmentFacts>,
    'invoke' | 'emit'
  >
): ExtensionEnvironmentApi {
  return {
    get: async (input) => {
      input = { ...input };
      validateEnvironmentInput(input);
      return run(
        (call) =>
          hooks.invoke('environment.get', input, call, async (input, effective) => {
            validateEnvironmentInput(input);
            if (typeof backend.get !== 'function') throw unavailable('get');
            const value = await backend.get({ ...input }, effective);
            if (value !== undefined && typeof value !== 'string') throw invalidResult();
            await hooks.emit('environment.completed', { operation: 'get' }, effective);
            return value;
          }),
        input.signal
      );
    },
    set: async (input) => {
      input = { ...input };
      validateEnvironmentInput(input);
      return run(
        (call) =>
          hooks.invoke('environment.set', input, call, async (input, effective) => {
            validateEnvironmentInput(input);
            if (typeof backend.set !== 'function') throw unavailable('set');
            const output = await backend.set({ ...input }, effective);
            const changed = output?.changed;
            if (typeof changed !== 'boolean') throw invalidResult();
            const result = { changed };
            await hooks.emit('environment.completed', { operation: 'set', ...result }, effective);
            return result;
          }),
        input.signal
      );
    }
  };
}
function unavailable(operation: string) {
  return new AgentError(
    'MAR_AGENT_HOST_PORT_UNAVAILABLE',
    'Native environment port is unavailable.',
    { details: { operation } }
  );
}
function invalidResult() {
  return new AgentError(
    'MAR_AGENT_ENVIRONMENT_OUTPUT_INVALID',
    'Native environment result is invalid.'
  );
}

export interface DomainEnvironmentOperations {
  'environment.get': { input: ExtensionEnvironmentKey; output: string | undefined };
  'environment.set': { input: ExtensionEnvironmentSet; output: ExtensionEnvironmentChange };
}
export interface DomainEnvironmentFacts {
  'environment.completed': ExtensionEnvironmentCompletion;
}
