import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';
import { CUSTOM_THEME_TOKENS } from '../../packages/web-core/src/model/custom-theme.js';

async function useThemeMenu(page: Page, option: Locator, action: string): Promise<void> {
  await option.getByRole('button', { name: /^More actions for / }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
  await expect(page.getByRole('menuitem', { name: action, exact: true })).toBeHidden();
}

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});
test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => console.error(error.message));
  await page.goto(`${fixture.url}custom-theme.html`);
});

test('custom theme JSON flows through warnings, save, Appearance, reload, export, import and deletion', async ({
  page,
  context
}, testInfo) => {
  const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
  });
  await useThemeMenu(page, page.locator('.theme-option').first(), 'Duplicate');
  await editor.fill('{');
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  await expect(page.locator('.el-form-item__error')).toContainText('Invalid JSON');
  expect(await page.evaluate(() => localStorage.getItem('mar.customThemes'))).toBeNull();
  const source = JSON.stringify(
    {
      version: 1,
      name: 'Ocean',
      colors: {
        '--mar-bg-page': '#ffffff',
        '--mar-bg-panel': '#ddeeff',
        '--mar-text-primary': '#112233',
        '--el-color-primary': '#2155bb',
        '--mar-font-size-body': '100px',
        '--mar-fill-hover': 'url(https://invalid.test/image)'
      },
      extension: { retained: true }
    },
    null,
    2
  );
  await editor.fill(source);
  await expect(page.locator('.validation')).toContainText('saving is allowed');
  await expect(page.locator('.el-form-item__error')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('theme-desktop.png'), fullPage: true });
  await expect(page.locator('.theme-preview .preview-toolbar')).toHaveCSS(
    'background-color',
    'rgb(221, 238, 255)'
  );
  expect(
    await page.evaluate(() => document.documentElement.style.getPropertyValue('--mar-bg-panel'))
  ).toBe('');
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  await expect(page.locator('.theme-options')).toContainText('Ocean');
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('combobox', { name: 'Theme', exact: true }).focus();
  await page.getByRole('combobox', { name: 'Theme', exact: true }).press('ArrowDown');
  await page.getByRole('option', { name: 'Ocean', exact: true }).click();
  await expect(page.locator('.settings-content')).toHaveCSS(
    'background-color',
    'rgb(221, 238, 255)'
  );
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
    false
  );
  await page.reload();
  await expect(page.locator('.settings-content')).toHaveCSS(
    'background-color',
    'rgb(221, 238, 255)'
  );
  await page.getByRole('button', { name: 'Inspect Ocean', exact: true }).click();
  await expect(editor).toHaveValue(source);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('Ocean.json');
  expect(await readFile((await download.path())!, 'utf8')).toBe(source);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy JSON', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(source);
  await page.locator('input[type=file]').setInputFiles({
    name: 'Ocean.json',
    mimeType: 'application/json',
    buffer: Buffer.from(source)
  });
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  await expect(page.locator('.theme-option')).toHaveCount(4);
  await useThemeMenu(
    page,
    page.locator('.theme-option').filter({ hasText: 'Ocean' }).first(),
    'Delete'
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.theme-option')).toHaveCount(3);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'vscode-dark-2026');
  expect(
    await page.evaluate(() => document.documentElement.style.getPropertyValue('--mar-bg-panel'))
  ).toBe('');
  expect(apiRequests).toEqual([]);
});

test('duplicate, draft protection and formatting work without changing the active palette', async ({
  page
}) => {
  const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
  await useThemeMenu(page, page.locator('.theme-option').first(), 'Duplicate');
  await editor.fill(JSON.stringify({ name: 'Original', version: 1, colors: {} }));
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  await useThemeMenu(
    page,
    page.locator('.theme-option').filter({ hasText: 'Original' }),
    'Duplicate'
  );
  expect(JSON.parse(await editor.inputValue()).name).toBe('Original (copy)');
  await page
    .getByRole('button', { name: /^Inspect /u })
    .first()
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(JSON.parse(await editor.inputValue()).name).toBe('Original (copy)');
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  await expect(page.locator('.theme-option')).toHaveCount(4);
  await editor.fill('null');
  await page.getByRole('button', { name: 'Format JSON', exact: true }).click();
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  await expect(page.locator('.theme-options')).toContainText('Untitled theme');
  await expect(page.locator('.validation')).toContainText('saving is allowed');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'vscode-dark-2026');
});

