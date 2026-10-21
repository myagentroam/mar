import {
  emitAuditAfterCommit,
  emitAudit,
  commitMysqlAudits,
  discardMysqlAudits
} from '@myagentroam/server-core/audit';

import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import { lockOrganizationReference, withOrganizationReference } from './organization-reference.js';
import { revokeOutOfScopeResourceGrants } from './resource-grant-scope.js';
import type { AuthorizationProvider, AuthorizationConnection } from '../product/product-policy.js';

export class OrganizationService {
  constructor(
    private readonly database: MysqlServerDatabase,
    private readonly authorization: AuthorizationProvider,
    private readonly now: () => number = Date.now
  ) {}

  async list(actorUserId: number): Promise<readonly object[]> {
    const ids = await this.authorization.managedOrganizationIds(actorUserId);
    if (ids.length === 0) throw new Error('RBAC_DENIED');
    const [rows] = await this.database.raw.query<RowDataPacket[]>(
      `SELECT id,name,parent_organization_id,created_at,updated_at
       FROM organizations WHERE id IN (?) ORDER BY id`,
      [ids]
    );
    return rows.map(publicOrganization);
  }

  async create(actorUserId: number, name: string, parentOrganizationId: number): Promise<object> {
    const id = await withOrganizationReference(
      this.database.raw,
      1,
      async (connection) => {
        await requirePermission(
          this.authorization,
          actorUserId,
          'ORG_MANAGE',
          parentOrganizationId,
          false,
          connection
        );
        const timestamp = this.now();
        const [result] = await connection.execute<ResultSetHeader>(
          `INSERT INTO organizations (name,parent_organization_id,created_at,updated_at)
         SELECT ?,id,?,? FROM organizations WHERE id=?`,
          [name, timestamp, timestamp, parentOrganizationId]
        );
        if (result.affectedRows !== 1) throw new Error('ORGANIZATION_PARENT_NOT_FOUND');
        return result.insertId;
      },
      true
    );
    emitAudit(this.database, {
      eventType: 'organization.created',
      actorUserId,
      targetType: 'ORGANIZATION',
      targetId: String(id),
      targetName: name,
      organizationId: id,
      metadata: JSON.stringify({ parentOrganizationId })
    });
    return this.get(id);
  }

  async rename(actorUserId: number, organizationId: number, name: string): Promise<object> {
    await withOrganizationReference(
      this.database.raw,
      1,
      async (connection) => {
        await requirePermission(
          this.authorization,
          actorUserId,
          'ORG_MANAGE',
          organizationId,
          false,
          connection
        );
        const [before] = await connection.execute<RowDataPacket[]>(
          'SELECT name FROM organizations WHERE id=?',
          [organizationId]
        );
        const [result] = await connection.execute<ResultSetHeader>(
          'UPDATE organizations SET name=?,updated_at=? WHERE id=?',
          [name, this.now(), organizationId]
        );
        if (result.affectedRows !== 1) throw new Error('ORGANIZATION_NOT_FOUND');
        emitAuditAfterCommit(this.database, connection, {
          eventType: 'organization.renamed',
          actorUserId,
          targetType: 'ORGANIZATION',
          targetId: String(organizationId),
          targetName: name,
          organizationId,
          metadata: JSON.stringify({ before: { name: before[0]?.['name'] }, after: { name } })
        });
      },
      true
    );
    return this.get(organizationId);
  }

