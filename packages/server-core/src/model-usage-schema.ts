import { createHash } from 'node:crypto';
import type { MysqlMigration } from './mysql-migration-contracts.js';
import { normalizeMysqlTableDefinition, validateMysqlSchema } from './mysql-schema-support.js';

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

const releasedQueryIndex = 'KEY `model_usage_user_time` (`user_id`,`ended_at`,`source_key`)';
const currentQueryIndex =
  'KEY `model_usage_user_time` (`user_id`,`purpose`,`ended_at`,`source_key`,`started_at`,`received_at`)';

// Keep v20 immutable while projecting the current covering query index.
export const MODEL_USAGE_CURRENT_SQL = MODEL_USAGE_SQL.replace(
  releasedQueryIndex,
  currentQueryIndex
);
const queryIndexSql = `ALTER TABLE model_usage_records DROP INDEX model_usage_user_time, ADD ${currentQueryIndex}`;

export const MODEL_USAGE_QUERY_INDEX_MIGRATION: MysqlMigration = {
  version: 31,
  name: 'personal_model_usage_query_index',
  checksum: createHash('sha256').update(queryIndexSql).digest('hex'),
  async up(connection) {
    const [rows] = await connection.query('SHOW CREATE TABLE model_usage_records');
    const actual = (rows as { 'Create Table': unknown }[])[0]?.['Create Table'];
    if (typeof actual !== 'string') throw new Error('SERVER_DATABASE_SCHEMA_MISMATCH');
    const normalized = normalizeMysqlTableDefinition(actual);
    if (normalized === normalizeMysqlTableDefinition(MODEL_USAGE_CURRENT_SQL)) return;
    if (normalized !== normalizeMysqlTableDefinition(MODEL_USAGE_SQL))
      throw new Error('SERVER_DATABASE_SCHEMA_MISMATCH');
    // One atomic DDL statement leaves either the released or current index on retry.
    await connection.query(queryIndexSql);
    await validateMysqlSchema(connection, { model_usage_records: MODEL_USAGE_CURRENT_SQL });
  }
};
