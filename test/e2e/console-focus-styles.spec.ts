import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

// @test-covers packages/web-core/src/styles.css
test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

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
    await expect(nativeButton).not.toHaveCSS('outline-style', 'none');

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
