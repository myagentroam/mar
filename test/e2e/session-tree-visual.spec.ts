import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/session-tree.html');
});
test.afterAll(async () => {
  await fixture?.close();
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
