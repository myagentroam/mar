import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

test('Node menu opens a same-origin desktop tab without an opener or Workspace', async ({
  page,
  context
}) => {
  const server = await startCustomThemeFixture('test/e2e/support/remote-desktop-menu.html', {
    protocolSource: true
  });
  try {
    await page.goto(`${server.url}remote-desktop-menu.html`);
    await page.getByRole('button', { name: 'Available Node' }).hover();
    await page.locator('.node-tree-actions button').first().click();
    const desktop = page.getByRole('menuitem', { name: /Remote Desktop|远程桌面/u });
    await expect(desktop).toBeVisible();
    await expect(desktop.locator('svg')).toHaveAttribute('data-mar-icon', 'desktop');
    await expect(
      page.getByRole('menuitem', { name: /Node details|节点详情/u }).locator('svg')
    ).toHaveAttribute('data-mar-icon', 'view');
    await context.route('**/console?*', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Desktop</title>' })
    );
    const opened = context.waitForEvent('page');
    await desktop.click();
    const tab = await opened;
    await tab.waitForLoadState();
    const url = new URL(tab.url());
    expect(url.origin).toBe(new URL(page.url()).origin);
    expect(url.pathname).toBe('/console');
    expect([...url.searchParams.entries()]).toEqual([
      ['remoteDesktop', '1'],
      ['nodeId', 'node/test']
    ]);
    expect(await tab.evaluate(() => window.opener)).toBeNull();
    await tab.close();
    await page.getByRole('button', { name: 'No Node access' }).hover();
    await page.locator('.node-tree-actions button').last().click();
    await expect(desktop).toHaveCount(0);
  } finally {
    await server.close();
  }
});
