import { describe, expect, it, vi } from 'vitest';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { AuthorizationService } from '../../ee/server/src/rbac/authorization-service.js';
import { SkillSourceService } from '../../ee/server/src/skill/skill-source-service.js';

describe('Server Skill source domain', () => {
  it('Users can manage personal sources but cannot create unauthorized organization sources', async () => {
    const fixture = sourceFixture();
    const service = new SkillSourceService(fixture.database, fixture.authorization, () => 2_000);
    await expect(
      service.create(7, {
        kind: 'REPOSITORY',
        scope: 'PERSONAL',
        name: '我的源',
        locator: 'https://github.com/acme/skills'
      })
    ).resolves.toMatchObject({ scope: 'PERSONAL', ownerUserId: 7 });
    fixture.authorization.authorize = vi.fn(async () => ({ allowed: false }));
    await expect(
      service.create(7, {
        kind: 'REPOSITORY',
        scope: 'ORGANIZATION',
        organizationId: 3,
        name: '越权源',
        locator: 'https://github.com/acme/skills'
      })
    ).rejects.toThrow('SKILL_SOURCE_FORBIDDEN');
  });

  it('The default skills.sh source cannot be deleted', async () => {
    const fixture = sourceFixture();
    fixture.source = { built_in: true, scope: 'ENTERPRISE' };
    await expect(
      new SkillSourceService(fixture.database, fixture.authorization).remove(1, 'skills-sh')
    ).rejects.toThrow('SKILL_SOURCE_BUILT_IN');
    expect(fixture.connection.rollback).toHaveBeenCalledOnce();
  });

  it('Community fixed admin can toggle the built-in source, but cannot delete it', async () => {
    const fixture = communitySourceFixture({ built_in: true, scope: 'ENTERPRISE' });
    const service = new SkillSourceService(fixture.database, fixture.authorization, () => 2_000);

    await expect(service.list(1)).resolves.toMatchObject([{ id: 'skills-sh', manageable: true }]);
    await service.setEnabled(1, 'skills-sh', false);
    await service.setEnabled(1, 'skills-sh', true);
    expect(
      fixture.connection.execute.mock.calls
        .filter(([sql]) => sql.includes('UPDATE skill_sources'))
        .map(([, values]) => values)
    ).toEqual([
      [false, 'DISABLED', 2_000, 'skills-sh'],
      [true, 'READY', 2_000, 'skills-sh']
    ]);
    await expect(service.remove(1, 'skills-sh')).rejects.toThrow('SKILL_SOURCE_BUILT_IN');
  });

  it('Community fixed admin cannot manage a non-built-in enterprise source', async () => {
    const fixture = communitySourceFixture({ built_in: false, scope: 'ENTERPRISE' });
    const service = new SkillSourceService(fixture.database, fixture.authorization);

    await expect(service.list(1)).resolves.toMatchObject([{ manageable: false }]);
    await expect(service.setEnabled(1, 'skills-sh', false)).rejects.toThrow(
      'SKILL_SOURCE_FORBIDDEN'
    );
    expect(fixture.connection.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE skill_sources'),
      expect.anything()
    );
  });

  it('Non-fixed Community admins, other users, and organization admins cannot manage the built-in source', async () => {
    const fixture = communitySourceFixture({ built_in: true, scope: 'ENTERPRISE' });
    const service = new SkillSourceService(fixture.database, fixture.authorization);

    for (const actorUserId of [2, 3, 4]) {
      await expect(service.list(actorUserId)).resolves.toMatchObject([{ manageable: false }]);
      await expect(service.setEnabled(actorUserId, 'skills-sh', false)).rejects.toThrow(
        'SKILL_SOURCE_FORBIDDEN'
      );
    }
    expect(fixture.connection.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE skill_sources'),
      expect.anything()
    );
  });

  it('Visible sources include enterprise, ancestor organization, and owned personal sources', async () => {
    const fixture = sourceFixture();
    await new SkillSourceService(fixture.database, fixture.authorization).list(7);
    const call = fixture.database.raw.execute as ReturnType<typeof vi.fn>;
    expect(call.mock.calls.at(-1)?.[0]).toContain("scope='ENTERPRISE'");
    expect(call.mock.calls.at(-1)?.[0]).toContain('owner_user_id=?');
    expect(call.mock.calls.at(-1)?.[0]).toContain('ancestors AS');
  });

  it('Each scope stores at most twenty sources', async () => {
    const fixture = sourceFixture();
    fixture.sourceCount = 20;
    await expect(
      new SkillSourceService(fixture.database, fixture.authorization).create(7, {
        kind: 'REPOSITORY',
        scope: 'PERSONAL',
        name: '超额源',
        locator: 'https://github.com/acme/skills'
      })
    ).rejects.toThrow('SKILL_SOURCE_LIMIT_EXCEEDED');
    expect(fixture.connection.beginTransaction).not.toHaveBeenCalled();
  });

  it('Rechecks capacity under the owner lock and rolls back when the last slot was taken', async () => {
    const fixture = sourceFixture();
    fixture.transactionCount = 20;
    await expect(
      new SkillSourceService(fixture.database, fixture.authorization).create(7, {
        kind: 'REPOSITORY',
        scope: 'PERSONAL',
        name: 'Last slot',
        locator: 'https://github.com/acme/skills'
      })
    ).rejects.toThrow('SKILL_SOURCE_LIMIT_EXCEEDED');
    expect(fixture.connection.execute.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining('FOR UPDATE'),
      expect.stringContaining('COUNT(*)')
    ]);
    expect(fixture.connection.rollback).toHaveBeenCalledOnce();
    expect(fixture.connection.commit).not.toHaveBeenCalled();
    expect(fixture.connection.release).toHaveBeenCalledOnce();
  });

  it('Locks the organization owner before its actor reference and final count', async () => {
    const fixture = sourceFixture();
    await new SkillSourceService(fixture.database, fixture.authorization).create(7, {
      kind: 'REPOSITORY',
      scope: 'ORGANIZATION',
      organizationId: 3,
      name: 'Organization source',
      locator: 'https://github.com/acme/skills'
    });
    expect(fixture.connection.execute.mock.calls.slice(0, 3)).toEqual([
      [expect.stringMatching(/FROM organizations.*FOR UPDATE/u), [3]],
      [expect.stringMatching(/FROM users.*FOR SHARE/u), [7]],
      [expect.stringContaining('COUNT(*)'), ['ORGANIZATION:3:']]
    ]);
  });
});

