import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

for (const [width, theme] of [
  [1280, 'daylight'],
  [390, 'vscode-dark-2026']
] as const) {
  test(`Session list watch loading uses the shared spinner and retains rows at ${width}px ${theme}`, async ({
    page
  }) => {
    const fixture = await startCustomThemeFixture();
    try {
      await page.setViewportSize({ width, height: 850 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(
        `${fixture.url}session-groups.html?locale=en-US&theme=${theme}&watch-status=loading`
      );
      const sidebar = page.locator('.conversation-sidebar');
      const status = sidebar.getByRole('status', { name: 'Loading sessions…' });
      await expect(status).toBeVisible();
      await expect(status).toHaveText('');
      await expect(status.locator('.busy-indicator')).toBeVisible();
      const indicatorSize = await status.locator('.busy-indicator').evaluate((indicator) => ({
        width: parseFloat(getComputedStyle(indicator).width),
        rootSize: parseFloat(getComputedStyle(document.documentElement).fontSize)
      }));
      expect(indicatorSize.width).toBeCloseTo(indicatorSize.rootSize * 0.875, 1);
      await expect(status.locator('.busy-indicator')).toHaveCSS('animation-name', 'none');
      await expect(sidebar.locator('.session-row')).toHaveCount(1);

      await page.goto(
        `${fixture.url}session-groups.html?locale=en-US&watch-status=loading&empty-sessions`
      );
      await expect(status).toBeVisible();
      await expect(sidebar.locator('.session-row')).toHaveCount(0);

      await page.goto(`${fixture.url}session-groups.html?locale=en-US&watch-status=failed`);
      await expect(sidebar.getByRole('status', { name: 'Loading sessions…' })).toHaveCount(0);
      await expect(sidebar.locator('.watch-status.failed')).toBeVisible();
      await expect(sidebar.locator('.session-row')).toHaveCount(1);
    } finally {
      await fixture.close();
    }
  });
}

test('Session rows keep their desktop and mobile density', async ({ page }) => {
  const fixture = await startCustomThemeFixture();
  try {
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.goto(`${fixture.url}session-groups.html?locale=en-US`);
    const row = page.locator('.conversation-sidebar .session-row').first();
    await row.locator('..').evaluate((item) => item.after(item.cloneNode(true)));
    const nextRow = page.locator('.conversation-sidebar .session-row').nth(1);
    await expect(row).toHaveCSS('height', '32px');
    const bounds = (await row.boundingBox())!;
    const nextBounds = (await nextRow.boundingBox())!;
    expect(nextBounds.y - (bounds.y + bounds.height)).toBe(2);
    await row.hover();
    await expect(row).toHaveCSS('height', '32px');
    const more = row.locator('.session-more-button');
    await expect(more).toHaveCSS('height', '24px');
    await more.click();
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 850 });
    await expect(row).toHaveCSS('height', '32px');
    const mobileBounds = (await row.boundingBox())!;
    const nextMobileBounds = (await nextRow.boundingBox())!;
    expect(nextMobileBounds.y - (mobileBounds.y + mobileBounds.height)).toBe(2);
    await row.hover();
    await expect(row).toHaveCSS('height', '32px');
    await expect(row.locator('.session-link')).toHaveCSS('height', '32px');
  } finally {
    await fixture.close();
  }
});

