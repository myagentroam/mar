import type { RowDataPacket } from 'mysql2/promise';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import {
  loadPermissionMatrix,
  type PermissionMatrix,
  type PermissionScope
} from './permission-matrix.js';

import type {
  ActorAuthorizationContext,
  AuthorizationConnection,
  AuthorizationContext,
  AuthorizationProvider
} from '../product/product-policy.js';
export type { ActorAuthorizationContext, AuthorizationContext } from '../product/product-policy.js';

export class AuthorizationService implements AuthorizationProvider {
  constructor(
    private readonly database: MysqlServerDatabase,
    private readonly matrix: PermissionMatrix = loadPermissionMatrix(),
    private readonly personalEdition: (actorUserId: number) => Promise<boolean> = async () => false
  ) {}

  async authorize(
    actorUserId: number,
    permissionId: string,
    context: AuthorizationContext = {},
    connection?: AuthorizationConnection
  ): Promise<{ readonly allowed: boolean; readonly reason?: string }> {
    if (!this.matrix.permissions.has(permissionId))
      return { allowed: false, reason: 'RBAC_PERMISSION_UNKNOWN' };
    const actor = await this.actorContext(actorUserId, connection);
    if (await this.personalEdition(actorUserId)) {
      if (!(await this.isPersonalAdmin(actorUserId)))
        return { allowed: false, reason: 'RBAC_ACTOR_INVALID' };
      const personal =
        context.ownerType === 'PERSONAL' &&
        context.ownerUserId === actorUserId &&
        this.matrix.grants.get('MEMBER')?.get(permissionId)?.has('PERSONAL') === true;
      const system =
        context.ownerType === 'SYSTEM' &&
        ['NODE_MANAGE', 'SKILL_SOURCE_MANAGE', 'LICENSE_READ', 'LICENSE_IMPORT'].includes(
          permissionId
        );
      return personal || system
        ? { allowed: true }
        : { allowed: false, reason: 'ENTERPRISE_LICENSE_REQUIRED' };
    }
    if (actor === undefined) return { allowed: false, reason: 'RBAC_ACTOR_INVALID' };
    const { role, organizationId } = actor;
    const scopes = this.matrix.grants.get(role)?.get(permissionId);
    if (scopes === undefined) return { allowed: false, reason: 'RBAC_DENIED' };
    for (const scope of scopes) {
      if (await this.scopeMatches(scope, actorUserId, organizationId, role, context, connection))
        return { allowed: true };
    }
    return { allowed: false, reason: 'RBAC_SCOPE_DENIED' };
  }

  async actorContext(
    actorUserId: number,
    connection?: AuthorizationConnection
  ): Promise<ActorAuthorizationContext | undefined> {
    const [rows] = await (connection ?? this.database.raw).execute<RowDataPacket[]>(
      `SELECT role,organization_id FROM users WHERE id=? AND enabled=TRUE${connection ? ' FOR SHARE' : ''}`,
      [actorUserId]
    );
    const actor = rows[0];
    if (actor === undefined) return undefined;
    const role = actor['role'];
    const organizationId = Number(actor['organization_id']);
    if (
      (role !== 'ADMIN' && role !== 'ORG_ADMIN' && role !== 'MEMBER') ||
      !Number.isSafeInteger(organizationId) ||
      (role === 'ADMIN' && organizationId !== 1)
    ) {
      return undefined;
    }
    return { role, organizationId };
  }

