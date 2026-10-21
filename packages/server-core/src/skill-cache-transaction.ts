import { createHash } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { commitMysqlAudits, discardMysqlAudits } from './audit.js';

/** One database-scoped cache key, one connection, through file work and reference commit. */
export async function withSkillCacheTransaction<T>(
  pool: Pool,
  cacheKey: string,
  action: (connection: PoolConnection, assertConnected: () => void) => Promise<T>
): Promise<T> {
  const connection = await pool.getConnection();
  const errors: unknown[] = [];
  let result: T | undefined;
  let lockName = '';
  let locked = false;
  let transaction = false;
  let reusable = true;
  let connectionFailure: Error | undefined;
  const onError = (error: Error) => {
    connectionFailure ??= error;
    reusable = false;
  };
  const onEnd = () => onError(new Error('SKILL_CACHE_CONNECTION_CLOSED'));
  const assertConnected = () => {
    if (connectionFailure) throw connectionFailure;
  };
  connection.on('error', onError);
  connection.on('end', onEnd);
  try {
    const [identity] = await connection.execute<RowDataPacket[]>(
      'SELECT DATABASE() AS database_name'
    );
    const databaseName = identity[0]?.['database_name'];
    if (typeof databaseName !== 'string') throw new Error('SKILL_CACHE_DATABASE_REQUIRED');
    lockName = createHash('sha256')
      .update(JSON.stringify(['myagentroam:skill-cache', databaseName, cacheKey]))
      .digest('hex');
    let acquired: unknown;
    try {
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT GET_LOCK(?, 5) AS acquired',
        [lockName]
      );
      acquired = rows[0]?.['acquired'];
    } catch (error) {
      // An interrupted acquisition may have succeeded on the server. Never pool that session.
      reusable = false;
      throw error;
    }
    if (acquired !== 1) {
      if (acquired !== 0) reusable = false;
      throw new Error(acquired === 0 ? 'SKILL_CACHE_LOCK_TIMEOUT' : 'SKILL_CACHE_LOCK_FAILED');
    }
    locked = true;
    // Start the read boundary after waiting for the key, not on a pre-lock snapshot.
    transaction = true;
    await connection.beginTransaction();
    result = await action(connection, assertConnected);
    assertConnected();
    await connection.commit();
    transaction = false;
    commitMysqlAudits(connection);
  } catch (error) {
    errors.push(error);
    discardMysqlAudits(connection);
    if (typeof error === 'object' && error !== null && 'fatal' in error && error.fatal)
      reusable = false;
    if (transaction && reusable) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        errors.push(rollbackError);
        reusable = false;
      }
    }
  } finally {
    if (locked && reusable) {
      try {
        const [rows] = await connection.execute<RowDataPacket[]>(
          'SELECT RELEASE_LOCK(?) AS released',
          [lockName]
        );
        if (rows[0]?.['released'] !== 1) {
          errors.push(new Error('SKILL_CACHE_UNLOCK_FAILED'));
          reusable = false;
        }
      } catch (error) {
        errors.push(error);
        reusable = false;
      }
    }
    connection.removeListener('error', onError);
    connection.removeListener('end', onEnd);
    if (reusable) connection.release();
    else connection.destroy();
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, 'SKILL_CACHE_TRANSACTION_FAILED', { cause: errors[0] });
  return result as T;
}
