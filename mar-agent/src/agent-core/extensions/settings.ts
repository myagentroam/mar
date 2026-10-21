import { MarAgentError } from '../error.js';
import { cloneCoreJson, type CoreJsonValue } from './data.js';
import type { CoreCapabilitySnapshot, CoreDomainFacts, CoreDomainOperations } from './contracts.js';
import type { ExtensionHooks } from './hooks.js';
import type { CoreOperationContext } from './operation.js';

export interface CoreSettingsReadInput {
  readonly scope?: string;
  readonly signal?: AbortSignal;
}
export interface CoreSettingDefinition {
  readonly key: string;
  readonly schema: boolean | Readonly<Record<string, CoreJsonValue>>;
  readonly source: string;
  readonly writable: boolean;
  readonly sensitive?: boolean;
  readonly owner?: string;
  readonly label?: string;
}
export interface CoreSettingsDescription {
  readonly revision: number;
  readonly definitions: readonly CoreSettingDefinition[];
}
export interface CoreSettingsSnapshot {
  readonly revision: number;
  readonly values: Readonly<Record<string, CoreJsonValue>>;
}
export interface CoreSettingsUpdate extends CoreSettingsReadInput {
  readonly key: string;
  readonly value: CoreJsonValue;
  readonly expectedRevision?: number;
}
export type CoreSettingsResult =
  | {
      readonly status: 'updated' | 'unchanged';
      readonly revision: number;
      readonly value: CoreJsonValue;
    }
  | {
      readonly status: 'denied';
      readonly revision: number;
      readonly reason: { readonly code: string; readonly message: string };
    };
