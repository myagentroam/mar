import { expect, test, type Locator } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/inspector-read-state.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

async function expectReadableState(button: Locator) {
  await expect(button).toBeVisible();
  const layout = await button.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.fontSize = 'var(--mar-font-size-meta)';
    element.parentElement!.append(probe);
    const metaSize = getComputedStyle(probe).fontSize;
    probe.remove();
    const range = document.createRange();
    range.selectNodeContents(element.querySelector('span') ?? element);
    const text = range.getBoundingClientRect();
    const button = element.getBoundingClientRect();
    return {
      fontSize: getComputedStyle(element).fontSize,
      metaSize,
      left: text.left - button.left,
      right: button.right - text.right,
      textWidth: text.width
    };
  });
  expect(layout.fontSize).toBe(layout.metaSize);
  expect(layout.textWidth).toBeGreaterThan(0);
  expect(layout.left).toBeGreaterThanOrEqual(-1);
  expect(layout.right).toBeGreaterThanOrEqual(-1);
  await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await button.hover();
  await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  for (const width of [1280, 390]) {
    test(`Inspector read feedback keeps text, indentation and neutral actions: ${theme} ${width}`, async ({
      browser
    }, testInfo) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        hasTouch: width === 390,
        isMobile: width === 390
      });
      const page = await context.newPage();
      try {
        for (const locale of ['en-US', 'zh-CN']) {
          let recovering = false;
          let finish!: () => void;
          const recovery = new Promise<void>((resolve) => {
            finish = resolve;
          });
          await page.unrouteAll({ behavior: 'wait' });
          await page.route('**/api/**', async (route) => {
            if (!recovering) {
              await route.fulfill({
                status: 503,
                json: { code: 'NODE_OFFLINE', message: 'Node offline' }
              });
              return;
            }
            await recovery;
            const path = new URL(route.request().url()).pathname;
            const value = path.includes('/fixture/files')
              ? { entries: [], nextCursor: null }
              : path.endsWith('/content/search')
                ? { search: { matches: [], truncated: false } }
                : path.endsWith('/git/refs')
                  ? { refs: [] }
                  : path.endsWith('/git/history')
                    ? { commits: [], nextCursor: null }
                    : path.endsWith('/files')
                      ? { files: [] }
                      : {};
            await route.fulfill({ json: value });
          });
          await page.goto(
            `${fixture.url}inspector-read-state.html?theme=${theme}&locale=${locale}`
          );
          const files = page.getByTestId('Files');
          for (const [panel, toolbarSelector] of [
            [files, '.explorer-toolbar'],
            [page.getByTestId('Search'), '.content-search-toolbar']
          ] as const) {
            const toolbar = panel.locator(toolbarSelector);
            const input = await toolbar.locator('.el-input__wrapper').boundingBox();
            const action = await toolbar.locator('button').last().boundingBox();
            const bounds = await toolbar.boundingBox();
            expect(input!.x - bounds!.x).toBeGreaterThanOrEqual(6);
            expect(bounds!.x + bounds!.width - action!.x - action!.width).toBeGreaterThanOrEqual(6);
            expect(bounds!.y + bounds!.height - input!.y - input!.height).toBeGreaterThanOrEqual(6);
            await toolbar.getByRole('textbox').fill('workspace');
            await toolbar.getByRole('textbox').focus();
            await expect(toolbar.getByRole('textbox')).toBeFocused();
          }
          const searchPanel = page.getByTestId('Search').locator('.content-search');
          const searchBounds = await searchPanel.boundingBox();
          const checkbox = await searchPanel.locator('.el-checkbox').boundingBox();
          const searchInput = await searchPanel.locator('.el-input__wrapper').boundingBox();
          expect(checkbox!.x - searchBounds!.x).toBeGreaterThanOrEqual(6);
          expect(checkbox!.y - searchBounds!.y).toBeGreaterThanOrEqual(6);
          expect(Math.abs(checkbox!.x - searchInput!.x)).toBeLessThanOrEqual(1);
          const filesBounds = await files.locator('.file-explorer').boundingBox();
          const filter = files.locator('.file-display-filter input');
          const filterBounds = await filter.boundingBox();
          expect(filterBounds!.y - filesBounds!.y).toBeGreaterThanOrEqual(6);
          await filter.clear();
          await files.screenshot({ path: testInfo.outputPath(`files-toolbar-${locale}.png`) });
          await searchPanel.screenshot({
            path: testInfo.outputPath(`search-toolbar-${locale}.png`)
          });
          const nestedRetry = files.locator('.file-tree-load-more button').first();
          await expectReadableState(nestedRetry);
          const retries = files.locator('.file-tree-load-more button');
          for (const [index, path] of ['src/nested/existing.ts', 'src/existing.ts'].entries()) {
            const label = files.locator(`[data-file-path="${path}"] .tree-name`);
            const textLeft = await retries
              .nth(index)
              .locator('span')
              .evaluate((element) => {
                const range = document.createRange();
                range.selectNodeContents(element);
                return range.getBoundingClientRect().x;
              });
            expect(Math.abs(textLeft - (await label.boundingBox())!.x)).toBeLessThanOrEqual(1);
          }
          const search = page.getByTestId('Search').locator('button.watch-status');
          const changes = page.getByTestId('Git Changes').locator('.change-append-state button');
          const history = page.getByTestId('Git History').locator('button.history-load-more');
          const commitFiles = page.getByTestId('Commit files');
          await commitFiles.locator('.history-commit-row').click();
          const commitRetry = commitFiles.locator('.history-files .empty button');
          for (const button of [search, changes, history, commitRetry])
            await expectReadableState(button);
          await page.screenshot({
            path: testInfo.outputPath(`inspector-errors-${locale}.png`),
            fullPage: true
          });

          recovering = true;
          for (const button of [nestedRetry, search, changes, history, commitRetry]) {
            await button.click();
            await expect(button).toHaveAttribute('aria-busy', 'true');
            await expectReadableState(button);
            await expect(button.locator('[data-mar-icon="loading-action"]')).toBeVisible();
          }
          finish();
          for (const button of [search, changes, history, commitRetry])
            await expect(button).toHaveCount(0);
          await expect(retries).toHaveCount(1);
          await retries.click();
          await expect(retries).toHaveCount(0);

          await page.getByRole('button', { name: 'Fail Files Watch', exact: true }).click();
          const watchRetry = files.locator('button.watch-status');
          await expectReadableState(watchRetry);
          await watchRetry.click();
          await expect(watchRetry).toHaveCount(0);
          await page.getByRole('button', { name: 'Fail Files refresh', exact: true }).click();
          const refreshRetry = files.locator('button.watch-status');
          await expectReadableState(refreshRetry);
          await refreshRetry.click();
          await expect(refreshRetry).toHaveCount(0);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
          ).toBeLessThanOrEqual(1);
        }
      } finally {
        await context.close();
      }
    });
  }
}
