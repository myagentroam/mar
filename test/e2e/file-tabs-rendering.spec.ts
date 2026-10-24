import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

for (const width of [1280, 390]) {
  test(`File tabs preserve keyboard navigation and bounded loading at ${width}px`, async ({
    page
  }) => {
    const fixture = await startCustomThemeFixture();
    try {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${fixture.url}file-tabs.html`);
      const tabs = page.getByRole('tab');
      await expect(tabs).toHaveCount(12);
      await page.locator('html').evaluate((element) => {
        element.style.setProperty('--mar-text-primary', '#d6dfc9');
        element.style.setProperty('--mar-color-brand-text', '#af79d0');
      });
      for (const close of [
        page.locator('.workspace-file-tab-close').first(),
        page.locator('.workspace-file-window-close')
      ]) {
        await close.hover();
        await expect(close).toHaveCSS('color', 'rgb(214, 223, 201)');
        await expect(close).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await close.focus();
        await expect(close).toHaveCSS('outline-style', 'solid');
        await expect(close).toHaveCSS('outline-width', '2px');
      }
      await expect(tabs.nth(0)).toHaveAttribute('tabindex', '0');
      await expect(tabs.nth(1)).toHaveAttribute('tabindex', '-1');
      await tabs.nth(0).focus();
      await page.keyboard.press('ArrowLeft');
      await expect(tabs.nth(11)).toBeFocused();
      await expect(tabs.nth(11)).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Home');
      await expect(tabs.nth(0)).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(tabs.nth(1)).toBeFocused();
      await page.keyboard.press('End');
      await expect(tabs.nth(11)).toBeFocused();
      const list = page.getByRole('tablist');
      expect(await list.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      expect((await tabs.nth(11).boundingBox())!.width).toBeGreaterThan(60);
      const frame = page.locator('.workspace-file-page-frame:visible');
      await expect(frame).toHaveAttribute('aria-busy', 'true');
      const content = frame.locator('.workspace-file-page-frame-content');
      const status = frame.getByRole('status');
      await expect(status).toBeVisible();
      const region = (await content.boundingBox())!;
      const overlay = (await status.boundingBox())!;
      expect(overlay.y).toBeGreaterThanOrEqual(region.y - 1);
      expect(overlay.y + overlay.height).toBeLessThanOrEqual(region.y + region.height + 1);
      expect(region.height).toBeGreaterThan(500);
      await expect(page.locator('html')).toHaveClass(/file-preview-open/);
      if (width === 1280) {
        await frame.getByRole('button', { name: 'Finish loading' }).click();
        await expect(status).toHaveCount(0);
        await expect(frame).not.toHaveAttribute('aria-busy', 'true');
      }
      await page.locator('.workspace-file-window-close').click();
      await expect(page.getByText('Files closed')).toBeVisible();
      await expect(page.locator('html')).not.toHaveClass(/file-preview-open/);
      await expect(page.locator('body')).not.toHaveClass(/file-preview-open/);
    } finally {
      await fixture.close();
    }
  });
}
