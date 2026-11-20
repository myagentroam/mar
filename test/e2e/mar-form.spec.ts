import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/mar-form.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

test('MAR form keeps native labels, validation triggers and disabled inheritance', async ({
  page
}, testInfo) => {
  await page.goto(`${fixture.url}mar-form.html?theme=dark`);
  const name = page.getByRole('textbox', { name: 'Display name' });
  const mode = page.getByRole('combobox', { name: 'Execution mode' });
  const visible = page.getByRole('switch', { name: 'Show in directory' });
  const confirmed = page.getByRole('switch', { name: 'Confirm changes' });
  const save = page.getByRole('button', { name: 'Save settings' });
  const nameError = page.getByRole('alert').filter({ hasText: 'Enter a display name' });
  const modeError = page.getByRole('alert').filter({ hasText: 'Select a mode' });

  await page.locator('label').filter({ hasText: 'Display name' }).click();
  await expect(name).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(nameError).toBeVisible();
  await expect(modeError).toHaveCount(0);
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toHaveAccessibleDescription(
    'Shown to workspace members. Enter a display name'
  );
  await name.fill('Example');
  await expect(nameError).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(nameError).toHaveCount(0);

  await save.click();
  await expect(modeError).toBeVisible();
  await expect(mode).toHaveAccessibleDescription('Select a mode');
  await page.locator('main').screenshot({ path: testInfo.outputPath('form-dark-invalid.png') });
  await mode.press('ArrowDown');
  await mode.press('Enter');
  await expect(modeError).toHaveCount(0);
  await name.press('Enter');
  await expect(page.locator('output')).toHaveText('1');

  await page.getByText('Show in directory', { exact: true }).click();
  await expect(visible).not.toBeChecked();
  await page.getByRole('button', { name: 'Toggle disabled' }).click();
  await expect(name).toBeDisabled();
  await expect(mode).toBeDisabled();
  await expect(visible).toBeDisabled();
  await expect(save).toBeDisabled();
  await expect(confirmed).toBeEnabled();
  await page.getByRole('button', { name: 'Toggle disabled' }).click();
  await name.fill('');
  await save.click();
  await expect(nameError).toBeVisible();
  await page.getByRole('button', { name: 'Clear name error' }).click();
  await expect(name).toHaveAccessibleDescription('Shown to workspace members.');
});

test('MAR form errors fit a light Chinese mobile viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto(`${fixture.url}mar-form.html?theme=light&locale=zh-CN`);
  await expect(page.getByRole('combobox', { name: '运行方式' })).toHaveAttribute(
    'placeholder',
    '请选择'
  );
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('alert')).toHaveCount(2);
  const name = page.getByRole('textbox', { name: '显示名称' });
  const mode = page.getByRole('combobox', { name: '运行方式' });
  await expect(name).toHaveAccessibleDescription('向工作区成员显示。 请输入显示名称');
  const nameError = await page.getByText('请输入显示名称').boundingBox();
  const nameBox = await name.boundingBox();
  const modeBox = await mode.boundingBox();
  expect(nameError!.y).toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height);
  expect(modeBox!.y).toBeGreaterThanOrEqual(nameError!.y + nameError!.height);
  expect(await page.locator('main').evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator('main').screenshot({ path: testInfo.outputPath('form-light-390-zh-CN.png') });
});
