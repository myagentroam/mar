import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

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
    await expect(page.locator('.el-dropdown-menu:visible')).toBeVisible();
    const menu = page.locator('.el-popper:visible').filter({ has: page.getByRole('menu') });
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
