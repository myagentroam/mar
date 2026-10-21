import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { commitMysqlAudits, discardMysqlAudits } from './audit.js';

/** Keep reference checks and mutations on the same connection and transaction. */
export async function withMysqlTransaction<T>(
  pool: Pool,
  action: (connection: PoolConnection) => Promise<T>
): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await action(connection);
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

/** Shared parent locks pair with exclusive locks in parent-deletion entry points. */
export async function lockMysqlUsers(
  connection: PoolConnection,
  values: readonly (number | null | undefined)[]
): Promise<void> {
  const ids = [
    ...new Set(values.filter((value): value is number => value !== null && value !== undefined))
  ].sort((a, b) => a - b);
  if (ids.length === 0) return;
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error('USER_NOT_FOUND');
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT id FROM users WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id FOR SHARE`,
    ids
  );
  if (rows.length !== ids.length) throw new Error('USER_NOT_FOUND');
}

export async function lockMysqlNode(connection: PoolConnection, nodeId: string): Promise<void> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    'SELECT id FROM nodes WHERE id=? FOR SHARE',
    [nodeId]
  );
  if (rows.length !== 1) throw new Error('NODE_NOT_FOUND');
}

export async function lockMysqlWorkspace(
  connection: PoolConnection,
  workspaceId: string,
  nodeId?: string
): Promise<void> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    'SELECT workspace_id,node_id FROM workspaces WHERE workspace_id=? FOR SHARE',
    [workspaceId]
  );
  if (rows.length !== 1 || (nodeId !== undefined && rows[0]!['node_id'] !== nodeId))
    throw new Error('WORKSPACE_NOT_FOUND');
}

export async function lockMysqlSkillSource(
  connection: PoolConnection,
  sourceId: string
): Promise<void> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    'SELECT id,enabled FROM skill_sources WHERE id=? FOR SHARE',
    [sourceId]
  );
  if (rows.length !== 1) throw new Error('SKILL_SOURCE_NOT_FOUND');
  if (!rows[0]!['enabled']) throw new Error('SKILL_SOURCE_DISABLED');
}

export async function lockMysqlTemplate(
  connection: PoolConnection,
  templateId: string
): Promise<RowDataPacket> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    'SELECT * FROM conversation_templates WHERE id=? FOR SHARE',
    [templateId]
  );
  if (rows.length !== 1) throw new Error('CONVERSATION_TEMPLATE_NOT_FOUND');
  return rows[0]!;
}

export async function lockMysqlModels(
  connection: PoolConnection,
  modelIds: readonly string[]
): Promise<void> {
  for (const id of [...new Set(modelIds)].sort()) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM mar_agent_models WHERE id=? FOR SHARE',
      [id]
    );
    if (rows.length !== 1) throw new Error('MAR_AGENT_MODEL_NOT_FOUND');
  }
}

export async function lockMysqlTemplateVersion(
  connection: Pick<PoolConnection, 'execute'>,
  versionId: string,
  templateId: string
): Promise<void> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    'SELECT id FROM conversation_template_versions WHERE id=? AND template_id=? FOR SHARE',
    [versionId, templateId]
  );
  if (rows.length !== 1) throw new Error('CONVERSATION_TEMPLATE_VERSION_NOT_FOUND');
}
