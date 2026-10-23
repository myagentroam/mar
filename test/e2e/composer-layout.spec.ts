import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});
test.use({ deviceScaleFactor: 3 });

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Composer reserves its exact height without a mobile seam: ${theme}`, async ({
    page
  }, testInfo) => {
    for (const width of [390, 420, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        `${fixture.url}visual-alignment.html?hosted=1&theme=${theme}${width < 768 ? '&mobile=1' : ''}`
      );
      const host = page.locator('.composer-host');
      const composer = host.locator('> .composer');
      await expect(composer).toBeVisible();
      for (const height of [313.1875, 379.3125]) {
        await composer.evaluate((element, value) => {
          element.style.height = `${value}px`;
        }, height);
        await expect
          .poll(async () => {
            const reserved = (await host.boundingBox())!.height;
            const actual = (await composer.boundingBox())!.height;
            return Math.abs(reserved - actual);
          })
          .toBeLessThan(0.02);
      }
      await composer.evaluate((element) => element.style.removeProperty('height'));
      await expect
        .poll(async () => {
          const reserved = (await host.boundingBox())!.height;
          const actual = (await composer.boundingBox())!.height;
          return Math.abs(reserved - actual);
        })
        .toBeLessThan(0.02);
      await page.screenshot({ path: testInfo.outputPath(`composer-${width}.png`) });
    }
  });
}
