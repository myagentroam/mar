import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

// @test-covers packages/web-core/src/view/settings/UsageStatisticsSettings.vue
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('Usage filters stay compact on desktop and wrap without overflow in narrow panels', async ({
  page
}, testInfo) => {
  for (const width of [1600, 1280, 700, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${fixture.url}icon-system.html?usage=1&locale=zh-CN&theme=vscode-dark-2026`);
    const panel = page.getByTestId('usage-statistics');
    if (width === 1280) {
      await page.addStyleTag({
        content: '[data-testid="usage-statistics"] { max-inline-size: 500px; }'
      });
    }
    const form = panel.locator('.filters');
    const controls = form.locator('.mar-ui-select').filter({ has: page.getByRole('combobox') });
    await expect(controls).toHaveCount(4);
    const formBounds = (await form.boundingBox())!;
    const [range, runner, model, mode] = await Promise.all(
      (await controls.all()).map(async (control) => (await control.boundingBox())!)
    );
    const rem = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).fontSize)
    );
    for (const control of [range, runner, model, mode]) {
      expect(control.x).toBeGreaterThanOrEqual(formBounds.x);
      expect(control.x + control.width).toBeLessThanOrEqual(formBounds.x + formBounds.width + 1);
    }
    if (width === 1600) {
      expect(range.width).toBeCloseTo(10 * rem, 0);
      expect(runner.width).toBeCloseTo(range.width, 0);
      expect(model.width).toBeCloseTo(14 * rem, 0);
      expect(mode.width).toBeCloseTo(8 * rem, 0);
      expect(mode.y).toBeCloseTo(range.y, 0);
    } else {
      expect(range.width).toBeLessThanOrEqual(12 * rem + 1);
      expect(runner.y).toBeCloseTo(range.y, 0);
      expect(model.y).toBeGreaterThan(range.y + range.height);
      expect(model.x).toBeCloseTo(range.x, 0);
      expect(mode.x).toBeCloseTo(runner.x, 0);
      expect(mode.y).toBeCloseTo(model.y, 0);
    }
    await form.screenshot({ path: testInfo.outputPath(`usage-filters-${width}.png`) });
  }
});

for (const locale of ['en-US', 'zh-CN']) {
  for (const width of [1280, 390]) {
    test(`Usage custom ranges accept future dates and retain limits in ${locale} at ${width}px`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture.url}icon-system.html?usage=1&locale=${locale}`);
      const panel = page.getByTestId('usage-statistics');
      const records = panel.locator('.records');
      await expect(records).toHaveAttribute('aria-busy', 'false');
      await panel
        .getByRole('combobox', {
          name: locale === 'en-US' ? 'Time range' : '时间范围',
          exact: true
        })
        .click();
      await page
        .getByRole('option', {
          name: locale === 'en-US' ? 'Custom range' : '自定义范围',
          exact: true
        })
        .click();
      const dates = await page.evaluate(() => {
        const now = Date.now();
        const format = (days: number) => {
          const date = new Date(now + days * 86400000);
          const pad = (n: number) => String(n).padStart(2, '0');
          return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
        };
        return {
          past: format(-1),
          now: format(0),
          tomorrow: format(1),
          future: format(2),
          limit: format(90),
          overLimit: format(91)
        };
      });
      const inputs = panel.locator('.custom-range .mar-ui-date-picker__input');
      const refresh = panel.getByRole('button', {
        name: locale === 'en-US' ? 'Refresh' : '刷新',
        exact: true
      });
      for (const [from, to, valid] of [
        [dates.past, dates.tomorrow, true],
        [dates.tomorrow, dates.future, true],
        [dates.now, dates.limit, true],
        [dates.now, dates.overLimit, false]
      ] as const) {
        await inputs.first().fill(from);
        await inputs.last().fill(to);
        await inputs.last().press('Enter');
        await refresh.click();
        if (!valid) await expect(panel.getByRole('alert')).toBeVisible();
        else {
          await expect(panel.getByRole('alert')).toHaveCount(0);
          await expect(records).toHaveAttribute('aria-busy', 'false');
        }
      }
    });
  }
}
