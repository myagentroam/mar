import { z } from 'zod';
import { AgentError } from '../error.js';

import { SecretValue, type ModelCredentialProvider } from '../network/credentials.js';
export { SecretValue } from '../network/credentials.js';
export type {
  ModelCredential,
  ModelCredentialAcquireReason,
  ModelCredentialProvider
} from '../network/credentials.js';

export type ResponsesTransport =
  | {
      readonly transport: 'HTTP';
      readonly httpVersion: '1.1' | '2';
    }
  | {
      readonly transport: 'WEBSOCKET';
    };

const rawResponsesTransportSchema = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('HTTP'), httpVersion: z.enum(['1.1', '2']) }).strip(),
  z.object({ transport: z.literal('WEBSOCKET') }).strip()
]);
export const agentReasoningEffortSchema = z.enum([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
]);
export type AgentReasoningEffort = z.infer<typeof agentReasoningEffortSchema>;

const modelFieldsSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    name: z.string().trim().min(1).max(128),
    protocol: z.enum(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES']),
    baseUrl: z.string().url(),
    apiKey: z.string().min(1).max(16_384),
    credentialProvider: z.never().optional(),
    credential: z.never().optional(),
    modelId: z.string().min(1).max(256),
    contextWindowTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    inputCapabilities: z.array(z.enum(['TEXT', 'IMAGE'])).min(1),
    outputCapabilities: z.tuple([z.literal('TEXT')]),
    reasoningEfforts: z.array(agentReasoningEffortSchema),
    defaultReasoningEffort: agentReasoningEffortSchema.optional(),
    conversationModel: z.boolean().optional().default(true),
    subagentModel: z.boolean().optional().default(false),
    titleGeneration: z.boolean().optional().default(false),
    codeMode: z.boolean().optional().default(false),
    useResourceUrl: z.boolean().optional().default(false),
    fastMode: z.boolean().optional(),
    serviceTier: z.enum(['auto', 'default', 'flex', 'priority', 'fast', 'ultrafast']).optional(),
    hostedWebSearch: z.boolean(),
    responsesTransport: rawResponsesTransportSchema.optional(),
    responsesToolNamespace: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u)
      .optional(),
    responsesPreviousResponseId: z.boolean().optional().default(false),
    responsesConfigurationUpdates: z.boolean().optional(),
    responsesOptionalParameters: z
      .object({
        reasoningEffort: z.boolean(),
        reasoningSummary: z.boolean(),
        textVerbosity: z.boolean(),
        promptCacheKey: z.boolean(),
        nativeTools: z.boolean().optional()
      })
      .strip()
      .optional(),
    enabled: z.boolean()
  })
  .strip();

function validateModelFields(
  value: Omit<z.infer<typeof modelFieldsSchema>, 'apiKey' | 'credentialProvider'>,
  context: z.RefinementCtx
) {
  if (!value.inputCapabilities.includes('TEXT'))
    context.addIssue({ code: 'custom', message: 'TEXT input capability is required.' });
  if (value.maxOutputTokens >= value.contextWindowTokens)
    context.addIssue({
      code: 'custom',
      message: 'Output limit must be smaller than context window.'
    });
  if (value.protocol === 'ANTHROPIC_MESSAGES' && value.hostedWebSearch)
    context.addIssue({
      code: 'custom',
      message: 'Hosted Web is not declared by the Anthropic Messages compatibility adapter.'
    });
  if (value.protocol !== 'OPENAI_RESPONSES' && value.responsesPreviousResponseId)
    context.addIssue({ code: 'custom', message: 'Responses continuation requires Responses.' });
  if (value.protocol !== 'OPENAI_RESPONSES' && value.responsesTransport !== undefined)
    context.addIssue({ code: 'custom', message: 'Responses transport requires Responses.' });
  if (value.protocol !== 'OPENAI_RESPONSES' && value.responsesConfigurationUpdates !== undefined)
    context.addIssue({
      code: 'custom',
      message: 'Responses configuration updates require Responses.'
    });
  if (value.responsesToolNamespace !== undefined && value.protocol !== 'OPENAI_RESPONSES')
    context.addIssue({
      code: 'custom',
      path: ['responsesToolNamespace'],
      message: 'Tool namespaces require Standard OpenAI Responses.'
    });
  if (value.protocol !== 'OPENAI_RESPONSES' && value.fastMode === true)
    context.addIssue({ code: 'custom', message: 'Fast mode requires Responses.' });
  if (value.protocol !== 'OPENAI_RESPONSES' && value.serviceTier !== undefined)
    context.addIssue({ code: 'custom', message: 'Service tier requires Responses.' });
}

const rawModelSchema = modelFieldsSchema
  .superRefine(validateModelFields)
  .superRefine((value, context) => {
    if (
      value.defaultReasoningEffort !== undefined &&
      value.reasoningEfforts.length > 0 &&
      !value.reasoningEfforts.includes(value.defaultReasoningEffort)
    )
      context.addIssue({
        code: 'custom',
        path: ['defaultReasoningEffort'],
        message: 'Default reasoning effort must be included in the exposed choices.'
      });
  });

