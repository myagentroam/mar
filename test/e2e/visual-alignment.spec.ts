import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('Node detail actions stay above Close and capability refresh stays within its section', async ({
  page
}) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${fixture.url}visual-alignment.html?resource-details=1`);
    const dialog = page.locator('.node-details-dialog');
    await expect(dialog).toBeVisible();
    const usages = dialog.getByRole('button', { name: 'Usage', exact: true });
    await expect(usages).toHaveCount(2);
    for (const action of await usages.all())
      await expect(action.locator('[data-mar-icon="refresh"]')).toBeVisible();
    const usage = usages.first();
    await usage.scrollIntoViewIfNeeded();
    const colors = await usage.evaluate((element) => {
      const probe = document.createElement('span');
      element.append(probe);
      probe.style.color = 'var(--mar-text-secondary)';
      const normal = getComputedStyle(probe).color;
      probe.style.color = 'var(--mar-text-primary)';
      const hover = getComputedStyle(probe).color;
      probe.remove();
      return { normal, hover };
    });
    await page.mouse.move(0, 0);
    await expect(usage).toHaveCSS('color', colors.normal);
    await usage.hover();
    await expect(usage).toHaveCSS('color', colors.hover);
    await expect(usage).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const refresh = dialog.getByRole('button', { name: 'Refresh capabilities', exact: true });
    await refresh.scrollIntoViewIfNeeded();
    await refresh.hover();
    await expect(refresh).toHaveCSS('color', colors.hover);
    const runtime = dialog.locator('.runtime-environment');
    const section = (await runtime.boundingBox())!;
    const action = (await refresh.boundingBox())!;
    expect(action.x).toBeGreaterThanOrEqual(section.x);
    expect(action.x + action.width).toBeLessThanOrEqual(section.x + section.width + 1);
    expect(action.y).toBeGreaterThanOrEqual(section.y);
    expect(action.y).toBeLessThan(section.y + 32);
    await refresh.click();
    await expect(page.getByTestId('capability-refresh-count')).toHaveText('1');
    const footer = dialog.locator('.el-dialog__footer');
    const close = footer.getByRole('button', { name: 'Close', exact: true });
    const upgrade = footer.locator('.node-detail-actions button');
    await upgrade.click();
    await expect(upgrade).toHaveText('Cancel upgrade');
    await close.scrollIntoViewIfNeeded();
    const upgradeBox = (await upgrade.boundingBox())!;
    const closeBox = (await close.boundingBox())!;
    expect(upgradeBox.y + upgradeBox.height).toBeLessThan(closeBox.y);
    await upgrade.click();
    await expect(upgrade).not.toHaveText('Cancel upgrade');
    await close.click();
    await expect(dialog).toHaveCount(0);
  }
});

test('Shared tooltip keeps one active instance for thousands of targets and preserves ARIA', async ({
  page
}) => {
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') warnings.push(message.text());
  });
  await page.goto(`${fixture.url}visual-alignment.html?shared-tooltip=1`);
  const first = page.locator('[data-row="1"]');
  const second = page.locator('[data-row="2"]');
  const hint = page.locator('.mar-tooltip:visible');
  await expect(page.locator('[data-row]')).toHaveCount(1000);
  await expect(page.getByTestId('tooltip-created')).toHaveText('0');
  await page.getByTestId('grow').click();
  await expect(page.locator('[data-row]')).toHaveCount(2000);
  await expect(page.getByTestId('tooltip-created')).toHaveText('0');
  await first.locator('span').hover();
  await expect(hint).toHaveText('Original 1');
  await expect(page.getByTestId('tooltip-live')).toHaveText('1');
  await expect(first).toHaveAccessibleDescription('Existing description Original 1');
  await expect(first).toHaveAttribute('aria-haspopup', 'menu');
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  await second.hover();
  await expect(hint).toHaveText('Original 2');
  await expect(hint).toHaveCount(1);
  await expect(first).toHaveAttribute('aria-describedby', 'existing-description');
  await second.focus();
  await second.press('Escape');
  await expect(hint).toHaveCount(0);
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute('aria-describedby', 'existing-description');
  await expect(page.getByTestId('tooltip-live')).toHaveText('0');
  expect(warnings).toEqual([]);
});

test('Shared tooltip cancels stale targets and follows content, hidden, removed and scrolling state', async ({
  page
}) => {
  await page.goto(`${fixture.url}visual-alignment.html?shared-tooltip=1`);
  const first = page.locator('[data-row="1"]');
  const second = page.locator('[data-row="2"]');
  const hint = page.locator('.mar-tooltip:visible');
  await first.hover();
  await second.hover();
  await expect(hint).toHaveText('Original 2');
  await page.getByTestId('rename').evaluate((button: HTMLButtonElement) => button.click());
  await expect(hint).toHaveText('Updated 2');
  await page.getByTestId('disable').evaluate((button: HTMLButtonElement) => button.click());
  await expect(hint).toHaveCount(0);
  await expect(second).toHaveAttribute('aria-describedby', 'existing-description');
  await page.getByTestId('disable').click();
  await first.focus();
  await expect(hint).toHaveText('Updated 1');
  await page.getByTestId('hide').evaluate((button: HTMLButtonElement) => button.click());
  await expect(hint).toHaveCount(0);
  await page.getByTestId('hide').click();
  await first.hover();
  await expect(hint).toHaveText('Updated 1');
  await page.getByTestId('tooltip-list').evaluate((list) => {
    list.scrollTop = 80;
  });
  await expect(hint).toHaveCount(0);
  await page.locator('[data-row="5"]').hover();
  await expect(hint).toHaveText('Updated 5');
  await page.getByTestId('remove').evaluate((button: HTMLButtonElement) => button.click());
  await expect(hint).toHaveCount(0);
  await expect(page.getByTestId('tooltip-live')).toHaveText('0');
});

test('Table overflow hints share the theme without template-ref warnings', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text());
  });
  await page.goto(`${fixture.url}visual-alignment.html`);
  await page.locator('.el-table__body .cell').hover();
  await expect(page.locator('.mar-tooltip:visible')).toContainText(
    'A complete long table cell description'
  );
  const hint = page.locator('.mar-tooltip:visible');
  await expect(hint.locator('.el-popper__arrow')).toBeVisible();
  await expect(hint).toHaveCSS('pointer-events', 'auto');
  await hint.hover();
  await expect(hint).toBeVisible();
  await hint.click({ clickCount: 3, position: { x: 24, y: 12 } });
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain(
    'A complete long table cell description'
  );
  expect(warnings.filter((message) => /ref owner|Missing ref|unmounted/i.test(message))).toEqual(
    []
  );
});

test('Unified hints preserve keyboard actions, details and disabled semantics', async ({
  page
}) => {
  await page.goto(`${fixture.url}visual-alignment.html`);
  const compact = page.locator('.composer-context-button');
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--mar-radius-control', '7px')
  );
  await expect(compact).toHaveCSS('border-radius', '7px');
  await compact.focus();
  const hint = page.locator('.mar-tooltip:visible');
  await expect(hint).toContainText('42000 of 100000');
  await expect(hint).toContainText('click to compact');
  await expect(compact).not.toHaveAttribute('title');
  await compact.press('Escape');
  await expect(hint).toHaveCount(0);
  await expect(compact).toBeFocused();
  await compact.press('Enter');
  await expect(page.getByTestId('compact-count')).toHaveText('1');
  await compact.press('Space');
  await expect(page.getByTestId('compact-count')).toHaveText('2');
  await page.getByText('Toggle availability', { exact: true }).click();
  await expect(compact).toHaveAttribute('aria-disabled', 'true');
  await compact.focus();
  await expect(hint).toContainText('currently unavailable');
  await compact.press('Enter');
  await expect(page.getByTestId('compact-count')).toHaveText('2');
});

test('Escape dismisses a focused hint before its containing dialog', async ({ page }) => {
  await page.goto(`${fixture.url}visual-alignment.html`);
  await page.getByRole('button', { name: 'Open hint dialog', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Hint dialog', exact: true });
  const action = dialog.getByRole('button', { name: 'Dialog action', exact: true });
  await action.focus();
  await expect(page.locator('.mar-tooltip:visible')).toContainText('Dialog action details');
  await action.press('Escape');
  await expect(page.locator('.mar-tooltip:visible')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(action).toBeFocused();
  await action.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('Touch Context details stay readable without stealing the compact action', async ({
  browser
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  try {
    const page = await context.newPage();
    await page.goto(`${fixture.url}visual-alignment.html?mobile=1&context-confirm=1`);
    const compact = page.locator('.composer-context-button');
    const hint = page.locator('.mar-tooltip:visible');
    await page.getByRole('button', { name: 'Toggle availability', exact: true }).tap();
    // ARIA disables compaction, not detail reading. Check native hit-testing before tapping.
    const point = await compact.evaluate((button: HTMLButtonElement) => {
      const rect = button.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      return {
        x,
        y,
        hit: button.contains(document.elementFromPoint(x, y)),
        disabled: button.disabled
      };
    });
    expect(point.hit).toBe(true);
    expect(point.disabled).toBe(false);
    await page.touchscreen.tap(point.x, point.y);
    await expect(hint).toContainText('42000 of 100000');
    await expect(hint).toContainText('currently unavailable');
    await expect(compact).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('dialog', { name: 'Compact Context', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('compact-count')).toHaveText('0');
    await page.getByRole('button', { name: 'Toggle availability', exact: true }).tap();
    await expect(hint).toHaveCount(0);

    await compact.tap();
    const dialog = page.getByRole('dialog', { name: 'Compact Context', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('42000 of 100000');
    await expect(hint).toHaveCount(0);
    await expect(page.getByTestId('compact-count')).toHaveText('0');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).tap();
    await expect(dialog).toHaveCount(0);
    await compact.tap();
    await dialog.getByRole('button', { name: 'Compact', exact: true }).tap();
    await expect(page.getByTestId('compact-count')).toHaveText('1');
    await expect(hint).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('Shared tooltip switches between touch, keyboard and mouse without stale input state', async ({
  browser
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true
  });
  try {
    const page = await context.newPage();
    await page.goto(`${fixture.url}visual-alignment.html?shared-tooltip=1`);
    const first = page.locator('[data-row="1"]');
    const second = page.locator('[data-row="2"]');
    const hint = page.locator('.mar-tooltip:visible');
    await first.tap();
    await expect(hint).toHaveText('Original 1');
    await second.tap();
    await expect(hint).toHaveCount(0);
    await page.keyboard.press('Shift+Tab');
    await expect(first).toBeFocused();
    await expect(hint).toHaveText('Original 1');
    await page.keyboard.press('Escape');
    await expect(hint).toHaveCount(0);
    await second.hover();
    await expect(hint).toHaveText('Original 2');
    await expect(hint).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test('Hosted model hints preserve dropdown semantics and keyboard selection', async ({ page }) => {
  await page.goto(`${fixture.url}visual-alignment.html?hosted=1`);
  const trigger = page.locator('.hosted-model-trigger');
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toHaveAccessibleDescription('Model One');
  await trigger.locator('span').first().hover();
  await expect(page.locator('.mar-tooltip:visible')).toContainText('Model One');
  await page.mouse.move(0, 0);
  await trigger.focus();
  await trigger.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('menuitem', { name: 'Model Two', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toContainText('Model Two');
  await expect(trigger).toHaveAccessibleDescription('Model Two');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('Theme action hints do not replace dropdown semantics', async ({ page }) => {
  await page.goto(`${fixture.url}visual-alignment.html?menus=1`);
  const trigger = page.locator('.theme-settings .el-dropdown button').first();
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.focus();
  await expect(page.locator('.mar-tooltip:visible')).toHaveText(
    (await trigger.getAttribute('aria-label')) ?? ''
  );
  await trigger.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitem', { name: /duplicate/i })).toBeVisible();
  await page.getByRole('menuitem', { name: /duplicate/i }).press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('Shared tooltip follows keyboard focus on real tree rows and workspace tabs', async ({
  page
}) => {
  await page.goto(`${fixture.url}visual-alignment.html?shared-tooltip=1`);
  const row = page.getByRole('treeitem', { name: 'Fixture workspace' });
  await row.focus();
  await expect(page.locator('.mar-tooltip:visible')).toHaveText('Fixture workspace');
  await row.hover();
  await page.mouse.move(0, 0);
  await expect(row).toBeFocused();
  await expect(page.locator('.mar-tooltip:visible')).toHaveText('Fixture workspace');
  await page.goto(`${fixture.url}workspace-tabs.html?locale=en-US`);
  const tab = page.getByRole('tab', { name: 'Workspace one', exact: true });
  await tab.focus();
  await expect(page.locator('.mar-tooltip:visible')).toHaveText('Workspace one');
});

test('Performance hover displays the details panel without a second hint', async ({ page }) => {
  await page.goto(`${fixture.url}visual-alignment.html?performance=1`);
  const trigger = page.locator('.web-performance-indicator');
  await expect(trigger).toBeVisible();
  const box = await trigger.boundingBox();
  await page.clock.install();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.clock.runFor(1000);
  await expect(page.locator('.web-performance-panel')).toBeVisible();
  await expect(page.locator('.mar-tooltip:visible')).toHaveCount(0);
});

for (const theme of ['daylight', 'vscode-dark-2026']) {
  for (const width of [390, 767, 768, 1280]) {
    test(`Session performance clears the final row and stays near the mobile bottom: ${theme}, ${width}px`, async ({
      browser
    }, testInfo) => {
      const context = await browser.newContext({
        viewport: { width, height: 700 },
        isMobile: width < 768,
        hasTouch: width < 768
      });
      try {
        const page = await context.newPage();
        await page.goto(`${fixture.url}visual-alignment.html?session-performance=1&theme=${theme}`);
        const info = page.locator('.session-performance-info');
        await expect(info).toBeVisible();
        await page.locator('.conversation-scroll').evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        const infoBox = (await info.boundingBox())!;
        const region = (await page.locator('.conversation-scroll-region').boundingBox())!;
        const lastRow = (await page.getByTestId('last-row').boundingBox())!;
        const bottomGap = region.y + region.height - infoBox.y - infoBox.height;
        if (width < 768) {
          expect(lastRow.y + lastRow.height).toBeLessThanOrEqual(infoBox.y);
          expect(bottomGap).toBeGreaterThanOrEqual(0);
          expect(bottomGap).toBeLessThanOrEqual(4);
        } else {
          const rootFontSize = await page
            .locator('html')
            .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
          expect(bottomGap).toBeCloseTo(rootFontSize * 0.75, 1);
        }
        if (width < 768) await info.tap();
        else await info.focus();
        await expect(page.locator('.mar-tooltip:visible')).toContainText('420 ms');
        await expect(page.locator('.mar-tooltip:visible')).toContainText('42.0');
        const hintBox = (await page.locator('.mar-tooltip:visible').boundingBox())!;
        expect(hintBox.x).toBeGreaterThanOrEqual(0);
        expect(hintBox.x + hintBox.width).toBeLessThanOrEqual(width);
        expect(hintBox.y).toBeGreaterThanOrEqual(0);
        expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(700);
        await page.screenshot({ path: testInfo.outputPath('session-performance-hint.png') });
        await page.getByTestId('leave-latest').click();
        const latest = page.locator('.conversation-latest');
        await expect(latest).toBeVisible();
        const latestBox = (await latest.boundingBox())!;
        const raisedInfo = (await info.boundingBox())!;
        expect(raisedInfo.y + raisedInfo.height).toBeLessThanOrEqual(latestBox.y);
        await latest.click();
        await expect(latest).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('session-performance-position.png') });
        await page.getByTestId('hide-performance').click();
        await expect(info).toHaveCount(0);
        const padding = await page.locator('.conversation-scroll').evaluate((element) => ({
          bottom: Number.parseFloat(getComputedStyle(element).paddingBottom),
          root: Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
        }));
        expect(padding.bottom).toBeCloseTo(padding.root, 1);
      } finally {
        await context.close();
      }
    });
  }
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Notification and template surfaces consume semantic fields without glass or horizontal motion: ${theme}`, async ({
    page
  }, testInfo) => {
    await page.goto(`${fixture.url}visual-alignment.html?theme=${theme}`);
    const trigger = page.locator('.workbench-notification-center button').first();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator('.workbench-notification-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS('backdrop-filter', 'none');
    await page.evaluate(() => {
      document.documentElement.style.setProperty(
        '--mar-control-bg-color-overlay',
        'rgb(30, 45, 60)'
      );
      document.documentElement.style.setProperty('--mar-radius-surface', '13px');
      document.documentElement.style.setProperty('--mar-radius-marker', '2px');
    });
    await expect(panel).toHaveCSS('background-color', 'rgb(30, 45, 60)');
    await expect(panel).toHaveCSS('border-radius', '13px');
    await expect(page.locator('.notification-unread-label')).toHaveCSS('border-radius', '2px');
    await expect(panel).toHaveCSS('opacity', '1');
    await page.screenshot({
      path: testInfo.outputPath('notification-desktop.png'),
      animations: 'disabled'
    });
    await trigger.click();
    await page.getByRole('button', { name: 'View email templates', exact: true }).click();
    const first = page.locator('.template-choice').first();
    const second = page.locator('.template-choice').nth(1);
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    const before = await second.boundingBox();
    await second.hover();
    await expect(second).toHaveCSS('transform', 'none');
    expect((await second.boundingBox())?.x).toBe(before?.x);
    await page.evaluate(() =>
      document.documentElement.style.setProperty('--mar-fill-selection', 'rgb(61, 66, 71)')
    );
    await second.click();
    await expect(second).toHaveCSS('background-color', 'rgb(61, 66, 71)');
    await second.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(second).toHaveCSS('outline-style', 'solid');
  });
}

