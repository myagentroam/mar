import { expect, request as playwrightRequest, test } from '@playwright/test';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { prepareMysqlDatabase } from '../../ee/server/src/mysql/connection.js';
import { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';
import { createEnterpriseTestServer } from './support/enterprise-test-server.js';
import { ResourceManagementDirectory } from '../../ee/server/src/rbac/resource-management-directory.js';
import { createTestMysqlEnvironmentSecretService } from '../support/mysql-environment-secret-service.js';
import { SkillFavoriteService } from '../../ee/server/src/skill/skill-favorite-service.js';
import { McpService } from '../../ee/server/src/mcp/mcp-service.js';
import { ConversationTemplateService } from '../../packages/server-core/src/conversation-template-service.js';
import type { AuthorizationProvider } from '../../ee/server/src/product/product-policy.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from './support/playwright-test-database.js';

test('production composition registers management and Node registration routes with current policy', async () => {
  const server = await createEnterpriseTestServer('management-composition');
  const client = await playwrightRequest.newContext({ baseURL: server.baseURL });
  try {
    const login = await client.post('/api/auth/login', {
      data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(login.status()).toBe(200);
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    const changed = await client.post('/api/auth/change-password', {
      headers: { 'x-csrf-token': csrfToken },
      data: { currentPassword: INITIAL_ADMIN_PASSWORD, password: INITIAL_ADMIN_PASSWORD }
    });
    expect(changed.status()).toBe(200);
    const changedCsrf = ((await changed.json()) as { csrfToken: string }).csrfToken;
    const users = await client.get('/api/management/users');
    expect(users.status()).toBe(200);
    expect((await users.json()).users).toEqual(
      expect.arrayContaining([expect.objectContaining({ username: 'admin' })])
    );
    const token = await client.post('/api/node-registration-tokens', {
      headers: { 'x-csrf-token': changedCsrf },
      data: { displayName: 'Test Node' }
    });
    expect(token.status()).toBe(200);
    expect((await token.json()).token).toEqual(expect.any(String));
    const foreignOwner = await client.post('/api/node-registration-tokens', {
      headers: { 'x-csrf-token': changedCsrf },
      data: {
        displayName: 'Foreign owner',
        ownership: { ownerType: 'PERSONAL', ownerUserId: 2 }
      }
    });
    expect(foreignOwner.status()).toBe(403);
    expect((await foreignOwner.json()).error.code).toBe('PERSONAL_RESOURCE_FORBIDDEN');
  } finally {
    try {
      await client.dispose();
    } finally {
      await server.close();
    }
  }
});

test('Management lists use real SQL authorization, complete reads, global filters and 20/20/5 pages', async () => {
  test.setTimeout(90_000);
  const target = resolvePlaywrightTestDatabase(
    `${process.env['MAR_TEST_RUN_ID']}-management-${randomUUID()}`
  );
  await createPlaywrightTestDatabase(target);
  const pool = mysql.createPool(target.databaseUrl);
  try {
    await prepareMysqlDatabase(pool);
    const database = new MysqlServerDatabase(pool);
    await database.initialize();
    await pool.query(
      "INSERT INTO organizations(id,name,parent_organization_id,created_at,updated_at) VALUES (2,'Visible',1,1,1),(3,'Hidden',1,1,1)"
    );
    await pool.query(
      "INSERT INTO users(id,username,role,organization_id,created_at,updated_at) VALUES (2,'reader','MEMBER',2,1,1),(3,'other','MEMBER',3,1,1)"
    );
    const authorization = {
      managedOrganizationIds: async () => [2],
      authorize: async (_id: number, _permission: string, context?: { ownerType?: string }) => ({
        allowed: context?.ownerType === 'PERSONAL'
      })
    } as unknown as AuthorizationProvider;
    const resources = new ResourceManagementDirectory(database, authorization);
    const secrets = createTestMysqlEnvironmentSecretService(
      database,
      undefined,
      undefined,
      async () => [2]
    );
    const skills = new SkillFavoriteService(
      database,
      authorization,
      {} as never,
      {} as never,
      '/unused-test-cache'
    );
    const mcps = new McpService(database, authorization);
    const templates = new ConversationTemplateService(
      database,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    await pool.query(`INSERT INTO skill_sources
      (id,kind,scope,owner_user_id,name,locator,created_by_user_id,created_at,updated_at,owner_key)
      VALUES ('source','REPOSITORY','PERSONAL',2,'Source','https://example.invalid/source',2,1,1,'PERSONAL:2:')`);
    for (let index = 0; index < 46; index++) {
      const hidden = index === 45;
      const suffix = String(index).padStart(2, '0');
      const userId = hidden ? 3 : 2;
      const organizationId = hidden ? 3 : 2;
      await pool.query(
        `INSERT INTO nodes(id,owner_type,owner_user_id,registered_by_user_id,display_name,registered_address,metadata,created_at,updated_at)
        VALUES (?,'PERSONAL',?,?,?,'127.0.0.1',JSON_OBJECT(),1,1)`,
        [`node-${suffix}`, userId, userId, `Node ${suffix}`]
      );
      await pool.query(
        `INSERT INTO workspaces(workspace_id,display_name,node_id,owner_type,owner_user_id,registered_at)
        VALUES (?,?,?,'PERSONAL',?,1)`,
        [`workspace-${suffix}`, `Workspace ${suffix}`, `node-${suffix}`, userId]
      );
      await pool.query(
        `INSERT INTO environment_secrets(id,name,secret_value,scope,owner_user_id,owner_key,created_at,updated_at)
        VALUES (?,?,'fixture-only','PERSONAL',?,?,1,1)`,
        [`secret-${suffix}`, `KEY_${suffix}`, userId, `PERSONAL:${userId}`]
      );
      await pool.query(
        `INSERT INTO skill_favorites
        (id,source_id,scope,owner_organization_id,repository_url,repository_identity,skill_path,normalized_name,tags,created_by_user_id,created_at,updated_at,owner_key)
        VALUES (?,'source','ORGANIZATION',?,'https://example.invalid/source',?,?,?,JSON_ARRAY(?),2,1,1,?)`,
        [
          `skill-${suffix}`,
          organizationId,
          `repo-${suffix}`,
          `skill-${suffix}`,
          `skill-${suffix}`,
          hidden ? 'hidden' : `tag-${suffix}`,
          `ORGANIZATION:${organizationId}:`
        ]
      );
      await pool.query(
        `INSERT INTO skill_versions(id,favorite_id,commit_sha,content_hash,archive_hash,cache_key,file_count,content_bytes,metadata,tls_verified,cache_state,created_at)
        VALUES (?,?,?, ?,?, ?,1,1,JSON_OBJECT('description','Fixture'),TRUE,'READY',1)`,
        [
          `version-${suffix}`,
          `skill-${suffix}`,
          'a'.repeat(40),
          'a'.repeat(64),
          'a'.repeat(64),
          `cache-${suffix}`
        ]
      );
      await pool.query('UPDATE skill_favorites SET current_version_id=? WHERE id=?', [
        `version-${suffix}`,
        `skill-${suffix}`
      ]);
      await pool.query(
        `INSERT INTO mcp_catalog_entries
        (id,source_id,scope,owner_organization_id,server_name,display_name,description,version,tags,runtime,created_by_user_id,created_at,updated_at)
        VALUES (?,'fixture','ORGANIZATION',?,?,?,'Fixture','1.0',JSON_ARRAY(?),JSON_OBJECT('transport','STDIO','command','node','args',JSON_ARRAY()),2,1,1)`,
        [
          `mcp-${suffix}`,
          organizationId,
          `server-${suffix}`,
          `MCP ${suffix}`,
          hidden ? 'hidden' : `tag-${suffix}`
        ]
      );
      if (!hidden)
        await pool.query(
          `INSERT INTO conversation_templates
        (id,source_node_id,source_workspace_id,name,normalized_name,description,draft_revision,draft_config,created_by_user_id,updated_by_user_id,created_at,updated_at)
        VALUES (?,'node-00','workspace-00',?,?,'Fixture',1,JSON_OBJECT(),2,2,1,1)`,
          [`template-${suffix}`, `Template ${suffix}`, `template ${suffix}`]
        );
    }

    expect((await resources.listManagedResources(2)).nodes).toHaveLength(45);
    expect(await secrets.list({ userId: 2, isAdmin: false })).toHaveLength(45);
    expect(await skills.list(2)).toHaveLength(45);
    expect(await mcps.listCatalog(2)).toHaveLength(45);
    expect(await templates.listAdmin()).toHaveLength(45);
    for (const [page, size] of [
      [1, 20],
      [2, 20],
      [3, 5]
    ] as const) {
      const query = { page: String(page), limit: '20' };
      const nodePage = await resources.listManagedResourcePage(
        2,
        { ...query, resourceType: 'NODE', sortBy: 'label', sortOrder: 'asc' },
        []
      );
      const workspacePage = await resources.listManagedResourcePage(
        2,
        { ...query, resourceType: 'WORKSPACE' },
        []
      );
      const secretPage = await secrets.listPage({ userId: 2, isAdmin: false }, query);
      const skillPage = await skills.listQuery(2, query);
      const mcpPage = await mcps.listQuery(2, query);
      const templatePage = await templates.listAdminQuery(query);
      for (const result of [nodePage, workspacePage, secretPage, skillPage, mcpPage, templatePage])
        expect(result).toMatchObject({ page, pageSize: 20, total: 45, hasMore: page < 3 });
      for (const records of [
        nodePage.nodes,
        workspacePage.workspaces,
        secretPage.secrets,
        skillPage.favorites,
        mcpPage.entries,
        templatePage.templates
      ])
        expect(records).toHaveLength(size);
      expect(skillPage.favorites.every((entry) => !entry.manageable)).toBe(true);
      expect(mcpPage.entries.every((entry) => !entry.manageable)).toBe(true);
      expect(skillPage.facets?.tags).toHaveLength(45);
      expect(mcpPage.facets?.tags).not.toContain('hidden');
    }
    const filtered = await skills.listQuery(2, { page: '1', keyword: 'skill-44' });
    expect(filtered).toMatchObject({ total: 1, page: 1 });
    expect(filtered.favorites.map((entry) => entry.id)).toEqual(['skill-44']);
    expect(filtered.facets?.tags).toHaveLength(45);
    expect(
      (await mcps.listQuery(2, { ids: JSON.stringify(['mcp-44', 'mcp-45']) })).entries.map(
        (entry) => entry.id
      )
    ).toEqual(['mcp-44']);
    expect((await secrets.listPage({ userId: 2, isAdmin: false }, { page: '99' })).page).toBe(3);
    expect(
      (
        await resources.listManagedResourcePage(
          2,
          { page: '1', resourceType: 'NODE', keyword: 'Node 44' },
          []
        )
      ).nodes.map((entry) => entry.id)
    ).toEqual(['node-44']);
  } finally {
    await pool.end();
    await dropPlaywrightTestDatabase(target);
  }
});
