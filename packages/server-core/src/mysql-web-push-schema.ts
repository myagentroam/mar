import type { MysqlSchema } from './mysql-schema-support.js';

export const MYSQL_WEB_PUSH_SCHEMA: MysqlSchema = {
  web_push_clients: `CREATE TABLE \`web_push_clients\` (
  \`id\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`user_id\` bigint unsigned NOT NULL,
  \`session_hash\` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`token_hash\` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`endpoint_hash\` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`endpoint\` varchar(2048) NOT NULL,
  \`p256dh\` varchar(87) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`auth_secret\` varchar(22) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`expiration_time\` bigint DEFAULT NULL,
  \`enabled\` tinyint(1) NOT NULL,
  \`binding_version\` bigint unsigned NOT NULL,
  \`created_at\` bigint NOT NULL,
  \`updated_at\` bigint NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_web_push_token\` (\`token_hash\`),
  UNIQUE KEY \`uq_web_push_endpoint\` (\`endpoint_hash\`),
  KEY \`idx_web_push_user\` (\`user_id\`),
  KEY \`idx_web_push_session\` (\`session_hash\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
};
