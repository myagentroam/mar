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
    const categories = page.locator('.conversation-sidebar').getByRole('radiogroup');
    const trackBorder = await categories.evaluate(
      (element) => getComputedStyle(element).borderTopColor
    );
    await expect(categories).toHaveCSS('border-top-width', '1px');
    await expect(aside.locator('.mar-tab-strip-item').first()).toHaveCSS(
      'border-top-color',
      trackBorder
    );
    const panel = await aside.evaluate((element) => getComputedStyle(element).backgroundColor);
    const inputWrappers = [
      resources.locator('.workspace-tree-filter .mar-ui-input'),
      page.locator('.session-search .mar-ui-input'),
      aside.locator('.file-display-filter.mar-ui-input')
    ];
    const readColor = (shadow: string) =>
      shadow.match(/(?:rgba?\(|color\(srgb )[^)]+\)/u)?.[0] ?? '';
    const contrast = (color: string, background = panel) => {
      const [a, b] = [luminance(color), luminance(background)];
      return (Math.max(a!, b!) + 0.05) / (Math.min(a!, b!) + 0.05);
    };
    for (const wrapper of inputWrappers) {
      await expect(wrapper).toBeVisible();
      const { border, background } = await wrapper.evaluate((element) => {
        const style = getComputedStyle(element);
        return { border: style.boxShadow, background: style.backgroundColor };
      });
      const borderColor = readColor(border);
      expect(trackBorder).toBe(borderColor);
      const normalContrast = contrast(borderColor, background);
      await wrapper.hover();
      const hoverContrast = async () => {
        const shadow = await wrapper.evaluate((element) => getComputedStyle(element).boxShadow);
        return contrast(readColor(shadow), background);
      };
      await expect.poll(hoverContrast).toBeGreaterThan(normalContrast);
      expect(await hoverContrast()).toBeLessThan(normalContrast + 0.35);
      await page.mouse.move(0, 0);
    }
    expect(trackBorder).not.toBe(primary);
    if (theme === 'daylight') {
      expect(primary).toBe(secondary);
    } else {
      await expect(page.locator('.conversation-panel')).toHaveCSS(
        'background-color',
        'rgb(22, 22, 22)'
      );
      await expect(page.locator('.composer-shell')).toHaveCSS(
        'background-color',
        'rgb(37, 37, 37)'
      );
      const newSession = page
        .locator('.conversation-sidebar')
        .getByRole('button', { name: '新建会话', exact: true });
      const { fill, border, primaryFill } = await newSession.evaluate((button) => {
        const probe = document.createElement('span');
        button.append(probe);
        const color = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const palette = {
          fill: color('--mar-session-create-fill'),
          border: color('--mar-input-border'),
          primaryFill: color('--mar-control-primary-bg')
        };
        probe.remove();
        return palette;
      });
      await expect(newSession).toHaveCSS('background-color', fill);
      await expect(newSession).toHaveCSS('border-top-color', border);
      await newSession.hover();
      const liveFill = async () =>
        luminance(
          await newSession.evaluate((element) => getComputedStyle(element).backgroundColor)
        );
      await expect.poll(liveFill).toBeGreaterThan(luminance(fill));
      expect(await liveFill()).toBeLessThan(luminance(primaryFill));
      await expect(newSession).toHaveCSS('border-top-color', border);
      await page.mouse.move(0, 0);
      expect(contrast(secondary)).toBeGreaterThanOrEqual(1.3);
      expect(contrast(primary)).toBeGreaterThanOrEqual(1.7);
    }
    const fileInput = inputWrappers[2]!;
    const textbox = fileInput.getByRole('textbox');
    await textbox.focus();
    await expect(textbox).toBeFocused();
    const focusColor = await fileInput.evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--mar-input-border-focus)';
      element.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await expect
      .poll(async () =>
        readColor(await fileInput.evaluate((element) => getComputedStyle(element).boxShadow))
      )
      .toBe(focusColor);
    expect(contrast(focusColor)).toBeGreaterThanOrEqual(3);
    await expect(textbox).toHaveCSS('outline-style', 'none');
    await textbox.blur();
    await page.screenshot({
      path: info.outputPath('workbench-boundaries.png'),
      animations: 'disabled'
    });
  });
}
