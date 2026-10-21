import { describe, expect, it, vi } from 'vitest';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import type { AuthorizationService } from '../../ee/server/src/rbac/authorization-service.js';
import { OrganizationService } from '../../ee/server/src/rbac/organization-service.js';

describe('Server organization domain', () => {
  it('preserves the former registration-token foreign-key restriction', async () => {
    const fixture = organizationFixture();
    fixture.tokenReferenced = true;
    await expect(
      new OrganizationService(fixture.database, fixture.authorization).remove(1, 3)
    ).rejects.toThrow('ORGANIZATION_NOT_EMPTY');
    expect(fixture.sql.some((sql) => sql.startsWith('DELETE FROM organizations'))).toBe(false);
    expect(fixture.rollback).toHaveBeenCalledOnce();
  });
  it('locks owned resources before cleanup and protects Skill sources used outside the organization', async () => {
    const fixture = organizationFixture();
    fixture.externalFavorite = true;
    await expect(
      new OrganizationService(fixture.database, fixture.authorization).remove(1, 3)
    ).rejects.toThrow('SKILL_SOURCE_IN_USE');
    expect(
      fixture.sql.some(
        (sql) => sql.startsWith('SELECT id FROM skill_sources') && sql.endsWith('FOR UPDATE')
      )
    ).toBe(true);
    expect(fixture.sql.some((sql) => sql.startsWith('DELETE FROM'))).toBe(false);
    expect(fixture.rollback).toHaveBeenCalledOnce();
  });

  it('protects root organization and rejects a move that creates a cycle', async () => {
    const fixture = organizationFixture();
    const service = new OrganizationService(fixture.database, fixture.authorization, () => 2_000);
    await expect(service.move(1, 1, 2)).rejects.toThrow('ROOT_ORGANIZATION_PROTECTED');
    fixture.cycle = true;
    await expect(service.move(1, 2, 3)).rejects.toThrow('ORGANIZATION_CYCLE');
    expect(fixture.rollback).toHaveBeenCalledOnce();
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it('refuses non-empty deletion and transfers organization resources to the direct parent', async () => {
    const blocked = organizationFixture();
    blocked.organization = {
      parent_organization_id: 2,
      child_count: 1,
      member_count: 0,
      provider_count: 0
    };
    await expect(
      new OrganizationService(blocked.database, blocked.authorization).remove(1, 3)
    ).rejects.toThrow('ORGANIZATION_NOT_EMPTY');
    expect(blocked.rollback).toHaveBeenCalledOnce();

    const allowed = organizationFixture();
    await new OrganizationService(allowed.database, allowed.authorization, () => 2_000).remove(
      1,
      3
    );
    expect(allowed.sql.some((sql) => sql.startsWith('UPDATE nodes'))).toBe(true);
    expect(allowed.sql.some((sql) => sql.startsWith('UPDATE workspaces'))).toBe(true);
    for (const table of [
      'resource_grants',
      'user_mar_agent_model_orders',
      'user_mar_agent_image_model_orders',
      'mar_agent_models',
      'mar_agent_image_models',
      'environment_secrets',
      'skill_versions',
      'skill_favorites',
      'skill_sources',
      'mcp_catalog_entries',
      'mcp_sources'
    ]) {
      expect(
        allowed.sql.findIndex((sql) => sql.startsWith(`DELETE FROM ${table}`))
      ).toBeGreaterThan(-1);
      expect(allowed.sql.findIndex((sql) => sql.startsWith(`DELETE FROM ${table}`))).toBeLessThan(
        allowed.sql.findIndex((sql) => sql.startsWith('DELETE FROM organizations'))
      );
    }
    expect(allowed.sql.some((sql) => sql.startsWith('DELETE FROM organizations'))).toBe(true);
    expect(allowed.commit).toHaveBeenCalledOnce();
  });
});

function organizationFixture() {
  const fixture: {
    cycle: boolean;
    tokenReferenced: boolean;
    externalFavorite: boolean;
    organization: Record<string, number>;
  } = {
    cycle: false,
    tokenReferenced: false,
    externalFavorite: false,
    organization: {
      parent_organization_id: 2,
      child_count: 0,
      member_count: 0,
      provider_count: 0
    }
  };
  const sql: string[] = [];
  const commit = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    commit,
    rollback,
    release: vi.fn(),
    execute: vi.fn(async (statement: string, values?: readonly unknown[]) => {
      sql.push(statement.trim());
      if (statement.startsWith('SELECT id FROM organizations WHERE id=? FOR UPDATE'))
        return [values?.[0] === 1 || values?.[0] === 3 ? [{ id: values[0] }] : [], []];
      if (statement.includes('SELECT token_hash FROM node_registration_tokens'))
        return [fixture.tokenReferenced ? [{ token_hash: 'fixture-token-hash' }] : [], []];
      if (statement.includes('SELECT favorite.id FROM skill_favorites'))
        return [fixture.externalFavorite ? [{ id: 'external-favorite' }] : [], []];
      if (statement.includes('WITH RECURSIVE subtree'))
        return [fixture.cycle ? [{ id: 3 }] : [], []];
      if (statement.includes('child_count')) return [[fixture.organization], []];
      return [{ affectedRows: 1 }, []];
    })
  };
  const database = {
    raw: { getConnection: vi.fn(async () => connection) }
  } as unknown as MysqlServerDatabase;
  const authorization = {
    authorize: vi.fn(async () => ({ allowed: true }))
  } as unknown as AuthorizationService;
  return Object.assign(fixture, { database, authorization, sql, commit, rollback });
}
