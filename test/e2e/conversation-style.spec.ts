import { expect, test, type Page } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Conversation metadata, status and Composer remain readable in ${theme}`, async ({
    page
  }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${fixture.url}conversation-style.html?theme=${theme}`);
      const tokens = await page.locator('html').evaluate((root) => {
        const color = (token: string) => {
          const probe = document.createElement('span');
          probe.style.color = `var(${token})`;
          root.append(probe);
          const value = getComputedStyle(probe).color;
          probe.remove();
          return value;
        };
        return {
          text: color('--mar-conversation-text'),
          muted: color('--mar-conversation-muted'),
          brand: color('--mar-color-brand-text'),
          canvas: color('--mar-conversation-canvas'),
          panel: color('--mar-bg-panel')
        };
      });
      await expect(page.locator('.process-activity.is-active')).toHaveCSS('color', tokens.text);
      await expect(page.locator('.process-activity.is-active')).toHaveCSS('font-weight', '600');
      await expect(page.locator('.process-activity-indicator')).toHaveCSS('color', tokens.brand);
      await expect(page.locator('.composer-busy-indicator')).toHaveCSS('width', '10px');
      await expect(page.locator('.composer-busy-indicator')).toHaveCSS('height', '10px');
      await expect(page.locator('.composer')).toHaveCSS('background-color', tokens.canvas);
      await expect(page.locator('.composer-shell')).toHaveCSS('background-color', tokens.panel);
      await expect(page.locator('.composer-shell')).toHaveCSS('border-top-width', '1px');
      await expect(page.locator('.composer textarea')).toHaveCSS('font-size', '14px');
      await expect(page.locator('.task-list-heading > span')).toHaveCSS('color', tokens.muted);
      const taskColors = await page
        .locator('.task-list-status')
        .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).color));
      expect(new Set(taskColors).size).toBe(3);
      await expect(page.locator('.task-list-status')).toHaveText(['To-do', 'In progress', 'Done']);
      await expect(page.locator('.conversation-item-heading > span').first()).toHaveCSS(
        'color',
        tokens.muted
      );
      const files = page.locator('.conversation-file-change-details > summary');
      await expect(files.locator('.conversation-group-meta')).toContainText('2');
      const plan = page.locator('.conversation-record-meta').filter({ hasText: '2' });
      await expect(plan).toBeVisible();
      for (const meta of [files.locator('.conversation-group-meta'), plan]) {
        const bounds = await meta.boundingBox();
        const heading = await meta.locator('..').boundingBox();
        expect(bounds!.x + bounds!.width).toBeGreaterThan(heading!.x + heading!.width - 24);
      }
      const group = page.locator('.conversation-record-group').first();
      await group.locator(':scope > summary').click();
      const nested = group.locator(':scope > details > summary').first();
      // Preserve breathing room and a bounded nesting increment, not a particular padding declaration.
      const spacing = await nested.evaluate((element) => {
        const style = getComputedStyle(element);
        return { top: parseFloat(style.paddingTop), right: parseFloat(style.paddingRight) };
      });
      expect(spacing.top).toBeGreaterThanOrEqual(2);
      expect(spacing.right).toBeGreaterThanOrEqual(8);
      expect((await nested.boundingBox())!.x - (await group.boundingBox())!.x).toBeLessThanOrEqual(
        16
      );
      const status = page.locator('.conversation-status');
      const latest = page.locator('.conversation-latest');
      await expect(latest).toBeVisible();
      expect((await status.boundingBox())!.y + (await status.boundingBox())!.height).toBeLessThan(
        (await latest.boundingBox())!.y
      );
      await page.getByTestId('toggle-following').click();
      await expect(latest).toHaveCount(0);
      await expect(status).toBeVisible();
      const copy = page.locator('.conversation-session-id button');
      await expect(copy).toHaveCSS('cursor', 'pointer');
      await copy.hover();
      await expect(copy.locator('code')).toHaveCSS('color', tokens.brand);
      for (const control of [
        page.getByTestId('native-utility'),
        page.getByTestId('element-utility')
      ]) {
        await control.hover();
        await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(control).toHaveCSS('color', tokens.brand);
        await control.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await expect(control).toBeFocused();
        await expect(control).not.toHaveCSS('outline-style', 'none');
        await page.keyboard.down('Space');
        await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await page.keyboard.up('Space');
        await control.evaluate((element) => element.setAttribute('aria-expanded', 'true'));
        await page.mouse.move(0, 0);
        await control.evaluate((element) => element.blur());
        await expect(control).toHaveCSS('color', tokens.brand);
        await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      }
      await expect(page.getByTestId('disabled-utility')).toBeDisabled();
      const treeToggle = page.locator('.workbench-tree-toggle');
      await expect(treeToggle).toHaveAttribute('aria-expanded', 'true');
      const notificationToggle = page.locator('.workbench-notification-trigger');
      const loads = page.getByTestId('notification-loads');
      await notificationToggle.click();
      await expect(loads).toHaveText('1');
      await expect(notificationToggle).toHaveAttribute('aria-expanded', 'true');
      await notificationToggle.click();
      await expect(notificationToggle).toHaveAttribute('aria-expanded', 'false');
      await page.getByRole('button', { name: 'Preview notification', exact: true }).click();
      await expect(notificationToggle).toHaveAttribute('aria-expanded', 'true');
      await notificationToggle.click();
      await expect(loads).toHaveText('2');
      await notificationToggle.click();
      await notificationToggle.click();
      await expect(loads).toHaveText('3');
      for (const detail of await page
        .locator('.conversation-file-change-details, .conversation-record-group')
        .all()) {
        if (!(await detail.evaluate((element) => (element as HTMLDetailsElement).open)))
          await detail.locator(':scope > summary').click();
      }
      for (const marker of [
        '.task-list-status',
        '.conversation-file-change-status',
        '.conversation-error-code'
      ])
        await expect(page.locator(marker).first()).toHaveCSS('border-radius', '4px');
      for (const selector of ['.user-message', '.assistant-message', '.process'])
        await expect(page.locator('.theme-preview').locator(selector)).toHaveCSS(
          'border-radius',
          '12px'
        );
      const userMessage = page.locator('.conversation-item.user_message');
      for (const property of ['background-color', 'border-top-color']) {
        const actual = await userMessage.evaluate(
          (element, name) => getComputedStyle(element).getPropertyValue(name),
          property
        );
        await expect(page.locator('.theme-preview .user-message')).toHaveCSS(property, actual);
      }
      for (const [selector, edge, size] of [
        ['.task-list-items', 'border-top-width', '1px'],
        ['.task-list-items > li', 'border-bottom-width', '1px'],
        ['.conversation-tool-list', 'border-left-width', '2px'],
        ['.conversation-tool-list > .conversation-tool-detail', 'border-top-width', '1px'],
        ['.conversation-record-group > .conversation-tool-detail', 'border-top-width', '0px'],
        ['.conversation-record-group > .conversation-command-detail', 'border-top-width', '0px']
      ] as const)
        await expect(page.locator(selector).first()).toHaveCSS(edge, size);
      await treeToggle.click();
      await expect(treeToggle).toHaveAttribute('aria-expanded', 'false');
      await treeToggle.click();
      await expect(treeToggle).toHaveAttribute('aria-expanded', 'true');
    }
  });
}

