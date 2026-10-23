import { expect, test, type Locator } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

async function expectReadIndicator(indicator: Locator, size: number) {
  await expect(indicator).toBeVisible();
  const actual = await indicator.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--mar-color-brand-text)';
    element.parentElement!.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(element);
    return {
      color: style.color,
      expected,
      size:
        parseFloat(style.width) / parseFloat(getComputedStyle(document.documentElement).fontSize)
    };
  });
  expect(actual.color).toBe(actual.expected);
  expect(actual.size).toBeCloseTo(size);
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Read loading shares theme colors and distinguishes resource rows: ${theme}`, async ({
    page
  }, testInfo) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture.url}visual-alignment.html?loading-feedback=1&theme=${theme}`);
      const preview = page.getByTestId('file-content').getByRole('status');
      const pagePreview = page.getByTestId('file-page-content').getByRole('status');
      const previews = [preview, pagePreview];
      const history = page.getByTestId('history-older');
      const indicators = [
        page.getByTestId('history-initial').locator('.busy-indicator'),
        history.locator('.busy-indicator'),
        page.getByTestId('management-append').locator('.busy-indicator')
      ];
      for (const loading of previews) {
        await expect(loading).toHaveText('');
        await expect(loading).toHaveAttribute('aria-busy', 'true');
        await expect(loading).toHaveAttribute('aria-label', /.+/);
        await expectReadIndicator(loading.locator('.busy-indicator'), 1.25);
      }
      const surface = (await pagePreview.locator('..').boundingBox())!;
      const spinner = (await pagePreview.locator('.busy-indicator').boundingBox())!;
      expect(Math.abs(spinner.x + spinner.width / 2 - surface.x - surface.width / 2)).toBeLessThan(
        1
      );
      expect(
        Math.abs(spinner.y + spinner.height / 2 - surface.y - surface.height / 2)
      ).toBeLessThan(1);
      for (const indicator of indicators) await expectReadIndicator(indicator, 0.875);
      const runtime = page.getByTestId('runtime-indicator');
      const runtimeColor = await runtime.evaluate((element) => getComputedStyle(element).color);
      expect(
        await runtime.evaluate(
          (element) =>
            parseFloat(getComputedStyle(element).width) /
            parseFloat(getComputedStyle(document.documentElement).fontSize)
        )
      ).toBeCloseTo(0.75);
      const tree = page.getByTestId('file-tree');
      const row = tree.locator('.file-tree-row-shell').filter({ hasText: 'src' });
      const rowHeight = (await row.boundingBox())!.height;
      const star = tree.getByRole('status').locator('[data-mar-icon="loading-action"]');
      await expect(star).toBeVisible();
      await expect(star).not.toHaveCSS('animation-name', 'none');
      await expect(tree.locator('.busy-indicator')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`read-loading-${width}.png`) });
      await page
        .locator('html')
        .evaluate((element) => element.style.setProperty('--mar-color-brand-text', '#c084fc'));
      for (const loading of previews)
        await expectReadIndicator(loading.locator('.busy-indicator'), 1.25);
      for (const indicator of indicators) await expectReadIndicator(indicator, 0.875);
      await expect(runtime).toHaveCSS('color', runtimeColor);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(star).toHaveCSS('animation-name', 'none');
      for (const loading of previews)
        await expect(loading.locator('.busy-indicator')).toHaveCSS('animation-name', 'none');
      await page.getByRole('button', { name: 'Finish directory load' }).click();
      await expect(star).toHaveCount(0);
      expect((await row.boundingBox())!.height).toBe(rowHeight);
      await page.getByRole('button', { name: 'Finish history load' }).click();
      const load = history.locator('button[data-history-action="load"]');
      await load.click();
      await expect(load).toHaveAttribute('aria-busy', 'true');
      await expect(load.locator('[data-mar-icon="loading-action"]')).toBeVisible();
      await expect(history.locator('.busy-indicator')).toHaveCount(0);
      await expect(history.getByText('Existing message remains readable')).toBeVisible();
      await page.getByRole('button', { name: 'Finish history load' }).click();
      await expect(load).toHaveAttribute('aria-busy', 'false');
      await page.getByRole('button', { name: 'Finish file load' }).click();
      await expect(page.getByText('Preview ready')).toBeVisible();
      for (const loading of previews) await expect(loading).toHaveCount(0);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
  });
}
