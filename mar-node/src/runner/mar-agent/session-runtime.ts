import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { access, constants } from 'node:fs/promises';
import {
  LocalAgentHost,
  createMarAgent,
  type ToolApprovalRequest,
  type ToolApprovalDecision
} from '@myagentroam/agent';
import {
  marAgentRuntimeCompactConfigurationSchema,
  type MarAgentRuntimeModelConfiguration
} from '@myagentroam/protocol';
import { nodeExecutionEnvironment } from '../../node-execution-environment.js';
import { nodeLog } from '../../operational.js';
import {
  BUNDLED_RIPGREP_VERSION,
  bundledRipgrepPath,
  prependBundledRipgrepToPath
} from '../../ripgrep-binary.js';
import { canonicalJson } from '../../util/canonical-json.js';
import {
  compactRuntimeConfigurations,
  marAgentCompactExtensionSource,
  updateMarAgentCompactState,
  type MarAgentCompactState
} from './compact-extensions.js';
import { MarAgentConversationNormalizer } from './conversation-normalizer.js';
import { type MarAgentMcpClientCache, type MarAgentMcpClientLease } from './mcp-client-pool.js';
import {
  type MarAgentRuntimeModelFactory,
  type MarAgentRuntimeModel,
  sdkModelConfigurations
} from './runtime-model-factory.js';
import type { ResolvedMcpServer } from '../../mcp/model.js';

export interface MarAgentSessionRuntime {
  readonly runtimeId: string;
  readonly fingerprint: MarAgentHostFingerprint;
  readonly agent: Awaited<ReturnType<typeof createMarAgent>>;
  readonly session: Awaited<ReturnType<Awaited<ReturnType<typeof createMarAgent>>['openSession']>>;
  readonly host: LocalAgentHost;
  readonly normalizer: MarAgentConversationNormalizer;
  readonly mcpLease: MarAgentMcpClientLease;
  readonly releaseEnvironment: (() => void) | undefined;
  readonly automaticTitleEnabled: boolean;
  models: MarAgentRuntimeModel[];
  modelFingerprint: string;
  compactState: MarAgentCompactState;
  personalInstructions: string;
}

export interface MarAgentHostRuntimeConfiguration {
  readonly environment: NodeJS.ProcessEnv;
  readonly guaranteedCommands: Readonly<Record<string, string>>;
}

export const HOST_CONFIGURATION_CATEGORIES = [
  'cwd',
  'mcpServers',
  'environment',
  'guaranteedCommands'
] as const;
export type HostConfigurationCategory = (typeof HOST_CONFIGURATION_CATEGORIES)[number];
export interface MarAgentHostFingerprint {
  readonly value: string;
  readonly categories: Readonly<Record<HostConfigurationCategory, string>>;
}

export interface MarAgentRuntimeRequest {
  runId: string;
  sessionId: string;
  cwd: string;
  model: MarAgentRuntimeModelConfiguration;
  models: MarAgentRuntimeModelConfiguration[];
  compact?: unknown;
  runtimeScopeId?: string;
  mode: 'run' | 'plan' | 'compact';
  secretEnvironment?: Readonly<Record<string, string>>;
  externalSessionId?: string;
  personalInstructions?: string;
  mcpServers: readonly ResolvedMcpServer[];
}

type HostOptions = ConstructorParameters<typeof LocalAgentHost>[0];
export type NodeModelResourcePublisher = (
  image: Parameters<NonNullable<HostOptions['publishModelResource']>>[0],
  context: Parameters<NonNullable<HostOptions['publishModelResource']>>[1] & {
    ownerSessionId: string;
  }
) => ReturnType<NonNullable<HostOptions['publishModelResource']>>;
export interface MarAgentRuntimeResources {
  readonly mcpClients: MarAgentMcpClientCache;
  readonly createAgent: typeof createMarAgent;
  readonly modelFactory: Pick<MarAgentRuntimeModelFactory, 'create'>;
  readonly resourceIdleTtlMs: number;
  readonly retainEnvironment?: (environment: Readonly<Record<string, string>>) => () => void;
  readonly customTitle: (sessionId: string) => string | undefined;
  readonly modelUsage: (
    runId: string,
    usage: Parameters<NonNullable<HostOptions['modelUsage']>>[0]
  ) => void;
  readonly publishModelResource?: NodeModelResourcePublisher;
  readonly question: (
    runId: string,
    request: { requestId: string; questions: unknown[] },
    signal: AbortSignal
  ) => Promise<Record<string, unknown>>;
  readonly approval?: (
    runId: string,
    request: ToolApprovalRequest,
    signal: AbortSignal
  ) => Promise<ToolApprovalDecision>;
}

