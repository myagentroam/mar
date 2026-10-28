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
    test(`Tabs retain neutral selection, focus and overflow in ${scheme} at ${width}px`, async ({
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
      const samples = page.getByRole('region', { name: 'Tabs state samples' });
      const settings = samples.getByRole('tab', { name: 'Settings', exact: true });
      const permissions = samples.getByRole('tab', { name: 'Permissions', exact: true });
      const disabled = samples.getByRole('tab', { name: 'Unavailable', exact: true });
      const configuration = samples.getByRole('tab', {
        name: 'Long configuration tab name',
        exact: true
      });
      for (const custom of [false, true]) {
        if (custom)
          await page.locator('html').evaluate((element) => {
            for (const [token, value] of Object.entries({
              '--mar-color-brand': '#bf6ac9',
              '--mar-text-primary': '#dae5cf',
              '--mar-text-secondary': '#b6c3af',
              '--mar-text-faint': '#8293a4',
              '--mar-bg-tab-inactive': '#1a2530',
              '--mar-fill-row-hover': '#334455',
              '--mar-fill-selection': '#445566'
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
            inactive: color('--mar-bg-tab-inactive'),
            selected: color('--mar-fill-selection'),
            hover: color('--mar-fill-row-hover'),
            disabled: color('--mar-text-faint'),
            focus: color('--mar-color-brand')
          };
          probe.remove();
          return colors;
        });
        await settings.click();
        await page.mouse.move(0, 0);
        await expect(settings).toHaveAttribute('aria-selected', 'true');
        await expect(settings).toHaveCSS('color', palette.active);
        await expect(settings).toHaveCSS('background-color', palette.selected);
        await expect(permissions).toHaveCSS('color', palette.normal);
        await expect(permissions).toHaveCSS('background-color', palette.inactive);
        await expect(samples.locator('.el-tabs__active-bar')).toBeHidden();
        await permissions.hover();
        await expect(permissions).toHaveCSS('color', palette.active);
        await expect(permissions).toHaveCSS('background-color', palette.hover);
        await settings.hover();
        await expect(settings).toHaveCSS('background-color', palette.selected);
        await expect(disabled).toHaveClass(/is-disabled/);
        await disabled.hover({ force: true });
        await expect(disabled).toHaveCSS('color', palette.disabled);
        await expect(disabled).toHaveCSS('background-color', palette.inactive);
        await disabled.click({ force: true });
        await expect(settings).toHaveAttribute('aria-selected', 'true');
        await settings.focus();
        await page.keyboard.press('ArrowRight');
        await expect(permissions).toBeFocused();
        await expect(permissions).toHaveAttribute('aria-selected', 'true');
        await expect(permissions).toHaveCSS('outline-style', 'solid');
        await expect(permissions).toHaveCSS('outline-color', palette.focus);
        await expect(
          samples.getByRole('tabpanel', { name: 'Permissions', exact: true })
        ).toHaveText('Permissions content');
        await page.keyboard.press('ArrowRight');
        await expect(configuration).toBeFocused();
        await expect(configuration).toHaveAttribute('aria-selected', 'true');
        const header = samples.locator('.el-tabs__header');
        const bounds = (await header.boundingBox())!;
        await expect
          .poll(async () => {
            const tabBounds = (await configuration.boundingBox())!;
            return (
              tabBounds.x >= bounds.x &&
              tabBounds.x + tabBounds.width <= bounds.x + bounds.width + 1
            );
          })
          .toBe(true);
        const padding = await settings.evaluate((element) => {
          const style = getComputedStyle(element);
          return [style.paddingLeft, style.paddingRight];
        });
        expect(padding[0]).toBe(padding[1]);
        if (!custom)
          await header.screenshot({ path: testInfo.outputPath(`tabs-${scheme}-${width}.png`) });
        await page.keyboard.press('ArrowLeft');
        await expect(permissions).toBeFocused();
        await page.keyboard.press('ArrowLeft');
        await expect(settings).toBeFocused();
        await permissions.tap();
        await expect(permissions).toHaveAttribute('aria-selected', 'true');
        await expect(
          samples.getByRole('tabpanel', { name: 'Permissions', exact: true })
        ).toBeVisible();
      }
    });
  }
}
