import { resolvedColorToHex } from '../../packages/web-core/src/util/theme-palette.js';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';
import { CUSTOM_THEME_TOKENS } from '../../packages/web-core/src/model/custom-theme.js';

async function componentAliases(): Promise<Record<string, string>> {
  const css = await readFile(
    new URL('../../packages/web-core/src/styles.css', import.meta.url),
    'utf8'
  );
  const bridge = css.slice(0, css.indexOf('}'));
  const registered = new Set<string>(CUSTOM_THEME_TOKENS);
  const aliases = Object.fromEntries(
    [...bridge.matchAll(/(--el-[\w-]+):\s*var\((--mar-[\w-]+)\);/gu)]
      .filter((match) => registered.has(match[2]!))
      .map((match) => [match[1]!, match[2]!])
  );
  expect(aliases).toMatchObject({
    '--el-color-primary': '--mar-color-brand',
    '--el-text-color-primary': '--mar-text-primary',
    '--el-bg-color': '--mar-bg-panel'
  });
  return aliases;
}

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
        '--mar-color-brand': '#2155bb',
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
  const preview = await page.locator('.preview-heading').boundingBox();
  expect(validation!.y + validation!.height).toBeLessThanOrEqual(preview!.y);
  await expect(
    page.getByRole('button', { name: 'Theme color reference', exact: true })
  ).toBeVisible();
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
  const lowContrast = JSON.parse(copied);
  lowContrast.colors['--mar-color-on-accent'] = lowContrast.colors['--mar-color-brand'];
  await editor.fill(JSON.stringify(lowContrast));
  await expect(page.locator('.validation')).toContainText(
    '--mar-color-on-accent / --mar-color-brand'
  );
  await editor.fill(copied);
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
    '--mar-control-fill-color'
  ]) {
    expect(
      await page.evaluate((key) => document.documentElement.style.getPropertyValue(key), token)
    ).toBe(light.colors[token]);
  }
});

for (const scheme of ['Light', 'Dark']) {
  test(
    'theme helper and action controls share standard hover states in ' + scheme,
    async ({ page }, testInfo) => {
      const options = page.locator('.theme-option');
      if (scheme === 'Light')
        await options.nth(1).getByRole('button', { name: 'Apply theme', exact: true }).click();
      const palette = await page.locator('html').evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          utility: style.getPropertyValue('--mar-color-brand-text').trim(),
          link: style.getPropertyValue('--mar-control-link-hover').trim()
        };
      });
      const help = page.getByRole('button', { name: 'Theme color reference', exact: true });
      const more = options.first().getByRole('button', { name: /^More actions for / });
      for (const control of [help, more]) {
        await expect(control).toHaveAttribute(
          'title',
          (await control.getAttribute('aria-label')) ?? ''
        );
        await control.hover();
        await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(control).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
        await expect
          .poll(async () =>
            resolvedColorToHex(await control.evaluate((element) => getComputedStyle(element).color))
          )
          .toBe(palette.utility);
      }
      const apply = options
        .nth(scheme === 'Light' ? 0 : 1)
        .getByRole('button', { name: 'Apply theme', exact: true });
      await apply.hover();
      await expect(apply).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect
        .poll(async () =>
          resolvedColorToHex(await apply.evaluate((element) => getComputedStyle(element).color))
        )
        .toBe(palette.link);
      await help.focus();
      await help.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Theme color reference', exact: true });
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await more.focus();
      await more.press('Enter');
      await expect(page.getByRole('menuitem', { name: 'Duplicate', exact: true })).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath('theme-actions-' + scheme + '.png'),
        animations: 'disabled'
      });
      await page.keyboard.press('Escape');
    }
  );
}

