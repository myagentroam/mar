import {
  emitAuditAfterCommit,
  emitAudit,
  commitMysqlAudits,
  discardMysqlAudits
} from '@myagentroam/server-core/audit';
import {
  ManagementQueryError,
  managementOrder,
  managementPageQuery,
  managementSearchPattern,
  managementText,
  readManagementPage
} from '@myagentroam/server-core/management-pagination';

import { lockOrganizationReference } from './organization-reference.js';
import { revokeOutOfScopeResourceGrants } from './resource-grant-scope.js';
import { withOrganizationReference } from './organization-reference.js';
import { randomBytes } from 'node:crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { hashPassword } from '@myagentroam/server-core/password';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { AuthorizationProvider } from '../product/product-policy.js';

type EnterpriseRole = 'ADMIN' | 'ORG_ADMIN' | 'MEMBER';

export class EnterpriseUserService {
  constructor(
    private readonly database: MysqlServerDatabase,
    private readonly authorization: AuthorizationProvider,
    private readonly now: () => number = Date.now
  ) {}

  async list(
    actorUserId: number,
    query: Record<string, unknown> = {}
  ): Promise<{
    readonly users: readonly object[];
    readonly page?: number;
    readonly pageSize?: number;
    readonly total?: number;
    readonly hasMore?: boolean;
  }> {
    const pageQuery = managementPageQuery(query);
    const organizationIds = await this.authorization.managedOrganizationIds(actorUserId);
    if (organizationIds.length === 0) throw new Error('RBAC_DENIED');

    const conditions = ['organization_id IN (?)'];
    const params: unknown[] = [organizationIds];
    const role = managementText(query, 'role');
    if (role !== undefined && role !== '') {
      if (role !== 'ADMIN' && role !== 'ORG_ADMIN' && role !== 'MEMBER')
        throw new ManagementQueryError();
      conditions.push('role=?');
      params.push(role);
    }
    const organizationId = managementText(query, 'organizationId');
    if (organizationId !== undefined && organizationId !== '') {
      if (!/^[1-9]\d*$/u.test(organizationId) || !Number.isSafeInteger(Number(organizationId)))
        throw new ManagementQueryError();
      conditions.push('organization_id=?');
      params.push(Number(organizationId));
    }
    const status = managementText(query, 'status');
    if (status !== undefined && status !== '') {
      if (status !== 'enabled' && status !== 'disabled') throw new ManagementQueryError();
      conditions.push('enabled=?');
      params.push(status === 'enabled');
    }
    const keyword = managementText(query, 'keyword');
    if (keyword !== undefined && keyword !== '') {
      const pattern = managementSearchPattern(keyword);
      conditions.push(
        "(username LIKE ? ESCAPE '!' OR email LIKE ? ESCAPE '!' OR nickname LIKE ? ESCAPE '!')"
      );
      params.push(pattern, pattern, pattern);
    }
    const order = managementOrder(
      query,
      {
        username: 'username',
        email: 'email',
        nickname: 'nickname',
        role: 'role',
        organizationId: 'organization_id',
        enabled: 'enabled',
        createdAt: 'created_at'
      },
      'id ASC'
    );
    const where = `WHERE ${conditions.join(' AND ')}`;
    const stableOrder = order === 'id ASC' ? order : `${order}, id ASC`;
    const columns =
      'SELECT id,username,email,nickname,role,organization_id,is_fixed_admin,enabled,created_at';

    if (pageQuery !== undefined) {
      const page = await readManagementPage(this.database.raw, pageQuery, {
        countSql: `SELECT COUNT(*) AS total FROM users ${where}`,
        rowsSql: `${columns} FROM users ${where} ORDER BY ${stableOrder}`,
        params
      });
      return {
        users: page.rows.map(publicEnterpriseUser),
        page: page.page,
        pageSize: page.pageSize,
        total: page.total,
        hasMore: page.hasMore
      };
    }

    const [rows] = await this.database.raw.query<RowDataPacket[]>(
      `${columns} FROM users ${where} ORDER BY ${stableOrder}`,
      params
    );
    return { users: rows.map(publicEnterpriseUser) };
  }

  async create(
    actorUserId: number,
    input: {
      readonly username: string;
      readonly email: string | null;
      readonly nickname: string | null;
      readonly role: EnterpriseRole;
      readonly organizationId: number;
    }
  ): Promise<{ readonly user: object; readonly temporaryPassword: string }> {
    const organizationId = input.role === 'ADMIN' ? 1 : input.organizationId;
    await requireAllowed(
      this.authorization.authorizeRoleAssignment(actorUserId, input.role, organizationId)
    );
    const temporaryPassword = randomBytes(18).toString('base64url');
    const timestamp = this.now();
    const result = await withOrganizationReference(
      this.database.raw,
      organizationId,
      async (connection) => {
        const [result] = await connection.execute<ResultSetHeader>(
          `INSERT INTO users
       (username,email,nickname,password_hash,must_change_password,enabled,role,organization_id,
        is_fixed_admin,created_at,updated_at)
       SELECT ?,?,?,?,TRUE,TRUE,?,?,FALSE,?,? FROM organizations WHERE id=?`,
          [
            input.username,
            input.email,
            input.nickname,
            hashPassword(temporaryPassword),
            input.role,
            organizationId,
            timestamp,
            timestamp,
            organizationId
          ]
        );
        return result;
      }
    );
    if (result.affectedRows !== 1) throw new Error('ORGANIZATION_NOT_FOUND');
    emitAudit(this.database, {
      eventType: 'user.created',
      actorUserId,
      organizationId,
      targetType: 'USER',
      targetId: String(result.insertId),
      targetName: input.username,
      metadata: JSON.stringify({ after: { role: input.role, organizationId } })
    });
    return { user: await this.get(result.insertId), temporaryPassword };
  }

