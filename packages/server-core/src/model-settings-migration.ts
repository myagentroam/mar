import { createHash } from 'node:crypto';
import type { MarAgentModelSummary } from '@myagentroam/protocol';
import type { MysqlMigrationConnection } from './mysql-migration-contracts.js';
import {
  MODEL_SETTINGS_V1_XAI_BASE_URL,
  modelSettingsV1CredentialSchema,
  modelSettingsV1TierSchema,
  parseModelSettingsV1,
  validateModelSettingsTargetV1
} from './model-settings.js';

/** Resolve the legacy speed bit only at the migration boundary. */
export function normalizeLegacyModelTier(input: {
  readonly credentialType: 'INLINE_API_KEY' | 'CREDENTIAL_REF';
  readonly fastMode: boolean;
  readonly serviceTier: MarAgentModelSummary['serviceTier'] | null;
  readonly baseUrl: string;
}): MarAgentModelSummary['serviceTier'] {
  if (input.fastMode && input.credentialType !== 'CREDENTIAL_REF')
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  if (
    input.baseUrl === MODEL_SETTINGS_V1_XAI_BASE_URL &&
    input.credentialType === 'CREDENTIAL_REF' &&
    (input.fastMode || (input.serviceTier != null && input.serviceTier !== 'default'))
  )
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  return (
    input.serviceTier ??
    (input.fastMode
      ? 'priority'
      : input.credentialType === 'CREDENTIAL_REF'
        ? 'default'
        : undefined)
  );
}

const LEGACY_COLUMNS = [
  'fast_mode',
  'service_tier',
  'hosted_web_search',
  'responses_transport',
  'responses_previous_response_id'
] as const;
type LegacyColumn = (typeof LEGACY_COLUMNS)[number];
const EXPAND_KEY_SQL = 'ALTER TABLE system_settings MODIFY setting_key varchar(191) NOT NULL';
const settingKeyV1 = (id: string) => `mar_agent_model_config:${id}`;
const DROP_COLUMN_SQL = (column: LegacyColumn) =>
  `ALTER TABLE mar_agent_models DROP COLUMN \`${column}\``;
const V1_SPEC = {
  key: 'mar_agent_model_config:<id>',
  protocols: ['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'],
  version: 1,
  responses: [
    'hostedWebSearch:boolean',
    'serviceTier?:auto|default|flex|priority|fast|ultrafast',
    'responsesTransport?:WEBSOCKET|HTTP/1.1|HTTP/2',
    'responsesPreviousResponseId:boolean'
  ],
  anthropic: [],
  conversion:
    'tier-explicit-else-fast-priority-else-ref-default-else-absent;validate-v1-target;complete-backfill-before-drop;compare-remaining'
};
type Row = Record<string, unknown>;

