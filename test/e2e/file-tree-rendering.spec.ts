import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

test('File tree renders bundled MAR file and folder icons by default in both color themes', async ({
  page
}, testInfo) => {
  const fixture = await startCustomThemeFixture();
  try {
    await page.goto(`${fixture.url}file-tree.html`);
    for (const [theme, expectedFolderColor] of [
      ['vscode-dark-2026', 'rgb(117, 195, 255)'],
      ['daylight', 'rgb(0, 118, 229)']
    ] as const) {
      await page.evaluate((value) => localStorage.setItem('mar.theme', value), theme);
      await page.reload();
      const tree = page.getByRole('tree');
      const folder = tree.locator('[data-file-path="."] .mar-file-icon');
      const file = tree.locator('[data-file-path="notes.txt"] .mar-file-icon');
      await expect(folder).toHaveCSS('color', expectedFolderColor);
      await expect(folder.locator('use')).toHaveAttribute('href', /#mar-file-dir$/u);
      await expect(file.locator('use')).toHaveAttribute('href', /#mar-file-txt$/u);
      await expect
        .poll(() => file.locator('use').evaluate((node: SVGUseElement) => node.getBBox().width))
        .toBeGreaterThan(0);
      for (const [path, id] of [
        ['.agents', 'dir'],
        ['dist', 'dir'],
        ['src', 'src'],
        ['test', 'tests'],
        ['button.spec.ts', 'test']
      ]) {
        const symbol = tree.locator(`[data-file-path="${path}"] .mar-file-icon use`);
        await expect(symbol).toHaveAttribute('href', new RegExp(`#mar-file-${id}$`));
        await expect
          .poll(() => symbol.evaluate((node: SVGUseElement) => node.getBBox().width))
          .toBeGreaterThan(0);
      }
      await page.getByRole('button', { name: 'Rename', exact: true }).click();
      const symbol = file.locator('use');
      await expect(symbol).toHaveAttribute('href', /#mar-file-ts$/u);
      await expect
        .poll(() => symbol.evaluate((node: SVGUseElement) => node.getBBox().width))
        .toBeGreaterThan(0);
      expect(await page.evaluate(() => localStorage.getItem('mar.icon-theme.v2'))).toBeNull();
      await tree.screenshot({ path: testInfo.outputPath(`mar-file-tree-${theme}.png`) });
    }
  } finally {
    await fixture.close();
  }
});

test('File tree updates rendered rows, permissions and locale while keeping its virtual layout bounded', async ({
  page
}) => {
  const fixture = await startCustomThemeFixture();
  try {
    await page.goto(`${fixture.url}file-tree.html`);
    const tree = page.getByRole('tree');
    const row = page.locator('[data-file-path="notes.txt"]');
    await expect(row).toBeVisible();
    expect(await tree.getByRole('treeitem').count()).toBeLessThan(42);
    expect(
      await tree.evaluate((element) => element.scrollWidth - element.clientWidth)
    ).toBeLessThanOrEqual(1);
    const rootName = await page.locator('[data-file-path="."] .tree-name').boundingBox();
    const childName = await row.locator('.tree-name').boundingBox();
    expect(childName!.x - rootName!.x).toBeCloseTo(8, 0);
    await expect(row).toHaveAttribute('draggable', 'true');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(row).toContainText('Renamed.ts');
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await row.hover();
    const actions = row.locator('..').locator('.file-tree-more');
    await expect(actions).toBeVisible();
    const englishLabel = await actions.getAttribute('aria-label');
    await row.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: englishLabel! });
    await expect(menu).toBeVisible();
    const rowBox = await row.locator('..').boundingBox();
    await expect
      .poll(async () => {
        const menuBox = await menu.boundingBox();
        return menuBox!.y - rowBox!.y - rowBox!.height;
      })
      .toBeGreaterThanOrEqual(8);
    await page.screenshot({
      path: test.info().outputPath('file-tree-menu-below-row.png'),
      animations: 'disabled'
    });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Change locale' }).click();
    await row.hover();
    await expect(actions).not.toHaveAttribute('aria-label', englishLabel!);
    await expect(actions).toHaveAttribute('aria-label', /Renamed.ts/);
    await page.getByRole('button', { name: 'Toggle loading' }).click();
    await tree.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(tree.locator('.file-tree-load-more [role="status"]')).toBeVisible();
    await page.getByRole('button', { name: 'Toggle loading' }).click();
    await expect(tree.locator('.file-tree-load-more [role="status"]')).toHaveCount(0);
    await tree.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.getByRole('button', { name: 'Toggle mutations' }).click();
    await expect(row).toHaveAttribute('draggable', 'false');
    await page.getByRole('button', { name: 'Toggle mutations' }).click();
    await page.getByRole('button', { name: 'Toggle mobile' }).click();
    await expect(row).toHaveAttribute('draggable', 'false');
    await page.getByRole('button', { name: 'Toggle disabled' }).click();
    await expect(row).toBeDisabled();
    await page.getByRole('button', { name: 'Toggle directory' }).click();
    await expect(row).toHaveCount(0);
    await expect(page.locator('[data-file-path="."]')).toHaveAttribute('aria-expanded', 'false');
  } finally {
    await fixture.close();
  }
});
