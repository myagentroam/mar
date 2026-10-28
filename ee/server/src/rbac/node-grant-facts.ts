import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import { resourceKey } from './resource-grant-contracts.js';

export async function hasDirectUserNodeGrant(
  database: MysqlServerDatabase,
  actorUserId: number,
  nodeId: string,
  connection?: PoolConnection,
  lock = false
): Promise<boolean> {
  const [rows] = await (connection ?? database.raw).execute<RowDataPacket[]>(
    `SELECT 1 FROM resource_grants grant_record
       JOIN users actor ON actor.id=? AND actor.enabled=TRUE
       WHERE grant_record.resource_type='NODE' AND grant_record.resource_key=?
         AND grant_record.target_type='USER' AND grant_record.target_user_id=?
       LIMIT 1${lock ? ' FOR SHARE' : ''}`,
    [actorUserId, resourceKey('NODE', nodeId, null), actorUserId]
  );
  return rows.length === 1;
}