const runtimeModelSchema = modelFieldsSchema
  .extend({
    // The direct SDK API accepts SecretValue or a live provider, not catalog strings.
    apiKey: z.instanceof(SecretValue).optional(),
    credentialProvider: z
      .custom<ModelCredentialProvider>(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          typeof (value as ModelCredentialProvider).acquire === 'function' &&
          typeof (value as ModelCredentialProvider).invalidate === 'function' &&
          typeof (value as ModelCredentialProvider).close === 'function'
      )
      .optional(),
    // The SDK does not apply the catalog's URL policy to direct model inputs.
    baseUrl: z.string()
  })
  .superRefine(validateModelFields)
  .superRefine((value, context) => {
    if ((value.apiKey === undefined) === (value.credentialProvider === undefined))
      context.addIssue({
        code: 'custom',
        message: 'Exactly one model credential source is required.'
      });
  });

export interface AgentModelConfiguration extends Omit<
  z.infer<typeof rawModelSchema>,
  | 'apiKey'
  | 'credential'
  | 'credentialProvider'
  | 'responsesPreviousResponseId'
  | 'responsesTransport'
  | 'conversationModel'
  | 'subagentModel'
  | 'useResourceUrl'
> {
  conversationModel?: boolean;
  subagentModel?: boolean;
  useResourceUrl?: boolean;
  apiKey?: SecretValue;
  credentialProvider?: ModelCredentialProvider;
  /** Whether this Responses endpoint accepts native configuration_update input items. */
  responsesConfigurationUpdates?: boolean;
  responsesTransport?: ResponsesTransport;
  responsesPreviousResponseId?: boolean;
}

export function usesResponsesConfigurationUpdates(
  model: Pick<AgentModelConfiguration, 'protocol' | 'responsesConfigurationUpdates'>
): boolean {
  return model.protocol === 'OPENAI_RESPONSES' && model.responsesConfigurationUpdates === true;
}

export interface ModelCatalog {
  version: 1;
  defaultModelId?: string;
  models: readonly AgentModelConfiguration[];
}

/** Validate and project a direct SDK model without copying credential objects. */
export function normalizeRuntimeModelConfiguration(input: unknown): AgentModelConfiguration {
  const parsed = runtimeModelSchema.safeParse(input);
  if (!parsed.success)
    throw new AgentError('MAR_AGENT_MODEL_CONFIG_INVALID', 'Model configuration is invalid.', {
      details: { issues: parsed.error.issues.map((issue) => issue.message) }
    });
  const {
    apiKey,
    credentialProvider,
    credential: _credential,
    responsesTransport,
    responsesConfigurationUpdates,
    ...model
  } = parsed.data;
  return {
    ...model,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(credentialProvider === undefined ? {} : { credentialProvider }),
    ...(responsesTransport === undefined ? {} : { responsesTransport }),
    ...(responsesConfigurationUpdates === undefined ? {} : { responsesConfigurationUpdates })
  };
}

export function resolveModelDefaultReasoningEffort(
  model: Pick<AgentModelConfiguration, 'defaultReasoningEffort' | 'reasoningEfforts'>
): AgentReasoningEffort {
  const configured = agentReasoningEffortSchema.safeParse(model.defaultReasoningEffort);
  if (
    configured.success &&
    (model.reasoningEfforts.length === 0 || model.reasoningEfforts.includes(configured.data))
  )
    return configured.data;
  return model.reasoningEfforts.includes('medium')
    ? 'medium'
    : (model.reasoningEfforts[0] ?? 'medium');
}

export function parseModelCatalog(
  input: unknown,
  options: { allowLoopbackHttp?: boolean } = {}
): ModelCatalog {
  const catalogSchema = z.object({
    version: z.literal(1),
    defaultModelId: z.string().optional(),
    models: z.array(rawModelSchema)
  });
  const parsed = catalogSchema.safeParse(input);
  if (!parsed.success)
    throw new AgentError('MAR_AGENT_MODEL_CONFIG_INVALID', 'Model catalog is invalid.', {
      details: { issues: parsed.error.issues.map((issue) => issue.message) }
    });

  const ids = new Set<string>();
  const names = new Set<string>();
  for (const model of parsed.data.models) {
    const url = new URL(model.baseUrl);
    const loopback =
      url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' && !(options.allowLoopbackHttp && loopback))
    )
      throw new AgentError('MAR_AGENT_MODEL_CONFIG_INVALID', 'Model base URL is not allowed.');
    const normalizedName = model.name.normalize('NFKC').toLocaleLowerCase('en-US');
    if (ids.has(model.id) || names.has(normalizedName))
      throw new AgentError(
        'MAR_AGENT_MODEL_CONFIG_INVALID',
        'Model identifiers and names must be unique.'
      );
    ids.add(model.id);
    names.add(normalizedName);
  }
  if (parsed.data.defaultModelId !== undefined && !ids.has(parsed.data.defaultModelId))
    throw new AgentError('MAR_AGENT_MODEL_CONFIG_INVALID', 'Default model does not exist.');

  return {
    version: 1,
    ...(parsed.data.defaultModelId === undefined
      ? {}
      : { defaultModelId: parsed.data.defaultModelId }),
    models: parsed.data.models.map(
      ({
        apiKey,
        responsesTransport,
        responsesConfigurationUpdates,
        credentialProvider: _provider,
        credential: _credential,
        ...model
      }) => ({
        ...model,
        apiKey: new SecretValue(apiKey),
        ...(responsesConfigurationUpdates === undefined ? {} : { responsesConfigurationUpdates }),
        ...(responsesTransport === undefined ? {} : { responsesTransport })
      })
    )
  };
}
