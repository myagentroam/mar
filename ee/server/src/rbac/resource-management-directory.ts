import {
  managementPageQuery,
  managementText,
  managementSearchPattern,
  managementOrder,
  ManagementQueryError,
  readManagementPage
} from '@myagentroam/server-core/management-pagination';
import { publicNode } from '@myagentroam/server-core/node-projection';
import type { RowDataPacket } from 'mysql2/promise';
import type { ResourceOwnership } from '@myagentroam/protocol';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { AuthorizationProvider } from '../product/product-policy.js';

/** Authorized management projections, independent of resource mutation transactions. */
export class ResourceManagementDirectory {
  constructor(
    private readonly database: MysqlServerDatabase,
    private readonly authorization: AuthorizationProvider
  ) {}

  async listManagedResources(
    actorUserId: number,
    includeAllResources = false
  ): Promise<{
    readonly nodes: readonly {
      readonly id: string;
      readonly displayName: string | null;
      readonly disabled: boolean;
      readonly ownership: ResourceOwnership;
      readonly ownerUsername?: string;
    }[];
    readonly workspaces: readonly object[];
  }> {
    const organizationIds = await this.authorization.managedOrganizationIds(actorUserId);
    const scopedOrganizationIds = organizationIds.length === 0 ? [-1] : organizationIds;
    const allNodes =
      includeAllResources &&
      (await this.authorization.authorize(actorUserId, 'NODE_MANAGE', { ownerType: 'SYSTEM' }))
        .allowed;
    const nodeScopeClause = allNodes
      ? 'TRUE'
      : `((owner_type='PERSONAL' AND owner_user_id=?)
      OR (owner_type='ORGANIZATION' AND owner_organization_id IN (?)))`;
    const workspaceScopeClause = `((w.owner_type='PERSONAL' AND w.owner_user_id=?)
      OR (w.owner_type='ORGANIZATION' AND w.owner_organization_id IN (?)))`;
    const scopeParams = [actorUserId, scopedOrganizationIds];
    const [nodeRows] = await this.database.raw.query<RowDataPacket[]>(
      `SELECT node.id,node.display_name,node.disabled,node.owner_type,
              node.owner_user_id,node.owner_organization_id,owner.username AS owner_username
       FROM nodes node
       LEFT JOIN users owner ON owner.id=node.owner_user_id
       WHERE ${nodeScopeClause}
       ORDER BY node.created_at,node.id`,
      allNodes ? [] : scopeParams
    );
    const [workspaceRows] = await this.database.raw.query<RowDataPacket[]>(
      `SELECT w.node_id,w.workspace_id,w.display_name,w.owner_type,w.owner_user_id,
              w.owner_organization_id,n.display_name AS node_display_name,
              owner.username AS owner_username
       FROM workspaces w
       LEFT JOIN nodes n ON n.id=w.node_id
       LEFT JOIN users owner ON owner.id=w.owner_user_id
       WHERE ${workspaceScopeClause}
       ORDER BY w.node_id,w.workspace_id`,
      scopeParams
    );
    const ownership = (row: RowDataPacket) =>
      row['owner_type'] === 'PERSONAL'
        ? { ownerType: 'PERSONAL' as const, ownerUserId: Number(row['owner_user_id']) }
        : {
            ownerType: 'ORGANIZATION' as const,
            ownerOrganizationId: Number(row['owner_organization_id'])
          };
    return {
      nodes: nodeRows.map((row) => ({
        id: String(row['id']),
        displayName: row['display_name'] === null ? null : String(row['display_name']),
        disabled: Boolean(row['disabled']),
        ownership: ownership(row),
        ...(row['owner_username'] === null || row['owner_username'] === undefined
          ? {}
          : { ownerUsername: String(row['owner_username']) })
      })),
      workspaces: workspaceRows.map((row) => ({
        nodeId: String(row['node_id']),
        nodeDisplayName:
          row['node_display_name'] === null || row['node_display_name'] === undefined
            ? null
            : String(row['node_display_name']),
        workspaceId: String(row['workspace_id']),
        displayName: String(row['display_name'] ?? row['workspace_id']),
        ownership: ownership(row),
        ...(row['owner_username'] === null || row['owner_username'] === undefined
          ? {}
          : { ownerUsername: String(row['owner_username']) })
      }))
    };
  }

