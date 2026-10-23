import { expect, test } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

test('Skill settings show the available internal catalog and remove Skill Center from management', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route('**/api/resources', (route) => json(route, { nodes: [], workspaces: [] }));
  const favorites: Record<string, unknown>[] = [
    {
      id: 'favorite-1',
      sourceId: 'skills-sh',
      scope: 'PERSONAL',
      normalizedName: 'code-review',
      featured: true,
      tags: ['代码质量'],
      description: 'Review changes before merge',
      repositoryIdentity: 'github.com/acme/skills',
      skillPath: 'skills/code-review',
      currentVersionId: 'version-1',
      commitSha: 'a'.repeat(40),
      tlsVerified: true,
      updatedAt: 1_700_000_000_000,
      manageable: true
    },
    {
      id: 'favorite-2',
      sourceId: 'skills-sh',
      scope: 'ENTERPRISE',
      normalizedName: 'database-query',
      featured: false,
      tags: ['数据库'],
      description: 'Query development databases safely',
      repositoryIdentity: 'github.com/acme/database-skills',
      skillPath: 'skills/database-query',
      currentVersionId: 'version-2',
      commitSha: 'b'.repeat(40),
      tlsVerified: true,
      updatedAt: 1_700_000_000_000,
      manageable: false
    }
  ];
  await page.route('**/api/skill-sources', (route) =>
    json(route, {
      sources: [
        {
          id: 'skills-sh',
          name: 'skills.sh',
          scope: 'ENTERPRISE',
          kind: 'SKILLS_SH',
          locator: 'skills.sh',
          enabled: true,
          builtIn: true,
          manageable: true
        }
      ]
    })
  );
  await page.route('**/api/skill-sources/skills-sh/skills?*', (route) =>
    json(route, {
      skills: [
        {
          id: 'acme/skills/code-review',
          name: 'code-review',
          description: 'Review changes before merge',
          source: 'acme/skills',
          skillPath: 'skills/code-review',
          installs: 42
        }
      ]
    })
  );
  await page.route('**/api/skill-favorites', (route) => json(route, { favorites }));
  await page.route('**/api/mcp-catalog', (route) =>
    json(route, {
      entries: [
        {
          id: 'mcp-playwright',
          sourceId: 'official',
          scope: 'ENTERPRISE',
          serverName: 'playwright',
          displayName: 'Playwright MCP',
          description: 'Browser automation tools',
          version: '1.0.0',
          featured: true,
          tags: ['浏览器'],
          runtime: { transport: 'STDIO' }
        }
      ]
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await expect(page.locator('.activity-rail .nav-menu-button .rail-label')).toHaveText([
    '工作',
    '对话',
    '管理',
    '设置',
    '帮助'
  ]);
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await expect(page).toHaveURL(/view=management/);
  await page.keyboard.press('Tab');
  const focusedNavigationButton = page.locator('.activity-rail nav button:focus-visible');
  await expect(focusedNavigationButton).toHaveCount(1);
  await expect(focusedNavigationButton).toHaveCSS('outline-offset', '-2px');
  const managementMenu = page.getByRole('navigation', { name: '管理菜单' });
  await expect(managementMenu.getByRole('button', { name: '技能中心' })).toHaveCount(0);
  const managementLabels = await managementMenu.getByRole('button').allTextContents();
  const skillConfigurationIndex = managementLabels.indexOf('技能配置');
  expect(skillConfigurationIndex).toBeGreaterThanOrEqual(0);
  expect(managementLabels.slice(skillConfigurationIndex, skillConfigurationIndex + 4)).toEqual([
    '技能配置',
    '技能源管理',
    'MCP 源管理',
    '环境密钥管理'
  ]);
  const skillConfigurationButton = managementMenu.getByRole('button', { name: '技能配置' });
  await skillConfigurationButton.click();
  await expect(page).toHaveURL(/management=skill-config/);
  await expect(skillConfigurationButton).toHaveAttribute('aria-current', 'page');
  expect(
    await skillConfigurationButton.evaluate((element) => {
      const button = element.getBoundingClientRect();
      const menu = element.parentElement?.getBoundingClientRect();
      return (
        menu !== undefined &&
        button.left > menu.left &&
        button.right < menu.right &&
        button.width >= menu.width - 24
      );
    })
  ).toBe(true);
  await expect(page.locator('.workbench-header .breadcrumb strong')).toHaveText('技能配置');
  await expect(page.locator('.skill-content')).toHaveCSS('overflow-y', 'auto');
  await expect(page.getByRole('textbox', { name: '搜索技能' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '可配置技能' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.getByRole('tab', { name: '当前目标中的技能' })).toBeVisible();
  const favorite = page
    .locator('.available-skill-table .el-table__row')
    .filter({ hasText: 'code-review' });
  await expect(page.locator('.available-skill-table')).toContainText('说明');
  await expect(favorite).not.toContainText('aaaaaaaaaaaa');
  await expect(page.getByRole('button', { name: '全部', exact: true })).toBeVisible();
  await expect(favorite.getByRole('button', { name: '详情', exact: true })).toHaveCount(0);
  await expect(favorite.getByRole('button', { name: '安装' }).locator('.el-icon')).toBeVisible();
  await expect(favorite.getByRole('button', { name: '安装' })).toBeDisabled();
  await page.getByRole('button', { name: '代码质量', exact: true }).click();
  await expect(
    page.locator('.available-skill-table .el-table__row').filter({ hasText: 'database-query' })
  ).toHaveCount(0);
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await favorite.click();
  const details = page.getByRole('dialog', { name: 'code-review' });
  await expect(details).toContainText('Review changes before merge');
  await expect(details).toContainText('aaaaaaaa');
  await details.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByText(/Commit|收藏版本|运行时事实来源/)).toHaveCount(0);

  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  const mcpRow = page
    .locator('.mcp-config-table .el-table__row')
    .filter({ hasText: 'Playwright MCP' });
  await expect(page.locator('.mcp-config-table')).toContainText('说明');
  await expect(mcpRow).toContainText('Browser automation tools');
  await expect(page.locator('.mcp-card-grid, .mcp-card')).toHaveCount(0);
  await expect(mcpRow.getByRole('button', { name: '详情', exact: true })).toHaveCount(0);
  await mcpRow.click();
  const mcpDetails = page.getByRole('dialog', { name: 'Playwright MCP' });
  await expect(mcpDetails).toContainText('Browser automation tools');
  await mcpDetails.getByRole('button', { name: '关闭', exact: true }).click();
});

test('Mobile skill settings use page-level vertical scrolling', async ({ page }) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/resources', (route) => json(route, { nodes: [], workspaces: [] }));
  await page.route('**/api/skill-sources', (route) => json(route, { sources: [] }));
  await page.route('**/api/skill-favorites', (route) =>
    json(route, {
      favorites: Array.from({ length: 14 }, (_, index) => ({
        id: `favorite-${index}`,
        sourceId: 'skills-sh',
        scope: 'PERSONAL',
        normalizedName: `mobile-skill-${index}`,
        featured: index === 0,
        tags: ['移动端'],
        description: `Mobile scrolling skill ${index}`,
        repositoryIdentity: 'github.com/acme/mobile-skills',
        skillPath: `skills/mobile-${index}`,
        currentVersionId: `version-${index}`,
        commitSha: String(index).padStart(40, '0'),
        tlsVerified: true,
        updatedAt: 1_700_000_000_000 + index,
        manageable: true
      }))
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page
    .getByRole('navigation', { name: '管理菜单' })
    .getByRole('button', { name: '技能配置' })
    .click();

  const skillPage = page.locator('.skill-page');
  const expectPageScroll = async (): Promise<void> => {
    await expect(skillPage).toHaveCSS('overflow-y', 'auto');
    const scroll = await skillPage.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop
      };
    });
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    expect(scroll.scrollTop).toBeGreaterThan(0);
  };

  await expect(page.locator('.workbench-header .breadcrumb strong')).toHaveText('技能配置');
  await expectPageScroll();
});

test('Skill installation runs asynchronously in the current Workspace and refreshes the catalog', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route('**/api/nodes', (route) =>
    json(route, {
      nodes: [
        {
          id: 'node-1',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.1.8',
          nodeVersion: 'v24',
          connected: true,
          disabled: false,
          capabilities: {}
        }
      ]
    })
  );
  await page.route('**/api/resources', (route) =>
    json(route, {
      nodes: [
        {
          id: 'node-1',
          displayName: 'node-1',
          connected: true,
          disabled: false,
          ownership: { ownerType: 'PERSONAL', ownerUserId: 1 },
          ownerUsername: 'admin'
        }
      ],
      workspaces: [
        {
          nodeId: 'node-1',
          nodeDisplayName: 'node-1',
          workspaceId: 'workspace-1',
          displayName: 'project',
          ownership: { ownerType: 'PERSONAL', ownerUserId: 1 },
          ownerUsername: 'admin'
        }
      ]
    })
  );
  await page.route('**/api/nodes/node-1/skills', (route) =>
    json(route, { targetKind: 'NODE', compatibilityMode: 'SYMLINK', skills: [] })
  );
  const favorite = {
    id: 'favorite-1',
    sourceId: 'skills-sh',
    scope: 'PERSONAL',
    normalizedName: 'code-review',
    featured: false,
    tags: [],
    description: 'Review changes before merge',
    repositoryIdentity: 'github.com/acme/skills',
    skillPath: 'skills/code-review',
    currentVersionId: 'version-1',
    commitSha: 'a'.repeat(40),
    tlsVerified: true,
    updatedAt: 1_700_000_000_000,
    manageable: true
  };
  await page.route('**/api/skill-sources', (route) => json(route, { sources: [] }));
  await page.route('**/api/skill-favorites', (route) => json(route, { favorites: [favorite] }));
  let repairCalls = 0;
  await page.route(
    '**/api/workspaces/workspace-1/skills/git-exclude-repair?nodeId=node-1',
    (route) => {
      repairCalls += 1;
      return route.fulfill({ status: 204 });
    }
  );
  let installed = false;
  let installAttempts = 0;
  await page.route('**/api/workspaces/workspace-1/skills?nodeId=node-1', (route) => {
    if (route.request().method() === 'POST') {
      installAttempts += 1;
      return json(route, { installJobId: `job-${installAttempts}` }, 202);
    }
    return json(route, {
      targetKind: 'WORKSPACE',
      compatibilityMode: 'MANAGED_COPY',
      skills: installed
        ? [
            {
              name: 'code-review',
              description: favorite.description,
              localStatus: 'VALID',
              install: {
                favoriteId: favorite.id,
                versionId: favorite.currentVersionId,
                commitSha: favorite.commitSha
              }
            }
          ]
        : []
    });
  });
  await page.route('**/api/skill-install-jobs/job-1', (route) =>
    json(route, { installJobId: 'job-1', status: 'FAILED', errorCode: 'SKILL_CONTENT_INVALID' })
  );
  await page.route('**/api/skill-install-jobs/job-2', (route) => {
    installed = true;
    return json(route, { installJobId: 'job-2', status: 'SUCCEEDED' });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('navigation', { name: '管理菜单' }).getByText('技能配置').click();
  await page.getByText('工作区', { exact: true }).click();
  await expect(page.locator('.target-select').nth(0)).toContainText('node-1');
  await expect(page.locator('.target-select').nth(1)).toContainText('project');
  await page.getByRole('button', { name: '检查环境', exact: true }).click();
  const environmentDialog = page.getByRole('dialog', { name: '环境检查通过' });
  await expect(environmentDialog).toContainText('受管副本');
  await environmentDialog.getByRole('button', { name: '知道了' }).click();
  const repairButton = page.getByRole('button', { name: '修正环境' });
  await expect(repairButton.locator('.el-icon')).toBeVisible();
  await repairButton.click();
  const repairDialog = page.getByRole('dialog', { name: '修正技能环境' });
  await expect(repairDialog).toContainText('本地 Git 排除规则');
  await repairDialog.getByRole('button', { name: '取消' }).click();
  expect(repairCalls).toBe(0);
  await repairButton.click();
  await page
    .getByRole('dialog', { name: '修正技能环境' })
    .getByRole('button', { name: '确认修正' })
    .click();
  await expect(page.getByText('Git 本地排除规则已修复')).toBeVisible();
  expect(repairCalls).toBe(1);
  await page
    .locator('.available-skill-table .el-table__row')
    .filter({ hasText: 'code-review' })
    .getByRole('button', { name: '安装' })
    .click();
  await expect(page.getByText('技能内容无效，未修改目标目录。')).toBeVisible();
  await page
    .locator('.available-skill-table .el-table__row')
    .filter({ hasText: 'code-review' })
    .getByRole('button', { name: '安装' })
    .click();
  await page.getByRole('tab', { name: '当前目标中的技能' }).click();
  await expect(page.getByRole('tab', { name: '当前目标中的技能' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  const installedSkill = page
    .locator('.installed-skill-table .el-table__row')
    .filter({ hasText: 'code-review' });
  await expect(installedSkill).toContainText('已是最新版本');
  await expect(installedSkill.getByRole('button', { name: '详情', exact: true })).toHaveCount(0);
  await expect(
    installedSkill.getByRole('button', { name: '删除' }).locator('.el-icon')
  ).toBeVisible();
  await expect(installedSkill.getByRole('button', { name: '重新安装' })).toBeVisible();
});

test('Enterprise administrators choose child organizations for skill sources and submit scalar organization IDs', async ({
  page
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  // Opening management first mounts its default users page before selecting sources.
  await page.route('**/api/enterprise/users', (route) => json(route, { users: [] }));
  await page.unroute('**/api/auth/me');
  await page.route('**/api/auth/me', (route) =>
    json(route, {
      authenticated: true,
      mustChangePassword: false,
      username: 'admin',
      isAdmin: true,
      edition: 'ENTERPRISE',
      licenseState: 'ENTERPRISE_VALID',
      role: 'ADMIN',
      organizationId: 1,
      managementWritable: true
    })
  );
  await page.route('**/api/resources', (route) => json(route, { nodes: [], workspaces: [] }));
  await page.route('**/api/organizations', (route) =>
    json(route, {
      organizations: [
        { id: 1, name: '企业根', parentOrganizationId: null },
        { id: 2, name: '研发中心', parentOrganizationId: 1 },
        { id: 3, name: '平台研发组', parentOrganizationId: 2 }
      ]
    })
  );
  let createdSourceBody: Record<string, unknown> | undefined;
  await page.route('**/api/skill-sources', (route) => {
    if (route.request().method() === 'POST') {
      createdSourceBody = route.request().postDataJSON() as Record<string, unknown>;
      return json(route, { source: { id: 'platform-skills' } }, 201);
    }
    return json(route, { sources: [] });
  });
  await page.route('**/api/skill-favorites', (route) => json(route, { favorites: [] }));

  await page.goto('/console');
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('navigation', { name: '管理菜单' }).getByText('技能源管理').click();
  await page.getByRole('button', { name: '添加技能源', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加技能源' });
  await dialog.getByRole('textbox').nth(0).fill('平台技能');
  await dialog.getByRole('textbox').nth(1).fill('https://github.com/example/platform-skills.git');
  await dialog.locator('.el-form-item').filter({ hasText: '范围' }).locator('.el-select').click();
  await page.getByRole('option', { name: '组织', exact: true }).click();
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(dialog.getByText('请选择组织', { exact: true })).toBeVisible();
  expect(createdSourceBody).toBeUndefined();
  const organizationCascader = dialog.locator('.el-cascader');
  await organizationCascader.locator('input').fill('平台研发组');
  await page.getByRole('listitem').filter({ hasText: '企业根 / 研发中心 / 平台研发组' }).click();
  await dialog.getByRole('button', { name: '添加', exact: true }).click();

  await expect
    .poll(() => createdSourceBody)
    .toEqual({
      kind: 'REPOSITORY',
      enabled: true,
      name: '平台技能',
      locator: 'https://github.com/example/platform-skills.git',
      scope: 'ORGANIZATION',
      organizationId: 3
    });
  expect(pageErrors).toEqual([]);
});

test('Skill source management discovers external entries and adds them to the personal catalog', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route('**/api/resources', (route) => json(route, { nodes: [], workspaces: [] }));
  await page.route('**/api/skill-sources', (route) =>
    json(route, {
      sources: [
        {
          id: 'skills-sh',
          name: 'skills.sh',
          scope: 'ENTERPRISE',
          kind: 'SKILLS_SH',
          locator: 'skills.sh',
          enabled: true,
          builtIn: true,
          manageable: true
        }
      ]
    })
  );
  const sourceRequestUrls: string[] = [];
  await page.route('**/api/skill-sources/skills-sh/skills**', (route) => {
    sourceRequestUrls.push(route.request().url());
    return json(route, {
      skills: [
        {
          id: 'acme/skills/code-review',
          name: 'code-review',
          description: 'Review changes before merge',
          source: 'acme/skills',
          skillPath: 'skills/code-review',
          installs: 42
        }
      ]
    });
  });
  let skillSourceStatusRequests = 0;
  await page.route('**/api/skill-sources/skills-sh', (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    skillSourceStatusRequests += 1;
    return route.fulfill({ status: 204 });
  });
  let added = false;
  let addedBody: Record<string, unknown> | undefined;
  let presentation = { featured: false, tags: [] as string[] };
  let editedBody: Record<string, unknown> | undefined;
  let releaseCheckUpdate!: () => void;
  let markCheckRequested!: () => void;
  const checkRequested = new Promise<void>((resolve) => (markCheckRequested = resolve));
  const checkUpdateBlocked = new Promise<void>((resolve) => (releaseCheckUpdate = resolve));
  let releaseExistingCheckUpdate!: () => void;
  let markExistingCheckRequested!: () => void;
  const existingCheckRequested = new Promise<void>(
    (resolve) => (markExistingCheckRequested = resolve)
  );
  const existingCheckUpdateBlocked = new Promise<void>(
    (resolve) => (releaseExistingCheckUpdate = resolve)
  );
  await page.route('**/api/skill-favorites/favorite-1/check-update', async (route) => {
    markCheckRequested();
    await checkUpdateBlocked;
    return json(route, { updateAvailable: true, latestCommitSha: 'b'.repeat(40) });
  });
  await page.route('**/api/skill-favorites/favorite-existing/check-update', async (route) => {
    markExistingCheckRequested();
    await existingCheckUpdateBlocked;
    return json(route, { updateAvailable: false, latestCommitSha: 'c'.repeat(40) });
  });
  await page.route(
    (url) => url.pathname === '/api/skill-favorites',
    (route) => {
      if (route.request().method() === 'POST') {
        added = true;
        addedBody = route.request().postDataJSON() as Record<string, unknown>;
        presentation = {
          featured: Boolean(addedBody['featured']),
          tags: Array.isArray(addedBody['tags']) ? addedBody['tags'].map(String) : []
        };
        return json(route, { favorite: { id: 'favorite-1' } }, 201);
      }
      const favorites = [
        {
          id: 'favorite-existing',
          sourceId: 'skills-sh',
          scope: 'ENTERPRISE',
          normalizedName: 'java-style',
          featured: false,
          tags: ['Java'],
          description: 'Java conventions',
          repositoryIdentity: 'github.com/acme/java-skills',
          skillPath: 'skills/java-style',
          currentVersionId: 'version-existing',
          commitSha: 'c'.repeat(40),
          tlsVerified: true,
          updatedAt: 1_700_000_000_000,
          manageable: true
        },
        ...(added
          ? [
              {
                id: 'favorite-1',
                sourceId: 'skills-sh',
                scope: 'PERSONAL',
                normalizedName: 'code-review',
                featured: presentation.featured,
                tags: presentation.tags,
                description: 'Review changes before merge',
                repositoryIdentity: 'github.com/acme/skills',
                skillPath: 'skills/code-review',
                currentVersionId: 'version-1',
                commitSha: 'a'.repeat(40),
                tlsVerified: true,
                updatedAt: 1_700_000_000_000,
                manageable: true
              }
            ]
          : [])
      ];
      const keyword = new URL(route.request().url()).searchParams.get('keyword') ?? '';
      const matches = favorites.filter((favorite) => JSON.stringify(favorite).includes(keyword));
      return json(route, {
        favorites: matches,
        page: 1,
        pageSize: 20,
        total: matches.length,
        hasMore: false,
        facets: { tags: [...new Set(['Java', ...presentation.tags])] }
      });
    }
  );
  await page.route('**/api/skill-favorites/favorite-1', (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    editedBody = route.request().postDataJSON() as Record<string, unknown>;
    presentation = {
      featured: Boolean(editedBody['featured']),
      tags: Array.isArray(editedBody['tags']) ? editedBody['tags'].map(String) : []
    };
    return route.fulfill({ status: 204 });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('navigation', { name: '管理菜单' }).getByText('技能源管理').click();
  await expect(page.locator('.workbench-header .breadcrumb strong')).toHaveText('技能源管理');
  await expect(page.locator('.management-page')).toHaveCSS('overflow-y', 'auto');
  await expect(page.getByRole('button', { name: '浏览技能' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '源内技能' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.getByRole('tab', { name: '已加入的技能' })).toBeVisible();
  const sourceSearchBar = page.locator('.source-search-bar');
  await expect(sourceSearchBar.locator('.el-select')).toContainText('skills.sh');
  const sourceSearchBounds = await sourceSearchBar.evaluate((element) => {
    const select = element.querySelector('.el-select')?.getBoundingClientRect();
    const input = element.querySelector('.el-input')?.getBoundingClientRect();
    return { selectTop: select?.top, inputTop: input?.top };
  });
  expect(
    Math.abs(sourceSearchBounds.selectTop! - sourceSearchBounds.inputTop!)
  ).toBeLessThanOrEqual(1);
  const sourceRow = page
    .locator('.skill-source-table .el-table__row')
    .filter({ hasText: 'skills.sh' });
  await sourceRow.click();
  await expect(page.getByRole('dialog', { name: 'skills.sh' })).toBeVisible();
  await page
    .getByRole('dialog', { name: 'skills.sh' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await sourceRow.getByRole('button', { name: '停用', exact: true }).click();
  const skillSourceConfirmation = page
    .getByRole('dialog')
    .filter({ hasText: '停用技能源“skills.sh”？' });
  await expect(skillSourceConfirmation).toBeVisible();
  await skillSourceConfirmation.getByRole('button', { name: '取消', exact: true }).click();
  expect(skillSourceStatusRequests).toBe(0);
  await sourceRow.getByRole('button', { name: '停用', exact: true }).click();
  await skillSourceConfirmation.getByRole('button', { name: '停用', exact: true }).click();
  await expect.poll(() => skillSourceStatusRequests).toBe(1);
  expect(sourceRequestUrls).toEqual([]);
  await expect(page.getByText('请输入关键词搜索 skills.sh 技能。')).toBeVisible();
  await sourceSearchBar.getByRole('textbox').fill('code review');
  await sourceSearchBar.getByRole('button', { name: '搜索', exact: true }).click();
  const candidate = page
    .locator('.source-skill-table .el-table__row')
    .filter({ hasText: 'code-review' });
  await expect(page.locator('.source-skill-table')).toContainText('说明');
  await expect(candidate).toContainText('Review changes before merge');
  expect(new URL(sourceRequestUrls[0]!).searchParams.get('query')).toBe('code review');
  expect(new URL(sourceRequestUrls[0]!).searchParams.get('limit')).toBe('40');
  await expect(candidate.getByRole('button', { name: '详情', exact: true })).toHaveCount(0);
  await expect(candidate.locator('.row-actions .el-icon')).toBeVisible();
  await candidate.click();
  const candidateDetails = page.getByRole('dialog', { name: 'code-review' });
  await expect(candidateDetails).toContainText('安装热度');
  await candidateDetails.getByRole('button', { name: '关闭', exact: true }).click();
  await candidate.getByRole('button', { name: '加入可用目录' }).click();
  const dialog = page.getByRole('dialog', { name: '加入可用目录' });
  await expect(dialog.getByText('仅自己')).toBeVisible();
  await dialog.locator('.el-switch').click();
  const tagInput = dialog.getByRole('combobox', { name: 'Tag 标签' });
  await dialog
    .locator('.el-form-item')
    .filter({ hasText: 'Tag 标签' })
    .locator('.el-select')
    .click();
  await page.getByRole('option', { name: 'Java', exact: true }).click();
  await dialog
    .locator('.el-form-item')
    .filter({ hasText: 'Tag 标签' })
    .locator('.el-select')
    .click();
  await tagInput.pressSequentially('后端');
  await tagInput.press('Enter');
  await expect(dialog.locator('.el-tag').filter({ hasText: '后端' })).toBeVisible();
  await tagInput.press('Escape');
  await dialog.getByRole('button', { name: '加入', exact: true }).click();
  await expect(page.getByText('技能已加入可用目录')).toBeVisible();
  expect(addedBody).toMatchObject({ scope: 'PERSONAL', featured: true, tags: ['Java', '后端'] });
  await page.getByRole('tab', { name: '已加入的技能' }).click();
  await expect(page.getByRole('tab', { name: '已加入的技能' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.locator('.catalog-skill-table')).toBeVisible();
  const catalogLayout = await page.locator('.management-page').evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth
  }));
  expect(catalogLayout.scrollWidth).toBeLessThanOrEqual(catalogLayout.clientWidth);
  const addedSkill = page
    .locator('.catalog-skill-table .el-table__row')
    .filter({ hasText: 'aaaaaaaa' });
  await expect(addedSkill).toContainText('更新于');
  const catalogFilter = page.locator('.catalog-filter-bar');
  await expect(catalogFilter.getByRole('button', { name: '全部', exact: true })).toBeVisible();
  await expect(catalogFilter.getByRole('button', { name: '后端', exact: true })).toBeVisible();
  await catalogFilter.getByRole('textbox').fill('不存在的技能');
  await expect(addedSkill).toHaveCount(0);
  await catalogFilter.getByRole('textbox').clear();
  await expect(addedSkill).toBeVisible();
  await expect(addedSkill.getByRole('button', { name: '详情', exact: true })).toHaveCount(0);
  await expect(
    addedSkill.getByRole('button', { name: '编辑', exact: true }).locator('.el-icon')
  ).toBeVisible();
  await addedSkill.getByRole('button', { name: '编辑', exact: true }).click();
  const editDialog = page.getByRole('dialog', { name: '编辑技能信息' });
  await expect(editDialog.getByText('普通', { exact: true })).toHaveCount(0);
  await editDialog.locator('.el-switch').click();
  await editDialog.getByRole('button', { name: '保存', exact: true }).click();
  expect(editedBody).toEqual({ featured: false, tags: ['Java', '后端'] });
  const checkUpdateButton = addedSkill.getByRole('button', { name: '检查更新' });
  const existingSkill = page
    .locator('.catalog-skill-table .el-table__row')
    .filter({ hasText: 'java-style' });
  const existingCheckUpdateButton = existingSkill.getByRole('button', { name: '检查更新' });
  await existingCheckUpdateButton.click();
  await existingCheckRequested;
  await expect(checkUpdateButton).toBeEnabled();
  await checkUpdateButton.click();
  await checkRequested;
  await expect(existingCheckUpdateButton).toHaveClass(/is-loading/);
  await expect(checkUpdateButton).toHaveClass(/is-loading/);
  await expect(page.locator('.el-table .el-loading-mask')).toHaveCount(0);
  releaseExistingCheckUpdate();
  releaseCheckUpdate();
  await expect(addedSkill.getByRole('button', { name: '更新到 bbbbbbbb' })).toBeVisible();
});

for (const scope of ['PERSONAL', 'ORGANIZATION'] as const) {
  test(`MCP source creation and catalog imports preserve ${scope} ownership and refresh consistently`, async ({
    page
  }) => {
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    await page.route('**/api/auth/me', (route) =>
      json(route, {
        authenticated: true,
        mustChangePassword: false,
        username: 'admin',
        isAdmin: true,
        edition: scope === 'PERSONAL' ? 'COMMUNITY' : 'ENTERPRISE',
        role: 'ADMIN',
        managementWritable: true,
        csrfToken: 'csrf-1'
      })
    );
    await page.route('**/api/enterprise/users', (route) => json(route, { users: [] }));
    await page.route('**/api/organizations', (route) =>
      json(route, {
        organizations: [{ id: 3, name: '平台组', parentOrganizationId: null }]
      })
    );
    const candidate = {
      id: 'candidate-1',
      serverName: 'example/test',
      displayName: 'Test MCP',
      description: 'Test catalog entry',
      version: '1.0.0',
      runtime: { transport: 'STDIO' }
    };
    let sourceBody: Record<string, unknown> | undefined;
    let catalogBody: Record<string, unknown> | undefined;
    await page.route('**/api/mcp-sources', (route) => {
      if (route.request().method() === 'POST') {
        sourceBody = route.request().postDataJSON() as Record<string, unknown>;
        return json(route, {});
      }
      return json(route, {
        sources:
          sourceBody === undefined
            ? []
            : [
                {
                  id: 'source-1',
                  ...sourceBody,
                  enabled: true,
                  builtIn: false,
                  status: 'READY',
                  manageable: true
                }
              ]
      });
    });
    await page.route('**/api/mcp-sources/source-1/servers?*', (route) =>
      json(route, { servers: [candidate] })
    );
    await page.route('**/api/mcp-catalog', (route) => {
      if (route.request().method() === 'POST') {
        catalogBody = route.request().postDataJSON() as Record<string, unknown>;
        return json(route, {});
      }
      return json(route, {
        entries:
          catalogBody === undefined
            ? []
            : [
                {
                  ...candidate,
                  ...catalogBody,
                  id: 'catalog-1',
                  manageable: true,
                  updatedAt: 1
                }
              ]
      });
    });
    await page.goto('/console?view=management&management=mcp-sources');
    await page.getByRole('button', { name: '添加 MCP 源', exact: true }).click();
    const sourceDialog = page.getByRole('dialog', { name: '新增 MCP 源' });
    await sourceDialog.getByRole('textbox').nth(0).fill('Fixture registry');
    await sourceDialog.getByRole('textbox').nth(1).fill('https://registry.example.test');
    if (scope === 'ORGANIZATION') {
      await sourceDialog.locator('.el-select').click();
      await page.getByRole('option', { name: '组织', exact: true }).click();
      await sourceDialog.getByRole('button', { name: '确定', exact: true }).click();
      await expect(sourceDialog.getByText('请选择组织', { exact: true })).toBeVisible();
      expect(sourceBody).toBeUndefined();
      await sourceDialog.locator('.el-cascader input').fill('平台组');
      await page.getByRole('listitem').filter({ hasText: '平台组' }).click();
    } else {
      await expect(sourceDialog.locator('.el-cascader')).toHaveCount(0);
    }
    await sourceDialog.getByRole('button', { name: '确定', exact: true }).click();
    await expect(sourceDialog).toBeHidden();
    await expect
      .poll(() => sourceBody)
      .toEqual({
        name: 'Fixture registry',
        locator: 'https://registry.example.test',
        scope,
        ...(scope === 'ORGANIZATION' ? { organizationId: 3 } : {})
      });
    await expect(page.locator('.mcp-source-table')).toContainText('Fixture registry');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await page
      .locator('.source-mcp-table .el-table__row')
      .filter({ hasText: 'Test MCP' })
      .getByRole('button', { name: '加入可用目录', exact: true })
      .click();
    const catalogDialog = page.getByRole('dialog', { name: '加入 MCP 中心' });
    if (scope === 'ORGANIZATION') {
      await catalogDialog.locator('.el-select').first().click();
      await page.getByRole('option', { name: '组织', exact: true }).click();
      await catalogDialog.locator('.el-cascader input').fill('平台组');
      await page.getByRole('listitem').filter({ hasText: '平台组' }).click();
    }
    await catalogDialog.getByRole('button', { name: '确定', exact: true }).click();
    await expect(catalogDialog).toBeHidden();
    await expect
      .poll(() => catalogBody)
      .toEqual({
        sourceId: 'source-1',
        candidate,
        featured: false,
        tags: [],
        scope,
        ...(scope === 'ORGANIZATION' ? { organizationId: 3 } : {})
      });
    await page.getByRole('tab', { name: '已加入的 MCP' }).click();
    await expect(page.locator('.catalog-mcp-table')).toContainText('Test MCP');
  });
}

test('MCP source tables open source, discovery, and catalog details through clickable rows', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route('**/api/resources', (route) => json(route, { nodes: [], workspaces: [] }));
  await page.route('**/api/mcp-sources', (route) =>
    json(route, {
      sources: [
        {
          id: 'acme-registry',
          name: 'Acme Registry',
          locator: 'https://registry.acme.example',
          scope: 'PERSONAL',
          enabled: true,
          builtIn: false,
          status: 'READY',
          manageable: true
        }
      ]
    })
  );
  let mcpSourceStatusRequests = 0;
  await page.route('**/api/mcp-sources/acme-registry', (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    mcpSourceStatusRequests += 1;
    return route.fulfill({ status: 204 });
  });
  let releaseFirstCheckUpdate!: () => void;
  let markFirstCheckRequested!: () => void;
  const firstCheckRequested = new Promise<void>((resolve) => (markFirstCheckRequested = resolve));
  const firstCheckUpdateBlocked = new Promise<void>(
    (resolve) => (releaseFirstCheckUpdate = resolve)
  );
  let releaseSecondCheckUpdate!: () => void;
  let markSecondCheckRequested!: () => void;
  const secondCheckRequested = new Promise<void>((resolve) => (markSecondCheckRequested = resolve));
  const secondCheckUpdateBlocked = new Promise<void>(
    (resolve) => (releaseSecondCheckUpdate = resolve)
  );
  await page.route('**/api/mcp-catalog/catalog-1/check-update', async (route) => {
    markFirstCheckRequested();
    await firstCheckUpdateBlocked;
    return json(route, { updateAvailable: true, latestVersion: '1.1.0' });
  });
  await page.route('**/api/mcp-catalog/catalog-2/check-update', async (route) => {
    markSecondCheckRequested();
    await secondCheckUpdateBlocked;
    return json(route, { updateAvailable: false, latestVersion: '1.2.0' });
  });
  await page.route(
    (url) => url.pathname === '/api/mcp-catalog',
    (route) =>
      json(route, {
        page: 1,
        pageSize: 20,
        total: 2,
        hasMore: false,
        facets: { tags: ['backend', 'tools'] },
        entries: [
          {
            id: 'catalog-1',
            sourceId: 'acme-registry',
            serverName: 'acme-existing',
            displayName: 'Acme Existing',
            description: 'Existing catalog MCP server',
            version: '1.0.0',
            runtime: { transport: 'HTTP' },
            scope: 'PERSONAL',
            featured: true,
            tags: ['backend'],
            manageable: true,
            updatedAt: 1_700_000_000_000
          },
          {
            id: 'catalog-2',
            sourceId: 'acme-registry',
            serverName: 'acme-tools',
            displayName: 'Acme Tools',
            description: 'Auxiliary MCP server',
            version: '1.2.0',
            runtime: { transport: 'STDIO' },
            scope: 'PERSONAL',
            featured: false,
            tags: ['tools'],
            manageable: true,
            updatedAt: 1_700_000_000_000
          }
        ]
      })
  );
  await page.route('**/api/mcp-sources/acme-registry/servers?*', (route) =>
    json(route, {
      servers: [
        {
          id: 'candidate-1',
          serverName: 'acme-search',
          displayName: 'Acme Search',
          description: 'Search MCP server',
          version: '2.0.0',
          runtime: { transport: 'STDIO' }
        }
      ]
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('navigation', { name: '管理菜单' }).getByText('MCP 源管理').click();
  await expect(page.locator('.workbench-header .breadcrumb strong')).toHaveText('MCP 源管理');
  const mcpSourceSearchBar = page.locator('.source-search-bar');
  const mcpSourceSearchBounds = await mcpSourceSearchBar.evaluate((element) => {
    const select = element.querySelector('.el-select')?.getBoundingClientRect();
    const input = element.querySelector('.el-input')?.getBoundingClientRect();
    return { selectTop: select?.top, inputTop: input?.top };
  });
  expect(
    Math.abs(mcpSourceSearchBounds.selectTop! - mcpSourceSearchBounds.inputTop!)
  ).toBeLessThanOrEqual(1);

  const sourceRow = page
    .locator('.mcp-source-table .el-table__row')
    .filter({ hasText: 'Acme Registry' });
  await sourceRow.click();
  await expect(page.getByRole('dialog', { name: 'Acme Registry' })).toBeVisible();
  await page
    .getByRole('dialog', { name: 'Acme Registry' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await sourceRow.getByRole('button', { name: '停用', exact: true }).click();
  const mcpSourceConfirmation = page
    .getByRole('dialog')
    .filter({ hasText: '停用 MCP 源“Acme Registry”？' });
  await expect(mcpSourceConfirmation).toBeVisible();
  await mcpSourceConfirmation.getByRole('button', { name: '取消', exact: true }).click();
  expect(mcpSourceStatusRequests).toBe(0);
  await sourceRow.getByRole('button', { name: '停用', exact: true }).click();
  await mcpSourceConfirmation.getByRole('button', { name: '停用', exact: true }).click();
  await expect.poll(() => mcpSourceStatusRequests).toBe(1);

  await page.getByRole('button', { name: '搜索', exact: true }).click();
  const candidateRow = page
    .locator('.source-mcp-table .el-table__row')
    .filter({ hasText: 'Acme Search' });
  await expect(page.locator('.source-mcp-table')).toContainText('说明');
  await expect(candidateRow).toContainText('Search MCP server');
  await expect(candidateRow.getByRole('button', { name: '详情', exact: true })).toHaveCount(0);
  await expect(candidateRow.locator('.row-actions .el-icon')).toBeVisible();
  await candidateRow.click();
  await expect(page.getByRole('dialog', { name: 'Acme Search' })).toBeVisible();
  await page
    .getByRole('dialog', { name: 'Acme Search' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();

  await page.getByRole('tab', { name: '已加入的 MCP' }).click();
  const catalogRow = page
    .locator('.catalog-mcp-table .el-table__row')
    .filter({ hasText: 'Acme Existing' });
  await expect(catalogRow).toContainText('1.0.0');
  await expect(catalogRow.getByRole('button', { name: '详情', exact: true })).toHaveCount(0);
  await expect(
    catalogRow.getByRole('button', { name: '编辑', exact: true }).locator('.el-icon')
  ).toBeVisible();
  const firstCheckUpdateButton = catalogRow.getByRole('button', { name: '检查更新' });
  const secondCatalogRow = page
    .locator('.catalog-mcp-table .el-table__row')
    .filter({ hasText: 'Acme Tools' });
  const secondCheckUpdateButton = secondCatalogRow.getByRole('button', { name: '检查更新' });
  await firstCheckUpdateButton.click();
  await firstCheckRequested;
  await expect(secondCheckUpdateButton).toBeEnabled();
  await secondCheckUpdateButton.click();
  await secondCheckRequested;
  await expect(firstCheckUpdateButton).toHaveClass(/is-loading/);
  await expect(secondCheckUpdateButton).toHaveClass(/is-loading/);
  await expect(page.locator('.el-table .el-loading-mask')).toHaveCount(0);
  releaseFirstCheckUpdate();
  releaseSecondCheckUpdate();
  await expect(catalogRow.getByRole('button', { name: '更新到 1.1.0' })).toBeVisible();
  await catalogRow.click();
  await expect(page.getByRole('dialog', { name: 'Acme Existing' })).toBeVisible();
});
