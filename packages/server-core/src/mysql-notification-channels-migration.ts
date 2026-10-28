import { createHash } from 'node:crypto';
import type { MysqlMigrationConnection } from './mysql-migration-contracts.js';

export const AGENT_NOTIFICATION_KIND =
  "enum('run','approval','plan','user-input','schedule','agent')";
const STATEMENTS = [
  `ALTER TABLE workbench_notifications MODIFY kind ${AGENT_NOTIFICATION_KIND} NOT NULL, MODIFY message varchar(4000) NOT NULL`,
  'ALTER TABLE mail_deliveries ADD COLUMN notification_result json DEFAULT NULL'
];
export const NOTIFICATION_CHANNELS_MIGRATION = {
  version: 28,
  name: 'notification_channels',
  checksum: createHash('sha256').update(JSON.stringify(STATEMENTS)).digest('hex'),
  async up(connection: MysqlMigrationConnection): Promise<void> {
    // MySQL DDL commits atomically per statement; inspect both steps to recover an interrupted migration.
    const [columns] = (await connection.execute(
      "SELECT COLUMN_NAME,COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='workbench_notifications' AND COLUMN_NAME IN ('kind','message')"
    )) as [readonly { COLUMN_NAME: string; COLUMN_TYPE: string }[], unknown];
    if (
      !columns.some(
        (column) => column.COLUMN_NAME === 'kind' && column.COLUMN_TYPE === AGENT_NOTIFICATION_KIND
      ) ||
      !columns.some(
        (column) => column.COLUMN_NAME === 'message' && column.COLUMN_TYPE === 'varchar(4000)'
      )
    )
      await connection.execute(STATEMENTS[0]!);
    const [results] = (await connection.execute(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mail_deliveries' AND COLUMN_NAME='notification_result'"
    )) as [readonly unknown[], unknown];
    if (results.length === 0) await connection.execute(STATEMENTS[1]!);
  }
};
