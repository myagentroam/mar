import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

for (const [width, theme, locale] of [
  [1280, 'vscode-dark-2026', 'en-US'],
  [390, 'daylight', 'en-US'],
  [1280, 'custom', 'zh-CN']
] as const) {
  test(`Session group tabs preserve badges, keyboard and move interaction at ${width}px ${theme} ${locale}`, async ({
    page
  }) => {
    const fixture = await startCustomThemeFixture();
    try {
      await page.setViewportSize({ width, height: 850 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`${fixture.url}session-groups.html?theme=${theme}&locale=${locale}`);
      const chats = page.locator('aside');
      const tabs = chats.getByRole('tab');
      await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
      await expect(tabs.nth(1)).toContainText('99+');
      await expect(tabs.nth(1)).toContainText(locale === 'zh-CN' ? '未读' : 'Unread');
      await tabs.nth(0).focus();
      await page.keyboard.press('ArrowRight');
      await expect(tabs.nth(1)).toBeFocused();
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
      await expect(chats.locator('.session-link')).toHaveCount(1);
      await chats.locator('.session-link').click();
      await expect(page.locator('.conversation')).toContainText('child');
      await chats.locator('.session-link').hover();
      await chats.locator('.session-more-button').click();
      await page
        .getByRole('menuitem', {
          name: locale === 'zh-CN' ? '移动到主会话' : 'Move to Main Sessions'
        })
        .click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText(locale === 'zh-CN' ? '分组关系' : 'group relationship');
      await dialog
        .getByRole('button', { name: locale === 'zh-CN' ? '移动' : 'Move', exact: true })
        .click();
      await expect(chats.locator('.session-link')).toHaveCount(0);
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.conversation')).toContainText('child');
      await tabs.nth(0).click();
      await expect(chats.locator('.session-link')).toHaveCount(2);
      if (width === 1280) await page.locator('.recent-sessions-trigger').click();
      const recent = page.locator('.recent-sessions-panel');
      await expect(recent.getByRole('tab').nth(0)).toHaveAttribute('aria-selected', 'true');
      await recent.getByRole('tab').nth(1).click();
      await expect(recent.locator('.recent-sessions-list > li')).toHaveCount(102);
      for (const list of [chats.getByRole('tablist'), recent.getByRole('tablist')])
        expect(
          await list.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
        ).toBe(true);
      const directory = resolve('test/runs', process.env['MAR_TEST_RUN_ID']!);
      await mkdir(directory, { recursive: true });
      await page.screenshot({
        path: resolve(directory, `session-groups-${width}-${theme}.png`),
        fullPage: true
      });
      await recent.locator('.recent-sessions-list > li > button').first().click();
      await expect(page.locator('.conversation')).toContainText('child-1');
    } finally {
      await fixture.close();
    }
  });
}