test('built-ins are read-only, copies include every color, and reset restores saved or copied drafts', async ({
  page
}) => {
  const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
  const rows = page.locator('.theme-option');
  await expect(rows).toHaveCount(2);
  await expect(
    rows.first().getByRole('button', { name: 'Inspect Dark', exact: true })
  ).toBeVisible();
  await expect(
    rows.nth(1).getByRole('button', { name: 'Inspect Light', exact: true })
  ).toBeVisible();
  await expect(editor).toHaveAttribute('readonly', '');
  await expect(page.locator('.validation')).toContainText('No detected warnings.');
  const validation = await page.locator('.validation').boundingBox();
  const reference = await page.locator('.token-reference').boundingBox();
  const preview = await page.locator('.preview-heading').boundingBox();
  expect(validation!.y + validation!.height).toBeLessThanOrEqual(reference!.y);
  expect(reference!.y + reference!.height).toBeLessThanOrEqual(preview!.y);
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /New (dark|light) theme/ })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Base theme', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save theme', exact: true })).toHaveCount(0);
  await rows
    .nth(1)
    .getByRole('button', { name: /^Inspect /u })
    .click();
  await expect(page.locator('.validation')).toContainText('No detected warnings.');
  const light = JSON.parse(await editor.inputValue());
  expect(light).not.toHaveProperty('base');
  for (const token of CUSTOM_THEME_TOKENS)
    expect(light.colors[token]).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/u);
  expect(light.colors['--mar-bg-panel']).toBe('#ffffff');
  await useThemeMenu(page, rows.nth(1), 'Duplicate');
  const copied = await editor.inputValue();
  expect(JSON.parse(copied).colors).toEqual(light.colors);
  await expect(page.locator('.validation')).toContainText('No detected warnings.');
  await expect(editor).not.toHaveAttribute('readonly', '');
  for (const name of ['Save theme', 'Format JSON', 'Reset']) {
    await expect(page.getByRole('button', { name, exact: true }).locator('svg')).toBeVisible();
  }
  const actions = await page.locator('.editor-layout form .actions').boundingBox();
  const jsonEditor = await editor.boundingBox();
  expect(actions!.y + actions!.height).toBeLessThanOrEqual(jsonEditor!.y);
  const previewPanel = await page.locator('.editor-layout .theme-preview').boundingBox();
  expect(
    Math.abs(jsonEditor!.y + jsonEditor!.height - previewPanel!.y - previewPanel!.height)
  ).toBeLessThanOrEqual(1);
  await expect(
    page.locator('.editor-layout form').getByRole('button', { name: 'Reset', exact: true })
  ).toBeDisabled();
  await editor.fill('null');
  await page
    .locator('.editor-layout form')
    .getByRole('button', { name: 'Reset', exact: true })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor).toHaveValue('null');
  await page
    .locator('.editor-layout form')
    .getByRole('button', { name: 'Reset', exact: true })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(editor).toHaveValue(copied);
  expect(await page.evaluate(() => localStorage.getItem('mar.customThemes'))).toBeNull();
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  await editor.fill('{}');
  await page
    .locator('.editor-layout form')
    .getByRole('button', { name: 'Reset', exact: true })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(editor).toHaveValue(copied);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mar.customThemes')!));
  expect(stored).toHaveLength(1);
  expect(stored[0].source).toBe(copied);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const select = page.getByRole('combobox', { name: 'Theme', exact: true });
  await select.focus();
  await select.press('ArrowDown');
  await page.getByRole('option', { name: 'Light (copy)', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
    false
  );
  for (const token of [
    '--mar-bg-page',
    '--mar-bg-panel',
    '--mar-color-brand-selected',
    '--el-fill-color'
  ]) {
    expect(
      await page.evaluate((key) => document.documentElement.style.getPropertyValue(key), token)
    ).toBe(light.colors[token]);
  }
});

test('theme choices apply immediately without replacing an unsaved draft', async ({
  page
}, testInfo) => {
  const options = page.locator('.theme-option');
  const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(options.first().getByRole('button', { name: 'Active', exact: true })).toBeDisabled();
  await options
    .nth(1)
    .getByRole('button', { name: /^Inspect /u })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'vscode-dark-2026');
  await options.nth(1).getByRole('button', { name: 'Apply theme', exact: true }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/u);
  expect(await page.evaluate(() => localStorage.getItem('mar.theme'))).toBe('daylight');
  await useThemeMenu(page, options.first(), 'Duplicate');
  const saved = JSON.stringify({
    version: 1,
    name: 'Violet',
    colors: { '--el-color-primary': '#c792ea' }
  });
  await editor.fill(saved);
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  const violet = options.filter({ hasText: 'Violet' });
  await violet.getByRole('button', { name: 'Apply theme', exact: true }).click();
  await expect(violet.getByRole('button', { name: 'Active', exact: true })).toBeDisabled();
  await page.reload();
  await expect(violet.getByRole('button', { name: 'Active', exact: true })).toBeDisabled();
  expect(
    await page.evaluate(() => document.documentElement.style.getPropertyValue('--el-color-primary'))
  ).toBe('#c792ea');
  await violet.getByRole('button', { name: /^Inspect /u }).click();
  await editor.fill(saved + ' ');
  await options.first().getByRole('button', { name: 'Apply theme', exact: true }).click();
  await expect(editor).toHaveValue(saved + ' ');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('mar.theme'))).toBe('vscode-dark-2026');
  await page.screenshot({
    path: testInfo.outputPath('theme-selector.png'),
    fullPage: true,
    animations: 'disabled'
  });
});

