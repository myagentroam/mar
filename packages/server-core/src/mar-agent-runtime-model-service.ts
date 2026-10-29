import { randomUUID } from 'node:crypto';
import {
  CHATGPT_RESOURCE,
  XAI_SUBSCRIPTION_BASE_URL,
  marAgentRuntimeModelConfigurationSchema,
  resolveMarAgentDefaultReasoningEffort,
  type MarAgentRuntimeCredentialCapability,
  type MarAgentRuntimeModelConfiguration,
  type MarAgentStoredModelConfiguration,
  type RuntimeCredentialTicket
} from '@myagentroam/protocol';
import type { MarAgentModelService } from './mar-agent-model-service.js';
import type { RuntimeCredentialService } from './runtime-credential-service.js';
import type { ImageGenerationConfigurationService } from './image-generation-configuration-service.js';
import type { MarAgentCompactService } from './mar-agent-compact-service.js';
export { MarAgentCompactService } from './mar-agent-compact-service.js';
import type { MarAgentRuntimeCompactConfiguration } from '@myagentroam/protocol';

interface MarAgentRuntimeModelServiceOptions {
  readonly compact?: Pick<MarAgentCompactService, 'runtime'>;
  readonly models: Pick<MarAgentModelService, 'storedConfigurationsForUser'> &
    Partial<Pick<MarAgentModelService, 'stored' | 'resourceInputEnabled'>>;
  readonly imageGeneration?: Pick<ImageGenerationConfigurationService, 'forUser'>;
  readonly tickets: Pick<RuntimeCredentialService, 'issue'>;
  readonly capability: (nodeId: string) => MarAgentRuntimeCredentialCapability | undefined;
  readonly id?: () => string;
}

interface RuntimeModelContext {
  readonly userId: number;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly sessionId?: string;
  readonly selectedModelId?: string;
}

interface ModelTransportTestContext {
  readonly userId: number;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly modelId: string;
}

export interface PreparedMarAgentRuntimeModels {
  readonly compact?: MarAgentRuntimeCompactConfiguration;
  readonly runtimeScopeId: string;
  readonly model?: MarAgentRuntimeModelConfiguration;
  readonly models: readonly MarAgentRuntimeModelConfiguration[];
}

export class MarAgentRuntimeModelService {
  readonly compact: MarAgentRuntimeModelServiceOptions['compact'];
  readonly #models: MarAgentRuntimeModelServiceOptions['models'];
  readonly #imageGeneration: MarAgentRuntimeModelServiceOptions['imageGeneration'];
  readonly #tickets: MarAgentRuntimeModelServiceOptions['tickets'];
  readonly #capability: MarAgentRuntimeModelServiceOptions['capability'];
  readonly #id: () => string;

  constructor(options: MarAgentRuntimeModelServiceOptions) {
    this.compact = options.compact;
    this.#models = options.models;
    this.#imageGeneration = options.imageGeneration;
    this.#tickets = options.tickets;
    this.#capability = options.capability;
    this.#id = options.id ?? randomUUID;
  }

