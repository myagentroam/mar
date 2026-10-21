import type { MysqlSchema } from './mysql-schema-support.js';

export const MYSQL_PROMPT_COMPLETION_SCHEMA: MysqlSchema = {
  user_prompt_completion_preferences: `CREATE TABLE \`user_prompt_completion_preferences\` (
  \`user_id\` bigint unsigned NOT NULL,
  \`work_enabled\` tinyint(1) NOT NULL DEFAULT '0',
  \`conversation_enabled\` tinyint(1) NOT NULL DEFAULT '0',
  \`updated_at\` bigint NOT NULL,
  PRIMARY KEY (\`user_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
};
