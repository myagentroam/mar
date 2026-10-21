import {
  managementPageQuery,
  managementText,
  managementSearchPattern,
  managementOrder,
  ManagementQueryError,
  readManagementPage
} from '@myagentroam/server-core/management-pagination';
import {
  EnvironmentSecretStore,
  secretSummary
} from '@myagentroam/server-core/environment-secret-store';
import {
  secretEnvironment,
  supportsSecretEnvironment
} from '@myagentroam/server-core/secret-environment';
import { lockOrganizationReference } from '../rbac/organization-reference.js';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type {
  EnvironmentSecretScope,
  EnvironmentSecretSummary,
  EnvironmentSecretInput
} from '@myagentroam/server-core/environment-secret-contracts';
import type { MysqlServerDatabase } from './server-database.js';
import type { ResourceOwnership } from '@myagentroam/protocol';

interface Actor {
  readonly userId: number;
  readonly isAdmin: boolean;
}

export class MysqlEnvironmentSecretService extends EnvironmentSecretStore {
  constructor(
    protected override readonly database: MysqlServerDatabase,
    private readonly canManageNode: (userId: number, nodeId: string) => Promise<boolean> = (
      userId,
      nodeId
    ) => database.userOwnsNode(userId, nodeId),
    private readonly canUseNode: (userId: number, nodeId: string) => Promise<boolean> = (
      userId,
      nodeId
    ) => database.userOwnsNode(userId, nodeId),
    private readonly managedOrganizationIds: (
      userId: number
    ) => Promise<readonly number[]> = async () => [],
    private readonly canManageOrganization: (
      userId: number,
      organizationId: number
    ) => Promise<boolean> = async (userId, organizationId) =>
      (await managedOrganizationIds(userId)).includes(organizationId),
    private readonly canManageWorkspace: (
      userId: number,
      nodeId: string,
      workspaceId: string
    ) => Promise<boolean> = async () => false,
    private readonly canUseWorkspace: (
      userId: number,
      nodeId: string,
      workspaceId: string
    ) => Promise<boolean> = async () => false
  ) {
    super(database);
  }