export async function createSessionRuntime(
  input: MarAgentRuntimeRequest,
  sessionKey: string,
  fingerprint: MarAgentHostFingerprint,
  hostConfiguration: MarAgentHostRuntimeConfiguration,
  dependencies: MarAgentRuntimeResources,
  currentRunId: () => string | undefined
): Promise<MarAgentSessionRuntime> {
  const sharedMcpServers = input.mcpServers.filter((server) => !isExecutionScopedMcp(server));
  const mcpLease = await dependencies.mcpClients.acquire(sharedMcpServers, input.cwd, {
    // Native Session IDs are assigned after the first lease; do not let that promotion
    // change a confirmed actor's discovery identity when its warm runtime is recreated.
    authorizationScope: input.secretEnvironment?.['MAR_USERNAME'] ? input.cwd : sessionKey
  });
  let agent: Awaited<ReturnType<typeof createMarAgent>> | undefined;
  let models: MarAgentRuntimeModel[] = [];
  let releaseEnvironment: (() => void) | undefined;
  try {
    releaseEnvironment = dependencies.retainEnvironment?.(input.secretEnvironment ?? {});
    const mcp = mcpLease.pool;
    const localHost = new LocalAgentHost({
      publishModelResource:
        dependencies.publishModelResource === undefined
          ? undefined
          : (image, context) =>
              dependencies.publishModelResource!(image, {
                ...context,
                ownerSessionId: input.sessionId
              }),
      modelUsage: (usage) => {
        const runId = currentRunId();
        if (runId !== undefined) dependencies.modelUsage(runId, usage);
      },
      mode: 'node',
      homeDirectory: homedir(),
      workspace: input.cwd,
      environment: hostConfiguration.environment,
      guaranteedCommands: hostConfiguration.guaranteedCommands,
      question: async (request, signal) => {
        const runId = currentRunId();
        return runId === undefined ? {} : dependencies.question(runId, request, signal);
      },
      approval: dependencies.approval
        ? (request, signal) => {
            const runId = currentRunId();
            if (runId === undefined) return Promise.resolve('REJECTED');
            return dependencies.approval!(runId, request, signal);
          }
        : undefined,
      mcpCatalog: () => mcp.catalog(),
      callMcp: async (call, signal, context) =>
        mcp.call(call.name, call.arguments, signal, context?.expectedTool),
      resourceIdleTtlMs: dependencies.resourceIdleTtlMs
    });
    models = dependencies.modelFactory.create(
      compactRuntimeConfigurations(input.models, input.compact),
      {
        ...(input.runtimeScopeId === undefined ? {} : { runtimeScopeId: input.runtimeScopeId }),
        executionId: input.runId
      }
    );
    const compactState: MarAgentCompactState = { revision: 0 };
    updateMarAgentCompactState(
      compactState,
      input.compact,
      models,
      input.models.map((model) => model.id)
    );
    agent = await dependencies.createAgent({
      mode: 'node',
      host: localHost,
      models: sdkModelConfigurations(
        models.filter((model) => input.models.some((candidate) => candidate.id === model.id))
      ),
      defaultModelId: input.model.id,
      runtimeExtensions: marAgentCompactExtensionSource(compactState),
      ...(input.personalInstructions ? { systemInstruction: input.personalInstructions } : {})
    });
    const customTitle = dependencies.customTitle(input.sessionId) ?? undefined;
    const session = input.externalSessionId
      ? await agent.openSession(input.externalSessionId)
      : await agent.createSession({
          workspace: input.cwd,
          ...(customTitle === undefined ? {} : { title: customTitle })
        });
    const runtime: MarAgentSessionRuntime = {
      runtimeId: randomUUID(),
      fingerprint,
      agent,
      session,
      host: localHost,
      normalizer: new MarAgentConversationNormalizer(),
      mcpLease,
      releaseEnvironment,
      automaticTitleEnabled: input.externalSessionId === undefined,
      models,
      compactState,
      modelFingerprint: sessionModelFingerprint(input),
      personalInstructions: input.personalInstructions ?? ''
    };
    return runtime;
  } catch (error) {
    for (const cleanup of [
      () => agent?.dispose(),
      () => closeModelCredentialProviders(models),
      () => mcpLease.release(),
      () => releaseEnvironment?.()
    ]) {
      try {
        await cleanup();
      } catch {
        nodeLog('runner.mar-agent.runtime.cleanup_failed', {
          sessionId: sessionKey,
          code: 'MAR_AGENT_RUNTIME_CLEANUP_FAILED',
          stage: 'creation_rollback'
        });
      }
    }
    throw error;
  }
}

