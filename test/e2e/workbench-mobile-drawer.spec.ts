import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const scenario of [
  { width: 1280, height: 900, locale: 'en-US', theme: 'daylight' },
  { width: 1440, height: 900, locale: 'zh-CN', theme: 'midnight' },
  { width: 1280, height: 320, locale: 'en-US', theme: 'daylight' },
  { width: 1280, height: 160, locale: 'en-US', theme: 'midnight' }
] as const) {
  test(`Desktop notifications show more entries without clipping at ${scenario.width}x${scenario.height} (${scenario.locale})`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize(scenario);
    await page.goto(
      `${fixture.url}workbench-mobile-drawer.html?locale=${scenario.locale}&theme=${scenario.theme}`
    );
    await page
      .getByRole('button', {
        name: scenario.locale === 'zh-CN' ? '打开通知中心' : 'Open notification center',
        exact: true
      })
      .click();
    const panel = page.locator('.workbench-notification-panel');
    const section = panel.locator('.workbench-notification-section');
    const entries = panel.locator('.workbench-notification-list > li');
    await expect(entries).toHaveCount(30);
    await panel.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    const bounds = (await panel.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(scenario.height - 4);
    await expect(section).toHaveCSS('overflow-y', 'auto');
    if (scenario.height === 900) {
      const visibleEntries = await section.evaluate((element) => {
        const viewport = element.getBoundingClientRect();
        return [...element.querySelectorAll('.workbench-notification-list > li')].filter(
          (entry) => {
            const bounds = entry.getBoundingClientRect();
            return bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1;
          }
        ).length;
      });
      expect(visibleEntries).toBeGreaterThanOrEqual(5);
      await panel.screenshot({ path: testInfo.outputPath('notification-height.png') });
    }
    await section.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const last = (await entries.last().boundingBox())!;
    const viewport = (await section.boundingBox())!;
    expect(last.y + last.height).toBeLessThanOrEqual(viewport.y + viewport.height + 1);
  });
}