  protected override async lockScope(
    connection: PoolConnection,
    user: Actor,
    input: Pick<EnvironmentSecretInput, 'scope' | 'nodeId' | 'organizationId' | 'workspaceId'>
  ): Promise<ResourceOwnership> {
    if (input.scope === 'WORKSPACE') {
      if (!input.nodeId || !input.workspaceId) throw new Error('SECRET_SCOPE_INVALID');
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT workspace_id,display_name AS workspaceName,owner_type,owner_user_id,owner_organization_id FROM workspaces WHERE node_id=? AND workspace_id=? FOR UPDATE',
        [input.nodeId, input.workspaceId]
      );
      if (rows.length !== 1) throw new Error('WORKSPACE_FORBIDDEN');
      return secretResourceOwnership(rows[0]!);
    }
    if (input.scope === 'NODE') {
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT id,display_name AS nodeName,owner_type,owner_user_id,owner_organization_id FROM nodes WHERE id=? FOR SHARE',
        [input.nodeId!]
      );
      if (rows.length !== 1) throw new Error('NODE_NOT_FOUND');
      return secretResourceOwnership(rows[0]!);
    }
    await lockOrganizationReference(
      connection,
      input.scope === 'ORGANIZATION' ? input.organizationId! : null
    );
    return input.scope === 'ORGANIZATION'
      ? { ownerType: 'ORGANIZATION', ownerOrganizationId: input.organizationId! }
      : { ownerType: 'PERSONAL', ownerUserId: user.userId };
  }

  async list(
    user: Actor,
    nodeId?: string,
    workspaceId?: string
  ): Promise<readonly EnvironmentSecretSummary[]> {
    if (workspaceId !== undefined) {
      if (!nodeId || !workspaceId) throw new Error('SECRET_SCOPE_INVALID');
      if (!(await this.canManageWorkspace(user.userId, nodeId, workspaceId)))
        throw new Error('WORKSPACE_FORBIDDEN');
      const [rows] = await this.database.raw.execute<RowDataPacket[]>(
        "SELECT * FROM environment_secrets WHERE scope='WORKSPACE' AND node_id=? AND workspace_id=? ORDER BY name,id",
        [nodeId, workspaceId]
      );
      return rows.map(secretSummary);
    }
    if (nodeId !== undefined && !(await this.canManageNode(user.userId, nodeId)))
      throw new Error('NODE_FORBIDDEN');
    const organizationIds = await this.managedOrganizationIds(user.userId);
    const [rows] = await this.database.raw.query<RowDataPacket[]>(
      `SELECT id,scope,name,secret_value,node_id,workspace_id,organization_id,visibility,created_at,updated_at
       FROM environment_secrets
       WHERE owner_user_id=?
          OR (scope='ORGANIZATION' AND organization_id IN (?))
          OR (scope='NODE' AND node_id=?)
       ORDER BY FIELD(scope,'PERSONAL','ORGANIZATION','NODE'),organization_id,name,id`,
      [user.userId, organizationIds.length === 0 ? [-1] : organizationIds, nodeId ?? '']
    );
    return rows.map(secretSummary);
  }

  async listPage(user: Actor, query: Record<string, unknown>) {
    const paging = managementPageQuery(query);
    if (paging === undefined) throw new ManagementQueryError();
    // Target configuration is a complete snapshot, not a paginated management list.
    if (query['nodeId'] !== undefined || query['workspaceId'] !== undefined)
      throw new ManagementQueryError();
    const organizations = await this.managedOrganizationIds(user.userId);
    const predicates = [
      "((scope='PERSONAL' AND owner_user_id=?) OR (scope='ORGANIZATION' AND organization_id IN (?)))"
    ];
    const params: unknown[] = [user.userId, organizations.length ? organizations : [-1]];
    const scopes = managementText(query, 'scopes');
    if (scopes) {
      const values = scopes.split(',');
      if (values.some((scope) => !['PERSONAL', 'ORGANIZATION'].includes(scope)))
        throw new ManagementQueryError();
      predicates.push('scope IN (?)');
      params.push(values);
    }
    const keyword = managementText(query, 'keyword');
    if (keyword) {
      predicates.push("name LIKE ? ESCAPE '!'");
      params.push(managementSearchPattern(keyword));
    }
    const organizationId = managementText(query, 'organizationId');
    if (organizationId) {
      if (!/^[1-9]\d*$/u.test(organizationId) || !Number.isSafeInteger(Number(organizationId)))
        throw new ManagementQueryError();
      predicates.push("scope='ORGANIZATION' AND organization_id=?");
      params.push(Number(organizationId));
    }
    const where = ` FROM environment_secrets WHERE ${predicates.join(' AND ')}`;
    const order = managementOrder(
      query,
      { name: 'name', scope: 'scope', updatedAt: 'updated_at', createdAt: 'created_at' },
      'name'
    );
    const { rows, ...metadata } = await readManagementPage(this.database.raw, paging, {
      countSql: `SELECT COUNT(*) AS total${where}`,
      rowsSql: `SELECT *${where} ORDER BY ${order},id`,
      params
    });
    return { secrets: rows.map(secretSummary), ...metadata };
  }

  async resolve(
    userId: number,
    nodeId: string,
    workspaceId?: string
  ): Promise<Readonly<Record<string, string>>> {
    if (workspaceId === undefined) {
      if (!(await this.canUseNode(userId, nodeId))) throw new Error('NODE_FORBIDDEN');
    } else if (!(await this.canUseWorkspace(userId, nodeId, workspaceId))) {
      throw new Error('WORKSPACE_FORBIDDEN');
    }
    const nodes = await this.database.listNodes();
    if (!supportsSecretEnvironment(nodes.find((node) => node.id === nodeId)?.metadata))
      throw new Error('CAPABILITY_VERSION_UNSUPPORTED');
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `WITH RECURSIVE organization_ancestors AS (
         SELECT organization.id,organization.parent_organization_id,0 AS depth
         FROM nodes JOIN organizations organization ON organization.id=nodes.owner_organization_id
         WHERE nodes.id=? AND nodes.owner_type='ORGANIZATION'
         UNION ALL
         SELECT parent.id,parent.parent_organization_id,child.depth+1
         FROM organizations parent JOIN organization_ancestors child
           ON child.parent_organization_id=parent.id
       )
       SELECT secret.name,secret.secret_value,secret.scope,
              COALESCE(ancestor.depth,0) AS organization_depth
       FROM environment_secrets secret
       LEFT JOIN organization_ancestors ancestor ON ancestor.id=secret.organization_id
       WHERE (secret.scope='ORGANIZATION' AND ancestor.id IS NOT NULL
              AND (secret.visibility='PUBLIC' OR ancestor.depth=0))
          OR (secret.scope='NODE' AND secret.node_id=?)
          OR (secret.scope='PERSONAL' AND secret.owner_user_id=?)
          OR (secret.scope='WORKSPACE' AND secret.node_id=? AND secret.workspace_id=?)
       ORDER BY CASE secret.scope WHEN 'ORGANIZATION' THEN 1 WHEN 'NODE' THEN 2 WHEN 'WORKSPACE' THEN 3 ELSE 4 END,
                CASE WHEN secret.scope='ORGANIZATION' THEN ancestor.depth ELSE 0 END DESC,
                secret.id`,
      [nodeId, nodeId, userId, nodeId, workspaceId ?? '']
    );
    return secretEnvironment(
      rows.map((row) => [String(row['name']), String(row['secret_value'])] as const)
    );
  }

  protected override async assertWrite(
    user: Actor,
    scope: EnvironmentSecretScope,
    nodeId?: string,
    organizationId?: number,
    workspaceId?: string
  ): Promise<void> {
    if (scope === 'WORKSPACE') {
      if (organizationId !== undefined || !nodeId || !workspaceId)
        throw new Error('SECRET_SCOPE_INVALID');
      if (!(await this.canManageWorkspace(user.userId, nodeId, workspaceId)))
        throw new Error('WORKSPACE_FORBIDDEN');
    } else if (scope === 'ORGANIZATION') {
      if (
        nodeId !== undefined ||
        !Number.isSafeInteger(organizationId) ||
        !(await this.canManageOrganization(user.userId, organizationId!))
      )
        throw new Error('ORGANIZATION_FORBIDDEN');
    } else if (scope === 'PERSONAL') {
      if (nodeId !== undefined || organizationId !== undefined)
        throw new Error('SECRET_SCOPE_INVALID');
    } else if (typeof nodeId !== 'string' || !(await this.canManageNode(user.userId, nodeId))) {
      throw new Error('NODE_FORBIDDEN');
    } else if (organizationId !== undefined) {
      throw new Error('SECRET_SCOPE_INVALID');
    }
  }

  protected override async writableRow(
    connection: Pool | PoolConnection,
    user: Actor,
    id: string
  ): Promise<RowDataPacket> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT * FROM environment_secrets WHERE id=?',
      [id]
    );
    const row = rows[0];
    if (!row) throw new Error('SECRET_NOT_FOUND');
    if (row['scope'] === 'PERSONAL' && Number(row['owner_user_id']) !== user.userId)
      throw new Error('SECRET_NOT_FOUND');
    if (
      row['scope'] === 'ORGANIZATION' &&
      !(await this.canManageOrganization(user.userId, Number(row['organization_id'])))
    )
      throw new Error('SECRET_NOT_FOUND');
    if (row['scope'] === 'NODE' && !(await this.canManageNode(user.userId, String(row['node_id']))))
      throw new Error('SECRET_NOT_FOUND');
    if (
      row['scope'] === 'WORKSPACE' &&
      !(await this.canManageWorkspace(
        user.userId,
        String(row['node_id']),
        String(row['workspace_id'])
      ))
    )
      throw new Error('SECRET_NOT_FOUND');
    return row;
  }
}

function secretResourceOwnership(
  row: RowDataPacket
): ResourceOwnership & { readonly nodeName?: string; readonly workspaceName?: string } {
  const names = {
    ...(typeof row['nodeName'] === 'string' ? { nodeName: row['nodeName'] } : {}),
    ...(typeof row['workspaceName'] === 'string' ? { workspaceName: row['workspaceName'] } : {})
  };
  return row['owner_type'] === 'ORGANIZATION'
    ? {
        ownerType: 'ORGANIZATION',
        ownerOrganizationId: Number(row['owner_organization_id']),
        ...names
      }
    : { ownerType: 'PERSONAL', ownerUserId: Number(row['owner_user_id']), ...names };
}
