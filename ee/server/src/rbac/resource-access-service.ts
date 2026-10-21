import {
  managementPageQuery,
  managementText,
  managementSearchPattern,
  managementOrder,
  ManagementQueryError,
  readManagementPage
} from '@myagentroam/server-core/management-pagination';
import { publicNode } from '@myagentroam/server-core/node-projection';
import {
  emitAuditAfterCommit,
  emitAudit,
  resourceAuditEvent,
  commitMysqlAudits,
  discardMysqlAudits
} from '@myagentroam/server-core/audit';

import { lockMysqlUsers } from '@myagentroam/server-core/mysql-reference-store';
import { lockOrganizationReference, withOrganizationReference } from './organization-reference.js';
import { revokeOutOfScopeResourceGrants } from './resource-grant-scope.js';
import { randomUUID } from 'node:crypto';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { ResourceOwnership } from '@myagentroam/protocol';
import { normalizeWorkspaceGroupName } from '@myagentroam/server-core/workspace-group';
import type { WorkspaceUpdate } from '@myagentroam/server-core/workspace-route-contracts';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { AuthorizationProvider } from '../product/product-policy.js';

export type GrantTarget =
  | { readonly targetType: 'USER'; readonly targetUserId: number }
  | { readonly targetType: 'ORGANIZATION'; readonly targetOrganizationId: number };
export type GrantResourceType = 'NODE' | 'WORKSPACE' | 'MODEL' | 'IMAGE_MODEL' | 'TEMPLATE';

const NODE_MANAGEMENT_OPERATIONS = new Set([
  'node.upgrade.request',
  'node.upgrade.cancel',
  'node.skills.inspect',
  'node.skills.install',
  'node.skills.remove',
  'node.mcps.inspect',
  'node.mcps.install',
  'node.mcps.remove',
  'conversation.template.publish.status'
]);

const WORKSPACE_MANAGEMENT_OPERATIONS = new Set([
  'workspace.git.settings.update',
  'workspace.skills.inspect',
  'workspace.skills.install',
  'workspace.skills.remove',
  'workspace.skills.git-exclude-repair',
  'workspace.mcps.inspect',
  'workspace.mcps.install',
  'workspace.mcps.remove'
]);

const WORKSPACE_REGISTRATION_OPERATIONS = new Set(['workspace.remove']);

export class ResourceAccessService {
  constructor(
    private readonly database: MysqlServerDatabase,
    private readonly authorization: AuthorizationProvider,
    private readonly now: () => number = Date.now,
    private readonly credentialScopes?: {
      assertModelGrantWithinScope(modelId: string, target: GrantTarget): Promise<void>;
      canUserUseModelCredential(userId: number, modelId: string): Promise<boolean>;
    },
    private readonly personalHostingAdmission?: (userId: number) => Promise<boolean>
  ) {}

  async lockOwnership(connection: PoolConnection, ownership: ResourceOwnership): Promise<void> {
    if (ownership.ownerType === 'PERSONAL') return;
    await lockOrganizationReference(connection, 1);
    await lockOrganizationReference(connection, ownership.ownerOrganizationId);
  }

  async cleanupModelResources(connection: PoolConnection, modelId: string): Promise<void> {
    await connection.execute(
      "DELETE FROM resource_grants WHERE resource_type='MODEL' AND model_id=?",
      [modelId]
    );
  }

  async cleanupImageModelResources(connection: PoolConnection, modelId: string): Promise<void> {
    await connection.execute(
      "DELETE FROM resource_grants WHERE resource_type='IMAGE_MODEL' AND image_model_id=?",
      [modelId]
    );
  }

  async canUseNode(actorUserId: number, nodeId: string): Promise<boolean> {
    const resource = await this.node(nodeId);
    if (resource === undefined) return false;
    if (resource.ownerType === 'PERSONAL') return resource.ownerUserId === actorUserId;
    const granted = await this.hasGrant(actorUserId, 'NODE', resourceKey('NODE', nodeId, null));
    return (
      await this.authorization.authorize(actorUserId, 'RESOURCE_USE', {
        ...authorizationOwnership(resource),
        granted
      })
    ).allowed;
  }

  async nodeOwnership(nodeId: string): Promise<ResourceOwnership | undefined> {
    const node = await this.node(nodeId);
    if (node === undefined) return undefined;
    return node.ownerType === 'PERSONAL'
      ? { ownerType: 'PERSONAL', ownerUserId: node.ownerUserId }
      : { ownerType: 'ORGANIZATION', ownerOrganizationId: node.ownerOrganizationId };
  }

  async canUseModel(actorUserId: number, modelId: string): Promise<boolean> {
    if (
      (await this.authorization.actorContext(actorUserId)) === undefined &&
      !(await this.authorization.isPersonalAdmin(actorUserId))
    )
      return false;
    const resource = await this.model(modelId);
    if (resource === undefined) return false;
    const authorized =
      resource.ownerType === 'PERSONAL'
        ? resource.ownerUserId === actorUserId
        : await this.hasGrant(actorUserId, 'MODEL', resourceKey('MODEL', modelId, null));
    if (!authorized) return false;
    if (this.credentialScopes === undefined) return true;
    return this.credentialScopes.canUserUseModelCredential(actorUserId, modelId);
  }

  async canManageModel(actorUserId: number, modelId: string): Promise<boolean> {
    const resource = await this.model(modelId);
    if (resource === undefined) return false;
    if (resource.ownerType === 'PERSONAL' && resource.ownerUserId !== actorUserId) return false;
    return (
      await this.authorization.authorize(
        actorUserId,
        'RESOURCE_MANAGE',
        authorizationOwnership(resource)
      )
    ).allowed;
  }

  async canUseImageModel(actorUserId: number, modelId: string): Promise<boolean> {
    if (
      (await this.authorization.actorContext(actorUserId)) === undefined &&
      !(await this.authorization.isPersonalAdmin(actorUserId))
    )
      return false;
    const resource = await this.imageModel(modelId);
    if (resource === undefined) return false;
    return resource.ownerType === 'PERSONAL'
      ? resource.ownerUserId === actorUserId
      : this.hasGrant(actorUserId, 'IMAGE_MODEL', resourceKey('IMAGE_MODEL', modelId, null));
  }

  async canManageImageModel(actorUserId: number, modelId: string): Promise<boolean> {
    const resource = await this.imageModel(modelId);
    if (resource === undefined) return false;
    if (resource.ownerType === 'PERSONAL' && resource.ownerUserId !== actorUserId) return false;
    return (
      await this.authorization.authorize(
        actorUserId,
        'RESOURCE_MANAGE',
        authorizationOwnership(resource)
      )
    ).allowed;
  }

  async canUseTemplate(actorUserId: number, templateId: string): Promise<boolean> {
    const hostingNode = await this.templateHostingNode(templateId);
    if (hostingNode?.ownerType === 'PERSONAL') {
      return (
        hostingNode.ownerUserId === actorUserId &&
        (await this.personalHostingAdmission?.(actorUserId)) === true
      );
    }
    if (hostingNode?.ownerType !== 'ORGANIZATION') return false;
    if (await this.authorization.isPersonalAdmin(actorUserId)) return false;
    return this.hasTemplateOrganizationGrant(
      actorUserId,
      templateId,
      hostingNode.ownerOrganizationId
    );
  }

  async assertCanHostConversationTemplate(nodeId: string): Promise<void> {
    const node = await this.node(nodeId, true);
    if (
      node?.ownerType === 'PERSONAL' &&
      (await this.personalHostingAdmission?.(node.ownerUserId)) === true
    )
      return;
    if (node?.ownerType !== 'ORGANIZATION')
      throw new Error('CONVERSATION_TEMPLATE_HOST_NODE_INVALID');
  }

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

