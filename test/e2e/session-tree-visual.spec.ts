import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/session-*.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

test('tree popover keeps one snapshot, orders active branches and closes by keyboard and outside click', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.goto(`${fixture.url}session-tree.html?locale=en-US&mixed=1`);
  const trigger = page.getByRole('button', { name: 'View session tree' });
  await trigger.hover();
  const tree = page.getByRole('dialog', { name: 'View session tree' });
  await expect(tree).toBeVisible();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(page.getByTestId('requests')).toHaveText('1');
  await tree.hover({ position: { x: 2, y: 2 } });
  await expect(tree.locator('.session-tree-node')).toHaveText([
    'RootIdle',
    'Running branchRunning',
    'Sleeping branchSleeping',
    'Idle branchIdle',
    'Active descendantRunning',
    'Idle leafIdle',
    'Idle leaf twoIdle'
  ]);
  await expect(tree.locator('.session-tree-status.el-tag')).toHaveCount(7);
  await expect(tree.locator('.session-tree-status.el-tag--success')).toHaveText([
    'Running',
    'Running'
  ]);
  await expect(tree.locator('.session-tree-status.el-tag--info')).toHaveText([
    'Idle',
    'Sleeping',
    'Idle',
    'Idle',
    'Idle'
  ]);
  await trigger.click();
  await expect(page.getByTestId('requests')).toHaveText('1');
  await page.keyboard.press('Escape');
  await expect(tree).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('requests')).toHaveText('2');
  await page.mouse.click(900, 700);
  await expect(tree).toHaveCount(0);
});

test('closing an in-flight snapshot aborts it and a failed snapshot can be reopened', async ({
  page
}) => {
  await page.goto(`${fixture.url}session-tree.html?locale=en-US&pending=1`);
  const trigger = page.getByRole('button', { name: 'View session tree' });
  await trigger.click();
  await expect(page.getByTestId('requests')).toHaveText('1');
  await trigger.click();
  await expect(page.getByTestId('aborts')).toHaveText('1');
  await page.goto(`${fixture.url}session-tree.html?locale=en-US&failure=1`);
  await trigger.click();
  await expect(page.getByText('tree unavailable')).toBeVisible();
  await trigger.click();
  await expect(page.getByTestId('requests')).toHaveText('2');
  await expect(
    page
      .getByRole('dialog', { name: 'View session tree' })
      .getByRole('button', { name: 'Verify image decoding and cleanup, Idle' })
  ).toBeVisible();
});

test('keyboard-opened list actions anchor the tree without a preceding mouse click', async ({
  page
}) => {
  await page.goto(`${fixture.url}session-groups.html?locale=en-US`);
  const chats = page.locator('.conversation-sidebar');
  await chats.getByRole('tab').nth(1).click();
  await chats.locator('.session-link').focus();
  const trigger = chats.locator('.session-more-button');
  await trigger.focus();
  await trigger.press('ArrowDown');
  const action = page.getByRole('menuitem', { name: 'View session tree', exact: true });
  await expect(action).toBeVisible();
  await action.focus();
  await action.press('Enter');
  const tree = page.getByRole('dialog', { name: 'View session tree' });
  await expect(tree).toBeVisible();
  await tree.getByRole('button', { name: 'Child collaboration, Idle' }).press('Enter');
  await expect(page.getByTestId('opened-tree-session')).toHaveText('child');
});

