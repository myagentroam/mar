import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let server: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  const replacement = resolve(
    import.meta.dirname,
    '../../packages/web-core/test/e2e/remote-desktop-controls-fakes.ts'
  );
  server = await startCustomThemeFixture('test/e2e/support/remote-desktop-controls.html', {
    aliases: [
      { find: '@novnc/novnc', replacement },
      { find: '../../service/standalone-remote-desktop-service.js', replacement }
    ]
  });
});
test.afterAll(async () => {
  await server?.close();
});

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 }
]) {
  test(`view-only control prompt is centered, bordered, and explicit at ${viewport.width}px`, async ({
    page
  }) => {
    await page.setViewportSize(viewport);
    await page.clock.install({ time: new Date('2026-11-12T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-11-12T00:00:01Z'));
    await page.addInitScript((mobile) => {
      localStorage.setItem('mar.locale.v2', mobile ? 'zh-CN' : 'en-US');
      localStorage.setItem('mar.theme', mobile ? 'vscode-dark-2026' : 'daylight');
    }, viewport.width === 390);
    await page.goto(`${server.url}remote-desktop-controls.html?path=relay`);
    await expect.poll(() => page.evaluate(() => window.desktopControls?.modes)).toEqual(['VIEW']);
    const prompt = page.getByTestId('desktop-control-prompt');
    await expect(prompt).toBeHidden();
    await page.evaluate(() => window.desktopControls.paint());
    await expect(prompt).toBeVisible();
    const stage = await page.locator('.remote-desktop-stage').boundingBox();
    const button = await prompt.boundingBox();
    expect(Math.abs(button!.x + button!.width / 2 - stage!.x - stage!.width / 2)).toBeLessThan(1);
    expect(Math.abs(button!.y + button!.height / 2 - stage!.y - stage!.height / 2)).toBeLessThan(1);
    expect(
      await prompt.evaluate((element) => parseFloat(getComputedStyle(element).borderTopWidth))
    ).toBeGreaterThan(0);
    expect(button!.x).toBeGreaterThanOrEqual(0);
    expect(button!.x + button!.width).toBeLessThanOrEqual(viewport.width);
    const statistics = page.getByTestId('desktop-statistics');
    await expect(statistics).not.toHaveAttribute('title');
    await expect(statistics).toContainText(/Server (中继|relay)/u);
    await expect(statistics).toContainText('FPS');
    await expect(statistics).toContainText('—');
    await page.clock.runFor(1000);
    await expect(statistics).toContainText('24 ms');
    if (viewport.width === 1280) {
      await statistics.hover();
      await page.clock.runFor(600);
      await expect(page.getByRole('tooltip')).toContainText('Live connection statistics');
      await page.mouse.move(0, 0);
      await page.clock.runFor(300);
      await expect(page.getByRole('tooltip')).toBeHidden();
    }
    await page.screenshot({ path: test.info().outputPath('view-only.png') });
    await prompt.focus();
    await page.keyboard.press('Enter');
    await expect
      .poll(() => page.evaluate(() => window.desktopControls.modes))
      .toEqual(['VIEW', 'CONTROL']);
    await expect(prompt).toBeHidden();
    await page.evaluate(() => window.desktopControls.paint());
    await expect(page.getByTestId('desktop-keyboard')).toBeVisible();
    await expect(prompt).toBeHidden();
  });
}

test('a viewing-only Node never offers a control prompt', async ({ page }) => {
  await page.goto(`${server.url}remote-desktop-controls.html?viewOnly`);
  await expect.poll(() => page.evaluate(() => window.desktopControls?.modes)).toEqual(['VIEW']);
  await page.evaluate(() => window.desktopControls.paint());
  await expect(page.getByTestId('desktop-control-prompt')).toBeHidden();
  await expect(page.getByTestId('desktop-control')).toBeDisabled();
  await expect(page.getByTestId('desktop-statistics')).toContainText(/直连|Direct/u);
});
