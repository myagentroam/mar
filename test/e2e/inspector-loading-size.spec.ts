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
      let holdChanges = false;
      let failChanges = false;
      let failHistory = true;
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
        else if (path.endsWith('/git/fetch'))
          await route.fulfill({ json: { fetchFailed: false, updated: false } });
        else await route.fulfill({ json: { files: { entries: [], nextCursor: null } } });
      });
      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&git-previews=1`);
      const inspector = page.getByRole('region', { name: 'Inspector fixture' });
      await inspector.getByRole('tab', { name: 'Git Changes', exact: true }).click();
      const fileName = inspector.locator('.change-file-name');
      await expect(fileName).toHaveText('main.ts');
      const fontSize = await fileName.evaluate((element) => getComputedStyle(element).fontSize);

      holdChanges = true;
      await inspector.getByRole('button', { name: 'Refresh Git changes', exact: true }).click();
      await expectLoadingSize(inspector.locator('.change-append-state[role="status"]'), fontSize);
      await inspector.screenshot({ path: testInfo.outputPath('git-changes-loading.png') });
      failChanges = true;
      await expect.poll(() => changesReads).toBe(2);
      releaseChanges?.();
      const changesRetry = inspector.locator('.change-append-state button');
      await expect(changesRetry).toHaveText('Failed to load. Retry');
      await expect(changesRetry).toHaveClass(/is-link/);
      await expect(changesRetry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await changesRetry.hover();
      await expect(changesRetry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect.soft(changesRetry).toHaveCSS('font-size', fontSize);
      failChanges = false;
      await changesRetry.click();
      await expectLoadingSize(changesRetry, fontSize);
      await expect.poll(() => changesReads).toBe(3);
      releaseChanges?.();
      await expect(changesRetry).toHaveCount(0);

      await inspector.getByRole('tab', { name: 'Git History', exact: true }).click();
      await expectLoadingSize(inspector.locator('.history-load-more[role="status"]'), fontSize);
      await inspector.screenshot({ path: testInfo.outputPath('git-history-loading.png') });
      await expect.poll(() => historyReads).toBe(1);
      releaseHistory?.();
      const historyRetry = inspector.locator('button.history-load-more');
      await expect(historyRetry).toHaveText('Failed to load. Retry');
      await expect(historyRetry).toHaveClass(/is-link/);
      await expect(historyRetry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await historyRetry.hover();
      await expect(historyRetry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect.soft(historyRetry).toHaveCSS('font-size', fontSize);
      failHistory = false;
      await historyRetry.click();
      await expectLoadingSize(historyRetry, fontSize);
      await expect.poll(() => historyReads).toBe(2);
      releaseHistory?.();
      await expect(historyRetry).toHaveCount(0);
    });
  }
}
