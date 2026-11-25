import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

for (const [width, theme] of [
  [1280, 'daylight'],
  [390, 'dark']
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
      await expect(status).toHaveCSS('flex-grow', '0');
      await expect(status.locator('.mar-busy-indicator')).toBeVisible();
      const indicatorSize = await status.locator('.mar-busy-indicator').evaluate((indicator) => ({
        width: parseFloat(getComputedStyle(indicator).width),
        rootSize: parseFloat(getComputedStyle(document.documentElement).fontSize)
      }));
      expect(indicatorSize.width).toBeCloseTo(indicatorSize.rootSize * 0.875, 1);
      await expect(status.locator('.mar-busy-indicator')).toHaveCSS('animation-name', 'none');
      await expect(sidebar.locator('.session-row')).toHaveCount(1);

      await page.goto(
        `${fixture.url}session-groups.html?locale=en-US&theme=${theme}&watch-status=loading&empty-sessions`
      );
      await expect(status).toBeVisible();
      await expect(status).toHaveCSS('flex-grow', '1');
      await expect(sidebar.locator('.session-row')).toHaveCount(0);

      await page.goto(
        `${fixture.url}session-groups.html?locale=en-US&theme=${theme}&watch-status=failed`
      );
      await expect(sidebar.getByRole('status', { name: 'Loading sessions…' })).toHaveCount(0);
      await expect(sidebar.locator('.watch-status.failed')).toBeVisible();
      await expect(sidebar.locator('.session-row')).toHaveCount(1);
    } finally {
      await fixture.close();
    }
  });
}