async function paletteColors(page: Page): Promise<Record<string, string>> {
  return page.locator('html').evaluate((root) => {
    const style = getComputedStyle(root);
    return Object.fromEntries(
      Array.from(style)
        .filter((key) => key.startsWith('--mar-'))
        .map((key) => [key, style.getPropertyValue(key).trim()])
    );
  });
}
function contrast(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((offset) => {
      const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

test('uses the porcelain daylight palette with accessible interactive and text colors', async ({
  page
}) => {
  await page.goto(fixture.url + 'conversation-style.html?theme=daylight');
  const daylight = await paletteColors(page);
  expect(daylight['--mar-bg-page']).toBe('#f7f8fa');
  expect(daylight['--mar-bg-panel']).toBe('#ffffff');
  expect(daylight['--mar-bg-tab-inactive']).toBe('#e7ecf2');
  expect(daylight['--mar-border-default']).toBe('#c7d1dd');
  expect(daylight['--mar-color-brand']).toBe('#245fa8');
  expect(daylight['--mar-color-brand-text']).toBe('#245994');
  expect(daylight['--mar-color-brand-selected']).toBe('#dce8f7');
  expect(daylight['--mar-color-accent']).toBe('#386b80');
  expect(daylight['--mar-control-color-success']).toBe('#21694f');
  expect(daylight['--mar-text-primary']).toBe('#202b3b');
  expect(daylight['--mar-text-secondary']).toBe('#4f6073');
  expect(daylight['--mar-text-tertiary']).toBe('#5d6d80');
  expect(daylight['--mar-text-muted']).toBe('#5d6d80');
  expect(daylight['--mar-text-faint']).toBe('#5d6d80');

  for (const state of [
    '--mar-color-brand',
    '--mar-color-brand-hover',
    '--mar-control-color-primary-dark-2'
  ]) {
    expect(contrast('#ffffff', daylight[state]!)).toBeGreaterThanOrEqual(4.5);
  }
  for (const role of ['primary', 'secondary', 'tertiary', 'muted', 'faint']) {
    expect(
      contrast(daylight[`--mar-text-${role}`]!, daylight['--mar-bg-panel']!)
    ).toBeGreaterThanOrEqual(4.5);
  }
  for (const [foreground, background] of [
    ['--mar-color-brand-text', '--mar-color-brand-selected'],
    ['--mar-color-accent', '--mar-color-accent-bg'],
    ['--mar-color-success-text', '--mar-color-success-bg'],
    ['--mar-color-warning-text', '--mar-color-warning-bg'],
    ['--mar-color-danger-text', '--mar-color-danger-bg']
  ]) {
    expect(contrast(daylight[foreground!]!, daylight[background!]!)).toBeGreaterThanOrEqual(4.5);
  }
});
test('uses the original dark palette with distinct surfaces and readable button text', async ({
  page
}) => {
  await page.goto(fixture.url + 'conversation-style.html?theme=vscode-dark-2026');
  const dark = await paletteColors(page);
  expect(dark['--mar-bg-page']).toBe('#0e1116');
  expect(dark['--mar-bg-panel']).toBe('#161d28');
  expect(dark['--mar-bg-chrome']).toBe('#131922');
  for (const [role, color] of Object.entries({
    canvas: '#0e1116',
    surface: '#131922',
    process: '#111720',
    border: '#313d50',
    'process-border': '#202a39',
    text: '#d0d7e2',
    muted: '#9fb0c7',
    code: '#111720'
  })) {
    expect(dark[`--mar-conversation-${role}`]).toBe(color);
  }
  expect(dark['--mar-control-bg-color-overlay']).toBe('#1a2230');
  expect(dark['--mar-bg-tab-inactive']).toBe('#111720');
  expect(dark['--mar-border-default']).toBe('#273142');
  expect(dark['--mar-border-subtle']).toBe('#202a39');
  expect(dark['--mar-color-brand']).toBe('#1f73cf');
  expect(dark['--mar-color-brand-hover']).toBe('#1a65b8');
  expect(dark['--mar-color-brand-selected']).toBe('#162c44');
  expect(dark['--mar-color-on-accent']).toBe('#ffffff');
  expect(
    contrast(dark['--mar-color-brand-text']!, dark['--mar-color-brand-selected']!)
  ).toBeGreaterThanOrEqual(4.5);
  expect(dark['--mar-color-accent']).toBe('#5edcec');
  expect(dark['--mar-control-color-success']).toBe('#62d6a4');
  expect(dark['--mar-text-primary']).toBe('#e8eef8');
  expect(dark['--mar-text-secondary']).toBe('#9fb0c7');
  expect(dark['--mar-text-muted']).toBe('#8799b1');
  for (const surface of [
    '--mar-bg-page',
    '--mar-bg-chrome',
    '--mar-bg-panel',
    '--mar-control-bg-color-overlay'
  ]) {
    for (const text of ['--mar-text-primary', '--mar-text-secondary', '--mar-text-tertiary']) {
      expect(contrast(dark[text]!, dark[surface]!), text + ' on ' + surface).toBeGreaterThanOrEqual(
        4.5
      );
    }
  }
  for (const brandState of [
    '--mar-color-brand',
    '--mar-color-brand-hover',
    '--mar-control-color-primary-light-3',
    '--mar-control-color-primary-dark-2'
  ]) {
    expect(contrast(dark['--mar-color-on-accent']!, dark[brandState]!)).toBeGreaterThanOrEqual(4.5);
  }
  expect(dark['--mar-shadow-medium']).toBe('#00000047');
  expect(dark['--mar-overlay-scrim']).toBe('#0000007a');
  expect(dark['--mar-text-neutral-control']).toBe('#8799b1');
});

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test('Navigation and conversation contrasts remain accessible in ' + theme, async ({ page }) => {
    await page.goto(fixture.url + 'conversation-style.html?theme=' + theme);
    const colors = await paletteColors(page);
    const selected = colors['--mar-fill-selection']!;
    const hover = colors['--mar-fill-row-hover']!;
    expect(selected).not.toBe(colors['--mar-color-brand-selected']);
    for (const text of ['--mar-text-primary', '--mar-text-secondary'])
      expect(contrast(colors[text]!, selected)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors['--mar-color-brand-text']!, selected)).toBeGreaterThanOrEqual(3);
    for (const background of ['--mar-bg-panel', '--mar-bg-chrome'])
      expect(contrast(selected, colors[background]!)).toBeGreaterThan(
        contrast(hover, colors[background]!)
      );
    expect(colors['--mar-conversation-canvas']).not.toBe(colors['--mar-conversation-surface']);
    for (const text of ['text', 'muted'])
      for (const background of ['canvas', 'surface', 'process', 'code'])
        expect(
          contrast(
            colors['--mar-conversation-' + text]!,
            colors['--mar-conversation-' + background]!
          )
        ).toBeGreaterThanOrEqual(4.5);
  });
}
