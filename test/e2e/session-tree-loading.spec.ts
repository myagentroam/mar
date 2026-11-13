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
  await expect(loading.locator('.mar-busy-indicator.mar-read-loading-indicator')).toBeVisible();
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
  await expect(tree.locator('.session-tree-loading .mar-busy-indicator')).toBeVisible();
  await setFixtureState(page, 'ready');
  await expect(tree.locator('.session-tree-row')).toHaveCount(100);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('close-restored-focus')).toHaveText('true');
  await expect(page.getByTestId('tree-anchor')).toBeFocused();
});

test('keeps mobile popovers inside equal viewport gutters', async ({ page }, testInfo) => {
  for (const width of [320, 390, 440]) {
    await openTree(page, 'dark', width);
    const popover = page.locator('.session-tree-popover');
    await expect(popover).toHaveCSS('opacity', '1');
    await expect
      .poll(async () => {
        const box = await popover.boundingBox();
        return box ? [Math.round(box.x), Math.round(width - box.x - box.width)] : [];
      })
      .toEqual([12, 12]);
    await setFixtureState(page, 'ready');
    await expect
      .poll(async () => {
        const box = await popover.boundingBox();
        return box ? [Math.round(box.x), Math.round(width - box.x - box.width)] : [];
      })
      .toEqual([12, 12]);
    if (width === 390)
      await page.screenshot({
        path: testInfo.outputPath('mobile-tree-gutters.png'),
        animations: 'disabled'
      });
  }
});

test('reveals row actions on hover, focus, and while its menu is open', async ({ page }) => {
  const { tree } = await openTree(page, 'daylight', 1280);
  await setFixtureState(page, 'ready');
  const row = tree.locator('.session-tree-row').first();
  const action = row.getByRole('button', { name: 'Session actions' });
  await page.mouse.move(0, 0);
  await expect(action).toHaveCSS('opacity', '0');
  await row.hover();
  await expect(action).toHaveCSS('opacity', '1');
  await action.focus();
  await page.mouse.move(0, 0);
  await expect(action).toHaveCSS('opacity', '1');
  await action.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem').first().focus();
  await page.mouse.move(0, 0);
  await expect(action).toHaveCSS('opacity', '1');
});

test('includes the action button in the selected row surface', async ({ page }, testInfo) => {
  const { tree } = await openTree(page, 'dark', 1280);
  await setFixtureState(page, 'ready');
  const row = tree
    .locator('.session-tree-row')
    .filter({ has: page.locator('[aria-current="true"]') });
  const action = row.locator('.session-tree-actions');
  const surfaceContainsAction = await action.evaluate((element) => {
    const action = element.getBoundingClientRect();
    for (
      let parent = element.parentElement;
      parent && !parent.classList.contains('session-tree-row');
      parent = parent.parentElement
    ) {
      const color = getComputedStyle(parent).backgroundColor;
      if (color === 'transparent' || color === 'rgba(0, 0, 0, 0)') continue;
      const surface = parent.getBoundingClientRect();
      return (
        surface.left <= action.left &&
        surface.right >= action.right &&
        surface.top <= action.top &&
        surface.bottom >= action.bottom
      );
    }
    return false;
  });
  expect(surfaceContainsAction).toBe(true);
  await row.hover();
  await page.screenshot({
    path: testInfo.outputPath('selected-tree-actions.png'),
    animations: 'disabled'
  });
});

test('keeps parent context actions reachable with the keyboard', async ({ page }) => {
  await page.goto(`${fixture.url}session-tree-loading.html?theme=dark&parent=1`);
  await setFixtureState(page, 'ready');
  const parent = page.locator('.session-tree-parent');
  const action = parent.getByRole('button', { name: 'Session actions' });
  await page.mouse.move(0, 0);
  await expect(action).toHaveCSS('opacity', '0');
  await action.focus();
  await expect(action).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test.describe('touch input', () => {
  test.use({ hasTouch: true });
  test('keeps row actions available without hover', async ({ page }) => {
    const { tree } = await openTree(page, 'daylight', 390);
    await setFixtureState(page, 'ready');
    const action = tree.locator('.session-tree-row').first().locator('.session-tree-actions');
    await expect(action).toHaveCSS('opacity', '1');
    await action.tap();
    await expect(page.getByRole('menu')).toBeVisible();
  });
});
