import {
  assertNoConversationTemplateReference,
  validateWorkspacePlacement
} from './workspace-ownership-rules.js';
import { hasDirectUserNodeGrant } from './node-grant-facts.js';

import { authorizationOwnership, requireOwnershipManagement } from './resource-ownership-policy.js';
import { resourceKey, type GrantResourceType } from './resource-grant-contracts.js';
import { lockOrganizationReference } from './organization-reference.js';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { ResourceOwnership } from '@myagentroam/protocol';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { AuthorizationProvider } from '../product/product-policy.js';
import { ResourceOwnershipStore } from './resource-ownership-store.js';
import type { ResourceOwnershipSnapshot } from './resource-ownership-contracts.js';

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

const WORKSPACE_REMOVAL_OPERATIONS = new Set(['workspace.remove']);

export class ResourceAccessService {
  private readonly ownership: ResourceOwnershipStore;

  constructor(
    private readonly database: MysqlServerDatabase,
    private readonly authorization: AuthorizationProvider,
    private readonly now: () => number = Date.now,
    private readonly credentialScopes?: {
      canUserUseModelCredential(userId: number, modelId: string): Promise<boolean>;
    },
    private readonly personalHostingAdmission?: (userId: number) => Promise<boolean>
  ) {
    this.ownership = new ResourceOwnershipStore(database);
  }

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
    const resource = await this.ownership.node(nodeId);
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
    const node = await this.ownership.node(nodeId);
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
    const resource = await this.ownership.model(modelId);
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
    const resource = await this.ownership.model(modelId);
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
    const resource = await this.ownership.imageModel(modelId);
    if (resource === undefined) return false;
    return resource.ownerType === 'PERSONAL'
      ? resource.ownerUserId === actorUserId
      : this.hasGrant(actorUserId, 'IMAGE_MODEL', resourceKey('IMAGE_MODEL', modelId, null));
  }

  async canManageImageModel(actorUserId: number, modelId: string): Promise<boolean> {
    const resource = await this.ownership.imageModel(modelId);
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
    const hostingNode = await this.ownership.templateHostingNode(templateId);
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

  async assertCanManageConversationTemplate(
    actorUserId: number,
    nodeId: string,
    workspaceId: string,
    connection: PoolConnection
  ): Promise<void> {
    const actor = await this.authorization.actorContext(actorUserId, connection);
    if (actor?.role !== 'ADMIN') throw new Error('ADMIN_REQUIRED');
    await this.assertCanHostConversationTemplate(nodeId, connection);
    const workspace = await this.ownership.workspace(nodeId, workspaceId, connection, true);
    if (workspace === undefined) throw new Error('WORKSPACE_NOT_FOUND');
    await requireOwnershipManagement(
      this.authorization,
      actorUserId,
      workspace,
      'RESOURCE_USE',
      connection
    );
  }

  async assertCanHostConversationTemplate(
    nodeId: string,
    connection?: PoolConnection
  ): Promise<void> {
    const node = await this.ownership.node(nodeId, true, connection, connection !== undefined);
    if (
      node?.ownerType === 'PERSONAL' &&
      (await this.personalHostingAdmission?.(node.ownerUserId)) === true
    )
      return;
    if (node?.ownerType !== 'ORGANIZATION')
      throw new Error('CONVERSATION_TEMPLATE_HOST_NODE_INVALID');
  }

  async canUseWorkspace(
    actorUserId: number,
    nodeId: string,
    workspaceId: string
  ): Promise<boolean> {
    const workspace = await this.ownership.workspace(nodeId, workspaceId);
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
    if (operation === 'workbench.node.upgrade.receive')
      return (
        (await this.canAccessNodeContainer(actorUserId, nodeId)) ||
        this.canManageNode(actorUserId, nodeId)
      );
    if (NODE_MANAGEMENT_OPERATIONS.has(operation)) return this.canManageNode(actorUserId, nodeId);
    if (WORKSPACE_REMOVAL_OPERATIONS.has(operation) && workspaceId !== undefined) {
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
    const resource = await this.ownership.node(nodeId, true);
    if (resource === undefined) throw new Error('NODE_NOT_FOUND');
    await this.requireNodeManagement(actorUserId, resource);
  }

  async canManageNode(
    actorUserId: number,
    nodeId: string,
    connection?: PoolConnection
  ): Promise<boolean> {
    try {
      if (connection === undefined) await this.assertCanManageNode(actorUserId, nodeId);
      else {
        const node = await this.ownership.node(nodeId, true, connection, true);
        if (node === undefined) return false;
        await this.requireNodeManagement(actorUserId, node, connection);
      }
      return true;
    } catch {
      return false;
    }
  }

  async canManageNodeSecrets(actorUserId: number, nodeId: string): Promise<boolean> {
    if (await this.canManageNode(actorUserId, nodeId)) return true;
    const resource = await this.ownership.node(nodeId, true);
    return (
      resource?.ownerType === 'ORGANIZATION' &&
      (await hasDirectUserNodeGrant(this.database, actorUserId, nodeId))
    );
  }

  async canRegisterWorkspace(
    actorUserId: number,
    nodeId: string,
    connection?: PoolConnection
  ): Promise<boolean> {
    const resource = await this.ownership.node(nodeId, false, connection, connection !== undefined);
    if (resource === undefined) return false;
    try {
      await requireOwnershipManagement(
        this.authorization,
        actorUserId,
        resource,
        'RESOURCE_MANAGE',
        connection
      );
      return true;
    } catch {
      return (
        resource.ownerType === 'ORGANIZATION' &&
        (await hasDirectUserNodeGrant(
          this.database,
          actorUserId,
          nodeId,
          connection,
          connection !== undefined
        ))
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

  async projectNodeWorkspaces<T extends { readonly id: string }>(
    actorUserId: number,
    nodeId: string,
    workspaces: readonly T[]
  ): Promise<readonly T[]> {
    const visible: Array<T & { readonly ownership: ResourceOwnership }> = [];
    for (const workspace of workspaces) {
      if (!(await this.canUseWorkspace(actorUserId, nodeId, workspace.id))) continue;
      const ownership = await this.ownership.workspace(nodeId, workspace.id);
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

  async resolveWorkspaceOwnership(
    actorUserId: number,
    nodeId: string,
    requestedOwnership?: ResourceOwnership,
    connection?: PoolConnection
  ): Promise<ResourceOwnership> {
    const node = await this.ownership.node(nodeId, false, connection, connection !== undefined);
    if (node === undefined) throw new Error('NODE_NOT_FOUND');
    if (
      node.ownerType === 'ORGANIZATION' &&
      !(await this.canManageNode(actorUserId, nodeId, connection)) &&
      (await hasDirectUserNodeGrant(
        this.database,
        actorUserId,
        nodeId,
        connection,
        connection !== undefined
      ))
    )
      return {
        ownerType: 'ORGANIZATION',
        ownerOrganizationId: node.ownerOrganizationId
      };
    const ownership = requestedOwnership ?? {
      ownerType: 'PERSONAL' as const,
      ownerUserId: actorUserId
    };
    await this.assertOwnershipSelection(actorUserId, ownership, connection);
    await validateWorkspacePlacement(connection ?? this.database.raw, node, ownership);
    return ownership;
  }

  async assertCanManageWorkspace(
    actorUserId: number,
    nodeId: string,
    workspaceId: string
  ): Promise<void> {
    const workspace = await this.ownership.workspace(nodeId, workspaceId);
    if (workspace === undefined) throw new Error('WORKSPACE_NOT_FOUND');
    await requireOwnershipManagement(this.authorization, actorUserId, workspace);
  }

  async assertCanUnregisterWorkspace(
    actorUserId: number,
    nodeId: string,
    workspaceId: string,
    connection?: PoolConnection
  ): Promise<void> {
    if (connection !== undefined) await this.ownership.node(nodeId, true, connection, true);
    const workspace = await this.ownership.workspace(
      nodeId,
      workspaceId,
      connection,
      connection !== undefined
    );
    if (workspace === undefined) throw new Error('WORKSPACE_NOT_FOUND');
    if (
      (workspace.ownerType === 'PERSONAL' && workspace.ownerUserId !== actorUserId) ||
      !(
        await this.authorization.authorize(
          actorUserId,
          'RESOURCE_MANAGE',
          authorizationOwnership(workspace),
          connection
        )
      ).allowed
    )
      throw new Error('WORKSPACE_FORBIDDEN');
    await assertNoConversationTemplateReference(
      connection ?? this.database.raw,
      workspaceId,
      connection !== undefined
    );
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
    resource: ResourceOwnershipSnapshot,
    connection?: Pick<PoolConnection, 'execute'>
  ): Promise<void> {
    const system = await this.authorization.authorize(
      actorUserId,
      'NODE_MANAGE',
      { ownerType: 'SYSTEM' },
      connection
    );
    if (system.allowed) return;
    await requireOwnershipManagement(
      this.authorization,
      actorUserId,
      resource,
      'RESOURCE_MANAGE',
      connection
    );
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

  private async organizationExists(organizationId: number): Promise<boolean> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT id FROM organizations WHERE id=?',
      [organizationId]
    );
    return rows.length === 1;
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

  private async hasVisibleWorkspace(actorUserId: number, nodeId: string): Promise<boolean> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT workspace_id FROM workspaces WHERE node_id=?',
      [nodeId]
    );
    for (const row of rows)
      if (await this.canUseWorkspace(actorUserId, nodeId, String(row['workspace_id']))) return true;
    return false;
  }
}
