import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;

test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/session-tree-loading.html');
});

test.afterAll(async () => {
  await fixture?.close();
});

async function openTree(page: Page, theme: 'dark' | 'daylight', width: number) {
  await page.setViewportSize({ width, height: 850 });
  await page.goto(`${fixture.url}session-tree-loading.html?theme=${theme}`);
  const dialog = page.getByRole('dialog', { name: 'View session tree', exact: true });
  await expect(dialog).toBeVisible();
  return { dialog, tree: dialog.locator('.session-tree') };
}

async function setFixtureState(page: Page, state: 'ready' | 'fail') {
  await page.evaluate((nextState) => {
    const controller = (
      window as Window & { sessionTreeLoadingFixture: { ready: () => void; fail: () => void } }
    ).sessionTreeLoadingFixture;
    controller[nextState]();
  }, state);
}

async function expectUnmaskedLoading(
  page: Page,
  testInfo: TestInfo,
  theme: 'dark' | 'daylight',
  width: number,
  screenshot: string
) {
  const popover = page.locator('.session-tree-popover');
  const { dialog, tree } = await openTree(page, theme, width);
  await expect(tree).toHaveAttribute('aria-busy', 'true');
  const loading = tree.locator('.session-tree-loading');
  await expect(loading).toHaveAttribute('role', 'status');
  await expect(loading).toHaveAttribute('aria-label', /Loading/);
  await expect(loading.locator('.busy-indicator.read-loading-indicator')).toBeVisible();
  await expect(tree.locator('.el-loading-mask')).toHaveCount(0);
  await expect(page.locator('.el-loading-mask, .el-overlay, [data-loading-overlay]')).toHaveCount(
    0
  );
  await expect(dialog.locator('.session-tree-header')).toBeVisible();
  await expect(popover).toBeVisible();
  await expect(popover).toHaveCSS('opacity', '1');
  const loadingSurface = await popover.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      color: style.color,
      borderColor: style.borderColor
    };
  });
  expect(loadingSurface.background).not.toBe('rgba(0, 0, 0, 0)');
  await page.screenshot({ path: testInfo.outputPath(screenshot), animations: 'disabled' });
  await setFixtureState(page, 'ready');
  await expect(tree).toHaveAttribute('aria-busy', 'false');
  await expect(tree.locator('.session-tree-row')).toHaveCount(100);
  const readySurface = await popover.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      color: style.color,
      borderColor: style.borderColor
    };
  });
  expect(loadingSurface).toEqual(readySurface);
}

test('keeps the loading ring local on a dark desktop popover', async ({ page }, testInfo) => {
  await expectUnmaskedLoading(
    page,
    testInfo,
    'dark',
    1280,
    'session-tree-loading-dark-desktop.png'
  );
});

test('keeps the loading ring local on a daylight mobile popover', async ({ page }, testInfo) => {
  await expectUnmaskedLoading(
    page,
    testInfo,
    'daylight',
    390,
    'session-tree-loading-daylight-mobile.png'
  );
});

test('preserves Node sibling order for 100 returned rows, including an active idle branch', async ({
  page
}) => {
  const { tree } = await openTree(page, 'daylight', 1280);
  await setFixtureState(page, 'ready');
  const titles = await tree.locator('.session-tree-title').allTextContents();
  expect(titles).toHaveLength(100);
  expect(titles.slice(0, 4)).toEqual([
    'Sleeping newer',
    'Running older',
    'Idle ancestor',
    'Active child'
  ]);
  expect(titles.at(-1)).toBe('Idle 095');
});

test('retries a failed tree read, reaches ready, and closes on Escape', async ({ page }) => {
  const { dialog, tree } = await openTree(page, 'dark', 390);
  await setFixtureState(page, 'fail');
  const error = tree.getByRole('status');
  await expect(error).toBeVisible();
  const retry = error.getByRole('button');
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(page.getByTestId('retry-count')).toHaveText('1');
  await expect(tree).toHaveAttribute('aria-busy', 'true');
  await expect(tree.locator('.session-tree-loading .busy-indicator')).toBeVisible();
  await setFixtureState(page, 'ready');
  await expect(tree.locator('.session-tree-row')).toHaveCount(100);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('close-restored-focus')).toHaveText('true');
  await expect(page.getByTestId('tree-anchor')).toBeFocused();
});
