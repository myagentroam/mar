import { describe, expect, it, vi } from 'vitest';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { AuthorizationService } from '../../ee/server/src/rbac/authorization-service.js';
import { loadPermissionMatrix } from '../../ee/server/src/rbac/permission-matrix.js';

describe('Server RBAC permission matrix', () => {
  it('admits only declared self-owned personal operations before activation', async () => {
    let personal = true;
    const execute = vi.fn(async () => [
      [
        {
          role: 'ADMIN',
          organization_id: 1,
          is_fixed_admin: true
        }
      ],
      []
    ]);
    const database = { raw: { execute } } as unknown as MysqlServerDatabase;
    const service = new AuthorizationService(
      database,
      loadPermissionMatrix(),
      async () => personal
    );
    for (const permission of [
      'SKILL_SOURCE_MANAGE',
      'SKILL_FAVORITE_MANAGE',
      'RESOURCE_MANAGE',
      'RESOURCE_USE'
    ]) {
      await expect(
        service.authorize(1, permission, {
          ownerType: 'PERSONAL',
          ownerUserId: 1
        })
      ).resolves.toEqual({ allowed: true });
    }
    for (const context of [
      {},
      { granted: true },
      {
        ownerType: 'PERSONAL' as const,
        ownerUserId: 2
      },
      { ownerType: 'ORGANIZATION' as const, organizationId: 1 }
    ]) {
      await expect(service.authorize(1, 'SKILL_SOURCE_MANAGE', context)).resolves.toMatchObject({
        allowed: false
      });
    }
    await expect(
      service.authorize(1, 'USER_MANAGE', {
        ownerType: 'PERSONAL',
        ownerUserId: 1
      })
    ).resolves.toMatchObject({ allowed: false });
    personal = false;
    await expect(
      service.authorize(1, 'SKILL_SOURCE_MANAGE', {
        ownerType: 'PERSONAL',
        ownerUserId: 1
      })
    ).resolves.toMatchObject({ allowed: true });
    personal = true;
    execute.mockResolvedValueOnce([[], []]);
    execute.mockResolvedValueOnce([[], []]);
    await expect(
      service.authorize(1, 'RESOURCE_USE', {
        ownerType: 'PERSONAL',
        ownerUserId: 1
      })
    ).resolves.toMatchObject({ allowed: false });
  });

  it('loads the single versioned matrix and rejects malformed extensions', () => {
    const matrix = loadPermissionMatrix();
    expect(matrix.version).toBe(2);
    expect(matrix.grants.get('ADMIN')?.has('LICENSE_IMPORT')).toBe(true);
    expect(matrix.grants.get('ADMIN')?.get('RESOURCE_MANAGE')).toEqual(
      new Set(['ORG_SUBTREE', 'PERSONAL'])
    );
    expect(matrix.grants.get('ADMIN')?.get('SKILL_SOURCE_MANAGE')).toEqual(
      new Set(['SYSTEM', 'ORG_SUBTREE', 'PERSONAL'])
    );
    expect(matrix.grants.get('ORG_ADMIN')?.get('SKILL_FAVORITE_MANAGE')).toEqual(
      new Set(['ORG_SUBTREE', 'PERSONAL'])
    );
    expect(matrix.grants.get('MEMBER')?.get('SKILL_SOURCE_MANAGE')).toEqual(new Set(['PERSONAL']));
    expect(() =>
      loadPermissionMatrix({
        matrixVersion: 2,
        roles: ['ADMIN', 'ORG_ADMIN', 'MEMBER'],
        permissions: ['RESOURCE_USE'],
        grants: [
          {
            role: 'ADMIN',
            permissions: [{ permissionId: 'UNKNOWN_PERMISSION', scopes: ['SYSTEM'] }]
          },
          {
            role: 'ORG_ADMIN',
            permissions: [{ permissionId: 'RESOURCE_USE', scopes: ['ORG_SUBTREE'] }]
          },
          {
            role: 'MEMBER',
            permissions: [{ permissionId: 'RESOURCE_USE', scopes: ['PERSONAL'] }]
          }
        ]
      })
    ).toThrow('RBAC_PERMISSION_UNKNOWN');
  });

  it('applies subtree, personal and granted scopes without crossing personal owners', async () => {
    const fixture = authorizationFixture();
    const service = new AuthorizationService(fixture.database);
    fixture.actor = { role: 'ADMIN', organization_id: 1 };
    fixture.ancestors = [{ id: 1 }];
    await expect(
      service.authorize(1, 'RESOURCE_USE', { ownerType: 'ORGANIZATION', organizationId: 9 })
    ).resolves.toEqual({ allowed: true });
    await expect(
      service.authorize(1, 'RESOURCE_USE', { ownerType: 'PERSONAL', ownerUserId: 2 })
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      service.authorize(1, 'RESOURCE_MANAGE', { ownerType: 'PERSONAL', ownerUserId: 2 })
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      service.authorize(1, 'SKILL_SOURCE_MANAGE', { ownerType: 'PERSONAL', ownerUserId: 2 })
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      service.authorize(1, 'SKILL_FAVORITE_MANAGE', { ownerType: 'PERSONAL', ownerUserId: 1 })
    ).resolves.toEqual({ allowed: true });
    fixture.actor = { role: 'ORG_ADMIN', organization_id: 2 };
    fixture.ancestors = [{ id: 2 }];
    await expect(
      service.authorize(2, 'ORG_MANAGE', { ownerType: 'ORGANIZATION', organizationId: 4 })
    ).resolves.toEqual({ allowed: true });
    fixture.ancestors = [];
    await expect(
      service.authorize(2, 'ORG_MANAGE', { ownerType: 'ORGANIZATION', organizationId: 5 })
    ).resolves.toMatchObject({ allowed: false });
    fixture.actor = { role: 'MEMBER', organization_id: 4 };
    await expect(
      service.authorize(3, 'SELF_MANAGE', { ownerType: 'ORGANIZATION', organizationId: 4 })
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      service.authorize(3, 'RESOURCE_USE', { ownerType: 'PERSONAL', ownerUserId: 3 })
    ).resolves.toEqual({ allowed: true });
    await expect(service.authorize(3, 'RESOURCE_USE', { granted: true })).resolves.toEqual({
      allowed: true
    });
  });

  it('keeps root organization admins equivalent for resources but separates explicit system objects', async () => {
    const fixture = authorizationFixture();
    const service = new AuthorizationService(fixture.database);
    fixture.ancestors = [{ id: 1 }];
    for (const role of ['ADMIN', 'ORG_ADMIN']) {
      fixture.actor = { role, organization_id: 1 };
      await expect(
        service.authorize(1, 'RESOURCE_MANAGE', { ownerType: 'ORGANIZATION', organizationId: 7 })
      ).resolves.toEqual({ allowed: true });
      await expect(
        service.authorize(1, 'RESOURCE_MANAGE', { ownerType: 'PERSONAL', ownerUserId: 2 })
      ).resolves.toMatchObject({ allowed: false });
      for (const context of [{}, { ownerType: 'ORGANIZATION' as const, organizationId: 1 }]) {
        await expect(service.authorize(1, 'LICENSE_IMPORT', context)).resolves.toMatchObject({
          allowed: false
        });
      }
      await expect(
        service.authorize(1, 'LICENSE_IMPORT', { ownerType: 'SYSTEM' })
      ).resolves.toEqual(
        role === 'ADMIN' ? { allowed: true } : { allowed: false, reason: 'RBAC_DENIED' }
      );
    }
    expect(loadPermissionMatrix().permissions.has('RESOURCE_GRANT_ENTERPRISE')).toBe(false);
  });

  it('fails closed for unknown permissions and invalid ADMIN organization binding', async () => {
    const fixture = authorizationFixture();
    const service = new AuthorizationService(fixture.database);
    fixture.actor = { role: 'ADMIN', organization_id: 2 };
    await expect(service.authorize(1, 'LICENSE_IMPORT')).resolves.toMatchObject({ allowed: false });
    await expect(service.authorize(1, 'DOES_NOT_EXIST')).resolves.toEqual({
      allowed: false,
      reason: 'RBAC_PERMISSION_UNKNOWN'
    });
  });

  it('centralizes member and role-assignment boundaries for organization admins', async () => {
    const fixture = authorizationFixture();
    const service = new AuthorizationService(fixture.database);
    fixture.actor = { role: 'ORG_ADMIN', organization_id: 2 };
    fixture.target = { role: 'MEMBER', organization_id: 4, is_fixed_admin: false };
    fixture.ancestors = [{ id: 2 }];
    await expect(service.authorizeManagedUser(2, 9)).resolves.toEqual({ allowed: true });
    await expect(service.authorizeRoleAssignment(2, 'ORG_ADMIN', 2)).resolves.toMatchObject({
      allowed: false
    });
    await expect(service.authorizeRoleAssignment(2, 'ORG_ADMIN', 4)).resolves.toEqual({
      allowed: true
    });
    fixture.target = { role: 'ORG_ADMIN', organization_id: 4, is_fixed_admin: false };
    await expect(service.authorizeManagedUser(2, 9)).resolves.toMatchObject({ allowed: false });
    fixture.actor = { role: 'ADMIN', organization_id: 1 };
    fixture.ancestors = [{ id: 1 }];
    await expect(service.authorizeRoleAssignment(1, 'ADMIN', 1)).resolves.toEqual({
      allowed: true
    });
  });

  it('authorizes fixed admin management only for enterprise system administrators', async () => {
    const fixture = authorizationFixture();
    fixture.target = { role: 'ADMIN', organization_id: 1, is_fixed_admin: true };
    fixture.ancestors = [{ id: 1 }];
    const service = new AuthorizationService(fixture.database);
    for (const role of ['MEMBER', 'ORG_ADMIN']) {
      fixture.actor = { role, organization_id: 1 };
      await expect(service.authorizeManagedUser(2, 1)).resolves.toMatchObject({ allowed: false });
    }
    fixture.actor = { role: 'ADMIN', organization_id: 1 };
    await expect(service.authorizeManagedUser(2, 1)).resolves.toEqual({ allowed: true });
    const community = new AuthorizationService(fixture.database, undefined, async () => true);
    await expect(community.authorizeManagedUser(1, 1)).resolves.toMatchObject({ allowed: false });
  });
});

function authorizationFixture() {
  const fixture: {
    actor: { role: string; organization_id: number };
    target: { role: string; organization_id: number; is_fixed_admin: boolean };
    ancestors: { id: number }[];
    database: MysqlServerDatabase;
  } = {
    actor: { role: 'MEMBER', organization_id: 1 },
    target: { role: 'MEMBER', organization_id: 1, is_fixed_admin: false },
    ancestors: [],
    database: undefined as unknown as MysqlServerDatabase
  };
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes('WITH RECURSIVE')) return [fixture.ancestors, []];
    if (sql.includes('is_fixed_admin')) return [[fixture.target], []];
    return [[fixture.actor], []];
  });
  fixture.database = { raw: { execute } } as unknown as MysqlServerDatabase;
  return fixture;
}
