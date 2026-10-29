import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

test('Session rows keep desktop density without changing mobile height', async ({ page }) => {
  const fixture = await startCustomThemeFixture();
  try {
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.goto(`${fixture.url}session-groups.html?locale=en-US`);
    const row = page.locator('.conversation-sidebar .session-row').first();
    await expect(row).toHaveCSS('height', '30px');
    await row.hover();
    await expect(row).toHaveCSS('height', '30px');
    const more = row.locator('.session-more-button');
    await expect(more).toHaveCSS('height', '24px');
    await more.click();
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 850 });
    await expect(row).toHaveCSS('height', '40px');
  } finally {
    await fixture.close();
  }
});

for (const width of [390, 1280]) {
  test(`Group badges open a session and select its group at ${width}px`, async ({ browser }) => {
    const fixture = await startCustomThemeFixture();
    const context = await browser.newContext({
      viewport: { width, height: 850 },
      hasTouch: width === 390
    });
    const page = await context.newPage();
    const activate = (locator: import('@playwright/test').Locator) =>
      width === 390 ? locator.tap() : locator.click();
    try {
      await page.goto(`${fixture.url}session-groups.html?theme=daylight&locale=en-US`);
      const chats = page.locator('.conversation-sidebar');
      const chatTabs = chats.getByRole('tab');
      await activate(chatTabs.nth(1).locator('.session-state-badge'));
      await expect(chatTabs.nth(1)).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.conversation > p').first()).toHaveText('child-1');
      await activate(chatTabs.nth(0).locator('.session-state-badge'));
      await expect(page.locator('.conversation > p').first()).toHaveText('main');
      await expect(chatTabs.nth(0)).toHaveAttribute('aria-selected', 'true');
      if (width === 1280) await page.locator('.recent-sessions-trigger').click();
      const recent = page.locator('.recent-sessions-panel');
      await activate(recent.getByRole('tab').nth(1).locator('.session-state-badge'));
      await expect(page.locator('.conversation > p').first()).toHaveText('child-1');
      await expect(chatTabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    } finally {
      await context.close();
      await fixture.close();
    }
  });
}

test('Unread-only group badges open their session in both lists', async ({ page }) => {
  const fixture = await startCustomThemeFixture();
  try {
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.goto(`${fixture.url}session-groups.html?locale=en-US&unread-only`);
    const chats = page.locator('.conversation-sidebar');
    const childBadge = chats.getByRole('tab').nth(1).locator('.session-state-badge');
    await expect(childBadge.locator('.session-state-count')).toHaveCount(0);
    await childBadge.click();
    await expect(page.locator('.conversation > p').first()).toHaveText('child-1');
    await page.locator('.recent-sessions-trigger').click();
    await page
      .locator('.recent-sessions-panel')
      .getByRole('tab')
      .nth(0)
      .locator('.session-state-badge')
      .click();
    await expect(page.locator('.conversation > p').first()).toHaveText('main');
  } finally {
    await fixture.close();
  }
});

for (const [width, theme, locale] of [
  [1280, 'vscode-dark-2026', 'en-US'],
  [320, 'vscode-dark-2026', 'en-US'],
  [390, 'daylight', 'en-US'],
  [390, 'daylight', 'zh-CN'],
  [1280, 'daylight', 'zh-CN'],
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
      const palette = await page.evaluate(() => {
        const probe = document.createElement('span');
        document.body.append(probe);
        const color = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const result = {
          brand: color('--mar-color-brand'),
          panel: color('--mar-bg-panel'),
          border: color('--mar-border-default'),
          track: color('--mar-bg-subtle'),
          selected: color('--mar-fill-selection'),
          text: color('--mar-text-primary'),
          hover: color('--mar-fill-row-hover'),
          link: color('--mar-control-link-text'),
          success: color('--mar-color-success-text')
        };
        probe.remove();
        return result;
      });
      const runningDots = page.locator('.session-activity.managed_active i');
      await expect(page.locator('.conversation-header .session-activity')).toHaveCount(0);
      await expect(page.locator('.workspace-tab-running i')).toHaveCount(1);
      await expect(chats.locator('.session-activity.managed_active i')).toHaveCount(1);
      await expect(runningDots).toHaveCount(2);
      for (const dot of await runningDots.all()) {
        await expect(dot).toHaveCSS('background-color', palette.brand);
        await expect(dot).toHaveCSS('width', '5px');
        await expect(dot).toHaveCSS('height', '5px');
        await expect(dot).toHaveCSS('animation-name', 'none');
      }
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      for (const dot of await runningDots.all())
        await expect(dot).toHaveCSS('animation-name', 'mar-run-glow');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const selectedBackground = {
        actual: await tabs.nth(0).evaluate((element) => getComputedStyle(element).backgroundColor),
        expected: palette.selected
      };
      expect(selectedBackground.actual).toBe(selectedBackground.expected);
      await expect(tabs.nth(1)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      expect(palette.track).not.toBe('rgba(0, 0, 0, 0)');
      expect(palette.track).not.toBe(selectedBackground.expected);
      await tabs.nth(1).hover();
      await expect(tabs.nth(1)).toHaveCSS('background-color', palette.hover);
      await page.mouse.move(0, 0);
      await expect(tabs.nth(1)).toHaveCSS('box-shadow', 'none');
      await expect(chats.getByRole('tablist')).toHaveCSS('background-color', palette.track);
      await expect(chats.getByRole('tablist')).toHaveCSS(
        'box-shadow',
        `${palette.border} 0px 0px 0px 1px inset`
      );
      await expect(tabs.nth(0)).toHaveCSS('box-shadow', 'none');
      expect(selectedBackground.actual).not.toBe(palette.panel);
      await tabs.nth(0).hover();
      await expect(tabs.nth(0)).toHaveCSS('background-color', selectedBackground.expected);
      for (const tab of await tabs.all()) {
        const bounds = await tab.boundingBox();
        expect(bounds!.height).toBeLessThanOrEqual(28);
        await expect(tab).toHaveCSS('text-align', 'center');
        const labelBounds = (await tab.locator('.group-label').boundingBox())!;
        const markerBounds = (await tab.locator('.group-markers').boundingBox())!;
        expect((labelBounds.x + markerBounds.x + markerBounds.width) / 2).toBeCloseTo(
          bounds!.x + bounds!.width / 2,
          0
        );
        expect(markerBounds.y).toBeGreaterThanOrEqual(bounds!.y);
        expect(markerBounds.y + markerBounds.height / 2).toBeCloseTo(
          labelBounds.y + labelBounds.height / 2,
          0
        );
        expect(markerBounds.y + markerBounds.height).toBeLessThanOrEqual(
          bounds!.y + bounds!.height
        );
        expect(markerBounds.x).toBeGreaterThanOrEqual(labelBounds.x + labelBounds.width);
        expect(markerBounds.x + markerBounds.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
        const badge = tab.locator('.session-state-count');
        await expect(tab.locator('.session-state-badge')).toHaveCSS('border-top-width', '0px');
        await expect(badge).toHaveCSS('background-color', palette.brand);
        const unread = tab.locator('.session-state-unread');
        const standalone = chats.locator('.session-unread-label').first();
        await expect(standalone).toBeVisible();
        await expect(unread).toHaveCSS(
          'background-color',
          await standalone.evaluate((element) => getComputedStyle(element).backgroundColor)
        );
        await expect(unread).toHaveCSS(
          'color',
          await standalone.evaluate((element) => getComputedStyle(element).color)
        );
        await expect(unread).toHaveCSS('color', palette.text);
        await expect(unread).toHaveCSS('border-inline-start-width', '0px');
        await expect(unread).toHaveCSS('border-top-width', '0px');
        if (theme !== 'custom' && (await tab.getAttribute('aria-selected')) === 'true') {
          const contrast = await unread.evaluate((element) => {
            const context = document.createElement('canvas').getContext('2d')!;
            const luminance = (color: string) => {
              context.clearRect(0, 0, 1, 1);
              context.fillStyle = color;
              context.fillRect(0, 0, 1, 1);
              const channels = context.getImageData(0, 0, 1, 1).data;
              return [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
                const value = channels[index]! / 255;
                return (
                  sum +
                  weight * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
                );
              }, 0);
            };
            const ratio = (first: number, second: number) =>
              (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
            const style = getComputedStyle(element);
            const fill = luminance(style.backgroundColor);
            const selectedStyle = getComputedStyle(element.closest('button')!);
            const selectedFill = luminance(selectedStyle.backgroundColor);
            return {
              text: ratio(fill, luminance(style.color)),
              surface: ratio(fill, selectedFill),
              selectedText: ratio(selectedFill, luminance(selectedStyle.color))
            };
          });
          expect(contrast.text).toBeGreaterThanOrEqual(4.5);
          expect(contrast.surface).toBeGreaterThan(1.25);
          expect(contrast.selectedText).toBeGreaterThanOrEqual(4.5);
        }
        const countBounds = (await badge.boundingBox())!;
        const unreadBounds = (await unread.boundingBox())!;
        expect(countBounds.height).toBeCloseTo(unreadBounds.height, 1);
        expect(countBounds.x + countBounds.width).toBeCloseTo(unreadBounds.x, 1);
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
      const sidebarBounds = (await chats.boundingBox())!;
      const firstTab = (await tabs.nth(0).boundingBox())!;
      const secondTab = (await tabs.nth(1).boundingBox())!;
      expect(firstTab.width).toBeCloseTo(secondTab.width, 0);
      expect(groupBounds.x - sidebarBounds.x).toBeCloseTo(6, 0);
      expect(sidebarBounds.x + sidebarBounds.width - groupBounds.x - groupBounds.width).toBeCloseTo(
        7,
        0
      );
      expect(groupBounds.height).toBeLessThanOrEqual(36);
      expect(listBounds.y - groupBounds.y - groupBounds.height).toBeLessThanOrEqual(8);
      await expect(chats.locator('.session-group-tabs')).toHaveCSS('border-top-width', '1px');
      await expect(chats.locator('.session-list')).toHaveCSS('border-top-width', '0px');
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
      await expect(tabs.nth(1)).toHaveCSS('background-color', selectedBackground.expected);
      await expect(tabs.nth(1)).toHaveCSS('box-shadow', 'none');
      await expect(tabs.nth(0)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(tabs.nth(0)).toHaveCSS('box-shadow', 'none');
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
      await tabs.nth(0).locator('.group-label').click();
      await expect(chats.locator('.session-link')).toHaveCount(2);
      if (width === 1280) await page.locator('.recent-sessions-trigger').click();
      const recent = page.locator('.recent-sessions-panel');
      await expect(recent.getByRole('tab').nth(1)).toHaveCSS(
        'background-color',
        'rgba(0, 0, 0, 0)'
      );
      await expect(recent.getByRole('tablist')).toHaveCSS('background-color', palette.track);
      await expect(recent.getByRole('tablist')).toHaveCSS(
        'box-shadow',
        `${palette.border} 0px 0px 0px 1px inset`
      );
      await expect(page.locator('.recent-sessions-badge .session-state-count')).toHaveCSS(
        'background-color',
        palette.brand
      );
      await expect(recent.getByRole('tab').nth(0)).toHaveAttribute('aria-selected', 'true');
      await expect(recent.getByRole('tab').nth(0)).toHaveCSS(
        'background-color',
        selectedBackground.expected
      );
      await expect(recent.getByRole('tab').nth(0)).toHaveCSS('box-shadow', 'none');
      await expect(recent.locator('.recent-session-unread')).toHaveCount(1);
      await expect(recent.locator('.recent-sessions-list > li').first()).toContainText(
        locale === 'zh-CN' ? '未读' : 'Unread'
      );
      await recent.getByRole('tab').nth(1).locator('.group-label').click();
      await page.mouse.move(0, 0);
      await expect(recent.getByRole('tab').nth(1)).toHaveCSS(
        'background-color',
        selectedBackground.expected
      );
      await expect(recent.getByRole('tab').nth(0)).toHaveCSS(
        'background-color',
        'rgba(0, 0, 0, 0)'
      );
      await expect(recent.locator('.recent-sessions-list > li')).toHaveCount(102);
      await expect(recent.locator('.recent-session-unread')).toHaveCount(1);
      await expect(
        recent.locator('.recent-sessions-list > li').nth(1).locator('.mar-unread-label')
      ).toHaveCount(0);
      const heading = recent.locator('.recent-session-heading').first();
      expect(
        await heading.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
      ).toBe(true);
      const statuses = recent.locator('.recent-sessions-list .el-tag');
      await expect(statuses.first()).toHaveClass(/el-tag--success/);
      await expect(statuses.first()).toHaveCSS('color', palette.success);
      await expect(statuses.last()).toHaveClass(/el-tag--primary/);
      await expect(statuses.last()).toHaveCSS('color', palette.link);
      for (const list of [chats.getByRole('tablist'), recent.getByRole('tablist')]) {
        await expect(list.locator('.session-state-unread')).toHaveCount(2);
        expect(
          await list.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
        ).toBe(true);
        const options = await list.getByRole('tab').all();
        const optionBounds = await Promise.all(options.map((option) => option.boundingBox()));
        expect(optionBounds[0]!.width).toBeCloseTo(optionBounds[1]!.width, 0);
        for (const option of options) {
          await expect(option.locator('.session-state-count')).toHaveCSS(
            'background-color',
            palette.brand
          );
          const bounds = (await option.boundingBox())!;
          const label = (await option.locator('.group-label').boundingBox())!;
          const markers = (await option.locator('.group-markers').boundingBox())!;
          expect((label.x + markers.x + markers.width) / 2).toBeCloseTo(
            bounds.x + bounds.width / 2,
            0
          );
          expect(markers.y).toBeGreaterThanOrEqual(bounds.y);
          expect(markers.x).toBeGreaterThanOrEqual(label.x + label.width);
          expect(markers.x + markers.width).toBeLessThanOrEqual(bounds.x + bounds.width);
          expect(markers.y + markers.height).toBeLessThanOrEqual(bounds.y + bounds.height);
        }
        for (const property of ['color', 'background-color', 'border-top-color', 'font-weight']) {
          const expected = await chats
            .locator('.session-unread-label')
            .first()
            .evaluate(
              (element, name) => getComputedStyle(element).getPropertyValue(name),
              property
            );
          for (const badge of await list.locator('.session-state-unread').all())
            await expect(badge).toHaveCSS(property, expected);
          await expect(recent.locator('.recent-session-unread')).toHaveCSS(property, expected);
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

for (const [width, theme, locale] of [
  [1280, 'daylight', 'en-US'],
  [390, 'vscode-dark-2026', 'en-US'],
  [1280, 'vscode-dark-2026', 'zh-CN'],
  [390, 'daylight', 'zh-CN']
] as const) {
  test(`Recent session stops distinguish Canceled from Interrupted at ${width}px ${locale}`, async ({
    page
  }) => {
    const fixture = await startCustomThemeFixture();
    try {
      await page.setViewportSize({ width, height: 850 });
      await page.goto(
        `${fixture.url}session-groups.html?theme=${theme}&locale=${locale}&stop-statuses`
      );
      if (width === 1280) await page.locator('.recent-sessions-trigger').click();
      const recent = page.locator('.recent-sessions-panel');
      const statuses = recent.locator('.recent-sessions-list .el-tag');
      await expect(statuses).toHaveText(
        locale === 'zh-CN' ? ['已取消', '已中断'] : ['Canceled', 'Interrupted']
      );
      await expect(statuses.first()).toHaveClass(/el-tag--info/);
      await expect(statuses.last()).toHaveClass(/el-tag--warning/);
      const directory = resolve(process.env.MAR_TEST_RUN_DIR ?? 'test/runs');
      await mkdir(directory, { recursive: true });
      await recent.screenshot({
        path: resolve(directory, `recent-session-stops-${width}-${theme}-${locale}.png`)
      });
    } finally {
      await fixture.close();
    }
  });
}
