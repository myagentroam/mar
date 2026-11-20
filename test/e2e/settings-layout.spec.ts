import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/settings-layout.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

const sections = [
  { id: 'appearance', selector: '.full', title: 'h2' },
  { id: 'account', selector: '.full', title: 'h2' },
  { id: 'usage', selector: '.usage-content', title: 'h2' },
  { id: 'custom-themes', selector: '.theme-settings', title: 'h2' },
  { id: 'notifications', selector: '.full', title: 'h2' },
  { id: 'quick-prompts', selector: '.quick-prompts-content', title: 'h2' },
  { id: 'personal-instructions', selector: '.personal-instructions', title: 'h2' },
  { id: 'git', selector: '.mar-management-page', title: 'h2' },
  { id: 'registration', selector: '.full', title: 'h2' },
  { id: 'shortcuts', selector: '.full', title: 'h2' },
  { id: 'about', selector: '.about-settings', title: '.system-brand' }
] as const;

for (const theme of ['daylight', 'vscode-dark-2026']) {
  for (const { width, locale } of [
    { width: 1920, locale: 'en-US' },
    { width: 1440, locale: 'zh-CN' },
    { width: 390, locale: 'zh-CN' },
    { width: 320, locale: 'en-US' }
  ]) {
    test(`Personal settings share full-width geometry in ${theme} at ${width}px`, async ({
      page
    }) => {
      test.setTimeout(90_000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width, height: 900 });
      for (const section of sections) {
        await test.step(section.id, async () => {
          await page.goto(
            `${fixture.url}settings-layout.html?section=${section.id}&theme=${theme}&locale=${locale}`
          );
          const content = page.locator('.settings-content');
          const panel = content.locator(section.selector).first();
          const title = panel.locator(section.title).first();
          await expect(title).toBeVisible();
          const inset = await page.evaluate(() =>
            Math.round(
              parseFloat(getComputedStyle(document.documentElement).fontSize) *
                (innerWidth < 768 ? 0.75 : 1)
            )
          );
          await expect
            .poll(async () => {
              const outer = (await content.boundingBox())!;
              const inner = (await panel.boundingBox())!;
              const heading = (await title.boundingBox())!;
              return {
                left: Math.round(inner.x - outer.x),
                right: Math.round(outer.x + outer.width - inner.x - inner.width),
                textInset: Math.round(heading.x - outer.x),
                overflow: await content.evaluate(
                  (element) => element.scrollWidth > element.clientWidth
                )
              };
            })
            .toEqual({ left: 0, right: 0, textInset: inset, overflow: false });

          if (section.id === 'appearance') {
            const row = content.locator('.theme-row').first();
            await expect(row.getByRole('combobox')).toBeVisible();
            const control = row.locator('.mar-ui-select');
            const label = row.locator('label');
            const bounds = (await row.boundingBox())!;
            const input = (await control.boundingBox())!;
            if (width > 767) {
              const rootFontSize = await page.evaluate(() =>
                parseFloat(getComputedStyle(document.documentElement).fontSize)
              );
              expect(bounds.width).toBeLessThanOrEqual(rootFontSize * 36);
              expect(input.width).toBeLessThan(320);
              expect(Math.abs(bounds.x + bounds.width - input.x - input.width)).toBeLessThan(2);
            } else {
              const text = (await label.boundingBox())!;
              expect(input.y).toBeGreaterThanOrEqual(text.y + text.height);
            }
            for (const select of await content.locator('.theme-row .mar-ui-select').all()) {
              expect((await select.boundingBox())!.width).toBeCloseTo(input.width, 0);
            }
          }
          if (section.id === 'custom-themes') {
            const editor = content.locator('.json-editor');
            const preview = content.locator('.editor-layout > aside');
            await expect(editor).toBeVisible();
            const left = (await editor.boundingBox())!;
            const right = (await preview.boundingBox())!;
            if (width < 768) expect(right.y).toBeGreaterThanOrEqual(left.y + left.height);
            else expect(right.x).toBeGreaterThanOrEqual(left.x + left.width);
          }
          if (section.id === 'personal-instructions') {
            await expect(content.getByRole('textbox')).toHaveValue(
              'Keep changes focused. Explain important decisions and verify the result.'
            );
          }
          await page.screenshot({
            path: test.info().outputPath(`${section.id}-${theme}-${width}.png`)
          });
        });
      }
      expect(errors).toEqual([]);
    });
  }
}