test('Session rows keep their desktop and mobile density', async ({ page }, testInfo) => {
  const fixture = await startCustomThemeFixture();
  try {
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${fixture.url}session-groups.html?locale=en-US&theme=dark`);
    const groups = page.locator('.conversation-sidebar').getByRole('radiogroup');
    await expect(groups).toHaveCSS('height', '26px');
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
    const menu = page.locator('.session-action-menu');
    await expect(menu).toHaveAttribute('data-side', 'bottom');
    await expect(menu).toHaveAttribute('data-arrow', '');
    const { center, clearance } = await menu.evaluate((element) => {
      const panel = element.getBoundingClientRect();
      const surface = getComputedStyle(element);
      const arrow = getComputedStyle(element, '::before');
      const width = parseFloat(arrow.width) + parseFloat(arrow.borderLeftWidth);
      const height = parseFloat(arrow.height) + parseFloat(arrow.borderTopWidth);
      const center =
        panel.left + parseFloat(surface.borderLeftWidth) + parseFloat(arrow.left) + width / 2;
      return {
        center,
        clearance:
          panel.right -
          center -
          Math.hypot(width, height) / 2 -
          parseFloat(surface.borderTopRightRadius)
      };
    });
    expect(clearance).toBeGreaterThanOrEqual(1);
    const trigger = (await more.boundingBox())!;
    expect(center).toBeGreaterThan(trigger.x);
    expect(center).toBeLessThan(trigger.x + trigger.width);
    const menuBounds = (await menu.boundingBox())!;
    await page.screenshot({
      clip: { ...menuBounds, y: menuBounds.y - 12, height: menuBounds.height + 12 },
      path: testInfo.outputPath('session-menu-arrow.png')
    });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 850 });
    await expect(groups).toHaveCSS('height', '26px');
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
    await sidebar.getByRole('radio', { name: 'Child Sessions', exact: true }).tap();
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
  [1280, 'dark', 'en-US'],
  [320, 'dark', 'en-US'],
  [390, 'daylight', 'en-US'],
  [390, 'daylight', 'zh-CN'],
  [1280, 'daylight', 'zh-CN'],
  [1280, 'custom', 'zh-CN'],
  [1280, 'dark', 'zh-CN'],
  [390, 'dark', 'zh-CN']
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
      const categories = chats.getByRole('radiogroup');
      const radios = categories.getByRole('radio');
      const options = categories.locator('.mar-segmented-option');
      const indicator = categories.locator('.mar-segmented-indicator');
      await expect(radios.nth(0)).toBeChecked();
      await expect(options.nth(0)).toHaveText(locale === 'zh-CN' ? '主会话' : 'Main');
      await expect(options.nth(1)).toHaveText(locale === 'zh-CN' ? '子会话' : 'Child');
      const trackBounds = (await categories.boundingBox())!;
      for (const toolbar of ['.session-search', '.new-session-form']) {
        const row = chats.locator(toolbar);
        await expect(row).toBeVisible();
        const bounds = (await row.boundingBox())!;
        expect(trackBounds.x).toBeCloseTo(bounds.x, 0);
        expect(trackBounds.x + trackBounds.width).toBeCloseTo(bounds.x + bounds.width, 0);
      }
      await categories.screenshot({ path: testInfo.outputPath('session-categories.png') });
      await expect(chats.locator('.session-state-badge')).toHaveCount(0);
      const colors = await chats.evaluate((element) => {
        const probe = document.createElement('span');
        element.append(probe);
        const color = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const result = {
          running: color('--mar-control-color-success'),
          runningText: color('--mar-color-success-text'),
          track: color('--mar-bg-subtle'),
          border: color('--mar-border-default'),
          selected: color('--mar-fill-selection'),
          hover: color('--mar-fill-row-hover'),
          primary: color('--mar-text-primary')
        };
        probe.remove();
        return result;
      });
      const expectIndicatorAt = async (option: number) => {
        await expect
          .poll(async () => {
            const [slider, target] = await Promise.all([
              indicator.boundingBox(),
              options.nth(option).boundingBox()
            ]);
            return slider && target
              ? Math.max(Math.abs(slider.x - target.x), Math.abs(slider.width - target.width))
              : Infinity;
          })
          .toBeLessThanOrEqual(1);
      };
      await expectIndicatorAt(0);
      await expect(indicator).toHaveCSS('background-color', colors.selected);
      await expect(indicator).toHaveCSS('transition-duration', '0s');
      await expect(options.nth(1)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(categories).toHaveCSS('background-color', colors.track);
      await expect(categories).toHaveCSS('border-top-width', '1px');
      await expect(categories).toHaveCSS('border-top-style', 'solid');
      await expect(categories).toHaveCSS('border-top-color', colors.border);
      await expect(options.nth(0)).toHaveCSS('border-top-width', '0px');
      await radios.nth(1).hover();
      await expect(options.nth(1)).toHaveCSS('background-color', colors.hover);
      for (const option of await options.all()) {
        const bounds = (await option.boundingBox())!;
        const text = (await option.locator('span').boundingBox())!;
        expect(bounds.height).toBeLessThanOrEqual(28);
        expect(text.x + text.width / 2).toBeCloseTo(bounds.x + bounds.width / 2, 0);
        await expect(option).toHaveCSS('font-size', '12px');
        await expect(option).toHaveCSS('font-weight', '400');
      }
      const dots = page.locator('.mar-session-activity.running i');
      await expect(page.locator('.conversation-header .mar-session-activity')).toHaveCount(0);
      await expect(dots).toHaveCount(2);
      for (const dot of await dots.all()) {
        await expect(dot).toHaveCSS('background-color', colors.running);
        await expect(dot).toHaveCSS('width', '6px');
        await expect(dot).toHaveCSS('animation-name', 'none');
      }
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      for (const dot of await dots.all()) await expect(dot).toHaveCSS('animation-name', 'none');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const unread = chats.locator('.session-unread-label').first();
      await expect(unread).toBeVisible();
      await expect(unread).toHaveCSS('color', colors.primary);
      await expect(unread).toHaveCSS('border-top-width', '1px');
      expect(
        await unread.evaluate((e) => parseFloat(getComputedStyle(e).borderTopRightRadius))
      ).toBeGreaterThan(0);
      await radios.nth(0).focus();
      await page.keyboard.press('ArrowRight');
      await expect(radios.nth(1)).toBeFocused();
      await expect(radios.nth(1)).toBeChecked();
      await expectIndicatorAt(1);
      await page.keyboard.press('ArrowLeft');
      await expect(radios.nth(0)).toBeFocused();
      await expect(radios.nth(0)).toBeChecked();
      await page.keyboard.press('End');
      await expect(radios.nth(1)).toBeFocused();
      await expect(radios.nth(1)).toBeChecked();
      await page.keyboard.press('Home');
      await expect(radios.nth(0)).toBeFocused();
      await expect(radios.nth(0)).toBeChecked();
      await expectIndicatorAt(0);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await indicator.evaluate((element) => {
        element.addEventListener('transitionrun', (event) => {
          if ((event as TransitionEvent).propertyName === 'transform')
            element.dataset.slid = 'true';
        });
      });
      await radios.nth(1).click();
      await expect(indicator).toHaveAttribute('data-slid', 'true');
      await expectIndicatorAt(1);
      await page.emulateMedia({ reducedMotion: 'reduce' });
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
      const recentCategories = recent.getByRole('radiogroup');
      await expect(recentCategories).toHaveCSS('border-top-width', '1px');
      await expect(recentCategories).toHaveCSS('border-top-style', 'solid');
      await expect(recentCategories).toHaveCSS('border-top-color', colors.border);
      await expect(recentCategories.locator('.mar-segmented-option').first()).toHaveCSS(
        'border-top-width',
        '0px'
      );
      await expect(recent.locator('.session-state-badge')).toHaveCount(0);
      await expect(recent.locator('.recent-session-unread')).toHaveCount(1);
      await recentCategories.getByRole('radio').nth(1).click();
      await expect(recentCategories.getByRole('radio').nth(1)).toBeChecked();
      await expect(radios.nth(1)).toBeChecked();
      await expect(recent.locator('.recent-sessions-list > li')).toHaveCount(102);
      await expect(page.locator('.conversation > p').first()).toHaveText('child');
      await expect(recent.locator('.recent-session-unread')).toHaveCount(1);
      const marker = recent.locator('.recent-session-unread');
      await expect(marker).toHaveCSS(
        'background-color',
        await unread.evaluate((e) => getComputedStyle(e).backgroundColor)
      );
      const statuses = recent.locator('.recent-sessions-list .mar-ui-tag');
      await expect(statuses.first()).toHaveAttribute('data-type', 'info');
      await expect(statuses.last()).toHaveText(locale === 'zh-CN' ? '运行中' : 'Running');
      await expect(statuses.last()).toHaveCSS('color', colors.runningText);
      await recent.screenshot({
        path: testInfo.outputPath(`plain-groups-${width}-${theme}-${locale}.png`)
      });
    } finally {
      await fixture.close();
    }
  });
}

test('Session categories retain a visible selection in forced colors', async ({ page }) => {
  const fixture = await startCustomThemeFixture();
  try {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto(`${fixture.url}session-groups.html?locale=zh-CN`);
    const categories = page.locator('.conversation-sidebar').getByRole('radiogroup');
    const radios = categories.getByRole('radio');
    const selectionBorders = () =>
      categories
        .locator('.mar-segmented-option')
        .evaluateAll((options) =>
          options.map((option) => getComputedStyle(option, '::after').borderTopStyle)
        );

    await expect(radios.nth(0)).toBeChecked();
    await expect.poll(selectionBorders).toEqual(['solid', 'none']);
    await radios.nth(0).focus();
    await page.keyboard.press('ArrowRight');
    await expect(radios.nth(1)).toBeChecked();
    await expect(radios.nth(1)).toBeFocused();
    await expect.poll(selectionBorders).toEqual(['none', 'solid']);
    await expect(categories.locator('.mar-segmented-option').nth(1)).toHaveCSS(
      'outline-style',
      'solid'
    );
  } finally {
    await fixture.close();
  }
});

for (const [width, theme, locale] of [
  [1280, 'daylight', 'en-US'],
  [390, 'dark', 'en-US'],
  [1280, 'dark', 'zh-CN'],
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
      const statuses = recent.locator('.recent-sessions-list .mar-ui-tag');
      await expect(statuses).toHaveText(
        locale === 'zh-CN' ? ['已取消', '已中断'] : ['Canceled', 'Interrupted']
      );
      await expect(statuses.first()).toHaveAttribute('data-type', 'info');
      await expect(statuses.last()).toHaveAttribute('data-type', 'warning');
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
