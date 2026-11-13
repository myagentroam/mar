import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.use({ hasTouch: true });
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const scheme of ['Light', 'Dark']) {
  for (const width of [1280, 390]) {
    test(`Dropdown actions retain neutral interaction colors in ${scheme} at ${width}px`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture.url}custom-theme.html`);
      if (scheme === 'Light')
        await page
          .locator('.theme-option')
          .filter({ has: page.getByRole('button', { name: 'Inspect Light', exact: true }) })
          .getByRole('button', { name: 'Apply theme', exact: true })
          .click();
      const samples = page.getByRole('region', { name: 'Dropdown state samples' });
      const trigger = samples.getByRole('button', { name: 'Sample menu', exact: true });
      const result = samples.getByRole('status', { name: 'Selected menu action' });
      for (const custom of [false, true]) {
        if (custom)
          await page.locator('html').evaluate((element) => {
            for (const [token, value] of Object.entries({
              '--mar-color-brand': '#bf6ac9',
              '--mar-text-primary': '#dae5cf',
              '--mar-text-secondary': '#b6c3af',
              '--mar-text-faint': '#8293a4',
              '--mar-fill-row-hover': '#334455'
            }))
              element.style.setProperty(token, value);
          });
        const palette = await samples.evaluate((element) => {
          const probe = document.createElement('span');
          element.append(probe);
          const color = (token: string) => {
            probe.style.color = `var(${token})`;
            return getComputedStyle(probe).color;
          };
          const colors = {
            normal: color('--mar-text-secondary'),
            active: color('--mar-text-primary'),
            hover: color('--mar-fill-row-hover'),
            disabled: color('--mar-text-faint'),
            focus: color('--mar-color-brand')
          };
          probe.remove();
          return colors;
        });
        await trigger.click();
        const rename = page.getByRole('menuitem', { name: 'Rename', exact: true });
        const copy = page.getByRole('menuitem', { name: 'Copy', exact: true });
        const disabled = page.getByRole('menuitem', { name: 'Unavailable', exact: true });
        const remove = page.getByRole('menuitem', { name: 'Delete', exact: true });
        await expect(copy).toHaveCSS('color', palette.normal);
        await copy.hover();
        await expect(copy).toHaveCSS('color', palette.active);
        await expect(copy).toHaveCSS('background-color', palette.hover);
        await expect(copy.locator('.mar-icon')).toHaveCSS('color', palette.active);
        await disabled.hover({ force: true });
        await expect(disabled).toHaveAttribute('aria-disabled', 'true');
        await expect(disabled).toHaveCSS('color', palette.disabled);
        await expect(disabled).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await trigger.click();
        await expect(copy).toBeHidden();
        await page.mouse.move(0, 0);
        await trigger.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await expect(trigger).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(copy).toBeVisible();
        await rename.focus();
        await page.keyboard.press('ArrowDown');
        await expect(copy).toBeFocused();
        await expect(copy).toHaveCSS('color', palette.active);
        await expect(copy).toHaveCSS('background-color', palette.hover);
        await expect(copy).toHaveCSS('outline-color', palette.focus);
        await expect(copy).toHaveCSS('outline-style', 'solid');
        await page.keyboard.press('ArrowDown');
        await expect(remove).toBeFocused();
        if (!custom)
          await page.getByRole('menu').screenshot({
            path: testInfo.outputPath(`dropdown-${scheme}-${width}.png`)
          });
        await page.keyboard.press('Escape');
        await expect(copy).toBeHidden();
        await trigger.tap();
        await copy.tap();
        await expect(result).toHaveText('copy');
        await expect(copy).toBeHidden();
      }
    });
  }
}
