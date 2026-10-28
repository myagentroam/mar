import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const locale of ['en-US', 'zh-CN']) {
  for (const width of [1280, 390]) {
    test(`Usage custom ranges accept future dates and retain limits in ${locale} at ${width}px`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture.url}icon-system.html?usage=1&locale=${locale}`);
      const panel = page.getByTestId('usage-statistics');
      await expect(panel).toHaveAttribute('aria-busy', 'false');
      await panel
        .locator('.el-select')
        .filter({
          has: page.getByRole('combobox', {
            name: locale === 'en-US' ? 'Time range' : '时间范围',
            exact: true
          })
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
      const inputs = panel.locator('.custom-range .el-range-input');
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
        if (!valid) await expect(panel.locator('.el-form-item__error')).toBeVisible();
        else {
          await expect(panel.locator('.el-form-item__error')).toHaveCount(0);
          await expect(panel).toHaveAttribute('aria-busy', 'false');
        }
      }
    });
  }
}
