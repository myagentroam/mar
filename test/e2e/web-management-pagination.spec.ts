import { expect, test, type Page } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

async function setupNodes(page: Page, failSecond = false) {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
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
  const nodes = Array.from({ length: 45 }, (_, index) => ({
    id: `node-${String(index).padStart(2, '0')}`,
    displayName: `Fixture Node ${String(index).padStart(2, '0')}`,
    connected: true,
    disabled: false,
    ownership: { ownerType: 'PERSONAL', ownerUserId: 1 },
    nodeAppVersion: '0.9.1',
    metadata: { supervisedUpgrade: true },
    upgradeAvailability: { state: 'AVAILABLE', targetVersion: '0.10.1' }
  }));
  const queries: URLSearchParams[] = [];
  let fail = failSecond;
  await page.route('**/api/resources*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    if (!query.has('page')) return json(route, { nodes, workspaces: [] });
    const requested = Number(query.get('page'));
    if (requested === 2 && fail) {
      fail = false;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'LIST_TEMPORARILY_UNAVAILABLE', message: 'Try again.' }
        })
      });
    }
    let rows = nodes.filter((node) => node.displayName.includes(query.get('keyword') ?? ''));
    if (query.get('sortOrder') === 'desc') rows = [...rows].reverse();
    const current = Math.min(requested, Math.max(1, Math.ceil(rows.length / 20)));
    return json(route, {
      nodes: rows.slice((current - 1) * 20, current * 20),
      workspaces: [],
      page: current,
      pageSize: 20,
      total: rows.length,
      hasMore: current * 20 < rows.length
    });
  });
  await page.route('**/api/management/nodes', (route) => json(route, { nodes }));
  await page.route(/\/api\/(?:enterprise|management)\/users(?:\?.*)?$/u, (route) => {
    const query = new URL(route.request().url()).searchParams;
    return json(
      route,
      query.has('page')
        ? { users: [], page: 1, pageSize: 20, total: 0, hasMore: false }
        : { users: [] }
    );
  });
  await page.route('**/api/admin/users', (route) => json(route, { users: [] }));
  await page.route('**/api/organizations', (route) => json(route, { organizations: [] }));
  await page.goto('/console');
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('button', { name: '节点管理', exact: true }).click();
  return queries;
}

test('Desktop management requests backend pages and push-all ignores the current page and filter', async ({
  page
}) => {
  const queries = await setupNodes(page);
  const table = page.locator('.resource-management-panel .el-table');
  await expect(table.locator('tbody tr.el-table__row')).toHaveCount(20);
  expect(
    queries
      .filter((query) => query.has('page'))
      .every((query) => query.get('limit') === '20' && query.get('resourceType') === 'NODE')
  ).toBe(true);
  await page.locator('.el-pager li.number').filter({ hasText: /^2$/ }).click();
  await expect(table.getByText('Fixture Node 20', { exact: true })).toBeVisible();
  await expect(table.getByText('Fixture Node 00', { exact: true })).toHaveCount(0);
  await table.locator('.sort-caret.descending').first().click();
  await expect(table.getByText('Fixture Node 44', { exact: true })).toBeVisible();
  expect(queries.at(-1)?.get('sortBy')).toBe('label');
  expect(queries.at(-1)?.get('sortOrder')).toBe('desc');
  await page.locator('.resource-filters input').first().fill('Fixture Node 44');
  await expect(table.locator('tbody tr.el-table__row')).toHaveCount(1);
  const upgraded: string[] = [];
  await page.route('**/api/nodes/*/upgrade', (route) => {
    upgraded.push(new URL(route.request().url()).pathname.split('/')[3]!);
    return json(route, { accepted: true });
  });
  await page.getByRole('button', { name: '推送全部', exact: true }).click();
  const confirmation = page.locator('.el-message-box');
  await expect(confirmation).toContainText('45');
  await confirmation.getByRole('button', { name: '推送全部', exact: true }).click();
  await expect.poll(() => upgraded.length).toBe(45);
  expect(new Set(upgraded).size).toBe(45);
  expect(
    queries.filter((query) => !query.has('page') && query.get('management') === 'all')
  ).toHaveLength(1);
});

test('Mobile append pauses on a failed backend page and retries the same page manually', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const queries = await setupNodes(page, true);
  const table = page.locator('.resource-management-panel .el-table');
  await expect(table.locator('tbody tr.el-table__row')).toHaveCount(20);
  const more = page.getByRole('button', { name: '加载更多', exact: true });
  await more.scrollIntoViewIfNeeded();
  await expect.poll(() => queries.filter((query) => query.get('page') === '2').length).toBe(1);
  await expect(more).toBeEnabled();
  await more.click();
  await expect.poll(() => queries.filter((query) => query.get('page') === '2').length).toBe(2);
  await expect(table.getByText('Fixture Node 20', { exact: true })).toBeVisible();
  // A successful manual retry resumes automatic loading of later pages.
  await expect(table.locator('tbody tr.el-table__row')).toHaveCount(45);
});