  /**
   * Community admission remains License-gated even with the unified root ADMIN identity.
   */
  async isPersonalAdmin(actorUserId: number): Promise<boolean> {
    if (!(await this.personalEdition(actorUserId))) return false;
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT is_fixed_admin,role,organization_id FROM users WHERE id=? AND enabled=TRUE',
      [actorUserId]
    );
    const actor = rows[0];
    return (
      Boolean(actor?.['is_fixed_admin']) &&
      actor?.['role'] === 'ADMIN' &&
      Number(actor?.['organization_id']) === 1
    );
  }

  async managedOrganizationIds(actorUserId: number): Promise<readonly number[]> {
    if (await this.personalEdition(actorUserId)) return [];
    const actor = await this.actorContext(actorUserId);
    if (actor === undefined) return [];
    const scopes = this.matrix.grants.get(actor.role)?.get('ORG_MANAGE');
    if (scopes === undefined) return [];
    if (!scopes.has('ORG_SUBTREE')) return [];
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `WITH RECURSIVE subtree AS (
        SELECT id FROM organizations WHERE id=?
        UNION ALL SELECT child.id FROM organizations child
        JOIN subtree parent ON child.parent_organization_id=parent.id
      ) SELECT id FROM subtree`,
      [actor.organizationId]
    );
    return rows.map((row) => Number(row['id']));
  }

  async authorizeManagedUser(
    actorUserId: number,
    targetUserId: number,
    connection?: AuthorizationConnection
  ): Promise<{ readonly allowed: boolean; readonly reason?: string }> {
    const [rows] = await (connection ?? this.database.raw).execute<RowDataPacket[]>(
      `SELECT role,organization_id,is_fixed_admin FROM users WHERE id=?${connection ? ' FOR UPDATE' : ''}`,
      [targetUserId]
    );
    const target = rows[0];
    if (target === undefined) return { allowed: false, reason: 'USER_NOT_FOUND' };
    const actor = await this.actorContext(actorUserId, connection);
    if (actor === undefined) return { allowed: false, reason: 'RBAC_ACTOR_INVALID' };
    const scopes = this.matrix.grants.get(actor.role)?.get('USER_MANAGE');
    if (scopes === undefined) return { allowed: false, reason: 'RBAC_DENIED' };
    if (actor.role !== 'ADMIN' && target['role'] !== 'MEMBER')
      return { allowed: false, reason: 'RBAC_TARGET_ROLE_DENIED' };
    return this.authorize(
      actorUserId,
      'USER_MANAGE',
      {
        ownerType: 'ORGANIZATION',
        organizationId: Number(target['organization_id'])
      },
      connection
    );
  }

  async authorizeRoleAssignment(
    actorUserId: number,
    assignedRole: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER',
    targetOrganizationId: number,
    connection?: AuthorizationConnection
  ): Promise<{ readonly allowed: boolean; readonly reason?: string }> {
    const actor = await this.actorContext(actorUserId, connection);
    if (actor === undefined) return { allowed: false, reason: 'RBAC_ACTOR_INVALID' };
    const scopes = this.matrix.grants.get(actor.role)?.get('ROLE_ASSIGN');
    if (scopes === undefined) return { allowed: false, reason: 'RBAC_DENIED' };
    if (actor.role !== 'ADMIN' && assignedRole === 'ADMIN')
      return { allowed: false, reason: 'RBAC_TARGET_ROLE_DENIED' };
    return this.authorize(
      actorUserId,
      'ROLE_ASSIGN',
      {
        ownerType: 'ORGANIZATION',
        organizationId: targetOrganizationId,
        strictDescendant: assignedRole === 'ORG_ADMIN'
      },
      connection
    );
  }

  async grantScope(actorUserId: number, connection?: AuthorizationConnection) {
    if (await this.personalEdition(actorUserId)) return undefined;
    const actor = await this.actorContext(actorUserId, connection);
    if (actor?.role === 'ADMIN' || actor?.role === 'ORG_ADMIN')
      return { role: actor.role, organizationId: actor.organizationId };
    return undefined;
  }

  private async scopeMatches(
    scope: PermissionScope,
    actorUserId: number,
    actorOrganizationId: number,
    actorRole: ActorAuthorizationContext['role'],
    context: AuthorizationContext,
    connection?: AuthorizationConnection
  ): Promise<boolean> {
    if (scope === 'SYSTEM') return context.ownerType === 'SYSTEM';
    if (scope === 'PERSONAL')
      return context.ownerType === 'PERSONAL' && context.ownerUserId === actorUserId;
    if (scope === 'GRANTED_RESOURCE') return context.granted === true;
    if (context.ownerType !== 'ORGANIZATION') return false;
    if (context.organizationId === undefined) return false;
    if (
      context.strictDescendant &&
      actorRole !== 'ADMIN' &&
      context.organizationId === actorOrganizationId
    )
      return false;
    return this.isOrganizationInSubtree(context.organizationId, actorOrganizationId, connection);
  }

  private async isOrganizationInSubtree(
    organizationId: number,
    ancestorOrganizationId: number,
    connection?: AuthorizationConnection
  ): Promise<boolean> {
    const [rows] = await (connection ?? this.database.raw).execute<RowDataPacket[]>(
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