export async function reconfigureSessionRuntime(
  existing: MarAgentSessionRuntime,
  input: MarAgentRuntimeRequest,
  modelFactory: MarAgentRuntimeResources['modelFactory']
): Promise<void> {
  const modelFingerprint = sessionModelFingerprint(input);
  const configurations = compactRuntimeConfigurations(input.models, input.compact);
  if (
    existing.modelFingerprint !== modelFingerprint ||
    configurations.some(
      (model) =>
        model.credential?.type === 'RUNTIME_TICKET' ||
        model.imageGeneration?.credential?.type === 'RUNTIME_TICKET'
    )
  ) {
    const models = modelFactory.create(configurations, {
      ...(input.runtimeScopeId === undefined ? {} : { runtimeScopeId: input.runtimeScopeId }),
      executionId: input.runId
    });
    try {
      await existing.agent.reconfigureModels({
        models: sdkModelConfigurations(
          models.filter((model) => input.models.some((candidate) => candidate.id === model.id))
        ),
        defaultModelId: input.model.id
      });
      existing.models = models;
      existing.modelFingerprint = modelFingerprint;
    } catch (error) {
      await closeModelCredentialProviders(models);
      throw error;
    }
  }
  const personalInstructions =
    input.personalInstructions ?? (input.mode === 'compact' ? existing.personalInstructions : '');
  if (existing.personalInstructions !== personalInstructions) {
    existing.agent.setSystemInstruction(personalInstructions || undefined);
    existing.personalInstructions = personalInstructions;
  }
  updateMarAgentCompactState(
    existing.compactState,
    input.compact,
    existing.models,
    input.models.map((model) => model.id)
  );
}

export async function releaseSessionRuntime(runtime: MarAgentSessionRuntime): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of [
    () => runtime.agent.dispose(),
    () => runtime.mcpLease.release(),
    () => runtime.releaseEnvironment?.()
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 1)
    nodeLog('runner.mar-agent.runtime.cleanup_failed', {
      sessionId: runtime.session.id,
      code: 'MAR_AGENT_RUNTIME_CLEANUP_FAILED',
      stage: 'resource_release'
    });
  if (failures.length > 0) throw failures[0];
}

export function isExecutionScopedMcp(
  server: import('../../mcp/model.js').ResolvedMcpServer
): boolean {
  return (
    server.lifecycle === 'EXECUTION' ||
    (server.transport === 'STDIO' && server.environment?.['MAR_CTL_USER_TOKEN'] !== undefined)
  );
}

