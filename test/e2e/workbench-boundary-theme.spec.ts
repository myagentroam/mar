import { expect, test } from '@playwright/test';
import { resolvedColorToHex } from '../../packages/web-core/src/util/theme-palette.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';
import { json, mockConsoleApi } from './support/web-console-api.js';

// @test-covers packages/web-core/src/styles/theme.css
// @test-covers packages/web-core/src/styles/mar-ui-theme.css
// @test-covers packages/web-core/src/view/workbench/WorkbenchAside.vue
// @test-covers packages/mar-ui/components/segmented/MarSegmented.vue

function luminance(color: string): number {
  const hex = resolvedColorToHex(color);
  const linear = (offset: number) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(1) + 0.7152 * linear(3) + 0.0722 * linear(5);
}

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/new-session-group.html');
});
test.afterAll(async () => await fixture?.close());

for (const theme of ['vscode-dark-2026', 'daylight'] as const) {
  test(`Workbench divider and input boundaries stay distinct in ${theme}`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.addInitScript((value) => localStorage.setItem('mar.theme', value), theme);
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], [], 'DIRECTORY', true);
    await page.route('**/api/auth/me', (route) =>
      json(route, { authenticated: true, userId: 1, username: 'admin', isAdmin: true })
    );
    await page.route('**/api/nodes/node-1/workbench-capabilities', (route) =>
      json(route, {
        manifest: {
          manifestVersion: 1,
          observedAt: 1,
          conversation: { available: true, reasonCode: null },
          files: { available: true, reasonCode: null },
          sessionGroups: { apiVersion: 1 }
        }
      })
    );
    await page.goto(`${fixture.url}new-session-group.html`);
    const resources = page.locator('.workspace-tree');
    await resources.getByRole('button', { name: /node-1/ }).click();
    await resources.getByRole('button', { name: 'project' }).click();

    const aside = page.locator('.workspace-aside .workbench-aside');
    await expect(aside).toBeVisible();
    const primary = await aside.evaluate((element) => getComputedStyle(element).borderLeftColor);
    await expect(aside).toHaveCSS('border-left-width', '1px');
    for (const [divider, edge] of [
      [page.locator('.mar-workbench-sidebar'), 'right'],
      [page.locator('.conversation-sidebar'), 'right'],
      [aside.locator('.workbench-aside-header'), 'bottom']
    ] as const) {
      await expect(divider).toHaveCSS(`border-${edge}-color`, primary);
      await expect(divider).toHaveCSS(`border-${edge}-width`, '1px');
    }

    const secondary = await aside
      .locator('.file-explorer > .explorer-toolbar')
      .evaluate((element) => getComputedStyle(element).borderBottomColor);
    const track = await page
      .locator('.conversation-sidebar')
      .getByRole('radiogroup')
      .evaluate((element) => getComputedStyle(element).borderTopColor);
    const panel = await aside.evaluate((element) => getComputedStyle(element).backgroundColor);
    const inputWrappers = [
      resources.locator('.workspace-tree-filter .mar-ui-input'),
      page.locator('.session-search .mar-ui-input'),
      aside.locator('.file-display-filter.mar-ui-input')
    ];
    const readColor = (shadow: string) =>
      shadow.match(/(?:rgba?\(|color\(srgb )[^)]+\)/u)?.[0] ?? '';
    const contrast = (color: string, background = panel) =>
      (luminance(color) + 0.05) / (luminance(background) + 0.05);
    for (const wrapper of inputWrappers) {
      await expect(wrapper).toBeVisible();
      const { border, background } = await wrapper.evaluate((element) => {
        const style = getComputedStyle(element);
        return { border: style.boxShadow, background: style.backgroundColor };
      });
      if (theme === 'daylight') {
        expect(readColor(border)).toBe('rgb(203, 214, 228)');
      } else {
        const normalContrast = contrast(readColor(border), background);
        expect(normalContrast).toBeGreaterThanOrEqual(3);
        await wrapper.hover();
        await expect
          .poll(async () => {
            const shadow = await wrapper.evaluate((element) => getComputedStyle(element).boxShadow);
            const hover = readColor(shadow);
            return hover ? contrast(hover, background) : 0;
          })
          .toBeGreaterThan(normalContrast);
        await page.mouse.move(0, 0);
      }
    }
    if (theme === 'daylight') {
      expect(primary).toBe(secondary);
    } else {
      await expect(page.locator('.conversation-panel')).toHaveCSS(
        'background-color',
        'rgb(19, 19, 19)'
      );
      await expect(page.locator('.composer-shell')).toHaveCSS(
        'background-color',
        'rgb(31, 31, 31)'
      );
      const newSession = page
        .locator('.conversation-sidebar')
        .getByRole('button', { name: '新建会话', exact: true });
      await expect(newSession).toHaveCSS('background-color', 'rgb(34, 34, 34)');
      await newSession.hover();
      await expect(newSession).toHaveCSS('background-color', 'rgb(40, 40, 40)');
      await page.mouse.move(0, 0);
      expect(contrast(secondary)).toBeGreaterThanOrEqual(1.3);
      expect(contrast(track)).toBeGreaterThan(contrast(secondary));
      expect(contrast(primary)).toBeGreaterThanOrEqual(1.7);
      expect(contrast(primary)).toBeGreaterThan(contrast(track));
    }
    const fileInput = inputWrappers[2]!;
    await fileInput.getByRole('textbox').focus();
    await expect(fileInput.getByRole('textbox')).toBeFocused();
    const focusColor = theme === 'daylight' ? 'rgb(9, 105, 232)' : 'rgb(40, 114, 200)';
    await expect
      .poll(async () =>
        readColor(await fileInput.evaluate((element) => getComputedStyle(element).boxShadow))
      )
      .toBe(focusColor);
    await fileInput.getByRole('textbox').blur();
    await page.screenshot({
      path: info.outputPath('workbench-boundaries.png'),
      animations: 'disabled'
    });
  });
}
