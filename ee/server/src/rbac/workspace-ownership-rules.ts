import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { ResourceOwnership } from '@myagentroam/protocol';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { ResourceOwnershipSnapshot } from './resource-ownership-contracts.js';

export async function assertNoConversationTemplateReference(
  query: Pick<MysqlServerDatabase['raw'], 'execute'> | PoolConnection,
  workspaceId: string,
  lock = false
): Promise<void> {
  const [templates] = await query.execute<RowDataPacket[]>(
    `SELECT id FROM conversation_templates WHERE source_workspace_id=? LIMIT 1${
      lock ? ' FOR SHARE' : ''
    }`,
    [workspaceId]
  );
  if (templates.length > 0) throw new Error('WORKSPACE_CONVERSATION_TEMPLATE_REFERENCE_EXISTS');
}

export async function validateWorkspacePlacement(
  database: Pick<PoolConnection, 'execute'>,
  node: ResourceOwnershipSnapshot,
  workspace: ResourceOwnership
): Promise<void> {
  if (workspace.ownerType === 'PERSONAL') {
    if (node.ownerType !== 'PERSONAL' || node.ownerUserId !== workspace.ownerUserId)
      throw new Error('WORKSPACE_NODE_OWNERSHIP_INCOMPATIBLE');
    return;
  }
  if (node.ownerType !== 'ORGANIZATION') throw new Error('WORKSPACE_NODE_OWNERSHIP_INCOMPATIBLE');
  const [rows] = await database.execute<RowDataPacket[]>(
    `WITH RECURSIVE ancestors AS (
      SELECT id,parent_organization_id FROM organizations WHERE id=?
      UNION ALL SELECT parent.id,parent.parent_organization_id FROM organizations parent
      JOIN ancestors child ON child.parent_organization_id=parent.id
    ) SELECT 1 FROM ancestors WHERE id=? LIMIT 1`,
    [workspace.ownerOrganizationId, node.ownerOrganizationId]
  );
  if (rows.length !== 1) throw new Error('WORKSPACE_NODE_OWNERSHIP_INCOMPATIBLE');
}