export function sessionHostFingerprint(
  input: {
    cwd: string;
    mcpServers: readonly import('../../mcp/model.js').ResolvedMcpServer[];
  },
  hostConfiguration: MarAgentHostRuntimeConfiguration
): MarAgentHostFingerprint {
  const configuration = {
    cwd: input.cwd,
    mcpServers: input.mcpServers.filter((server) => !isExecutionScopedMcp(server)),
    environment: Object.entries(hostConfiguration.environment)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
    guaranteedCommands: Object.entries(hostConfiguration.guaranteedCommands).sort(
      ([left], [right]) => left.localeCompare(right)
    )
  };
  const digest = (value: unknown) =>
    createHash('sha256').update(canonicalJson(value)).digest('hex');
  return {
    value: digest(configuration),
    // Only fixed category names leave this comparison; never log these value fingerprints.
    categories: {
      cwd: digest(configuration.cwd),
      mcpServers: digest(configuration.mcpServers),
      environment: digest(configuration.environment),
      guaranteedCommands: digest(configuration.guaranteedCommands)
    }
  };
}

function sessionModelFingerprint(input: {
  compact?: unknown;
  model: MarAgentRuntimeModelConfiguration;
  models: readonly MarAgentRuntimeModelConfiguration[];
}): string {
  const compact = marAgentRuntimeCompactConfigurationSchema.safeParse(input.compact);
  return createHash('sha256')
    .update(
      JSON.stringify({
        defaultModelId: input.model.id,
        compact: compact.success
          ? {
              model: runtimeModelFingerprint(compact.data.model),
              effort: compact.data.reasoningEffort
            }
          : null,
        models: input.models.map(runtimeModelFingerprint)
      })
    )
    .digest('hex');
}

export async function resolveMarAgentHostRuntimeConfiguration(
  secretEnvironment: Readonly<Record<string, string>> = {}
): Promise<MarAgentHostRuntimeConfiguration> {
  const environment = nodeExecutionEnvironment({
    ...secretEnvironment,
    MAR_CTL_CONTEXT_REQUIRED: '1'
  });
  // CLI credentials are bound to each execution, never retained as Host configuration.
  delete environment['MAR_CTL_USER_TOKEN'];
  for (const key of [
    'MAR_CTL_NODE_ID',
    'MAR_CTL_WORKSPACE_ID',
    'MAR_CTL_SESSION_ID',
    'MAR_CTL_RUN_ID',
    'MAR_CTL_RUNNER'
  ])
    delete environment[key];
  const ripgrep = await availableBundledRipgrep();
  return {
    environment:
      ripgrep === undefined ? environment : prependBundledRipgrepToPath(environment, ripgrep),
    guaranteedCommands: ripgrep === undefined ? {} : { rg: BUNDLED_RIPGREP_VERSION }
  };
}

async function availableBundledRipgrep(): Promise<string | undefined> {
  try {
    const executable = bundledRipgrepPath();
    await access(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return executable;
  } catch {
    return undefined;
  }
}

function runtimeModelFingerprint(model: MarAgentRuntimeModelConfiguration): object {
  const { apiKey, credential, imageGeneration, ...configuration } = model;
  return {
    ...configuration,
    ...(imageGeneration === undefined
      ? {}
      : {
          imageGeneration: {
            ...imageGeneration,
            credential: runtimeCredentialFingerprint(imageGeneration.credential)
          }
        }),
    ...(apiKey === undefined
      ? {}
      : { apiKeyHash: createHash('sha256').update(apiKey).digest('hex') }),
    credential: runtimeCredentialFingerprint(credential)
  };
}

function runtimeCredentialFingerprint(
  credential: MarAgentRuntimeModelConfiguration['credential']
): object | undefined {
  return credential?.type === 'INLINE_API_KEY'
    ? {
        type: credential.type,
        valueHash: createHash('sha256').update(credential.value).digest('hex')
      }
    : credential === undefined
      ? undefined
      : {
          type: credential.type,
          credentialId: credential.credentialId
        };
}

async function closeModelCredentialProviders(
  models: readonly {
    readonly credentialProvider?: {
      close(): Promise<void>;
    };
    readonly imageGeneration?: {
      readonly credentialProvider?: { close(): Promise<void> };
    };
  }[]
): Promise<void> {
  await Promise.allSettled(
    [
      ...new Set(
        models.flatMap((model) => [
          ...(model.credentialProvider === undefined ? [] : [model.credentialProvider]),
          ...(model.imageGeneration?.credentialProvider === undefined
            ? []
            : [model.imageGeneration.credentialProvider])
        ])
      )
    ].map((provider) => provider.close())
  );
}