export interface CoreSettingsApi {
  describe(input?: CoreSettingsReadInput): Promise<CoreSettingsDescription>;
  read(input?: CoreSettingsReadInput): Promise<CoreSettingsSnapshot>;
  update(input: CoreSettingsUpdate): Promise<CoreSettingsResult>;
}
export type CoreSettingsBackend = {
  [Name in keyof CoreSettingsApi]: (
    input: NonNullable<Parameters<CoreSettingsApi[Name]>[0]>,
    call: CoreOperationContext
  ) => Promise<Awaited<ReturnType<CoreSettingsApi[Name]>>>;
};
export interface CoreSettingsCompletion {
  readonly operation: keyof CoreSettingsApi;
  readonly revision: number;
  readonly scope?: string;
  readonly status?: CoreSettingsResult['status'];
}
export function coreSettingsBinding(
  bindings?: Readonly<Record<string, unknown>>
): CoreSettingsBackend | undefined {
  const backend = bindings?.['settings'];
  if (backend === undefined) return undefined;
  if (
    !backend ||
    typeof backend !== 'object' ||
    ['describe', 'read', 'update'].some(
      (name) => typeof (backend as Record<string, unknown>)[name] !== 'function'
    )
  )
    throw new MarAgentError(
      'MAR_AGENT_SETTINGS_BINDING_INVALID',
      'Settings binding must provide describe, read and update.'
    );
  return backend as CoreSettingsBackend;
}
export function settingsCapabilities(
  base: CoreCapabilitySnapshot,
  bound: boolean
): CoreCapabilitySnapshot {
  const list = Object.freeze([
    ...base.list().filter((id) => id !== 'settings'),
    ...(bound ? ['settings'] : [])
  ]);
  return Object.freeze({ has: (id: string) => list.includes(id), list: () => list });
}
function copyInput<Input extends CoreSettingsReadInput>(input: Input): Input {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    (input.scope !== undefined && (typeof input.scope !== 'string' || !input.scope))
  )
    throw invalid('INPUT');
  if ('key' in input) {
    const update = input as unknown as CoreSettingsUpdate;
    if (
      typeof update.key !== 'string' ||
      !update.key ||
      (update.expectedRevision !== undefined &&
        (!Number.isSafeInteger(update.expectedRevision) || update.expectedRevision < 0))
    )
      throw invalid('INPUT');
    try {
      return { ...input, value: cloneCoreJson(update.value) };
    } catch {
      throw invalid('INPUT');
    }
  }
  return { ...input };
}
function copyOutput<Value>(value: Value): Value {
  try {
    return cloneCoreJson(value) as Value;
  } catch {
    throw invalid('OUTPUT');
  }
}
function invalid(kind: 'INPUT' | 'OUTPUT') {
  return new MarAgentError(
    `MAR_AGENT_SETTINGS_${kind}_INVALID`,
    `Settings ${kind === 'INPUT' ? 'input' : 'result'} is invalid.`
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function bindCoreSettings(
  backend: CoreSettingsBackend,
  run: <Value>(
    operation: (call: CoreOperationContext) => Promise<Value>,
    signal?: AbortSignal
  ) => Promise<Value>,
  hooks: ExtensionHooks<CoreDomainOperations, CoreDomainFacts>
): CoreSettingsApi {
  const invoke = async <Name extends keyof CoreSettingsApi>(
    name: Name,
    raw: NonNullable<Parameters<CoreSettingsApi[Name]>[0]>
  ): Promise<Awaited<ReturnType<CoreSettingsApi[Name]>>> => {
    const input = copyInput(raw);
    return run(
      (call) =>
        hooks.invoke(`settings.${name}`, input, call, async (candidate, effective) => {
          const supplied = copyInput(candidate);
          if (name === 'update' && (!('key' in supplied) || !('value' in supplied)))
            throw invalid('INPUT');
          if (typeof backend[name] !== 'function')
            throw new MarAgentError(
              'MAR_AGENT_HOST_PORT_UNAVAILABLE',
              'Bound settings operation is unavailable.',
              { details: { operation: name } }
            );
          const handler = backend[name] as (
            input: typeof supplied,
            call: CoreOperationContext
          ) => Promise<unknown>;
          const output = copyOutput(await handler.call(backend, supplied, effective));
          if (
            !object(output) ||
            !Number.isSafeInteger(output['revision']) ||
            (output['revision'] as number) < 0
          )
            throw invalid('OUTPUT');
          if (name === 'describe') {
            const definitions = output['definitions'];
            if (
              !Array.isArray(definitions) ||
              definitions.some(
                (item: unknown) =>
                  !object(item) ||
                  typeof item['key'] !== 'string' ||
                  !item['key'] ||
                  typeof item['source'] !== 'string' ||
                  typeof item['writable'] !== 'boolean' ||
                  (item['sensitive'] !== undefined && typeof item['sensitive'] !== 'boolean') ||
                  (item['label'] !== undefined && typeof item['label'] !== 'string') ||
                  (item['owner'] !== undefined && typeof item['owner'] !== 'string') ||
                  (typeof item['schema'] !== 'boolean' && !object(item['schema']))
              ) ||
              new Set(definitions.map((item: { key: string }) => item.key)).size !==
                definitions.length
            )
              throw invalid('OUTPUT');
          } else if (name === 'read') {
            if (!object(output['values'])) throw invalid('OUTPUT');
          } else if (
            !['updated', 'unchanged', 'denied'].includes(String(output['status'])) ||
            (output['status'] === 'denied'
              ? !object(output['reason']) ||
                typeof output['reason']['code'] !== 'string' ||
                !output['reason']['code'] ||
                typeof output['reason']['message'] !== 'string'
              : !('value' in output))
          )
            throw invalid('OUTPUT');
          await hooks.emit(
            'settings.completed',
            {
              operation: name,
              revision: output['revision'] as number,
              ...(supplied.scope === undefined ? {} : { scope: supplied.scope }),
              ...(name === 'update'
                ? { status: output['status'] as CoreSettingsResult['status'] }
                : {})
            },
            effective
          );
          return output as unknown as CoreDomainOperations[`settings.${Name}`]['output'];
        }),
      input.signal
    ) as Promise<Awaited<ReturnType<CoreSettingsApi[Name]>>>;
  };
  return {
    describe: (input = {}) => invoke('describe', input),
    read: (input = {}) => invoke('read', input),
    update: (input) => invoke('update', input)
  };
}
