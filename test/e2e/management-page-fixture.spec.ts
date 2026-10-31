import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/management-page.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

test('Audit initial failure retries in place with one busy indicator and retained focus', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.url}management-page.html?area=audit`);
  const section = page.locator('.audit-management');
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(1);
  await page.evaluate(() => window.managementPageFixture.settle(0, false));
  const retry = section.locator('.management-mobile-status button');
  await expect(retry).toHaveText('Failed to load. Retry');
  await retry.focus();
  await retry.press('Enter');
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(2);
  await expect(retry).toBeFocused();
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).toHaveAccessibleName('Loading');
  await expect(section.locator('.busy-indicator')).toHaveCount(1);
  await expect(section.locator('.el-loading-mask')).toBeHidden();
  await page.evaluate(() => window.managementPageFixture.settle(1, true));
  await expect(section.locator('.management-mobile-status button')).toHaveCount(0);
});

test('Audit desktop page changes show one table loading indicator', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.url}management-page.html?area=audit&pages=1`);
  const section = page.locator('.audit-management');
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(1);
  await page.evaluate(() => window.managementPageFixture.settle(0, true));
  await section.locator('.el-pager li.number').filter({ hasText: /^2$/ }).click();
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(2);
  await expect(section.locator('.el-table .el-loading-mask')).toBeVisible();
  await expect(section.locator(':scope > .el-loading-mask')).toBeHidden();
  await expect(section.getByRole('button', { name: 'Refresh', exact: true })).not.toHaveClass(
    /is-loading/
  );
  await page.evaluate(() => window.managementPageFixture.settle(1, true));
  await expect(section.locator('.el-table .el-loading-mask')).toBeHidden();
  await expect(section.locator('.el-pager .is-active')).toHaveText('2');
});

test('Usage details retain rows and retry a failed automatic page in place', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.url}management-page.html?area=usage`);
  const panel = page.getByTestId('usage-statistics');
  const count = () => page.evaluate(() => window.managementPageFixture.calls().length);
  await expect.poll(count).toBe(2);
  await page.evaluate(() =>
    Promise.all([
      window.managementPageFixture.settle(0, true),
      window.managementPageFixture.settle(1, true)
    ])
  );
  const rows = panel.locator('.records tbody tr.el-table__row');
  const boundary = panel.locator('.management-mobile-status');
  await expect(rows).toHaveCount(20);
  await boundary.scrollIntoViewIfNeeded();
  await expect.poll(count).toBe(3);
  await page.evaluate(() => window.managementPageFixture.settle(2, false));
  const retry = boundary.locator('button');
  await expect(retry).toBeVisible();
  await expect(retry).toHaveAccessibleName('Failed to load. Retry');
  await expect(rows).toHaveCount(20);
  await retry.focus();
  await retry.press('Enter');
  await expect.poll(count).toBe(4);
  await expect(retry).toBeFocused();
  await expect(retry).toHaveAccessibleName('Loading');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => window.managementPageFixture.settle(3, true));
  await expect(rows).toHaveCount(40);
  await expect(boundary.getByRole('button')).toHaveCount(0);
  const calls = await page.evaluate(() => window.managementPageFixture.calls());
  expect(new URL(calls[2]!, 'http://fixture').searchParams.get('page')).toBe('2');
  expect(new URL(calls[3]!, 'http://fixture').searchParams.get('page')).toBe('2');
});

test('Resource append failure stops, refresh uses one indicator, and a new context rearms once', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.url}management-page.html`);
  const section = page.locator('.resource-management-panel');
  const rows = section.locator('tbody tr.el-table__row');
  const boundary = section.locator('.management-mobile-status');
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(1);
  await page.evaluate(() => window.managementPageFixture.settle(0, true));
  await expect(rows).toHaveCount(20);
  await boundary.scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(2);
  await page.evaluate(() => window.managementPageFixture.settle(1, false));
  await expect(boundary.getByRole('button', { name: 'Failed to load. Retry' })).toBeVisible();
  await expect(rows).toHaveCount(20);
  await section.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(3);
  await expect(boundary.locator('button')).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Refresh', exact: true })).toHaveClass(
    /is-loading/
  );
  await expect(section.locator('.el-loading-mask')).toBeHidden();
  await page.evaluate(() => window.managementPageFixture.settle(2, true));
  await expect(rows).toHaveCount(20);
  const input = section.locator('.resource-filters input').first();
  await input.fill('Node');
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(4);
  await page.evaluate(() => window.managementPageFixture.settle(3, true));
  await boundary.scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => window.managementPageFixture.calls().length)).toBe(5);
  const calls = await page.evaluate(() => window.managementPageFixture.calls());
  expect(new URL(calls[4]!, 'http://fixture').searchParams.get('page')).toBe('2');
  await page.evaluate(() => window.managementPageFixture.settle(4, true));
  await expect(rows).toHaveCount(40);
  expect(await page.evaluate(() => window.managementPageFixture.calls().length)).toBe(5);
});

test('A continuously visible boundary loads only once per new query context', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 3600 });
  await page.goto(`${fixture.url}management-page.html?tall=1`);
  const section = page.locator('.resource-management-panel');
  const boundary = section.locator('.management-mobile-status');
  const count = () => page.evaluate(() => window.managementPageFixture.calls().length);
  const settle = (index: number) =>
    page.evaluate((value) => window.managementPageFixture.settle(value, true), index);
  const drainObservers = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 250)))
        )
    );
  await expect.poll(count).toBe(1);
  await settle(0);
  await expect(boundary).toBeInViewport();
  await expect.poll(count).toBe(2);
  await settle(1);
  await expect(section.locator('tbody tr.el-table__row')).toHaveCount(40);
  await expect(boundary).toBeInViewport();
  await drainObservers();
  expect(await count()).toBe(2);

  await section.locator('.resource-filters input').first().fill('Node');
  await expect.poll(count).toBe(3);
  await settle(2);
  await expect(boundary).toBeInViewport();
  await expect.poll(count).toBe(4);
  const calls = await page.evaluate(() => window.managementPageFixture.calls());
  expect(new URL(calls[3]!, 'http://fixture').searchParams.get('page')).toBe('2');
  await settle(3);
  await expect(section.locator('tbody tr.el-table__row')).toHaveCount(40);
  await expect(boundary).toBeInViewport();
  await drainObservers();
  expect(await count()).toBe(4);
});
