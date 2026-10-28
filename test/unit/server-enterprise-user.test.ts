import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { describe, expect, it, vi } from 'vitest';
import { hashOpaque } from '../../packages/server-core/src/session-token.js';
import { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import type { AuthorizationService } from '../../ee/server/src/rbac/authorization-service.js';
import { EnterpriseUserService } from '../../ee/server/src/rbac/enterprise-user-service.js';
import { registerEnterpriseUserRoutes } from '../../ee/server/src/route/enterprise-user-routes.js';

describe('Server enterprise user membership', () => {
  it('moves ADMIN to root and runs unified grant cleanup before commit', async () => {
    const fixture = enterpriseUserFixture();
    const service = new EnterpriseUserService(fixture.database, fixture.authorization, () => 2_000);
    await expect(service.assign(1, 9, 'ADMIN', 7)).resolves.toMatchObject({
      id: 9,
      role: 'ADMIN',
      organizationId: 1
    });
    const update = fixture.calls.find((call) => call.sql.includes('UPDATE users SET role'));
    expect(update?.values).toEqual(['ADMIN', 1, 2_000, 9]);
    expect(
      fixture.calls.some((call) =>
        call.sql.includes('DELETE grant_record FROM resource_grants grant_record')
      )
    ).toBe(true);
    expect(fixture.commit).toHaveBeenCalledOnce();
  });

  it('rolls back protected or unauthorized membership changes before persistence', async () => {
    const fixture = enterpriseUserFixture();
    fixture.authorization.authorizeManagedUser = vi.fn(async () => ({
      allowed: false,
      reason: 'ADMIN_USER_PROTECTED'
    }));
    const service = new EnterpriseUserService(fixture.database, fixture.authorization);
    await expect(service.assign(2, 1, 'MEMBER', 2)).rejects.toThrow('ADMIN_USER_PROTECTED');
    expect(fixture.connection.beginTransaction).not.toHaveBeenCalled();
  });

  it('updates profile and membership in one service transaction', async () => {
    const fixture = enterpriseUserFixture();
    const service = new EnterpriseUserService(fixture.database, fixture.authorization, () => 3_000);
    await expect(
      service.update(1, 9, {
        email: 'member@example.com',
        nickname: '成员甲',
        role: 'ORG_ADMIN',
        organizationId: 2
      })
    ).resolves.toMatchObject({ id: 9 });
    expect(
      fixture.calls.some((call) => call.sql.includes('role=?,organization_id=?,email=?,nickname=?'))
    ).toBe(true);
  });

  it('updates the fixed admin profile without writing its recovery identity', async () => {
    const fixture = enterpriseUserFixture(true);
    const service = new EnterpriseUserService(fixture.database, fixture.authorization, () => 3_000);
    await expect(
      service.update(1, 1, {
        email: 'admin@example.com',
        nickname: 'Recovery admin',
        role: 'ADMIN',
        organizationId: 1
      })
    ).resolves.toMatchObject({
      id: 1,
      email: 'admin@example.com',
      nickname: 'Recovery admin',
      role: 'ADMIN',
      organizationId: 1,
      fixedAdmin: true
    });
    const updates = fixture.calls.filter((call) => call.sql.startsWith('UPDATE users'));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.sql).toContain('SET email=?,nickname=?,updated_at=?');
    expect(updates[0]?.values).toEqual(['admin@example.com', 'Recovery admin', 3_000, 1]);
    expect(fixture.commit).toHaveBeenCalledOnce();
  });

  it.each([
    { role: 'MEMBER' as const, organizationId: 1 },
    { role: 'ORG_ADMIN' as const, organizationId: 2 },
    { role: 'ADMIN' as const, organizationId: 2 }
  ])('rejects fixed admin identity changes: $role / $organizationId', async (membership) => {
    const fixture = enterpriseUserFixture(true);
    const service = new EnterpriseUserService(fixture.database, fixture.authorization);
    await expect(
      service.update(1, 1, { email: 'changed@example.com', nickname: 'Changed', ...membership })
    ).rejects.toThrow('ADMIN_USER_PROTECTED');
    expect(fixture.calls.some((call) => call.sql.startsWith('UPDATE users'))).toBe(false);
    expect(fixture.connection.rollback).toHaveBeenCalledOnce();
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it('keeps membership-only assignment of the fixed admin protected', async () => {
    const fixture = enterpriseUserFixture(true);
    const service = new EnterpriseUserService(fixture.database, fixture.authorization);
    await expect(service.assign(1, 1, 'ADMIN', 1)).rejects.toThrow('ADMIN_USER_PROTECTED');
    expect(fixture.calls.some((call) => call.sql.startsWith('UPDATE users'))).toBe(false);
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'preserves fixed admin connections but revokes ordinary membership changes: fixedAdmin=$0',
    async (fixedAdmin) => {
      const fixture = enterpriseUserFixture(fixedAdmin);
      const sessions = {
        findCurrentUserSession: () => ({
          userId: 1,
          username: 'admin',
          isAdmin: true,
          sessionHash: 'session-hash',
          mustChangePassword: false,
          csrfTokenHash: hashOpaque('csrf-token')
        })
      };
      const closeUserSessions = vi.fn();
      const app = Fastify();
      registerEnterpriseUserRoutes({
        app,
        database: sessions,
        users: new EnterpriseUserService(fixture.database, fixture.authorization),
        nodeControl: { closeUserSessions },
        publicOrigin: undefined
      });
      try {
        const userId = fixedAdmin ? 1 : 9;
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/enterprise/users/${userId}`,
          headers: { cookie: 'mar_user_session=session-id', 'x-csrf-token': 'csrf-token' },
          payload: {
            email: 'updated@example.com',
            nickname: 'Updated',
            role: fixedAdmin ? 'ADMIN' : 'ORG_ADMIN',
            organizationId: fixedAdmin ? 1 : 2
          }
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().user).toMatchObject({ id: userId, fixedAdmin });
        if (fixedAdmin) expect(closeUserSessions).not.toHaveBeenCalled();
        else expect(closeUserSessions).toHaveBeenCalledExactlyOnceWith(userId);
      } finally {
        await app.close();
      }
    }
  );

  it('keeps the no-page read complete and scoped, and pages filtered rows in one transaction', async () => {
    const fixture = enterpriseUserListFixture();
    const service = new EnterpriseUserService(fixture.database, fixture.authorization);

    const full = await service.list(7);
    expect(full.users).toHaveLength(45);
    expect(full).not.toHaveProperty('page');
    expect(fixture.fullQuery).toHaveBeenCalledOnce();
    expect(fixture.fullQuery.mock.calls[0]?.[0]).toContain('WHERE organization_id IN (?)');
    expect(fixture.fullQuery.mock.calls[0]?.[1]).toEqual([[2, 3]]);

    const filteredFull = await service.list(7, { keyword: 'member-03' });
    expect(filteredFull.users).toHaveLength(45);
    expect(filteredFull).not.toHaveProperty('page');
    expect(fixture.fullQuery.mock.calls[1]?.[0]).toContain("username LIKE ? ESCAPE '!'");
    expect(fixture.fullQuery.mock.calls[1]?.[0]).not.toContain('LIMIT');

    const page = await service.list(7, {
      page: '3',
      limit: '20',
      role: 'MEMBER',
      organizationId: '3',
      status: 'disabled',
      keyword: 'ann%_!',
      sortBy: 'username',
      sortOrder: 'desc'
    });
    expect(page).toMatchObject({ page: 3, pageSize: 20, total: 45, hasMore: false });
    expect(page.users).toHaveLength(5);
    expect(fixture.connection.beginTransaction).toHaveBeenCalledOnce();
    expect(fixture.connection.commit).toHaveBeenCalledOnce();
    expect(fixture.connection.query).toHaveBeenCalledTimes(3);
    const [countSql, countParams] = fixture.connection.query.mock.calls[1]!;
    const [rowsSql, rowsParams] = fixture.connection.query.mock.calls[2]!;
    expect(countSql).toContain('organization_id IN (?)');
    expect(countSql).toContain('organization_id=?');
    expect(countSql).toContain('enabled=?');
    expect(countSql).toContain("LIKE ? ESCAPE '!'");
    expect(rowsSql).toContain('ORDER BY username DESC, id ASC LIMIT 20 OFFSET 40');
    expect(rowsParams).toEqual(countParams);
    expect(rowsParams).toEqual([
      [2, 3],
      'MEMBER',
      3,
      false,
      '%ann!%!_!!%',
      '%ann!%!_!!%',
      '%ann!%!_!!%'
    ]);
  });

  it('rejects invalid user-list filters rather than returning an unfiltered list', async () => {
    const fixture = enterpriseUserListFixture();
    const service = new EnterpriseUserService(fixture.database, fixture.authorization);
    await expect(service.list(7, { page: '', keyword: 'must-not-fallback' })).rejects.toMatchObject(
      { code: 'MANAGEMENT_QUERY_INVALID' }
    );
    await expect(service.list(7, { role: 'ROOT' })).rejects.toMatchObject({
      code: 'MANAGEMENT_QUERY_INVALID'
    });
    expect(fixture.fullQuery).not.toHaveBeenCalled();
    expect(fixture.connection.query).not.toHaveBeenCalled();
  });

  it('keeps the management-user envelope full by default and uses scoped SQL pagination on request', async () => {
    const fixture = mysqlUserListFixture();
    const database = fixture.database;

    const full = await database.listUsers();
    expect(full).toHaveLength(45);
    expect(fixture.pool.query).toHaveBeenCalledOnce();
    expect(fixture.pool.query.mock.calls[0]?.[0]).not.toContain('LIMIT');

    const page = await database.listUsers({
      page: '2',
      limit: '20',
      role: 'MEMBER',
      organizationId: '2',
      status: 'enabled',
      keyword: 'ann',
      sortBy: 'username',
      sortOrder: 'desc'
    });
    expect(page).toMatchObject({ page: 2, pageSize: 20, total: 45, hasMore: true });
    if (!('users' in page)) throw new Error('Expected paginated user results');
    expect(page.users).toHaveLength(20);
    expect(fixture.connection.query).toHaveBeenCalledTimes(3);
    const [countSql, countParams] = fixture.connection.query.mock.calls[1]!;
    const [rowsSql, rowsParams] = fixture.connection.query.mock.calls[2]!;
    expect(countSql).toContain('role=?');
    expect(countSql).toContain('organization_id=?');
    expect(countSql).toContain('enabled=?');
    expect(countSql).toContain("LIKE ? ESCAPE '!'");
    expect(rowsSql).toContain('ORDER BY username DESC, id ASC LIMIT 20 OFFSET 20');
    expect(rowsParams).toEqual(countParams);
    expect(rowsParams).toEqual(['MEMBER', 2, true, '%ann%', '%ann%', '%ann%']);
  });
});

function enterpriseUserFixture(fixedAdmin = false) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const commit = vi.fn(async () => undefined);
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    commit,
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
    execute: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push(values === undefined ? { sql } : { sql, values });
      if (sql.startsWith('SELECT username,role,organization_id')) return [[userRow], []];
      if (sql.startsWith('UPDATE users SET email=')) {
        if (fixedAdmin) {
          userRow.email = values?.[0] as string | null;
          userRow.nickname = values?.[1] as string | null;
        }
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith('UPDATE users') && fixedAdmin) return [{ affectedRows: 0 }, []];
      if (sql.includes('SELECT id FROM organizations')) return [[{ id: 1 }], []];
      if (sql.startsWith('SELECT id FROM organizations WHERE id=? FOR UPDATE'))
        return [[{ id: values?.[0] }], []];
      return [{ affectedRows: 1 }, []];
    }),
    query: vi.fn(async () => [{ affectedRows: 1 }, []])
  };
  const userRow = {
    id: fixedAdmin ? 1 : 9,
    username: fixedAdmin ? 'admin' : 'member',
    email: null as string | null,
    nickname: null as string | null,
    role: 'ADMIN',
    organization_id: 1,
    is_fixed_admin: fixedAdmin,
    enabled: true,
    created_at: 1_000
  };
  const database = {
    raw: {
      getConnection: vi.fn(async () => connection),
      execute: vi.fn(async () => [[userRow], []])
    }
  } as unknown as MysqlServerDatabase;
  const authorization = {
    authorizeManagedUser: vi.fn(async () => ({ allowed: true })),
    authorizeRoleAssignment: vi.fn(async () => ({ allowed: true }))
  } as unknown as AuthorizationService;
  return { database, authorization, connection, calls, commit };
}

function enterpriseUserListFixture() {
  const rows = Array.from({ length: 45 }, (_, index) => ({
    id: index + 1,
    username: `member-${String(index + 1).padStart(2, '0')}`,
    email: null,
    nickname: null,
    role: 'MEMBER',
    organization_id: index % 2 === 0 ? 2 : 3,
    is_fixed_admin: false,
    enabled: index % 2 === 0,
    created_at: index + 1_000
  }));
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push(values === undefined ? { sql } : { sql, values });
      if (sql.startsWith('SELECT COUNT(*)')) return [[{ total: 45 }], []];
      const offset = Number(/OFFSET (\d+)$/u.exec(sql)?.[1] ?? 0);
      return [rows.slice(offset, offset + 20), []];
    })
  };
  const fullQuery = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    calls.push(values === undefined ? { sql } : { sql, values });
    return [rows, []];
  });
  const database = {
    raw: {
      getConnection: vi.fn(async () => connection),
      query: fullQuery
    }
  } as unknown as MysqlServerDatabase;
  const authorization = {
    managedOrganizationIds: vi.fn(async () => [2, 3])
  } as unknown as AuthorizationService;
  return { database, authorization, connection, fullQuery, calls };
}

function mysqlUserListFixture() {
  const rows = Array.from({ length: 45 }, (_, index) => ({
    id: index + 1,
    username: `user-${String(index + 1).padStart(2, '0')}`,
    email: null,
    nickname: null,
    role: 'MEMBER',
    organization_id: 2,
    is_fixed_admin: false,
    enabled: true,
    created_at: index + 1_000
  }));
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
    query: vi.fn(async (sql: string, _params: readonly unknown[]) => {
      if (sql.startsWith('SELECT COUNT(*)')) return [[{ total: 45 }], []];
      const offset = Number(/OFFSET (\d+)$/u.exec(sql)?.[1] ?? 0);
      return [rows.slice(offset, offset + 20), []];
    })
  };
  const pool = {
    getConnection: vi.fn(async () => connection),
    query: vi.fn(async (_sql: string) => [rows, []])
  };
  const database = Object.assign(
    Object.create(MysqlServerDatabase.prototype) as MysqlServerDatabase,
    {
      raw: pool
    }
  );
  return { database, pool, connection };
}
