import { expect, test, type Locator } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

async function unreadBorder(tab: Locator) {
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
    const border = luminance(labelStyle.borderTopColor);
    const surface = luminance(background);
    return {
      contrast: (Math.max(border, surface) + 0.05) / (Math.min(border, surface) + 0.05),
      color: labelStyle.borderTopColor,
      width: labelStyle.borderTopWidth,
      background: labelStyle.backgroundColor
    };
  });
}

for (const width of [1280, 390]) {
  test.describe(`Unread border at ${width}px`, () => {
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
        const normal = await unreadBorder(second);
        const selected = await unreadBorder(first);
        expect(normal.contrast).toBeGreaterThanOrEqual(3);
        expect(selected.contrast).toBeGreaterThanOrEqual(3);
        expect(selected.color).toBe(normal.color);
        expect(selected.width).toBe('1px');
        expect(selected.background).toBe('rgba(0, 0, 0, 0)');
        if (width === 1280) {
          await second.hover();
          expect((await unreadBorder(second)).contrast).toBeGreaterThanOrEqual(3);
        }
        await second.getByRole('tab').click();
        await expect(second).toHaveClass(/active/);
        expect((await unreadBorder(second)).contrast).toBeGreaterThanOrEqual(3);
        await tabs.screenshot({ path: testInfo.outputPath('unread-selected.png') });

        await page.evaluate(() => {
          const style = document.documentElement.style;
          style.setProperty('--mar-text-secondary', '#c5bfac');
          style.setProperty('--mar-border-medium', '#403d38');
          style.setProperty('--mar-fill-selection', '#35322c');
        });
        const custom = await unreadBorder(second);
        expect(custom.color).not.toBe(selected.color);
        expect(custom.contrast).toBeGreaterThanOrEqual(3);
        expect(custom.width).toBe('1px');
        await tabs.screenshot({ path: testInfo.outputPath('unread-custom-selected.png') });
      });
    }
  });
}
