import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/settings-layout.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

test('Browser cache interval saves beside the input and reports results in Feedback', async ({
  page
}, info) => {
  await page.setViewportSize({ width: 320, height: 660 });
  const endpoint = '**/api/auth/preferences/browser-settings';
  let reads = 0;
  const writes: unknown[] = [];
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'PUT') {
      writes.push(route.request().postDataJSON());
      if (writes.length === 1) {
        await route.fulfill({
          status: 500,
          json: { error: { code: 'INTERNAL_ERROR', requestId: 'cache-save-failure' } }
        });
      } else {
        await route.fulfill({ status: 204 });
      }
    } else if (++reads === 1) {
      await route.fulfill({ status: 500 });
    } else {
      await route.fulfill({ json: { revision: 1, cacheCleanupDays: 30 } });
    }
  });
  await page.goto(`${fixture.url}settings-layout.html?section=browser&locale=zh-CN`);

  const settings = page.getByRole('region', { name: '浏览器设置' });
  await expect(settings.getByRole('heading', { name: '浏览器设置', level: 1 })).toBeVisible();
  const errors = page.locator('.mar-message--error');
  await expect(errors).toHaveText(/无法加载账号的浏览器设置/);
  await expect(settings.getByText(/无法加载账号的浏览器设置/)).toHaveCount(0);
  await errors.getByRole('button', { name: '关闭' }).click();
  const retry = settings.getByRole('button', { name: '重试', exact: true });
  await retry.click();

  const interval = settings.getByRole('spinbutton', { name: '清理间隔（天）' });
  const save = settings.getByRole('button', { name: '保存', exact: true });
  await expect(interval).toHaveValue('30');
  await expect(retry).toHaveCount(0);
  await expect(save).toBeDisabled();
  await expect(save.locator('svg')).toBeVisible();
  const groupBoundaries = [
    [settings.getByText('管理工作台中的浏览器偏好。'), settings.getByRole('checkbox')],
    [
      settings.getByText(/允许 MAR Agent 使用隔离浏览器/),
      settings.getByRole('heading', { name: '缓存清理周期', level: 2 })
    ],
    [save, settings.getByRole('heading', { name: '链接打开方式', level: 2 })]
  ] as const;
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 660 });
    await expect(save).toBeInViewport({ ratio: 1 });
    const inputBox = (await settings.locator('.mar-ui-input-number').boundingBox())!;
    const saveBox = (await save.boundingBox())!;
    expect(saveBox.x).toBeGreaterThan(inputBox.x + inputBox.width);
    expect(saveBox.y + saveBox.height / 2).toBeCloseTo(inputBox.y + inputBox.height / 2, 0);
    for (const [previous, next] of groupBoundaries) {
      const previousBox = (await previous.boundingBox())!;
      const nextBox = (await next.boundingBox())!;
      const gap = nextBox.y - (previousBox.y + previousBox.height);
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThanOrEqual(28);
    }
  }
  await interval.fill('');
  await save.click();
  await expect(settings.getByRole('alert')).toHaveText('请输入 1–60 之间的整数。');
  expect(writes).toEqual([]);

  await interval.fill('7');
  await save.click();
  const saveError = errors.filter({ hasText: '无法保存缓存清理周期。' });
  await expect(saveError).toBeVisible();
  await expect(saveError).toContainText('请求 ID：cache-save-failure');
  await expect(settings.getByRole('alert')).toHaveCount(0);
  await expect(interval).toHaveValue('7');
  await saveError.getByRole('button', { name: '关闭' }).click();
  await expect(errors).toHaveCount(0);
  await save.click();
  const success = page.locator('.mar-message--success');
  await expect(success).toContainText('已保存到账号。');
  await expect(settings.getByText('已保存到账号。')).toHaveCount(0);
  await expect(save).toBeDisabled();
  expect(writes).toEqual([{ cacheCleanupDays: 7 }, { cacheCleanupDays: 7 }]);
  await expect(success).toHaveCSS('opacity', '1');
  await page.screenshot({
    path: info.outputPath('browser-cache-settings.png'),
    animations: 'disabled'
  });
});

test('Browser link destinations keep their labels and save independently on mobile', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await page.route('**/api/auth/preferences/browser-settings', (route) =>
    route.fulfill({ json: { revision: 1, cacheCleanupDays: 30 } })
  );
  await page.goto(`${fixture.url}settings-layout.html?section=browser&locale=en-US`);

  const settings = page.getByRole('region', { name: 'Browser settings' });
  const web = settings.getByRole('combobox', { name: 'Web links', exact: true });
  const local = settings.getByRole('combobox', { name: 'Local URLs and HTML links', exact: true });
  await expect(web).toHaveText('This device');
  await expect(local).toHaveText('MAR');
  await settings.getByText('Web links', { exact: true }).click();
  await expect(web).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('option', { name: 'MAR', exact: true }).click();
  await expect(web).toHaveText('MAR');
  await page.reload();
  await expect(web).toHaveText('MAR');
  await expect(local).toHaveText('MAR');
  await local.click();
  await page.getByRole('option', { name: 'This device', exact: true }).click();
  await expect(local).toHaveText('This device');
  await page.reload();
  await expect(web).toHaveText('MAR');
  await expect(local).toHaveText('This device');
});

