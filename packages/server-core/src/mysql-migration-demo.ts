import { createHash } from 'node:crypto';
import type { MysqlMigration } from './mysql-migration-contracts.js';

const CREATE_DEMO_TABLE = `CREATE TABLE IF NOT EXISTS \`mysql_migration_demo\` (
  \`id\` int NOT NULL PRIMARY KEY,
  \`label\` varchar(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;
const UPSERT_DEMO_ROW =
  "INSERT INTO `mysql_migration_demo` (`id`,`label`) VALUES (1,'demo') ON DUPLICATE KEY UPDATE `label`='demo'";

// Copy this only as a reference. Demo migrations must never enter a runtime catalog.
export const MYSQL_MIGRATION_DEMO: MysqlMigration = {
  version: 1,
  name: 'demo_example_table',
  checksum: createHash('sha256').update(`${CREATE_DEMO_TABLE}\n${UPSERT_DEMO_ROW}`).digest('hex'),
  up: async (connection) => {
    await connection.query(CREATE_DEMO_TABLE);
    await connection.query('START TRANSACTION');
    try {
      await connection.execute(UPSERT_DEMO_ROW);
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    }
  }
};