  async move(
    actorUserId: number,
    organizationId: number,
    parentOrganizationId: number
  ): Promise<object> {
    if (organizationId === 1) throw new Error('ROOT_ORGANIZATION_PROTECTED');
    await requirePermission(this.authorization, actorUserId, 'ORG_MANAGE', organizationId, true);
    await requirePermission(this.authorization, actorUserId, 'ORG_MANAGE', parentOrganizationId);
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      await lockOrganizationReference(connection, 1, true);
      await requirePermission(
        this.authorization,
        actorUserId,
        'ORG_MANAGE',
        organizationId,
        true,
        connection
      );
      await requirePermission(
        this.authorization,
        actorUserId,
        'ORG_MANAGE',
        parentOrganizationId,
        false,
        connection
      );
      const [before] = await connection.execute<RowDataPacket[]>(
        'SELECT name,parent_organization_id FROM organizations WHERE id=?',
        [organizationId]
      );
      const [cycleRows] = await connection.execute<RowDataPacket[]>(
        `WITH RECURSIVE subtree AS (
          SELECT id FROM organizations WHERE id=?
          UNION ALL SELECT child.id FROM organizations child
          JOIN subtree parent ON child.parent_organization_id=parent.id
        ) SELECT id FROM subtree WHERE id=?`,
        [organizationId, parentOrganizationId]
      );
      if (cycleRows.length > 0) throw new Error('ORGANIZATION_CYCLE');
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE organizations SET parent_organization_id=?,updated_at=?
         WHERE id=? AND parent_organization_id IS NOT NULL`,
        [parentOrganizationId, this.now(), organizationId]
      );
      if (result.affectedRows !== 1) throw new Error('ORGANIZATION_NOT_FOUND');
      emitAuditAfterCommit(this.database, connection, {
        eventType: 'organization.moved',
        actorUserId,
        targetType: 'ORGANIZATION',
        targetId: String(organizationId),
        targetName: String(before[0]?.['name'] ?? organizationId),
        organizationId,
        metadata: JSON.stringify({
          before: { parentOrganizationId: before[0]?.['parent_organization_id'] },
          after: { parentOrganizationId }
        })
      });
      await validateAllWorkspacePlacements(connection);
      await revokeOutOfScopeResourceGrants(connection);
      await connection.commit();
      commitMysqlAudits(connection);
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return this.get(organizationId);
  }

  async remove(actorUserId: number, organizationId: number): Promise<void> {
    if (organizationId === 1) throw new Error('ROOT_ORGANIZATION_PROTECTED');
    await requirePermission(this.authorization, actorUserId, 'ORG_MANAGE', organizationId, true);
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      await lockOrganizationReference(connection, 1, true);
      await requirePermission(
        this.authorization,
        actorUserId,
        'ORG_MANAGE',
        organizationId,
        true,
        connection
      );
      // Acquire the parent lock before any snapshot reads of its dependants.
      await connection.execute('SELECT id FROM organizations WHERE id=? FOR UPDATE', [
        organizationId
      ]);
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT name,parent_organization_id,
          (SELECT COUNT(*) FROM organizations WHERE parent_organization_id=?) AS child_count,
          (SELECT COUNT(*) FROM users WHERE organization_id=?) AS member_count,
          (SELECT COUNT(*) FROM oauth_providers WHERE default_organization_id=?) AS provider_count
         FROM organizations WHERE id=? FOR UPDATE`,
        [organizationId, organizationId, organizationId, organizationId]
      );
      const organization = rows[0];
      if (organization === undefined) throw new Error('ORGANIZATION_NOT_FOUND');
      if (
        Number(organization['child_count']) > 0 ||
        Number(organization['member_count']) > 0 ||
        Number(organization['provider_count']) > 0
      ) {
        throw new Error('ORGANIZATION_NOT_EMPTY');
      }
      const parentId = Number(organization['parent_organization_id']);
      const [tokenRows] = await connection.execute<RowDataPacket[]>(
        'SELECT token_hash FROM node_registration_tokens WHERE owner_organization_id=? LIMIT 1 FOR UPDATE',
        [organizationId]
      );
      if (tokenRows.length > 0) throw new Error('ORGANIZATION_NOT_EMPTY');
      // Resource writers lock the same parent rows before adding dependent records.
      for (const sql of [
        'SELECT id FROM mar_agent_models WHERE owner_organization_id=? ORDER BY id FOR UPDATE',
        'SELECT id FROM mar_agent_image_models WHERE owner_organization_id=? ORDER BY id FOR UPDATE',
        'SELECT id FROM skill_sources WHERE owner_organization_id=? ORDER BY id FOR UPDATE',
        'SELECT id FROM skill_favorites WHERE owner_organization_id=? ORDER BY id FOR UPDATE'
      ])
        await connection.execute(sql, [organizationId]);
      const [externalFavorites] = await connection.execute<RowDataPacket[]>(
        `SELECT favorite.id FROM skill_favorites favorite
         JOIN skill_sources source ON source.id=favorite.source_id
         WHERE source.owner_organization_id=?
           AND (favorite.owner_organization_id IS NULL OR favorite.owner_organization_id<>?)
         LIMIT 1 FOR SHARE`,
        [organizationId, organizationId]
      );
      if (externalFavorites.length > 0)
        throw Object.assign(new Error('SKILL_SOURCE_IN_USE'), {
          publicDetails:
            'A Skill source owned by this organization is still referenced outside the organization.'
        });
      await connection.execute(
        `UPDATE nodes SET owner_organization_id=?,updated_at=?
         WHERE owner_type='ORGANIZATION' AND owner_organization_id=?`,
        [parentId, this.now(), organizationId]
      );
      await connection.execute(
        `UPDATE workspaces SET owner_organization_id=?
         WHERE owner_type='ORGANIZATION' AND owner_organization_id=?`,
        [parentId, organizationId]
      );
      await connection.execute(
        `DELETE FROM resource_grants
         WHERE (resource_type='MODEL' AND model_id IN (
           SELECT id FROM mar_agent_models
           WHERE owner_type='ORGANIZATION' AND owner_organization_id=?
         ))
            OR (resource_type='IMAGE_MODEL' AND image_model_id IN (
           SELECT id FROM mar_agent_image_models
           WHERE owner_type='ORGANIZATION' AND owner_organization_id=?
         ))`,
        [organizationId, organizationId]
      );
      await connection.execute(
        `DELETE FROM user_mar_agent_model_orders
         WHERE model_id IN (
           SELECT id FROM mar_agent_models
           WHERE owner_type='ORGANIZATION' AND owner_organization_id=?
         )`,
        [organizationId]
      );
      await connection.execute(
        `DELETE FROM user_mar_agent_image_model_orders
         WHERE image_model_id IN (
           SELECT id FROM mar_agent_image_models
           WHERE owner_type='ORGANIZATION' AND owner_organization_id=?
         )`,
        [organizationId]
      );
      await connection.execute(
        `DELETE FROM mar_agent_models
         WHERE owner_type='ORGANIZATION' AND owner_organization_id=?`,
        [organizationId]
      );
      await connection.execute(
        `DELETE FROM mar_agent_image_models
         WHERE owner_type='ORGANIZATION' AND owner_organization_id=?`,
        [organizationId]
      );
      await connection.execute(
        `DELETE FROM resource_grants
         WHERE grant_scope_organization_id=? OR target_organization_id=?`,
        [organizationId, organizationId]
      );
      await connection.execute('DELETE FROM environment_secrets WHERE organization_id=?', [
        organizationId
      ]);
      await connection.execute(
        'DELETE FROM skill_versions WHERE favorite_id IN (SELECT id FROM skill_favorites WHERE owner_organization_id=?)',
        [organizationId]
      );
      await connection.execute('DELETE FROM skill_favorites WHERE owner_organization_id=?', [
        organizationId
      ]);
      await connection.execute('DELETE FROM skill_sources WHERE owner_organization_id=?', [
        organizationId
      ]);
      await connection.execute('DELETE FROM mcp_catalog_entries WHERE owner_organization_id=?', [
        organizationId
      ]);
      await connection.execute('DELETE FROM mcp_sources WHERE owner_organization_id=?', [
        organizationId
      ]);
      await revokeOutOfScopeResourceGrants(connection);
      emitAuditAfterCommit(this.database, connection, {
        eventType: 'organization.deleted',
        actorUserId,
        targetType: 'ORGANIZATION',
        targetId: String(organizationId),
        targetName: String(rows[0]?.['name'] ?? organizationId),
        organizationId,
        metadata: JSON.stringify({ parentOrganizationId: rows[0]?.['parent_organization_id'] })
      });
      await connection.execute('DELETE FROM organizations WHERE id=?', [organizationId]);
      await connection.commit();
      commitMysqlAudits(connection);
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async memberUserIds(organizationId: number): Promise<readonly number[]> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `WITH RECURSIVE subtree AS (
        SELECT id FROM organizations WHERE id=?
        UNION ALL SELECT child.id FROM organizations child
        JOIN subtree parent ON child.parent_organization_id=parent.id
      ) SELECT u.id FROM users u JOIN subtree organization ON organization.id=u.organization_id`,
      [organizationId]
    );
    return rows.map((row) => Number(row['id']));
  }

  private async get(organizationId: number): Promise<object> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT id,name,parent_organization_id,created_at,updated_at
       FROM organizations WHERE id=?`,
      [organizationId]
    );
    if (rows[0] === undefined) throw new Error('ORGANIZATION_NOT_FOUND');
    return publicOrganization(rows[0]);
  }
}

async function validateAllWorkspacePlacements(
  connection: Pick<PoolConnection, 'execute'>
): Promise<void> {
  const [organizationRows] = await connection.execute<RowDataPacket[]>(
    'SELECT id,parent_organization_id FROM organizations'
  );
  const parents = new Map<number, number | null>(
    organizationRows.map((row) => [
      Number(row['id']),
      row['parent_organization_id'] === null ? null : Number(row['parent_organization_id'])
    ])
  );
  const [workspaceRows] = await connection.execute<RowDataPacket[]>(
    `SELECT workspace.owner_organization_id AS workspace_organization_id,
            node.owner_organization_id AS node_organization_id
     FROM workspaces workspace JOIN nodes node ON node.id=workspace.node_id
     WHERE workspace.owner_type='ORGANIZATION' AND node.owner_type='ORGANIZATION'`
  );
  for (const row of workspaceRows) {
    const workspaceOrganizationId = Number(row['workspace_organization_id']);
    const nodeOrganizationId = Number(row['node_organization_id']);
    let current: number | null | undefined = workspaceOrganizationId;
    while (current !== null && current !== undefined && current !== nodeOrganizationId)
      current = parents.get(current);
    if (current !== nodeOrganizationId)
      throw new Error('ORGANIZATION_MOVE_RESOURCE_PLACEMENT_INVALID');
  }
}

async function requirePermission(
  authorization: AuthorizationProvider,
  actorUserId: number,
  permissionId: string,
  organizationId: number,
  strictDescendant = false,
  connection?: AuthorizationConnection
): Promise<void> {
  const result = await authorization.authorize(
    actorUserId,
    permissionId,
    {
      ownerType: 'ORGANIZATION',
      organizationId,
      strictDescendant
    },
    connection
  );
  if (!result.allowed) throw new Error(result.reason ?? 'RBAC_DENIED');
}

function publicOrganization(row: RowDataPacket): object {
  return {
    id: Number(row['id']),
    name: String(row['name']),
    parentOrganizationId:
      row['parent_organization_id'] === null ? null : Number(row['parent_organization_id']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at'])
  };
}