function sourceFixture() {
  const fixture: {
    source: Record<string, unknown>;
    sourceCount: number;
    transactionCount: number;
  } = {
    source: { built_in: false, scope: 'PERSONAL', owner_user_id: 7 },
    sourceCount: 0,
    transactionCount: 0
  };
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
    execute: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('COUNT(*)')) return [[{ total: fixture.transactionCount }], []];
      if (sql.includes('SELECT id FROM users')) return [[{ id: values[0] }], []];
      if (sql.includes('SELECT id FROM organizations')) return [[{ id: values[0] }], []];
      if (sql.includes('built_in,scope,owner_organization_id,owner_user_id'))
        return [[fixture.source], []];
      return [{ affectedRows: 1 }, []];
    })
  };
  const raw = {
    getConnection: vi.fn(async () => connection),
    execute: vi.fn(async (sql: string) =>
      sql.includes('COUNT(*)') ? [[{ total: fixture.sourceCount }], []] : [[], []]
    )
  };
  const database = { raw } as unknown as MysqlServerDatabase;
  const authorization = {
    authorize: vi.fn(async () => ({ allowed: true }))
  } as unknown as AuthorizationService;
  return Object.assign(fixture, { database, authorization, connection });
}

function communitySourceFixture(sourceOverrides: Record<string, unknown>) {
  const actors = new Map([
    [1, { role: 'ADMIN', organization_id: 1, is_fixed_admin: true }],
    [2, { role: 'MEMBER', organization_id: 1, is_fixed_admin: false }],
    [3, { role: 'ORG_ADMIN', organization_id: 2, is_fixed_admin: false }],
    [4, { role: 'ADMIN', organization_id: 1, is_fixed_admin: false }]
  ]);
  const source = {
    id: 'skills-sh',
    kind: 'SKILLS_SH',
    scope: 'ENTERPRISE',
    owner_organization_id: null,
    owner_user_id: null,
    name: 'skills.sh',
    locator: 'https://skills.sh',
    enabled: true,
    built_in: true,
    status: 'READY',
    last_error_code: null,
    created_at: 1,
    updated_at: 1,
    ...sourceOverrides
  };
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
    execute: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('FROM skill_sources'))
        return [values[0] === source['id'] ? [source] : [], []];
      return [{ affectedRows: 1 }, []];
    })
  };
  const raw = {
    getConnection: vi.fn(async () => connection),
    execute: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('FROM skill_sources')) return [[source], []];
      if (sql.includes('is_fixed_admin')) {
        const actor = actors.get(Number(values[0]));
        return [actor === undefined ? [] : [actor], []];
      }
      if (sql.includes('FROM users')) {
        const actor = actors.get(Number(values[0]));
        return [actor === undefined ? [] : [actor], []];
      }
      return [[], []];
    })
  };
  const database = { raw } as unknown as MysqlServerDatabase;
  const authorization = new AuthorizationService(database, undefined, async () => true);
  return { database, authorization, connection };
}
