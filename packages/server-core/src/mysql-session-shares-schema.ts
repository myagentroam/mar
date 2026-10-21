import type { MysqlSchema } from './mysql-schema-support.js';

export const MYSQL_SESSION_SHARES_SCHEMA: MysqlSchema = {
  session_shares: `CREATE TABLE \`session_shares\` (
  \`id\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`user_id\` bigint unsigned NOT NULL,
  \`node_id\` varchar(128) NOT NULL,
  \`workspace_id\` varchar(128) NOT NULL,
  \`session_id\` varchar(128) NOT NULL,
  \`password_hash\` varchar(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`access_credential\` char(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`created_at\` bigint NOT NULL,
  \`expires_at\` bigint DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`idx_session_shares_target\` (\`node_id\`,\`workspace_id\`,\`session_id\`),
  KEY \`idx_session_shares_user\` (\`user_id\`),
  KEY \`idx_session_shares_workspace\` (\`workspace_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
};

export const MYSQL_SESSION_SHARES_CURRENT_SCHEMA: MysqlSchema = {
  session_shares: MYSQL_SESSION_SHARES_SCHEMA.session_shares!.replace(
    '  `access_credential`',
    '  `encrypted_password` varchar(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,\n  `access_credential`'
  )
};