  async canUseWorkspace(
    actorUserId: number,
    nodeId: string,
    workspaceId: string
  ): Promise<boolean> {
    const workspace = await this.workspace(nodeId, workspaceId);
    if (workspace === undefined) return false;
    if (workspace.ownerType === 'PERSONAL') return workspace.ownerUserId === actorUserId;
    const directGrant = await this.hasGrant(
      actorUserId,
      'WORKSPACE',
      resourceKey('WORKSPACE', nodeId, workspaceId)
    );
    const direct = await this.authorization.authorize(actorUserId, 'RESOURCE_USE', {
      ...authorizationOwnership(workspace),
      granted: directGrant
    });
    return direct.allowed || this.canUseNode(actorUserId, nodeId);
  }

  async canRelay(
    actorUserId: number,
    nodeId: string,
    operation: string,
    _data: unknown,
    workspaceId?: string
  ): Promise<boolean> {
    if (operation === 'workspace.git.settings.get' && workspaceId !== undefined)
      return (
        (await this.canUseWorkspace(actorUserId, nodeId, workspaceId)) ||
        this.canManageWorkspace(actorUserId, nodeId, workspaceId)
      );
    if (NODE_MANAGEMENT_OPERATIONS.has(operation)) return this.canManageNode(actorUserId, nodeId);
    if (WORKSPACE_REGISTRATION_OPERATIONS.has(operation) && workspaceId !== undefined) {
      try {
        await this.assertCanUnregisterWorkspace(actorUserId, nodeId, workspaceId);
        return true;
      } catch {
        return false;
      }
    }
    if (WORKSPACE_MANAGEMENT_OPERATIONS.has(operation) && workspaceId !== undefined)
      return this.canManageWorkspace(actorUserId, nodeId, workspaceId);
    if (workspaceId !== undefined) return this.canUseWorkspace(actorUserId, nodeId, workspaceId);
    if (operation === 'workspace.list' || operation === 'workbench.node.receive')
      return this.canAccessNodeContainer(actorUserId, nodeId);
    return this.canUseNode(actorUserId, nodeId);
  }

  async canAccessNodeContainer(actorUserId: number, nodeId: string): Promise<boolean> {
    return (
      (await this.canUseNode(actorUserId, nodeId)) || this.hasVisibleWorkspace(actorUserId, nodeId)
    );
  }

  async assertCanUseWorkspace(
    actorUserId: number,
    nodeId: string,
    workspaceId: string
  ): Promise<void> {
    if (!(await this.canUseWorkspace(actorUserId, nodeId, workspaceId)))
      throw new Error('WORKSPACE_FORBIDDEN');
  }

  async assertCanManageNode(actorUserId: number, nodeId: string): Promise<void> {
    const resource = await this.node(nodeId, true);
    if (resource === undefined) throw new Error('NODE_NOT_FOUND');
    await this.requireNodeManagement(actorUserId, resource);
  }

  async canManageNode(actorUserId: number, nodeId: string): Promise<boolean> {
    try {
      await this.assertCanManageNode(actorUserId, nodeId);
      return true;
    } catch {
      return false;
    }
  }

  async canManageNodeSecrets(actorUserId: number, nodeId: string): Promise<boolean> {
    if (await this.canManageNode(actorUserId, nodeId)) return true;
    const resource = await this.node(nodeId, true);
    return (
      resource?.ownerType === 'ORGANIZATION' &&
      (await this.hasDirectUserNodeGrant(actorUserId, nodeId))
    );
  }

  async canRegisterWorkspace(actorUserId: number, nodeId: string): Promise<boolean> {
    const resource = await this.node(nodeId);
    if (resource === undefined) return false;
    try {
      await this.requireOwnershipManagement(actorUserId, resource);
      return true;
    } catch {
      return (
        resource.ownerType === 'ORGANIZATION' &&
        (await this.hasDirectUserNodeGrant(actorUserId, nodeId))
      );
    }
  }

  async canManageWorkspace(
    actorUserId: number,
    nodeId: string,
    workspaceId: string
  ): Promise<boolean> {
    try {
      await this.assertCanManageWorkspace(actorUserId, nodeId, workspaceId);
      return true;
    } catch {
      return false;
    }
  }

