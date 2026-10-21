import type { Pool, RowDataPacket } from 'mysql2/promise';
import {
  marAgentCompactConfigurationSchema,
  type MarAgentCompactConfiguration,
  type MarAgentRuntimeCompactConfiguration,
  type MarAgentRuntimeModelConfiguration
} from '@myagentroam/protocol';
import type { MarAgentModelService } from './mar-agent-model-service.js';

const settingKey = 'mar_agent_compact';
const defaults: MarAgentCompactConfiguration = {
  enabled: false,
  modelId: null,
  reasoningEffort: null
};

/** Deployment-scoped settings owned by MAR Agent, not by the generic settings page. */
export class MarAgentCompactService {
  constructor(
    private readonly database: { readonly raw: Pick<Pool, 'execute'> },
    private readonly models: Pick<MarAgentModelService, 'listManagedForUser'>
  ) {}

  async read(): Promise<MarAgentCompactConfiguration> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT setting_value FROM system_settings WHERE setting_key=?',
      [settingKey]
    );
    if (rows.length === 0) return { ...defaults };
    try {
      const raw: unknown = rows[0]!['setting_value'];
      const value =
        typeof raw === 'string'
          ? JSON.parse(raw)
          : Buffer.isBuffer(raw)
            ? JSON.parse(raw.toString('utf8'))
            : raw;
      return marAgentCompactConfigurationSchema.parse(value);
    } catch {
      throw new Error('MAR_AGENT_COMPACT_CONFIG_INVALID');
    }
  }

  async write(userId: number, raw: unknown): Promise<MarAgentCompactConfiguration> {
    const parsed = marAgentCompactConfigurationSchema.safeParse(raw);
    if (!parsed.success) throw new Error('MAR_AGENT_COMPACT_CONFIG_INVALID');
    const configuration = parsed.data;
    if (configuration.enabled && configuration.modelId !== null) {
      const model = (await this.models.listManagedForUser(userId)).find(
        (candidate) => candidate.id === configuration.modelId
      );
      if (!model || (configuration.enabled && !model.enabled))
        throw new Error('MAR_AGENT_COMPACT_MODEL_UNAVAILABLE');
      if (
        configuration.reasoningEffort !== null &&
        !(model.reasoningEfforts.length === 0
          ? configuration.reasoningEffort === (model.defaultReasoningEffort ?? 'medium')
          : model.reasoningEfforts.includes(configuration.reasoningEffort))
      )
        throw new Error('MAR_AGENT_COMPACT_EFFORT_INVALID');
    }
    await this.database.raw.execute(
      `INSERT INTO system_settings (setting_key,setting_value,updated_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_at=VALUES(updated_at)`,
      [settingKey, JSON.stringify(configuration), Date.now()]
    );
    return configuration;
  }

  async runtime(
    models: readonly MarAgentRuntimeModelConfiguration[]
  ): Promise<MarAgentRuntimeCompactConfiguration | undefined> {
    try {
      const configuration = await this.read();
      if (
        !configuration.enabled ||
        configuration.modelId === null ||
        configuration.reasoningEffort === null
      )
        return undefined;
      const model = models.find(
        (candidate) => candidate.id === configuration.modelId && candidate.enabled
      );
      if (
        !model ||
        !(model.reasoningEfforts.length === 0
          ? configuration.reasoningEffort === (model.defaultReasoningEffort ?? 'medium')
          : model.reasoningEfforts.includes(configuration.reasoningEffort))
      )
        return undefined;
      return { model, reasoningEffort: configuration.reasoningEffort };
    } catch {
      // An unavailable optional compactor must not prevent an authorized main execution.
      return undefined;
    }
  }
}
