import { createHash } from 'node:crypto';
import { mcpRuntimeDescriptorSchema } from '@myagentroam/protocol';
import { nodeExecutionEnvironment } from '../node-execution-environment.js';
import { canonicalJson } from '../util/canonical-json.js';
import type { ResolvedMcpServer } from './model.js';
import { assertMcpServerNames } from './naming.js';

export function resolveMcpServers(
  raw: unknown,
  secrets: Readonly<Record<string, string>>,
  executionServers: readonly ResolvedMcpServer[] = []
): readonly ResolvedMcpServer[] {
  const installations = Array.isArray(raw) ? raw : [];
  const marctlEnvironment = {
    MAR_USERNAME: secrets['MAR_USERNAME'] ?? '',
    ...(secrets['MAR_CTL_SERVER_URL'] === undefined
      ? {}
      : { MAR_CTL_SERVER_URL: secrets['MAR_CTL_SERVER_URL'] }),
    ...(secrets['MAR_CTL_USER_TOKEN'] === undefined
      ? {}
      : { MAR_CTL_USER_TOKEN: secrets['MAR_CTL_USER_TOKEN'] }),
    MAR_CTL_CONTEXT_REQUIRED: '1'
  };
  const mcpEnvironment = (provided: Readonly<Record<string, string>>) =>
    nodeExecutionEnvironment(
      { ...provided, ...marctlEnvironment },
      { PATH: process.env['PATH'], Path: process.env['Path'] }
    );
  const result: ResolvedMcpServer[] = [];
  for (const value of installations) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (typeof record['serverName'] !== 'string' || record['enabled'] !== true) continue;
    const runtime = mcpRuntimeDescriptorSchema.safeParse(record['runtime']);
    if (!runtime.success) continue;
    const configuration = isRecord(record['configuration']) ? record['configuration'] : {};
    const sourceIdentity = createHash('sha256')
      .update(
        canonicalJson({
          id: record['id'] ?? null,
          name: record['serverName'],
          runtime: runtime.data,
          configuration
        })
      )
      .digest('hex');
    const authorizationIdentity = secrets['MAR_USERNAME']?.trim() || undefined;
    const resolveReferences = (
      candidate: unknown
    ): Readonly<Record<string, string>> | undefined => {
      if (!isRecord(candidate)) return {};
      const result: Record<string, string> = {};
      for (const [name, reference] of Object.entries(candidate)) {
        if (!isRecord(reference) || typeof reference['secretName'] !== 'string') return undefined;
        const secret = secrets[reference['secretName']];
        if (secret === undefined) return undefined;
        result[name] = secret;
      }
      return result;
    };
    if (runtime.data.transport === 'STDIO') {
      const runtimeEnvironment = resolveReferences(runtime.data.environment);
      const configuredEnvironment = resolveReferences(configuration['environment']);
      if (runtimeEnvironment === undefined || configuredEnvironment === undefined) continue;
      result.push({
        name: record['serverName'],
        origin: 'USER',
        sourceIdentity,
        ...(authorizationIdentity === undefined ? {} : { authorizationIdentity }),
        transport: 'STDIO' as const,
        command: runtime.data.command,
        args: [
          ...runtime.data.args,
          ...(Array.isArray(configuration['arguments'])
            ? configuration['arguments'].filter((item): item is string => typeof item === 'string')
            : [])
        ],
        environment: mcpEnvironment({
          ...runtimeEnvironment,
          ...configuredEnvironment
        })
      });
    } else {
      const runtimeHeaders = resolveReferences(runtime.data.headers);
      const configuredHeaders = resolveReferences(configuration['headers']);
      if (runtimeHeaders === undefined || configuredHeaders === undefined) continue;
      result.push({
        name: record['serverName'],
        origin: 'USER',
        sourceIdentity,
        ...(authorizationIdentity === undefined ? {} : { authorizationIdentity }),
        transport: 'HTTP' as const,
        url: runtime.data.url,
        headers: {
          ...runtimeHeaders,
          ...configuredHeaders
        }
      });
    }
  }
  const servers = [
    ...result,
    ...executionServers.map((server) =>
      server.transport === 'STDIO'
        ? { ...server, environment: mcpEnvironment(server.environment ?? {}) }
        : server
    )
  ];
  assertMcpServerNames(servers);
  return servers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
