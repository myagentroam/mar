import { expect, test, type Locator, type Page } from '@playwright/test';
import { resolvedColorToHex } from '../../packages/web-core/src/util/theme-palette.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

// @test-covers packages/web-core/src/styles/mar-ui-theme.css
// @test-covers packages/web-core/src/view/workbench/WorkbenchActivityCenter.vue
// @test-covers packages/web-core/src/view/workbench/WorkbenchRecentSessionList.vue
// @test-covers packages/web-core/src/view/session/session-markers.css

test.use({ hasTouch: true });
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/workbench-mobile-drawer.html');
});
test.afterAll(async () => fixture.close());

async function expectActivityElevation(popover: Locator, theme: string) {
  const dark = theme === 'vscode-dark-2026';
  await expect(popover).toBeVisible();
  const background = await popover.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(resolvedColorToHex(background)).toBe(dark ? '#2b2b2b' : '#ffffff');
  await expect(popover).toHaveCSS('border-top-width', '1px');
  await expect(popover).toHaveCSS(
    'border-top-color',
    dark ? 'rgb(71, 71, 71)' : 'rgb(201, 201, 201)'
  );
  await expect(popover).toHaveCSS('border-top-left-radius', '12px');
  await expect(popover).toHaveCSS('box-shadow', /0px 10px 24px/u);
}

async function expectActivityPanels(panel: Locator, activeTab: Locator) {
  const tabs = panel.locator('.activity-tabs [role="tab"]');
  await expect(tabs).toHaveCount(2);
  await expect(panel.locator('[role="tabpanel"]')).toHaveCount(2);
  await expect(panel.getByRole('tabpanel')).toHaveCount(1);
  await expect(panel.locator('[role="tabpanel"]:visible')).toHaveCount(1);
  const identities = await tabs.evaluateAll((elements) =>
    elements.map((element) => ({ tab: element.id, panel: element.getAttribute('aria-controls')! }))
  );
  const activeId = await activeTab.getAttribute('id');
  for (const identity of identities) {
    expect(identity.tab).not.toBe('');
    expect(identity.panel).toBeTruthy();
    await expect(panel.page().locator(`[id="${identity.tab}"]`)).toHaveCount(1);
    const target = panel.page().locator(`[id="${identity.panel}"]`);
    await expect(target).toHaveCount(1);
    await expect(target).toHaveAttribute('role', 'tabpanel');
    await expect(target).toHaveAttribute('aria-labelledby', identity.tab);
    if (identity.tab === activeId) {
      await expect(target).toBeVisible();
      expect(await target.getByRole('button').count()).toBeGreaterThan(0);
    } else {
      await expect(target).toBeHidden();
      await expect(target).toHaveCSS('display', 'none');
      // Only the stable shell survives: inactive list controls cannot retain focus.
      await expect(target.locator('button, input, a, [tabindex]')).toHaveCount(0);
      await expect(target).toBeEmpty();
    }
  }
  return identities;
}

