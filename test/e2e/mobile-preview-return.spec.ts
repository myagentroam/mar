import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('A mobile file window traps focus and Back closes the whole window rather than one tab', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.url}file-tabs.html`);
  const window = page.locator('.workspace-file-tabs');
  await expect(window).toBeVisible();
  await expect(window.getByRole('tab')).toHaveCount(12);
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.textContent = 'Background action';
    document.body.append(button);
  });
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    expect(await window.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  const route = page.url();
  await page.goBack();
  await expect(window).toHaveCount(0);
  await expect(page).toHaveURL(route);
  await expect(page.getByRole('button', { name: 'Background action' })).toBeVisible();
});
