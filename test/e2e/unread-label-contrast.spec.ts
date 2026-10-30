import { expect, test, type Locator } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

async function unreadContrast(tab: Locator) {
  return tab.evaluate((element) => {
    const label = element.querySelector('.mar-unread-label')!;
    const labelStyle = getComputedStyle(label);
    const tabStyle = getComputedStyle(element);
    const context = document.createElement('canvas').getContext('2d')!;
    function luminance(color: string): number {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const pixels = context.getImageData(0, 0, 1, 1).data;
      const linear = Array.from(pixels.slice(0, 3), (channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
    }
    // Selected tabs use an opaque, uniform gradient over their base surface.
    const background = element.classList.contains('active')
      ? tabStyle.getPropertyValue('--mar-fill-selection')
      : tabStyle.backgroundColor;
    const foreground = luminance(labelStyle.color);
    const fill = luminance(labelStyle.backgroundColor);
    const border = luminance(labelStyle.borderTopColor);
    const surface = luminance(background);
    const ratio = (first: number, second: number) =>
      (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    return {
      textContrast: ratio(foreground, fill),
      boundaryContrast: ratio(border, surface),
      color: labelStyle.color,
      borderWidth: labelStyle.borderTopWidth,
      height: label.getBoundingClientRect().height,
      fontSize: parseFloat(labelStyle.fontSize),
      background: labelStyle.backgroundColor
    };
  });
}

for (const width of [1280, 390]) {
  test.describe(`Unread label at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width === 390 });
    for (const theme of ['daylight', 'vscode-dark-2026']) {
      test(`stays visible on normal and selected surfaces in ${theme}`, async ({
        page
      }, testInfo) => {
        await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&unread=1`);
        const tabs = page.locator('section[aria-label="Workspace tab fixture"]');
        const first = tabs
          .locator('.workspace-tab')
          .filter({ has: page.getByRole('tab', { name: 'Workspace 0', exact: true }) });
        const second = tabs
          .locator('.workspace-tab')
          .filter({ has: page.getByRole('tab', { name: 'Workspace 1', exact: true }) });
        await expect(first).toHaveClass(/active/);
        await expect(second).not.toHaveClass(/active/);
        const normal = await unreadContrast(second);
        const selected = await unreadContrast(first);
        for (const label of [normal, selected]) {
          expect(label.textContrast).toBeGreaterThanOrEqual(4.5);
          expect(label.boundaryContrast).toBeGreaterThan(1.25);
          expect(label.borderWidth).toBe('1px');
          expect(label.height).toBeLessThanOrEqual(label.fontSize * 1.2 + 2.1);
          expect(label.background).not.toBe('rgba(0, 0, 0, 0)');
        }
        expect(selected.color).toBe(normal.color);
        expect(selected.background).toBe(normal.background);
        if (width === 1280) {
          await second.hover();
          const hovered = await unreadContrast(second);
          expect(hovered.textContrast).toBeGreaterThanOrEqual(4.5);
          expect(hovered.boundaryContrast).toBeGreaterThan(1.25);
        }
        await second.getByRole('tab').click();
        await expect(second).toHaveClass(/active/);
        const switched = await unreadContrast(second);
        expect(switched.textContrast).toBeGreaterThanOrEqual(4.5);
        expect(switched.boundaryContrast).toBeGreaterThan(1.25);
        await tabs.screenshot({
          path: testInfo.outputPath(`unread-selected-${width}-${theme}.png`)
        });

        await page.evaluate(() => {
          const style = document.documentElement.style;
          style.setProperty('--mar-text-secondary', '#c5bfac');
          style.setProperty('--mar-fill-selection', '#35322c');
        });
        const custom = await unreadContrast(second);
        expect(custom.background).not.toBe(selected.background);
        expect(custom.color).toBe(selected.color);
        expect(custom.textContrast).toBeGreaterThanOrEqual(4.5);
        expect(custom.boundaryContrast).toBeGreaterThan(1.25);
        expect(custom.borderWidth).toBe('1px');
        await tabs.screenshot({ path: testInfo.outputPath('unread-custom-selected.png') });
      });
    }
  });
}
