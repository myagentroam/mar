import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
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
  await trigger.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitem', { name: /duplicate/i })).toBeVisible();
  await page.getByRole('menuitem', { name: /duplicate/i }).press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
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
        await info.focus();
        await expect(page.locator('.mar-tooltip:visible')).toContainText('420 ms');
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
    const box = await panel.boundingBox();
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