async function prepareActivityInteraction(page: Page, width = 1280) {
  await page.setViewportSize({ width, height: 760 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${fixture.url}workbench-mobile-drawer.html?locale=en-US`);
  await expect(page.locator('.activity-entry-count')).toHaveText('30');
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  return {
    entry: page.locator('.activity-center-trigger'),
    panel: page.locator('.workbench-activity-panel:visible')
  };
}

test('Activity hover never opens the panel or changes focus', async ({ page }) => {
  const { entry, panel } = await prepareActivityInteraction(page);
  const input = page.getByRole('textbox', { name: 'Background input' });
  await input.focus();
  await entry.hover();
  await page.clock.runFor(100);
  await expect(entry).toHaveAttribute('aria-expanded', 'false');
  await page.mouse.move(900, 650);
  await page.clock.runFor(500);
  await expect(panel).toHaveCount(0);

  await entry.hover();
  await page.clock.runFor(500);
  await expect(panel).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(page.locator('.mar-tooltip:visible')).toHaveCount(0);
  await page.mouse.move(900, 650);
  await page.clock.runFor(500);
  await expect(panel).toHaveCount(0);
  await expect(entry).toHaveAttribute('aria-expanded', 'false');
});

test('Activity clicks toggle the custom panel and pointer movement keeps its selected page', async ({
  page
}) => {
  const { entry, panel } = await prepareActivityInteraction(page);
  await entry.click();
  await expect(panel).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await panel.getByRole('tab', { name: 'Recent Sessions', exact: true }).click();
  await panel.hover();
  await expect(panel.getByRole('tab', { name: 'Recent Sessions', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await page.mouse.move(900, 650);
  await page.clock.runFor(500);
  await expect(panel).toBeVisible();
  await entry.click();
  await page.clock.runFor(500);
  await expect(panel).toHaveCount(0);
  await entry.click();
  await expect(panel).toBeVisible();
  await page.mouse.click(900, 650);
  await page.clock.runFor(500);
  await expect(panel).toHaveCount(0);
});

test('Activity shortcuts toggle the panel without moving focus or displaying a tooltip', async ({
  page
}) => {
  const { entry, panel } = await prepareActivityInteraction(page);
  const input = page.getByRole('textbox', { name: 'Background input' });
  await input.focus();
  for (const shortcut of ['Control+Shift+E', 'Meta+Shift+E']) {
    await page.keyboard.press(shortcut);
    await page.clock.runFor(500);
    await expect(panel).toBeVisible();
    await expect(input).toBeFocused();
    await expect(entry).not.toBeFocused();
    expect(await entry.evaluate((element) => element.matches(':focus-visible'))).toBe(false);
    await expect(page.locator('.mar-tooltip:visible')).toHaveCount(0);
    await page.keyboard.press(shortcut);
    await page.clock.runFor(500);
    await expect(panel).toHaveCount(0);
    await expect(input).toBeFocused();
  }
  await entry.hover();
  await page.clock.runFor(500);
  await expect(panel).toHaveCount(0);
  await page.keyboard.press('Control+Shift+E');
  await page.mouse.move(900, 650);
  await page.clock.runFor(500);
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await page.clock.runFor(500);
  await expect(panel).toHaveCount(0);
  await expect(input).toBeFocused();
});

test('Activity Tab navigation retains a visible focus ring and keyboard activation', async ({
  page
}) => {
  const { entry, panel } = await prepareActivityInteraction(page);
  await entry.focus();
  await page.keyboard.press('Tab');
  await expect(entry).not.toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(entry).toBeFocused();
  expect(await entry.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
  await expect(entry).toHaveCSS('outline-style', 'solid');
  await expect(entry).toHaveCSS('outline-width', '2px');
  for (const key of ['Enter', 'Space']) {
    await page.keyboard.press(key);
    await page.clock.runFor(500);
    await expect(panel).toBeVisible();
    await expect(entry).toBeFocused();
    await page.keyboard.press('Escape');
    await page.clock.runFor(500);
    await expect(panel).toHaveCount(0);
    await expect(entry).toBeFocused();
  }
});

test('Activity pointer movement cannot reopen panels after Escape or layout changes', async ({
  page
}) => {
  const { entry, panel } = await prepareActivityInteraction(page);
  await entry.click();
  await expect(panel).toBeVisible();
  await entry.hover();
  await page.keyboard.press('Escape');
  await page.clock.runFor(500);
  await expect(panel).toHaveCount(0);
  await page.mouse.move(900, 650);
  await entry.click();
  await expect(panel).toBeVisible();
  await page.setViewportSize({ width: 390, height: 760 });
  await page.clock.runFor(500);
  await expect(panel).toHaveCount(0);
  await entry.hover();
  await page.clock.runFor(500);
  await expect(panel).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.clock.runFor(500);
  await expect(panel).toHaveCount(0);
});

for (const width of [1280, 390]) {
  test(`Activity touch keeps explicit opening and closing at ${width}px`, async ({ page }) => {
    const { entry, panel } = await prepareActivityInteraction(page, width);
    await entry.focus();
    await entry.dispatchEvent('pointerenter', { pointerType: 'touch' });
    await page.clock.runFor(500);
    await expect(panel).toHaveCount(0);
    await expect(page.locator('.mar-tooltip:visible')).toHaveCount(0);
    if (width < 768) {
      await entry.hover();
      await page.clock.runFor(500);
      await expect(panel).toHaveCount(0);
    }
    await entry.tap();
    await expect(panel).toBeVisible();
    await entry.dispatchEvent('pointerleave', { pointerType: 'touch' });
    await page.clock.runFor(500);
    await expect(panel).toBeVisible();
    await entry.tap();
    await page.clock.runFor(500);
    await expect(panel).toHaveCount(0);
  });
}

test('Aggregated notifications preserve upload recovery, removal and cancellation intents', async ({
  page
}) => {
  await page.goto(`${fixture.url}workbench-mobile-drawer.html?locale=en-US&read=1&uploads=1`);
  await page.locator('.activity-center-trigger').click();
  await page.getByRole('tab', { name: 'Notifications', exact: true }).click();
  const tasks = page.locator('.workbench-notification-upload');
  await expect(tasks).toHaveCount(2);
  await expect(tasks.first()).toHaveCSS('border-top-width', '0px');
  await expect(tasks.last()).toHaveCSS('border-top-width', '1px');
  await expect(page.locator('.workbench-notification-list > li').first()).toHaveCSS(
    'border-top-width',
    '1px'
  );
  const opened = page.getByLabel('Opened target');
  await tasks.first().getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(opened).toHaveText('retry:FAILED');
  await tasks.first().getByRole('button', { name: 'Delete report.txt', exact: true }).click();
  await expect(opened).toHaveText('remove:FAILED');
  await tasks.last().getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(opened).toHaveText('cancel:UPLOADING');
  await page
    .locator('.workbench-notification-list > li')
    .first()
    .getByRole('button')
    .first()
    .click();
  await expect(opened).toHaveText('notification-0');
  await expect(page.locator('.workbench-activity-panel')).toHaveCount(0);
});

test('Activity entry distinguishes all four states and caps unread counts', async ({ page }) => {
  for (const [query, count, running] of [
    ['many-notifications=1', '99+', true],
    ['stopped=1', '30', false],
    ['read=1', '', true],
    ['read=1&stopped=1', '', false]
  ] as const) {
    await page.goto(`${fixture.url}workbench-mobile-drawer.html?locale=en-US&${query}`);
    const entry = page.locator('.activity-center-trigger');
    await expect(
      page.getByRole('button', { name: 'Preview notification', exact: true })
    ).toBeVisible();
    if (count) await expect(entry.locator('.activity-entry-count')).toHaveText(count);
    else await expect(entry.locator('.activity-entry-count')).toHaveCount(0);
    await expect(entry.locator('.activity-entry-running')).toHaveCount(running ? 1 : 0);
    await entry.click();
    await expect(
      page.getByRole('tab', { name: count ? 'Notifications' : 'Recent Sessions', exact: true })
    ).toHaveAttribute('aria-selected', 'true');
  }
});

for (const width of [1280, 390]) {
  for (const theme of ['daylight', 'vscode-dark-2026']) {
    test(`Activity tabs share MarTabs workbench styling and preserve keyboard activation at ${width}px ${theme}`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 850 });
      await page.goto(`${fixture.url}workbench-mobile-drawer.html?locale=en-US&theme=${theme}`);
      const trigger = page.locator('.activity-center-trigger');
      await trigger.click();
      const panel = page.locator('.workbench-activity-panel:visible');
      const tabs = panel.locator('.activity-tabs .mar-ui-tabs__header');
      const recent = tabs.getByRole('tab', { name: 'Recent Sessions', exact: true });
      const notifications = tabs.getByRole('tab', { name: 'Notifications', exact: true });
      await expect(notifications).toHaveAttribute('aria-selected', 'true');
      const identities = await expectActivityPanels(panel, notifications);
      for (const target of [recent, notifications]) {
        await target.click();
        await expect(target).toHaveAttribute('aria-selected', 'true');
        expect(await expectActivityPanels(panel, target)).toEqual(identities);
        await page.keyboard.press('Tab');
        expect(
          await panel
            .getByRole('tabpanel')
            .evaluate((element) => element.contains(document.activeElement))
        ).toBe(true);
      }
      await expect(notifications.locator('..')).toHaveCSS('border-top-width', '1px');
      await expect(tabs).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const colors = await tabs.evaluate((element) => {
        const probe = document.createElement('span');
        element.append(probe);
        probe.style.color = 'var(--mar-bg-tab-inactive)';
        const inactive = getComputedStyle(probe).color;
        probe.style.color = 'var(--mar-fill-selection)';
        const selected = getComputedStyle(probe).color;
        probe.remove();
        return { inactive, selected };
      });
      await expect(recent.locator('..')).toHaveCSS('background-color', colors.inactive);
      await expect(notifications.locator('..')).toHaveCSS('background-color', colors.selected);
      const overlap = await recent.evaluate((element) => {
        const row = element.parentElement!;
        return (
          row.getBoundingClientRect().right - row.nextElementSibling!.getBoundingClientRect().left
        );
      });
      expect(overlap).toBeCloseTo(1, 1);
      await notifications.focus();
      for (const key of ['ArrowLeft', 'End', 'Home', 'ArrowRight']) {
        const target = key === 'ArrowLeft' || key === 'Home' ? recent : notifications;
        await page.keyboard.press(key);
        await expect(target).toBeFocused();
        await expect(target).toHaveAttribute('aria-selected', 'true');
        expect(await expectActivityPanels(panel, target)).toEqual(identities);
        await expect(trigger.locator('.activity-entry-count')).toHaveText('30');
      }
      await expect(tabs.locator('.activity-unread-count')).toHaveText('30');
      await tabs.screenshot({ path: testInfo.outputPath(`activity-tabs-${width}-${theme}.png`) });
      await recent.click();
      await recent.evaluate((element) => (element as HTMLElement).blur());
      await page.mouse.move(width - 1, 849);
      await expect(page.locator('.mar-tooltip:visible')).toHaveCount(0);
      if (width >= 768) {
        await expectActivityElevation(page.locator('.workbench-activity-popover:visible'), theme);
      } else {
        await expect(page.locator('.workbench-activity-popover:visible')).toHaveCount(0);
        await expect(panel).toHaveCSS('box-shadow', 'none');
      }
      await page.screenshot({
        path: testInfo.outputPath(`activity-panel-${width}-${theme}.png`),
        animations: 'disabled'
      });
    });

    test(`Activity notification badges share compact dimensions at ${width}px ${theme}`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 850 });
      let entryAnchor: { top: number; right: number } | undefined;
      for (const [query, count] of [
        ['one-notification=1', '1'],
        ['', '30'],
        ['many-notifications=1', '99+']
      ] as const) {
        await page.goto(
          `${fixture.url}workbench-mobile-drawer.html?locale=en-US&theme=${theme}&${query}`
        );
        const trigger = page.locator('.activity-center-trigger');
        const entryBadge = trigger.locator('.activity-entry-count');
        await expect(entryBadge).toHaveText(count);
        const anchor = await entryBadge.evaluate((element) => {
          const triggerBox = element.parentElement!.getBoundingClientRect();
          const badgeBox = element.getBoundingClientRect();
          return {
            top: badgeBox.top - triggerBox.top,
            right: triggerBox.right - badgeBox.right
          };
        });
        entryAnchor ??= anchor;
        expect(anchor.top).toBeCloseTo(entryAnchor.top, 1);
        expect(anchor.right).toBeCloseTo(entryAnchor.right, 1);
        // Leave room for the 2px inset focus ring and the badge's 1.5px isolation halo.
        expect(anchor.top).toBeGreaterThanOrEqual(3.5);
        expect(anchor.right).toBeGreaterThanOrEqual(3.5);
        if (count === '99+') {
          await trigger.focus();
          await page.keyboard.press('Tab');
          await page.keyboard.press('Shift+Tab');
          await expect(trigger).toBeFocused();
          await expect(trigger).toHaveCSS('outline-style', 'solid');
          await trigger.screenshot({ path: testInfo.outputPath('activity-trigger-99-focus.png') });
        }
        await trigger.click();
        const panel = page.locator('.workbench-activity-panel:visible');
        const tabBadge = panel.locator('.activity-unread-count');
        await expect(tabBadge).toHaveText(count);
        const badgeStyles = (element: Element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          const text = document.createRange();
          text.selectNodeContents(element);
          return {
            width: box.width,
            height: box.height,
            textWidth: text.getBoundingClientRect().width,
            padding: style.padding,
            boxSizing: style.boxSizing,
            borderRadius: style.borderRadius,
            background: style.backgroundColor,
            color: style.color,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight
          };
        };
        const {
          width: tabWidth,
          height: tabHeight,
          textWidth: tabTextWidth,
          ...tabStyles
        } = await tabBadge.evaluate(badgeStyles);
        const {
          width: entryWidth,
          height: entryHeight,
          textWidth: entryTextWidth,
          ...entryStyles
        } = await entryBadge.evaluate(badgeStyles);
        expect(tabStyles).toEqual(entryStyles);
        expect(tabHeight).toBeCloseTo(14, 2);
        expect(tabStyles.padding).toBe('0px 3px');
        if (count === '1') expect(tabWidth).toBeCloseTo(14, 2);
        if (count === '99+') expect(tabWidth).toBeGreaterThan(14);
        expect(tabWidth).toBeCloseTo(Math.max(14, tabTextWidth + 6), 1);
        expect(entryWidth).toBeCloseTo(Math.max(14, entryTextWidth + 6), 1);
        expect(tabWidth).toBeCloseTo(entryWidth, 2);
        expect(tabHeight).toBeCloseTo(entryHeight, 2);
        await expect(tabBadge).toBeInViewport({ ratio: 1 });
        expect(
          await panel
            .locator('.activity-tabs .mar-ui-tabs__header')
            .evaluate((tabs) => tabs.scrollWidth)
        ).toBeLessThanOrEqual(
          await panel
            .locator('.activity-tabs .mar-ui-tabs__header')
            .evaluate((tabs) => tabs.clientWidth)
        );
        if (count === '1') {
          await trigger.screenshot({ path: testInfo.outputPath('activity-trigger.png') });
          await panel
            .getByRole('tablist')
            .screenshot({ path: testInfo.outputPath('activity-tabs.png') });
        }
      }
    });

    test(`Activity center combines lists without mixing state at ${width}px ${theme}`, async ({
      page
    }, testInfo) => {
      const viewport = { width, height: 850 };
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`${fixture.url}workbench-mobile-drawer.html?locale=zh-CN&theme=${theme}`);
      const trigger = page.locator('.activity-center-trigger');
      const panel = page.locator('.workbench-activity-panel:visible');
      const icon = trigger.locator('[data-mar-icon="recent-sessions"]');
      await expect(icon).toBeVisible();
      await expect(icon).toHaveAttribute('aria-hidden', 'true');
      await expect(icon).toHaveCSS('animation-name', 'none');
      const content = await icon
        .locator('path')
        .last()
        .evaluate((element: SVGPathElement) => {
          const { width, height } = element.getBBox();
          return { width, height, length: element.getTotalLength() };
        });
      expect(content).toEqual({ width: 6, height: 4, length: 10 });
      await trigger.screenshot({ path: testInfo.outputPath('activity-entry-stacked-cards.png') });
      await expect(trigger.locator('.activity-entry-count')).toHaveText('30');
      await expect(trigger.locator('.activity-entry-running')).toHaveCount(1);
      const colors = await trigger.evaluate((element) => {
        const probe = document.createElement('span');
        element.append(probe);
        const resolve = (value: string) => {
          probe.style.color = value;
          return getComputedStyle(probe).color;
        };
        const color = (token: string) => resolve(`var(${token})`);
        const result = {
          unread: color('--mar-conversation-activity-fg'),
          notificationText: CSS.supports('color: contrast-color(red)')
            ? resolve('contrast-color(var(--mar-conversation-activity-fg))')
            : color('--mar-bg-panel'),
          running: color('--mar-control-color-success'),
          page: color('--mar-bg-page'),
          chrome: color('--mar-bg-chrome'),
          divider: color('--mar-border-subtle'),
          runningText: color('--mar-color-success-text'),
          completed: color('--mar-text-secondary')
        };
        probe.remove();
        return result;
      });
      expect(colors.running).not.toBe(colors.unread);
      for (const marker of ['.activity-entry-count', '.activity-entry-running']) {
        await expect(trigger.locator(marker)).toHaveCSS(
          'box-shadow',
          `${width >= 768 ? colors.page : colors.chrome} 0px 0px 0px 1.5px`
        );
      }
      await expect(trigger.locator('.activity-entry-count')).toHaveCSS(
        'background-color',
        colors.unread
      );
      await expect(trigger.locator('.activity-entry-count')).toHaveCSS(
        'color',
        colors.notificationText
      );
      await expect(trigger.locator('.activity-entry-running')).toHaveCSS(
        'background-color',
        colors.running
      );
      await expect(page.locator('.workbench-notification-trigger')).toHaveCount(0);
      await trigger.tap();
      await expect(panel.getByRole('tab', { name: /通知/ })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      const notificationBadge = panel
        .getByRole('tab', { name: /通知/ })
        .locator('.activity-unread-count');
      await expect(notificationBadge).toHaveCSS('background-color', colors.unread);
      await expect(notificationBadge).toHaveCSS('color', colors.notificationText);
      const notices = panel.locator('.workbench-notification-list > li');
      await expect(notices).toHaveCount(30);
      await expect(notices.first()).toHaveCSS('border-top-width', '0px');
      await expect(notices.nth(1)).toHaveCSS('border-top-color', colors.divider);
      await expect(notices.last()).toHaveCSS('border-bottom-width', '0px');
      await expect(trigger.locator('.activity-entry-count')).toHaveText('30');
      await expect(panel).toBeInViewport({ ratio: 1 });
      const box = await panel.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(240);
      expect(
        (await panel.locator('.activity-tabs .mar-ui-tabs__header').boundingBox())!.height
      ).toBeLessThan(60);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(850);
      if (width >= 768) {
        const anchor = await trigger.boundingBox();
        expect(box!.x).toBeGreaterThan(anchor!.x + anchor!.width);
      }
      const scroll = panel.locator('.workbench-notification-section');
      await scroll.evaluate((element) => (element.scrollTop = element.scrollHeight));
      await expect(panel.getByRole('button', { name: '全部标记已读' })).toBeInViewport();
      await expect(panel.locator('.workbench-notification-list > li').last()).toBeInViewport();
      await scroll.evaluate((element) => (element.scrollTop = 0));
      await page.screenshot({
        path: testInfo.outputPath(`activity-${width}-${theme}-notifications.png`),
        animations: 'disabled'
      });
      await panel.getByRole('button', { name: '全部标记已读' }).click();
      await expect(trigger.locator('.activity-entry-count')).toHaveCount(0);
      await expect(panel.getByRole('tab', { name: /通知/ })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      await expect(trigger.locator('.activity-entry-running')).toHaveCount(1);
      await trigger.tap();
      await expect(panel).toHaveCount(0);
      await trigger.tap();
      await expect(panel.getByRole('tab', { name: '最近会话', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      await expect(panel.locator('.activity-running-count')).toHaveText('活动任务：1');
      await expect(panel.locator('.session-state-badge')).toHaveCount(0);
      await expect(panel.locator('.recent-sessions-list > li')).toHaveCount(30);
      const statuses = panel.locator('.recent-sessions-list .mar-ui-tag');
      await expect(statuses.first()).toHaveText('运行中');
      await expect(statuses.first()).toHaveAttribute('data-type', 'success');
      await expect(statuses.first()).toHaveCSS('color', colors.runningText);
      await expect(statuses.nth(1)).toHaveAttribute('data-type', 'info');
      await expect(statuses.nth(1)).toHaveCSS('color', colors.completed);
      await page.screenshot({
        path: testInfo.outputPath(`activity-${width}-${theme}-recent.png`),
        animations: 'disabled'
      });
      const row = panel.locator('.recent-sessions-list button').first();
      const rowHover = await row.evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--mar-fill-row-hover)';
        element.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await row.hover();
      await expect
        .poll(() =>
          row
            .evaluate((element) => getComputedStyle(element).backgroundColor)
            .then(resolvedColorToHex)
        )
        .toBe(`${resolvedColorToHex(rowHover)}${width >= 768 ? '80' : ''}`);
      await expect(statuses.first()).toHaveCSS('color', colors.runningText);
      if (width >= 768) {
        await panel.screenshot({ path: testInfo.outputPath(`recent-session-hover-${theme}.png`) });
      }
      await page.mouse.move(viewport.width - 1, viewport.height - 1);
      await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await panel.locator('input[value="CHILD"]').tap();
      await expect(panel.locator('.recent-sessions-list > li')).toHaveCount(0);
      await expect(page.locator('output')).toHaveText('');
      await panel.locator('input[value="MAIN"]').tap();
      await panel.locator('.recent-sessions-list button').first().tap();
      await expect(panel).toHaveCount(0);
      await expect(page.locator('output')).toHaveText('session-0');
    });
  }
  for (const theme of ['daylight', 'vscode-dark-2026']) {
    test(`Activity previews stay near the entry without stealing menus or focus at ${width}px ${theme}`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 760 });
      await page.goto(`${fixture.url}workbench-mobile-drawer.html?locale=en-US&theme=${theme}`);
      const trigger = page.locator('.activity-center-trigger');
      const input = page.getByRole('textbox', { name: 'Background input' });
      const previewButton = page.getByRole('button', { name: 'Preview notification' });
      const announcePreview = () =>
        previewButton.evaluate((button: HTMLButtonElement) => {
          // Deliver the fixture notification without simulating a click outside an open menu.
          button.dispatchEvent(new MouseEvent('click', { bubbles: false }));
        });
      await input.focus();
      await announcePreview();
      const preview = page.locator('.activity-preview:visible');
      await expect(preview).toContainText('Application update available');
      await expect(preview).toContainText('0.10.2');
      await expect(input).toBeFocused();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      const popover = page.locator('.workbench-activity-popover:visible');
      await expectActivityElevation(popover, theme);
      await expect(preview.locator('li.unread')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const radius = await popover.evaluate(
        (element) => getComputedStyle(element).borderTopLeftRadius
      );
      expect(parseFloat(radius)).toBeGreaterThan(0);
      for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'])
        await expect(preview).toHaveCSS(`border-${corner}-radius`, radius);
      await expect(preview).toHaveCSS('overflow', 'hidden');
      if (width >= 768) {
        await expect(popover).toHaveAttribute('data-side', 'right');
        await expect(popover).toHaveAttribute('data-arrow');
        const { arrow, surface } = await popover.evaluate((element) => {
          const style = getComputedStyle(element, '::before');
          const panel = getComputedStyle(element);
          return {
            arrow: [style.backgroundColor, style.borderTopColor, style.borderLeftColor, style.left],
            surface: [panel.backgroundColor, panel.borderTopColor]
          };
        });
        expect(resolvedColorToHex(arrow[0]!)).toBe(resolvedColorToHex(surface[0]!));
        expect(arrow.slice(1, 3)).toEqual([surface[1], surface[1]]);
        expect(parseFloat(arrow[3]!)).toBeLessThan(0);
      } else await expect(popover).toHaveClass(/mar-ui-popover--no-arrow/);
      await expect(popover).toHaveCSS('opacity', '1');
      await page.screenshot({
        path: testInfo.outputPath(`notification-preview-${width}-${theme}.png`),
        animations: 'disabled'
      });
      const box = await preview.boundingBox();
      const anchor = await trigger.boundingBox();
      if (width >= 768) expect(box!.x).toBeGreaterThan(anchor!.x + anchor!.width);
      else expect(box!.y).toBeGreaterThan(anchor!.y + anchor!.height);
      await trigger.tap();
      await expect(preview).toHaveCount(0);
      const panel = page.locator('.workbench-activity-panel:visible');
      await panel.getByRole('tab', { name: 'Recent Sessions', exact: true }).click();
      await announcePreview();
      await expect(preview).toHaveCount(0);
      await expect(panel).toBeVisible();
      await expect(
        panel.getByRole('tab', { name: 'Recent Sessions', exact: true })
      ).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      if (width < 768) {
        await page.locator('.nav-menu-button:has([data-mar-icon="workspace"])').tap();
        const workspaceMenu = page.locator('.workspace-tree.mobile-open');
        await expect(workspaceMenu).toBeVisible();
        await announcePreview();
        await expect(preview).toHaveCount(0);
        await expect(workspaceMenu).toBeVisible();
      }
    });
  }
}