test('Settings navigation and theme editor respond to the available content width', async ({
  page
}) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(`${fixture.url}settings-layout.html?section=appearance&theme=daylight`);
  await page.getByRole('button', { name: 'Themes', exact: true }).click();
  const content = page.locator('.settings-content');
  await expect(content.locator('.theme-settings')).toBeVisible();
  const editor = content.locator('.json-editor');
  const preview = content.locator('.editor-layout > aside');
  const containerWidth = await content.locator('.theme-settings').evaluate((element) => {
    const style = getComputedStyle(element);
    return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  });
  // Desktop rem scaling produces fractional widths: both sides of the breakpoint must be covered.
  await page.setViewportSize({ width: Math.floor(1000 - containerWidth + 760), height: 900 });
  await expect
    .poll(async () => {
      const left = (await editor.boundingBox())!;
      const right = (await preview.boundingBox())!;
      return right.y >= left.y + left.height;
    })
    .toBe(true);
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await expect
    .poll(async () => {
      const left = (await editor.boundingBox())!;
      const right = (await preview.boundingBox())!;
      return right.x >= left.x + left.width;
    })
    .toBe(true);
});

for (const theme of ['vscode-dark-2026', 'daylight']) {
  test(`System notification settings keep status and action clear in ${theme}`, async ({
    page
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
      localStorage.setItem('mar.workbench.system-notifications.v1.settings-layout-fixture', 'true');
    });
    await page.setViewportSize({ width: 1360, height: 600 });
    await page.goto(
      `${fixture.url}settings-layout.html?section=notifications&theme=${theme}&locale=zh-CN`
    );
    const content = page.locator('.settings-content');
    const heading = content.getByRole('heading', { name: '系统通知', exact: true });
    await expect(heading).toHaveCount(1);
    const status = content.getByRole('status');
    const disable = content.getByRole('button', { name: '关闭系统通知', exact: true });
    await expect(status).toHaveText('已开启');
    await expect(disable).toHaveCSS('border-top-width', '1px');
    await expect(disable).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    const headingBox = (await heading.boundingBox())!;
    const statusBox = (await status.boundingBox())!;
    const actionBox = (await disable.boundingBox())!;
    expect(actionBox.x).toBeCloseTo(headingBox.x, 0);
    const gap = statusBox.x - actionBox.x - actionBox.width;
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThanOrEqual(16);
    expect(
      Math.abs(actionBox.y + actionBox.height / 2 - statusBox.y - statusBox.height / 2)
    ).toBeLessThan(2);
    await page.screenshot({ path: test.info().outputPath(`system-notifications-${theme}.png`) });

    await page.setViewportSize({ width: 320, height: 660 });
    await expect(disable).toBeInViewport();
    await expect
      .poll(() => content.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
    await disable.focus();
    await page.keyboard.press('Enter');
    await expect(status).toHaveText('未开启');
    await expect(content.getByRole('button', { name: '开启系统通知', exact: true })).toBeEnabled();
  });
}

test.describe('System notification settings on a touch device', () => {
  test.use({
    viewport: { width: 320, height: 660 },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15)'
  });

  test('keeps the offline Push status and touch action readable', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
      localStorage.setItem('mar.workbench.system-notifications.v1.settings-layout-fixture', 'true');
    });
    await page.goto(`${fixture.url}settings-layout.html?section=notifications&locale=en-US`);
    const content = page.locator('.settings-content');
    const action = content.getByRole('button', { name: 'Disable offline Push', exact: true });
    const status = content.getByRole('status').filter({ hasText: /^Enabled$/ });
    const detail = content.getByRole('status').filter({ hasText: 'Offline Push is not supported' });
    await expect(content.getByRole('heading', { name: 'Offline Push', exact: true })).toBeVisible();
    await expect(action).toBeInViewport({ ratio: 1 });
    await expect(status).toBeInViewport({ ratio: 1 });
    await expect(detail).toBeInViewport({ ratio: 1 });
    const actionBox = (await action.boundingBox())!;
    const statusBox = (await status.boundingBox())!;
    const detailBox = (await detail.boundingBox())!;
    expect(actionBox.height).toBeGreaterThanOrEqual(44);
    expect(statusBox.x).toBeGreaterThan(actionBox.x + actionBox.width);
    expect(detailBox.x).toBeCloseTo(actionBox.x, 0);
    expect(detailBox.y).toBeGreaterThan(actionBox.y + actionBox.height);
    await action.tap();
    await expect(content.getByRole('status').first()).toHaveText('Disabled');
  });
});
