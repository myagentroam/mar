import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.use({ hasTouch: true });
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const scheme of ['Light', 'Dark']) {
  for (const width of [1280, 390]) {
    test(`Segmented filters retain neutral selection and focus in ${scheme} at ${width}px`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture.url}custom-theme.html`);
      if (scheme === 'Light')
        await page
          .locator('.theme-option')
          .filter({ has: page.getByRole('button', { name: 'Inspect Light', exact: true }) })
          .getByRole('button', { name: 'Apply theme', exact: true })
          .click();
      const scope = page.getByRole('radiogroup', { name: 'Configuration scope', exact: true });
      const disabledScope = page.getByRole('radiogroup', {
        name: 'Disabled configuration scope',
        exact: true
      });
      const node = scope.getByRole('radio', { name: 'Node', exact: true });
      const workspace = scope.getByRole('radio', { name: 'Workspace', exact: true });
      const unavailable = scope.getByRole('radio', { name: 'Unavailable', exact: true });
      const nodeLabel = scope.locator('label').filter({
        has: page.getByRole('radio', { name: 'Node', exact: true })
      });
      const workspaceLabel = scope.locator('label').filter({
        has: page.getByRole('radio', { name: 'Workspace', exact: true })
      });
      const disabledLabel = scope.locator('label').filter({
        has: page.getByRole('radio', { name: 'Unavailable', exact: true })
      });
      const selection = scope.locator('.el-segmented__item-selected');
      for (const custom of [false, true]) {
        if (custom)
          await page.locator('html').evaluate((element) => {
            for (const [token, value] of Object.entries({
              '--mar-color-brand': '#bf6ac9',
              '--mar-text-primary': '#dae5cf',
              '--mar-text-secondary': '#b6c3af',
              '--mar-text-faint': '#8293a4',
              '--mar-bg-subtle': '#26303d',
              '--mar-fill-muted': '#2b3540',
              '--mar-fill-row-hover': '#334455',
              '--mar-fill-selection': '#445566',
              '--mar-border-default': '#556476'
            }))
              element.style.setProperty(token, value);
          });
        const palette = await scope.evaluate((element) => {
          const probe = document.createElement('span');
          element.append(probe);
          const color = (token: string) => {
            probe.style.color = `var(${token})`;
            return getComputedStyle(probe).color;
          };
          probe.style.color =
            getComputedStyle(element).colorScheme === 'dark'
              ? 'color-mix(in oklab, var(--mar-fill-selection) 73%, var(--mar-text-primary))'
              : 'color-mix(in srgb, var(--mar-fill-selection) 97%, var(--mar-text-primary))';
          const selected = getComputedStyle(probe).color;
          const colors = {
            normal: color('--mar-text-secondary'),
            active: color('--mar-text-primary'),
            background: color('--mar-fill-muted'),
            selected,
            hover: color('--mar-fill-row-hover'),
            disabled: color('--mar-text-faint'),
            disabledSelection: color('--mar-bg-subtle'),
            border: color('--mar-border-default'),
            focus: color('--mar-color-brand')
          };
          probe.remove();
          return colors;
        });
        await page.mouse.move(0, 0);
        await expect(node).toBeChecked();
        await expect(scope).toHaveCSS('background-color', palette.background);
        const surface = await scope.evaluate((element) => ({
          surrounding: getComputedStyle(element.parentElement!).backgroundColor,
          shadow: getComputedStyle(element).boxShadow
        }));
        expect(palette.background).not.toBe(surface.surrounding);
        expect(surface.shadow).toContain(palette.border);
        expect(surface.shadow).toContain('inset');
        await expect(nodeLabel).toHaveCSS('color', palette.active);
        await expect(workspaceLabel).toHaveCSS('color', palette.normal);
        await expect(selection).toHaveCSS('background-color', palette.selected);
        await expect(selection).toHaveCSS('box-shadow', 'none');
        await workspaceLabel.hover();
        await expect(workspaceLabel).toHaveCSS('background-color', palette.hover);
        await expect(workspaceLabel).toHaveCSS('color', palette.active);
        await nodeLabel.hover();
        await expect(selection).toHaveCSS('background-color', palette.selected);
        await expect(unavailable).toBeDisabled();
        await disabledLabel.hover();
        await expect(disabledLabel).toHaveCSS('color', palette.disabled);
        await expect(disabledLabel).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await disabledLabel.click({ force: true });
        await expect(node).toBeChecked();
        await expect(
          disabledScope.getByRole('radio', { name: 'Node', exact: true })
        ).toBeDisabled();
        await expect(disabledScope.locator('label.is-selected')).toHaveCSS(
          'color',
          palette.disabled
        );
        await expect(disabledScope.locator('.el-segmented__item-selected')).toHaveCSS(
          'background-color',
          palette.disabledSelection
        );
        await node.focus();
        await page.keyboard.press('ArrowRight');
        await expect(workspace).toBeFocused();
        await expect(workspace).toBeChecked();
        await expect(selection).toHaveClass(/is-focus-visible/);
        const focus = await selection.evaluate((element) => {
          const style = getComputedStyle(element, '::before');
          return { color: style.outlineColor, width: style.outlineWidth };
        });
        expect(focus).toEqual({ color: palette.focus, width: '2px' });
        await page.keyboard.press('ArrowRight');
        await expect(node).toBeChecked();
        await nodeLabel.tap();
        await workspaceLabel.tap();
        await expect(workspace).toBeChecked();
        if (!custom)
          await scope.screenshot({
            animations: 'disabled',
            path: testInfo.outputPath(`segmented-${scheme}-${width}-workspace.png`)
          });
        await nodeLabel.tap();
        await expect(node).toBeChecked();
        await expect
          .poll(async () => {
            const selected = (await selection.boundingBox())!;
            const label = (await nodeLabel.boundingBox())!;
            return Math.abs(selected.x - label.x);
          })
          .toBeLessThan(1);
        if (!custom)
          await scope.screenshot({ path: testInfo.outputPath(`segmented-${scheme}-${width}.png`) });
      }
    });
  }
}
