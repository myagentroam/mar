import { expect, test, type Page } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

const organizations = [
  { id: 1, name: 'Root', parentOrganizationId: null },
  { id: 7, name: 'Platform', parentOrganizationId: 1 },
  { id: 8, name: 'Research', parentOrganizationId: 7 },
  { id: 9, name: 'Other', parentOrganizationId: 1 }
];

async function setup(page: Page, english: boolean, nodeManageable = false): Promise<void> {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.addInitScript(
    (locale) => localStorage.setItem('mar.locale.v2', locale),
    english ? 'en-US' : 'zh-CN'
  );
  const admin = {
    authenticated: true,
    userId: 1,
    mustChangePassword: false,
    username: 'admin',
    isAdmin: true,
    edition: 'ENTERPRISE',
    role: 'ADMIN',
    organizationId: 1,
    licenseState: 'ENTERPRISE_VALID',
    managementWritable: true,
    csrfToken: 'csrf-1'
  };
  await page.route('**/api/auth/me', (route) => json(route, admin));
  await page.route('**/api/license', (route) =>
    json(route, {
      edition: 'ENTERPRISE',
      state: 'ENTERPRISE_VALID',
      reason: null,
      licenseId: 'license-1',
      enterpriseName: 'Organization display fixture',
      expiresAt: null,
      managementWritable: true
    })
  );
  const node = {
    id: 'node-1',
    displayName: 'Organization Node',
    platform: 'linux',
    architecture: 'x64',
    nodeAppVersion: '0.9.120',
    nodeVersion: 'v24.15.0',
    connected: true,
    disabled: false,
    manageable: nodeManageable,
    workspaceCreatable: true,
    ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 7 },
    capabilities: { codex: { available: true, version: '0.146' } }
  };
  await page.route('**/api/nodes', (route) => json(route, { nodes: [node] }));
  await page.route('**/api/management/nodes', (route) => json(route, { nodes: [node] }));
  await page.route('**/api/resources*', (route) => {
    const paginated = new URL(route.request().url()).searchParams.has('page');
    return json(route, {
      nodes: [node],
      workspaces: [],
      ...(paginated ? { page: 1, pageSize: 20, total: 1, hasMore: false } : {})
    });
  });
  await page.route('**/api/enterprise/users', (route) => json(route, { users: [] }));
  await page.route('**/api/runner-usage/status?*', (route) => json(route, { statuses: [] }));
  await page.route('**/api/organizations', (route) => json(route, { organizations }));
}