  async prepare(context: RuntimeModelContext): Promise<PreparedMarAgentRuntimeModels> {
    const stored = await this.#models.storedConfigurationsForUser(context.userId);
    const resourceUrlsEnabled = (await this.#models.resourceInputEnabled?.()) ?? true;
    const selected =
      context.selectedModelId === undefined
        ? undefined
        : stored.find((model) => model.id === context.selectedModelId);
    if (context.selectedModelId !== undefined && selected === undefined)
      throw new Error('MAR_AGENT_MODEL_FORBIDDEN');
    if (selected !== undefined && (!selected.enabled || selected.conversationModel === false))
      throw new Error('MAR_AGENT_MODEL_DISABLED');
    const runtimeScopeId = this.#id();
    const capability = this.#capability(context.nodeId);
    if (
      stored.some((model) => model.conversationModel === false) &&
      capability?.conversationModels !== true
    )
      throw Object.assign(new Error('CAPABILITY_VERSION_UNSUPPORTED'), {
        publicMessage: 'Upgrade this Node to use a model catalog containing auxiliary-only models.'
      });
    const grouped = groupCredentialModels(stored);
    const tickets = new Map<string, RuntimeCredentialTicket>();
    for (const [credentialId, models] of grouped) {
      if (capability?.apiVersion !== 1)
        throw new Error('MAR_AGENT_RUNTIME_CREDENTIALS_UNSUPPORTED');
      for (const model of models) assertTransportAvailable(model, capability);
      tickets.set(
        credentialId,
        await this.#tickets.issue({
          userId: context.userId,
          credentialId,
          nodeId: context.nodeId,
          workspaceId: context.workspaceId,
          ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
          runtimeScopeId,
          allowedModelIds: models.map((model) => model.id)
        })
      );
    }
    const imageGeneration = await this.#prepareImageGeneration(context, runtimeScopeId);
    const models = stored.map((model) =>
      runtimeModel(
        model,
        model.credential.type === 'CREDENTIAL_REF'
          ? tickets.get(model.credential.credentialId)
          : undefined,
        imageGeneration,
        capability,
        resourceUrlsEnabled
      )
    );
    const compact = await this.compact?.runtime(models);
    return {
      runtimeScopeId,
      ...(compact === undefined ? {} : { compact }),
      ...(selected === undefined
        ? {}
        : { model: models.find((model) => model.id === selected.id)! }),
      models
    };
  }

  async preparePromptCompletion(
    context: RuntimeModelContext & { readonly selectedModelId: string }
  ): Promise<{
    readonly runtimeScopeId: string;
    readonly model: MarAgentRuntimeModelConfiguration;
  }> {
    const available = await this.#models.storedConfigurationsForUser(context.userId);
    const model = available.find((value) => value.id === context.selectedModelId && value.enabled);
    if (!model) throw new Error('MAR_AGENT_MODEL_FORBIDDEN');
    const capability = this.#capability(context.nodeId);
    const runtimeScopeId = this.#id();
    let ticket: RuntimeCredentialTicket | undefined;
    if (model.credential.type === 'CREDENTIAL_REF') {
      if (capability?.apiVersion !== 1)
        throw new Error('MAR_AGENT_RUNTIME_CREDENTIALS_UNSUPPORTED');
      assertTransportAvailable(model, capability);
      ticket = await this.#tickets.issue({
        userId: context.userId,
        credentialId: model.credential.credentialId,
        nodeId: context.nodeId,
        workspaceId: context.workspaceId,
        ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
        runtimeScopeId,
        allowedModelIds: [model.id]
      });
    }
    // Auxiliary generation has no image, Compact, child-agent or unrelated model authority.
    return { runtimeScopeId, model: runtimeModel(model, ticket, undefined, capability, false) };
  }

  async prepareTest(context: ModelTransportTestContext): Promise<{
    readonly runtimeScopeId: string;
    readonly model: MarAgentRuntimeModelConfiguration;
  }> {
    if (this.#models.stored === undefined)
      throw new Error('MAR_AGENT_MODEL_TEST_CONFIGURATION_UNAVAILABLE');
    const model = await this.#models.stored(context.modelId);
    if (!model.enabled) throw new Error('MAR_AGENT_MODEL_DISABLED');
    const capability = this.#capability(context.nodeId);
    if (capability?.apiVersion !== 1) throw new Error('MAR_AGENT_RUNTIME_CREDENTIALS_UNSUPPORTED');
    if (model.credential.type === 'CREDENTIAL_REF') assertTransportAvailable(model, capability);
    const runtimeScopeId = this.#id();
    const ticket =
      model.credential.type === 'CREDENTIAL_REF'
        ? await this.#tickets.issue({
            userId: context.userId,
            credentialId: model.credential.credentialId,
            nodeId: context.nodeId,
            workspaceId: context.workspaceId,
            runtimeScopeId,
            allowedModelIds: [model.id]
          })
        : undefined;
    return {
      runtimeScopeId,
      model: runtimeModel(
        model,
        ticket,
        undefined,
        capability,
        (await this.#models.resourceInputEnabled?.()) ?? true
      )
    };
  }

  async #prepareImageGeneration(context: RuntimeModelContext, runtimeScopeId: string) {
    const configuration = await this.#imageGeneration?.forUser(context.userId);
    if (configuration === undefined || configuration === null) return undefined;
    if (configuration.provider === 'BYTED_ARK') {
      if (!configuration.config.url) return undefined;
      if (!configuration.config.apiKey)
        throw new Error('MAR_AGENT_IMAGE_GENERATION_API_KEY_REQUIRED');
      return {
        provider: configuration.provider,
        config: { modelId: configuration.config.modelId },
        generateEndpoint: configuration.config.url,
        editEndpoint: configuration.config.url,
        imageModelId: configuration.config.modelId,
        httpVersion: '1.1' as const,
        credential: { type: 'INLINE_API_KEY' as const, value: configuration.config.apiKey }
      };
    }
    const capability = this.#capability(context.nodeId);
    if (capability?.apiVersion !== 1) throw new Error('MAR_AGENT_RUNTIME_CREDENTIALS_UNSUPPORTED');
    if (!capability.httpVersions.includes('1.1'))
      throw new Error('MAR_AGENT_MODEL_HTTP1_UNAVAILABLE');
    const ticket = await this.#tickets.issue({
      userId: context.userId,
      credentialId: configuration.config.credentialId,
      nodeId: context.nodeId,
      workspaceId: context.workspaceId,
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      runtimeScopeId,
      allowedModelIds: ['image-generation'],
      purpose: 'IMAGE_GENERATION'
    });
    return {
      provider: configuration.provider,
      config: configuration.config,
      generateEndpoint: 'https://chatgpt.com/backend-api/codex/images/generations',
      editEndpoint: 'https://chatgpt.com/backend-api/codex/images/edits',
      imageModelId: configuration.config.modelId,
      httpVersion: '1.1' as const,
      credential: {
        type: 'RUNTIME_TICKET' as const,
        credentialId: configuration.config.credentialId,
        ticket
      }
    };
  }
}

