import { describe, expect, it, vi } from 'vitest';
import { AuthorizationService } from '../../ee/server/src/rbac/authorization-service.js';
import { McpService } from '../../ee/server/src/mcp/mcp-service.js';

describe('Server MCP Registry discovery', () => {
  it('Startup ensures only the official Registry source without an undeletable built-in Playwright entry', async () => {
    const execute = vi.fn(async (sql: string) => {
      void sql;
      return [[], []];
    });
    const service = new McpService(
      { raw: { execute } } as never,
      { authorize: vi.fn() } as never,
      undefined,
      () => 1
    );

    await service.ensureOfficialSource();

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toContain('INSERT INTO mcp_sources');
  });

  it('Community fixed admin can toggle the built-in Registry but cannot delete it', async () => {
    const fixture = communityMcpFixture({ built_in: true, scope: 'ENTERPRISE' });
    const service = new McpService(fixture.database, fixture.authorization, undefined, () => 2_000);

    await expect(service.listSources(1)).resolves.toMatchObject([
      { id: 'official', builtIn: true, manageable: true }
    ]);
    await service.setSourceEnabled(1, 'official', false);
    await service.setSourceEnabled(1, 'official', true);
    expect(
      fixture.execute.mock.calls
        .filter(([sql]) => sql.startsWith('UPDATE mcp_sources'))
        .map(([, values]) => values)
    ).toEqual([
      [false, 'DISABLED', 2_000, 'official'],
      [true, 'READY', 2_000, 'official']
    ]);
    await expect(service.removeSource(1, 'official')).rejects.toThrow('MCP_SOURCE_BUILT_IN');
    expect(
      fixture.execute.mock.calls.some(([sql]) => sql.startsWith('DELETE FROM mcp_sources'))
    ).toBe(false);
  });

  it('Community fixed admin cannot manage ordinary enterprise sources or MCP catalog entries', async () => {
    const fixture = communityMcpFixture({ built_in: false, scope: 'ENTERPRISE' });
    const service = new McpService(fixture.database, fixture.authorization);

    await expect(service.listSources(1)).resolves.toMatchObject([{ manageable: false }]);
    await expect(service.setSourceEnabled(1, 'official', false)).rejects.toThrow(
      'MCP_SOURCE_FORBIDDEN'
    );
    await expect(service.listCatalog(1)).resolves.toMatchObject([{ manageable: false }]);
    await expect(service.removeCatalog(1, 'catalog-entry')).rejects.toThrow('MCP_SOURCE_FORBIDDEN');
    expect(fixture.execute.mock.calls.some(([sql]) => sql.startsWith('UPDATE mcp_sources'))).toBe(
      false
    );
    expect(
      fixture.execute.mock.calls.some(([sql]) => sql.startsWith('DELETE FROM mcp_catalog_entries'))
    ).toBe(false);
  });

  it('Non-fixed Community admins, other users, and organization admins cannot manage the built-in Registry', async () => {
    const fixture = communityMcpFixture({ built_in: true, scope: 'ENTERPRISE' });
    const service = new McpService(fixture.database, fixture.authorization);

    for (const actorUserId of [2, 3, 4]) {
      await expect(service.listSources(actorUserId)).resolves.toMatchObject([
        { manageable: false }
      ]);
      await expect(service.setSourceEnabled(actorUserId, 'official', false)).rejects.toThrow(
        'MCP_SOURCE_FORBIDDEN'
      );
    }
    expect(fixture.execute.mock.calls.some(([sql]) => sql.startsWith('UPDATE mcp_sources'))).toBe(
      false
    );
  });

  it('Accepts JSON catalog fields already parsed by the MySQL driver', async () => {
    const query = vi.fn(async () => [
      [
        {
          id: 'playwright',
          source_id: 'official',
          scope: 'ENTERPRISE',
          owner_organization_id: null,
          owner_user_id: null,
          server_name: 'io.github.microsoft/playwright-mcp',
          display_name: 'Playwright',
          description: 'Browser automation',
          version: '0.0.78',
          featured: 1,
          tags: ['浏览器', '测试', '推荐'],
          runtime: {
            transport: 'STDIO',
            command: 'npx',
            args: ['-y', '@playwright/mcp@0.0.78']
          },
          created_at: 1,
          updated_at: 1
        }
      ],
      []
    ]);
    const database = {
      raw: {
        execute: query,
        query
      }
    };
    const authorization = { authorize: vi.fn(async () => ({ allowed: true })) };
    const service = new McpService(database as never, authorization as never);

    await expect(service.listCatalog(1)).resolves.toEqual([
      expect.objectContaining({
        tags: ['浏览器', '测试', '推荐'],
        runtime: expect.objectContaining({ command: 'npx' })
      })
    ]);
  });

  it('Converts pinned official Playwright versions into isolated headless runtime descriptions', async () => {
    let catalogInserted = false;
    const database = {
      raw: {
        execute: vi.fn(async (sql: string) => {
          if (sql.includes('FROM mcp_sources'))
            return [
              [
                {
                  id: 'official',
                  scope: 'ENTERPRISE',
                  owner_organization_id: null,
                  owner_user_id: null,
                  name: '官方',
                  locator: 'https://registry.example.com',
                  enabled: 1,
                  built_in: 1,
                  status: 'READY',
                  last_error_code: null,
                  created_at: 1,
                  updated_at: 1
                }
              ],
              []
            ];
          if (sql.includes('SELECT id FROM mcp_catalog_entries'))
            return [catalogInserted ? [{ id: 'existing' }] : [], []];
          if (sql.includes('INSERT INTO mcp_catalog_entries')) catalogInserted = true;
          return [[], []];
        })
      }
    };
    const authorization = { authorize: vi.fn(async () => ({ allowed: true })) };
    const fetchImpl = vi.fn(async () =>
      Response.json({
        servers: [
          {
            server: {
              name: 'io.github.microsoft/playwright-mcp',
              title: 'Playwright',
              description: 'Browser automation',
              version: '0.0.78',
              packages: [
                {
                  registryType: 'npm',
                  identifier: '@playwright/mcp',
                  version: '0.0.78',
                  environmentVariables: [
                    { name: 'REQUIRED_TOKEN', isRequired: true },
                    { name: 'OPTIONAL_TOKEN', isRequired: false }
                  ]
                }
              ]
            }
          }
        ]
      })
    );
    const service = new McpService(database as never, authorization as never, fetchImpl as never);

    const discovered = await service.discover(1, 'official', 'playwright');
    expect(discovered).toEqual([
      expect.objectContaining({
        serverName: 'io.github.microsoft/playwright-mcp',
        version: '0.0.78',
        runtime: {
          transport: 'STDIO',
          command: 'npx',
          args: ['-y', '@playwright/mcp@0.0.78', '--headless', '--isolated'],
          environment: { REQUIRED_TOKEN: { secretName: 'REQUIRED_TOKEN' } }
        }
      })
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://registry.example.com/v0.1/servers?version=latest&search=playwright',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    await expect(
      service.addCatalog(1, {
        sourceId: 'official',
        candidate: { ...discovered[0], runtime: { transport: 'STDIO', command: 'malware' } },
        scope: 'ORGANIZATION',
        organizationId: 1,
        featured: true,
        tags: ['浏览器']
      })
    ).resolves.toEqual(
      expect.objectContaining({
        runtime: expect.objectContaining({
          command: 'npx',
          args: expect.arrayContaining(['@playwright/mcp@0.0.78'])
        })
      })
    );
    await expect(
      service.addCatalog(1, {
        sourceId: 'official',
        candidate: discovered[0],
        scope: 'ORGANIZATION',
        organizationId: 1,
        featured: true,
        tags: ['浏览器']
      })
    ).rejects.toThrow('MCP_CATALOG_ALREADY_EXISTS');
  });

  it('Imported MCP entries support update checks, pinned upgrades, and display metadata edits', async () => {
    const updates: { sql: string; values: unknown }[] = [];
    const catalogRow = {
      id: 'catalog-1',
      source_id: 'official',
      scope: 'PERSONAL',
      owner_organization_id: null,
      owner_user_id: 1,
      server_name: 'example/server',
      display_name: 'Example',
      description: 'old',
      version: '1.0.0',
      featured: 0,
      tags: [],
      runtime: { transport: 'HTTP', url: 'https://old.example.com/mcp' },
      created_at: 1,
      updated_at: 1
    };
    const query = vi.fn(async (sql: string, values?: unknown) => {
      if (sql.includes('SELECT * FROM mcp_catalog_entries')) return [[catalogRow], []];
      if (sql.includes('SELECT entry.* FROM mcp_catalog_entries')) return [[catalogRow], []];
      if (sql.includes('FROM mcp_sources'))
        return [
          [
            {
              id: 'official',
              scope: 'ENTERPRISE',
              owner_organization_id: null,
              owner_user_id: null,
              name: '官方',
              locator: 'https://registry.example.com',
              enabled: 1,
              built_in: 1,
              status: 'READY',
              last_error_code: null,
              created_at: 1,
              updated_at: 1
            }
          ],
          []
        ];
      if (sql.startsWith('UPDATE mcp_catalog_entries')) updates.push({ sql, values });
      return [[], []];
    });
    const database = {
      raw: {
        execute: query,
        query
      }
    };
    const authorization = { authorize: vi.fn(async () => ({ allowed: true })) };
    const fetchImpl = vi.fn(async () =>
      Response.json({
        servers: [
          {
            server: {
              name: 'example/server',
              title: 'Example 2',
              description: 'new',
              version: '2.0.0',
              remotes: [{ transportType: 'streamable-http', url: 'https://new.example.com/mcp' }]
            }
          }
        ]
      })
    );
    const service = new McpService(
      database as never,
      authorization as never,
      fetchImpl as never,
      () => 9
    );

    await expect(service.checkCatalogUpdate(1, 'catalog-1')).resolves.toEqual({
      updateAvailable: true,
      latestVersion: '2.0.0'
    });
    await expect(service.upgradeCatalog(1, 'catalog-1')).resolves.toEqual(
      expect.objectContaining({ id: 'catalog-1', version: '2.0.0', updatedAt: 9 })
    );
    await service.updateCatalogPresentation(1, 'catalog-1', {
      featured: true,
      tags: ['浏览器']
    });

    expect(updates).toHaveLength(2);
    expect(updates[0]?.values).toEqual(
      expect.arrayContaining(['Example 2', 'new', '2.0.0', 9, 'catalog-1'])
    );
    expect(updates[1]?.values).toEqual([true, JSON.stringify(['浏览器']), 9, 'catalog-1']);
  });
});

function communityMcpFixture(sourceOverrides: Record<string, unknown>) {
  const actors = new Map([
    [1, { role: 'ADMIN', organization_id: 1, is_fixed_admin: true }],
    [2, { role: 'MEMBER', organization_id: 1, is_fixed_admin: false }],
    [3, { role: 'ORG_ADMIN', organization_id: 2, is_fixed_admin: false }],
    [4, { role: 'ADMIN', organization_id: 1, is_fixed_admin: false }]
  ]);
  const source = {
    id: 'official',
    scope: 'ENTERPRISE',
    owner_organization_id: null,
    owner_user_id: null,
    name: 'Official MCP Registry',
    locator: 'https://registry.example.com',
    enabled: true,
    built_in: true,
    status: 'READY',
    last_error_code: null,
    created_at: 1,
    updated_at: 1,
    ...sourceOverrides
  };
  const catalogEntry = {
    id: 'catalog-entry',
    source_id: 'official',
    scope: 'ENTERPRISE',
    owner_organization_id: null,
    owner_user_id: null,
    server_name: 'example/server',
    display_name: 'Example',
    description: '',
    version: '1.0.0',
    featured: false,
    tags: [],
    runtime: { transport: 'HTTP', url: 'https://example.com/mcp' },
    created_at: 1,
    updated_at: 1
  };
  const execute = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (sql.includes('FROM mcp_catalog_entries')) return [[catalogEntry], []];
    if (sql.includes('FROM mcp_sources')) return [[source], []];
    if (sql.includes('is_fixed_admin')) {
      const actor = actors.get(Number(values[0]));
      return [actor === undefined ? [] : [actor], []];
    }
    if (sql.includes('FROM users')) {
      const actor = actors.get(Number(values[0]));
      return [actor === undefined ? [] : [actor], []];
    }
    return [[], []];
  });
  const database = { raw: { execute, query: execute } } as never;
  const authorization = new AuthorizationService(database, undefined, async () => true);
  return { database, authorization, execute };
}
