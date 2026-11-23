import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

// @test-covers packages/web-core/src/styles.css
test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

// @test-covers packages/mar-ui/styles/base.css
test('MAR UI base styles work without the Console stylesheet or theme', async ({ page }) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/mar-ui-base.html');
  try {
    await page.goto(`${fixture.url}mar-ui-base.html`);
    const button = page.getByRole('button', { name: 'Native action' });
    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    await expect(button).toHaveCSS('outline', 'rgb(0, 0, 0) solid 2px');
    await expect(button).toHaveCSS('outline-offset', '2px');
    await expect(button).toHaveCSS('border-top-width', '0px');
    await expect(button).toHaveCSS('font-family', 'monospace');
    const scroller = page.locator('#scroller');
    await expect(scroller).toHaveCSS('box-sizing', 'border-box');
    await expect(scroller).toHaveCSS('scrollbar-width', 'thin');
    await expect(scroller).toHaveCSS('scrollbar-color', 'auto');

    await page.locator('html').evaluate((element) => {
      element.style.setProperty('--mar-ui-control-focus', '#a92b70');
      element.style.setProperty('--mar-ui-scrollbar-thumb', '#456789');
    });
    await expect(button).toHaveCSS('outline', 'rgb(169, 43, 112) solid 2px');
    await expect(scroller).toHaveCSS('scrollbar-color', 'rgb(69, 103, 137) rgba(0, 0, 0, 0)');
  } finally {
    await fixture.close();
  }
});

test('Console suppresses native tap rings without losing keyboard or editing focus', async ({
  page
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/console-focus-styles.html');
  try {
    await page.goto(`${fixture.url}console-focus-styles.html`);
    const graphic = page.getByRole('img', { name: 'Graphic' });
    await graphic.tap();
    await expect(graphic).toHaveCSS('outline-style', 'none');

    const nativeButton = page.getByRole('button', { name: 'Native action' });
    await page.keyboard.press('Tab');
    await expect(nativeButton).toBeFocused();
    await expect(nativeButton).toHaveCSS('outline', 'rgb(23, 78, 158) solid 2px');
    await graphic.tap();
    await nativeButton.tap();
    await expect(nativeButton).toHaveCSS('outline-style', 'none');

    const text = page.getByRole('textbox', { name: 'Text field' });
    await text.tap();
    await expect(text).toBeFocused();
    await expect(text).not.toHaveCSS('outline-style', 'none');

    const customButton = page.getByRole('button', { name: 'Styled action' });
    await customButton.tap();
    await expect(customButton).toBeFocused();
    await expect(customButton).toHaveCSS('outline-style', 'dashed');
  } finally {
    await fixture.close();
  }
});

test('Console focus and link colors are independent in built-in and custom themes', async ({
  page
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/console-focus-styles.html');
  try {
    await page.goto(`${fixture.url}console-focus-styles.html`);
    const button = page.getByRole('button', { name: 'Native action' });
    const link = page.getByRole('link', { name: 'Theme link' });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    await expect(button).toHaveCSS('outline-color', 'rgb(23, 78, 158)');
    await expect(link).toHaveCSS('color', 'rgb(23, 78, 158)');

    const root = page.locator('html');
    await root.evaluate((element) => element.setAttribute('data-theme', 'vscode-dark-2026'));
    await expect(button).toHaveCSS('outline-color', 'rgb(117, 183, 255)');
    await expect(link).toHaveCSS('color', 'rgb(117, 183, 255)');
    await root.evaluate((element) => {
      element.style.setProperty('--mar-control-focus', '#ffcc66');
      element.style.setProperty('--mar-link-text', '#99ffff');
    });
    await expect(button).toHaveCSS('outline-color', 'rgb(255, 204, 102)');
    await expect(link).toHaveCSS('color', 'rgb(153, 255, 255)');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(button).toBeFocused();
    await page.emulateMedia({ forcedColors: 'active' });
    await expect(button).toHaveCSS('outline-style', 'solid');
    await expect(button).not.toHaveCSS('outline-color', 'rgb(255, 204, 102)');
  } finally {
    await fixture.close();
  }
});