test('filled primary controls use the same foreground as the theme preview', async ({ page }) => {
  const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
  const options = page.locator('.theme-option');
  await useThemeMenu(page, options.first(), 'Duplicate');
  const save = page.getByRole('button', { name: 'Save theme', exact: true });
  const sample = page.locator('.theme-preview .preview-button.primary');
  await expect(sample).toHaveCSS('color', 'rgb(14, 17, 22)');
  await expect(save).toHaveCSS('color', 'rgb(14, 17, 22)');
  const custom = JSON.stringify({
    version: 1,
    name: 'Palenight sample',
    colors: {
      '--el-color-primary': '#c792ea',
      '--mar-color-on-accent': '#202331'
    }
  });
  await editor.fill(custom);
  await save.click();
  await options
    .filter({ hasText: 'Palenight sample' })
    .getByRole('button', { name: 'Apply theme', exact: true })
    .click();
  await expect(sample).toHaveCSS('color', 'rgb(32, 35, 49)');
  await expect(save).toHaveCSS('color', 'rgb(32, 35, 49)');
  await save.hover();
  await expect(save).toHaveCSS('color', 'rgb(32, 35, 49)');
  await page.mouse.down();
  await expect(save).toHaveCSS('color', 'rgb(32, 35, 49)');
  await page.mouse.up();
});

test('expanded and compact previews share the applied palette without changing global state', async ({
  page
}, testInfo) => {
  const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
  await useThemeMenu(page, page.locator('.theme-option').first(), 'Duplicate');
  const source = JSON.stringify({
    version: 1,
    name: 'Preview',
    colors: { '--el-color-primary': '#ff00ff', '--mar-color-diff-add-text': '#123456' }
  });
  await editor.fill(source);
  const preview = page.locator('.theme-preview');
  await expect(preview.locator('.user-message')).toHaveText('This is a sample message.');
  await expect(preview.locator('.assistant-message strong')).toHaveText('Sample heading');
  await expect(preview.locator('.preview-toolbar')).toHaveCSS(
    'background-color',
    'rgb(19, 25, 34)'
  );
  await expect(preview.locator('.diff-add')).toHaveCSS('color', 'rgb(18, 52, 86)');
  await expect(preview.getByRole('button', { name: 'Disabled', exact: true })).toBeDisabled();
  const compactFont = await preview.evaluate((element) =>
    parseFloat(getComputedStyle(element).fontSize)
  );
  await preview.locator('input').focus();
  await expect(preview.locator('input')).toHaveCSS('outline-color', 'rgb(255, 0, 255)');
  await page.getByRole('button', { name: 'Enlarge preview', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const expanded = dialog.locator('.theme-preview');
  await expect(expanded).toBeVisible();
  expect(
    await expanded.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
  ).toBeGreaterThan(compactFont);
  await expect(expanded.locator('.diff-add')).toHaveCSS('color', 'rgb(18, 52, 86)');
  await expanded.getByRole('textbox', { name: 'Message', exact: true }).fill('Preview only');
  await expect(editor).toHaveValue(source);
  expect(await page.evaluate(() => localStorage.getItem('mar.customThemes'))).toBeNull();
  expect(
    await page.evaluate(() => document.documentElement.style.getPropertyValue('--el-color-primary'))
  ).toBe('');
  await page.screenshot({
    path: testInfo.outputPath('theme-expanded.png'),
    fullPage: true,
    animations: 'disabled'
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

for (const locale of ['en-US', 'zh-CN']) {
  test(`theme editor remains usable on narrow screens in ${locale}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${fixture.url}custom-theme.html?locale=${locale}`);
    await expect(page.locator('.json-editor textarea')).toBeVisible();
    const bounds = await page.locator('.editor-layout').boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390
    );
    const form = await page.locator('.editor-layout form').boundingBox();
    const aside = await page.locator('.editor-layout aside').boundingBox();
    expect(aside!.y).toBeGreaterThan(form!.y);
    await expect(page.locator('.theme-settings h2')).toHaveText(
      locale === 'zh-CN' ? '主题' : 'Themes'
    );
    await expect(
      page.getByRole('button', {
        name: locale === 'zh-CN' ? '查看 暗色' : 'Inspect Dark',
        exact: true
      })
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`theme-${locale}.png`), fullPage: true });
    await page.locator('.editor-layout aside').scrollIntoViewIfNeeded();
    await expect(page.locator('.theme-preview')).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath(`theme-${locale}-preview.png`),
      fullPage: true
    });
    await page
      .getByRole('button', {
        name: locale === 'zh-CN' ? '放大预览' : 'Enlarge preview',
        exact: true
      })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const dialogBounds = await dialog.locator('.el-dialog').boundingBox();
    expect(dialogBounds!.x).toBeGreaterThanOrEqual(16);
    expect(dialogBounds!.x + dialogBounds!.width).toBeLessThanOrEqual(374);
  });
}