function groupCredentialModels(
  models: readonly MarAgentStoredModelConfiguration[]
): Map<string, MarAgentStoredModelConfiguration[]> {
  const grouped = new Map<string, MarAgentStoredModelConfiguration[]>();
  for (const model of models) {
    if (model.credential.type !== 'CREDENTIAL_REF') continue;
    const group = grouped.get(model.credential.credentialId) ?? [];
    group.push(model);
    grouped.set(model.credential.credentialId, group);
  }
  return grouped;
}

function assertTransportAvailable(
  model: MarAgentStoredModelConfiguration,
  capability: MarAgentRuntimeCredentialCapability
): void {
  if (
    model.baseUrl === XAI_SUBSCRIPTION_BASE_URL &&
    capability.responsesOptionalParameters !== true
  )
    throw new Error('MAR_AGENT_RUNTIME_CREDENTIALS_UNSUPPORTED');
  if (
    model.baseUrl === CHATGPT_RESOURCE &&
    model.credential.type === 'CREDENTIAL_REF' &&
    capability.namespacedTools !== true
  )
    throw new Error('MAR_AGENT_RUNTIME_CREDENTIALS_UNSUPPORTED');
  const transport = model.responsesTransport;
  if (transport === undefined) throw new Error('MAR_AGENT_MODEL_TRANSPORT_INVALID');
  if (transport.transport === 'WEBSOCKET') {
    if (!capability.websocket) throw new Error('MAR_AGENT_MODEL_WEBSOCKET_UNAVAILABLE');
    return;
  }
  if (!capability.httpVersions.includes(transport.httpVersion))
    throw new Error(
      transport.httpVersion === '2'
        ? 'MAR_AGENT_MODEL_HTTP2_UNAVAILABLE'
        : 'MAR_AGENT_MODEL_HTTP1_UNAVAILABLE'
    );
}

