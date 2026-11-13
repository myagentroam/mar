import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/session-groups.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const theme of ['daylight', 'vscode-dark-2026', 'custom']) {
  test(`Session and Workspace running markers match the static activity badge: ${theme}`, async ({
    page
  }, testInfo) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 850 });
      await page.goto(`${fixture.url}session-groups.html?locale=en-US&theme=${theme}`);
      const session = page.locator('.session-row .mar-session-activity');
      const workspace = page.locator('.workspace-tab-running');
      const badge = page.locator('.activity-entry-running');
      await expect(session).toHaveAttribute('aria-label', 'Working');
      await expect(workspace).toHaveAttribute('aria-label', 'Workspace has an active task');
      await expect(badge).toBeVisible();

      if (theme === 'custom') {
        await page.evaluate(() => {
          document.documentElement.style.setProperty('--mar-control-color-success', '#854e9a');
        });
        await expect(badge).toHaveCSS('background-color', 'rgb(133, 78, 154)');
      }
      const badgeStyle = await badge.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          color: style.backgroundColor,
          width: style.width,
          height: style.height,
          radius: style.borderRadius,
          shadow: style.boxShadow
        };
      });
      expect(badgeStyle.width).toBe('6px');
      expect(badgeStyle.height).toBe('6px');
      expect(badgeStyle.shadow).not.toBe('none');

      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        await page.emulateMedia({ reducedMotion });
        for (const marker of [session.locator('i'), workspace.locator('i'), badge]) {
          await expect(marker).toBeVisible();
          await expect(marker).toHaveCSS('background-color', badgeStyle.color);
          await expect(marker).toHaveCSS('width', badgeStyle.width);
          await expect(marker).toHaveCSS('height', badgeStyle.height);
          await expect(marker).toHaveCSS('border-radius', badgeStyle.radius);
          await expect(marker).toHaveCSS('animation-name', 'none');
          await expect(marker).toHaveCSS('opacity', '1');
        }
        for (const marker of [session.locator('i'), workspace.locator('i')]) {
          await expect(marker).toHaveCSS('box-shadow', 'none');
        }
      }

      await page.locator('.session-row').hover();
      await expect(session.locator('i')).toHaveCSS('background-color', badgeStyle.color);
      await page.locator('.conversation-sidebar').getByRole('tab').nth(1).click();
      await expect(page.locator('.session-row')).toHaveCount(1);
      await expect(session).toHaveAttribute('aria-label', 'Working');
      await expect(session.locator('i')).toHaveCSS('animation-name', 'none');
      await expect(session.locator('i')).toHaveCSS('box-shadow', 'none');
      await page.locator('.fixture').screenshot({
        path: testInfo.outputPath(`static-running-markers-${width}.png`)
      });
    }
  });
}