const sections = [
  { id: 'appearance', selector: '.full', title: 'h2' },
  { id: 'account', selector: '.full', title: 'h2' },
  { id: 'usage', selector: '.usage-content', title: 'h2' },
  { id: 'custom-themes', selector: '.theme-settings', title: 'h2' },
  { id: 'notifications', selector: '.full', title: 'h2' },
  { id: 'quick-prompts', selector: '.quick-prompts-content', title: 'h2' },
  { id: 'personal-instructions', selector: '.personal-instructions', title: 'h2' },
  { id: 'browser', selector: '.browser-settings', title: 'h1' },
  { id: 'git', selector: '.mar-management-page', title: 'h1' },
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
      await page.route('**/api/auth/preferences/browser-settings', (route) =>
        route.fulfill({ json: { revision: 1, cacheCleanupDays: 30 } })
      );
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

          if (section.id === 'appearance' || section.id === 'browser') {
            const rows = panel.locator('.mar-settings-option-row');
            if (section.id === 'appearance') {
              await expect(
                rows.getByRole('combobox', {
                  name: locale === 'zh-CN' ? '输入预测' : 'Composer Prediction',
                  exact: true
                })
              ).toBeVisible();
            }
            const row = rows.first();
            await expect(row.getByRole('combobox')).toBeVisible();
            const control = row.locator('.mar-ui-select');
            const label = row.locator('label');
            const bounds = (await row.boundingBox())!;
            const input = (await control.boundingBox())!;
            const text = (await label.boundingBox())!;
            const mobileGap = input.y - (text.y + text.height);
            if (width > 767) {
              const rootFontSize = await page.evaluate(() =>
                parseFloat(getComputedStyle(document.documentElement).fontSize)
              );
              expect(bounds.width).toBeLessThanOrEqual(rootFontSize * 36);
              expect(input.width).toBeLessThan(320);
              expect(Math.abs(bounds.x + bounds.width - input.x - input.width)).toBeLessThan(2);
            } else {
              expect(mobileGap).toBeGreaterThan(0);
            }
            for (const option of await rows.all()) {
              const box = (await option.locator('.mar-ui-select').boundingBox())!;
              const optionLabel = (await option.locator('label').boundingBox())!;
              expect(box.x).toBeCloseTo(input.x, 0);
              expect(box.width).toBeCloseTo(input.width, 0);
              if (width > 767) {
                expect(box.y + box.height / 2).toBeCloseTo(
                  optionLabel.y + optionLabel.height / 2,
                  0
                );
              } else {
                expect(box.y - (optionLabel.y + optionLabel.height)).toBeCloseTo(mobileGap, 0);
              }
            }
          }
          if (section.id === 'browser') {
            await expect(panel.getByRole('spinbutton')).toHaveValue('30');
            await expect(panel.getByRole('checkbox')).toHaveAccessibleDescription(/MAR Agent/);
          }
          if (section.id === 'git') {
            await expect(panel.locator('header .git-page-hint')).toBeVisible();
            await expect(
              panel.getByRole('cell', { name: 'Example Git', exact: true })
            ).toBeVisible();
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

  test('Offline Push retry keeps the busy state on its own action', async ({ page }, info) => {
    const pending = Promise.withResolvers<void>();
    let requests = 0;
    await page.route('**/fixture-push-subscription', async (route) => {
      requests++;
      await pending.promise;
      await route.fulfill({ status: 204 });
    });
    await page.goto(
      `${fixture.url}settings-layout.html?section=notifications&locale=en-US&theme=daylight&push-retry`
    );
    const content = page.locator('.settings-content');
    const enable = content.getByRole('button', { name: 'Enable / retry offline Push' });
    const disable = content.getByRole('button', { name: 'Disable offline Push' });
    await expect(enable).toBeVisible();
    await page.screenshot({
      path: info.outputPath('push-unavailable.png'),
      animations: 'disabled'
    });
    await enable.click();
    await expect(enable).toHaveAttribute('aria-busy', 'true');
    await expect(disable).toBeDisabled();
    await expect(disable).not.toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => requests).toBe(1);
    await page.screenshot({ path: info.outputPath('push-enabling.png'), animations: 'disabled' });
    pending.resolve();
    await expect(content.getByText(/Offline Push is ready/)).toBeVisible();
    await expect(disable).toBeEnabled();
    await page.screenshot({ path: info.outputPath('push-ready.png'), animations: 'disabled' });
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
