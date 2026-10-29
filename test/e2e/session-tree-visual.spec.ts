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
      await expect(rows).toHaveCount(2);
      for (const row of await rows.all()) {
        await expect(row).toHaveCSS('border-top-width', '0px');
        expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      await rows.first().hover();
      expect(await rows.first().evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
        'rgba(0, 0, 0, 0)'
      );
      await rows.last().focus();
      await expect(rows.last()).toHaveCSS('outline-width', '2px');
      await expect(rows.last()).toHaveAttribute('aria-current', 'true');
      expect(await rows.last().evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
        'rgba(0, 0, 0, 0)'
      );
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: testInfo.outputPath(`tree-${width}-${theme}.png`),
        fullPage: true
      });
      await rows.first().press('Enter');
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('selected')).toHaveText('parent');
    });
  }
}
