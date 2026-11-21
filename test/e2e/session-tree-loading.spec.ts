import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resolvedColorToHex } from '../../packages/web-core/src/util/theme-palette.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

// @test-covers packages/web-core/src/view/workspace/WorkspaceSessionTreePopover.vue

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
  await expect(tree.locator('.mar-ui-loading')).toHaveCount(0);
  await expect(page.locator('.mar-ui-loading, [data-loading-overlay]')).toHaveCount(0);
  await expect(dialog.locator('.session-tree-header')).toBeVisible();
  await expect(popover).toBeVisible();
  await expect(popover).toHaveCSS('opacity', '1');
  await expect(popover).toHaveCSS('border-top-width', '1px');
  await expect(popover).toHaveCSS(
    'border-top-color',
    theme === 'dark' ? 'rgb(65, 78, 98)' : 'rgb(203, 214, 228)'
  );
  await expect(popover).toHaveCSS('box-shadow', /0px 10px 24px/u);
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

test('the teleported tree follows a custom floating surface and outline', async ({ page }) => {
  const { tree } = await openTree(page, 'dark', 1280);
  await page.locator('html').evaluate((element: HTMLElement) => {
    element.style.setProperty('--mar-control-bg-color-overlay', '#25364940');
    element.style.setProperty('--mar-overlay-border', '#6b8199');
  });
  const popover = page.locator('.session-tree-popover');
  const background = (selector: typeof popover) =>
    selector.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(resolvedColorToHex(await background(popover))).toBe('#253649');
  await expect(popover).toHaveCSS('border-top-color', 'rgb(107, 129, 153)');
  await setFixtureState(page, 'ready');
  const row = tree.locator('.session-tree-row').filter({ hasText: 'Sleeping newer' });
  await row.hover();
  await row.locator('.session-tree-actions').click();
  const menu = page.getByRole('menu').and(page.locator('.session-tree-menu'));
  await expect(menu).toBeVisible();
  expect(resolvedColorToHex(await background(menu))).toBe('#253649');
  await expect(menu).toHaveCSS('border-top-color', 'rgb(107, 129, 153)');
  await expect(menu).toHaveCSS('box-shadow', /0px 4px 12px/u);
  await expect(menu.locator('.mar-ui-dropdown-item--divided')).toHaveCSS(
    'border-top-color',
    'rgb(47, 57, 73)'
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

test('retries a failed tree read, reaches ready, and closes on Escape', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { dialog, tree } = await openTree(page, 'dark', 390);
  await setFixtureState(page, 'fail');
  const error = tree.getByRole('status');
  await expect(error).toBeVisible();
  const retry = error.getByRole('button');
  await expect(retry).toBeVisible();
  await expect(retry).toHaveCSS(
    'font-size',
    await error.evaluate((element) => getComputedStyle(element).fontSize)
  );
  await expect(retry).toHaveCSS('border-top-width', '0px');
  await page.screenshot({
    path: info.outputPath('session-tree-failed.png'),
    animations: 'disabled'
  });
  const retryBounds = await retry.boundingBox();
  expect(retryBounds).not.toBeNull();
  await retry.click();
  await expect(page.getByTestId('retry-count')).toHaveText('1');
  await expect(tree).toHaveAttribute('aria-busy', 'true');
  const busyRetry = tree.getByRole('button', { name: 'Loading', exact: true });
  const ring = busyRetry.locator('.mar-read-loading-indicator');
  await expect(busyRetry).toBeFocused();
  await expect(busyRetry).toHaveAttribute('aria-busy', 'true');
  await expect(ring).toBeVisible();
  await expect.poll(() => busyRetry.boundingBox()).toEqual(retryBounds);
  const ringBounds = (await ring.boundingBox())!;
  expect(
    Math.abs(ringBounds.x + ringBounds.width / 2 - (retryBounds!.x + retryBounds!.width / 2))
  ).toBeLessThan(1);
  expect(
    Math.abs(ringBounds.y + ringBounds.height / 2 - (retryBounds!.y + retryBounds!.height / 2))
  ).toBeLessThan(1);
  await expect(error.getByText('Session tree synchronization is unavailable.')).toBeHidden();
  await expect(tree.locator('.mar-busy-indicator')).toHaveCount(1);
  await page.screenshot({
    path: info.outputPath('session-tree-retrying.png'),
    animations: 'disabled'
  });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('retry-count')).toHaveText('1');
  await setFixtureState(page, 'fail');
  await expect(retry).toBeFocused();
  await expect(retry).not.toHaveAttribute('aria-busy', 'true');
  await retry.click();
  await expect(page.getByTestId('retry-count')).toHaveText('2');
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
  await expect(tree.locator('.session-tree-actions')).toHaveCount(0);
  await expect(row.getByRole('button', { name: /more actions/i })).toHaveCount(0);
  const restingWidth = await row.locator('.session-tree-node').evaluate((node) => node.clientWidth);
  await row.hover();
  await expect(action).toBeVisible();
  expect(await row.locator('.session-tree-node').evaluate((node) => node.clientWidth)).toBeLessThan(
    restingWidth
  );
  await page.mouse.move(0, 0);
  await expect(action).toHaveCount(0);
  await row.locator('.session-tree-node').focus();
  await expect(action).toBeVisible();
  await action.focus();
  await page.mouse.move(0, 0);
  await expect(action).toBeVisible();
  await action.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem').first().focus();
  await page.mouse.move(0, 0);
  await expect(action).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(action).toBeFocused();
  await page.getByTestId('tree-anchor').focus();
  await expect(tree.locator('.session-tree-actions')).toHaveCount(0);
});

test('includes the action button in the selected row surface', async ({ page }, testInfo) => {
  const { tree } = await openTree(page, 'dark', 1280);
  await setFixtureState(page, 'ready');
  const row = tree
    .locator('.session-tree-row')
    .filter({ has: page.locator('[aria-current="true"]') });
  await row.hover();
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
  await expect(action).toHaveCount(0);
  await parent.locator('.session-tree-node').focus();
  await page.keyboard.press('Tab');
  await expect(action).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('mounts context actions before opening either parent or descendant menus', async ({
  page
}) => {
  await page.goto(`${fixture.url}session-tree-loading.html?theme=dark&parent=1`);
  await setFixtureState(page, 'ready');
  for (const selector of ['.session-tree-parent', '.session-tree-row']) {
    const row = page.locator(selector).first();
    await page.mouse.move(0, 0);
    await page.getByTestId('tree-anchor').focus();
    await expect(row.locator('.session-tree-actions')).toHaveCount(0);
    await row.dispatchEvent('contextmenu');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
    await expect(row.locator('.session-tree-node')).toBeFocused();
    await page.getByTestId('tree-anchor').focus();
    await expect(page.locator('.session-tree-actions')).toHaveCount(0);
  }
});

test('releases keyboard context actions after closing the menu and leaving the row', async ({
  page
}) => {
  await page.goto(`${fixture.url}session-tree-loading.html?theme=dark&parent=1`);
  await setFixtureState(page, 'ready');
  for (const selector of ['.session-tree-parent', '.session-tree-row']) {
    const row = page.locator(selector).first();
    await page.mouse.move(0, 0);
    await page.getByTestId('tree-anchor').focus();
    await expect(row.locator('.session-tree-actions')).toHaveCount(0);
    await row.locator('.session-tree-node').focus();
    await row.dispatchEvent('contextmenu');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
    await expect(row.locator('.session-tree-node')).toBeFocused();
    await page.getByTestId('tree-anchor').focus();
    await expect(page.locator('.session-tree-actions')).toHaveCount(0);
  }
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