function json(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8'));
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function flag(value: unknown): boolean {
  if (value !== 0 && value !== 1 && value !== false && value !== true)
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  return Boolean(value);
}

function legacyDocument(row: Row): unknown {
  const fastMode = flag(row['fast_mode']);
  const hostedWebSearch = flag(row['hosted_web_search']);
  const responsesPreviousResponseId = flag(row['responses_previous_response_id']);
  const rawTier = row['service_tier'];
  const tier = rawTier === null ? null : modelSettingsV1TierSchema.parse(rawTier);
  const transport =
    row['responses_transport'] === null ? undefined : json(row['responses_transport']);
  if (row['protocol'] === 'ANTHROPIC_MESSAGES') {
    if (
      fastMode ||
      hostedWebSearch ||
      responsesPreviousResponseId ||
      tier !== null ||
      transport !== undefined
    )
      throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
    return { version: 1 };
  }
  if (row['protocol'] !== 'OPENAI_RESPONSES') throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  const credential = modelSettingsV1CredentialSchema.parse(json(row['credential']));
  const serviceTier = normalizeLegacyModelTier({
    credentialType: credential.type,
    fastMode,
    serviceTier: tier,
    baseUrl: String(row['base_url'])
  });
  return {
    version: 1,
    hostedWebSearch,
    ...(serviceTier === undefined ? {} : { serviceTier }),
    ...(transport === undefined ? {} : { responsesTransport: transport }),
    responsesPreviousResponseId
  };
}

function compareRemaining(
  row: Row,
  settings: ReturnType<typeof parseModelSettingsV1>,
  columns: Set<string>
): void {
  const responses = 'hostedWebSearch' in settings ? settings : undefined;
  if (columns.has('fast_mode')) {
    const fastMode = flag(row['fast_mode']);
    const credential = modelSettingsV1CredentialSchema.parse(json(row['credential']));
    if (
      (responses === undefined && fastMode) ||
      (fastMode && credential.type !== 'CREDENTIAL_REF') ||
      (fastMode &&
        credential.type === 'CREDENTIAL_REF' &&
        row['base_url'] === MODEL_SETTINGS_V1_XAI_BASE_URL)
    )
      throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  }
  if (
    columns.has('hosted_web_search') &&
    flag(row['hosted_web_search']) !== (responses?.hostedWebSearch ?? false)
  )
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  if (
    columns.has('responses_previous_response_id') &&
    flag(row['responses_previous_response_id']) !==
      (responses?.responsesPreviousResponseId ?? false)
  )
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  if (columns.has('responses_transport')) {
    const old = row['responses_transport'] === null ? undefined : json(row['responses_transport']);
    const normalized =
      old === undefined
        ? undefined
        : parseModelSettingsV1('OPENAI_RESPONSES', {
            version: 1,
            hostedWebSearch: false,
            responsesPreviousResponseId: false,
            responsesTransport: old
          });
    const transport =
      normalized !== undefined && 'responsesTransport' in normalized
        ? normalized.responsesTransport
        : undefined;
    if (JSON.stringify(transport) !== JSON.stringify(responses?.responsesTransport))
      throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  }
  if (
    columns.has('service_tier') &&
    row['service_tier'] !== null &&
    row['service_tier'] !== responses?.serviceTier
  )
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  if (
    columns.has('fast_mode') &&
    columns.has('service_tier') &&
    row['service_tier'] === null &&
    responses !== undefined
  ) {
    const credential = modelSettingsV1CredentialSchema.parse(json(row['credential']));
    const expected = normalizeLegacyModelTier({
      credentialType: credential.type,
      fastMode: flag(row['fast_mode']),
      serviceTier: null,
      baseUrl: String(row['base_url'])
    });
    if (expected !== responses.serviceTier) throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  }
}

/** Recoverable backfill: all documents are validated and committed before the first model DDL. */
export const MODEL_SETTINGS_MIGRATION = {
  version: 34,
  name: 'model_protocol_settings',
  checksum: createHash('sha256')
    .update(
      JSON.stringify({
        expand: EXPAND_KEY_SQL,
        drops: LEGACY_COLUMNS.map(DROP_COLUMN_SQL),
        document: V1_SPEC
      })
    )
    .digest('hex'),
  async up(connection: MysqlMigrationConnection): Promise<void> {
    const [keyRows] = (await connection.execute(
      "SELECT CHARACTER_MAXIMUM_LENGTH AS length FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='system_settings' AND COLUMN_NAME='setting_key'"
    )) as [readonly { length: number }[], unknown];
    if (Number(keyRows[0]?.length) === 128) await connection.execute(EXPAND_KEY_SQL);
    else if (Number(keyRows[0]?.length) !== 191) throw new Error('SERVER_DATABASE_SCHEMA_MISMATCH');
    const [columnRows] = (await connection.execute(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mar_agent_models'"
    )) as [readonly { COLUMN_NAME: string }[], unknown];
    const columns = new Set(columnRows.map((row) => row.COLUMN_NAME));
    const remaining = LEGACY_COLUMNS.filter((column) => columns.has(column));
    await connection.query('START TRANSACTION');
    try {
      const selected = ['id', 'protocol', 'base_url', 'credential', ...remaining]
        .map((column) => `\`${column}\``)
        .join(',');
      const [rows] = (await connection.execute(
        `SELECT ${selected} FROM mar_agent_models FOR UPDATE`
      )) as [readonly Row[], unknown];
      for (const row of rows) {
        const id = String(row['id']);
        const protocol = row['protocol'] as MarAgentModelSummary['protocol'];
        const [found] = (await connection.execute(
          'SELECT setting_value FROM system_settings WHERE setting_key=? FOR UPDATE',
          [settingKeyV1(id)]
        )) as [readonly Row[], unknown];
        let settings: ReturnType<typeof parseModelSettingsV1>;
        if (found.length === 0) {
          if (remaining.length !== LEGACY_COLUMNS.length)
            throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
          settings = parseModelSettingsV1(protocol, legacyDocument(row));
          validateModelSettingsTargetV1(
            protocol,
            String(row['base_url']),
            json(row['credential']),
            settings
          );
          await connection.execute(
            'INSERT INTO system_settings (setting_key,setting_value,updated_at) VALUES (?,?,?)',
            [settingKeyV1(id), JSON.stringify(settings), Date.now()]
          );
        } else {
          settings = parseModelSettingsV1(protocol, json(found[0]!['setting_value']));
          validateModelSettingsTargetV1(
            protocol,
            String(row['base_url']),
            json(row['credential']),
            settings
          );
          if (remaining.length === LEGACY_COLUMNS.length) {
            const expected = parseModelSettingsV1(protocol, legacyDocument(row));
            if (JSON.stringify(settings) !== JSON.stringify(expected))
              throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
          } else compareRemaining(row, settings, columns);
        }
      }
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    }
    for (const column of remaining as LegacyColumn[])
      await connection.execute(DROP_COLUMN_SQL(column));
  }
};