test('Escape returns keyboard focus from the tree to its title trigger', async ({ page }) => {
  await page.goto(`${fixture.url}session-tree.html?locale=en-US`);
  const trigger = page.getByRole('button', { name: 'View session tree' });
  await trigger.focus();
  await trigger.press('Enter');
  const tree = page.getByRole('dialog', { name: 'View session tree' });
  await tree.getByRole('button', { name: 'Verify image decoding and cleanup, Idle' }).focus();
  await page.keyboard.press('Escape');
  await expect(tree).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Escape closes a keyboard-opened tree before focus enters it', async ({ page }) => {
  await page.goto(`${fixture.url}session-tree.html?locale=en-US`);
  const trigger = page.getByRole('button', { name: 'View session tree' });
  await trigger.focus();
  await trigger.press('Enter');
  const tree = page.getByRole('dialog', { name: 'View session tree' });
  await expect(tree).toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(tree).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Escape dismisses a hover-only tree without moving keyboard focus', async ({ page }) => {
  await page.goto(`${fixture.url}session-tree.html?locale=en-US`);
  const trigger = page.getByRole('button', { name: 'View session tree' });
  await trigger.hover();
  const tree = page.getByRole('dialog', { name: 'View session tree' });
  await expect(tree).toBeVisible();
  await expect(trigger).not.toBeFocused();
  await page.keyboard.press('Escape');
  await expect(tree).toHaveCount(0);
  await expect(page.getByTestId('requests')).toHaveText('1');
});

test('Escape cancels a pending hover before any snapshot is requested', async ({ page }) => {
  await page.goto(`${fixture.url}session-tree.html?locale=en-US`);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const trigger = page.getByRole('button', { name: 'View session tree' });
  await trigger.dispatchEvent('pointerenter', { pointerType: 'mouse' });
  await page.keyboard.press('Escape');
  await page.clock.runFor(250);
  await expect(page.getByRole('dialog', { name: 'View session tree' })).toHaveCount(0);
  await expect(page.getByTestId('requests')).toHaveText('0');
});

test('a deep 100-node snapshot remains scrollable on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 600 });
  await page.goto(`${fixture.url}session-tree.html?locale=en-US&long=1`);
  await page.getByRole('button', { name: 'View session tree' }).click();
  const tree = page.locator('.session-tree');
  await expect(tree.locator('.session-tree-node')).toHaveCount(100);
  expect(
    await tree.evaluate(
      (el) => el.scrollHeight > el.clientHeight && el.scrollWidth > el.clientWidth
    )
  ).toBe(true);
  const last = tree.getByRole('button', { name: 'Node 99, Idle' });
  await last.scrollIntoViewIfNeeded();
  expect(
    await last.locator('.session-tree-title').evaluate((el) => el.getBoundingClientRect().width)
  ).toBeGreaterThan(20);
  await expect(last.locator('.session-tree-status')).toBeVisible();
});