test('theme choices apply immediately without replacing an unsaved draft', async ({
  page
}, testInfo) => {
  const options = page.locator('.theme-option');
  const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
  await expect(page.locator('.theme-settings').getByRole('table')).toHaveCount(0);
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
    colors: { '--mar-color-brand': '#c792ea' }
  });
  await editor.fill(saved);
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  const violet = options.filter({ hasText: 'Violet' });
  await violet.getByRole('button', { name: 'Apply theme', exact: true }).click();
  await expect(violet.getByRole('button', { name: 'Active', exact: true })).toBeDisabled();
  await page.reload();
  await expect(violet.getByRole('button', { name: 'Active', exact: true })).toBeDisabled();
  expect(
    await page.evaluate(() => document.documentElement.style.getPropertyValue('--mar-color-brand'))
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
  await expect(sample).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(save).toHaveCSS('color', 'rgb(255, 255, 255)');
  const custom = JSON.stringify({
    version: 1,
    name: 'Palenight sample',
    colors: {
      '--mar-color-brand': '#c792ea',
      '--mar-color-on-accent': '#202331',
      '--mar-control-color-primary-light-3': '#112233',
      '--mar-control-color-primary-dark-2': '#223344',
      '--mar-color-brand-hover': '#abcdef'
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
  await sample.hover();
  await expect(sample).toHaveCSS('background-color', 'rgb(171, 205, 239)');
  await expect(sample).toHaveCSS('border-color', 'rgb(171, 205, 239)');
  await page.mouse.down();
  await expect(sample).toHaveCSS('background-color', 'rgb(34, 51, 68)');
  await expect(sample).toHaveCSS('border-color', 'rgb(34, 51, 68)');
  await page.mouse.up();
  await save.hover();
  await expect(save).toHaveCSS('color', 'rgb(32, 35, 49)');
  await expect(save).toHaveCSS('background-color', 'rgb(171, 205, 239)');
  await expect(save).toHaveCSS('border-color', 'rgb(171, 205, 239)');
  await page.mouse.down();
  await expect(save).toHaveCSS('color', 'rgb(32, 35, 49)');
  await expect(save).toHaveCSS('background-color', 'rgb(34, 51, 68)');
  await expect(save).toHaveCSS('border-color', 'rgb(34, 51, 68)');
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
    colors: {
      '--mar-color-brand': '#ff00ff',
      '--mar-fill-selection': '#38475a',
      '--mar-fill-row-hover': '#283442',
      '--mar-color-diff-add-text': '#123456',
      '--mar-conversation-surface': '#16324f',
      '--mar-conversation-text': '#f8eedd'
    }
  });
  await editor.fill(source);
  const preview = page.locator('.theme-preview');
  for (const selector of ['.file.selected', '.tab.active']) {
    await expect(preview.locator(selector)).toHaveCSS('background-color', 'rgb(56, 71, 90)');
    await preview.locator(selector).hover();
    await expect(preview.locator(selector)).toHaveCSS('background-color', 'rgb(56, 71, 90)');
  }
  await expect(preview.locator('.user-message')).toHaveText('This is a sample message.');
  await expect(preview.locator('.assistant-message strong')).toHaveText('Sample heading');
  await expect(preview.locator('.user-message')).toHaveCSS('color', 'rgb(248, 238, 221)');
  await expect(preview.locator('.assistant-message')).toHaveCSS(
    'background-color',
    'rgb(22, 50, 79)'
  );
  for (const selector of ['.user-message', '.assistant-message', '.process'])
    await expect(preview.locator(selector)).toHaveCSS('border-radius', '12px');
  await expect(preview.locator('.status').first()).toHaveCSS('border-radius', '4px');
  await expect(preview.locator('.preview-button.primary')).toHaveCSS('border-radius', '6px');
  await expect(preview.locator('.preview-toolbar')).toHaveCSS(
    'background-color',
    'rgb(22, 29, 40)'
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
  await expect(expanded.locator('.file.selected')).toHaveCSS('background-color', 'rgb(56, 71, 90)');
  await expect(expanded.locator('.tab.active')).toHaveCSS('background-color', 'rgb(56, 71, 90)');
  const dialogPanel = dialog.locator('.el-dialog');
  await expect(dialogPanel).toHaveCSS('border-radius', '12px');
  await dialogPanel.evaluate((element) => element.classList.add('is-fullscreen'));
  await expect(dialogPanel).toHaveCSS('border-radius', '0px');
  await dialogPanel.evaluate((element) => element.classList.remove('is-fullscreen'));
  expect(
    await expanded.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
  ).toBeGreaterThan(compactFont);
  await expect(expanded.locator('.diff-add')).toHaveCSS('color', 'rgb(18, 52, 86)');
  await expanded.getByRole('textbox', { name: 'Message', exact: true }).fill('Preview only');
  await expect(editor).toHaveValue(source);
  expect(await page.evaluate(() => localStorage.getItem('mar.customThemes'))).toBeNull();
  expect(
    await page.evaluate(() => document.documentElement.style.getPropertyValue('--mar-color-brand'))
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

for (const scheme of ['Light', 'Dark']) {
  test('MAR variables drive every component alias in ' + scheme + ' palettes', async ({ page }) => {
    const aliases = await componentAliases();
    const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
    const row = page
      .locator('.theme-option')
      .filter({ has: page.getByRole('button', { name: 'Inspect ' + scheme, exact: true }) });
    await useThemeMenu(page, row, 'Duplicate');
    const source = JSON.parse(await editor.inputValue());
    expect(Object.keys(source.colors).every((key) => key.startsWith('--mar-'))).toBe(true);
    for (const [index, token] of [...new Set(Object.values(aliases))].entries())
      source.colors[token] = '#' + (0x203040 + index * 0x030507).toString(16).padStart(6, '0');
    source.colors['--mar-color-brand'] = '#654321';
    source.colors['--mar-control-bg-color-overlay'] = '#345678';
    source.colors['--mar-bg-panel'] = '#123456';
    source.colors['--mar-bg-page'] = scheme === 'Light' ? '#ffffff' : '#000000';
    await editor.fill(JSON.stringify(source));
    const inspectAliases = (element: Element, aliases: Record<string, string>) => {
      const style = getComputedStyle(element);
      return Object.entries(aliases).map(([alias, target]) => ({
        alias,
        target,
        actual: style.getPropertyValue(alias).trim(),
        expected: style.getPropertyValue(target).trim()
      }));
    };
    for (const result of await page.locator('.theme-preview').evaluate(inspectAliases, aliases)) {
      expect(result.actual, result.alias).toBe(result.expected);
      expect(result.actual, result.alias).toBe(source.colors[result.target]);
      expect(result.actual).not.toBe('');
    }
    await page.getByRole('button', { name: 'Save theme', exact: true }).click();
    await page
      .locator('.theme-option')
      .filter({ has: page.getByRole('button', { name: 'Inspect ' + source.name, exact: true }) })
      .getByRole('button', { name: 'Apply theme', exact: true })
      .click();
    for (const result of await page.locator('html').evaluate(inspectAliases, aliases)) {
      expect(result.actual, result.alias).toBe(result.expected);
      expect(result.actual, result.alias).toBe(source.colors[result.target]);
    }
    await expect(page.locator('.actions .el-button--primary')).toHaveCSS(
      'background-color',
      'rgb(101, 67, 33)'
    );
    await page.getByRole('button', { name: 'Theme color reference', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: 'Theme color reference', exact: true }).locator('.el-dialog')
    ).toHaveCSS('background-color', 'rgb(18, 52, 86)');
    await page.keyboard.press('Escape');
    await page
      .locator('.theme-option')
      .first()
      .getByRole('button', { name: /^More actions for / })
      .click();
    await expect(page.getByRole('menu')).toHaveCSS('background-color', 'rgb(52, 86, 120)');
  });
}

for (const locale of ['en-US', 'zh-CN']) {
  test(
    'theme color help supports search, copying and narrow layouts in ' + locale,
    async ({ page, context }, testInfo) => {
      await page.goto(fixture.url + 'custom-theme.html?locale=' + locale);
      const title = locale === 'en-US' ? 'Theme color reference' : '主题颜色说明';
      const searchLabel = locale === 'en-US' ? 'Search names or descriptions' : '搜索变量名或用途';
      const trigger = page.getByRole('button', { name: title, exact: true });
      await trigger.focus();
      await trigger.press('Enter');
      const dialog = page.getByRole('dialog', { name: title, exact: true });
      await expect(dialog.locator('.token-row')).toHaveCount(CUSTOM_THEME_TOKENS.length);
      for (const description of await dialog.locator('dd').allTextContents())
        expect(description.trim()).not.toBe('');
      await dialog
        .getByRole('textbox', { name: searchLabel })
        .fill(locale === 'en-US' ? 'Page canvas' : '页面底层背景');
      await expect(dialog.locator('.token-row')).toHaveCount(1);
      await expect(dialog.locator('code')).toHaveText('--mar-bg-page');
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await dialog
        .getByRole('button', {
          name: locale === 'en-US' ? 'Copy --mar-bg-page' : '复制 --mar-bg-page',
          exact: true
        })
        .click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe('--mar-bg-page');
      await page.evaluate(() => {
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true,
          value: async () => {
            throw new Error('Clipboard unavailable');
          }
        });
      });
      await dialog
        .getByRole('button', {
          name: locale === 'en-US' ? 'Copy --mar-bg-page' : '复制 --mar-bg-page',
          exact: true
        })
        .click();
      await expect(page.locator('.el-message--error')).toContainText(
        locale === 'en-US'
          ? 'Could not copy the variable name. Select and copy it manually.'
          : '无法复制变量名，请选中变量名手动复制。'
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await dialog.getByRole('textbox', { name: searchLabel }).fill('');
      const bounds = await dialog.locator('.el-dialog').boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(15);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true
      );
      await page.screenshot({ path: testInfo.outputPath('theme-help-' + locale + '.png') });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await trigger.click();
      await expect(dialog.getByRole('textbox', { name: searchLabel })).toHaveValue('');
    }
  );
}

for (const scheme of ['Light', 'Dark']) {
  test(
    'real controls preserve the built-in ' + scheme + ' palette and respond to custom states',
    async ({ page }) => {
      const controls = page.getByRole('region', { name: 'Real theme controls' });
      const row = page.locator('.theme-option').filter({
        has: page.getByRole('button', { name: 'Inspect ' + scheme, exact: true })
      });
      if (scheme === 'Light')
        await row.getByRole('button', { name: 'Apply theme', exact: true }).click();
      else await expect(row.getByRole('button', { name: 'Active', exact: true })).toBeDisabled();
      const panel = scheme === 'Dark' ? 'rgb(22, 29, 40)' : 'rgb(255, 255, 255)';
      await expect(controls.locator('.el-input__wrapper')).toHaveCSS('background-color', panel);
      await expect(controls.locator('.el-select__wrapper')).toHaveCSS('background-color', panel);
      await expect(controls.locator('.el-table')).toHaveCSS('background-color', panel);
      await expect(controls.getByRole('button', { name: 'Sample default', exact: true })).toHaveCSS(
        'background-color',
        panel
      );
      await expect(controls.getByRole('button', { name: 'Sample primary', exact: true })).toHaveCSS(
        'color',
        'rgb(255, 255, 255)'
      );
      await expect(controls.getByRole('button', { name: 'Sample primary', exact: true })).toHaveCSS(
        'background-color',
        scheme === 'Dark' ? 'rgb(31, 115, 207)' : 'rgb(36, 95, 168)'
      );
      expect(
        resolvedColorToHex(
          await controls
            .getByRole('button', { name: 'Sample disabled primary', exact: true })
            .evaluate((element) => getComputedStyle(element).color)
        )
      ).toBe(scheme === 'Dark' ? '#ffffff80' : '#ffffff');
      await expect(controls.locator('.el-table th')).toHaveCSS(
        'background-color',
        scheme === 'Dark' ? 'rgb(19, 25, 34)' : 'rgb(236, 240, 244)'
      );
      await controls.locator('.el-table__body tr').first().hover();
      await expect(controls.locator('.el-table__body td').first()).toHaveCSS(
        'background-color',
        scheme === 'Dark' ? 'rgb(32, 43, 58)' : 'rgb(228, 234, 241)'
      );
      await controls.getByRole('button', { name: 'Sample link', exact: true }).hover();
      await expect(controls.getByRole('button', { name: 'Sample link', exact: true })).toHaveCSS(
        'color',
        scheme === 'Dark' ? 'rgb(48, 147, 255)' : 'rgb(24, 71, 128)'
      );

      await useThemeMenu(page, row, 'Duplicate');
      const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
      const theme = JSON.parse(await editor.inputValue());
      Object.assign(theme.colors, {
        '--mar-bg-panel': '#123456',
        '--mar-table-header-bg': '#234567',
        '--mar-table-row-hover-bg': '#345678',
        '--mar-color-on-accent': '#fedcba',
        '--mar-control-link-text': '#abcdef',
        '--mar-control-link-hover': '#bcdefa',
        '--mar-color-brand-disabled': '#cdefab'
      });
      await editor.fill(JSON.stringify(theme));
      await page.getByRole('button', { name: 'Save theme', exact: true }).click();
      await page
        .locator('.theme-option')
        .filter({ has: page.getByRole('button', { name: 'Inspect ' + theme.name, exact: true }) })
        .getByRole('button', { name: 'Apply theme', exact: true })
        .click();
      await expect(controls.locator('.el-input__wrapper')).toHaveCSS(
        'background-color',
        'rgb(18, 52, 86)'
      );
      await expect(controls.locator('.el-select__wrapper')).toHaveCSS(
        'background-color',
        'rgb(18, 52, 86)'
      );
      await expect(controls.locator('.el-table')).toHaveCSS('background-color', 'rgb(18, 52, 86)');
      await expect(controls.locator('.el-table th')).toHaveCSS(
        'background-color',
        'rgb(35, 69, 103)'
      );
      await expect(controls.getByRole('button', { name: 'Sample primary', exact: true })).toHaveCSS(
        'color',
        'rgb(254, 220, 186)'
      );
      const disabledPrimary = controls.getByRole('button', {
        name: 'Sample disabled primary',
        exact: true
      });
      const disabledColor = async () =>
        resolvedColorToHex(
          await disabledPrimary.evaluate((element) => getComputedStyle(element).color)
        );
      await expect.poll(disabledColor).toBe(scheme === 'Dark' ? '#fedcba80' : '#fedcba');
      await disabledPrimary.hover();
      await expect.poll(disabledColor).toBe(scheme === 'Dark' ? '#fedcba80' : '#fedcba');
      await expect(controls.getByRole('button', { name: 'Sample link', exact: true })).toHaveCSS(
        'color',
        'rgb(171, 205, 239)'
      );
      await expect(
        controls.getByRole('button', { name: 'Sample disabled link', exact: true })
      ).toHaveCSS('color', 'rgb(205, 239, 171)');
      await controls.getByRole('button', { name: 'Sample link', exact: true }).hover();
      await expect(controls.getByRole('button', { name: 'Sample link', exact: true })).toHaveCSS(
        'color',
        'rgb(188, 222, 250)'
      );
      await controls.locator('.el-table__body tr').first().hover();
      await expect(controls.locator('.el-table__body td').first()).toHaveCSS(
        'background-color',
        'rgb(52, 86, 120)'
      );
    }
  );
}

for (const scheme of ['Light', 'Dark']) {
  test(
    'responsive layout tokens remain independent of the ' + scheme + ' color mapping',
    async ({ page }) => {
      if (scheme === 'Light')
        await page
          .locator('.theme-option')
          .filter({
            has: page.getByRole('button', { name: 'Inspect Light', exact: true })
          })
          .getByRole('button', { name: 'Apply theme', exact: true })
          .click();
      const aliases = await componentAliases();
      // Include both breakpoint edges and resize back to mobile to catch stale overrides.
      for (const width of [390, 767, 768, 860, 861, 1440, 420]) {
        await page.setViewportSize({ width, height: 900 });
        const mobile = width < 768;
        const expected = {
          '--sidebar-header-height': mobile ? '46px' : '68px',
          '--mar-brand-logo-size': mobile ? '32px' : '35px',
          '--mar-font-size-body': mobile ? '13px' : '14px',
          '--el-component-size-small': mobile ? '24px' : '26px',
          '--mar-utility-control-size': mobile ? '28px' : '31px',
          '--mar-session-row-min-height': mobile ? '40px' : '34px',
          '--mar-workbench-sidebar-width': mobile ? '222px' : width <= 860 ? '220px' : '244px'
        };
        const actual = await page.locator('html').evaluate((element, names) => {
          const style = getComputedStyle(element);
          return Object.fromEntries(
            names.map((name) => [name, style.getPropertyValue(name).trim()])
          );
        }, Object.keys(expected));
        expect(actual, scheme + ' at ' + width).toEqual(expected);
        const resolvedAliases = await page.locator('html').evaluate((element, mapping) => {
          const style = getComputedStyle(element);
          return Object.entries(mapping).map(([alias, token]) => ({
            alias,
            actual: style.getPropertyValue(alias).trim(),
            expected: style.getPropertyValue(token).trim()
          }));
        }, aliases);
        for (const alias of resolvedAliases)
          expect(alias.actual, alias.alias + ' at ' + width).toBe(alias.expected);
      }
    }
  );
}
