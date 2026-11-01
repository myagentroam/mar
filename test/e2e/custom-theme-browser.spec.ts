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
  const bridgeStart = css.indexOf(':root,\nhtml.console-ui,\n.theme-preview {');
  expect(bridgeStart).toBeGreaterThanOrEqual(0);
  const bridge = css.slice(bridgeStart, css.indexOf('}', bridgeStart));
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

async function expectMessageThemeTokens(message: Locator, iconToken: string): Promise<void> {
  const actual = await message.evaluate((element, statusToken) => {
    const root = getComputedStyle(document.documentElement);
    const surface = getComputedStyle(element);
    const content = element.querySelector('.mar-message-text');
    const icon = element.querySelector('.el-message__icon');
    if (!content || !icon) throw new Error('Message content or icon is missing');
    const colorForToken = (token: string): string => {
      const probe = document.createElement('span');
      probe.style.cssText = 'position: fixed; visibility: hidden;';
      probe.style.color = `var(${token})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    return {
      background: surface.backgroundColor,
      backgroundToken: colorForToken('--mar-control-bg-color-overlay'),
      border: surface.borderTopColor,
      borderToken: colorForToken('--mar-border-default'),
      radius: surface.borderRadius,
      radiusToken: root.getPropertyValue('--mar-radius-control').trim(),
      text: getComputedStyle(content).color,
      textToken: colorForToken('--mar-text-primary'),
      fontSize: getComputedStyle(content).fontSize,
      bodyToken: root.getPropertyValue('--mar-font-size-body').trim(),
      iconColor: getComputedStyle(icon).color,
      statusColor: colorForToken(statusToken)
    };
  }, iconToken);

  expect(resolvedColorToHex(actual.background)).toBe(resolvedColorToHex(actual.backgroundToken));
  expect(resolvedColorToHex(actual.border)).toBe(resolvedColorToHex(actual.borderToken));
  expect(actual.radius).toBe(actual.radiusToken);
  expect(resolvedColorToHex(actual.text)).toBe(resolvedColorToHex(actual.textToken));
  expect(actual.fontSize).toBe(actual.bodyToken);
  expect(resolvedColorToHex(actual.iconColor)).toBe(resolvedColorToHex(actual.statusColor));
}

async function expectMessageFirstLineAlignment(message: Locator): Promise<void> {
  const offsets = await message.evaluate((element) => {
    const content = element.querySelector('.mar-message-text');
    const statusIcon = element.querySelector('.el-message__icon .mar-icon');
    const closeIcon = element.querySelector('.mar-message-close .mar-icon');
    if (!content || !statusIcon || !closeIcon)
      throw new Error('Message feedback layout is missing');
    const contentRect = content.getBoundingClientRect();
    const lineHeight = Number.parseFloat(getComputedStyle(content).lineHeight);
    const firstLineCenter = contentRect.y + lineHeight / 2;
    const centerY = (rect: DOMRect) => rect.y + rect.height / 2;
    return {
      status: centerY(statusIcon.getBoundingClientRect()) - firstLineCenter,
      close: centerY(closeIcon.getBoundingClientRect()) - firstLineCenter
    };
  });
  expect(Math.abs(offsets.status)).toBeLessThanOrEqual(1);
  expect(Math.abs(offsets.close)).toBeLessThanOrEqual(1);
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

test('lazy loading directive displays and removes its styled mask', async ({ page }) => {
  const sample = page.getByRole('region', { name: 'Loading directive sample' });
  const panel = sample.locator('.page-loading-panel');
  const mask = panel.locator('.el-loading-mask');
  await expect(panel).toHaveAttribute('aria-busy', 'true');
  await expect(mask).toBeVisible();
  await expect(mask).toHaveCSS('position', 'absolute');
  await sample.getByRole('button', { name: 'Toggle sample loading' }).click();
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  await expect(mask).toBeHidden();
});

for (const scheme of ['Light', 'Dark']) {
  test(`lazy dropdown retains ${scheme} and custom hover tokens and commands`, async ({ page }) => {
    if (scheme === 'Light')
      await page
        .locator('.theme-option')
        .filter({
          has: page.getByRole('button', { name: 'Inspect Light', exact: true })
        })
        .getByRole('button', { name: 'Apply theme', exact: true })
        .click();
    const trigger = page.getByRole('button', { name: 'Sample menu', exact: true });
    for (const custom of [false, true]) {
      if (custom)
        await page.locator('html').evaluate((root) => {
          root.style.setProperty('--mar-fill-row-hover', '#345678');
          root.style.setProperty('--mar-text-primary', '#e5d6c7');
        });
      await trigger.click();
      const item = page.getByRole('menuitem', { name: 'Rename', exact: true });
      await item.hover();
      const colors = await item.evaluate((element) => {
        const probe = document.createElement('span');
        element.append(probe);
        const token = (name: string) => {
          probe.style.color = `var(${name})`;
          return getComputedStyle(probe).color;
        };
        const result = {
          background: getComputedStyle(element).backgroundColor,
          color: getComputedStyle(element).color,
          hover: token('--mar-fill-row-hover'),
          text: token('--mar-text-primary')
        };
        probe.remove();
        return result;
      });
      expect(colors.background).toBe(colors.hover);
      expect(colors.color).toBe(colors.text);
      await item.click();
      await expect(page.getByLabel('Selected menu action')).toHaveText('rename');
    }
  });
}

for (const scheme of ['Light', 'Dark']) {
  test(`Conversation file links retain pointer and keyboard activation in ${scheme}`, async ({
    page
  }) => {
    const theme = page.locator('.theme-option').filter({
      has: page.getByRole('button', { name: 'Inspect ' + scheme, exact: true })
    });
    if (scheme === 'Light')
      await theme.getByRole('button', { name: 'Apply theme', exact: true }).click();
    const section = page.getByRole('region', { name: 'Conversation file links' });
    const output = section.getByLabel('Opened Markdown files');
    const opened: { path: string; line?: number; external: boolean }[] = [];
    for (const [name, path, line] of [
      ['Windows protocol', 'docs/design/BLE_PROTOCOL.md', 7],
      ['README.md:10', 'README.md', 10],
      ['Relative file', 'docs/guide.md', 3],
      ['Temporary file', '/tmp/note.txt', undefined]
    ] as const) {
      const link = section.getByRole('link', { name, exact: true });
      await expect(link).toHaveAttribute('href', '#');
      await expect(link).toHaveCSS('cursor', 'pointer');
      await link.click();
      opened.push({ path, ...(line === undefined ? {} : { line }), external: false });
      await expect(output).toHaveText(JSON.stringify(opened));
      await link.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(link).toBeFocused();
      await page.keyboard.press('Enter');
      opened.push({ path, ...(line === undefined ? {} : { line }), external: false });
      await expect(output).toHaveText(JSON.stringify(opened));
      await expect(page).toHaveURL(/custom-theme\.html$/u);
    }
    await section.getByRole('link', { name: 'Windows protocol', exact: true }).click({
      modifiers: ['Control']
    });
    opened.push({ path: 'docs/design/BLE_PROTOCOL.md', line: 7, external: true });
    await expect(output).toHaveText(JSON.stringify(opened));
    await expect(page).toHaveURL(/custom-theme\.html$/u);
    const external = section.getByRole('link', { name: 'External website', exact: true });
    await expect(external).toHaveAttribute('href', 'https://example.com/help');
    await expect(external).toHaveAttribute('target', '_blank');
    await expect(external).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(external).toHaveCSS('cursor', 'pointer');
    await expect(section.locator('a[href^="javascript:"]')).toHaveCount(0);
  });
}

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

test('PWA update reloads an unsaved theme without a leave confirmation', async ({ page }) => {
  await page.route('**/web-version.json', (route) =>
    route.fulfill({ json: { version: 'next', hash: 'next-build' } })
  );
  await page.goto(`${fixture.url}custom-theme.html?pwaUpdate`);
  await useThemeMenu(page, page.locator('.theme-option').first(), 'Duplicate');
  await page.getByRole('textbox', { name: 'Theme JSON', exact: true }).fill('unsaved draft');
  expect(
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })))
  ).toBe(false);
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    void dialog.accept();
  });
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.getByRole('button', { name: 'Apply PWA update', exact: true }).click()
  ]);
  expect(dialogs).toEqual([]);
  await expect(page.getByRole('textbox', { name: 'Theme JSON', exact: true })).not.toHaveValue(
    'unsaved draft'
  );
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
  const themeSettings = page.locator('.theme-settings');
  await expect(themeSettings.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await expect(themeSettings.getByRole('button', { name: /New (dark|light) theme/ })).toHaveCount(
    0
  );
  await expect(
    themeSettings.getByRole('columnheader', { name: 'Base theme', exact: true })
  ).toHaveCount(0);
  await expect(themeSettings.getByRole('button', { name: 'Save theme', exact: true })).toHaveCount(
    0
  );
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
  test(`Select options separate neutral selection from brand focus in ${scheme}`, async ({
    page
  }, testInfo) => {
    if (scheme === 'Light')
      await page
        .locator('.theme-option')
        .filter({ has: page.getByRole('button', { name: 'Inspect Light', exact: true }) })
        .getByRole('button', { name: 'Apply theme', exact: true })
        .click();
    const samples = page.getByRole('region', { name: 'Select state samples' });
    for (const custom of [false, true]) {
      if (custom)
        await page.locator('html').evaluate((element) => {
          for (const [token, value] of Object.entries({
            '--mar-color-brand': '#bf6ac9',
            '--mar-text-primary': '#dae5cf',
            '--mar-text-faint': '#8293a4',
            '--mar-border-medium': '#718293',
            '--mar-fill-row-hover': '#334455',
            '--mar-fill-selection': '#445566'
          }))
            element.style.setProperty(token, value);
        });
      const palette = await samples.evaluate((element) => {
        const probe = document.createElement('span');
        element.append(probe);
        const color = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const result = {
          text: color('--mar-text-primary'),
          disabled: color('--mar-text-faint'),
          selected: color('--mar-fill-selection'),
          hover: color('--mar-fill-row-hover'),
          hoverBorder: color('--mar-border-medium'),
          disabledBorder: color('--mar-border-subtle'),
          focus: color('--mar-color-brand')
        };
        probe.remove();
        return result;
      });
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const name of ['Neutral select', 'Multiple select']) {
          const select = samples.getByRole('combobox', { name, exact: true });
          const wrapper = select.locator(
            'xpath=ancestor::div[contains(@class,"el-select__wrapper")]'
          );
          await page.getByRole('button', { name: 'Sample default', exact: true }).focus();
          await wrapper.hover();
          await expect(wrapper).toHaveCSS(
            'box-shadow',
            `${palette.hoverBorder} 0px 0px 0px 1px inset`
          );
          await select.focus();
          await select.press('ArrowDown');
          await expect(wrapper).toHaveCSS('box-shadow', `${palette.focus} 0px 0px 0px 1px inset`);
          const dropdown = page.getByRole('listbox', { name, exact: true });
          const selected = dropdown.getByRole('option', { name: 'One', exact: true });
          const other = dropdown.getByRole('option', { name: 'Two', exact: true });
          const disabled = dropdown.getByRole('option', { name: 'Unavailable', exact: true });
          await expect(selected).toHaveAttribute('aria-selected', 'true');
          await expect(selected).toHaveCSS('color', palette.text);
          await expect(selected).toHaveCSS('font-weight', '400');
          await expect(selected).toHaveCSS('background-color', palette.selected);
          await other.hover();
          await expect(other).toHaveCSS('color', palette.text);
          await expect(other).toHaveCSS('background-color', palette.hover);
          await selected.hover();
          await expect(selected).toHaveCSS('background-color', palette.selected);
          await disabled.hover({ force: true });
          await expect(disabled).toHaveAttribute('aria-disabled', 'true');
          await expect(disabled).toHaveCSS('color', palette.disabled);
          await expect(disabled).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
          if (name === 'Multiple select') {
            expect(
              await selected.evaluate(
                (element) => getComputedStyle(element, '::after').backgroundColor
              )
            ).toBe(palette.text);
            expect(
              await disabled.evaluate(
                (element) => getComputedStyle(element, '::after').backgroundColor
              )
            ).toBe(palette.disabled);
          }
          if (!custom)
            await dropdown.screenshot({ path: testInfo.outputPath(`${name}-${width}.png`) });
          await select.press('Escape');
          await expect(dropdown).toBeHidden();
        }
        const disabledSelect = samples.getByRole('combobox', {
          name: 'Disabled select',
          exact: true
        });
        await expect(disabledSelect).toBeDisabled();
        const disabledWrapper = disabledSelect.locator(
          'xpath=ancestor::div[contains(@class,"el-select__wrapper")]'
        );
        await disabledWrapper.hover();
        await expect(disabledWrapper).toHaveCSS(
          'box-shadow',
          `${palette.disabledBorder} 0px 0px 0px 1px inset`
        );
      }
    }
  });

  test(`Ordinary actions preserve neutral states and bordered surfaces in ${scheme}`, async ({
    page
  }, testInfo) => {
    if (scheme === 'Light')
      await page
        .locator('.theme-option')
        .filter({ has: page.getByRole('button', { name: 'Inspect Light', exact: true }) })
        .getByRole('button', { name: 'Apply theme', exact: true })
        .click();
    const controls = page.getByRole('region', { name: 'Real theme controls' });
    const secondary = controls.getByRole('button', { name: 'Sample default', exact: true });
    const neutral = controls.getByRole('button', { name: 'Sample neutral action', exact: true });
    const disabled = controls.getByRole('button', { name: 'Sample disabled default', exact: true });
    const danger = controls.getByRole('button', { name: 'Sample dangerous action', exact: true });
    const navigation = controls.getByRole('link', { name: 'Manage usage', exact: true });
    for (const custom of [false, true]) {
      if (custom)
        await page.locator('html').evaluate((element) => {
          for (const [token, value] of Object.entries({
            '--mar-text-primary': '#dae5cf',
            '--mar-text-secondary': '#a5b6c7',
            '--mar-color-brand': '#bf6ac9',
            '--mar-fill-row-hover': '#334455',
            '--mar-fill-selection': '#445566',
            '--mar-border-medium': '#718293'
          }))
            element.style.setProperty(token, value);
        });
      const colors = await controls.evaluate((element) => {
        const probe = document.createElement('span');
        element.append(probe);
        const color = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const result = {
          normal: color('--mar-text-secondary'),
          hover: color('--mar-text-primary'),
          surface: color('--mar-fill-row-hover'),
          pressed: color('--mar-fill-selection'),
          border: color('--mar-border-medium'),
          focus: color('--mar-color-brand'),
          navigation: color('--el-color-primary'),
          navigationSurface: color('--el-color-primary-light-9')
        };
        probe.remove();
        return result;
      });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await controls.getByRole('textbox', { name: 'Sample input' }).focus();
        await page.mouse.move(0, 0);
        await expect(neutral).toHaveCSS('color', colors.normal);
        await neutral.hover();
        await expect(neutral).toHaveCSS('color', colors.hover);
        await expect(neutral).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await page.mouse.down();
        await expect(neutral).toHaveCSS('color', colors.hover);
        await page.mouse.up();
        await secondary.hover();
        await expect(secondary).toHaveCSS('color', colors.hover);
        await expect(secondary).toHaveCSS('background-color', colors.surface);
        await expect(secondary).toHaveCSS('border-top-color', colors.border);
        await expect(secondary).toHaveCSS('border-top-width', '1px');
        await expect(secondary).toHaveCSS('transform', 'none');
        await page.mouse.down();
        await expect(secondary).toHaveCSS('background-color', colors.pressed);
        await page.mouse.up();
        await page.mouse.move(0, 0);
        await secondary.focus();
        await page.keyboard.down('Space');
        try {
          await expect(secondary).toHaveCSS('color', colors.hover);
          await expect(secondary).toHaveCSS('background-color', colors.pressed);
        } finally {
          await page.keyboard.up('Space');
        }
        await neutral.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        await expect(neutral).toBeFocused();
        await expect(neutral).toHaveCSS('outline-color', colors.focus);
        await expect(neutral).toHaveCSS('outline-style', 'solid');
        const disabledColor = await disabled.evaluate((element) => getComputedStyle(element).color);
        await disabled.hover({ force: true });
        await expect(disabled).toBeDisabled();
        await expect(disabled).toHaveCSS('color', disabledColor);
        await danger.hover();
        await expect(danger).not.toHaveCSS('color', colors.hover);
        await expect(danger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(navigation).toHaveAttribute('href', 'https://chatgpt.com/settings/usage');
        await expect(navigation).toHaveAttribute('target', '_blank');
        await expect(navigation).toHaveAttribute('rel', 'noopener noreferrer');
        await navigation.hover();
        await expect(navigation).toHaveCSS('color', colors.navigation);
        await expect(navigation).toHaveCSS('background-color', colors.navigationSurface);
        const preview = page.locator('.theme-preview').first();
        const previewColors = await preview.evaluate((element) => {
          const probe = document.createElement('span');
          element.append(probe);
          const color = (token: string) => {
            probe.style.color = `var(${token})`;
            return getComputedStyle(probe).color;
          };
          const palette = {
            text: color('--mar-text-primary'),
            hover: color('--mar-fill-row-hover'),
            pressed: color('--mar-fill-selection'),
            border: color('--mar-border-medium'),
            foreground: color('--mar-color-on-accent'),
            primaryHover: color('--mar-color-brand-hover')
          };
          probe.remove();
          return palette;
        });
        const previewSecondary = preview.locator('.preview-button.secondary');
        await previewSecondary.hover();
        await expect(previewSecondary).toHaveCSS('color', previewColors.text);
        await expect(previewSecondary).toHaveCSS('background-color', previewColors.hover);
        await expect(previewSecondary).toHaveCSS('border-top-color', previewColors.border);
        await page.mouse.move(0, 0);
        await previewSecondary.focus();
        await page.keyboard.down('Space');
        try {
          await expect(previewSecondary).toHaveCSS('color', previewColors.text);
          await expect(previewSecondary).toHaveCSS('background-color', previewColors.pressed);
        } finally {
          await page.keyboard.up('Space');
        }
        const previewPrimary = preview.locator('.preview-button.primary');
        await previewPrimary.hover();
        await expect(previewPrimary).toHaveCSS('color', previewColors.foreground);
        await expect(previewPrimary).toHaveCSS('background-color', previewColors.primaryHover);
        await controls.screenshot({
          path: testInfo.outputPath(`neutral-actions-${custom ? 'custom' : 'builtin'}-${width}.png`)
        });
      }
    }
  });

  test(
    'workspace Git and branch labels use distinct ' + scheme + ' theme colors',
    async ({ page }, testInfo) => {
      const row = page.locator('.theme-option').filter({
        has: page.getByRole('button', { name: 'Inspect ' + scheme, exact: true })
      });
      if (scheme === 'Light')
        await row.getByRole('button', { name: 'Apply theme', exact: true }).click();
      const workspace = page.getByRole('region', { name: 'Real workspace labels' });
      const git = workspace.locator('.workspace-kind-tag');
      const branch = workspace.locator('.workspace-branch-tag');
      const input = workspace.getByRole('textbox', { name: 'Workspace branch' });
      const colors =
        scheme === 'Light'
          ? {
              git: ['#a15c07', '#fff4df', '#a15c078c'],
              branch: ['#075fc7', '#eaf2ff', '#8ab8ff']
            }
          : {
              git: ['#d29922', '#f1c56e24', '#d299228c'],
              branch: ['#3093ff', '#3093ff24', '#1f73cf7a']
            };
      async function expectColors(expected: Record<'git' | 'branch', string[]>): Promise<void> {
        for (const [tag, palette] of [
          [git, expected.git],
          [branch, expected.branch]
        ] as const) {
          // Theme transitions can expose transient OKLab colors before the final palette settles.
          await expect(async () => {
            const actual = await tag.evaluate((element) => {
              const style = getComputedStyle(element);
              return [style.color, style.backgroundColor, style.borderTopColor];
            });
            expect(actual.map(resolvedColorToHex)).toEqual(palette);
            const contentColor = await tag
              .locator('.el-tag__content')
              .evaluate((element) => getComputedStyle(element).color);
            expect(resolvedColorToHex(contentColor)).toBe(palette[0]);
          }).toPass({ timeout: 5_000 });
        }
      }
      await expect(git).toHaveText('Git');
      for (const name of [
        'main',
        'master',
        'develop',
        'feature/ui',
        'release/1.0',
        'hotfix/hover',
        'other'
      ]) {
        await input.fill(name);
        await expect(branch).toHaveText(name);
        await expectColors(colors);
      }
      await input.fill('develop');
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expectColors(colors);
        await workspace.locator('.session-heading').screenshot({
          path: testInfo.outputPath('workspace-labels-' + width + '.png')
        });
      }
      const longBranch = 'feature/a-long-branch-name-that-must-remain-bounded';
      await input.fill(longBranch);
      await expect(branch).toHaveText(longBranch);
      await expect(branch).toHaveCSS('text-overflow', 'ellipsis');
      await expect.poll(async () => (await branch.boundingBox())?.width).toBeLessThanOrEqual(160);
      await expectColors(colors);

      const gitWorkspace = workspace.getByRole('checkbox', { name: 'Git workspace', exact: true });
      const workspaceToggle = workspace.getByText('Git workspace', { exact: true });
      await workspaceToggle.click();
      await expect(gitWorkspace).not.toBeChecked();
      await expect(git).toHaveCount(0);
      await expect(branch).toHaveCount(0);
      await workspaceToggle.click();
      await expect(gitWorkspace).toBeChecked();
      await expect(git).toHaveText('Git');
      await expect(branch).toHaveText(longBranch);
      await expectColors(colors);

      await row.getByRole('button', { name: 'Inspect ' + scheme, exact: true }).click();
      const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
      const theme = JSON.parse(await editor.inputValue());
      theme.name = scheme + ' Git labels';
      Object.assign(theme.colors, {
        '--mar-text-secondary': '#bacac0',
        '--mar-bg-subtle': '#1b2521',
        '--mar-border-default': '#3f5148',
        '--mar-color-warning-text': '#e3b669',
        '--mar-color-warning-bg': '#30271a',
        '--mar-color-brand-text': '#91b7ed',
        '--mar-color-brand-subtle': '#1d2d43',
        '--mar-color-brand-border': '#4a6d9c'
      });
      await page.locator('input[type=file]').setInputFiles({
        name: 'git-labels.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(theme))
      });
      await page.getByRole('button', { name: 'Save theme', exact: true }).click();
      await page
        .locator('.theme-option')
        .filter({ has: page.getByRole('button', { name: 'Inspect ' + theme.name, exact: true }) })
        .getByRole('button', { name: 'Apply theme', exact: true })
        .click();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expectColors({
          git: ['#e3b669', '#30271a', '#e3b6698c'],
          branch: ['#91b7ed', '#1d2d43', '#4a6d9c']
        });
        await workspace.locator('.session-heading').screenshot({
          path: testInfo.outputPath('workspace-labels-custom-' + width + '.png')
        });
      }
    }
  );
}

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
          utility: style.getPropertyValue('--mar-text-primary').trim()
        };
      });
      const help = page.getByRole('button', { name: 'Theme color reference', exact: true });
      const more = options.first().getByRole('button', { name: /^More actions for / });
      for (const control of [help, more]) {
        const label = (await control.getAttribute('aria-label')) ?? '';
        expect(label).not.toBe('');
        await expect(control).not.toHaveAttribute('title');
        await control.hover();
        await expect(page.getByRole('tooltip', { name: label, exact: true })).toBeVisible();
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
        .toBe(palette.utility);
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
      await page.locator('html').evaluate((element) => {
        element.style.setProperty('--mar-text-primary', '#d9e2d0');
        element.style.setProperty('--mar-color-brand-text', '#8a4fc7');
      });
      for (const control of [help, more]) {
        await control.hover();
        await expect(control).toHaveCSS('color', 'rgb(217, 226, 208)');
        await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await page.mouse.move(0, 0);
        await control.focus();
        await expect(control).toHaveCSS('color', 'rgb(217, 226, 208)');
        await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      }
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
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const option of [options.nth(1), options.first()]) {
      const choice = option.getByRole('button', { name: /^Inspect /u });
      await choice.click();
      await expect(choice).toHaveAttribute('aria-pressed', 'true');
      const reference = await option.evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--mar-fill-selection)';
        probe.style.borderColor = 'var(--mar-border-default)';
        element.append(probe);
        const style = getComputedStyle(probe);
        const result = { background: style.backgroundColor, border: style.borderColor };
        probe.remove();
        return result;
      });
      await expect(option).toHaveCSS('background-color', reference.background);
      await expect(option).toHaveCSS('border-color', reference.border);
      await choice.hover();
      await expect(choice).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(option).toHaveCSS('background-color', reference.background);
    }
  }
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
    async ({ page }, testInfo) => {
      const controls = page.getByRole('region', { name: 'Real theme controls' });
      const row = page.locator('.theme-option').filter({
        has: page.getByRole('button', { name: 'Inspect ' + scheme, exact: true })
      });
      if (scheme === 'Light')
        await row.getByRole('button', { name: 'Apply theme', exact: true }).click();
      else await expect(row.getByRole('button', { name: 'Active', exact: true })).toBeDisabled();
      const typography = page.getByRole('region', { name: 'Real conversation typography' });
      const conversationText = scheme === 'Dark' ? 'rgb(208, 215, 226)' : 'rgb(23, 32, 51)';
      const conversationMuted = scheme === 'Dark' ? 'rgb(159, 176, 199)' : 'rgb(82, 98, 122)';
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const selector of ['p', 'strong', 'h3', 'th', 'td', 'code'])
          await expect(typography.locator('.agent-markdown ' + selector).first()).toHaveCSS(
            'color',
            conversationText
          );
        await expect(typography.locator('.agent-markdown')).toHaveCSS(
          'font-size',
          width < 768 ? '13px' : '14px'
        );
        await expect(typography.locator('.conversation-metadata')).toHaveCSS(
          'color',
          conversationMuted
        );
        await typography.screenshot({
          path: testInfo.outputPath('conversation-typography-' + width + '.png')
        });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      // Resizing and screenshots can leave the pointer over a control; inspect its neutral state.
      await page.mouse.move(-10, -10);
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
        scheme === 'Dark' ? 'rgb(31, 115, 207)' : 'rgb(9, 105, 232)'
      );
      const primary = controls.getByRole('button', { name: 'Sample primary', exact: true });
      await primary.scrollIntoViewIfNeeded();
      const primaryBounds = await primary.boundingBox();
      await primary.screenshot({ path: testInfo.outputPath('primary-default.png') });
      await primary.hover();
      const hoverColor = scheme === 'Dark' ? 'rgb(26, 101, 184)' : 'rgb(5, 84, 184)';
      await expect(primary).toHaveCSS('background-color', hoverColor);
      await expect(primary).toHaveCSS('border-top-color', hoverColor);
      await expect(primary).toHaveCSS('color', 'rgb(255, 255, 255)');
      await expect(primary).toHaveCSS('transform', 'none');
      expect(await primary.boundingBox()).toEqual(primaryBounds);
      await primary.screenshot({ path: testInfo.outputPath('primary-hover.png') });
      expect(
        resolvedColorToHex(
          await controls
            .getByRole('button', { name: 'Sample disabled primary', exact: true })
            .evaluate((element) => getComputedStyle(element).color)
        )
      ).toBe(scheme === 'Dark' ? '#ffffff80' : '#ffffff');
      await expect(controls.locator('.el-table th')).toHaveCSS(
        'background-color',
        scheme === 'Dark' ? 'rgb(19, 25, 34)' : 'rgb(237, 243, 250)'
      );
      await controls.locator('.el-table__body tr').first().hover();
      await expect(controls.locator('.el-table__body td').first()).toHaveCSS(
        'background-color',
        scheme === 'Dark' ? 'rgb(32, 43, 58)' : 'rgb(229, 237, 246)'
      );
      await controls.getByRole('button', { name: 'Sample link', exact: true }).hover();
      await expect(controls.getByRole('button', { name: 'Sample link', exact: true })).toHaveCSS(
        'color',
        scheme === 'Dark' ? 'rgb(74, 163, 255)' : 'rgb(4, 74, 159)'
      );
      const neutral = controls.getByRole('button', { name: 'Sample neutral action', exact: true });
      const disabledNeutral = controls.getByRole('button', {
        name: 'Sample disabled neutral action',
        exact: true
      });
      const danger = controls.getByRole('button', { name: 'Sample dangerous action', exact: true });
      await page.mouse.move(0, 0);
      const neutralColor = await neutral.evaluate((element) => getComputedStyle(element).color);
      const dangerColor = await danger.evaluate((element) => getComputedStyle(element).color);
      const disabledNeutralColor = await disabledNeutral.evaluate(
        (element) => getComputedStyle(element).color
      );
      expect(neutralColor).not.toBe(dangerColor);
      expect(neutralColor).not.toBe(scheme === 'Dark' ? 'rgb(48, 147, 255)' : 'rgb(7, 95, 199)');
      await expect(disabledNeutral).toBeDisabled();
      for (const action of [neutral, disabledNeutral, danger]) {
        await expect(action).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await action.hover({ force: true });
        await expect(action).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      }
      await disabledNeutral.hover({ force: true });
      await expect(disabledNeutral).toHaveCSS('color', disabledNeutralColor);
      await neutral.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(neutral).toBeFocused();
      await expect(neutral).not.toHaveCSS('outline-style', 'none');
      await controls.screenshot({ path: testInfo.outputPath('action-hierarchy.png') });
      const management = page.getByRole('region', { name: 'Real management actions' });
      const edit = management.locator('.prompt-actions .el-button').first();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.mouse.move(0, 0);
        await expect(edit).toHaveCSS('color', neutralColor);
        await expect(edit).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await edit.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('.el-button--primary')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await management.screenshot({
          path: testInfo.outputPath('management-actions-' + width + '.png')
        });
      }
      await page.setViewportSize({ width: 1440, height: 900 });

      await useThemeMenu(page, row, 'Duplicate');
      const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
      const theme = JSON.parse(await editor.inputValue());
      Object.assign(theme.colors, {
        '--mar-bg-panel': '#123456',
        '--mar-table-header-bg': '#234567',
        '--mar-table-row-hover-bg': '#345678',
        '--mar-color-on-accent': '#fedcba',
        '--mar-color-brand-hover': '#234567',
        '--mar-conversation-text': '#d5c4af',
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
      for (const selector of ['p', 'strong', 'h3', 'th', 'td', 'code'])
        await expect(typography.locator('.agent-markdown ' + selector).first()).toHaveCSS(
          'color',
          'rgb(213, 196, 175)'
        );
      await expect(typography.locator('.conversation-metadata')).toHaveCSS(
        'color',
        conversationMuted
      );
      await expect(controls.getByRole('button', { name: 'Sample primary', exact: true })).toHaveCSS(
        'color',
        'rgb(254, 220, 186)'
      );
      await primary.hover();
      await expect(primary).toHaveCSS('background-color', 'rgb(35, 69, 103)');
      await expect(primary).toHaveCSS('border-top-color', 'rgb(35, 69, 103)');
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
          '--sidebar-header-height': mobile ? '46px' : '44px',
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

test('real message feedback follows light, dark, and custom theme tokens and keeps duplicates separate', async ({
  page
}) => {
  for (const scheme of ['Light', 'Dark']) {
    const row = page.locator('.theme-option').filter({
      has: page.getByRole('button', { name: 'Inspect ' + scheme, exact: true })
    });
    await row.getByRole('button', { name: 'Apply theme', exact: true }).click();
    await page.getByTestId('show-info-feedback').click();
    const message = page
      .locator('.el-message--info')
      .filter({ hasText: 'Theme-aware info feedback' });
    await expect(message).toContainText('Theme-aware info feedback');
    await expectMessageThemeTokens(message, '--mar-text-secondary');
    await expectMessageFirstLineAlignment(message);
    await message.locator('.mar-message-close').click();
    await expect(message).toHaveCount(0);
  }

  const options = page.locator('.theme-option');
  await useThemeMenu(page, options.first(), 'Duplicate');
  const editor = page.getByRole('textbox', { name: 'Theme JSON', exact: true });
  await editor.fill(
    JSON.stringify({
      version: 1,
      name: 'Message feedback palette',
      colors: {
        '--mar-control-bg-color-overlay': '#263547',
        '--mar-text-primary': '#f4f6fa',
        '--mar-text-secondary': '#c3d0df',
        '--mar-border-default': '#718096',
        '--mar-color-brand': '#72a9ff',
        '--mar-control-color-success': '#39a879',
        '--mar-control-color-warning': '#e2a83b',
        '--mar-control-color-danger': '#f06a65'
      }
    })
  );
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  const customTheme = options.filter({ hasText: 'Message feedback palette' });
  await customTheme.getByRole('button', { name: 'Apply theme', exact: true }).click();

  for (const [testId, type, token] of [
    ['show-info-feedback', 'info', '--mar-text-secondary'],
    ['show-success-feedback', 'success', '--mar-control-color-success'],
    ['show-warning-feedback', 'warning', '--mar-control-color-warning'],
    ['show-error-feedback', 'error', '--mar-control-color-danger']
  ] as const) {
    await page.getByTestId(testId).click();
    const message = page
      .locator('.el-message--' + type)
      .filter({ hasText: 'Theme-aware ' + type + ' feedback' });
    await expect(message).toBeVisible();
    await expectMessageThemeTokens(message, token);
    await expectMessageFirstLineAlignment(message);
    await message.locator('.mar-message-close').click();
    await expect(message).toHaveCount(0);
  }

  await page.getByTestId('show-repeated-feedback').click();
  const repeated = page.locator('.el-message--info').filter({ hasText: 'Repeated feedback event' });
  await expect(repeated).toHaveCount(2);
  await expect
    .poll(async () => {
      const tops = await repeated.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().top)
      );
      return tops.length === 2 && Math.abs(tops[0]! - tops[1]!) > 1;
    })
    .toBe(true);
  await repeated.first().locator('.mar-message-close').click();
  await repeated.last().locator('.mar-message-close').click();
  await expect(repeated).toHaveCount(0);
});

test('short and diagnostic feedback automatically disappear while hover pauses dismissal', async ({
  page
}) => {
  await page.clock.install();
  await page.mouse.move(0, 0);
  await page.getByTestId('show-info-feedback').click();
  const info = page.locator('.el-message--info');
  await expect(info).toBeVisible();
  await page.clock.runFor(2_000);
  await expect(info).toBeVisible();
  await page.clock.runFor(1_500);
  await expect(info).toHaveCount(0);

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByTestId('show-long-feedback').click();
    const error = page.locator('.el-message--error');
    await expect(error).toBeVisible();
    await page.clock.runFor(5_000);
    await expect(error).toBeVisible();
    await error.hover();
    await page.clock.runFor(7_000);
    await expect(error).toBeVisible();
    await page.mouse.move(0, 0);
    await page.clock.runFor(6_500);
    await expect(error).toHaveCount(0);
  }
});

test('mobile long feedback scrolls without trapping its accessible close control and dialogs close with Escape', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('show-plain-text-feedback').click();
  const plainTextMessage = page
    .locator('.el-message--warning')
    .filter({ hasText: 'Plain text <img data-feedback-payload=unsafe src=x>' });
  await expect(plainTextMessage.locator('.mar-message-text')).toHaveText(
    'Plain text <img data-feedback-payload=unsafe src=x>'
  );
  await expect(plainTextMessage.locator('img')).toHaveCount(0);
  await plainTextMessage.locator('.mar-message-close').click();
  await expect(plainTextMessage).toHaveCount(0);

  await page.getByTestId('open-feedback-dialog').click();
  const dialog = page.getByRole('dialog', { name: 'Message feedback dialog', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await page.getByTestId('show-dialog-feedback').click();
  const message = dialog
    .locator('.el-message--error')
    .filter({ hasText: 'Line 1: long feedback remains readable and can be dismissed.' });
  const content = message.locator('.mar-message-text');
  const close = message.locator('.mar-message-close');
  await expect(content).toContainText(
    'Line 1: long feedback remains readable and can be dismissed.'
  );
  await expectMessageFirstLineAlignment(message);
  expect(await message.evaluate((element) => element.closest('[role="dialog"]') !== null)).toBe(
    true
  );
  await expect(dialog).toBeVisible();

  const layout = await message.evaluate((element) => {
    const content = element.querySelector('.mar-message-text')!;
    const close = element.querySelector('.el-message__closeBtn')!;
    const rect = (target: Element) => {
      const { x, y, width, height } = target.getBoundingClientRect();
      return { x, y, width, height, right: x + width, bottom: y + height };
    };
    return {
      message: rect(element),
      content: rect(content),
      close: rect(close),
      scrollHeight: content.scrollHeight,
      clientHeight: content.clientHeight,
      scrollWidth: content.scrollWidth,
      clientWidth: content.clientWidth,
      closeOutsideContent: !content.contains(close)
    };
  });
  expect(layout.message.x).toBeGreaterThanOrEqual(16);
  expect(layout.message.right).toBeLessThanOrEqual(374);
  expect(layout.content.right).toBeLessThanOrEqual(layout.close.x);
  expect(layout.closeOutsideContent).toBe(true);
  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);

  await expect(close).toHaveRole('button');
  await expect(close).toHaveAccessibleName(/close/i);
  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(close).toBeVisible();
  await close.focus();
  await expect(close).toBeFocused();
  await close.press('Enter');
  await expect(message).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('dialog-attached feedback leaves no offset after the dialog closes', async ({ page }) => {
  await page.getByTestId('show-info-feedback').click();
  const baselineMessage = page
    .locator('.el-message--info')
    .filter({ hasText: 'Theme-aware info feedback' });
  await expect(baselineMessage).toBeVisible();
  const baselineTop = await baselineMessage.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).top)
  );
  expect(Number.isFinite(baselineTop)).toBe(true);
  await baselineMessage.locator('.mar-message-close').click();
  await expect(baselineMessage).toHaveCount(0);

  await page.getByTestId('open-feedback-dialog').click();
  const dialog = page.getByRole('dialog', { name: 'Message feedback dialog', exact: true });
  await expect(dialog).toBeVisible();
  await page.getByTestId('show-dialog-feedback').click();
  const dialogMessage = dialog
    .locator('.el-message--error')
    .filter({ hasText: 'Line 1: long feedback remains readable and can be dismissed.' });
  await expect(dialogMessage).toBeVisible();

  await dialog.locator('.el-dialog__headerbtn').click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page
      .locator('.el-message--error')
      .filter({ hasText: 'Line 1: long feedback remains readable and can be dismissed.' })
  ).toHaveCount(0);

  await page.getByTestId('show-info-feedback').click();
  const nextMessage = page
    .locator('.el-message--info')
    .filter({ hasText: 'Theme-aware info feedback' });
  await expect(nextMessage).toBeVisible();
  const nextTop = await nextMessage.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).top)
  );
  expect(nextTop).toBeCloseTo(baselineTop, 1);

  await nextMessage.locator('.mar-message-close').click();
  await expect(nextMessage).toHaveCount(0);
});

test('successful dialog saves keep their feedback after the dialog is destroyed', async ({
  page
}) => {
  await page.getByTestId('open-feedback-dialog').click();
  await page.getByTestId('save-feedback-dialog').click();
  await expect(
    page.getByRole('dialog', { name: 'Message feedback dialog', exact: true })
  ).toHaveCount(0);
  const message = page.locator('.el-message--success').filter({ hasText: 'Dialog settings saved' });
  await expect(message).toBeVisible();
  await expect(message).toHaveJSProperty('isConnected', true);
  await message.locator('.mar-message-close').click();
  await expect(message).toHaveCount(0);
});