function runtimeModel(
  model: MarAgentStoredModelConfiguration,
  ticket: RuntimeCredentialTicket | undefined,
  imageGeneration: MarAgentRuntimeModelConfiguration['imageGeneration'],
  capability: MarAgentRuntimeCredentialCapability | undefined,
  resourceUrlsEnabled: boolean = true
): MarAgentRuntimeModelConfiguration {
  if (model.inputCapabilities.includes('IMAGE') && capability?.resourceInput !== true)
    throw new Error('MAR_AGENT_MODEL_RESOURCE_INPUT_UNAVAILABLE');
  const responses = model.protocol === 'OPENAI_RESPONSES';
  if (
    responses &&
    model.responsesPreviousResponseId &&
    model.responsesTransport?.transport !== 'WEBSOCKET' &&
    capability?.responsesHttpContinuation !== true
  )
    throw new Error('MAR_AGENT_MODEL_HTTP_CONTINUATION_UNAVAILABLE');
  if (
    responses &&
    model.credential.type === 'INLINE_API_KEY' &&
    model.responsesTransport !== undefined
  ) {
    if (capability === undefined) throw new Error('MAR_AGENT_MODEL_TRANSPORT_INVALID');
    assertTransportAvailable(model, capability);
  }
  const grok =
    model.baseUrl === XAI_SUBSCRIPTION_BASE_URL && model.credential.type === 'CREDENTIAL_REF';
  const serviceTier = grok ? undefined : model.serviceTier;
  const supportsTier =
    serviceTier !== undefined && capability?.serviceTiers?.includes(serviceTier) === true;
  if (serviceTier !== undefined && serviceTier !== 'default' && !supportsTier)
    throw new Error('MAR_AGENT_MODEL_SERVICE_TIER_UNAVAILABLE');
  return marAgentRuntimeModelConfigurationSchema.parse({
    id: model.id,
    name: model.name,
    protocol: model.protocol,
    baseUrl: model.baseUrl,
    ...(model.credential.type === 'INLINE_API_KEY'
      ? { credential: { type: 'INLINE_API_KEY', value: model.credential.value } }
      : {
          credential: {
            type: 'RUNTIME_TICKET',
            credentialId: model.credential.credentialId,
            ticket
          }
        }),
    modelId: model.modelId,
    contextWindowTokens: model.contextWindowTokens,
    maxOutputTokens: model.maxOutputTokens,
    inputCapabilities: model.inputCapabilities,
    outputCapabilities: model.outputCapabilities,
    reasoningEfforts: model.reasoningEfforts,
    defaultReasoningEffort: resolveMarAgentDefaultReasoningEffort(
      model.defaultReasoningEffort,
      model.reasoningEfforts
    ),
    conversationModel: model.conversationModel ?? true,
    subagentModel: model.subagentModel ?? false,
    titleGeneration: model.titleGeneration,
    codeMode: model.codeMode,
    ...(supportsTier ? { serviceTier } : {}),
    hostedWebSearch: model.hostedWebSearch,
    useResourceUrl: resourceUrlsEnabled && model.metadata?.useResourceUrl === true,
    ...(model.responsesTransport === undefined
      ? {}
      : { responsesTransport: model.responsesTransport }),
    ...(model.credential.type === 'CREDENTIAL_REF'
      ? { responsesConfigurationUpdates: model.baseUrl !== CHATGPT_RESOURCE && !grok }
      : {}),
    ...(grok
      ? {
          responsesOptionalParameters: {
            reasoningEffort: model.reasoningEfforts.length > 0,
            reasoningSummary: false,
            textVerbosity: false,
            promptCacheKey: false,
            nativeTools: false
          }
        }
      : {}),
    ...(model.baseUrl === CHATGPT_RESOURCE && model.credential.type === 'CREDENTIAL_REF'
      ? { responsesToolNamespace: 'mar' }
      : {}),
    responsesPreviousResponseId: model.responsesPreviousResponseId,
    ...(imageGeneration === undefined ? {} : { imageGeneration }),
    enabled: model.enabled
  });
}
