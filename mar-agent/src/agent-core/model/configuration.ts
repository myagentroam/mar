import { z } from 'zod';
import { MarAgentError } from '../error.js';

export class SecretValue {
  #value: string;

  constructor(value: string) {
    if (value.length === 0)
      throw new MarAgentError('MAR_AGENT_MODEL_CONFIG_INVALID', 'API key is required.');
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  toString(): string {
    return '[REDACTED]';
  }
}

export type ModelCredentialAcquireReason = 'REQUEST' | 'UNAUTHORIZED' | 'RECONNECT';

export interface ModelCredential {
  readonly revision: number;
  readonly expiresAt: number;
  readonly bearer: SecretValue;
  readonly headers: Readonly<Record<string, SecretValue | string>>;
  readonly socks5Url?: SecretValue;
}

export interface ModelCredentialProvider {
  acquire(reason: ModelCredentialAcquireReason): Promise<ModelCredential>;
  invalidate(revision: number): void | Promise<void>;
  close(): Promise<void>;
}

export type ResponsesTransport =
  | {
      readonly transport: 'HTTP';
      readonly httpVersion: '1.1' | '2';
    }
  | {
      readonly transport: 'WEBSOCKET';
    };

const rawResponsesTransportSchema = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('HTTP'), httpVersion: z.enum(['1.1', '2']) }).strict(),
  z.object({ transport: z.literal('WEBSOCKET') }).strict()
]);
export const marAgentReasoningEffortSchema = z.enum([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
]);
export type MarAgentReasoningEffort = z.infer<typeof marAgentReasoningEffortSchema>;

const rawModelSchema = z
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
    modelId: z.string().min(1).max(256),
    contextWindowTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    inputCapabilities: z.array(z.enum(['TEXT', 'IMAGE'])).min(1),
    outputCapabilities: z.tuple([z.literal('TEXT')]),
    reasoningEfforts: z.array(marAgentReasoningEffortSchema),
    defaultReasoningEffort: marAgentReasoningEffortSchema.optional(),
    conversationModel: z.boolean().optional().default(true),
    titleGeneration: z.boolean().optional().default(false),
    codeMode: z.boolean().optional().default(false),
    fastMode: z.boolean().optional(),
    serviceTier: z.enum(['auto', 'default', 'flex', 'priority', 'fast', 'ultrafast']).optional(),
    hostedWebSearch: z.boolean(),
    responsesTransport: rawResponsesTransportSchema.optional(),
    responsesToolNamespace: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u)
      .optional(),
    responsesPreviousResponseId: z.boolean().optional().default(false),
    responsesOptionalParameters: z
      .object({
        reasoningEffort: z.boolean(),
        reasoningSummary: z.boolean(),
        textVerbosity: z.boolean(),
        promptCacheKey: z.boolean(),
        nativeTools: z.boolean().optional()
      })
      .strict()
      .optional(),
    enabled: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.inputCapabilities.includes('TEXT'))
      context.addIssue({ code: 'custom', message: 'TEXT input capability is required.' });
    if (value.maxOutputTokens >= value.contextWindowTokens)
      context.addIssue({
        code: 'custom',
        message: 'Output limit must be smaller than context window.'
      });
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
    if (value.protocol === 'ANTHROPIC_MESSAGES' && value.hostedWebSearch)
      context.addIssue({
        code: 'custom',
        message: 'Hosted Web is not declared by the Anthropic Messages compatibility adapter.'
      });
    if (value.protocol !== 'OPENAI_RESPONSES' && value.responsesPreviousResponseId)
      context.addIssue({ code: 'custom', message: 'Responses continuation requires Responses.' });
    if (value.protocol !== 'OPENAI_RESPONSES' && value.responsesTransport !== undefined)
      context.addIssue({ code: 'custom', message: 'Responses transport requires Responses.' });
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
  });

export interface MarAgentModelConfiguration extends Omit<
  z.infer<typeof rawModelSchema>,
  'apiKey' | 'responsesPreviousResponseId' | 'responsesTransport' | 'conversationModel'
> {
  conversationModel?: boolean;
  apiKey?: SecretValue;
  credentialProvider?: ModelCredentialProvider;
  /** Whether this Responses endpoint accepts native configuration_update input items. */
  responsesConfigurationUpdates?: boolean;
  /** @deprecated Use responsesConfigurationUpdates. */
  codexCredential?: boolean;
  responsesTransport?: ResponsesTransport;
  responsesPreviousResponseId?: boolean;
}

export function supportsResponsesConfigurationUpdates(
  model: Pick<MarAgentModelConfiguration, 'responsesConfigurationUpdates' | 'codexCredential'>
): boolean {
  return model.responsesConfigurationUpdates ?? model.codexCredential === true;
}

export function usesResponsesConfigurationUpdates(
  model: Pick<
    MarAgentModelConfiguration,
    'protocol' | 'responsesConfigurationUpdates' | 'codexCredential'
  >
): boolean {
  return model.protocol === 'OPENAI_RESPONSES' && supportsResponsesConfigurationUpdates(model);
}

export interface ModelCatalog {
  version: 1;
  defaultModelId?: string;
  models: readonly MarAgentModelConfiguration[];
}

export function resolveModelDefaultReasoningEffort(
  model: Pick<MarAgentModelConfiguration, 'defaultReasoningEffort' | 'reasoningEfforts'>
): MarAgentReasoningEffort {
  const configured = marAgentReasoningEffortSchema.safeParse(model.defaultReasoningEffort);
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
    throw new MarAgentError('MAR_AGENT_MODEL_CONFIG_INVALID', 'Model catalog is invalid.', {
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
      throw new MarAgentError('MAR_AGENT_MODEL_CONFIG_INVALID', 'Model base URL is not allowed.');
    const normalizedName = model.name.normalize('NFKC').toLocaleLowerCase('en-US');
    if (ids.has(model.id) || names.has(normalizedName))
      throw new MarAgentError(
        'MAR_AGENT_MODEL_CONFIG_INVALID',
        'Model identifiers and names must be unique.'
      );
    ids.add(model.id);
    names.add(normalizedName);
  }
  if (parsed.data.defaultModelId !== undefined && !ids.has(parsed.data.defaultModelId))
    throw new MarAgentError('MAR_AGENT_MODEL_CONFIG_INVALID', 'Default model does not exist.');

  return {
    version: 1,
    ...(parsed.data.defaultModelId === undefined
      ? {}
      : { defaultModelId: parsed.data.defaultModelId }),
    models: parsed.data.models.map(({ apiKey, responsesTransport, ...model }) => ({
      ...model,
      apiKey: new SecretValue(apiKey),
      ...(responsesTransport === undefined ? {} : { responsesTransport })
    }))
  };
}