for (const theme of ['daylight', 'midnight']) {
  test(`Notification delete controls share themed hover and keyboard feedback in ${theme}`, async ({
    page
  }, testInfo) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.url}workbench-mobile-drawer.html?locale=en-US&theme=${theme}`);
      await page.getByRole('button', { name: 'Open notification center', exact: true }).click();
      const remove = page
        .locator('.workbench-notification-list .workbench-notification-delete')
        .first();
      await expect(remove).toBeVisible();
      await remove.evaluate(async (element) => {
        const panel = element.closest('.workbench-notification-panel')!;
        await Promise.all(panel.getAnimations().map((animation) => animation.finished));
      });
      const tokens = await remove.evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.cssText =
          'position:absolute;color:var(--mar-text-primary);background:var(--mar-fill-hover);border-color:var(--mar-color-brand)';
        element.append(probe);
        const style = getComputedStyle(probe);
        const colors = {
          foreground: style.color,
          surface: style.backgroundColor,
          focus: style.borderTopColor
        };
        probe.remove();
        return colors;
      });
      const normal = await remove.evaluate((element) => ({
        color: getComputedStyle(element).color,
        transform: getComputedStyle(element).transform,
        iconTransform: getComputedStyle(element.querySelector('svg')!).transform
      }));
      const bounds = await remove.boundingBox();
      await expect(remove).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      expect(normal.color).not.toBe(tokens.foreground);
      await remove.hover();
      await expect(remove).toHaveCSS('color', tokens.foreground);
      await expect(remove).toHaveCSS('background-color', tokens.surface);
      await expect(remove).toHaveCSS('transform', normal.transform);
      await expect(remove.locator('svg')).toHaveCSS('transform', normal.iconTransform);
      expect(await remove.boundingBox()).toEqual(bounds);
      await page.screenshot({
        path: testInfo.outputPath(`notification-delete-${theme}-${width}.png`)
      });

      await page.mouse.move(0, 0);
      await page.keyboard.press('Tab');
      await remove.focus();
      await expect(remove).toHaveCSS('outline-style', 'solid');
      await expect(remove).toHaveCSS('outline-width', '2px');
      await expect(remove).toHaveCSS('outline-color', tokens.focus);

      await remove.evaluate((element: HTMLButtonElement) => {
        element.disabled = true;
        element.blur();
      });
      await remove.hover();
      await expect(remove).toHaveCSS('color', normal.color);
      await expect(remove).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(remove).toHaveCSS('opacity', '0.55');
      await expect(remove).toHaveCSS('cursor', 'not-allowed');
    }
  });
}

for (const scenario of [
  { width: 320, height: 700, locale: 'en-US', theme: 'daylight' },
  { width: 390, height: 844, locale: 'zh-CN', theme: 'midnight' },
  { width: 430, height: 430, locale: 'en-US', theme: 'midnight' }
] as const) {
  test(`Existing mobile menus share panels, browser Back and repeated-click dismissal at ${scenario.width}px (${scenario.locale})`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize(scenario);
    await page.goto(
      `${fixture.url}workbench-mobile-drawer.html?locale=${scenario.locale}&theme=${scenario.theme}`
    );
    const recent = page.getByRole('button', {
      name: scenario.locale === 'zh-CN' ? '最近会话' : 'Recent Sessions',
      exact: true
    });
    const notification = page.getByRole('button', {
      name: scenario.locale === 'zh-CN' ? '打开通知中心' : 'Open notification center',
      exact: true
    });
    const panel = page.locator('.workspace-tree.mobile-open');
    const route = page.url();
    await recent.click();
    await expect(panel).toBeVisible();
    await expect(panel.locator('.recent-sessions-list > li')).toHaveCount(30);
    await expect(panel.locator('.mobile-menu-header button')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect
      .poll(() => panel.evaluate((element) => element.getBoundingClientRect().x))
      .toBeCloseTo(0, 0);
    const bounds = (await panel.boundingBox())!;
    expect(bounds.width).toBe(Math.min(300, scenario.width - 48));
    expect(bounds.y).toBeGreaterThanOrEqual(44);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(scenario.height + 1);
    await page.screenshot({ path: testInfo.outputPath('recent-menu.png') });
    await recent.click();
    await expect(panel).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => history.state?.__marMobileMenu)).toBeUndefined();

    await recent.click();
    await expect(panel).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => Boolean(history.state?.__marMobileMenu)))
      .toBe(true);
    const length = await page.evaluate(() => history.length);
    await notification.click();
    await expect(panel.locator('.workbench-notification-list > li')).toHaveCount(30);
    await expect(panel.locator('.recent-sessions-list')).toHaveCount(0);
    await expect(panel.locator('.mobile-menu-header button')).toHaveCount(0);
    const markAllRead = panel.getByRole('button', {
      name: scenario.locale === 'zh-CN' ? '全部标记已读' : 'Mark all as read',
      exact: true
    });
    await expect(markAllRead).toBeVisible();
    await expect(notification.locator('.workbench-notification-badge')).toHaveText('30');
    await markAllRead.click();
    await expect(markAllRead).toHaveCount(0);
    await expect(notification.locator('.workbench-notification-badge')).toHaveCount(0);
    await expect(panel.locator('.workbench-notification-list > li')).toHaveCount(30);
    expect(await page.evaluate(() => history.length)).toBe(length);
    await panel.locator('.workbench-notification-list > li').last().scrollIntoViewIfNeeded();
    await expect(panel).toBeVisible();
    expect(await panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('notification-menu.png') });
    await page.goBack();
    await expect(panel).toHaveCount(0);
    await expect(page).toHaveURL(route);
    await expect(notification).toHaveAttribute('aria-expanded', 'false');

    for (const view of ['nodes', 'management', 'settings']) {
      const menu = page.locator(
        `.nav-menu-button:has([data-mar-icon="${view === 'nodes' ? 'workspace' : view === 'management' ? 'administration' : 'settings'}"])`
      );
      await menu.click();
      await expect(panel).toBeVisible();
      await menu.click();
      await expect(panel).toHaveCount(0);
    }
    await notification.click();
    await expect(panel).toBeVisible();
    await page
      .getByRole('button', { name: 'Close menu', exact: true })
      .click({ position: { x: scenario.width - 10, y: 10 } });
    await expect(panel).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
  });
}

test('Mobile menus preserve shared tokens, reduced motion, focus and transient previews', async ({
  page
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`${fixture.url}workbench-mobile-drawer.html`);
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--mar-bg-panel', '#243247')
  );
  const trigger = page.getByRole('button', { name: 'Open notification center', exact: true });
  const panel = page.locator('.workspace-tree.mobile-open');
  await trigger.click();
  await expect(panel).toHaveCSS('background-color', 'rgb(36, 50, 71)');
  await expect(panel).toHaveCSS('transition-duration', '0s');
  await page.keyboard.press('Tab');
  expect(await panel.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.getByRole('button', { name: 'Preview notification' }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.workbench-notification-list > li')).toHaveCount(1);
  await trigger.click();
  await expect(panel.locator('.workbench-notification-list > li')).toHaveCount(31);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(panel).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => history.state?.__marMobileMenu)).toBeUndefined();
  await page.getByRole('button', { name: 'Recent Sessions', exact: true }).click();
  await expect(page.locator('.recent-sessions-popover:visible')).toBeVisible();
  await expect(page.locator('.recent-sessions-popover .recent-sessions-list > li')).toHaveCount(30);
});

test('Mobile menu history coalesces rapid reopening and preserves the selected route on browser Back', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`${fixture.url}workbench-mobile-drawer.html`);
  await page.evaluate(() => history.replaceState({ foreign: 'keep' }, ''));
  const recent = page.getByRole('button', { name: 'Recent Sessions', exact: true });
  const panel = page.locator('.workspace-tree.mobile-open');
  await recent.click();
  await expect(panel).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(history.state?.__marMobileMenu))).toBe(true);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.addEventListener('popstate', () => resolve(), { once: true });
        const trigger = document.querySelector<HTMLButtonElement>('.recent-sessions-trigger')!;
        trigger.click();
        queueMicrotask(() => trigger.click());
      })
  );
  await expect(panel).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(history.state?.__marMobileMenu))).toBe(true);
  expect(await page.evaluate(() => history.state.foreign)).toBe('keep');
  const length = await page.evaluate(() => history.length);
  const settings = page.locator('.nav-menu-button:has([data-mar-icon="settings"])');
  await settings.click();
  await expect(panel.locator('.settings-nav')).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.goBack();
  await expect(panel).toHaveCount(0);
  await expect(settings).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(/view=settings/);
  expect(await page.evaluate(() => history.state.foreign)).toBe('keep');
  await settings.click();
  await expect(panel).toBeVisible();
  await expect(panel.locator('.mobile-menu-header button')).toHaveCount(0);
  await settings.click();
  await expect(panel).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => history.state?.__marMobileMenu)).toBeUndefined();
});

test('Reopening a menu after browser Forward reuses its inactive history entry', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`${fixture.url}workbench-mobile-drawer.html`);
  const recent = page.getByRole('button', { name: 'Recent Sessions', exact: true });
  const panel = page.locator('.workspace-tree.mobile-open');
  const route = page.url();
  await recent.click();
  await expect(panel).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(history.state?.__marMobileMenu))).toBe(true);
  const length = await page.evaluate(() => history.length);
  await page.goBack();
  await expect(panel).toHaveCount(0);
  await page.goForward();
  await expect(panel).toHaveCount(0);
  await recent.click();
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.goBack();
  await expect(panel).toHaveCount(0);
  await expect(page).toHaveURL(route);
});

test('Escape closes only the visible layer after Quick Open has been closed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`${fixture.url}workbench-mobile-drawer.html`);
  const quickOpen = page.getByRole('button', { name: 'Open quick open', exact: true });
  await quickOpen.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.el-overlay-dialog')).toHaveCount(1);
  await expect(page.locator('.el-overlay-dialog')).not.toBeVisible();
  const notification = page.getByRole('button', { name: 'Open notification center', exact: true });
  const menu = page.locator('.workspace-tree.mobile-open');
  await notification.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await notification.click();
  await expect(menu).toBeVisible();
  await page.mouse.move(380, 690);
  // Exercise the dialog intent while the menu scrim owns pointer interaction.
  await quickOpen.evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.el-overlay-dialog')).not.toBeVisible();
  await expect(menu).toBeVisible();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});
