import { expect, test, type Page } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

test.use({ hasTouch: true });
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/workbench-mobile-drawer.html');
});
test.afterAll(async () => fixture.close());

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

test('Activity shortcuts toggle the panel without displaying a tooltip', async ({ page }) => {
  const { entry, panel } = await prepareActivityInteraction(page);
  await page.getByRole('textbox', { name: 'Background input' }).focus();
  for (const shortcut of ['Control+Shift+E', 'Meta+Shift+E']) {
    await page.keyboard.press(shortcut);
    await page.clock.runFor(500);
    await expect(panel).toBeVisible();
    await expect(entry).toBeFocused();
    await expect(page.locator('.mar-tooltip:visible')).toHaveCount(0);
    await page.keyboard.press(shortcut);
    await page.clock.runFor(500);
    await expect(panel).toHaveCount(0);
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
  const opened = page.getByLabel('Opened target');
  await tasks.first().getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(opened).toHaveText('retry:FAILED');
  await tasks.first().getByRole('button', { name: 'Delete report.txt', exact: true }).click();
  await expect(opened).toHaveText('remove:FAILED');
  await tasks.last().getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(opened).toHaveText('cancel:UPLOADING');
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
    test(`Activity tabs share MarTab styling and preserve keyboard activation at ${width}px ${theme}`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 850 });
      await page.goto(`${fixture.url}workbench-mobile-drawer.html?locale=en-US&theme=${theme}`);
      const trigger = page.locator('.activity-center-trigger');
      await trigger.click();
      const panel = page.locator('.workbench-activity-panel:visible');
      const tabs = panel.locator('.activity-tabs');
      const recent = tabs.getByRole('tab', { name: 'Recent Sessions', exact: true });
      const notifications = tabs.getByRole('tab', { name: 'Notifications', exact: true });
      await expect(notifications).toHaveAttribute('aria-selected', 'true');
      await expect(notifications.locator('..')).toHaveCSS('border-top-width', '1px');
      const overlap = await recent.evaluate((element) => {
        const row = element.parentElement!;
        return (
          row.getBoundingClientRect().right - row.nextElementSibling!.getBoundingClientRect().left
        );
      });
      expect(overlap).toBeCloseTo(width < 768 ? -4 : 1, 1);
      await notifications.focus();
      for (const key of ['ArrowLeft', 'End', 'Home', 'ArrowRight']) {
        const target = key === 'ArrowLeft' || key === 'Home' ? recent : notifications;
        await page.keyboard.press(key);
        await expect(target).toBeFocused();
        await expect(target).toHaveAttribute('aria-selected', 'true');
        const identity = await target.evaluate((element) => ({
          tab: element.id,
          panel: element.getAttribute('aria-controls')
        }));
        expect(identity.tab).not.toBe('');
        expect(identity.panel).toBeTruthy();
        await expect(panel.locator('[role="tabpanel"]')).toHaveAttribute('id', identity.panel!);
        await expect(panel.locator('[role="tabpanel"]')).toHaveAttribute(
          'aria-labelledby',
          identity.tab
        );
        await expect(trigger.locator('.activity-entry-count')).toHaveText('30');
      }
      await expect(tabs.locator('.activity-unread-count')).toHaveText('30');
      await tabs.screenshot({ path: testInfo.outputPath(`activity-tabs-${width}-${theme}.png`) });
    });

    test(`Activity notification badges share dimensions at ${width}px ${theme}`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 850 });
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
        await trigger.click();
        const panel = page.locator('.workbench-activity-panel:visible');
        const tabBadge = panel.locator('.activity-unread-count');
        await expect(tabBadge).toHaveText(count);
        const badgeStyles = (element: Element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return {
            width: box.width,
            height: box.height,
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
          ...tabStyles
        } = await tabBadge.evaluate(badgeStyles);
        const {
          width: entryWidth,
          height: entryHeight,
          ...entryStyles
        } = await entryBadge.evaluate(badgeStyles);
        expect(tabStyles).toEqual(entryStyles);
        expect(tabHeight).toBeCloseTo(16, 2);
        expect(tabWidth).toBeGreaterThanOrEqual(16);
        expect(tabWidth).toBeCloseTo(entryWidth, 2);
        expect(tabHeight).toBeCloseTo(entryHeight, 2);
        await expect(tabBadge).toBeInViewport({ ratio: 1 });
        expect(
          await panel.locator('.activity-tabs').evaluate((tabs) => tabs.scrollWidth)
        ).toBeLessThanOrEqual(
          await panel.locator('.activity-tabs').evaluate((tabs) => tabs.clientWidth)
        );
      }
    });

    test(`Activity center combines lists without mixing state at ${width}px ${theme}`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 850 });
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
        const color = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const result = {
          unread: color('--mar-color-brand'),
          running: color('--el-color-success'),
          runningText: color('--mar-color-success-text'),
          completed: color('--el-color-info')
        };
        probe.remove();
        return result;
      });
      expect(colors.running).not.toBe(colors.unread);
      await expect(trigger.locator('.activity-entry-count')).toHaveCSS(
        'background-color',
        colors.unread
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
      await expect(panel.locator('.workbench-notification-list > li')).toHaveCount(30);
      await expect(trigger.locator('.activity-entry-count')).toHaveText('30');
      await expect(panel).toBeInViewport({ ratio: 1 });
      const box = await panel.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(240);
      expect((await panel.locator('.activity-tabs').boundingBox())!.height).toBeLessThan(60);
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
      await expect(panel.locator('.activity-running-count')).toHaveText('运行中 1');
      await expect(panel.locator('.session-state-badge')).toHaveCount(0);
      await expect(panel.locator('.recent-sessions-list > li')).toHaveCount(30);
      const statuses = panel.locator('.recent-sessions-list .el-tag');
      await expect(statuses.first()).toHaveClass(/el-tag--success/);
      await expect(statuses.first()).toHaveCSS('color', colors.runningText);
      await expect(statuses.nth(1)).toHaveClass(/el-tag--info/);
      await expect(statuses.nth(1)).toHaveCSS('color', colors.completed);
      await page.screenshot({
        path: testInfo.outputPath(`activity-${width}-${theme}-recent.png`),
        animations: 'disabled'
      });
      await panel.locator('[data-group="CHILD"]').tap();
      await expect(panel.locator('.recent-sessions-list > li')).toHaveCount(0);
      await expect(page.locator('output')).toHaveText('');
      await panel.locator('[data-group="MAIN"]').tap();
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
      await input.focus();
      await page
        .getByRole('button', { name: 'Preview notification' })
        .evaluate((button: HTMLButtonElement) => button.click());
      const preview = page.locator('.activity-preview:visible');
      await expect(preview).toContainText('New version');
      await expect(input).toBeFocused();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      const popover = page.locator('.workbench-activity-popover:visible');
      const radius = await popover.evaluate(
        (element) => getComputedStyle(element).borderTopLeftRadius
      );
      expect(parseFloat(radius)).toBeGreaterThan(0);
      for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'])
        await expect(preview).toHaveCSS(`border-${corner}-radius`, radius);
      await expect(preview).toHaveCSS('overflow', 'hidden');
      const arrow = popover.locator('.el-popper__arrow');
      if (width >= 768) {
        await expect(arrow).toBeVisible();
        expect((await arrow.boundingBox())!.x).toBeLessThan((await popover.boundingBox())!.x);
        expect(
          await arrow.evaluate((element) => getComputedStyle(element, '::before').backgroundColor)
        ).toBe(await popover.evaluate((element) => getComputedStyle(element).backgroundColor));
      } else await expect(arrow).toHaveCount(0);
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
      await page
        .getByRole('button', { name: 'Preview notification' })
        .evaluate((button: HTMLButtonElement) => button.click());
      await expect(preview).toHaveCount(0);
      await expect(
        panel.getByRole('tab', { name: 'Recent Sessions', exact: true })
      ).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      if (width < 768) {
        await page.locator('.nav-menu-button:has([data-mar-icon="workspace"])').tap();
        await expect(page.locator('.workspace-tree.mobile-open')).toBeVisible();
        await page
          .getByRole('button', { name: 'Preview notification' })
          .evaluate((button: HTMLButtonElement) => button.click());
        await expect(preview).toHaveCount(0);
      }
    });
  }
}
