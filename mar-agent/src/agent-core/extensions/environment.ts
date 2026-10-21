import { MarAgentError } from '../error.js';
import type { CoreOperationContext } from './operation.js';
import type { CoreDomainFacts, CoreDomainOperations } from './contracts.js';
import type { ExtensionHooks } from './hooks.js';

export interface CoreEnvironmentKey {
  readonly key: string;
  readonly signal?: AbortSignal;
}
export interface CoreEnvironmentSet extends CoreEnvironmentKey {
  readonly value?: string;
}
export interface CoreEnvironmentChange {
  readonly changed: boolean;
}
export interface CoreEnvironmentApi {
  get(input: CoreEnvironmentKey): Promise<string | undefined>;
  set(input: CoreEnvironmentSet): Promise<CoreEnvironmentChange>;
}
export interface CoreEnvironmentBackend {
  get(input: CoreEnvironmentKey, call: CoreOperationContext): Promise<string | undefined>;
  set(input: CoreEnvironmentSet, call: CoreOperationContext): Promise<CoreEnvironmentChange>;
}
export interface CoreEnvironmentCompletion {
  readonly operation: 'get' | 'set';
  readonly changed?: boolean;
}
export function validateEnvironmentInput(input: CoreEnvironmentKey): void {
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
    throw new MarAgentError(
      'MAR_AGENT_ENVIRONMENT_INPUT_INVALID',
      'Environment variable input is invalid.'
    );
}
export function bindCoreEnvironment(
  backend: CoreEnvironmentBackend,
  run: <Value>(
    operation: (call: CoreOperationContext) => Promise<Value>,
    signal?: AbortSignal
  ) => Promise<Value>,
  hooks: ExtensionHooks<CoreDomainOperations, CoreDomainFacts>
): CoreEnvironmentApi {
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
  return new MarAgentError(
    'MAR_AGENT_HOST_PORT_UNAVAILABLE',
    'Native environment port is unavailable.',
    { details: { operation } }
  );
}
function invalidResult() {
  return new MarAgentError(
    'MAR_AGENT_ENVIRONMENT_OUTPUT_INVALID',
    'Native environment result is invalid.'
  );
}