  async listManagedResourcePage(
    actorUserId: number,
    query: Record<string, unknown>,
    onlineIds: readonly string[]
  ) {
    const paging = managementPageQuery(query);
    if (paging === undefined) throw new ManagementQueryError();
    const type = managementText(query, 'resourceType');
    if (type !== 'NODE' && type !== 'WORKSPACE') throw new ManagementQueryError();
    const isNode = type === 'NODE';
    const alias = isNode ? 'node' : 'w';
    const organizations = await this.authorization.managedOrganizationIds(actorUserId);
    const allNodes =
      isNode &&
      query['management'] === 'all' &&
      (await this.authorization.authorize(actorUserId, 'NODE_MANAGE', { ownerType: 'SYSTEM' }))
        .allowed;
    const predicates = allNodes
      ? ['TRUE']
      : [
          `((${alias}.owner_type='PERSONAL' AND ${alias}.owner_user_id=?) OR (${alias}.owner_type='ORGANIZATION' AND ${alias}.owner_organization_id IN (?)))`
        ];
    const params: unknown[] = allNodes
      ? []
      : [actorUserId, organizations.length ? organizations : [-1]];
    for (const [key, column] of [
      ['ownerType', 'owner_type'],
      ['ownerOrganizationId', 'owner_organization_id'],
      ['ownerUserId', 'owner_user_id']
    ] as const) {
      const value = managementText(query, key);
      if (!value) continue;
      if (
        key === 'ownerType'
          ? !['PERSONAL', 'ORGANIZATION'].includes(value)
          : !/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))
      )
        throw new ManagementQueryError();
      predicates.push(`${alias}.${column}=?`);
      params.push(value);
    }
    const keyword = managementText(query, 'keyword');
    if (keyword) {
      const columns = isNode
        ? ['node.display_name', 'node.id']
        : ['w.display_name', 'w.workspace_id', 'w.node_id', 'n.display_name'];
      predicates.push(`(${columns.map((column) => `${column} LIKE ? ESCAPE '!'`).join(' OR ')})`);
      params.push(...columns.map(() => managementSearchPattern(keyword)));
    }
    const status = managementText(query, 'status');
    if (status && isNode) {
      if (!['online', 'offline', 'disabled'].includes(status)) throw new ManagementQueryError();
      predicates.push(
        status === 'disabled'
          ? 'node.disabled=TRUE'
          : `node.disabled=FALSE AND node.id ${status === 'offline' ? 'NOT ' : ''}IN (?)`
      );
      if (status !== 'disabled') params.push(onlineIds.length ? onlineIds : ['']);
    }
    const from = isNode
      ? 'FROM nodes node LEFT JOIN users owner ON owner.id=node.owner_user_id'
      : 'FROM workspaces w LEFT JOIN nodes n ON n.id=w.node_id LEFT JOIN users owner ON owner.id=w.owner_user_id';
    const where = ` WHERE ${predicates.join(' AND ')}`;
    const order = managementOrder(
      query,
      {
        label: `${alias}.display_name`,
        ownerUsername: 'owner.username',
        nodeId: isNode ? 'node.id' : 'w.node_id',
        workspaceId: 'w.workspace_id'
      },
      isNode ? 'node.created_at' : 'w.node_id'
    );
    if (isNode && query['sortBy'] === 'workspaceId') throw new ManagementQueryError();
    const { rows, ...metadata } = await readManagementPage(this.database.raw, paging, {
      countSql: `SELECT COUNT(*) AS total ${from}${where}`,
      rowsSql: `SELECT ${alias}.*,owner.username AS owner_username${isNode ? '' : ',n.display_name AS node_display_name'} ${from}${where} ORDER BY ${order},${isNode ? 'node.id' : 'w.workspace_id'}`,
      params
    });
    const ownership = (row: RowDataPacket): ResourceOwnership =>
      row['owner_type'] === 'PERSONAL'
        ? { ownerType: 'PERSONAL', ownerUserId: Number(row['owner_user_id']) }
        : { ownerType: 'ORGANIZATION', ownerOrganizationId: Number(row['owner_organization_id']) };
    return {
      ...metadata,
      nodes: isNode
        ? rows.map((row) => ({
            ...publicNode({
              id: String(row['id']),
              ownerUserId: Number(row['owner_user_id'] ?? row['registered_by_user_id']),
              displayName: row['display_name'] == null ? null : String(row['display_name']),
              registeredAddress: String(row['registered_address']),
              metadata:
                typeof row['metadata'] === 'string'
                  ? row['metadata']
                  : JSON.stringify(row['metadata']),
              disabled: Boolean(row['disabled']),
              lastHeartbeatAt:
                row['last_heartbeat_at'] == null ? null : Number(row['last_heartbeat_at']),
              connected: onlineIds.includes(String(row['id']))
            }),
            ownership: ownership(row),
            ownerUsername: row['owner_username'] == null ? undefined : String(row['owner_username'])
          }))
        : [],
      workspaces: isNode
        ? []
        : rows.map((row) => ({
            nodeId: String(row['node_id']),
            workspaceId: String(row['workspace_id']),
            displayName: String(row['display_name'] ?? row['workspace_id']),
            nodeDisplayName:
              row['node_display_name'] == null ? null : String(row['node_display_name']),
            ownership: ownership(row),
            ownerUsername: row['owner_username'] == null ? undefined : String(row['owner_username'])
          }))
    };
  }
}
