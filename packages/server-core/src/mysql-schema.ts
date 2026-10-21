import { MODEL_USAGE_MIGRATION, MODEL_USAGE_SQL } from './model-usage-schema.js';
import schema from './mysql-core-schema-v1.json' with { type: 'json' };
import hostedSchema from './mysql-hosted-schema-v2.json' with { type: 'json' };
import gitSchema from './mysql-git-schema-v3.json' with { type: 'json' };
import workspaceGroupsSchema from './mysql-workspace-groups-schema-v4.json' with { type: 'json' };
import highDensityCompactionSchema from './mysql-high-density-compaction-schema-v5.json' with { type: 'json' };
import modelOrderSchema from './mysql-model-order-schema-v6.json' with { type: 'json' };
import fastModeSchema from './mysql-fast-mode-schema-v7.json' with { type: 'json' };
import modelResourcesSchema from './mysql-model-resources-schema-v8.json' with { type: 'json' };
import { MYSQL_PROMPT_COMPLETION_SCHEMA } from './mysql-prompt-completion-schema.js';
import { MYSQL_WEB_PUSH_SCHEMA } from './mysql-web-push-schema.js';
import {
  MYSQL_SESSION_SHARES_SCHEMA,
  MYSQL_SESSION_SHARES_CURRENT_SCHEMA
} from './mysql-session-shares-schema.js';
import {
  NOTIFICATION_CHANNELS_MIGRATION,
  AGENT_NOTIFICATION_KIND
} from './mysql-notification-channels-migration.js';
import { createMysqlBaselineMigration, type MysqlSchema } from './mysql-schema-support.js';
import { createHash } from 'node:crypto';
import { projectCredentialDocument } from './credential-document.js';
import {
  validateMysqlSchema,
  mysqlSchemaWithoutForeignKeys,
  removeMysqlForeignKeys,
  validateMysqlReferences,
  assertMysqlNoForeignKeys
} from './mysql-schema-support.js';
import { mailTemplatesZhCN } from './i18n/mail-templates.zh-CN.js';
import { mailTemplatesEnUS } from './i18n/mail-templates.en-US.js';

// Core v9 freezes the complete common installation schema. New changes must use Core v10+.
export const CORE_MYSQL_BASELINE_VERSION = 9;
export const CORE_MYSQL_SCHEMA_V9: MysqlSchema = {
  ...schema,
  ...hostedSchema,
  ...gitSchema,
  ...workspaceGroupsSchema,
  ...highDensityCompactionSchema,
  ...modelOrderSchema,
  ...fastModeSchema,
  ...modelResourcesSchema
};
const scheduleNotificationSql = `ALTER TABLE workbench_notifications MODIFY kind enum('run','approval','plan','user-input','schedule') NOT NULL`;
const MARCTL_MANAGEMENT_KEY_SQL =
  "UPDATE system_settings SET setting_key='marctl_management_key' WHERE setting_key='marmgr_management_key'";
const SERVICE_TIER_COLUMN =
  "enum('auto','default','flex','priority','fast','ultrafast') DEFAULT NULL";
const SERVICE_TIER_ADD_SQL = `ALTER TABLE mar_agent_models ADD COLUMN service_tier ${SERVICE_TIER_COLUMN}`;
const RESPONSES_ENCODING_DROP_SQL = 'ALTER TABLE mar_agent_models DROP COLUMN responses_encoding';
const HIGH_DENSITY_COMPACTION_DROP_SQL =
  'ALTER TABLE mar_agent_models DROP COLUMN high_density_compaction';
const SERVICE_TIER_BACKFILL_SQL = `UPDATE mar_agent_models SET service_tier = CASE
  WHEN fast_mode = 1 THEN 'priority'
  ELSE 'default'
  END WHERE service_tier IS NULL AND protocol = 'OPENAI_RESPONSES'`;
