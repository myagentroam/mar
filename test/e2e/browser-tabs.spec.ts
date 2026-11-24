import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

test('Browser page tabs use the shared selection fill without highlighting the toolbar', async ({
  page
}, testInfo) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/browser-downloads.html');
  try {
    await page.setViewportSize({ width: 960, height: 700 });
    await page.goto(`${fixture.url}browser-downloads.html`);
    const tabs = page.getByRole('tablist', { name: 'Browser' });
    const firstTab = tabs.getByRole('tab', { name: 'Downloads fixture' });
    const secondTab = tabs.getByRole('tab', { name: 'Second page' });
    const toolbar = page.locator('.node-browser-toolbar');

    for (const theme of ['dark', 'light', 'custom'] as const) {
      await page.evaluate((theme) => {
        const root = document.documentElement;
        root.dataset.theme = theme === 'light' ? 'daylight' : 'vscode-dark-2026';
        if (theme === 'custom') root.style.setProperty('--mar-fill-selection', '#285654');
      }, theme);
      if (theme === 'light') await page.setViewportSize({ width: 390, height: 700 });
      const { selection, hover } = await tabs.evaluate((element) => {
        const probe = document.createElement('span');
        probe.hidden = true;
        element.append(probe);
        probe.style.color = 'var(--mar-fill-selection)';
        const selection = getComputedStyle(probe).color;
        probe.style.color = 'var(--mar-fill-row-hover)';
        const hover = getComputedStyle(probe).color;
        probe.remove();
        return { selection, hover };
      });

      await firstTab.click();
      await expect(firstTab).toHaveAttribute('aria-selected', 'true');
      const activeSurface = firstTab.locator('..');
      await expect(activeSurface).toHaveCSS('background-color', selection);
      const firstClose = activeSurface.getByRole('button', { name: /^Close /u });
      const [tabBox, closeBox] = await Promise.all([
        activeSurface.boundingBox(),
        firstClose.boundingBox()
      ]);
      expect(tabBox!.x + tabBox!.width - closeBox!.x - closeBox!.width).toBeGreaterThanOrEqual(2);
      const cornerFills = await activeSurface.evaluate((element) =>
        ['::before', '::after'].map((corner) => getComputedStyle(element, corner).backgroundImage)
      );
      for (const fill of cornerFills) expect(fill).toContain(selection);
      await expect(secondTab.locator('..')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(toolbar).not.toHaveCSS('background-color', selection);
      if (theme === 'dark') {
        await firstClose.hover();
        await page.locator('.node-browser-tabs').screenshot({
          path: testInfo.outputPath('browser-tabs-dark.png')
        });
      }
      await secondTab.hover();
      await expect(secondTab.locator('..')).toHaveCSS('background-color', hover);
      await secondTab.click();
      await expect(secondTab).toHaveAttribute('aria-selected', 'true');
      await expect(secondTab.locator('..')).toHaveCSS('background-color', selection);
      await expect(firstTab.locator('..')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    }
  } finally {
    await fixture.close();
  }
});