  async assign(
    actorUserId: number,
    targetUserId: number,
    role: EnterpriseRole,
    requestedOrganizationId: number,
    profile?: { readonly email: string | null; readonly nickname: string | null }
  ): Promise<ReturnType<typeof publicEnterpriseUser>> {
    await requireAllowed(this.authorization.authorizeManagedUser(actorUserId, targetUserId));
    const organizationId = role === 'ADMIN' ? 1 : requestedOrganizationId;
    await requireAllowed(
      this.authorization.authorizeRoleAssignment(actorUserId, role, organizationId)
    );
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      await lockOrganizationReference(connection, 1, true);
      await requireAllowed(
        this.authorization.authorizeManagedUser(actorUserId, targetUserId, connection)
      );
      await requireAllowed(
        this.authorization.authorizeRoleAssignment(actorUserId, role, organizationId, connection)
      );
      const [organizationRows] = await connection.execute<RowDataPacket[]>(
        'SELECT id FROM organizations WHERE id=? FOR UPDATE',
        [organizationId]
      );
      if (organizationRows.length !== 1) throw new Error('ORGANIZATION_NOT_FOUND');
      const [before] = await connection.execute<RowDataPacket[]>(
        'SELECT username,role,organization_id,is_fixed_admin FROM users WHERE id=? FOR UPDATE',
        [targetUserId]
      );
      const fixedAdmin = Boolean(before[0]?.['is_fixed_admin']);
      if (
        fixedAdmin &&
        (profile === undefined || role !== 'ADMIN' || requestedOrganizationId !== 1)
      )
        throw new Error('ADMIN_USER_PROTECTED');
      const [result] = await connection.execute<ResultSetHeader>(
        fixedAdmin
          ? `UPDATE users SET email=?,nickname=?,updated_at=? WHERE id=? AND is_fixed_admin=TRUE`
          : profile === undefined
            ? `UPDATE users SET role=?,organization_id=?,updated_at=?
             WHERE id=? AND is_fixed_admin=FALSE`
            : `UPDATE users SET role=?,organization_id=?,email=?,nickname=?,updated_at=?
             WHERE id=? AND is_fixed_admin=FALSE`,
        fixedAdmin && profile !== undefined
          ? [profile.email, profile.nickname, this.now(), targetUserId]
          : profile === undefined
            ? [role, organizationId, this.now(), targetUserId]
            : [role, organizationId, profile.email, profile.nickname, this.now(), targetUserId]
      );
      if (result.affectedRows !== 1) throw new Error('USER_NOT_FOUND_OR_PROTECTED');
      await revokeOutOfScopeResourceGrants(connection);
      emitAuditAfterCommit(this.database, connection, {
        eventType: 'user.updated',
        actorUserId,
        organizationId,
        targetType: 'USER',
        targetId: String(targetUserId),
        targetName: String(before[0]?.['username'] ?? targetUserId),
        metadata: JSON.stringify({
          before: { role: before[0]?.['role'], organizationId: before[0]?.['organization_id'] },
          after: { role, organizationId }
        })
      });
      await connection.commit();
      commitMysqlAudits(connection);
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return this.get(targetUserId);
  }

  async update(
    actorUserId: number,
    targetUserId: number,
    input: {
      readonly email: string | null;
      readonly nickname: string | null;
      readonly role: EnterpriseRole;
      readonly organizationId: number;
    }
  ): Promise<ReturnType<typeof publicEnterpriseUser>> {
    return this.assign(actorUserId, targetUserId, input.role, input.organizationId, {
      email: input.email,
      nickname: input.nickname
    });
  }

  private async get(userId: number): Promise<ReturnType<typeof publicEnterpriseUser>> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT id,username,email,nickname,role,organization_id,is_fixed_admin,enabled,created_at
       FROM users WHERE id=?`,
      [userId]
    );
    if (rows[0] === undefined) throw new Error('USER_NOT_FOUND');
    return publicEnterpriseUser(rows[0]);
  }
}

async function requireAllowed(
  resultPromise: Promise<{ readonly allowed: boolean; readonly reason?: string }>
): Promise<void> {
  const result = await resultPromise;
  if (!result.allowed) throw new Error(result.reason ?? 'RBAC_DENIED');
}

function publicEnterpriseUser(row: RowDataPacket) {
  return {
    id: Number(row['id']),
    username: String(row['username']),
    email: row['email'] === null ? null : String(row['email']),
    nickname: row['nickname'] === null ? null : String(row['nickname']),
    role: row['role'],
    organizationId: Number(row['organization_id']),
    fixedAdmin: Boolean(row['is_fixed_admin']),
    enabled: Boolean(row['enabled']),
    createdAt: Number(row['created_at'])
  };
}