  async changeNodeOwnership(
    actorUserId: number,
    nodeId: string,
    ownership: ResourceOwnership
  ): Promise<void> {
    const current = await this.node(nodeId);
    if (current === undefined) throw new Error('NODE_NOT_FOUND');
    if (current.ownerType === 'PERSONAL' || ownership.ownerType === 'PERSONAL')
      throw new Error('PERSONAL_RESOURCE_OWNERSHIP_IMMUTABLE');
    await this.requireOwnershipManagement(actorUserId, current);
    await this.assertOwnershipSelection(actorUserId, ownership);
    const [workspaceRows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT owner_organization_id FROM workspaces
       WHERE node_id=? AND owner_type='ORGANIZATION'`,
      [nodeId]
    );
    try {
      for (const row of workspaceRows)
        await validateWorkspacePlacement(this.database.raw, ownership, {
          ownerType: 'ORGANIZATION',
          ownerOrganizationId: Number(row['owner_organization_id'])
        });
    } catch (error) {
      if (error instanceof Error && error.message === 'WORKSPACE_NODE_OWNERSHIP_INCOMPATIBLE')
        throw nodeOwnershipWorkspacePlacementError();
      throw error;
    }
    await withOrganizationReference(
      this.database.raw,
      1,
      async (connection) => {
        await lockOrganizationReference(connection, ownership.ownerOrganizationId);
        const locked = await this.node(nodeId, false, connection, true);
        if (locked === undefined) throw new Error('NODE_NOT_FOUND');
        if (locked.ownerType !== 'ORGANIZATION')
          throw new Error('PERSONAL_RESOURCE_OWNERSHIP_IMMUTABLE');
        await this.requireOwnershipManagement(actorUserId, locked, 'RESOURCE_MANAGE', connection);
        await this.assertOwnershipSelection(actorUserId, ownership, connection);
        const [currentWorkspaces] = await connection.execute<RowDataPacket[]>(
          `SELECT owner_organization_id FROM workspaces WHERE node_id=? AND owner_type='ORGANIZATION' FOR SHARE`,
          [nodeId]
        );
        for (const row of currentWorkspaces)
          await validateWorkspacePlacement(connection, ownership, {
            ownerType: 'ORGANIZATION',
            ownerOrganizationId: Number(row['owner_organization_id'])
          });
        await connection.execute(
          `UPDATE nodes SET owner_organization_id=?,updated_at=?
       WHERE id=? AND owner_type='ORGANIZATION'`,
          [ownership.ownerOrganizationId, this.now(), nodeId]
        );
        emitAuditAfterCommit(
          this.database,
          connection,
          resourceAuditEvent(
            {
              eventType: 'node.ownership.changed',
              actorUserId,
              targetType: 'NODE',
              targetId: nodeId,
              nodeId
            },
            locked,
            {
              before: { ownerOrganizationId: locked.ownerOrganizationId },
              after: { ownerOrganizationId: ownership.ownerOrganizationId }
            }
          )
        );
        await revokeOutOfScopeResourceGrants(connection);
      },
      true
    );
  }

  async changeWorkspaceOwnership(
    actorUserId: number,
    nodeId: string,
    workspaceId: string,
    ownership: ResourceOwnership
  ): Promise<void> {
    const current = await this.workspace(nodeId, workspaceId);
    if (current === undefined) throw new Error('WORKSPACE_NOT_FOUND');
    if (current.ownerType === 'PERSONAL' || ownership.ownerType === 'PERSONAL')
      throw new Error('PERSONAL_RESOURCE_OWNERSHIP_IMMUTABLE');
    await this.requireOwnershipManagement(actorUserId, current);
    await this.assertOwnershipSelection(actorUserId, ownership);
    const node = await this.node(nodeId);
    if (node === undefined) throw new Error('NODE_NOT_FOUND');
    await validateWorkspacePlacement(this.database.raw, node, ownership);
    await withOrganizationReference(
      this.database.raw,
      1,
      async (connection) => {
        await lockOrganizationReference(connection, ownership.ownerOrganizationId);
        const locked = await this.workspace(nodeId, workspaceId, connection, true);
        if (locked === undefined) throw new Error('WORKSPACE_NOT_FOUND');
        if (locked.ownerType !== 'ORGANIZATION')
          throw new Error('PERSONAL_RESOURCE_OWNERSHIP_IMMUTABLE');
        await this.requireOwnershipManagement(actorUserId, locked, 'RESOURCE_MANAGE', connection);
        await this.assertOwnershipSelection(actorUserId, ownership, connection);
        const lockedNode = await this.node(nodeId, false, connection, true);
        if (lockedNode === undefined) throw new Error('NODE_NOT_FOUND');
        await validateWorkspacePlacement(connection, lockedNode, ownership);
        await connection.execute(
          `UPDATE workspaces SET owner_organization_id=?
       WHERE workspace_id=? AND node_id=? AND owner_type='ORGANIZATION'`,
          [ownership.ownerOrganizationId, workspaceId, nodeId]
        );
        emitAuditAfterCommit(
          this.database,
          connection,
          resourceAuditEvent(
            {
              eventType: 'workspace.ownership.changed',
              actorUserId,
              targetType: 'WORKSPACE',
              targetId: workspaceId,
              nodeId,
              workspaceId
            },
            locked,
            {
              before: { ownerOrganizationId: locked.ownerOrganizationId },
              after: { ownerOrganizationId: ownership.ownerOrganizationId }
            }
          )
        );
        await revokeOutOfScopeResourceGrants(connection);
      },
      true
    );
  }

  async projectNodeWorkspaces<T extends { readonly id: string }>(
    actorUserId: number,
    nodeId: string,
    workspaces: readonly T[]
  ): Promise<readonly T[]> {
    const node = await this.node(nodeId);
    if (node === undefined) throw new Error('NODE_NOT_FOUND');
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      await lockOrganizationReference(connection, 1);
      if (node.ownerType === 'PERSONAL') await lockMysqlUsers(connection, [node.ownerUserId]);
      const [nodeRows] = await connection.execute<RowDataPacket[]>(
        `SELECT owner_type,owner_user_id,owner_organization_id,legacy_ownership_backfill_pending
         FROM nodes WHERE id=? AND disabled=FALSE FOR UPDATE`,
        [nodeId]
      );
      const lockedNode = storedOwnership(nodeRows[0]);
      if (lockedNode === undefined) throw new Error('NODE_NOT_FOUND');
      if (lockedNode.ownerType === 'PERSONAL')
        await lockMysqlUsers(connection, [lockedNode.ownerUserId]);
      await lockOrganizationReference(
        connection,
        lockedNode.ownerType === 'ORGANIZATION' ? lockedNode.ownerOrganizationId : null
      );
      const [licenseRows] = await connection.execute<RowDataPacket[]>(
        'SELECT ever_activated FROM license_state WHERE singleton_id=1'
      );
      const mayBackfill =
        !licenseRows[0]?.['ever_activated'] || nodeRows[0]?.['legacy_ownership_backfill_pending'];
      for (const workspace of workspaces) {
        const [registeredRows] = await connection.execute<RowDataPacket[]>(
          'SELECT node_id FROM workspaces WHERE workspace_id=? FOR UPDATE',
          [workspace.id]
        );
        if (registeredRows.length > 0) {
          if (String(registeredRows[0]?.['node_id']) !== nodeId)
            throw new Error('WORKSPACE_ID_CONFLICT');
          continue;
        }
        const [tombstoneRows] = await connection.execute<RowDataPacket[]>(
          'SELECT workspace_id FROM workspace_tombstones WHERE workspace_id=?',
          [workspace.id]
        );
        if (tombstoneRows.length > 0) throw new Error('WORKSPACE_ID_REUSED');
        if (!mayBackfill) continue;
        const displayName = workspaceDisplayName(workspace);
        await connection.execute(
          `INSERT INTO workspaces
           (workspace_id,display_name,node_id,owner_type,owner_user_id,owner_organization_id,registered_at)
           VALUES (?,?,?,?,?,?,?)`,
          [
            workspace.id,
            displayName,
            nodeId,
            lockedNode.ownerType,
            lockedNode.ownerType === 'PERSONAL' ? lockedNode.ownerUserId : null,
            lockedNode.ownerType === 'ORGANIZATION' ? lockedNode.ownerOrganizationId : null,
            this.now()
          ]
        );
      }
      if (nodeRows[0]?.['legacy_ownership_backfill_pending'])
        await connection.execute(
          'UPDATE nodes SET legacy_ownership_backfill_pending=FALSE,updated_at=? WHERE id=?',
          [this.now(), nodeId]
        );
      await connection.commit();
      commitMysqlAudits(connection);
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    const visible: Array<T & { readonly ownership: ResourceOwnership }> = [];
    for (const workspace of workspaces) {
      if (!(await this.canUseWorkspace(actorUserId, nodeId, workspace.id))) continue;
      const ownership = await this.workspace(nodeId, workspace.id);
      if (ownership === undefined) continue;
      const presentation = await this.workspacePresentation(nodeId, workspace.id);
      visible.push({
        ...workspace,
        displayName: presentation.displayName,
        groupName: presentation.groupName,
        manageable: await this.canManageWorkspace(actorUserId, nodeId, workspace.id),
        ownership:
          ownership.ownerType === 'PERSONAL'
            ? { ownerType: 'PERSONAL', ownerUserId: ownership.ownerUserId }
            : {
                ownerType: 'ORGANIZATION',
                ownerOrganizationId: ownership.ownerOrganizationId
              }
      });
    }
    return visible;
  }

  async registerWorkspace(
    actorUserId: number,
    nodeId: string,
    workspaceId: string,
    ownership: ResourceOwnership,
    displayName = workspaceId
  ): Promise<void> {
    // Re-evaluate the actor's ownership entitlement after Node-side creation and
    // before persisting its Server registration. This prevents a revoked direct
    // Node grant from being reused with an ownership resolved before the revoke.
    const node = await this.node(nodeId);
    if (node === undefined) throw new Error('NODE_NOT_FOUND');
    const resolvedOwnership = await this.resolveWorkspaceOwnership(actorUserId, nodeId, ownership);
    if (!sameOwnership(resolvedOwnership, ownership))
      throw new Error('WORKSPACE_NODE_OWNERSHIP_INCOMPATIBLE');
    const mustHoldDirectNodeGrant =
      !(await this.canManageNode(actorUserId, nodeId)) &&
      (await this.hasDirectUserNodeGrant(actorUserId, nodeId));
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      await lockOrganizationReference(connection, 1);
      if (node.ownerType === 'PERSONAL') await lockMysqlUsers(connection, [node.ownerUserId]);
      const lockedNode = await this.node(nodeId, false, connection, true);
      if (lockedNode === undefined) throw new Error('NODE_NOT_FOUND');
      if (!sameOwnership(node, lockedNode))
        throw new Error('WORKSPACE_NODE_OWNERSHIP_INCOMPATIBLE');
      if (lockedNode.ownerType === 'PERSONAL')
        await lockMysqlUsers(connection, [lockedNode.ownerUserId]);
      await lockOrganizationReference(
        connection,
        lockedNode.ownerType === 'ORGANIZATION' ? lockedNode.ownerOrganizationId : null
      );
      if (
        mustHoldDirectNodeGrant &&
        !(await this.hasDirectUserNodeGrant(actorUserId, nodeId, connection, true))
      )
        throw new Error('WORKSPACE_NODE_OWNERSHIP_INCOMPATIBLE');
      if (ownership.ownerType === 'PERSONAL')
        await lockMysqlUsers(connection, [ownership.ownerUserId]);
      else await lockOrganizationReference(connection, ownership.ownerOrganizationId);
      await validateWorkspacePlacement(connection, lockedNode, ownership);
      const [tombstones] = await connection.execute<RowDataPacket[]>(
        'SELECT workspace_id FROM workspace_tombstones WHERE workspace_id=? FOR UPDATE',
        [workspaceId]
      );
      if (tombstones.length > 0) throw new Error('WORKSPACE_ID_REUSED');
      const [existing] = await connection.execute<RowDataPacket[]>(
        'SELECT node_id FROM workspaces WHERE workspace_id=? FOR UPDATE',
        [workspaceId]
      );
      if (existing.length > 0) throw new Error('WORKSPACE_ID_CONFLICT');
      await connection.execute(
        `INSERT INTO workspaces
         (workspace_id,display_name,node_id,owner_type,owner_user_id,owner_organization_id,registered_at)
         VALUES (?,?,?,?,?,?,?)`,
        [
          workspaceId,
          displayName,
          nodeId,
          ownership.ownerType,
          ownership.ownerType === 'PERSONAL' ? ownership.ownerUserId : null,
          ownership.ownerType === 'ORGANIZATION' ? ownership.ownerOrganizationId : null,
          this.now()
        ]
      );
      await connection.commit();
      commitMysqlAudits(connection);
      emitAudit(
        this.database,
        resourceAuditEvent(
          {
            eventType: 'workspace.registered',
            actorUserId,
            targetType: 'WORKSPACE',
            targetId: workspaceId,
            nodeId,
            workspaceId
          },
          { ...ownership, displayName },
          {}
        )
      );
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async renameWorkspace(
    actorUserId: number,
    nodeId: string,
    workspaceId: string,
    displayName: string
  ): Promise<void> {
    const workspace = await this.workspace(nodeId, workspaceId);
    if (workspace === undefined) throw new Error('WORKSPACE_NOT_FOUND');
    await this.requireOwnershipManagement(actorUserId, workspace);
    const [result] = await this.database.raw.execute<ResultSetHeader>(
      'UPDATE workspaces SET display_name=? WHERE workspace_id=? AND node_id=?',
      [displayName, workspaceId, nodeId]
    );
    if (result.affectedRows !== 1) throw new Error('WORKSPACE_NOT_FOUND');
  }

  async updateWorkspaceGroupName(
    actorUserId: number,
    nodeId: string,
    workspaceId: string,
    groupName: string | null
  ): Promise<void> {
    const value = normalizeWorkspaceGroupName(groupName);
    const workspace = await this.workspace(nodeId, workspaceId);
    if (workspace === undefined) throw new Error('WORKSPACE_NOT_FOUND');
    if (!(await this.canRegisterWorkspace(actorUserId, nodeId)))
      throw new Error('WORKSPACE_FORBIDDEN');
    const [result] = await this.database.raw.execute<ResultSetHeader>(
      'UPDATE workspaces SET group_name=? WHERE workspace_id=? AND node_id=?',
      [value, workspaceId, nodeId]
    );
    if (result.affectedRows !== 1) throw new Error('WORKSPACE_NOT_FOUND');
    emitAudit(
      this.database,
      resourceAuditEvent(
        {
          eventType: 'workspace.group.updated',
          actorUserId,
          targetType: 'WORKSPACE',
          targetId: workspaceId,
          nodeId,
          workspaceId
        },
        workspace,
        { after: { groupName: value } }
      )
    );
  }

  async updateWorkspace(
    actorUserId: number,
    nodeId: string,
    workspaceId: string,
    update: WorkspaceUpdate
  ): Promise<void> {
    if (
      update.displayName !== undefined &&
      (!update.displayName.trim() || update.displayName.length > 255)
    )
      throw new Error('WORKSPACE_INVALID');
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      const current = await this.workspace(nodeId, workspaceId, connection, true);
      if (current === undefined) throw new Error('WORKSPACE_NOT_FOUND');
      await this.requireOwnershipManagement(actorUserId, current, 'RESOURCE_MANAGE', connection);
      if (update.ownership !== undefined) {
        if (current.ownerType === 'PERSONAL' || update.ownership.ownerType === 'PERSONAL')
          throw new Error('PERSONAL_RESOURCE_OWNERSHIP_IMMUTABLE');
        await this.assertOwnershipSelection(actorUserId, update.ownership);
        const [nodeRows] = await connection.execute<RowDataPacket[]>(
          `SELECT owner_type,owner_user_id,owner_organization_id FROM nodes
           WHERE id=? AND disabled=FALSE FOR UPDATE`,
          [nodeId]
        );
        const node = storedOwnership(nodeRows[0]);
        if (node === undefined) throw new Error('NODE_NOT_FOUND');
        await validateWorkspacePlacement(connection, node, update.ownership);
        await lockOrganizationReference(connection, update.ownership.ownerOrganizationId);
        const [result] = await connection.execute<ResultSetHeader>(
          `UPDATE workspaces SET owner_organization_id=?
           WHERE workspace_id=? AND node_id=? AND owner_type='ORGANIZATION'`,
          [update.ownership.ownerOrganizationId, workspaceId, nodeId]
        );
        if (result.affectedRows !== 1) throw new Error('WORKSPACE_NOT_FOUND');
        await this.revokeResourceGrantsOutsideAuthority(
          'WORKSPACE',
          nodeId,
          workspaceId,
          update.ownership.ownerOrganizationId,
          connection
        );
      }
      if (update.displayName !== undefined) {
        const [result] = await connection.execute<ResultSetHeader>(
          'UPDATE workspaces SET display_name=? WHERE workspace_id=? AND node_id=?',
          [update.displayName, workspaceId, nodeId]
        );
        if (result.affectedRows !== 1) throw new Error('WORKSPACE_NOT_FOUND');
      }
      await connection.commit();
      commitMysqlAudits(connection);
      emitAudit(
        this.database,
        resourceAuditEvent(
          {
            eventType: 'workspace.updated',
            actorUserId,
            targetType: 'WORKSPACE',
            targetId: workspaceId,
            nodeId,
            workspaceId
          },
          current,
          {
            before: { name: current.displayName },
            after: {
              name: update.displayName,
              ownerOrganizationId:
                update.ownership?.ownerType === 'ORGANIZATION'
                  ? update.ownership.ownerOrganizationId
                  : undefined
            }
          }
        )
      );
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async resolveWorkspaceOwnership(
    actorUserId: number,
    nodeId: string,
    requestedOwnership?: ResourceOwnership
  ): Promise<ResourceOwnership> {
    const node = await this.node(nodeId);
    if (node === undefined) throw new Error('NODE_NOT_FOUND');
    if (
      node.ownerType === 'ORGANIZATION' &&
      !(await this.canManageNode(actorUserId, nodeId)) &&
      (await this.hasDirectUserNodeGrant(actorUserId, nodeId))
    )
      return {
        ownerType: 'ORGANIZATION',
        ownerOrganizationId: node.ownerOrganizationId
      };
    const ownership = requestedOwnership ?? {
      ownerType: 'PERSONAL' as const,
      ownerUserId: actorUserId
    };
    await this.assertOwnershipSelection(actorUserId, ownership);
    await validateWorkspacePlacement(this.database.raw, node, ownership);
    return ownership;
  }

  async unregisterWorkspace(
    actorUserId: number,
    nodeId: string,
    workspaceId: string
  ): Promise<void> {
    await this.assertCanUnregisterWorkspace(actorUserId, nodeId, workspaceId);
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      const workspace = await this.workspace(nodeId, workspaceId, connection, true);
      if (workspace === undefined) throw new Error('WORKSPACE_NOT_FOUND');
      await this.assertNoConversationTemplateReference(connection, workspaceId, true);
      await connection.execute(
        "DELETE FROM environment_secrets WHERE scope='WORKSPACE' AND node_id=? AND workspace_id=?",
        [nodeId, workspaceId]
      );
      await connection.execute(
        "DELETE FROM resource_grants WHERE resource_type='WORKSPACE' AND node_id=? AND workspace_id=?",
        [nodeId, workspaceId]
      );
      await connection.execute('DELETE FROM session_shares WHERE workspace_id=? AND node_id=?', [
        workspaceId,
        nodeId
      ]);
      const [result] = await connection.execute<ResultSetHeader>(
        'DELETE FROM workspaces WHERE workspace_id=? AND node_id=?',
        [workspaceId, nodeId]
      );
      if (result.affectedRows !== 1) throw new Error('WORKSPACE_NOT_FOUND');
      await connection.execute(
        `INSERT INTO workspace_tombstones (workspace_id,deleted_at) VALUES (?,?)
         ON DUPLICATE KEY UPDATE deleted_at=VALUES(deleted_at)`,
        [workspaceId, this.now()]
      );
      await connection.commit();
      commitMysqlAudits(connection);
      emitAudit(
        this.database,
        resourceAuditEvent(
          {
            eventType: 'workspace.unregistered',
            actorUserId,
            targetType: 'WORKSPACE',
            targetId: workspaceId,
            nodeId,
            workspaceId
          },
          workspace,
          {}
        )
      );
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async assertCanManageWorkspace(
    actorUserId: number,
    nodeId: string,
    workspaceId: string
  ): Promise<void> {
    const workspace = await this.workspace(nodeId, workspaceId);
    if (workspace === undefined) throw new Error('WORKSPACE_NOT_FOUND');
    await this.requireOwnershipManagement(actorUserId, workspace);
  }

  async assertCanUnregisterWorkspace(
    actorUserId: number,
    nodeId: string,
    workspaceId: string
  ): Promise<void> {
    const workspace = await this.workspace(nodeId, workspaceId);
    if (workspace === undefined) throw new Error('WORKSPACE_NOT_FOUND');
    if (!(await this.canRegisterWorkspace(actorUserId, nodeId)))
      throw new Error('WORKSPACE_FORBIDDEN');
    await this.assertNoConversationTemplateReference(this.database.raw, workspaceId);
  }

  private async assertNoConversationTemplateReference(
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

  async createGrant(
    actorUserId: number,
    resourceType: GrantResourceType,
    resourceId: string,
    workspaceId: string | null,
    target: GrantTarget
  ): Promise<string> {
    if (target.targetType !== 'USER' && target.targetType !== 'ORGANIZATION')
      throw new Error(
        resourceType === 'TEMPLATE'
          ? 'CONVERSATION_TEMPLATE_GRANT_SCOPE_INVALID'
          : 'RESOURCE_GRANT_TARGET_INVALID'
      );
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      await lockOrganizationReference(connection, 1);
      const scope = await this.authorization.grantScope(actorUserId, connection);
      if (scope === undefined) throw new Error('RBAC_DENIED');
      const resource = await this.grantResource(resourceType, resourceId, workspaceId, connection);
      if (resource === undefined) throw new Error('RESOURCE_NOT_FOUND');
      if (resource.ownerType !== 'ORGANIZATION')
        throw new Error(
          resourceType === 'TEMPLATE'
            ? 'CONVERSATION_TEMPLATE_HOST_NODE_INVALID'
            : 'PERSONAL_RESOURCE_NOT_SHAREABLE'
        );
      const targetOrganizationId =
        target.targetType === 'USER'
          ? await this.userOrganizationId(target.targetUserId, connection)
          : target.targetOrganizationId;
      await lockOrganizationReference(connection, targetOrganizationId);
      if (resourceType === 'TEMPLATE') {
        if (scope.role !== 'ADMIN') throw new Error('TEMPLATE_RESOURCE_ADMIN_REQUIRED');
        if (
          target.targetType !== 'ORGANIZATION' ||
          !(await this.isOrganizationInSubtree(
            targetOrganizationId,
            resource.ownerOrganizationId,
            connection
          ))
        )
          throw new Error('CONVERSATION_TEMPLATE_GRANT_SCOPE_INVALID');
      } else {
        await this.requireOwnershipManagement(
          actorUserId,
          resource,
          'RESOURCE_GRANT_MANAGE',
          connection
        );
        const allowed = await this.authorization.authorize(
          actorUserId,
          'RESOURCE_GRANT_MANAGE',
          {
            ownerType: 'ORGANIZATION',
            organizationId: targetOrganizationId
          },
          connection
        );
        if (!allowed.allowed) throw new Error(allowed.reason ?? 'RBAC_DENIED');
        if (resourceType === 'MODEL')
          await this.credentialScopes?.assertModelGrantWithinScope(resourceId, target);
      }
      const id = randomUUID();
      await this.insertGrant(
        id,
        resourceType,
        resourceType === 'NODE' || resourceType === 'WORKSPACE' ? resourceId : null,
        workspaceId,
        resourceType === 'MODEL' ? resourceId : null,
        resourceType === 'IMAGE_MODEL' ? resourceId : null,
        resourceType === 'TEMPLATE' ? resourceId : null,
        target,
        scope.organizationId,
        actorUserId,
        scope.role,
        connection
      );
      await connection.commit();
      commitMysqlAudits(connection);
      emitAudit(
        this.database,
        resourceAuditEvent(
          {
            eventType: 'resource.grant.created',
            actorUserId,
            targetType: resourceType,
            targetId: resourceType === 'WORKSPACE' ? workspaceId! : resourceId,
            ...(resourceType === 'NODE' || resourceType === 'WORKSPACE'
              ? { nodeId: resourceId }
              : {}),
            ...(resourceType === 'WORKSPACE' ? { workspaceId: workspaceId! } : {})
          },
          resource,
          { ...target, after: target }
        )
      );
      return id;
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async grantResource(
    type: GrantResourceType,
    id: string,
    workspaceId: string | null,
    connection: Pick<PoolConnection, 'execute'>
  ): Promise<StoredOwnership | undefined> {
    if (type === 'NODE') return this.node(id, true, connection, true);
    if (type === 'WORKSPACE') return this.workspace(id, workspaceId ?? '', connection, true);
    if (type === 'MODEL') return this.model(id, connection, true);
    if (type === 'IMAGE_MODEL') return this.imageModel(id, connection, true);
    return this.templateHostingNode(id, connection, true);
  }

  async listGrants(
    actorUserId: number,
    resourceType: GrantResourceType,
    resourceId: string,
    workspaceId: string | null
  ): Promise<readonly object[]> {
    if (resourceType === 'MODEL' || resourceType === 'IMAGE_MODEL' || resourceType === 'TEMPLATE') {
      if (resourceType === 'MODEL' || resourceType === 'IMAGE_MODEL') {
        const model =
          resourceType === 'MODEL'
            ? await this.model(resourceId)
            : await this.imageModel(resourceId);
        if (model === undefined) throw new Error('RESOURCE_NOT_FOUND');
        if (model.ownerType === 'PERSONAL') throw new Error('PERSONAL_RESOURCE_NOT_SHAREABLE');
        await this.requireOwnershipManagement(actorUserId, model, 'RESOURCE_GRANT_MANAGE');
      } else await this.requireTemplateAdmin(actorUserId);
      const exists =
        resourceType === 'MODEL'
          ? await this.modelExists(resourceId)
          : resourceType === 'IMAGE_MODEL'
            ? (await this.imageModel(resourceId)) !== undefined
            : await this.templateExists(resourceId);
      if (!exists) throw new Error('RESOURCE_NOT_FOUND');
    }
    const resource =
      resourceType === 'MODEL' || resourceType === 'IMAGE_MODEL' || resourceType === 'TEMPLATE'
        ? undefined
        : resourceType === 'NODE'
          ? await this.node(resourceId)
          : await this.workspace(resourceId, workspaceId ?? '');
    if (resourceType !== 'MODEL' && resourceType !== 'IMAGE_MODEL' && resourceType !== 'TEMPLATE') {
      if (resource === undefined) throw new Error('RESOURCE_NOT_FOUND');
      await this.requireOwnershipManagement(actorUserId, resource, 'RESOURCE_GRANT_MANAGE');
    }
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT id,target_type,target_user_id,target_organization_id,
              grant_scope_organization_id,created_by_user_id,created_at
       FROM resource_grants WHERE resource_key=? ORDER BY created_at,id`,
      [resourceKey(resourceType, resourceId, workspaceId)]
    );
    return rows.map((row) => ({
      id: String(row['id']),
      resourceType,
      ...(resourceType === 'NODE' || resourceType === 'WORKSPACE' ? { nodeId: resourceId } : {}),
      ...(resourceType === 'WORKSPACE' ? { workspaceId: workspaceId as string } : {}),
      ...(resourceType === 'MODEL' ? { modelId: resourceId } : {}),
      ...(resourceType === 'IMAGE_MODEL' ? { imageModelId: resourceId } : {}),
      ...(resourceType === 'TEMPLATE' ? { templateId: resourceId } : {}),
      targetType: row['target_type'],
      ...(row['target_user_id'] === null ? {} : { targetUserId: Number(row['target_user_id']) }),
      ...(row['target_organization_id'] === null
        ? {}
        : { targetOrganizationId: Number(row['target_organization_id']) }),
      ...(row['grant_scope_organization_id'] === null
        ? {}
        : { grantScopeOrganizationId: Number(row['grant_scope_organization_id']) }),
      createdByUserId: Number(row['created_by_user_id']),
      createdAt: Number(row['created_at'])
    }));
  }

