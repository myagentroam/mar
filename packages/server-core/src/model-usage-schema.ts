import { createHash } from 'node:crypto';
import type { MysqlMigration } from './mysql-migrations.js';
import { validateMysqlSchema } from './mysql-schema-support.js';

export const MODEL_USAGE_SQL = `CREATE TABLE \`model_usage_records\` (
  \`source_key\` char(64) NOT NULL,
  \`user_id\` bigint unsigned NOT NULL,
  \`source_node_id\` varchar(256) NOT NULL,
  \`record_id\` varchar(256) NOT NULL,
  \`revision\` bigint NOT NULL,
  \`payload_hash\` char(64) NOT NULL,
  \`identity_hash\` char(64) NOT NULL,
  \`runner\` varchar(32) NOT NULL,
  \`mode\` varchar(16) NOT NULL,
  \`purpose\` varchar(32) NOT NULL,
  \`model_key\` varchar(800) NOT NULL,
  \`model_name\` varchar(256) NOT NULL,
  \`started_at\` bigint NOT NULL,
  \`ended_at\` bigint DEFAULT NULL,
  \`received_at\` bigint NOT NULL,
  \`input_tokens\` decimal(38,0) DEFAULT NULL,
  \`output_tokens\` decimal(38,0) DEFAULT NULL,
  \`record\` json NOT NULL,
  PRIMARY KEY (\`source_key\`),
  KEY \`model_usage_user_time\` (\`user_id\`,\`ended_at\`,\`source_key\`),
  KEY \`model_usage_retention\` (\`received_at\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

export const MODEL_USAGE_MIGRATION: MysqlMigration = {
  version: 20,
  name: 'personal_model_usage',
  checksum: createHash('sha256').update(MODEL_USAGE_SQL).digest('hex'),
  async up(connection) {
    await connection.query(MODEL_USAGE_SQL.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '));
    await validateMysqlSchema(connection, { model_usage_records: MODEL_USAGE_SQL });
  }
};
