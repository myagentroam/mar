import { describe, expect, it, vi } from 'vitest';
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