  async removeGrant(actorUserId: number, grantId: string): Promise<GrantResourceType> {
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      await lockOrganizationReference(connection, 1);
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT resource_type,node_id,workspace_id,model_id,image_model_id,template_id,target_type,target_user_id,target_organization_id
         FROM resource_grants WHERE id=? FOR UPDATE`,
        [grantId]
      );
      const grant = rows[0];
      if (grant === undefined) throw new Error('RESOURCE_GRANT_NOT_FOUND');
      const type = grant['resource_type'] as GrantResourceType;
      const id = String(
        grant['template_id'] ?? grant['image_model_id'] ?? grant['model_id'] ?? grant['node_id']
      );
      const resource = await this.grantResource(
        type,
        id,
        grant['workspace_id'] as string | null,
        connection
      );
      if (resource === undefined) throw new Error('RESOURCE_NOT_FOUND');
      if (type === 'TEMPLATE') {
        const scope = await this.authorization.grantScope(actorUserId, connection);
        if (scope?.role !== 'ADMIN') throw new Error('TEMPLATE_RESOURCE_ADMIN_REQUIRED');
      } else {
        await this.requireOwnershipManagement(
          actorUserId,
          resource,
          'RESOURCE_GRANT_MANAGE',
          connection
        );
      }
      const [result] = await connection.execute<ResultSetHeader>(
        'DELETE FROM resource_grants WHERE id=?',
        [grantId]
      );
      if (result.affectedRows !== 1) throw new Error('RESOURCE_GRANT_NOT_FOUND');
      await connection.commit();
      commitMysqlAudits(connection);
      emitAudit(
        this.database,
        resourceAuditEvent(
          {
            eventType: 'resource.grant.revoked',
            actorUserId,
            targetType: type,
            targetId: type === 'WORKSPACE' ? String(grant['workspace_id']) : id,
            ...(type === 'NODE' || type === 'WORKSPACE' ? { nodeId: id } : {}),
            ...(type === 'WORKSPACE' ? { workspaceId: String(grant['workspace_id']) } : {})
          },
          resource,
          {
            targetType: grant['target_type'],
            targetUserId: grant['target_user_id'],
            targetOrganizationId: grant['target_organization_id']
          }
        )
      );
      return type;
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async assertOwnershipSelection(
    actorUserId: number,
    ownership: ResourceOwnership,
    connection?: Pick<PoolConnection, 'execute'>
  ): Promise<void> {
    if (ownership.ownerType === 'PERSONAL') {
      if (ownership.ownerUserId !== actorUserId) throw new Error('PERSONAL_RESOURCE_FORBIDDEN');
      return;
    }
    const allowed = await this.authorization.authorize(
      actorUserId,
      'RESOURCE_OWNERSHIP_MANAGE',
      {
        ownerType: 'ORGANIZATION',
        organizationId: ownership.ownerOrganizationId
      },
      connection
    );
    if (!allowed.allowed) throw new Error(allowed.reason ?? 'RBAC_DENIED');
  }

  private async requireNodeManagement(
    actorUserId: number,
    resource: StoredOwnership,
    connection?: Pick<PoolConnection, 'execute'>
  ): Promise<void> {
    const system = await this.authorization.authorize(
      actorUserId,
      'NODE_MANAGE',
      { ownerType: 'SYSTEM' },
      connection
    );
    if (system.allowed) return;
    await this.requireOwnershipManagement(actorUserId, resource, 'RESOURCE_MANAGE', connection);
  }

  private async requireOwnershipManagement(
    actorUserId: number,
    resource: StoredOwnership,
    permissionId = 'RESOURCE_MANAGE',
    connection?: Pick<PoolConnection, 'execute'>
  ): Promise<void> {
    if (resource.ownerType === 'PERSONAL' && resource.ownerUserId !== actorUserId)
      throw new Error('RBAC_SCOPE_DENIED');
    const allowed = await this.authorization.authorize(
      actorUserId,
      permissionId,
      authorizationOwnership(resource),
      connection
    );
    if (!allowed.allowed) throw new Error(allowed.reason ?? 'RBAC_DENIED');
  }

  private async node(
    nodeId: string,
    includeDisabled = false,
    query: Pick<PoolConnection, 'execute'> = this.database.raw,
    lock = false
  ): Promise<StoredOwnership | undefined> {
    const [rows] = await query.execute<RowDataPacket[]>(
      `SELECT display_name,owner_type,owner_user_id,owner_organization_id FROM nodes
       WHERE id=?${includeDisabled ? '' : ' AND disabled=FALSE'}${lock ? ' FOR SHARE' : ''}`,
      [nodeId]
    );
    return storedOwnership(rows[0]);
  }

  private async workspace(
    nodeId: string,
    workspaceId: string,
    query: Pick<MysqlServerDatabase['raw'], 'execute'> | PoolConnection = this.database.raw,
    lock = false
  ): Promise<StoredOwnership | undefined> {
    const [rows] = await query.execute<RowDataPacket[]>(
      `SELECT display_name,owner_type,owner_user_id,owner_organization_id FROM workspaces
       WHERE workspace_id=? AND node_id=?${lock ? ' FOR UPDATE' : ''}`,
      [workspaceId, nodeId]
    );
    return storedOwnership(rows[0]);
  }

  private async workspacePresentation(
    nodeId: string,
    workspaceId: string
  ): Promise<{ readonly displayName: string; readonly groupName: string | null }> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT display_name,group_name FROM workspaces WHERE workspace_id=? AND node_id=?',
      [workspaceId, nodeId]
    );
    return {
      displayName: String(rows[0]?.['display_name'] ?? workspaceId),
      groupName:
        rows[0]?.['group_name'] === null || rows[0]?.['group_name'] === undefined
          ? null
          : String(rows[0]?.['group_name'])
    };
  }

  private async userOrganizationId(
    userId: number,
    query: Pick<PoolConnection, 'execute'> = this.database.raw
  ): Promise<number> {
    const [rows] = await query.execute<RowDataPacket[]>(
      `SELECT organization_id FROM users WHERE id=? AND enabled=TRUE${query === this.database.raw ? '' : ' FOR SHARE'}`,
      [userId]
    );
    const organizationId = Number(rows[0]?.['organization_id']);
    if (!Number.isSafeInteger(organizationId)) throw new Error('USER_NOT_FOUND');
    return organizationId;
  }

  private async modelExists(modelId: string): Promise<boolean> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT id FROM mar_agent_models WHERE id=?',
      [modelId]
    );
    return rows.length === 1;
  }

  private async model(
    modelId: string,
    query: Pick<PoolConnection, 'execute'> = this.database.raw,
    lock = false
  ): Promise<StoredOwnership | undefined> {
    const [rows] = await query.execute<RowDataPacket[]>(
      `SELECT name AS display_name,owner_type,owner_user_id,owner_organization_id
       FROM mar_agent_models WHERE id=?${lock ? ' FOR SHARE' : ''}`,
      [modelId]
    );
    return storedOwnership(rows[0]);
  }

  private async imageModel(
    modelId: string,
    query: Pick<PoolConnection, 'execute'> = this.database.raw,
    lock = false
  ): Promise<StoredOwnership | undefined> {
    const [rows] = await query.execute<RowDataPacket[]>(
      `SELECT name AS display_name,owner_type,owner_user_id,owner_organization_id
       FROM mar_agent_image_models WHERE id=?${lock ? ' FOR SHARE' : ''}`,
      [modelId]
    );
    return storedOwnership(rows[0]);
  }

  private async templateExists(templateId: string): Promise<boolean> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT id FROM conversation_templates WHERE id=?',
      [templateId]
    );
    return rows.length === 1;
  }

  private async templateHostingNode(
    templateId: string,
    query: Pick<PoolConnection, 'execute'> = this.database.raw,
    lock = false
  ): Promise<StoredOwnership | undefined> {
    const [rows] = await query.execute<RowDataPacket[]>(
      `SELECT template.name AS display_name,template.source_node_id AS nodeId,template.source_workspace_id AS workspaceId,
              node.display_name AS nodeName,node.owner_type,node.owner_user_id,node.owner_organization_id
       FROM conversation_templates template
       JOIN nodes node ON node.id=template.source_node_id
       WHERE template.id=?${lock ? ' FOR SHARE' : ''}`,
      [templateId]
    );
    return storedOwnership(rows[0]);
  }

  private async organizationExists(organizationId: number): Promise<boolean> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT id FROM organizations WHERE id=?',
      [organizationId]
    );
    return rows.length === 1;
  }

  private async isModelAdmin(actorUserId: number): Promise<boolean> {
    const actor = await this.authorization.actorContext(actorUserId);
    return actor?.role === 'ADMIN' || this.authorization.isPersonalAdmin(actorUserId);
  }

  private async requireModelAdmin(actorUserId: number): Promise<void> {
    if (!(await this.isModelAdmin(actorUserId))) throw new Error('MODEL_RESOURCE_ADMIN_REQUIRED');
  }

  private async requireTemplateAdmin(actorUserId: number): Promise<void> {
    if (!(await this.isModelAdmin(actorUserId)))
      throw new Error('TEMPLATE_RESOURCE_ADMIN_REQUIRED');
  }

  private async insertGrant(
    id: string,
    resourceType: GrantResourceType,
    nodeId: string | null,
    workspaceId: string | null,
    modelId: string | null,
    imageModelId: string | null,
    templateId: string | null,
    target: GrantTarget,
    grantScopeOrganizationId: number,
    actorUserId: number,
    role: 'ADMIN' | 'ORG_ADMIN',
    connection: Pick<PoolConnection, 'execute'>
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO resource_grants
       (id,resource_type,node_id,workspace_id,model_id,image_model_id,template_id,target_type,target_user_id,
        target_organization_id,grant_scope_organization_id,created_by_user_id,
        created_by_role,created_at,resource_key,target_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        resourceType,
        nodeId,
        workspaceId,
        modelId,
        imageModelId,
        templateId,
        target.targetType,
        target.targetType === 'USER' ? target.targetUserId : null,
        target.targetType === 'ORGANIZATION' ? target.targetOrganizationId : null,
        grantScopeOrganizationId,
        actorUserId,
        role,
        this.now(),
        resourceKey(
          resourceType,
          templateId ?? imageModelId ?? modelId ?? nodeId ?? '',
          workspaceId
        ),
        target.targetType === 'USER'
          ? `USER:${target.targetUserId}`
          : `ORGANIZATION:${target.targetOrganizationId}`
      ]
    );
  }

  private async hasGrant(
    actorUserId: number,
    resourceType: GrantResourceType,
    key: string
  ): Promise<boolean> {
    if (await this.authorization.isPersonalAdmin(actorUserId)) return false;
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `WITH RECURSIVE actor_organizations AS (
        SELECT o.id,o.parent_organization_id FROM users u
        JOIN organizations o ON o.id=u.organization_id WHERE u.id=? AND u.enabled=TRUE
        UNION ALL SELECT parent.id,parent.parent_organization_id FROM organizations parent
        JOIN actor_organizations child ON child.parent_organization_id=parent.id
      ) SELECT 1 FROM resource_grants grant_record
       WHERE grant_record.resource_type=? AND grant_record.resource_key=?
         AND ((grant_record.target_type='USER' AND grant_record.target_user_id=?)
           OR (grant_record.target_type='ORGANIZATION' AND grant_record.target_organization_id IN
             (SELECT id FROM actor_organizations))) LIMIT 1`,
      [actorUserId, resourceType, key, actorUserId]
    );
    return rows.length === 1;
  }

  private async hasDirectUserNodeGrant(
    actorUserId: number,
    nodeId: string,
    connection?: PoolConnection,
    lock = false
  ): Promise<boolean> {
    const [rows] = await (connection ?? this.database.raw).execute<RowDataPacket[]>(
      `SELECT 1 FROM resource_grants grant_record
       JOIN users actor ON actor.id=? AND actor.enabled=TRUE
       WHERE grant_record.resource_type='NODE' AND grant_record.resource_key=?
         AND grant_record.target_type='USER' AND grant_record.target_user_id=?
       LIMIT 1${lock ? ' FOR SHARE' : ''}`,
      [actorUserId, resourceKey('NODE', nodeId, null), actorUserId]
    );
    return rows.length === 1;
  }

  private async hasTemplateOrganizationGrant(
    actorUserId: number,
    templateId: string,
    hostingOrganizationId: number
  ): Promise<boolean> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `WITH RECURSIVE actor_organizations AS (
        SELECT organization.id,organization.parent_organization_id
        FROM users actor
        JOIN organizations organization ON organization.id=actor.organization_id
        WHERE actor.id=? AND actor.enabled=TRUE
        UNION ALL
        SELECT parent.id,parent.parent_organization_id
        FROM organizations parent
        JOIN actor_organizations child ON child.parent_organization_id=parent.id
      ), hosting_subtree AS (
        SELECT id FROM organizations WHERE id=?
        UNION ALL
        SELECT child.id FROM organizations child
        JOIN hosting_subtree parent ON child.parent_organization_id=parent.id
      )
      SELECT 1 FROM resource_grants grant_record
      WHERE grant_record.resource_type='TEMPLATE'
        AND grant_record.resource_key=?
        AND grant_record.target_type='ORGANIZATION'
        AND grant_record.target_organization_id IN (SELECT id FROM actor_organizations)
        AND grant_record.target_organization_id IN (SELECT id FROM hosting_subtree)
      LIMIT 1`,
      [actorUserId, hostingOrganizationId, resourceKey('TEMPLATE', templateId, null)]
    );
    return rows.length === 1;
  }

  private async isOrganizationInSubtree(
    organizationId: number,
    ancestorOrganizationId: number,
    query: Pick<PoolConnection, 'execute'> = this.database.raw
  ): Promise<boolean> {
    const [rows] = await query.execute<RowDataPacket[]>(
      `WITH RECURSIVE ancestors AS (
        SELECT id,parent_organization_id FROM organizations WHERE id=?
        UNION ALL
        SELECT parent.id,parent.parent_organization_id FROM organizations parent
        JOIN ancestors child ON child.parent_organization_id=parent.id
      ) SELECT 1 FROM ancestors WHERE id=? LIMIT 1`,
      [organizationId, ancestorOrganizationId]
    );
    return rows.length === 1;
  }

  private async hasVisibleWorkspace(actorUserId: number, nodeId: string): Promise<boolean> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT workspace_id FROM workspaces WHERE node_id=?',
      [nodeId]
    );
    for (const row of rows)
      if (await this.canUseWorkspace(actorUserId, nodeId, String(row['workspace_id']))) return true;
    return false;
  }

  private async revokeResourceGrantsOutsideAuthority(
    resourceType: 'NODE' | 'WORKSPACE',
    nodeId: string,
    workspaceId: string | null,
    ownerOrganizationId: number,
    connection: Pick<PoolConnection, 'execute'> = this.database.raw
  ): Promise<void> {
    await connection.execute(
      `DELETE FROM resource_grants WHERE resource_key=?
       AND NOT EXISTS (
         WITH RECURSIVE ancestors AS (
           SELECT id,parent_organization_id FROM organizations WHERE id=?
           UNION ALL SELECT parent.id,parent.parent_organization_id FROM organizations parent
           JOIN ancestors child ON child.parent_organization_id=parent.id
         ) SELECT 1 FROM ancestors WHERE id=resource_grants.grant_scope_organization_id
       )`,
      [`${resourceType}:${nodeId}:${workspaceId ?? ''}`, ownerOrganizationId]
    );
  }

  private async revokeHostedTemplateGrantsOutsideAuthority(
    nodeId: string,
    ownerOrganizationId: number
  ): Promise<void> {
    await this.database.raw.execute(
      `DELETE grant_record FROM resource_grants grant_record
       JOIN conversation_templates template ON template.id=grant_record.template_id
       WHERE grant_record.resource_type='TEMPLATE' AND template.source_node_id=?
         AND (grant_record.target_type<>'ORGANIZATION'
           OR grant_record.target_organization_id IS NULL
           OR NOT EXISTS (
             WITH RECURSIVE ancestors AS (
               SELECT id,parent_organization_id FROM organizations
               WHERE id=grant_record.target_organization_id
               UNION ALL
               SELECT parent.id,parent.parent_organization_id FROM organizations parent
               JOIN ancestors child ON child.parent_organization_id=parent.id
             ) SELECT 1 FROM ancestors WHERE id=?
           ))`,
      [nodeId, ownerOrganizationId]
    );
  }
}

type StoredOwnership = (
  | { readonly ownerType: 'PERSONAL'; readonly ownerUserId: number }
  | { readonly ownerType: 'ORGANIZATION'; readonly ownerOrganizationId: number }
) & { readonly displayName?: string };

function resourceKey(
  resourceType: GrantResourceType,
  resourceId: string,
  workspaceId: string | null
): string {
  return resourceType === 'MODEL' || resourceType === 'IMAGE_MODEL' || resourceType === 'TEMPLATE'
    ? `${resourceType}:${resourceId}`
    : `${resourceType}:${resourceId}:${workspaceId ?? ''}`;
}

function workspaceDisplayName(workspace: { readonly id: string }): string {
  const path =
    'path' in workspace && typeof workspace.path === 'string' ? workspace.path : undefined;
  return path?.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspace.id;
}

function storedOwnership(row: RowDataPacket | undefined): StoredOwnership | undefined {
  if (row === undefined) return undefined;
  const source = {
    ...Object.fromEntries(
      ['nodeId', 'workspaceId', 'nodeName']
        .filter((key) => typeof row[key] === 'string')
        .map((key) => [key, row[key]])
    ),
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

function authorizationOwnership(resource: StoredOwnership) {
  return resource.ownerType === 'PERSONAL'
    ? { ownerType: resource.ownerType, ownerUserId: resource.ownerUserId }
    : { ownerType: resource.ownerType, organizationId: resource.ownerOrganizationId };
}

function sameOwnership(left: ResourceOwnership, right: ResourceOwnership): boolean {
  return (
    left.ownerType === right.ownerType &&
    (left.ownerType === 'PERSONAL'
      ? left.ownerUserId ===
        (right as Extract<ResourceOwnership, { ownerType: 'PERSONAL' }>).ownerUserId
      : left.ownerOrganizationId ===
        (right as Extract<ResourceOwnership, { ownerType: 'ORGANIZATION' }>).ownerOrganizationId)
  );
}

function nodeOwnershipWorkspacePlacementError(): Error & {
  readonly publicMessage: string;
  readonly publicDetails: string;
} {
  return Object.assign(new Error('NODE_OWNERSHIP_WORKSPACE_INCOMPATIBLE'), {
    publicMessage:
      "The Node can't be moved to the selected organization because one or more Workspaces would fall outside its organization subtree.",
    publicDetails:
      'Move each affected Workspace to the selected organization or one of its descendant organizations, then retry.'
  });
}

async function validateWorkspacePlacement(
  database: Pick<PoolConnection, 'execute'>,
  node: StoredOwnership,
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
