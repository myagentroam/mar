import { randomUUID } from 'node:crypto';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  emitAudit,
  resourceAuditEvent,
  commitMysqlAudits,
  discardMysqlAudits
} from '@myagentroam/server-core/audit';
import { lockOrganizationReference } from './organization-reference.js';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { AuthorizationProvider } from '../product/product-policy.js';
import { ResourceOwnershipStore } from './resource-ownership-store.js';
import type {
  ResourceOwnershipSnapshot,
  TemplateHostingNodeSnapshot
} from './resource-ownership-contracts.js';
import { requireOwnershipManagement } from './resource-ownership-policy.js';
import {
  resourceKey,
  type GrantResourceType,
  type GrantTarget
} from './resource-grant-contracts.js';

/** Owns resource-grant reads and transactional changes. */
export class ResourceGrantService {
  private readonly ownership: ResourceOwnershipStore;
  constructor(
    private readonly database: MysqlServerDatabase,
    private readonly authorization: AuthorizationProvider,
    private readonly credentialScopes: {
      assertModelGrantWithinScope(modelId: string, target: GrantTarget): Promise<void>;
    },
    private readonly now: () => number = Date.now
  ) {
    this.ownership = new ResourceOwnershipStore(database);
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
        await requireOwnershipManagement(
          this.authorization,
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
          await this.credentialScopes.assertModelGrantWithinScope(resourceId, target);
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
  ): Promise<ResourceOwnershipSnapshot | TemplateHostingNodeSnapshot | undefined> {
    if (type === 'NODE') return this.ownership.node(id, true, connection, true);
    if (type === 'WORKSPACE')
      return this.ownership.workspace(id, workspaceId ?? '', connection, true);
    if (type === 'MODEL') return this.ownership.model(id, connection, true);
    if (type === 'IMAGE_MODEL') return this.ownership.imageModel(id, connection, true);
    return this.ownership.templateHostingNode(id, connection, true);
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
            ? await this.ownership.model(resourceId)
            : await this.ownership.imageModel(resourceId);
        if (model === undefined) throw new Error('RESOURCE_NOT_FOUND');
        if (model.ownerType === 'PERSONAL') throw new Error('PERSONAL_RESOURCE_NOT_SHAREABLE');
        await requireOwnershipManagement(
          this.authorization,
          actorUserId,
          model,
          'RESOURCE_GRANT_MANAGE'
        );
      } else await this.requireTemplateAdmin(actorUserId);
      const exists =
        resourceType === 'MODEL'
          ? await this.modelExists(resourceId)
          : resourceType === 'IMAGE_MODEL'
            ? (await this.ownership.imageModel(resourceId)) !== undefined
            : await this.templateExists(resourceId);
      if (!exists) throw new Error('RESOURCE_NOT_FOUND');
    }
    const resource =
      resourceType === 'MODEL' || resourceType === 'IMAGE_MODEL' || resourceType === 'TEMPLATE'
        ? undefined
        : resourceType === 'NODE'
          ? await this.ownership.node(resourceId)
          : await this.ownership.workspace(resourceId, workspaceId ?? '');
    if (resourceType !== 'MODEL' && resourceType !== 'IMAGE_MODEL' && resourceType !== 'TEMPLATE') {
      if (resource === undefined) throw new Error('RESOURCE_NOT_FOUND');
      await requireOwnershipManagement(
        this.authorization,
        actorUserId,
        resource,
        'RESOURCE_GRANT_MANAGE'
      );
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
        await requireOwnershipManagement(
          this.authorization,
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

  private async templateExists(templateId: string): Promise<boolean> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT id FROM conversation_templates WHERE id=?',
      [templateId]
    );
    return rows.length === 1;
  }

  private async isModelAdmin(actorUserId: number): Promise<boolean> {
    const actor = await this.authorization.actorContext(actorUserId);
    return actor?.role === 'ADMIN' || this.authorization.isPersonalAdmin(actorUserId);
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
}
