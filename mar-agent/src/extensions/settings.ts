import { AgentError } from '../error.js';
import { cloneCoreJson, type ExtensionJsonValue } from './data.js';
import type { ExtensionCapabilitySnapshot } from './capabilities.js';
import type { ExtensionHooks } from './hooks.js';
import type { ExtensionOperationContext } from './operation.js';

export interface ExtensionSettingsReadInput {
  readonly scope?: string;
  readonly signal?: AbortSignal;
}
export interface ExtensionSettingDefinition {
  readonly key: string;
  readonly schema: boolean | Readonly<Record<string, ExtensionJsonValue>>;
  readonly source: string;
  readonly writable: boolean;
  readonly sensitive?: boolean;
  readonly owner?: string;
  readonly label?: string;
}
export interface ExtensionSettingsDescription {
  readonly revision: number;
  readonly definitions: readonly ExtensionSettingDefinition[];
}
export interface ExtensionSettingsSnapshot {
  readonly revision: number;
  readonly values: Readonly<Record<string, ExtensionJsonValue>>;
}
export interface ExtensionSettingsUpdate extends ExtensionSettingsReadInput {
  readonly key: string;
  readonly value: ExtensionJsonValue;
  readonly expectedRevision?: number;
}
export type ExtensionSettingsResult =
  | {
      readonly status: 'updated' | 'unchanged';
      readonly revision: number;
      readonly value: ExtensionJsonValue;
    }
  | {
      readonly status: 'denied';
      readonly revision: number;
      readonly reason: { readonly code: string; readonly message: string };
    };
export interface ExtensionSettingsApi {
  describe(input?: ExtensionSettingsReadInput): Promise<ExtensionSettingsDescription>;
  read(input?: ExtensionSettingsReadInput): Promise<ExtensionSettingsSnapshot>;
  update(input: ExtensionSettingsUpdate): Promise<ExtensionSettingsResult>;
}
export type ExtensionSettingsBackend = {
  [Name in keyof ExtensionSettingsApi]: (
    input: NonNullable<Parameters<ExtensionSettingsApi[Name]>[0]>,
    call: ExtensionOperationContext
  ) => Promise<Awaited<ReturnType<ExtensionSettingsApi[Name]>>>;
};
export interface ExtensionSettingsCompletion {
  readonly operation: keyof ExtensionSettingsApi;
  readonly revision: number;
  readonly scope?: string;
  readonly status?: ExtensionSettingsResult['status'];
}
export function coreSettingsBinding(
  bindings?: Readonly<Record<string, unknown>>
): ExtensionSettingsBackend | undefined {
  const backend = bindings?.['settings'];
  if (backend === undefined) return undefined;
  if (
    !backend ||
    typeof backend !== 'object' ||
    ['describe', 'read', 'update'].some(
      (name) => typeof (backend as Record<string, unknown>)[name] !== 'function'
    )
  )
    throw new AgentError(
      'MAR_AGENT_SETTINGS_BINDING_INVALID',
      'Settings binding must provide describe, read and update.'
    );
  return backend as ExtensionSettingsBackend;
}
export function settingsCapabilities(
  base: ExtensionCapabilitySnapshot,
  bound: boolean
): ExtensionCapabilitySnapshot {
  const list = Object.freeze([
    ...base.list().filter((id) => id !== 'settings'),
    ...(bound ? ['settings'] : [])
  ]);
  return Object.freeze({ has: (id: string) => list.includes(id), list: () => list });
}
function copyInput<Input extends ExtensionSettingsReadInput>(input: Input): Input {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    (input.scope !== undefined && (typeof input.scope !== 'string' || !input.scope))
  )
    throw invalid('INPUT');
  if ('key' in input) {
    const update = input as unknown as ExtensionSettingsUpdate;
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
  return new AgentError(
    `MAR_AGENT_SETTINGS_${kind}_INVALID`,
    `Settings ${kind === 'INPUT' ? 'input' : 'result'} is invalid.`
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function bindCoreSettings(
  backend: ExtensionSettingsBackend,
  run: <Value>(
    operation: (call: ExtensionOperationContext) => Promise<Value>,
    signal?: AbortSignal
  ) => Promise<Value>,
  hooks: Pick<ExtensionHooks<DomainSettingsOperations, DomainSettingsFacts>, 'invoke' | 'emit'>
): ExtensionSettingsApi {
  const invoke = async <Name extends keyof ExtensionSettingsApi>(
    name: Name,
    raw: NonNullable<Parameters<ExtensionSettingsApi[Name]>[0]>
  ): Promise<Awaited<ReturnType<ExtensionSettingsApi[Name]>>> => {
    const input = copyInput(raw);
    return run(
      (call) =>
        hooks.invoke(`settings.${name}`, input, call, async (candidate, effective) => {
          const supplied = copyInput(candidate);
          if (name === 'update' && (!('key' in supplied) || !('value' in supplied)))
            throw invalid('INPUT');
          if (typeof backend[name] !== 'function')
            throw new AgentError(
              'MAR_AGENT_HOST_PORT_UNAVAILABLE',
              'Bound settings operation is unavailable.',
              { details: { operation: name } }
            );
          const handler = backend[name] as (
            input: typeof supplied,
            call: ExtensionOperationContext
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
                ? { status: output['status'] as ExtensionSettingsResult['status'] }
                : {})
            },
            effective
          );
          return output as unknown as DomainSettingsOperations[`settings.${Name}`]['output'];
        }),
      input.signal
    ) as Promise<Awaited<ReturnType<ExtensionSettingsApi[Name]>>>;
  };
  return {
    describe: (input = {}) => invoke('describe', input),
    read: (input = {}) => invoke('read', input),
    update: (input) => invoke('update', input)
  };
}

export interface DomainSettingsOperations {
  'settings.describe': { input: ExtensionSettingsReadInput; output: ExtensionSettingsDescription };
  'settings.read': { input: ExtensionSettingsReadInput; output: ExtensionSettingsSnapshot };
  'settings.update': { input: ExtensionSettingsUpdate; output: ExtensionSettingsResult };
}
export interface DomainSettingsFacts {
  'settings.completed': ExtensionSettingsCompletion;
}
