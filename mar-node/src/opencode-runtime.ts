import { spawnSync } from 'node:child_process';
import { minimalRunnerEnvironment, platformCliInvocation, runRunnerProbe } from './operational.js';

const PROBE_TIMEOUT_MS = 3_000;

export interface OpenCodeProbe {
  readonly available: boolean;
  readonly compatible: boolean;
  readonly version?: string;
}

export interface OpenCodeProviderCatalog {
  readonly connected?: readonly string[];
  readonly default?: Readonly<Record<string, string>>;
  readonly all?: readonly {
    readonly id?: string;
    readonly name?: string;
    readonly source?: 'env' | 'config' | 'custom' | 'api';
    readonly models?: Readonly<
      Record<
        string,
        {
          readonly id?: string;
          readonly name?: string;
          readonly variants?: Readonly<Record<string, { readonly disabled?: boolean }>>;
          readonly limit?: { readonly context?: number };
        }
      >
    >;
  }[];
}

export interface OpenCodeProfileModel {
  readonly id: string;
  readonly label: string;
  readonly supportedEfforts: string[];
}

export function probeOpenCode(command = 'opencode'): OpenCodeProbe {
  const invocation = platformCliInvocation(command, ['--version']);
  const result = spawnSync(invocation.command, invocation.args, {
    windowsHide: true,
    env: minimalRunnerEnvironment(),
    timeout: PROBE_TIMEOUT_MS,
    encoding: 'utf8'
  });
  if (result.status !== 0 || result.error !== undefined)
    return { available: false, compatible: false };
  return openCodeProbeResult(`${result.stdout}${result.stderr}`);
}

export async function probeOpenCodeAsync(command = 'opencode'): Promise<OpenCodeProbe> {
  const invocation = platformCliInvocation(command, ['--version']);
  const result = await runRunnerProbe(invocation.command, invocation.args, {
    env: minimalRunnerEnvironment(),
    timeoutMs: PROBE_TIMEOUT_MS
  });
  return result.status === 0
    ? openCodeProbeResult(`${result.stdout}${result.stderr}`)
    : { available: false, compatible: false };
}

function openCodeProbeResult(output: string): OpenCodeProbe {
  const version = output.trim().replace(/^v/i, '').slice(0, 128);
  return {
    available: version.length > 0,
    compatible: /^1\.18\./.test(version),
    ...(version.length === 0 ? {} : { version })
  };
}

export function openCodeProfileModels(catalog: OpenCodeProviderCatalog): OpenCodeProfileModel[] {
  const connected = new Set(catalog.connected ?? []);
  return (catalog.all ?? [])
    .filter(
      (provider) =>
        typeof provider.id === 'string' &&
        connected.has(provider.id) &&
        provider.source === 'config'
    )
    .flatMap((provider) => {
      const providerId = provider.id!;
      return Object.entries(provider.models ?? {}).flatMap(([key, model]) => {
        const modelId = boundedString(model.id) ?? boundedString(key);
        if (modelId === undefined) return [];
        const qualifiedModelId = `${providerId}/${modelId}`;
        if (qualifiedModelId.length > 128) return [];
        const variants = Object.entries(model.variants ?? {})
          .filter(([, value]) => value.disabled !== true)
          .map(([id]) => id)
          .filter((id) => id.length > 0 && id.length <= 64)
          .slice(0, 32);
        return [
          {
            id: qualifiedModelId,
            label: (boundedString(model.name) ?? modelId).slice(0, 128),
            supportedEfforts: variants
          }
        ];
      });
    });
}

export function openCodeContextLimits(
  catalog: OpenCodeProviderCatalog
): ReadonlyMap<string, number> {
  const connected = new Set(catalog.connected ?? []);
  return new Map(
    (catalog.all ?? [])
      .filter(
        (provider) =>
          typeof provider.id === 'string' &&
          connected.has(provider.id) &&
          provider.source === 'config'
      )
      .flatMap((provider) =>
        Object.entries(provider.models ?? {}).flatMap(([key, model]) => {
          const modelId = boundedString(model.id) ?? boundedString(key);
          if (modelId === undefined) return [];
          const qualifiedModelId = `${provider.id}/${modelId}`;
          const context = model.limit?.context;
          return qualifiedModelId.length <= 128 &&
            Number.isSafeInteger(context) &&
            (context ?? 0) > 0
            ? [[qualifiedModelId, context!] as const]
            : [];
        })
      )
  );
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 4096 ? trimmed : undefined;
}
