import { expect, test, type Page } from '@playwright/test';
import type {} from '../../packages/web-core/test/e2e/resource-details-app.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

async function settle(page: Page, path: string, value: unknown, fail = false) {
  await expect
    .poll(() => page.evaluate(() => window.resourceDetailsFixture.pending()))
    .toContain(path);
  await page.evaluate(
    ({ path, value, fail }) => window.resourceDetailsFixture.settle(path, value, fail),
    { path, value, fail }
  );
}
async function open(page: Page, label: string) {
  await page
    .locator('.resource-management-panel .el-table__body')
    .getByRole('cell', { name: label, exact: true })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
}
async function close(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

for (const outcome of ['success', 'failure'] as const) {
  test(`Workspace details stay closed after a late path ${outcome}`, async ({ page }) => {
    const fixture = await startCustomThemeFixture();
    try {
      await page.goto(`${fixture.url}resource-details.html`);
      await open(page, 'Workspace a');
      await close(page);
      await settle(
        page,
        '/api/workspaces?nodeId=a',
        { workspaces: [{ id: 'work-a', path: '/late/a' }] },
        outcome === 'failure'
      );
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } finally {
      await fixture.close();
    }
  });

  test(`Workspace details retain the current path after an old ${outcome}`, async ({ page }) => {
    const fixture = await startCustomThemeFixture();
    try {
      await page.goto(`${fixture.url}resource-details.html`);
      await open(page, 'Workspace a');
      await close(page);
      await open(page, 'Workspace b');
      await settle(page, '/api/workspaces?nodeId=b', {
        workspaces: [{ id: 'work-b', path: '/current/b' }]
      });
      await expect(page.getByRole('dialog')).toContainText('/current/b');
      await settle(
        page,
        '/api/workspaces?nodeId=a',
        { workspaces: [{ id: 'work-a', path: '/late/a' }] },
        outcome === 'failure'
      );
      await expect(page.getByRole('dialog')).toContainText('/current/b');
      await expect(page.getByRole('dialog')).not.toContainText('/late/a');
    } finally {
      await fixture.close();
    }
  });

  test(`Node usage controls retain current availability after an old ${outcome}`, async ({
    page
  }) => {
    const fixture = await startCustomThemeFixture();
    try {
      await page.goto(`${fixture.url}resource-details.html?kind=NODE`);
      await open(page, 'Node a');
      await expect
        .poll(() => page.evaluate(() => window.resourceDetailsFixture.pending()))
        .toContain('/api/runner-usage/status?nodeId=a');
      await close(page);
      await open(page, 'Node b');
      const usage = page.getByRole('dialog').getByRole('button', { name: 'Usage', exact: true });
      await expect(usage).toBeDisabled();
      await settle(page, '/api/runner-usage/status?nodeId=b', {
        statuses: [{ runner: 'codex', available: true }]
      });
      await expect(usage).toBeEnabled();
      await settle(
        page,
        '/api/runner-usage/status?nodeId=a',
        { statuses: [{ runner: 'codex', available: false }] },
        outcome === 'failure'
      );
      await expect(page.getByRole('dialog')).toContainText('Node b');
      await expect(usage).toBeEnabled();
      await usage.click();
      await expect
        .poll(() => page.evaluate(() => window.resourceDetailsFixture.pending()))
        .toContain('/api/runner-usage?nodeId=b&runner=codex');
      await close(page);
      await open(page, 'Node a');
      await expect(usage).toBeDisabled();
      await settle(
        page,
        '/api/runner-usage?nodeId=b&runner=codex',
        { usage: { runner: 'codex', windows: [], fetchedAt: 1, cached: false } },
        outcome === 'failure'
      );
      await expect(page.getByRole('dialog')).toHaveCount(1);
      await expect(page.locator('.el-message--error')).toHaveCount(0);
      await settle(page, '/api/runner-usage/status?nodeId=a', {
        statuses: [{ runner: 'codex', available: true }]
      });
      await expect(usage).toBeEnabled();
      await usage.click();
      await settle(page, '/api/runner-usage?nodeId=a&runner=codex', {
        usage: {
          runner: 'codex',
          windows: [{ id: 'current', label: 'Current window', usedPercentage: 37, resetsAt: null }],
          fetchedAt: 2,
          cached: false
        }
      });
      await expect(page.getByRole('dialog')).toHaveCount(2);
      await expect(page.getByRole('dialog').filter({ hasText: 'Current window' })).toContainText(
        '37%'
      );
    } finally {
      await fixture.close();
    }
  });
}
