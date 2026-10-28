import type { MysqlMigrationConnection } from '@myagentroam/server-core/mysql-migration-contracts';

/** Shared by the startup migration and fixed-admin initialization on an empty database. */
export async function initializeRootIdentity(
  connection: Pick<MysqlMigrationConnection, 'execute'>,
  timestamp: number
): Promise<void> {
  await connection.execute(
    `INSERT INTO organizations (id,name,parent_organization_id,created_at,updated_at)
     VALUES (1,'MyAgentRoam',NULL,?,?) ON DUPLICATE KEY UPDATE id=id`,
    [timestamp, timestamp]
  );
  await connection.execute(
    `UPDATE users SET role='ADMIN',organization_id=1,updated_at=?
     WHERE is_fixed_admin=TRUE AND (role IS NULL OR role<>'ADMIN' OR organization_id IS NULL OR organization_id<>1)`,
    [timestamp]
  );
}
