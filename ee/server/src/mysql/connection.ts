import type { Pool } from 'mysql2/promise';
import {
  createMysqlPool,
  assertMysqlVersion,
  type MysqlDatabaseOptions
} from '@myagentroam/server-core/mysql-connection';
export {
  createMysqlPool,
  type MysqlDatabaseOptions
} from '@myagentroam/server-core/mysql-connection';
import { CORE_MYSQL_MIGRATIONS } from '@myagentroam/server-core/mysql-schema';
import { runServerMysqlMigrations } from '@myagentroam/server-core/mysql-migrations';
import {
  ENTERPRISE_MYSQL_MIGRATIONS,
  validateEnterpriseMysqlBaseline,
  validateEnterpriseMysqlDatabase
} from './enterprise-migrations.js';

export async function openMysqlDatabase(options: MysqlDatabaseOptions = {}): Promise<Pool> {
  const pool = createMysqlPool(options);
  try {
    await prepareMysqlDatabase(pool);
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

export async function prepareMysqlDatabase(pool: Pool): Promise<void> {
  await assertMysqlVersion(pool);
  await runServerMysqlMigrations(pool, {
    edition: 'enterprise',
    core: CORE_MYSQL_MIGRATIONS,
    enterprise: ENTERPRISE_MYSQL_MIGRATIONS,
    validateBaseline: validateEnterpriseMysqlBaseline,
    validate: validateEnterpriseMysqlDatabase
  });
}
