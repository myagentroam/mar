import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type {
  ResourceOwnershipSnapshot,
  TemplateHostingNodeSnapshot
} from './resource-ownership-contracts.js';

/** Reads resource ownership facts, optionally locking them on the caller's transaction. */
export class ResourceOwnershipStore {
  constructor(private readonly database: MysqlServerDatabase) {}

  async node(
    nodeId: string,
    includeDisabled = false,
    query: Pick<PoolConnection, 'execute'> = this.database.raw,
    lock = false
  ): Promise<ResourceOwnershipSnapshot | undefined> {
    const [rows] = await query.execute<RowDataPacket[]>(
      `SELECT display_name,owner_type,owner_user_id,owner_organization_id FROM nodes
       WHERE id=?${includeDisabled ? '' : ' AND disabled=FALSE'}${lock ? ' FOR SHARE' : ''}`,
      [nodeId]
    );
    return storedOwnership(rows[0]);
  }

  async workspace(
    nodeId: string,
    workspaceId: string,
    query: Pick<MysqlServerDatabase['raw'], 'execute'> | PoolConnection = this.database.raw,
    lock = false
  ): Promise<ResourceOwnershipSnapshot | undefined> {
    const [rows] = await query.execute<RowDataPacket[]>(
      `SELECT display_name,owner_type,owner_user_id,owner_organization_id FROM workspaces
       WHERE workspace_id=? AND node_id=?${lock ? ' FOR UPDATE' : ''}`,
      [workspaceId, nodeId]
    );
    return storedOwnership(rows[0]);
  }

  async model(
    modelId: string,
    query: Pick<PoolConnection, 'execute'> = this.database.raw,
    lock = false
  ): Promise<ResourceOwnershipSnapshot | undefined> {
    const [rows] = await query.execute<RowDataPacket[]>(
      `SELECT name AS display_name,owner_type,owner_user_id,owner_organization_id
       FROM mar_agent_models WHERE id=?${lock ? ' FOR SHARE' : ''}`,
      [modelId]
    );
    return storedOwnership(rows[0]);
  }

  async imageModel(
    modelId: string,
    query: Pick<PoolConnection, 'execute'> = this.database.raw,
    lock = false
  ): Promise<ResourceOwnershipSnapshot | undefined> {
    const [rows] = await query.execute<RowDataPacket[]>(
      `SELECT name AS display_name,owner_type,owner_user_id,owner_organization_id
       FROM mar_agent_image_models WHERE id=?${lock ? ' FOR SHARE' : ''}`,
      [modelId]
    );
    return storedOwnership(rows[0]);
  }

  async templateHostingNode(
    templateId: string,
    query: Pick<PoolConnection, 'execute'> = this.database.raw,
    lock = false
  ): Promise<TemplateHostingNodeSnapshot | undefined> {
    const [rows] = await query.execute<RowDataPacket[]>(
      `SELECT template.name AS display_name,template.source_node_id AS nodeId,template.source_workspace_id AS workspaceId,
              node.display_name AS nodeName,node.owner_type,node.owner_user_id,node.owner_organization_id
       FROM conversation_templates template
       JOIN nodes node ON node.id=template.source_node_id
       WHERE template.id=?${lock ? ' FOR SHARE' : ''}`,
      [templateId]
    );
    const row = rows[0];
    const ownership = storedOwnership(row);
    if (ownership === undefined || row === undefined) return undefined;
    return {
      ...ownership,
      ...(typeof row['nodeId'] === 'string' ? { nodeId: row['nodeId'] } : {}),
      ...(typeof row['workspaceId'] === 'string' ? { workspaceId: row['workspaceId'] } : {}),
      ...(typeof row['nodeName'] === 'string' ? { nodeName: row['nodeName'] } : {})
    };
  }
}

export function storedOwnership(
  row: RowDataPacket | undefined
): ResourceOwnershipSnapshot | undefined {
  if (row === undefined) return undefined;
  const source = {
    ...(typeof row['display_name'] === 'string' ? { displayName: row['display_name'] } : {})
  };
  return row['owner_type'] === 'PERSONAL'
    ? { ownerType: 'PERSONAL', ownerUserId: Number(row['owner_user_id']), ...source }
    : {
        ownerType: 'ORGANIZATION',
        ownerOrganizationId: Number(row['owner_organization_id']),
        ...source
      };
}