for (const english of [false, true]) {
  const language = english ? 'en-US' : 'zh-CN';
  test(`Organization names preserve the complete template catalog while grants stay within the hosting subtree ${language}`, async ({
    page
  }) => {
    await setup(page, english);
    await page.route(
      (url) => url.pathname === '/api/admin/conversation-templates',
      (route) =>
        json(route, {
          page: 1,
          pageSize: 20,
          total: 1,
          hasMore: false,
          templates: [
            {
              id: 'template-1',
              nodeId: 'node-1',
              name: 'Organization template',
              description: '',
              status: 'ACTIVE',
              currentVersionId: 'version-1',
              available: true,
              createdAt: 1,
              updatedAt: 2,
              draftRevision: 1,
              publishedVersion: 1
            }
          ]
        })
    );
    const grants = [7, 8, 9, 99].map((id) => ({
      id: `grant-${id}`,
      resourceType: 'TEMPLATE',
      templateId: 'template-1',
      targetType: 'ORGANIZATION',
      targetOrganizationId: id,
      grantScopeOrganizationId: 7,
      createdByUserId: 1,
      createdAt: 1
    }));
    const writes: Record<string, unknown>[] = [];
    const revoked: string[] = [];
    await page.route('**/api/resource-grants**', (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        writes.push(body);
        grants.push({
          ...grants[0]!,
          id: 'grant-created',
          targetOrganizationId: Number(body['targetOrganizationId'])
        });
        return json(route, { id: 'grant-created' }, 201);
      }
      if (route.request().method() === 'DELETE') {
        const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
        revoked.push(id);
        const index = grants.findIndex((grant) => grant.id === id);
        if (index >= 0) grants.splice(index, 1);
        return route.fulfill({ status: 204 });
      }
      return json(route, { grants });
    });
    await page.goto('/console?view=management&management=conversation-templates');
    const row = page.locator('.mar-ui-table__row').filter({ hasText: 'Organization template' });
    await row.getByRole('button', { name: english ? 'Grant' : '授权', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.locator('.mar-ui-table__row').filter({ hasText: 'Root / Platform' })
    ).toHaveCount(2);
    await expect(dialog).toContainText('Root / Platform / Research');
    await expect(dialog).toContainText('Root / Other');
    await expect(dialog.locator('.mar-ui-table__row').filter({ hasText: '99' })).toBeVisible();
    await dialog.locator('.mar-ui-cascader input').fill('Other');
    await expect(page.locator('.mar-ui-cascader__option')).toHaveCount(0);
    await dialog.locator('.mar-ui-cascader input').fill('Research');
    await expect(
      page.locator('.mar-ui-cascader__option').filter({ hasText: 'Research' })
    ).toBeVisible();
    await page.locator('.mar-ui-cascader__option').filter({ hasText: 'Research' }).click();
    await dialog.getByRole('button', { name: english ? 'Grant' : '授权', exact: true }).click();
    await expect
      .poll(() => writes)
      .toEqual([
        {
          resourceType: 'TEMPLATE',
          templateId: 'template-1',
          targetType: 'ORGANIZATION',
          targetOrganizationId: 8
        }
      ]);
    await expect(dialog.locator('.mar-ui-table__row')).toHaveCount(5);
    await dialog.locator('.mar-ui-table__row').last().getByRole('button').click();
    await page.locator('.mar-message-box .el-button--primary').click();
    await expect.poll(() => revoked).toEqual(['grant-created']);
    await expect(dialog.locator('.mar-ui-table__row')).toHaveCount(4);
  });

  test(`Organization names appear in resource detail grants and fixed-Workspace registration ${language}`, async ({
    page
  }) => {
    await setup(page, english);
    await page.route('**/api/resource-grants**', (route) =>
      json(route, {
        grants: [
          { id: 'grant-7', targetType: 'ORGANIZATION', targetOrganizationId: 7 },
          { id: 'grant-99', targetType: 'ORGANIZATION', targetOrganizationId: 99 }
        ]
      })
    );
    await page.goto('/console?view=management&management=resource-nodes');
    const row = page.locator('.mar-ui-table__row').filter({ hasText: 'Organization Node' });
    await expect(row).toContainText('Root / Platform');
    await row.click();
    const details = page.getByRole('dialog');
    await expect(details).toContainText('Root / Platform');
    await details.getByRole('button', { name: english ? 'Close' : '关闭', exact: true }).click();
    await row.getByRole('button', { name: english ? 'Grant' : '授权', exact: true }).click();
    const grants = page.getByRole('dialog');
    await expect(grants).toContainText('Root / Platform');
    await expect(grants.locator('.mar-ui-table__row').filter({ hasText: '99' })).toBeVisible();
    await grants.getByRole('button', { name: english ? 'Close' : '关闭', exact: true }).click();
    await page.getByRole('button', { name: english ? 'Work' : '工作', exact: true }).click();
    const tree = page.locator('.workspace-tree');
    await tree.getByRole('button', { name: 'Organization Node', exact: true }).click();
    await page
      .getByRole('button', { name: english ? 'Node actions' : '节点操作', exact: true })
      .click();
    await page
      .getByRole('menuitem', { name: english ? 'Add workspace' : '添加工作区', exact: true })
      .click();
    const ownership = page.locator('.workspace-picker-ownership');
    await expect(ownership.locator('strong')).toHaveText('Root / Platform');
    await expect(ownership.locator('.mar-ui-select, .mar-ui-cascader')).toHaveCount(0);
  });
}

test('Workspace registration uses the searchable organization selector for the Node subtree', async ({
  page
}) => {
  await setup(page, true, true);
  await page.goto('/console?view=nodes');
  const tree = page.locator('.workspace-tree');
  await tree.getByRole('button', { name: 'Organization Node', exact: true }).click();
  await tree.getByRole('button', { name: 'Node actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add workspace', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Register Workspace' });
  const selector = dialog.getByLabel('Resource Owner', { exact: true });
  const dropdown = page.locator('.mar-ui-cascader__popup:visible');
  const suggestions = dropdown.locator('.mar-ui-cascader__option');
  await expect(selector).toHaveValue('Root / Platform');
  await page.setViewportSize({ width: 390, height: 844 });
  await selector.fill('Other');
  await expect(dropdown.locator('.mar-ui-cascader__empty')).toBeVisible();
  await expect(suggestions).toHaveCount(0);
  await selector.fill('Research');
  const research = suggestions.filter({ hasText: /^Root \/ Platform \/ Research$/u });
  await expect(research).toBeInViewport();
  await page.keyboard.press('ArrowDown');
  await expect(research).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dropdown).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(selector).toBeFocused();
  await expect(selector).toHaveAttribute('aria-expanded', 'false');
  await expect(selector).toHaveValue('Root / Platform');

  await selector.click();
  await selector.fill('Research');
  await expect(research).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(research).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(selector).toHaveValue('Root / Platform / Research');
});
