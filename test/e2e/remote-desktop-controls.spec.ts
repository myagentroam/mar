import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let server: Awaited<ReturnType<typeof startCustomThemeFixture>>;
let realServer: Awaited<ReturnType<typeof startCustomThemeFixture>>;
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
  realServer = await startCustomThemeFixture('test/e2e/support/remote-desktop-controls.html', {
    aliases: [{ find: '../../service/standalone-remote-desktop-service.js', replacement }]
  });
});
test.afterAll(async () => {
  await server?.close();
  await realServer?.close();
});

test('switches a selected capture back to VIEW through the display selector', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mar.locale.v2', 'en-US'));
  await page.goto(`${server.url}remote-desktop-controls.html?displaySelection`);
  await expect.poll(() => page.evaluate(() => window.desktopControls?.modes)).toEqual(['CONTROL']);
  await page.evaluate(() => window.desktopControls.paint());
  await expect(page.getByTestId('desktop-control')).toBeEnabled();
  await page.getByTestId('desktop-control').click();
  await expect.poll(() => page.evaluate(() => window.desktopControls.modes)).toEqual(['CONTROL']);
  await page.evaluate(() => window.desktopControls.paint());
  await page.getByTestId('desktop-screen').click();
  await expect(page.getByRole('option')).toHaveCount(2);
  await page.getByRole('option', { name: 'Display2', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.desktopControls.displays))
    .toEqual(['screen', 'secondary']);
  await expect
    .poll(() => page.evaluate(() => window.desktopControls.modes))
    .toEqual(['CONTROL', 'CONTROL']);
  await page.evaluate(() => window.desktopControls.paint());
  await expect(page.getByTestId('desktop-control-prompt')).toBeVisible();
  await expect(page.getByTestId('desktop-view')).toHaveCount(0);
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
    await expect
      .poll(() => page.evaluate(() => window.desktopControls?.modes))
      .toEqual(['CONTROL']);
    const prompt = page.getByTestId('desktop-control-prompt');
    await expect(prompt).toBeHidden();
    await expect(
      page.locator('.remote-desktop-overlay [data-mar-icon="loading-action"]')
    ).toBeVisible();
    await page.evaluate(() => window.desktopControls.paint());
    await expect(prompt).toBeVisible();
    await expect(page.locator('.remote-desktop-title')).not.toContainText('node-a-internal-id');
    await expect(page.getByTestId('desktop-node-name')).toHaveText('Fixture Node');
    const buttonStyle = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      return [style.height, style.fontSize, style.color, style.backgroundColor, style.borderColor];
    };
    await expect(async () => {
      expect(await prompt.evaluate(buttonStyle)).toEqual(
        await page.getByTestId('desktop-control').evaluate(buttonStyle)
      );
    }).toPass({ timeout: 5000 });
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
    await expect(statistics).toContainText(' -');
    await expect(statistics).not.toContainText('—');
    const screen = page.getByTestId('desktop-screen');
    await screen.click();
    await expect(page.getByRole('option')).toHaveCount(1);
    await expect(page.getByRole('option')).toHaveText(
      viewport.width === 390 ? 'Display1（主屏）' : 'Display1 (primary)'
    );
    await screen.click();
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
    await expect.poll(() => page.evaluate(() => window.desktopControls.modes)).toEqual(['CONTROL']);
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

test('real noVNC leaves the local mouse free in VIEW and accepts input only after Control desktop', async ({
  page
}) => {
  await page.goto(`${realServer.url}remote-desktop-controls.html?realRfb`);
  await page.waitForFunction(() => window.desktopControls?.rfbReady);
  await page.evaluate(() => window.desktopControls.paint());
  const prompt = page.getByTestId('desktop-control-prompt');
  await expect(prompt).toBeVisible();
  const canvas = page.locator('.remote-desktop-target canvas');
  const original = (await canvas.elementHandle())!;
  const box = (await canvas.boundingBox())!;
  const point = { x: box.x + 10, y: box.y + 10 };
  const hit = () =>
    page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y)!;
      return { tag: element.tagName, cursor: getComputedStyle(element).cursor };
    }, point);
  expect((await hit()).tag).not.toBe('CANVAS');
  expect((await hit()).cursor).not.toBe('none');
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => page.evaluate(() => window.desktopControls.pointerMasks)).toEqual([]);
  await prompt.hover();
  await expect.poll(() => prompt.evaluate((element) => element.matches(':hover'))).toBe(true);
  await prompt.click();
  await expect.poll(() => page.evaluate(() => window.desktopControls.modes)).toEqual(['CONTROL']);
  await expect.poll(() => page.evaluate(() => window.desktopControls.rfbReady)).toBe(true);
  await expect(prompt).toBeHidden();
  await expect.poll(async () => (await hit()).tag).toBe('CANVAS');
  await page.mouse.click(point.x, point.y);
  await expect
    .poll(() => page.evaluate(() => window.desktopControls.pointerMasks.slice(-2)))
    .toEqual([1, 0]);
  await page.keyboard.down('a');
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => window.desktopControls.pointerMasks.at(-1))).toBe(1);
  // Click without releasing the held pointer/key first, exercising the actual viewOnly setter.
  await page.getByTestId('desktop-view').evaluate((button: HTMLButtonElement) => button.click());
  await expect(prompt).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.desktopControls.keyEvents))
    .toEqual([
      [1, 97],
      [0, 97]
    ]);
  await expect
    .poll(() => page.evaluate(() => window.desktopControls.pointerMasks.slice(-2)))
    .toEqual([1, 0]);
  await page.keyboard.up('a');
  await page.mouse.up();
  await prompt.click();
  await expect(prompt).toBeHidden();
  await expect(page.locator('.remote-desktop-overlay')).toHaveCount(0);
  expect(await original.evaluate((element) => element.isConnected)).toBe(true);
  expect(await page.evaluate(() => window.desktopControls.modes)).toEqual(['CONTROL']);
  await page.mouse.click(point.x, point.y);
  await expect
    .poll(() => page.evaluate(() => window.desktopControls.pointerMasks.slice(-2)))
    .toEqual([1, 0]);
});
