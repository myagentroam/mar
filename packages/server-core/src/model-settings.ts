import { z } from 'zod';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { MarAgentModelSummary } from '@myagentroam/protocol';

// These schemas are part of the released v34 conversion, not the evolving wire schema.
export const modelSettingsV1TierSchema = z.enum([
  'auto',
  'default',
  'flex',
  'priority',
  'fast',
  'ultrafast'
]);
export const modelSettingsV1CredentialSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('INLINE_API_KEY'), value: z.string().min(1).max(16_384) }).strict(),
  z
    .object({ type: z.literal('CREDENTIAL_REF'), credentialId: z.string().trim().min(1).max(128) })
    .strict()
]);
export const MODEL_SETTINGS_V1_XAI_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';

const transport = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('WEBSOCKET') }).strict(),
  z.object({ transport: z.literal('HTTP'), httpVersion: z.enum(['1.1', '2']) }).strict()
]);
const responses = z
  .object({
    version: z.literal(1),
    hostedWebSearch: z.boolean(),
    serviceTier: modelSettingsV1TierSchema.optional(),
    responsesTransport: transport.optional(),
    responsesPreviousResponseId: z.boolean()
  })
  .strict();
const anthropic = z.object({ version: z.literal(1) }).strict();
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CHATGPT_BASE_URL = 'https://api.openai.com/v1';

type ModelSettingsV1 = z.infer<typeof responses> | z.infer<typeof anthropic>;
export type ModelSettings = ModelSettingsV1 & { gcEnabled?: boolean; unifiedCompact?: boolean };
export const modelSettingsKey = (id: string): string => `mar_agent_model_config:${id}`;

type Executor = Pick<Pool | PoolConnection, 'execute'>;

/** Settings share the transaction and lifetime of their owning model. */
export class ModelSettingsStore {
  constructor(private readonly now: () => number = Date.now) {}

  async write(
    id: string,
    protocol: MarAgentModelSummary['protocol'],
    value: unknown,
    executor: Executor
  ): Promise<void> {
    const settings = parseModelSettings(protocol, value);
    await executor.execute(
      'INSERT INTO system_settings (setting_key,setting_value,updated_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_at=VALUES(updated_at)',
      [modelSettingsKey(id), JSON.stringify(settings), this.now()]
    );
  }

  async remove(id: string, executor: Executor): Promise<void> {
    await executor.execute('DELETE FROM system_settings WHERE setting_key=?', [
      modelSettingsKey(id)
    ]);
  }
}

/** Decode a document selected in the same SQL snapshot as its model row. */
export function parseStoredModelSettings(
  protocol: MarAgentModelSummary['protocol'],
  raw: unknown
): ModelSettings {
  if (raw === undefined || raw === null) throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  let value: unknown;
  try {
    value = Buffer.isBuffer(raw)
      ? JSON.parse(raw.toString('utf8'))
      : typeof raw === 'string'
        ? JSON.parse(raw)
        : raw;
  } catch {
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  }
  return parseModelSettings(protocol, value);
}

/** Validate the document against the protocol fact on its owning model. */
export function parseModelSettings(
  protocol: MarAgentModelSummary['protocol'],
  value: unknown
): ModelSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  const { gcEnabled, unifiedCompact, ...legacy } = value as Record<string, unknown>;
  if (gcEnabled !== undefined && typeof gcEnabled !== 'boolean')
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  if (unifiedCompact !== undefined && typeof unifiedCompact !== 'boolean')
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  return {
    ...parseModelSettingsV1(protocol, legacy),
    ...(gcEnabled === undefined ? {} : { gcEnabled }),
    ...(unifiedCompact === undefined ? {} : { unifiedCompact })
  };
}

/** Immutable v1 decoder shared with the v34 historical migration. */
export function parseModelSettingsV1(
  protocol: MarAgentModelSummary['protocol'],
  value: unknown
): ModelSettingsV1 {
  const schema =
    protocol === 'OPENAI_RESPONSES'
      ? responses
      : protocol === 'ANTHROPIC_MESSAGES'
        ? anthropic
        : undefined;
  const result = schema?.safeParse(value);
  if (result === undefined || !result.success) throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  return result.data;
}

/** Construct a document from the validated model input without copying the protocol fact. */
export function modelSettingsFromInput(model: {
  protocol: MarAgentModelSummary['protocol'];
  hostedWebSearch: boolean;
  serviceTier?: MarAgentModelSummary['serviceTier'] | undefined;
  responsesTransport?: MarAgentModelSummary['responsesTransport'] | undefined;
  responsesPreviousResponseId?: boolean | undefined;
  gcEnabled?: boolean | undefined;
  unifiedCompact?: boolean | undefined;
}): ModelSettings {
  if (model.protocol === 'ANTHROPIC_MESSAGES') {
    if (
      model.hostedWebSearch ||
      model.serviceTier !== undefined ||
      model.responsesTransport !== undefined ||
      model.responsesPreviousResponseId
    )
      throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
    return parseModelSettings(model.protocol, {
      version: 1,
      gcEnabled: model.gcEnabled ?? true,
      unifiedCompact: model.unifiedCompact ?? false
    });
  }
  return parseModelSettings(model.protocol, {
    version: 1,
    gcEnabled: model.gcEnabled ?? true,
    unifiedCompact: model.unifiedCompact ?? false,
    hostedWebSearch: model.hostedWebSearch,
    ...(model.serviceTier === undefined ? {} : { serviceTier: model.serviceTier }),
    ...(model.responsesTransport === undefined
      ? {}
      : { responsesTransport: model.responsesTransport }),
    responsesPreviousResponseId: model.responsesPreviousResponseId ?? false
  });
}

/** Check credential and endpoint constraints at a model persistence boundary. */
export function validateModelSettingsTarget(
  protocol: MarAgentModelSummary['protocol'],
  baseUrl: string,
  credential: unknown,
  settings: ModelSettings
): void {
  validateModelSettingsTargetV1(protocol, baseUrl, credential, settings);
}

/** Immutable v1 credential/target rules used by the v34 migration. */
export function validateModelSettingsTargetV1(
  protocol: MarAgentModelSummary['protocol'],
  baseUrl: string,
  credential: unknown,
  settings: ModelSettings
): void {
  const parsedCredential = modelSettingsV1CredentialSchema.safeParse(credential);
  if (!parsedCredential.success) throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  if (parsedCredential.data.type !== 'CREDENTIAL_REF') return;
  if (
    protocol !== 'OPENAI_RESPONSES' ||
    ![CODEX_BASE_URL, CHATGPT_BASE_URL, MODEL_SETTINGS_V1_XAI_BASE_URL].includes(baseUrl) ||
    !('hostedWebSearch' in settings)
  )
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  if (
    baseUrl === MODEL_SETTINGS_V1_XAI_BASE_URL &&
    ((settings.serviceTier !== undefined && settings.serviceTier !== 'default') ||
      (settings.responsesTransport?.transport !== 'WEBSOCKET' &&
        (settings.responsesTransport?.transport !== 'HTTP' ||
          settings.responsesTransport.httpVersion !== '1.1')))
  )
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
}
