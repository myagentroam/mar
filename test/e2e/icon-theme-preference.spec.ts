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
  test(`icon theme keeps the saved selection and rendered icon on write failure, then retries: ${locale}`, async ({
    page
  }, testInfo) => {
    const messages = commonMessages[locale];
    const pageErrors: string[] = [];
    const apiRequests: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
    });
    await page.goto(`${fixture.url}custom-theme.html?locale=${locale}`);
    const openAppearance = () =>
      page.getByRole('button', { name: messages.settings.appearance, exact: true }).click();
    const select = page
      .locator('.el-select')
      .filter({ has: page.locator('#appearance-icon-theme') });
    const preview = page.getByTestId('icon-theme-preview');
    const choose = async (name: string) => {
      await select.click();
      await page.getByRole('option', { name, exact: true }).click();
    };
    await openAppearance();
    await expect(select).toContainText('Material');
    await expect(preview.locator('.material-file-icon svg')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('mar.icon-theme'))).toBeNull();

    await choose('Seti');
    await expect(preview.locator('.seti-file-icon')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('mar.icon-theme'))).toBe('seti');
    await page.reload();
    await openAppearance();
    await expect(select).toContainText('Seti');
    await expect(preview.locator('.seti-file-icon')).toBeVisible();
    const savedIcon = await preview.innerHTML();

    // Fault only this browser's icon preference writes; other settings remain real.
    await page.evaluate(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (this === localStorage && key === 'mar.icon-theme') {
          throw new DOMException('Storage unavailable', 'QuotaExceededError');
        }
        setItem.call(this, key, value);
      };
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await choose('Material');
      const feedback = page.locator('.el-message--error');
      await expect(feedback).toHaveCount(1);
      await expect(feedback).toHaveText(messages.customThemes.storageFailed);
      await expect(feedback).toBeInViewport();
      await expect(feedback).toHaveCSS('opacity', '1');
      await expect(select).toContainText('Seti');
      expect(await preview.innerHTML()).toBe(savedIcon);
      expect(await page.evaluate(() => localStorage.getItem('mar.icon-theme'))).toBe('seti');
      if (attempt === 0) {
        await page.screenshot({
          path: testInfo.outputPath(`storage-failure-${locale}.png`),
          animations: 'disabled'
        });
      }
      await feedback.locator('.el-message__closeBtn').click();
      await expect(feedback).toHaveCount(0);
    }
    expect(pageErrors).toEqual([]);

    // Reload removes the injected failure and restores the last committed value.
    await page.reload();
    await openAppearance();
    await expect(select).toContainText('Seti');
    await choose('Material');
    await expect(preview.locator('.material-file-icon svg')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('mar.icon-theme'))).toBe('material');
    await page.reload();
    await openAppearance();
    await expect(select).toContainText('Material');
    await expect(preview.locator('.material-file-icon svg')).toBeVisible();
    expect(pageErrors).toEqual([]);
    expect(apiRequests).toEqual([]);
  });
}
