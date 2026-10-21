import { commitMysqlAudits, discardMysqlAudits } from '@myagentroam/server-core/audit';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

/** The caller must hold a transaction until the referencing write commits. */
export async function lockOrganizationReference(
  connection: Pick<PoolConnection, 'execute'>,
  organizationId: number | null,
  exclusive = false
): Promise<void> {
  if (organizationId === null) return;
  if (!Number.isSafeInteger(organizationId) || organizationId < 1)
    throw new Error('ORGANIZATION_NOT_FOUND');
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT id FROM organizations WHERE id=? ${exclusive ? 'FOR UPDATE' : 'FOR SHARE'}`,
    [organizationId]
  );
  if (rows.length !== 1) throw new Error('ORGANIZATION_NOT_FOUND');
}

export async function withOrganizationReference<T>(
  pool: Pick<Pool, 'getConnection'>,
  organizationId: number,
  write: (connection: PoolConnection) => Promise<T>,
  exclusive = false
): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await lockOrganizationReference(connection, organizationId, exclusive);
    const result = await write(connection);
    await connection.commit();
    commitMysqlAudits(connection);
    return result;
  } catch (error) {
    discardMysqlAudits(connection);
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
