import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

for (const [width, theme, locale] of [
  [1280, 'vscode-dark-2026', 'en-US'],
  [390, 'daylight', 'en-US'],
  [1280, 'custom', 'zh-CN'],
  [1280, 'vscode-dark-2026', 'zh-CN'],
  [390, 'vscode-dark-2026', 'zh-CN']
] as const) {
  test(`Session group tabs preserve badges, keyboard and move interaction at ${width}px ${theme} ${locale}`, async ({
    page
  }) => {
    const fixture = await startCustomThemeFixture();
    try {
      await page.setViewportSize({ width, height: 850 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`${fixture.url}session-groups.html?theme=${theme}&locale=${locale}`);
      const chats = page.locator('.conversation-sidebar');
      const tabs = chats.getByRole('tab');
      await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
      await expect(tabs.nth(0).locator(':scope > span').first()).toHaveText(
        locale === 'zh-CN' ? '主会话' : 'Main'
      );
      await expect(tabs.nth(1).locator(':scope > span').first()).toHaveText(
        locale === 'zh-CN' ? '子会话' : 'Child'
      );
      await expect(tabs.nth(1)).toContainText('99+');
      await expect(tabs.nth(1)).toContainText(locale === 'zh-CN' ? '未读' : 'Unread');
      const selectedBackground = await tabs.nth(0).evaluate((element) => {
        const style = getComputedStyle(element);
        const probe = document.createElement('span');
        probe.style.background = 'var(--mar-fill-selection)';
        element.append(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { actual: style.backgroundColor, expected };
      });
      expect(selectedBackground.actual).toBe(selectedBackground.expected);
      await tabs.nth(0).hover();
      await expect(tabs.nth(0)).toHaveCSS('background-color', selectedBackground.expected);
      for (const tab of await tabs.all()) {
        const bounds = await tab.boundingBox();
        expect(bounds!.height).toBeLessThanOrEqual(28);
        await expect(tab).toHaveCSS('text-align', 'center');
        const labelBounds = (await tab.locator('.group-label').boundingBox())!;
        const markerBounds = (await tab.locator('.group-markers').boundingBox())!;
        expect(labelBounds.x + labelBounds.width / 2).toBeCloseTo(bounds!.x + bounds!.width / 2, 0);
        expect(markerBounds.y).toBeLessThan(bounds!.y);
        expect(markerBounds.y + markerBounds.height).toBeLessThanOrEqual(labelBounds.y);
        expect(markerBounds.x + markerBounds.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
        const badge = tab.locator('.el-badge__content');
        await expect(badge).toHaveCSS('border-top-width', '1px');
        const markerColor = await badge.evaluate((element) => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--mar-color-on-accent)';
          element.append(probe);
          const expected = getComputedStyle(probe).color;
          probe.remove();
          return { actual: getComputedStyle(element).color, expected };
        });
        expect(markerColor.actual).toBe(markerColor.expected);
        const badgeBounds = await badge.boundingBox();
        expect(badgeBounds!.height).toBeLessThan(bounds!.height);
      }
      const groupBounds = (await chats.getByRole('tablist').boundingBox())!;
      const listBounds = (await chats.locator('.session-list').boundingBox())!;
      expect(groupBounds.height).toBeLessThanOrEqual(36);
      expect(listBounds.y - groupBounds.y - groupBounds.height).toBeLessThanOrEqual(4);
      const directory = resolve('test/runs', process.env['MAR_TEST_RUN_ID']!);
      await mkdir(directory, { recursive: true });
      const headerBounds = (await chats.boundingBox())!;
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: resolve(directory, `session-group-header-${width}-${theme}-${locale}.png`),
        clip: { ...headerBounds, height: Math.min(headerBounds.height, 240) }
      });
      await tabs.nth(0).focus();
      await page.keyboard.press('ArrowRight');
      await expect(tabs.nth(1)).toHaveCSS('outline-style', 'solid');
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
      for (const list of [chats.getByRole('tablist'), recent.getByRole('tablist')]) {
        await expect(list.locator('.group-unread')).toHaveCount(2);
        expect(
          await list.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
        ).toBe(true);
        for (const property of ['color', 'background-color', 'border-top-color', 'font-weight']) {
          const expected = await chats
            .locator('.session-unread-label')
            .first()
            .evaluate(
              (element, name) => getComputedStyle(element).getPropertyValue(name),
              property
            );
          for (const unread of await list.locator('.group-unread').all())
            await expect(unread).toHaveCSS(property, expected);
        }
      }
      await page.screenshot({
        path: resolve(directory, `session-groups-${width}-${theme}-${locale}.png`),
        fullPage: true
      });
      await recent.locator('.recent-sessions-list > li > button').first().click();
      await expect(page.locator('.conversation')).toContainText('child-1');
    } finally {
      await fixture.close();
    }
  });
}