const MAIL_TEMPLATES_SQL = `CREATE TABLE \`mail_templates\` (
  \`id\` varchar(64) NOT NULL,
  \`kind\` enum('TEST','NOTIFICATION') NOT NULL,
  \`locale\` enum('zh-CN','en-US') NOT NULL,
  \`name\` varchar(128) NOT NULL,
  \`subject\` varchar(256) NOT NULL,
  \`body\` text NOT NULL,
  \`revision\` bigint NOT NULL DEFAULT '1',
  \`is_default\` tinyint(1) NOT NULL DEFAULT '0',
  \`created_at\` bigint NOT NULL,
  \`updated_at\` bigint NOT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`mail_templates_kind\` (\`kind\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;
const MAIL_DELIVERIES_SQL = `CREATE TABLE \`mail_deliveries\` (
  \`source_key\` char(64) NOT NULL,
  \`payload_hash\` char(64) NOT NULL,
  \`user_id\` bigint unsigned NOT NULL,
  \`node_id\` varchar(128) NOT NULL,
  \`execution_id\` varchar(128) NOT NULL,
  \`call_id\` varchar(128) NOT NULL,
  \`status\` enum('UNKNOWN','SENT') NOT NULL DEFAULT 'UNKNOWN',
  \`created_at\` bigint NOT NULL,
  PRIMARY KEY (\`source_key\`),
  KEY \`mail_deliveries_user_execution\` (\`user_id\`,\`execution_id\`),
  CONSTRAINT \`mail_deliveries_user_fk\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;
const LEGACY_DEFAULT_MAIL_TEMPLATES = [
  { id: 'test-zh-CN', kind: 'TEST', locale: 'zh-CN', ...mailTemplatesZhCN.test },
  { id: 'test-en-US', kind: 'TEST', locale: 'en-US', ...mailTemplatesEnUS.test },
  {
    id: 'notification-zh-CN',
    kind: 'NOTIFICATION',
    locale: 'zh-CN',
    ...mailTemplatesZhCN.legacyNotification
  },
  {
    id: 'notification-en-US',
    kind: 'NOTIFICATION',
    locale: 'en-US',
    ...mailTemplatesEnUS.legacyNotification
  }
] as const;
const DEFAULT_MAIL_TEMPLATES = [
  { id: 'test-zh-CN', kind: 'TEST', locale: 'zh-CN', ...mailTemplatesZhCN.test },
  { id: 'test-en-US', kind: 'TEST', locale: 'en-US', ...mailTemplatesEnUS.test },
  {
    id: 'notification-zh-CN',
    kind: 'NOTIFICATION',
    locale: 'zh-CN',
    ...mailTemplatesZhCN.notification
  },
  {
    id: 'notification-en-US',
    kind: 'NOTIFICATION',
    locale: 'en-US',
    ...mailTemplatesEnUS.notification
  }
] as const;
const MAIL_TEMPLATE_CONTENT_UPDATE_SQL =
  'UPDATE mail_templates SET subject=?,body=?,revision=revision+1,updated_at=? WHERE id=? AND is_default=1';
const WORKSPACE_SECRET_OWNER_CHECK =
  "((((`scope` = _utf8mb4'PERSONAL') and (`owner_user_id` is not null) and (`organization_id` is null) and (`node_id` is null) and (`workspace_id` is null)) or ((`scope` = _utf8mb4'ORGANIZATION') and (`owner_user_id` is null) and (`organization_id` is not null) and (`node_id` is null) and (`workspace_id` is null)) or ((`scope` = _utf8mb4'NODE') and (`owner_user_id` is null) and (`organization_id` is null) and (`node_id` is not null) and (`workspace_id` is null)) or ((`scope` = _utf8mb4'WORKSPACE') and (`owner_user_id` is null) and (`organization_id` is null) and (`node_id` is not null) and (`workspace_id` is not null))))";
const WORKSPACE_SECRET_SCHEMA = CORE_MYSQL_SCHEMA_V9['environment_secrets']!.replace(
  "enum('PERSONAL','ORGANIZATION','NODE')",
  "enum('PERSONAL','ORGANIZATION','NODE','WORKSPACE')"
)
  .replace(
    '  `node_id` varchar(128) DEFAULT NULL,',
    '  `node_id` varchar(128) DEFAULT NULL,\n  `workspace_id` varchar(128) DEFAULT NULL,'
  )
  .replace(
    '  KEY `environment_secrets_node_fk` (`node_id`),',
    '  KEY `environment_secrets_node_fk` (`node_id`),\n  KEY `environment_secrets_workspace_fk` (`workspace_id`),'
  )
  .replace(
    '  CONSTRAINT `environment_secrets_node_fk`',
    '  CONSTRAINT `environment_secrets_workspace_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`workspace_id`) ON DELETE CASCADE,\n  CONSTRAINT `environment_secrets_node_fk`'
  )
  .replace(
    /CONSTRAINT `environment_secrets_exact_owner` CHECK \([^\n]+/u,
    `CONSTRAINT \`environment_secrets_exact_owner\` CHECK ${WORKSPACE_SECRET_OWNER_CHECK},`
  );
const WORKSPACE_SECRET_MIGRATION_SQL = `ALTER TABLE environment_secrets
  DROP CHECK environment_secrets_exact_owner,
  MODIFY scope enum('PERSONAL','ORGANIZATION','NODE','WORKSPACE') NOT NULL,
  ADD COLUMN workspace_id varchar(128) DEFAULT NULL AFTER node_id,
  ADD KEY environment_secrets_workspace_fk (workspace_id),
  ADD CONSTRAINT environment_secrets_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id) ON DELETE CASCADE,
  ADD CONSTRAINT environment_secrets_exact_owner CHECK ${WORKSPACE_SECRET_OWNER_CHECK}`;
export const CORE_MYSQL_SCHEMA_V17: MysqlSchema = {
  ...CORE_MYSQL_SCHEMA_V9,
  mar_agent_models: CORE_MYSQL_SCHEMA_V9['mar_agent_models']!.replace(
    "  `fast_mode` tinyint(1) NOT NULL DEFAULT '0',",
    "  `fast_mode` tinyint(1) NOT NULL DEFAULT '0',\n  `service_tier` " + SERVICE_TIER_COLUMN + ','
  ).replace("  `responses_encoding` enum('STANDARD','LITE') DEFAULT NULL,\n", ''),
  workbench_notifications: CORE_MYSQL_SCHEMA_V9['workbench_notifications']!.replace(
    "enum('run','approval','plan','user-input')",
    "enum('run','approval','plan','user-input','schedule')"
  ),
  environment_secrets: WORKSPACE_SECRET_SCHEMA,
  mail_templates: MAIL_TEMPLATES_SQL,
  mail_deliveries: MAIL_DELIVERIES_SQL
};

const CORE_MYSQL_SCHEMA_V19: MysqlSchema = {
  ...CORE_MYSQL_SCHEMA_V17,
  mar_agent_models: CORE_MYSQL_SCHEMA_V17['mar_agent_models']!.replace(
    "  `high_density_compaction` tinyint(1) NOT NULL DEFAULT '0',\n",
    ''
  )
};

export const CORE_MYSQL_SCHEMA: MysqlSchema = mysqlSchemaWithoutForeignKeys({
  ...CORE_MYSQL_SCHEMA_V19,
  workbench_notifications: CORE_MYSQL_SCHEMA_V19['workbench_notifications']!.replace(
    "enum('run','approval','plan','user-input','schedule')",
    AGENT_NOTIFICATION_KIND
  ).replace('`message` varchar(512)', '`message` varchar(4000)'),
  mail_deliveries: MAIL_DELIVERIES_SQL.replace(
    '  PRIMARY KEY',
    '  `notification_result` json DEFAULT NULL,\n  PRIMARY KEY'
  ),
  mar_agent_models: CORE_MYSQL_SCHEMA_V19['mar_agent_models']!.replace(
    "  `title_generation` tinyint(1) NOT NULL DEFAULT '0',",
    "  `conversation_model` tinyint(1) NOT NULL DEFAULT '1',\n  `title_generation` tinyint(1) NOT NULL DEFAULT '0',"
  ),
  model_usage_records: MODEL_USAGE_SQL,
  ...MYSQL_PROMPT_COMPLETION_SCHEMA,
  ...MYSQL_WEB_PUSH_SCHEMA,
  ...MYSQL_SESSION_SHARES_CURRENT_SCHEMA
});

export async function validateCoreMysqlBaseline(
  connection: import('./mysql-migrations.js').MysqlMigrationConnection
): Promise<void> {
  await validateMysqlSchema(connection, CORE_MYSQL_SCHEMA_V9);
}

export async function validateCoreMysqlDatabase(
  connection: import('./mysql-migrations.js').MysqlMigrationConnection
): Promise<void> {
  await validateMysqlSchema(connection, CORE_MYSQL_SCHEMA);
  await validateMysqlReferences(connection, CORE_MYSQL_SCHEMA_V19);
  const [shareOrphans] = await connection.query(`SELECT 1 AS orphan FROM session_shares share_record
    LEFT JOIN users owner ON owner.id=share_record.user_id
    LEFT JOIN nodes node ON node.id=share_record.node_id
    LEFT JOIN workspaces workspace ON workspace.workspace_id=share_record.workspace_id AND workspace.node_id=share_record.node_id
    WHERE owner.id IS NULL OR node.id IS NULL OR workspace.workspace_id IS NULL LIMIT 1`);
  if (!Array.isArray(shareOrphans) || shareOrphans.length !== 0)
    throw new Error('SERVER_DATABASE_REFERENCE_INVALID');
  await assertMysqlNoForeignKeys(connection);
}

const XAI_SUBSCRIPTION_ENDPOINT_SQL =
  "UPDATE mar_agent_models SET base_url='https://api.x.ai/v1',last_tested_at=NULL,last_test_status='UNVERIFIED',last_test_code=NULL WHERE protocol='OPENAI_RESPONSES' AND base_url='https://cli-chat-proxy.grok.com/v1' AND JSON_UNQUOTE(JSON_EXTRACT(credential,'$.type'))='CREDENTIAL_REF'";
const RESPONSES_HTTP_CONTINUATION_SQL =
  "UPDATE mar_agent_models SET responses_previous_response_id=0 WHERE responses_previous_response_id<>0 AND (responses_transport IS NULL OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(responses_transport,'$.transport')),'')<>'WEBSOCKET')";
const XAI_SUBSCRIPTION_PROXY_ENDPOINT_SQL =
  "UPDATE mar_agent_models SET base_url='https://cli-chat-proxy.grok.com/v1',last_tested_at=NULL,last_test_status='UNVERIFIED',last_test_code=NULL WHERE protocol='OPENAI_RESPONSES' AND base_url='https://api.x.ai/v1' AND JSON_UNQUOTE(JSON_EXTRACT(credential,'$.type'))='CREDENTIAL_REF'";
const CONVERSATION_MODEL_SQL =
  'ALTER TABLE mar_agent_models ADD COLUMN conversation_model tinyint(1) NOT NULL DEFAULT 1 AFTER default_reasoning_effort';

// Keep this catalog at its baseline only; append future migrations without rewriting v9.
export const CORE_MYSQL_MIGRATIONS = [
  createMysqlBaselineMigration(
    'core_schema_v9',
    CORE_MYSQL_SCHEMA_V9,
    undefined,
    CORE_MYSQL_BASELINE_VERSION
  ),
  {
    version: 10,
    name: 'scheduled_session_notifications',
    checksum: createHash('sha256').update(scheduleNotificationSql).digest('hex'),
    up: async (connection: { execute(sql: string): Promise<unknown> }) => {
      await connection.execute(scheduleNotificationSql);
    }
  },
  {
    version: 11,
    name: 'mail_templates_and_deliveries',
    checksum: createHash('sha256')
      .update(
        JSON.stringify([MAIL_TEMPLATES_SQL, MAIL_DELIVERIES_SQL, LEGACY_DEFAULT_MAIL_TEMPLATES])
      )
      .digest('hex'),
    up: async (connection: {
      query(sql: string): Promise<unknown>;
      execute(sql: string, params?: readonly unknown[]): Promise<unknown>;
    }) => {
      for (const [name, sql] of [
        ['mail_templates', MAIL_TEMPLATES_SQL],
        ['mail_deliveries', MAIL_DELIVERIES_SQL]
      ] as const) {
        await connection.query(sql.replace(/^CREATE TABLE /u, 'CREATE TABLE IF NOT EXISTS '));
        await validateMysqlSchema(connection as never, { [name]: sql });
      }
      for (const template of LEGACY_DEFAULT_MAIL_TEMPLATES)
        await connection.execute(
          `INSERT IGNORE INTO mail_templates
           (id,kind,locale,name,subject,body,revision,is_default,created_at,updated_at)
           VALUES (?,?,?,?,?,?,1,1,?,?)`,
          [
            template.id,
            template.kind,
            template.locale,
            template.name,
            template.subject,
            template.body,
            Date.now(),
            Date.now()
          ]
        );
    }
  },
  {
    version: 12,
    name: 'mail_template_notification_titles',
    checksum: createHash('sha256')
      .update(
        JSON.stringify(
          DEFAULT_MAIL_TEMPLATES.filter(({ kind }) => kind === 'NOTIFICATION').map(
            ({ id, subject, body }) => ({ id, subject, body })
          )
        )
      )
      .digest('hex'),
    up: async (connection: {
      execute(sql: string, params?: readonly unknown[]): Promise<unknown>;
    }) => {
      for (const template of DEFAULT_MAIL_TEMPLATES)
        if (template.kind === 'NOTIFICATION')
          await connection.execute(MAIL_TEMPLATE_CONTENT_UPDATE_SQL, [
            template.subject,
            template.body,
            Date.now(),
            template.id
          ]);
    }
  },
  {
    version: 13,
    name: 'responses_service_tier',
    checksum: createHash('sha256')
      .update(JSON.stringify([SERVICE_TIER_ADD_SQL, SERVICE_TIER_BACKFILL_SQL]))
      .digest('hex'),
    up: async (connection: {
      execute(sql: string, params?: readonly unknown[]): Promise<unknown>;
      query(sql: string): Promise<unknown>;
    }) => {
      const [columns] = (await connection.execute(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mar_agent_models' AND COLUMN_NAME='service_tier'`
      )) as [readonly unknown[], unknown];
      if (columns.length === 0) await connection.execute(SERVICE_TIER_ADD_SQL);
      await connection.query('START TRANSACTION');
      try {
        await connection.execute(SERVICE_TIER_BACKFILL_SQL);
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      }
    }
  },
  {
    version: 14,
    name: 'credential_ownership_v3',
    checksum: createHash('sha256').update('credential_ownership_v3:personal-owner-1').digest('hex'),
    up: async (
      connection: import('./mysql-migrations.js').MysqlMigrationConnection,
      edition?: 'personal' | 'enterprise'
    ) => {
      if (edition !== 'personal') return;
      const [rows] = (await connection.execute(
        "SELECT setting_value FROM system_settings WHERE setting_key='mar_agent_credentials' FOR UPDATE"
      )) as [readonly Record<string, unknown>[], unknown];
      const raw = rows[0]?.['setting_value'];
      if (raw === undefined || raw === null) return;
      const projection = projectCredentialDocument(
        raw,
        { ownerType: 'PERSONAL', ownerUserId: 1 },
        Date.now()
      );
      if (!projection.changed) return;
      await connection.execute(
        "UPDATE system_settings SET setting_value=CAST(? AS JSON),updated_at=? WHERE setting_key='mar_agent_credentials'",
        [JSON.stringify(projection.document), Date.now()]
      );
    }
  },
  {
    version: 15,
    name: 'marctl_management_key',
    checksum: createHash('sha256').update(MARCTL_MANAGEMENT_KEY_SQL).digest('hex'),
    up: async (connection: import('./mysql-migrations.js').MysqlMigrationConnection) => {
      await connection.query('START TRANSACTION');
      try {
        const [rows] = (await connection.execute(
          "SELECT setting_key FROM system_settings WHERE setting_key IN ('marmgr_management_key','marctl_management_key') FOR UPDATE"
        )) as [readonly Record<string, unknown>[], unknown];
        if (rows.length > 1) throw new Error('MARCTL_MANAGEMENT_KEY_MIGRATION_CONFLICT');
        await connection.execute(MARCTL_MANAGEMENT_KEY_SQL);
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      }
    }
  },
  {
    version: 16,
    name: 'remove_responses_encoding',
    checksum: createHash('sha256').update(RESPONSES_ENCODING_DROP_SQL).digest('hex'),
    up: async (connection: import('./mysql-migrations.js').MysqlMigrationConnection) => {
      const [rows] = (await connection.execute(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mar_agent_models' AND COLUMN_NAME='responses_encoding'"
      )) as [readonly Record<string, unknown>[], unknown];
      if (rows.length > 0) await connection.execute(RESPONSES_ENCODING_DROP_SQL);
    }
  },
  {
    version: 17,
    name: 'workspace_environment_secrets',
    checksum: createHash('sha256').update(WORKSPACE_SECRET_MIGRATION_SQL).digest('hex'),
    up: async (connection: import('./mysql-migrations.js').MysqlMigrationConnection) => {
      const [rows] = (await connection.execute(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='environment_secrets' AND COLUMN_NAME='workspace_id'"
      )) as [readonly Record<string, unknown>[], unknown];
      if (rows.length === 0) await connection.execute(WORKSPACE_SECRET_MIGRATION_SQL);
      await validateMysqlSchema(connection, { environment_secrets: WORKSPACE_SECRET_SCHEMA });
    }
  },
  {
    version: 18,
    name: 'explicit_mysql_references',
    checksum: createHash('sha256')
      .update(JSON.stringify(['explicit_mysql_references:v1', CORE_MYSQL_SCHEMA_V17]))
      .digest('hex'),
    up: async (connection: import('./mysql-migrations.js').MysqlMigrationConnection) => {
      await removeMysqlForeignKeys(connection, CORE_MYSQL_SCHEMA_V17);
    }
  },
  {
    version: 19,
    name: 'remove_high_density_compaction',
    checksum: createHash('sha256').update(HIGH_DENSITY_COMPACTION_DROP_SQL).digest('hex'),
    up: async (connection: import('./mysql-migrations.js').MysqlMigrationConnection) => {
      const [rows] = (await connection.execute(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mar_agent_models' AND COLUMN_NAME='high_density_compaction'"
      )) as [readonly Record<string, unknown>[], unknown];
      if (rows.length > 0) await connection.execute(HIGH_DENSITY_COMPACTION_DROP_SQL);
    }
  },
  MODEL_USAGE_MIGRATION,
  {
    version: 21,
    name: 'xai_subscription_inference_endpoint',
    checksum: createHash('sha256').update(XAI_SUBSCRIPTION_ENDPOINT_SQL).digest('hex'),
    up: async (connection: import('./mysql-migrations.js').MysqlMigrationConnection) => {
      await connection.query('START TRANSACTION');
      try {
        await connection.execute(XAI_SUBSCRIPTION_ENDPOINT_SQL);
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      }
    }
  },
  {
    version: 22,
    name: 'responses_websocket_only_continuation',
    checksum: createHash('sha256').update(RESPONSES_HTTP_CONTINUATION_SQL).digest('hex'),
    up: async (connection: import('./mysql-migrations.js').MysqlMigrationConnection) => {
      await connection.query('START TRANSACTION');
      try {
        await connection.execute(RESPONSES_HTTP_CONTINUATION_SQL);
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      }
    }
  },
  {
    version: 23,
    name: 'xai_subscription_proxy_endpoint',
    checksum: createHash('sha256').update(XAI_SUBSCRIPTION_PROXY_ENDPOINT_SQL).digest('hex'),
    up: async (connection: import('./mysql-migrations.js').MysqlMigrationConnection) => {
      await connection.query('START TRANSACTION');
      try {
        await connection.execute(XAI_SUBSCRIPTION_PROXY_ENDPOINT_SQL);
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      }
    }
  },
  {
    version: 24,
    name: 'user_prompt_completion_preferences',
    checksum: createHash('sha256')
      .update(JSON.stringify(MYSQL_PROMPT_COMPLETION_SCHEMA))
      .digest('hex'),
    up: async (connection: import('./mysql-migrations.js').MysqlMigrationConnection) => {
      for (const [name, sql] of Object.entries(MYSQL_PROMPT_COMPLETION_SCHEMA)) {
        await connection.query(sql.replace(/^CREATE TABLE /u, 'CREATE TABLE IF NOT EXISTS '));
        await validateMysqlSchema(connection, { [name]: sql });
      }
    }
  },
  {
    version: 25,
    name: 'conversation_model_usage',
    checksum: createHash('sha256').update(CONVERSATION_MODEL_SQL).digest('hex'),
    up: async (connection: import('./mysql-migrations.js').MysqlMigrationConnection) => {
      const [rows] = (await connection.execute(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mar_agent_models' AND COLUMN_NAME='conversation_model'"
      )) as [readonly Record<string, unknown>[], unknown];
      if (rows.length === 0) await connection.execute(CONVERSATION_MODEL_SQL);
    }
  },
  {
    version: 26,
    name: 'remove_marctl_management_key',
    checksum: createHash('sha256')
      .update(
        "DELETE FROM system_settings WHERE setting_key IN ('marctl_management_key','marmgr_management_key')"
      )
      .digest('hex'),
    up: async (connection: import('./mysql-migrations.js').MysqlMigrationConnection) => {
      await connection.query('START TRANSACTION');
      try {
        await connection.execute(
          "DELETE FROM system_settings WHERE setting_key IN ('marctl_management_key','marmgr_management_key')"
        );
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      }
    }
  },
  {
    version: 27,
    name: 'web_push_clients',
    checksum: createHash('sha256').update(JSON.stringify(MYSQL_WEB_PUSH_SCHEMA)).digest('hex'),
    up: async (connection: import('./mysql-migrations.js').MysqlMigrationConnection) => {
      for (const [name, sql] of Object.entries(MYSQL_WEB_PUSH_SCHEMA)) {
        await connection.query(sql.replace(/^CREATE TABLE /u, 'CREATE TABLE IF NOT EXISTS '));
        await validateMysqlSchema(connection, { [name]: sql });
      }
    }
  },
  NOTIFICATION_CHANNELS_MIGRATION,
  {
    version: 29,
    name: 'session_shares',
    checksum: createHash('sha256')
      .update(JSON.stringify(MYSQL_SESSION_SHARES_SCHEMA))
      .digest('hex'),
    up: async (connection: import('./mysql-migrations.js').MysqlMigrationConnection) => {
      for (const [name, sql] of Object.entries(MYSQL_SESSION_SHARES_SCHEMA)) {
        await connection.query(sql.replace(/^CREATE TABLE /u, 'CREATE TABLE IF NOT EXISTS '));
        await validateMysqlSchema(connection, { [name]: sql });
      }
    }
  },
  {
    version: 30,
    name: 'recoverable_session_share_passwords',
    checksum: createHash('sha256')
      .update(
        'ALTER TABLE session_shares ADD COLUMN encrypted_password varchar(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER password_hash'
      )
      .digest('hex'),
    up: async (connection: import('./mysql-migrations.js').MysqlMigrationConnection) => {
      const [rows] = (await connection.execute(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='session_shares' AND COLUMN_NAME='encrypted_password'"
      )) as [readonly Record<string, unknown>[], unknown];
      if (rows.length === 0)
        await connection.execute(
          'ALTER TABLE session_shares ADD COLUMN encrypted_password varchar(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER password_hash'
        );
      await validateMysqlSchema(connection, MYSQL_SESSION_SHARES_CURRENT_SCHEMA);
    }
  }
] as const;