test.describe('touch interaction', () => {
  test.use({ hasTouch: true });
  test('touch opens the anchored tree and mobile back closes it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 850 });
    await page.goto(`${fixture.url}session-tree.html?locale=en-US&rootOnly=1`);
    const trigger = page.getByRole('button', { name: 'View session tree' });
    await trigger.tap();
    const tree = page.getByRole('dialog', { name: 'View session tree' });
    await expect(tree).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.goBack();
    await expect(tree).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});

for (const width of [390, 1280]) {
  for (const theme of ['dark', 'daylight']) {
    test(`session tree controls at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 850 });
      const locale = theme === 'dark' ? 'en-US' : 'zh-CN';
      await page.goto(`${fixture.url}session-tree.html?theme=${theme}&locale=${locale}`);
      const trigger = page.getByRole('button', {
        name: locale === 'en-US' ? 'View session tree' : '查看会话树'
      });
      const treeIcon = trigger.locator('[data-mar-icon="session-tree"]');
      await expect(treeIcon).toBeVisible();
      await expect(trigger.locator('svg')).toHaveCount(1);
      await expect(treeIcon).toHaveAttribute('aria-hidden', 'true');
      await expect(treeIcon).toHaveCSS('animation-name', 'none');
      await expect(treeIcon).toHaveCSS(
        'stroke',
        await trigger.evaluate((el) => getComputedStyle(el).color)
      );
      await trigger.screenshot({ path: testInfo.outputPath(`tree-trigger-${width}-${theme}.png`) });
      await expect(trigger).toHaveCSS('border-top-width', '0px');
      await trigger.hover();
      await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await trigger.focus();
      await expect(trigger).toHaveCSS('outline-width', '2px');
      await trigger.press('Enter');
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const rows = dialog.locator('.session-tree-node');
      await expect(rows).toHaveCount(4);
      await expect(rows.locator('.session-tree-status.el-tag')).toHaveCount(4);
      const longTitle = rows.last().locator('.session-tree-title');
      await expect(rows.last()).toHaveAccessibleName(
        `${'Review upload boundary tests and verify image compatibility. '.repeat(6).trim()}, ${locale === 'en-US' ? 'Idle' : '空闲'}`
      );
      const titleSize = await longTitle.evaluate((element) => ({
        height: element.clientHeight,
        fullHeight: element.scrollHeight,
        lineHeight: parseFloat(getComputedStyle(element).lineHeight)
      }));
      expect(titleSize.height).toBeLessThanOrEqual(titleSize.lineHeight * 2 + 1);
      expect(titleSize.fullHeight).toBeGreaterThan(titleSize.height);
      await expect(rows.locator('[data-mar-icon="collection"]')).toHaveCount(0);
      const treeRows = dialog.locator('.session-tree-row');
      const childBranch = treeRows.nth(1).locator('.session-tree-branch');
      const ancestorBranch = treeRows.nth(2).locator('.session-tree-branch').first();
      const lastBranch = treeRows.nth(3).locator('.session-tree-branch');
      await expect(childBranch).toHaveCSS('border-inline-start-width', '1px');
      await expect(ancestorBranch).toHaveCSS('border-inline-start-width', '1px');
      await expect(lastBranch).toHaveCSS('border-inline-start-width', '0px');
      // Read both edges in one frame while the dialog entrance transition may be active.
      const [childLine, ancestorLine] = await treeRows.evaluateAll((elements) =>
        [elements[1]!, elements[2]!].map((element) => {
          const box = element.querySelector('.session-tree-branch')!.getBoundingClientRect();
          return { x: box.x, y: box.y, height: box.height };
        })
      );
      expect(ancestorLine!.x).toBe(childLine!.x);
      expect(Math.abs(childLine!.y + childLine!.height - ancestorLine!.y)).toBeLessThan(1);
      const connectorEdges = await treeRows.evaluateAll((elements) => {
        const origin = elements[0]!.querySelector('.session-tree-origin')!;
        const stem = elements[0]!.querySelector('.session-tree-origin-stem')!;
        const child = elements[1]!.querySelector('.session-tree-branch')!;
        const ancestor = elements[2]!.querySelector('.session-tree-branch')!;
        const grandchild = elements[2]!.querySelectorAll('.session-tree-branch')[1]!;
        const last = elements[3]!.querySelector('.session-tree-branch')!;
        const branchX = (element: Element) => element.getBoundingClientRect().left;
        const elbowX = (element: Element) =>
          branchX(element) +
          parseFloat(getComputedStyle(element).borderLeftWidth) +
          parseFloat(getComputedStyle(element, '::before').left);
        return {
          root: branchX(stem),
          rootElbow: elbowX(origin),
          rootCornerRadius: getComputedStyle(origin, '::before').borderEndStartRadius,
          continuing: branchX(child),
          continuingElbow: elbowX(child),
          ancestor: branchX(ancestor),
          grandchild: branchX(grandchild),
          grandchildElbow: elbowX(grandchild),
          lastElbow: elbowX(last)
        };
      });
      expect(connectorEdges.rootElbow).toBeCloseTo(connectorEdges.root, 1);
      expect(connectorEdges.rootCornerRadius).toBe('0px');
      expect(connectorEdges.continuing).toBeCloseTo(connectorEdges.root, 1);
      expect(connectorEdges.continuingElbow).toBeCloseTo(connectorEdges.continuing, 1);
      expect(connectorEdges.ancestor).toBeCloseTo(connectorEdges.continuing, 1);
      expect(connectorEdges.grandchildElbow).toBeCloseTo(connectorEdges.grandchild, 1);
      expect(connectorEdges.lastElbow).toBeCloseTo(connectorEdges.continuing, 1);
      const ending = await lastBranch.evaluate((element) => {
        const style = getComputedStyle(element, '::before');
        return {
          height: parseFloat(style.height),
          border: style.borderBottomWidth,
          parentHeight: element.clientHeight
        };
      });
      expect(ending.border).toBe('1px');
      expect(Math.abs(ending.height - ending.parentHeight / 2)).toBeLessThan(1);
      for (const row of await rows.all()) {
        await expect(row).not.toContainText(/mar-agent|codex/);
        await expect(row).toHaveCSS('border-top-width', '0px');
        expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      await rows.first().hover();
      await expect(rows.first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const current = dialog.locator('.session-tree-node[aria-current="true"]');
      await current.focus();
      await expect(current).toHaveCSS('outline-width', '2px');
      await expect(current).toContainText('Review BMP');
      await expect(current).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(current.locator('.session-tree-title')).toHaveCSS('font-weight', '600');
      await expect(rows.locator('[data-mar-icon]')).toHaveCount(0);
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.mouse.move(0, 0);
      await current.evaluate((element) => (element as HTMLElement).blur());
      await page.screenshot({
        path: testInfo.outputPath(`tree-${width}-${theme}.png`),
        fullPage: true
      });
      await current.evaluate((element) => {
        (element as HTMLElement).style.setProperty('--mar-color-brand-text', '#694198');
      });
      await current.hover();
      await expect(current).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(current.locator('.session-tree-title')).toHaveCSS('color', 'rgb(105, 65, 152)');
      await rows.first().press('Enter');
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('selected')).toHaveText('parent');
    });
  }
}

for (const theme of ['dark', 'daylight']) {
  test(`root-only session tree in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 850 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${fixture.url}session-tree.html?theme=${theme}&locale=zh-CN&rootOnly=1`);
    await page.getByRole('button', { name: '查看会话树' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.session-tree-node')).toHaveCount(1);
    await expect(dialog.locator('.session-tree-origin')).toBeVisible();
    await expect(dialog.locator('.session-tree-origin-stem')).toHaveCount(0);
    await expect(dialog.locator('.session-tree-branch')).toHaveCount(0);
    await expect(dialog.locator('.session-tree')).toHaveCSS('min-height', '0px');
    await expect(dialog.locator('.el-loading-mask')).toBeHidden();
    const root = dialog.getByRole('button', { name: 'forge#maintainer, 空闲' });
    await expect(root).toHaveAttribute('aria-current', 'true');
    await expect(root).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.mouse.move(0, 0);
    await root.evaluate((element) => (element as HTMLElement).blur());
    await page.screenshot({
      path: testInfo.outputPath(`root-${theme}.png`),
      fullPage: true,
      animations: 'disabled'
    });
    await root.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('selected')).toHaveText('parent');
  });
}

for (const [width, theme] of [
  [390, 'daylight'],
  [1280, 'vscode-dark-2026']
] as const) {
  test(`session tree menu icon at ${width}px in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${fixture.url}session-groups.html?theme=${theme}&locale=en-US`);
    const chats = page.locator('.conversation-sidebar');
    await chats.getByRole('tab').nth(1).click();
    await chats.locator('.session-link').hover();
    await chats.locator('.session-more-button').click();
    const treeItem = page.getByRole('menuitem', { name: 'View session tree', exact: true });
    await expect(treeItem.locator('[data-mar-icon="session-tree"]')).toBeVisible();
    await expect(treeItem.locator('[data-mar-icon="collection"]')).toHaveCount(0);
    await treeItem.screenshot({ path: testInfo.outputPath('session-tree-menu.png') });
    await treeItem.click();
    await page.locator('.session-tree-node').click();
    await expect(page.getByTestId('opened-tree-session')).toHaveText('child');
    await expect(treeItem).not.toBeVisible();
  });
}