test('Mobile session rows remain selectable by touch', async ({ browser }) => {
  const fixture = await startCustomThemeFixture();
  const context = await browser.newContext({
    viewport: { width: 390, height: 850 },
    hasTouch: true
  });
  try {
    const page = await context.newPage();
    await page.goto(`${fixture.url}session-groups.html?locale=en-US`);
    const sidebar = page.locator('.conversation-sidebar');
    await sidebar.getByRole('tab').nth(1).tap();
    const row = sidebar.locator('.session-row').first();
    await expect(row).toHaveCSS('height', '32px');
    await row.locator('.session-link').tap();
    await expect(page.locator('.conversation')).toContainText('child');
  } finally {
    await context.close();
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
  test(`Plain session categories keep selection, unread rows and tree interaction at ${width}px ${theme} ${locale}`, async ({
    page
  }, testInfo) => {
    const fixture = await startCustomThemeFixture();
    try {
      await page.setViewportSize({ width, height: 850 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`${fixture.url}session-groups.html?theme=${theme}&locale=${locale}`);
      const chats = page.locator('.conversation-sidebar');
      const tabs = chats.getByRole('tab');
      await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
      await expect(tabs.nth(0)).toHaveText(locale === 'zh-CN' ? '主会话' : 'Main');
      await expect(tabs.nth(1)).toHaveText(locale === 'zh-CN' ? '子会话' : 'Child');
      await expect(chats.locator('.session-state-badge')).toHaveCount(0);
      const colors = await chats.evaluate((element) => {
        const probe = document.createElement('span');
        element.append(probe);
        const color = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const result = {
          running: color('--el-color-success'),
          track: color('--mar-bg-subtle'),
          selected: color('--mar-fill-selection'),
          hover: color('--mar-fill-row-hover'),
          primary: color('--mar-text-primary')
        };
        probe.remove();
        return result;
      });
      await expect(tabs.nth(0)).toHaveCSS('background-color', colors.selected);
      await expect(tabs.nth(1)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(chats.getByRole('tablist')).toHaveCSS('background-color', colors.track);
      await tabs.nth(1).hover();
      await expect(tabs.nth(1)).toHaveCSS('background-color', colors.hover);
      for (const tab of await tabs.all()) {
        const bounds = (await tab.boundingBox())!;
        const text = (await tab.locator('.group-label').boundingBox())!;
        expect(bounds.height).toBeLessThanOrEqual(28);
        expect(text.x + text.width / 2).toBeCloseTo(bounds.x + bounds.width / 2, 0);
      }
      const dots = page.locator('.session-activity.managed_active i');
      await expect(page.locator('.conversation-header .session-activity')).toHaveCount(0);
      await expect(dots).toHaveCount(2);
      for (const dot of await dots.all()) {
        await expect(dot).toHaveCSS('background-color', colors.running);
        await expect(dot).toHaveCSS('width', '5px');
        await expect(dot).toHaveCSS('animation-name', 'none');
      }
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      for (const dot of await dots.all())
        await expect(dot).toHaveCSS('animation-name', 'mar-run-glow');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const unread = chats.locator('.session-unread-label').first();
      await expect(unread).toBeVisible();
      await expect(unread).toHaveCSS('color', colors.primary);
      await expect(unread).toHaveCSS('border-top-width', '1px');
      expect(
        await unread.evaluate((e) => parseFloat(getComputedStyle(e).borderTopRightRadius))
      ).toBeGreaterThan(0);
      await tabs.nth(0).focus();
      await page.keyboard.press('ArrowRight');
      await expect(tabs.nth(1)).toBeFocused();
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.conversation > p').first()).toHaveText('main');
      await chats.locator('.session-link').click();
      await expect(page.locator('.conversation > p').first()).toHaveText('child');
      await chats.locator('.session-more-button').click();
      await expect(
        page.getByRole('menuitem', {
          name: locale === 'zh-CN' ? '移动到主会话' : 'Move to Main Sessions'
        })
      ).toHaveCount(0);
      await page
        .getByRole('menuitem', { name: locale === 'zh-CN' ? '查看会话树' : 'View session tree' })
        .click();
      await expect(page.getByRole('dialog', { name: 'View session tree' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'View session tree' })).toHaveCount(0);
      await expect(chats.locator('.session-link')).toBeFocused();
      await chats.locator('.session-more-button').click();
      await page
        .getByRole('menuitem', { name: locale === 'zh-CN' ? '查看会话树' : 'View session tree' })
        .click();
      await page.locator('.session-tree-node').click();
      await expect(page.getByTestId('opened-tree-session')).toHaveText('child-detail');
      await page.locator('.activity-center-trigger').click();
      await page
        .locator('.activity-tabs:visible')
        .getByRole('tab', { name: locale === 'zh-CN' ? '最近会话' : 'Recent Sessions' })
        .click();
      const recent = page.locator('.recent-sessions-panel:visible');
      await expect(recent.locator('.session-state-badge')).toHaveCount(0);
      await expect(recent.locator('.recent-session-unread')).toHaveCount(1);
      await recent.getByRole('tab').nth(1).click();
      await expect(recent.locator('.recent-sessions-list > li')).toHaveCount(102);
      await expect(page.locator('.conversation > p').first()).toHaveText('child');
      await expect(recent.locator('.recent-session-unread')).toHaveCount(1);
      const marker = recent.locator('.recent-session-unread');
      await expect(marker).toHaveCSS(
        'background-color',
        await unread.evaluate((e) => getComputedStyle(e).backgroundColor)
      );
      const statuses = recent.locator('.recent-sessions-list .el-tag');
      await expect(statuses.first()).toHaveClass(/el-tag--info/);
      await expect(statuses.last()).toHaveClass(/el-tag--success/);
      await recent.screenshot({
        path: testInfo.outputPath(`plain-groups-${width}-${theme}-${locale}.png`)
      });
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
      await page.locator('.activity-center-trigger').click();
      await page
        .locator('.activity-tabs:visible')
        .getByRole('tab', { name: locale === 'zh-CN' ? '最近会话' : 'Recent Sessions' })
        .click();
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
