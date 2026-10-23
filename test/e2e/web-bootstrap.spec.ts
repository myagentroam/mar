import { expect, test } from '@playwright/test';

for (const theme of ['daylight', 'vscode-dark-2026']) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 }
  ]) {
    test(`bootstrap stays centered and respects reduced motion in ${theme} at ${viewport.width}px`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.addInitScript((value) => localStorage.setItem('mar.theme', value), theme);
      // Keep the application unloaded to exercise the independent HTML bootstrap.
      await page.route('**/*', (route) =>
        route.request().resourceType() === 'script' ? route.abort() : route.continue()
      );
      await page.goto('/console');
      const bootstrap = page.locator('#mar-bootstrap');
      const graphic = bootstrap.locator('svg');
      await expect(bootstrap).toBeVisible();
      await expect(bootstrap).toHaveCSS(
        'background-color',
        theme === 'daylight' ? 'rgb(243, 246, 249)' : 'rgb(14, 17, 22)'
      );
      const bounds = await graphic.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x + bounds!.width / 2).toBeCloseTo(viewport.width / 2, 0);
      expect(bounds!.y + bounds!.height / 2).toBeCloseTo(viewport.height / 2, 0);
      expect(bounds!.width).toBeGreaterThanOrEqual(40);
      expect(bounds!.width).toBeLessThanOrEqual(64);
      expect(await graphic.evaluate((svg) => svg.getAnimations({ subtree: true }).length)).toBe(1);
      expect(
        await graphic.evaluate(async (svg) => {
          const animation = svg.getAnimations({ subtree: true })[0]!;
          await animation.ready;
          const before = Number(animation.currentTime);
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          return Number(animation.currentTime) > before;
        })
      ).toBe(true);
      await graphic.evaluate((svg) => {
        for (const animation of svg.getAnimations({ subtree: true })) {
          animation.pause();
          animation.currentTime = 350;
        }
      });
      await page.screenshot({
        path: testInfo.outputPath('bootstrap.png'),
        clip: { x: viewport.width / 2 - 80, y: viewport.height / 2 - 80, width: 160, height: 160 }
      });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect
        .poll(() => graphic.evaluate((svg) => svg.getAnimations({ subtree: true }).length))
        .toBe(0);
      await expect(graphic).toBeVisible();
      await expect(bootstrap).toHaveCSS('transition-duration', '0s');
      await bootstrap.evaluate((element) => element.classList.add('mar-bootstrap--leaving'));
      await expect(bootstrap).toHaveCSS('opacity', '0');
      await expect(bootstrap).toHaveCSS('pointer-events', 'none');
    });
  }
}
