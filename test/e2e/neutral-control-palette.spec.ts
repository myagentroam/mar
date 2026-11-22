import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

// @test-covers packages/web-core/src/styles/mar-ui-theme.css
// @test-covers packages/mar-ui/components/button/MarButton.vue
// @test-covers packages/mar-ui/components/loading/loading.css

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/custom-theme.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const [scheme, width, background, foreground, loading] of [
  ['Dark', 1280, 'rgb(222, 222, 222)', 'rgb(24, 24, 24)', 'rgb(194, 194, 194)'],
  ['Light', 390, 'rgb(37, 99, 201)', 'rgb(255, 255, 255)', 'rgb(81, 81, 81)']
] as const) {
  test(`Confirmation controls and loading are independent of the running accent in ${scheme}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${fixture.url}custom-theme.html`);
    if (scheme === 'Light') {
      await page
        .locator('.theme-option')
        .filter({ has: page.getByRole('button', { name: 'Inspect Light', exact: true }) })
        .getByRole('button', { name: 'Apply theme', exact: true })
        .click();
    }
    await page.evaluate(() =>
      document.documentElement.style.setProperty('--mar-conversation-activity-fg', '#ff00ff')
    );
    const indicator = page.locator('.page-loading-panel .mar-ui-loading__indicator');
    await expect(indicator).toHaveCSS('color', loading);
    await page.getByTestId('open-close-confirmation').click();
    const dialog = page.getByRole('dialog', { name: 'Action confirmation' });
    const confirm = dialog.locator('.mar-ui-button--primary');
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    await expect(confirm).toBeFocused();
    await expect(confirm).toHaveCSS('background-color', background);
    await expect(confirm).toHaveCSS('color', foreground);
    await expect(cancel).not.toHaveCSS('background-color', background);
    await page.mouse.move(0, 0);
    await dialog
      .locator('.mar-ui-dialog')
      .screenshot({ path: testInfo.outputPath(`neutral-confirmation-${scheme}.png`) });
    await page.keyboard.press('Shift+Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(confirm).toBeFocused();
    await expect(confirm).toHaveCSS('outline-style', 'solid');
    await expect(confirm).toHaveCSS(
      'outline-color',
      scheme === 'Dark' ? 'rgb(160, 160, 160)' : 'rgb(96, 96, 96)'
    );
    await cancel.click();
    await expect(dialog).toBeHidden();
  });
}