for (const mobile of [false, true]) {
  test(`Notification long content wraps completely and remains scrollable: mobile=${mobile}`, async ({
    browser
  }, testInfo) => {
    const viewport = mobile ? { width: 320, height: 480 } : { width: 1280, height: 720 };
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
    try {
      const page = await context.newPage();
      await page.goto(
        `${fixture.url}visual-alignment.html?long-notification=1${mobile ? '&mobile=1&theme=daylight' : ''}`
      );
      await page.locator('.workbench-notification-center button').first().click();
      const panel = page.locator('.workbench-notification-panel');
      const item = panel.locator('.workbench-notification-list > li').first();
      const title = item.locator('strong');
      const message = item.locator('small');
      await expect(message).toContainText('End of notification.');
      for (const text of [title, message]) {
        const metrics = await text.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const box = element.getBoundingClientRect();
          const lines = [...range.getClientRects()];
          return {
            lines: lines.length,
            width: box.width,
            contentWidth: range.getBoundingClientRect().width,
            allLinesInside: lines.every((line) => {
              const center = line.top + line.height / 2;
              return center >= box.top && center <= box.bottom;
            })
          };
        });
        expect(metrics.lines).toBeGreaterThan(1);
        expect(metrics.contentWidth).toBeLessThanOrEqual(metrics.width + 1);
        expect(metrics.allLinesInside).toBe(true);
      }
      const font = await message.evaluate((element) => ({
        actual: getComputedStyle(element).fontSize,
        expected: getComputedStyle(document.documentElement)
          .getPropertyValue('--mar-font-size-meta')
          .trim()
      }));
      expect(font.actual).toBe(font.expected);
      const messageBox = (await message.boundingBox())!;
      const time = item.locator('time');
      const timeBox = (await time.boundingBox())!;
      expect(timeBox.y).toBeGreaterThanOrEqual(messageBox.y + messageBox.height);
      const section = mobile
        ? page.locator('.notification-fixture-drawer')
        : panel.locator('.workbench-notification-section');
      await section.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(time).toBeInViewport();
      const box = (await (mobile ? section : panel).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      await page.screenshot({
        path: testInfo.outputPath('notification-long.png'),
        animations: 'disabled'
      });
      const remove = item.locator('.workbench-notification-delete');
      await remove.scrollIntoViewIfNeeded();
      await expect(remove).toBeInViewport({ ratio: 1 });
      if (mobile) await remove.tap();
      else await remove.click();
      await expect(item).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}

test('Mobile first touch executes the action and the notification stays within the viewport', async ({
  browser
}, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 700 },
    isMobile: true,
    hasTouch: true
  });
  try {
    const page = await context.newPage();
    await page.goto(`${fixture.url}visual-alignment.html?mobile=1`);
    await page.locator('.composer-context-button').tap();
    await expect(page.getByTestId('compact-count')).toHaveText('1');
    await page.locator('.workbench-notification-center button').first().tap();
    const panel = page.locator('.workbench-notification-panel');
    await expect(panel).toBeVisible();
    const box = await page.locator('.notification-fixture-drawer').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y + box!.height).toBeLessThanOrEqual(700);
    await expect(panel).toHaveCSS('opacity', '1');
    await page.screenshot({
      path: testInfo.outputPath('notification-mobile.png'),
      animations: 'disabled'
    });
  } finally {
    await context.close();
  }
});
