import { expect, test } from '@playwright/test';
import { commonMessages } from '../../packages/web-core/src/i18n/messages.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const locale of ['en-US', 'zh-CN'] as const) {
  test(`appearance offers only MAR File Icons and ignores the old storage key: ${locale}`, async ({
    page
  }, testInfo) => {
    const messages = commonMessages[locale];
    const pageErrors: string[] = [];
    const apiRequests: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
    });
    await page.goto(`${fixture.url}custom-theme.html?locale=${locale}&appearance-only`);
    await page.evaluate(() => localStorage.setItem('mar.icon-theme', 'material'));
    await page.reload();
    const openAppearance = () =>
      page.getByRole('button', { name: messages.settings.appearance, exact: true }).click();
    const select = page
      .locator('.el-select')
      .filter({ has: page.locator('#appearance-icon-theme') });
    const preview = page.getByTestId('icon-theme-preview');
    await openAppearance();
    await expect(select).toContainText(messages.settings.iconThemeMar);
    await select.click();
    await expect(page.getByRole('option')).toHaveText([messages.settings.iconThemeMar]);
    await page.keyboard.press('Escape');
    const marIcon = preview.locator('.mar-file-icon svg');
    await expect(marIcon).toBeVisible();
    // A visible wrapper is not enough: the bundled external symbol must resolve and draw.
    await expect
      .poll(() =>
        marIcon
          .locator('use')
          .first()
          .evaluate((el: SVGUseElement) => el.getBBox().width)
      )
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => localStorage.getItem('mar.icon-theme.v2'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('mar.icon-theme'))).toBe('material');
    await preview.screenshot({ path: testInfo.outputPath(`mar-file-icons-${locale}.png`) });

    // A removed theme on the current key is also ignored, without rewriting the stored value.
    await page.evaluate(() => localStorage.setItem('mar.icon-theme.v2', 'seti'));
    await page.reload();
    await openAppearance();
    await expect(select).toContainText(messages.settings.iconThemeMar);
    await expect(marIcon).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('mar.icon-theme.v2'))).toBe('seti');
    expect(pageErrors).toEqual([]);
    expect(apiRequests).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('mar.icon-theme'))).toBe('material');
  });
}
