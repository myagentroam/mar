import { expect, test, type Locator } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

// @test-covers packages/web-core/src/view/composer/ComposerToolbar.vue
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/composer-options.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

async function expectMenuInsideViewport(menu: Locator) {
  await expect(menu).toBeVisible();
  await menu.evaluate(async (element) => {
    for (let current: Element | null = element; current; current = current.parentElement) {
      await Promise.allSettled(current.getAnimations().map((animation) => animation.finished));
    }
  });
  await expect
    .poll(() =>
      menu.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.left >= 8 &&
          rect.right <= innerWidth - 8 &&
          rect.top >= 8 &&
          rect.bottom <= innerHeight - 8
        );
      })
    )
    .toBe(true);
}

for (const [width, height, theme, top] of [
  [1280, 844, 'daylight', false],
  [390, 844, 'vscode-dark-2026', false],
  [320, 360, 'daylight', true]
] as const) {
  test(`Composer menus keep gutters and local scrolling (${width}x${height}, ${theme})`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width, height });
    await page.goto(
      `${fixture.url}composer-options.html?theme=${theme}${width < 768 ? '&mobile' : ''}${top ? '&top' : ''}`
    );
    for (const kind of ['runner', 'access', 'model-effort']) {
      await page.locator(`.composer-${kind}-select`).click();
      const menu = page.locator(`.el-select-dropdown.composer-${kind}-popper:visible`);
      await expectMenuInsideViewport(menu);
      if (kind === 'model-effort') {
        const scroll = menu.locator('.el-scrollbar__wrap');
        expect(
          await scroll.evaluate((element) => element.scrollHeight > element.clientHeight)
        ).toBe(true);
        await page.screenshot({ path: info.outputPath('model-menu.png'), animations: 'disabled' });
        if (height < 400) {
          await page.setViewportSize({ width, height: 240 });
          await expectMenuInsideViewport(menu);
        }
        const last = menu.getByRole('option', {
          name: 'Engineering model 32 with a descriptive configuration name',
          exact: true
        });
        await last.scrollIntoViewIfNeeded();
        await expectMenuInsideViewport(menu);
        expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await last.click();
        await expect(page.getByTestId('selected-model')).toHaveText('model-31');
        await page.locator('.composer-model-effort-select').click();
        await expect(last).toBeInViewport();
        await page.keyboard.press('Tab');
        await expect(menu.getByRole('option', { name: 'medium', exact: true })).toBeInViewport();
        await page.keyboard.press('Tab');
        await expect(last).toBeInViewport();
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        expect(
          await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)
        ).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
      } else {
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
      }
    }
  });
}
