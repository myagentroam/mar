import type { Pool, RowDataPacket } from 'mysql2/promise';
import {
  promptCompletionConfigurationSchema,
  type PromptCompletionConfiguration
} from '@myagentroam/protocol';
import type { MarAgentModelService } from './mar-agent-model-service.js';

const settingKey = 'mar_agent_prompt_completion';
const defaultConfiguration: PromptCompletionConfiguration = {
  enabled: true,
  modelId: null,
  reasoningEffort: null
};
export class PromptCompletionSettings {
  constructor(
    private readonly pool: Pool,
    private readonly models: Pick<MarAgentModelService, 'listManagedForUser'>,
    private readonly now: () => number = Date.now
  ) {}

  async readConfiguration(): Promise<PromptCompletionConfiguration> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT setting_value FROM system_settings WHERE setting_key=?',
      [settingKey]
    );
    if (rows.length === 0) return { ...defaultConfiguration };
    try {
      const configuration = promptCompletionConfigurationSchema.parse(
        parseJson(rows[0]!['setting_value'])
      );
      return configuration;
    } catch {
      throw new Error('MAR_AGENT_PROMPT_COMPLETION_CONFIG_INVALID');
    }
  }

  async writeConfiguration(userId: number, raw: unknown): Promise<PromptCompletionConfiguration> {
    const parsed = promptCompletionConfigurationSchema.safeParse(raw);
    if (!parsed.success) throw new Error('MAR_AGENT_PROMPT_COMPLETION_CONFIG_INVALID');
    const configuration = parsed.data;
    if (configuration.enabled) {
      if (configuration.modelId === null || configuration.reasoningEffort === null)
        throw new Error('MAR_AGENT_PROMPT_COMPLETION_MODEL_REQUIRED');
      const model = (await this.models.listManagedForUser(userId)).find(
        (candidate) => candidate.id === configuration.modelId
      );
      if (!model || !model.enabled)
        throw new Error('MAR_AGENT_PROMPT_COMPLETION_MODEL_UNAVAILABLE');
      if (
        !(model.reasoningEfforts.length === 0
          ? configuration.reasoningEffort === (model.defaultReasoningEffort ?? 'medium')
          : model.reasoningEfforts.includes(configuration.reasoningEffort))
      )
        throw new Error('MAR_AGENT_PROMPT_COMPLETION_EFFORT_INVALID');
    }
    await this.pool.execute(
      `INSERT INTO system_settings (setting_key,setting_value,updated_at) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_at=VALUES(updated_at)`,
      [settingKey, JSON.stringify(configuration), this.now()]
    );
    return configuration;
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value === 'string') return JSON.parse(value);
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8'));
  return value;
}
