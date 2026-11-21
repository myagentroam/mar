import { expect, test, type Locator } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/workbench-style.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

async function expectLoadingSize(status: Locator, fontSize: string) {
  await expect(status).toBeVisible();
  await expect(status.locator('[data-mar-icon="loading-action"]')).toBeVisible();
  const sizes = await status.evaluate((element) => {
    const icon = element.querySelector('[data-mar-icon="loading-action"]')!;
    return {
      fontSize: getComputedStyle(element).fontSize,
      iconWidth: getComputedStyle(icon).width,
      iconHeight: getComputedStyle(icon).height
    };
  });
  expect.soft(sizes).toEqual({ fontSize, iconWidth: fontSize, iconHeight: fontSize });
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  for (const width of [1280, 390]) {
    test(`Git loading shares list text and icon sizes in ${theme} at ${width}px`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      let holdChanges = true;
      let failChanges = false;
      let emptyChanges = false;
      let failHistory = true;
      let failHistoryFetch = true;
      let changesReads = 0;
      let historyReads = 0;
      let releaseChanges: (() => void) | undefined;
      let releaseHistory: (() => void) | undefined;
      const entry = {
        repositoryPath: '',
        repositoryName: 'root',
        source: 'ROOT',
        path: 'src/main.ts',
        state: 'UNSTAGED',
        change: 'MODIFIED',
        diffAvailable: true
      };
      await page.route('**/api/workspaces/workspace/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/changes')) {
          changesReads += 1;
          if (holdChanges)
            await new Promise<void>((resolve) => {
              releaseChanges = resolve;
            });
          if (failChanges)
            await route.fulfill({
              status: 503,
              json: { error: { code: 'NODE_OFFLINE', message: 'Offline' } }
            });
          else if (emptyChanges) await route.fulfill({ json: { changes: [], repositories: [] } });
          else
            await route.fulfill({
              json: {
                changes: [entry],
                repositories: [
                  {
                    repositoryPath: '',
                    repositoryName: 'root',
                    source: 'ROOT',
                    current: true,
                    status: 'DIRTY',
                    changes: [entry]
                  }
                ]
              }
            });
        } else if (path.endsWith('/git/history')) {
          historyReads += 1;
          await new Promise<void>((resolve) => {
            releaseHistory = resolve;
          });
          if (failHistory)
            await route.fulfill({
              status: 503,
              json: { error: { code: 'NODE_OFFLINE', message: 'Offline' } }
            });
          else await route.fulfill({ json: { commits: [], nextCursor: null } });
        } else if (path.endsWith('/git/refs')) await route.fulfill({ json: { refs: [] } });
        else if (path.endsWith('/git/fetch')) {
          const body = route.request().postDataJSON() as { repositoryPath?: string };
          await route.fulfill({
            json: {
              fetchFailed: body.repositoryPath !== undefined && failHistoryFetch,
              updated: false
            }
          });
        } else await route.fulfill({ json: { files: { entries: [], nextCursor: null } } });
      });
      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&git-previews=1`);
      const inspector = page.getByRole('region', { name: 'Inspector fixture' });
      await inspector.getByRole('tab', { name: 'Git Changes', exact: true }).click();
      const firstRead = inspector.locator('.changes-read-state.mar-region-status--center');
      await expect(firstRead.locator('[data-mar-icon="loading-action"]')).toBeVisible();
      await inspector.screenshot({ path: testInfo.outputPath('git-changes-initial.png') });
      await expect.poll(() => changesReads).toBe(1);
      releaseChanges?.();
      const fileName = inspector.locator('.change-file-name');
      await expect(fileName).toHaveText('main.ts');
      const fontSize = await fileName.evaluate((element) => getComputedStyle(element).fontSize);

      holdChanges = true;
      const changesRefresh = inspector.getByRole('button', {
        name: 'Refresh Git changes',
        exact: true
      });
      await changesRefresh.click();
      await expect(changesRefresh).toBeDisabled();
      await expect(changesRefresh.locator('[data-mar-icon="loading-action"]')).toHaveCSS(
        'width',
        '14px'
      );
      await expect(inspector.locator('.changes-read-state')).toHaveCount(0);
      await inspector.screenshot({ path: testInfo.outputPath('git-changes-loading.png') });
      failChanges = true;
      await expect.poll(() => changesReads).toBe(2);
      releaseChanges?.();
      await expect(changesRefresh).toBeEnabled();
      await expect(fileName).toHaveText('main.ts');
      await expect(inspector.locator('.changes-read-state')).toHaveCount(0);
      await inspector.screenshot({ path: testInfo.outputPath('git-changes-refresh-failed.png') });
      failChanges = false;
      await changesRefresh.click();
      await expect(changesRefresh).toBeDisabled();
      await expect(inspector.locator('.changes-read-state')).toHaveCount(0);
      await expect.poll(() => changesReads).toBe(3);
      releaseChanges?.();
      await expect(changesRefresh).toBeEnabled();

      await inspector.getByRole('tab', { name: 'Git History', exact: true }).click();
      await expectLoadingSize(inspector.locator('.history-load-more[role="status"]'), fontSize);
      const fetchNotice = inspector.locator('.git-fetch-notice');
      await expect.poll(() => historyReads).toBe(1);
      await expect(fetchNotice).toHaveCount(0);
      await inspector.screenshot({ path: testInfo.outputPath('git-history-loading.png') });
      releaseHistory?.();
      const historyRetry = inspector.locator('button.history-load-more');
      await expect(historyRetry).toHaveText('Failed to load. Retry');
      await expect(fetchNotice).toHaveCount(0);
      await expect(historyRetry).toHaveClass(/mar-ui-button--inline/);
      await expect(historyRetry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await historyRetry.hover();
      await expect(historyRetry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect.soft(historyRetry).toHaveCSS('font-size', fontSize);
      await inspector.screenshot({ path: testInfo.outputPath('git-history-failed.png') });
      failHistory = false;
      await historyRetry.click();
      await expectLoadingSize(historyRetry, fontSize);
      await inspector.screenshot({ path: testInfo.outputPath('git-history-retrying.png') });
      await expect.poll(() => historyReads).toBe(2);
      releaseHistory?.();
      await expect(historyRetry).toHaveCount(0);
      await expect(inspector.locator('.git-history .mar-region-status')).toHaveText(
        'No Git commit history.'
      );
      await expect(fetchNotice).toHaveAttribute('role', 'alert');
      await inspector.screenshot({
        path: testInfo.outputPath('git-history-local-empty-warning.png')
      });
      failHistoryFetch = false;
      await inspector.getByRole('button', { name: 'Refresh Git history', exact: true }).click();
      await expect.poll(() => historyReads).toBe(3);
      releaseHistory?.();
      await expect(fetchNotice).toHaveCount(0);
      await expect(inspector.locator('.git-history .mar-region-status')).toHaveText(
        'No Git commit history.'
      );
      await inspector.screenshot({ path: testInfo.outputPath('git-history-empty.png') });
      emptyChanges = true;
      holdChanges = false;
      await inspector.getByRole('tab', { name: 'Git Changes', exact: true }).click();
      await expect.poll(() => changesReads).toBe(4);
      await expect(
        inspector.locator('.changes-empty:not(.mar-region-status--center)')
      ).toBeVisible();
      await inspector.screenshot({ path: testInfo.outputPath('git-changes-empty.png') });
    });
  }
}
