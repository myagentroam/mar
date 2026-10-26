import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('Desktop notification panels cover resize handles without disabling uncovered dragging', async ({
  page
}) => {
  await page.setViewportSize({ width: 800, height: 800 });
  await page.goto(`${fixture.url}workbench-mobile-drawer.html`);
  await page.locator('html').evaluate((element) => {
    element.style.setProperty('--mar-workbench-sidebar-width', '400px');
    element.style.setProperty('--mar-workbench-sidebar-total-width', '448px');
  });
  const handle = page.locator('.workspace-tree-resize');
  await expect(handle).toBeVisible();
  await page.getByRole('button', { name: 'Open notification center', exact: true }).click();
  const panel = page.locator('.workbench-notification-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveCSS('transform', 'none');
  const handleBounds = (await handle.boundingBox())!;
  const panelBounds = (await panel.boundingBox())!;
  const x = handleBounds.x + handleBounds.width / 2;
  const y = panelBounds.y + 20;
  expect(x).toBeGreaterThan(panelBounds.x);
  expect(x).toBeLessThan(panelBounds.x + panelBounds.width);
  await page.mouse.move(x, y);
  expect(
    await panel.evaluate(
      (element, point) => element.contains(document.elementFromPoint(point.x, point.y)),
      { x, y }
    )
  ).toBe(true);
  await expect
    .poll(() => handle.evaluate((element) => getComputedStyle(element, '::before').backgroundColor))
    .toBe('rgba(0, 0, 0, 0)');
  await page.mouse.down();
  await expect(handle).not.toHaveClass(/dragging/);
  await page.mouse.up();
  await expect(panel).toBeVisible();

  const uncoveredY = panelBounds.y + panelBounds.height + 3;
  expect(uncoveredY).toBeLessThan(handleBounds.y + handleBounds.height);
  await page.mouse.move(x, uncoveredY);
  await page.mouse.down();
  await expect(handle).toHaveClass(/dragging/);
  await page.mouse.move(x + 10, uncoveredY);
  await page.mouse.up();
  await expect(handle).not.toHaveClass(/dragging/);
  await expect(panel).toHaveCount(0);
});

test('Touch highlights stay transparent on menus, scrims and preview overlays', async ({
  browser
}) => {
  const context = await browser.newContext({
    isMobile: true,
    hasTouch: true,
    viewport: { width: 390, height: 844 }
  });
  try {
    const page = await context.newPage();
    for (const theme of ['daylight', 'vscode-dark-2026']) {
      await page.goto(`${fixture.url}workbench-mobile-drawer.html?locale=en-US&theme=${theme}`);
      const notification = page.getByRole('button', {
        name: 'Open notification center',
        exact: true
      });
      for (const control of [
        page.locator('html'),
        notification,
        page.getByRole('link', { name: 'Help', exact: true })
      ])
        await expect(control).toHaveCSS('-webkit-tap-highlight-color', 'rgba(0, 0, 0, 0)');
      await notification.tap();
      const menu = page.locator('.workspace-tree.mobile-open');
      await expect(menu).toBeVisible();
      const scrim = page.locator('.sidebar-scrim');
      await expect(scrim).toHaveCSS('-webkit-tap-highlight-color', 'rgba(0, 0, 0, 0)');
      await scrim.tap({ position: { x: 380, y: 10 } });
      await expect(menu).toHaveCount(0);
      await expect(page.getByLabel('Opened target')).toHaveText('');

      await notification.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(notification).toBeFocused();
      await expect(notification).toHaveCSS('outline-style', 'solid');
      await expect(notification).toHaveCSS('outline-width', '2px');

      await page.getByRole('button', { name: 'Open image preview', exact: true }).tap();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(page.locator('.el-overlay').filter({ has: dialog })).toHaveCSS(
        '-webkit-tap-highlight-color',
        'rgba(0, 0, 0, 0)'
      );
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
  } finally {
    await context.close();
  }
});

for (const theme of ['daylight', 'midnight']) {
  test(`Read-all is neutral while expanded navigation stays branded in ${theme}`, async ({
    page
  }, testInfo) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.url}workbench-mobile-drawer.html?locale=en-US&theme=${theme}`);
      const colors = await page.locator('html').evaluate((element) => {
        const probe = document.createElement('span');
        element.append(probe);
        const color = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const result = {
          normal: color('--mar-text-secondary'),
          hover: color('--mar-text-primary'),
          brand: color('--mar-color-brand-text'),
          focus: color('--mar-color-brand')
        };
        probe.style.fontSize = 'var(--mar-font-size-meta)';
        const meta = getComputedStyle(probe).fontSize;
        probe.remove();
        return { ...result, meta };
      });
      const recent = page.locator('.recent-sessions-trigger');
      await recent.click();
      await expect(recent).toHaveAttribute('aria-expanded', 'true');
      await expect(recent).toHaveCSS('color', colors.brand);
      const bell = page.getByRole('button', { name: 'Open notification center', exact: true });
      await bell.click();
      await expect(recent).toHaveAttribute('aria-expanded', 'false');
      if (width < 768) await expect(bell).toHaveCSS('color', colors.brand);
      const markAll = page.getByRole('button', { name: 'Mark all as read', exact: true });
      await page.mouse.move(0, 0);
      await expect(markAll).toHaveCSS('color', colors.normal);
      await expect(markAll).toHaveCSS('font-size', colors.meta);
      await markAll.hover();
      await expect(markAll).toHaveCSS('color', colors.hover);
      await expect(markAll).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await markAll.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(markAll).toHaveCSS('outline-color', colors.focus);
      await expect(markAll).toHaveCSS('outline-style', 'solid');
      await page.screenshot({ path: testInfo.outputPath(`read-all-${width}.png`) });
      await markAll.click();
      await expect(page.locator('.workbench-notification-list .el-tag')).toHaveCount(0);
      await expect(page.locator('.workbench-notification-list > li')).toHaveCount(30);
    }
  });

  test(`Help shares notification utility colors without changing link behavior in ${theme}`, async ({
    browser
  }, testInfo) => {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width < 768,
        hasTouch: width < 768
      });
      try {
        await context.route('**/help/**', (route) =>
          route.fulfill({ contentType: 'text/html', body: '<title>Help</title>' })
        );
        const page = await context.newPage();
        await page.goto(`${fixture.url}workbench-mobile-drawer.html?locale=en-US&theme=${theme}`);
        const help = page.getByRole('link', { name: 'Help', exact: true });
        const bell = page.getByRole('button', { name: 'Open notification center', exact: true });
        await expect(help).toHaveAttribute('href', /getting-started\/overview/);
        await expect(help).toHaveAttribute('target', '_blank');
        await expect(help).toHaveAttribute('rel', 'noopener noreferrer');
        for (const custom of [false, true]) {
          if (custom)
            await page.locator('html').evaluate((element) => {
              element.style.setProperty('--mar-text-primary', '#d6dfc9');
              element.style.setProperty('--mar-text-secondary', '#8295a4');
              element.style.setProperty('--mar-color-brand', '#9672d1');
              element.style.setProperty('--mar-color-brand-text', '#af79d0');
            });
          const colors = await help.evaluate((element) => {
            const probe = document.createElement('span');
            element.append(probe);
            const color = (token: string) => {
              probe.style.color = `var(${token})`;
              return getComputedStyle(probe).color;
            };
            const result = {
              normal: color('--mar-text-secondary'),
              hover: color('--mar-text-primary'),
              hoverBackground: color('--mar-fill-row-hover'),
              focus: color('--mar-color-brand')
            };
            probe.remove();
            return result;
          });
          for (const control of [help, bell]) {
            await page.mouse.move(0, 0);
            await expect(control).toHaveCSS('color', colors.normal);
            await control.hover();
            await expect(control).toHaveCSS('color', colors.hover);
            await expect(control).toHaveCSS(
              'background-color',
              control === bell && width < 768 ? colors.hoverBackground : 'rgba(0, 0, 0, 0)'
            );
            await control.focus();
            await page.keyboard.press('Tab');
            await page.keyboard.press('Shift+Tab');
            await expect(control).toBeFocused();
            await expect(control).toHaveCSS('color', colors.hover);
            await expect(control).toHaveCSS('outline-color', colors.focus);
            await expect(control).toHaveCSS('outline-width', '2px');
          }
          if (!custom)
            await page.screenshot({ path: testInfo.outputPath(`help-${theme}-${width}.png`) });
        }
      } finally {
        await context.close();
      }
    }
  });
}

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
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
        const panel = element.closest('.workbench-notification-panel')!;
        await Promise.all(
          [
            ...(panel.closest('.workspace-tree')?.getAnimations() ?? []),
            ...panel.getAnimations()
          ].map((animation) => animation.finished)
        );
      });
      const tokens = await remove.evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.cssText =
          'position:absolute;color:var(--mar-text-primary);background:transparent;border-color:var(--mar-color-brand)';
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
      await expect(remove).toHaveCSS('outline-offset', '2px');
      await expect(remove).toHaveCSS('color', tokens.foreground);
      await expect(remove).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

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
    await expect(panel.locator('.mobile-menu-header')).toHaveCount(0);
    await expect(panel).toHaveAccessibleName(
      scenario.locale === 'zh-CN' ? '最近会话' : 'Recent Sessions'
    );
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect
      .poll(() => panel.evaluate((element) => element.getBoundingClientRect().x))
      .toBeCloseTo(0, 0);
    const bounds = (await panel.boundingBox())!;
    const railBounds = (await page.locator('.activity-rail').boundingBox())!;
    expect(bounds.width).toBeCloseTo(Math.min(300, scenario.width - 48), 3);
    expect(bounds.y).toBeCloseTo(railBounds.y + railBounds.height, 1);
    expect(bounds.y + bounds.height).toBeCloseTo(scenario.height, 1);
    await page.screenshot({ path: testInfo.outputPath('recent-menu.png') });
    await recent.click();
    await expect(panel).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => history.state?.__marTemporaryLayer))
      .toBeUndefined();

    await recent.click();
    await expect(panel).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => Boolean(history.state?.__marTemporaryLayer)))
      .toBe(true);
    const length = await page.evaluate(() => history.length);
    await notification.click();
    await expect(panel.locator('.workbench-notification-list > li')).toHaveCount(30);
    await expect(panel.locator('.recent-sessions-list')).toHaveCount(0);
    await expect(panel.locator('.mobile-menu-header')).toHaveCount(0);
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
      await expect(panel.locator('.mobile-menu-header')).toHaveCount(0);
      await expect(panel).toHaveAccessibleName(/.+/u);
      await menu.click();
      await expect(panel).toHaveCount(0);
    }
    await notification.click();
    await expect(panel).toBeVisible();
    await page.locator('.sidebar-scrim').click({ position: { x: scenario.width - 10, y: 10 } });
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
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--mar-bg-panel', '#243247');
    document.documentElement.style.setProperty('--mar-border-subtle', '#43546b');
  });
  const trigger = page.getByRole('button', { name: 'Open notification center', exact: true });
  const panel = page.locator('.workspace-tree.mobile-open');
  await trigger.click();
  await expect(panel).toHaveCSS('background-color', 'rgb(36, 50, 71)');
  await expect(panel).toHaveCSS('border-right-color', 'rgb(67, 84, 107)');
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
  await expect.poll(() => page.evaluate(() => history.state?.__marTemporaryLayer)).toBeUndefined();
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
  await expect
    .poll(() => page.evaluate(() => Boolean(history.state?.__marTemporaryLayer)))
    .toBe(true);
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
  await expect
    .poll(() => page.evaluate(() => Boolean(history.state?.__marTemporaryLayer)))
    .toBe(true);
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
  await expect(panel.locator('.mobile-menu-header')).toHaveCount(0);
  await settings.click();
  await expect(panel).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => history.state?.__marTemporaryLayer)).toBeUndefined();
});

test('Forward does not revive a menu and reopening owns a new temporary entry', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`${fixture.url}workbench-mobile-drawer.html`);
  const recent = page.getByRole('button', { name: 'Recent Sessions', exact: true });
  const panel = page.locator('.workspace-tree.mobile-open');
  const route = page.url();
  await recent.click();
  await expect(panel).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Boolean(history.state?.__marTemporaryLayer)))
    .toBe(true);
  const length = await page.evaluate(() => history.length);
  await page.goBack();
  await expect(panel).toHaveCount(0);
  await page.goForward();
  await expect(panel).toHaveCount(0);
  await recent.click();
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
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
  await expect(page.locator('.el-overlay-dialog')).toHaveCount(0);
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

test('Mobile menus animate in Chat, preserve their leaving content and isolate scroll and focus', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto(`${fixture.url}workbench-mobile-drawer.html`);
  await page.locator('.nav-menu-button:has([data-mar-icon="conversation"])').click();
  const notifications = page.getByRole('button', { name: 'Open notification center', exact: true });
  await page.evaluate(() => {
    (window as Window & { menuTransitions?: string[] }).menuTransitions = [];
    document.addEventListener('transitionrun', (event) => {
      if ((event.target as Element).matches('.workspace-tree'))
        (window as Window & { menuTransitions: string[] }).menuTransitions.push(event.propertyName);
    });
  });
  await notifications.click();
  const drawer = page.locator('.workspace-tree');
  await expect(drawer).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as Window & { menuTransitions: string[] }).menuTransitions.includes('transform')
      )
    )
    .toBe(true);
  await drawer.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
    element.scrollTop = element.scrollHeight;
  });
  await page.getByRole('button', { name: 'Recent Sessions', exact: true }).click();
  await expect.poll(() => drawer.evaluate((element) => element.scrollTop)).toBe(0);
  for (let index = 0; index < 45; index++) {
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() =>
        Boolean(document.activeElement?.closest('.workspace-tree, .activity-rail'))
      )
    ).toBe(true);
  }
  // Closing and observing in one browser task proves the content is retained
  // before the leave transition ends, rather than testing only the final state.
  const leaving = await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('.recent-sessions-trigger')!.click();
    return new Promise<{ label: string | null; entries: number; scrim: boolean }>((resolve) => {
      requestAnimationFrame(() =>
        resolve({
          label: document.querySelector('.workspace-tree')?.getAttribute('aria-label') ?? null,
          entries: document.querySelectorAll('.recent-sessions-list > li').length,
          scrim: document.querySelector('.sidebar-scrim') !== null
        })
      );
    });
  });
  expect(leaving.label).toBe('Recent Sessions');
  expect(leaving.entries).toBe(30);
  expect(leaving.scrim).toBe(true);
  await expect(drawer).not.toBeVisible();

  for (const [label, entry] of [
    ['Settings', 'Account'],
    ['Admin', 'System']
  ] as const) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(drawer.getByRole('button', { name: entry, exact: true })).toBeVisible();
    const leavingNavigation = await page.evaluate((name) => {
      const trigger = [...document.querySelectorAll<HTMLButtonElement>('.nav-menu-button')].find(
        (button) => button.getAttribute('aria-label') === name
      );
      trigger!.click();
      return new Promise<{ active: boolean; entries: string[] }>((resolve) => {
        requestAnimationFrame(() =>
          resolve({
            active: document
              .querySelector('.workspace-tree')!
              .classList.contains('mobile-menu-leave-active'),
            entries: [...document.querySelectorAll('.settings-nav button')].map(
              (button) => button.textContent?.trim() ?? ''
            )
          })
        );
      });
    }, label);
    expect(leavingNavigation.active).toBe(true);
    expect(leavingNavigation.entries).toContain(entry);
    await expect(drawer).not.toBeVisible();
  }
});

test('Closing a mobile menu does not refocus a background editor', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto(`${fixture.url}workbench-mobile-drawer.html`);
  const input = page.getByRole('textbox', { name: 'Background input', exact: true });
  await input.focus();
  await page.getByRole('button', { name: 'Recent Sessions', exact: true }).evaluate((element) => {
    // A touch activation or shortcut need not focus the menu trigger first.
    element.click();
  });
  const drawer = page.locator('.workspace-tree.mobile-open');
  await expect(drawer).toBeFocused();
  await page.goBack();
  await expect(drawer).toHaveCount(0);
  await expect(input).not.toBeFocused();
  await expect(page.locator('.activity-rail button').first()).toBeFocused();
});

test('Mobile image, guarded details, prompt and alert return through only the top layer', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto(`${fixture.url}workbench-mobile-drawer.html`);
  const initialState = await page.evaluate(() => history.state);
  await page.getByRole('button', { name: 'Open image preview', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => history.state)).toEqual(initialState);

  await page.getByRole('button', { name: 'Open guarded details', exact: true }).click();
  await page.getByRole('textbox', { name: 'Draft', exact: true }).fill('Keep edited draft');
  await page.goBack();
  const confirmation = page.getByRole('dialog', { name: 'Confirm discard', exact: true });
  await expect(confirmation).toBeVisible();
  await page.goBack();
  await expect(confirmation).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue(
    'Keep edited draft'
  );
  await page.goBack();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Draft', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => history.state)).toEqual(initialState);

  for (const type of ['prompt', 'alert']) {
    await page.getByRole('button', { name: `Open ${type}`, exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Notice', exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('dialog', { name: 'Notice', exact: true })).not.toBeVisible();
    await expect(page.getByLabel('Opened target')).toHaveText('cancelled');
    await expect.poll(() => page.evaluate(() => history.state)).toEqual(initialState);
  }
});

for (const source of ['conversation', 'attachment']) {
  for (const shape of ['small', 'landscape', 'portrait']) {
    test(`Image previews fit without upscaling ${source} ${shape} and preserve mobile return`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(
        `${fixture.url}workbench-mobile-drawer.html?image=${shape}${source === 'attachment' ? '&attachment=1' : ''}`
      );
      const initialState = await page.evaluate(() => history.state);
      await page.getByRole('button', { name: 'Open image preview', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Sample image', exact: true });
      const surface = dialog.locator('.attachment-preview-dialog');
      await surface.evaluate((el: HTMLElement) =>
        el.style.setProperty('--mar-control-bg-color-overlay', '#173b4a')
      );
      await expect(surface).toHaveCSS('background-color', 'rgb(23, 59, 74)');
      const image = dialog.getByRole('img', { name: 'Sample image', exact: true });
      await expect(image).toBeVisible();
      await expect
        .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
      await expect(surface).toHaveCSS('width', '960px');
      await expect(surface).toHaveCSS('height', '760px');
      await expect.poll(async () => Math.round((await surface.boundingBox())!.y)).toBe(160);
      const bounds = (await surface.boundingBox())!;
      expect(bounds.x).toBeCloseTo(480, 0);
      expect(bounds.y).toBeCloseTo(160, 0);

      const assertImageFits = async () => {
        const sizes = await image.evaluate((el) => {
          const img = el as HTMLImageElement;
          const body = img.parentElement!;
          const css = getComputedStyle(body);
          const width =
            body.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
          const height =
            body.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
          const bounds = img.getBoundingClientRect();
          return {
            width,
            height,
            displayedWidth: bounds.width,
            displayedHeight: bounds.height,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight
          };
        });
        const scale = Math.min(
          1,
          sizes.width / sizes.naturalWidth,
          sizes.height / sizes.naturalHeight
        );
        expect(sizes.displayedWidth).toBeCloseTo(sizes.naturalWidth * scale, 0);
        expect(sizes.displayedHeight).toBeCloseTo(sizes.naturalHeight * scale, 0);
      };
      await assertImageFits();
      const handle = await image.elementHandle();
      await page.setViewportSize({ width: 390, height: 760 });
      await expect(surface).toHaveCSS('width', '390px');
      await expect(surface).toHaveCSS('height', '760px');
      await expect(surface).toHaveCSS('border-radius', '0px');
      expect(await handle!.evaluate((el) => el.isConnected)).toBe(true);
      await assertImageFits();
      if (source === 'conversation' && shape === 'portrait') {
        await page.screenshot({ path: testInfo.outputPath('mobile-image-preview.png') });
      }
      await page.goBack();
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => history.state)).toEqual(initialState);
      await page.getByRole('button', { name: 'Open image preview', exact: true }).click();
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => history.state)).toEqual(initialState);
      if (shape === 'small') {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.getByRole('button', { name: 'Open image preview', exact: true }).click();
        await expect(dialog).toBeVisible();
        await image.click();
        await expect(dialog).toBeVisible();
        const imageBounds = (await image.boundingBox())!;
        await page.mouse.move(
          imageBounds.x + imageBounds.width / 2,
          imageBounds.y + imageBounds.height / 2
        );
        await page.mouse.down();
        await page.mouse.move(8, 8);
        await page.mouse.up();
        await expect(dialog).toBeVisible();
        await dialog.click({ position: { x: 8, y: 8 } });
        await expect(dialog).toHaveCount(0);
        await page.getByRole('button', { name: 'Open image preview', exact: true }).click();
        await expect(image).toBeVisible();
      }
    });
  }
}
