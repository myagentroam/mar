import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/file-editor-layout.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

test('standalone Git Diff loads its shared preview actions', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`${fixture.url}isolated-git-diff.html`);
  const actions = page.locator('.diff-preview-toolbar');
  await expect(actions).toBeVisible();
  await expect(actions).toHaveCSS('display', 'flex');
  const [gap, rootSize] = await actions.evaluate((element) => [
    parseFloat(getComputedStyle(element).columnGap),
    parseFloat(getComputedStyle(document.documentElement).fontSize)
  ]);
  expect(gap).toBeCloseTo(rootSize! * 0.4, 1);
  expect(requests.some((url) => /Workspace(?:Text|Format)FilePage\.vue/u.test(url))).toBe(false);
});

for (const shape of ['small', 'landscape', 'portrait']) {
  test(`File image previews fit their stable surface without upscaling: ${shape}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1920, height: 1200 });
    await page.goto(`${fixture.url}file-editor-layout.html?image=${shape}`);
    const surface = page.locator('.file-preview-surface');
    await surface.evaluate((el: HTMLElement) =>
      el.style.setProperty('--mar-control-bg-color-overlay', '#173b4a')
    );
    await expect(surface).toHaveCSS('background-color', 'rgb(23, 59, 74)');
    const image = surface.getByRole('img', { name: 'sample.svg', exact: true });
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBeGreaterThan(0);
    const handle = await image.elementHandle();
    for (const mobile of [false, true]) {
      if (mobile) await page.setViewportSize({ width: 390, height: 844 });
      await expect(surface).toHaveCSS('width', mobile ? '390px' : '1440px');
      await expect(surface).toHaveCSS('height', mobile ? '844px' : '960px');
      const size = await image.evaluate((el: HTMLImageElement) => {
        const area = el.parentElement!;
        const css = getComputedStyle(area);
        const bounds = el.getBoundingClientRect();
        return {
          width: bounds.width,
          height: bounds.height,
          naturalWidth: el.naturalWidth,
          naturalHeight: el.naturalHeight,
          availableWidth:
            area.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight),
          availableHeight:
            area.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom)
        };
      });
      const scale = Math.min(
        1,
        size.availableWidth / size.naturalWidth,
        size.availableHeight / size.naturalHeight
      );
      expect(size.width).toBeCloseTo(size.naturalWidth * scale, 0);
      expect(size.height).toBeCloseTo(size.naturalHeight * scale, 0);
      expect(await handle!.evaluate((el) => el.isConnected)).toBe(true);
      await expect(
        surface.getByRole('button', { name: 'Close preview', exact: true })
      ).toBeVisible();
    }
    if (shape === 'portrait')
      await page.screenshot({ path: testInfo.outputPath('mobile-file-image-preview.png') });
  });
}

test('Working-tree Diff keeps its minimap inside the content inset across viewports', async ({
  page
}, testInfo) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${fixture.url}file-editor-layout.html?diff=WORKING_TREE&long=1`);
    const content = page.locator('.unified-diff-content');
    const minimap = content.locator('.diff-minimap');
    const code = content.locator('.unified-diff-code');
    await expect(minimap).toBeVisible();
    const background = await code.evaluate((element) => getComputedStyle(element).backgroundColor);
    await expect(content).toHaveCSS('background-color', background);
    const gaps = await content.evaluate((element) => {
      const outer = element.getBoundingClientRect();
      const pane = element.querySelector('.unified-diff-pane')!.getBoundingClientRect();
      const map = element.querySelector('.diff-minimap')!.getBoundingClientRect();
      const code = element.querySelector<HTMLElement>('.unified-diff-code')!;
      const inset = parseFloat(getComputedStyle(element).paddingLeft);
      return [
        pane.left - outer.left - inset,
        pane.top - outer.top - inset,
        outer.bottom - pane.bottom - inset,
        outer.right - map.right - inset - (code.offsetWidth - code.clientWidth),
        map.top - outer.top - inset,
        outer.bottom - map.bottom - inset - (code.offsetHeight - code.clientHeight)
      ];
    });
    for (const gap of gaps) expect(Math.abs(gap)).toBeLessThan(1);
    const bounds = (await minimap.boundingBox())!;
    await minimap.click({ position: { x: bounds.width / 2, y: bounds.height - 2 } });
    await expect.poll(() => code.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath(`diff-inset-minimap-${width}.png`) });
  }
});

for (const theme of ['light', 'dark']) {
  test(`Text selections stand out above same-word matches and the current line in ${theme} theme`, async ({
    page
  }, testInfo) => {
    await page.goto(`${fixture.url}file-editor-layout.html?text=code&draft=1&theme=${theme}`);
    const content = page.locator('.cm-content');
    await expect(content).toBeVisible();
    await page.getByRole('button', { name: 'Edit file', exact: true }).click();
    await content.fill('const example = 1;\nconsole.log(example);\nexample;');
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await content
        .locator('.cm-line')
        .last()
        .dblclick({ position: { x: 22, y: 8 } });
      await expect
        .poll(() => page.evaluate(() => window.getSelection()?.toString()))
        .toBe('example');
      await expect(page.locator('.cm-selectionMatch')).toHaveCount(2);
      await expect(page.locator('.cm-selectionBackground').first()).toBeVisible();
      await expect(page.locator('.cm-activeLine')).toBeVisible();
      const hierarchy = await page.locator('.code-file-editor').evaluate((editor) => {
        const selection = editor.querySelector('.cm-selectionBackground')!;
        const line = editor.querySelector('.cm-activeLine')!;
        const match = editor.querySelector('.cm-selectionMatch')!;
        const background = getComputedStyle(editor.querySelector('.cm-editor')!).backgroundColor;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!;
        const luminance = (colors: string[]) => {
          context.clearRect(0, 0, 1, 1);
          for (const color of colors) {
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
          }
          const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
        };
        const lineBackground = getComputedStyle(line).backgroundColor;
        const base = luminance([background, lineBackground]);
        const contrast = (value: number) =>
          (Math.max(base, value) + 0.05) / (Math.min(base, value) + 0.05);
        return {
          selection: contrast(
            luminance([background, getComputedStyle(selection).backgroundColor, lineBackground])
          ),
          match: contrast(luminance([background, getComputedStyle(match).backgroundColor])),
          matchColor: getComputedStyle(match).color,
          textColor: getComputedStyle(editor.querySelector('.cm-content')!).color,
          matchOutline: getComputedStyle(match).outlineStyle
        };
      });
      expect(hierarchy.selection).toBeGreaterThan(1.5);
      expect(hierarchy.match).toBeLessThan(hierarchy.selection);
      expect(hierarchy.matchColor).toBe(hierarchy.textColor);
      expect(hierarchy.matchOutline).toBe('solid');
      await page.screenshot({
        path: testInfo.outputPath(`editor-highlights-${theme}-${width}.png`)
      });
    }
    const selection = page.locator('.cm-selectionBackground').first();
    const before = await selection.evaluate((element) => getComputedStyle(element).backgroundColor);
    await page
      .locator('html')
      .evaluate((element) => element.style.setProperty('--mar-color-brand', '#805ad5'));
    await expect
      .poll(() => selection.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(before);
  });

  test(`File toolbars share button shapes and states across viewports in ${theme} theme`, async ({
    browser,
    browserName
  }, testInfo) => {
    for (const mode of ['text=code&draft=1', 'diff=HISTORY&shortcuts=1', 'image=small']) {
      let desktopStyle: unknown;
      for (const width of [1280, 390]) {
        const context = await browser.newContext({
          viewport: { width, height: 844 },
          ...(browserName === 'chromium' ? { isMobile: width < 768 } : {}),
          hasTouch: width < 768
        });
        try {
          const page = await context.newPage();
          await page.goto(`${fixture.url}file-editor-layout.html?${mode}&theme=${theme}`);
          const toolbar = page.locator(
            width === 390
              ? '.workspace-file-mobile-actions'
              : mode.startsWith('diff')
                ? '.diff-preview-toolbar'
                : '.file-preview-desktop-actions'
          );
          const find = toolbar.getByRole('button', {
            name: mode.startsWith('text')
              ? 'Find in file'
              : mode.startsWith('diff')
                ? 'Previous change'
                : 'Download file',
            exact: true
          });
          await expect(find).toBeVisible();
          await expect(toolbar.locator('[data-mar-icon="more"]')).toHaveCount(0);
          const header = page.locator('.workspace-file-page-frame-header');
          const frameContent = page.locator('.workspace-file-page-frame-content');
          for (const side of ['top', 'right', 'bottom', 'left']) {
            await expect(frameContent).toHaveCSS(`padding-${side}`, '0px');
          }
          if (mode.startsWith('diff')) {
            const content = page.locator('.unified-diff-content');
            const inset = await page.evaluate(() =>
              window.innerWidth < 768
                ? 0
                : 0.5 * parseFloat(getComputedStyle(document.documentElement).fontSize)
            );
            for (const side of ['top', 'right', 'bottom', 'left']) {
              await expect(content).toHaveCSS(`padding-${side}`, `${inset}px`);
            }
          }
          const metadata = header.locator('.mar-file-preview-eyebrow');
          await expect(metadata).toBeVisible();
          // Measure in one frame so the preview's entrance transition cannot skew the comparison.
          const alignment = await header.evaluate(
            (element, button) => {
              const metadataBox = element
                .querySelector('.mar-file-preview-eyebrow')!
                .getBoundingClientRect();
              const buttonBox = button!.getBoundingClientRect();
              const headerBox = element.getBoundingClientRect();
              const pathBox = element
                .querySelector('.workspace-file-page-frame-title > small')
                ?.getBoundingClientRect();
              return {
                offset: Math.abs(
                  metadataBox.y + metadataBox.height / 2 - (buttonBox.y + buttonBox.height / 2)
                ),
                pathRight: pathBox?.right,
                left: metadataBox.left,
                top: metadataBox.top,
                bottom: metadataBox.bottom,
                headerTop: headerBox.top,
                headerBottom: headerBox.bottom
              };
            },
            await find.elementHandle()
          );
          if (width === 1280) {
            expect(alignment.offset).toBeLessThan(1);
            if (alignment.pathRight !== undefined) {
              expect(alignment.pathRight).toBeLessThan(alignment.left);
            }
          } else {
            expect(alignment.top).toBeGreaterThanOrEqual(alignment.headerTop);
            expect(alignment.bottom).toBeLessThanOrEqual(alignment.headerBottom);
          }
          const radius = await find.evaluate((element) =>
            getComputedStyle(element).getPropertyValue('--mar-radius-control').trim()
          );
          await expect(find).toHaveCSS('border-radius', radius);
          const normal = await find.evaluate((element) => {
            const css = getComputedStyle(element);
            return { color: css.color, background: css.backgroundColor, border: css.borderColor };
          });
          let saveStates: unknown;
          const tokens = await find.evaluate((element) => {
            const probe = document.createElement('span');
            element.append(probe);
            const color = (token: string) => {
              probe.style.color = `var(${token})`;
              return getComputedStyle(probe).color;
            };
            const result = {
              background: color('--mar-bg-panel'),
              border: color('--mar-border-default'),
              hoverBackground: color('--mar-fill-hover'),
              hoverBorder: color('--mar-border-medium'),
              hoverText: color('--mar-text-primary'),
              pressedBackground: color('--mar-fill-selection'),
              focus: color('--mar-color-brand'),
              disabledBorder: color('--mar-border-subtle')
            };
            probe.remove();
            return result;
          });
          for (const button of await toolbar.locator('.el-button:visible').all()) {
            await expect(button).toHaveCSS('background-color', tokens.background);
            await expect(button).toHaveCSS(
              'border-color',
              (await button.isDisabled()) ? tokens.disabledBorder : tokens.border
            );
            if (!(await button.isDisabled())) {
              await button.hover();
              await expect(button).toHaveCSS('background-color', tokens.hoverBackground);
              await expect(button).toHaveCSS('border-color', tokens.hoverBorder);
              await expect(button).toHaveCSS('color', tokens.hoverText);
              await page.mouse.move(0, 0);
            }
          }
          if (mode.startsWith('text')) {
            await toolbar.getByRole('button', { name: 'Edit file', exact: true }).click();
            const save = toolbar.getByRole('button', { name: 'Save', exact: true });
            await expect(save).toBeEnabled();
            await expect(save).toHaveCSS('border-radius', radius);
            await page.mouse.move(0, 0);
            await expect(save).toHaveCSS('background-color', tokens.background);
            await toolbar.screenshot({
              path: testInfo.outputPath(`file-tools-${theme}-${width}-normal.png`)
            });
            await save.hover();
            await expect(save).toHaveCSS('background-color', tokens.hoverBackground);
            await expect(save).toHaveCSS('border-color', tokens.hoverBorder);
            await expect(save).toHaveCSS('color', tokens.hoverText);
            await toolbar.screenshot({
              path: testInfo.outputPath(`file-tools-${theme}-${width}-hover.png`)
            });
            if (width === 1280)
              await page.screenshot({ path: testInfo.outputPath(`file-editor-${theme}.png`) });
            await save.focus();
            await page.keyboard.press('Tab');
            await page.keyboard.press('Shift+Tab');
            await expect(save).toBeFocused();
            await expect(save).toHaveCSS('outline-color', tokens.focus);
            await expect(save).toHaveCSS('outline-width', '2px');
            const enabled = await save.evaluate(
              (element) => getComputedStyle(element).backgroundColor
            );
            await page.keyboard.down('Space');
            try {
              // Gecko activates on keyup without exposing :active while Space is held.
              const active = await save.evaluate((element) => element.matches(':active'));
              await expect(save).toHaveCSS(
                'background-color',
                active ? tokens.pressedBackground : enabled
              );
              await expect(save).toHaveCSS('color', tokens.hoverText);
            } finally {
              await page.keyboard.up('Space');
            }
            await expect(save).toBeDisabled();
            await expect(save).toHaveCSS('background-color', tokens.background);
            await expect(save).toHaveCSS('border-color', tokens.disabledBorder);
            await page.mouse.move(0, 0);
            await toolbar.screenshot({
              path: testInfo.outputPath(`file-tools-${theme}-${width}-disabled.png`)
            });
            saveStates = {
              enabled,
              disabled: await save.evaluate(async (element) => {
                await Promise.all(element.getAnimations().map((animation) => animation.finished));
                return getComputedStyle(element).backgroundColor;
              })
            };
          }
          if (mode.startsWith('diff')) {
            await page.getByRole('button', { name: 'Find preview content', exact: true }).click();
            const search = page.locator('.inline-find-bar');
            await expect(search).toBeVisible();
            await expect(search.getByRole('button', { name: 'Previous match' })).toBeDisabled();
            await search.getByPlaceholder('Find', { exact: true }).fill('new');
            await expect(search.getByRole('button', { name: 'Next match' })).toBeEnabled();
            const rowHoverBackground = await search.evaluate((element) => {
              const probe = document.createElement('span');
              probe.style.color = 'var(--mar-fill-row-hover)';
              element.append(probe);
              const color = getComputedStyle(probe).color;
              probe.remove();
              return color;
            });
            const searchButtons = await search.locator('.el-button').all();
            for (const [index, button] of searchButtons.entries()) {
              await button.hover();
              await expect(button).toHaveCSS('color', tokens.hoverText);
              await expect(button).toHaveCSS('background-color', rowHoverBackground);
              await expect(button).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)');
              await search.getByRole('textbox').focus();
              for (let step = 0; step <= index; step += 1) await page.keyboard.press('Tab');
              await expect(button).toBeFocused();
              await expect(button).toHaveCSS('outline-width', '2px');
            }
            await page.screenshot({
              path: testInfo.outputPath(`diff-tools-${theme}-${width}.png`)
            });
            await search.getByRole('button', { name: 'Close find' }).click();
            await expect(search).toHaveCount(0);
          }
          if (width === 1280) desktopStyle = { normal, saveStates };
          else {
            expect({ normal, saveStates }).toEqual(desktopStyle);
            await expect(find).toHaveCSS('width', '36px');
            await expect(find).toHaveCSS('height', '36px');
            await page.screenshot({
              path: testInfo.outputPath(`toolbar-${theme}-${mode.split('=')[0]}.png`)
            });
            const toggle = toolbar.locator('.workspace-file-mobile-actions-toggle');
            await expect(toggle).toHaveCSS('border-radius', radius);
            await toggle.click();
            await expect(toggle).toHaveAttribute('aria-expanded', 'false');
            await expect(toolbar.locator('.workspace-file-mobile-actions-body')).toHaveAttribute(
              'inert',
              ''
            );
            await toggle.click();
            await expect(toggle).toHaveAttribute('aria-expanded', 'true');
            // Enter keyboard navigation before collapsing the other in-document tab stops.
            await toggle.focus();
            await page.keyboard.press('Shift+Tab');
            await expect(toggle).not.toBeFocused();
            await page.keyboard.press('Tab');
            await expect(toggle).toBeFocused();
            await expect(toggle).toHaveCSS('border-radius', radius);
            await expect(toggle).toHaveCSS('outline-style', 'solid');
            await expect(toggle).toHaveCSS('outline-width', '2px');
            await page.keyboard.press('Enter');
            await expect(toggle).toHaveAttribute('aria-expanded', 'false');
            await expect(toolbar.locator('.workspace-file-mobile-actions-body')).toHaveAttribute(
              'inert',
              ''
            );
            await expect(toggle).toHaveCSS('outline-style', 'solid');
            await expect(toggle).toHaveCSS('outline-width', '2px');
            await page.keyboard.press('Enter');
            await expect(toggle).toHaveAttribute('aria-expanded', 'true');
            await expect(find).toBeVisible();
          }
        } finally {
          await context.close();
        }
      }
    }
  });
}

for (const [notice, message, width] of [
  [
    'LIMITED',
    'The symbol index has reached its size limit. Navigation results may be incomplete.',
    1280
  ],
  ['UNAVAILABLE', 'Symbol indexing is unavailable on this Node.', 390]
] as const) {
  test(`Code navigation ${notice} notices are local and dismissible`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(
      `${fixture.url}file-editor-layout.html?text=code&draft=1&navigationNotice=${notice}${notice === 'LIMITED' ? '&navigationCandidate=1' : ''}`
    );
    const editor = page.locator('.cm-content');
    await expect(editor).toHaveText('Recovered unsaved content');
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    const dropdown = page.locator('.file-navigation-dropdown');
    await expect(dropdown.getByRole('status')).toHaveText(message);
    await expect(
      page.getByText('No definitions or references found.', { exact: true })
    ).toHaveCount(0);
    await expect(page.locator('.el-message--error')).toHaveCount(0);
    const bounds = (await dropdown.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await dropdown.getByRole('status').click();
    await expect(dropdown).toBeVisible();
    if (notice === 'LIMITED') {
      await dropdown.getByRole('option').click();
      await expect(page.locator('html')).toHaveAttribute(
        'data-opened-navigation-target',
        'src/target.ts'
      );
      await expect(dropdown.getByRole('status')).toHaveText(message);
    }
    await page.getByRole('button', { name: 'Edit file', exact: true }).click();
    await expect(dropdown).toHaveCount(0);
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await editor.fill('Continued editing after navigation notice');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute(
      'data-saved-draft',
      JSON.stringify({
        value: 'Continued editing after navigation notice',
        revision: 'draft-revision'
      })
    );
  });
}

test('Restored drafts render immediately and preserve their original revision on save', async ({
  page
}) => {
  await page.goto(`${fixture.url}file-editor-layout.html?text=code&draft=1`);
  await expect(page.locator('html')).toHaveAttribute('data-applied-draft', 'draft-tab');
  await expect(page.locator('.cm-content')).toHaveText('Recovered unsaved content');
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await page.getByRole('button', { name: 'Edit file', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute(
    'data-saved-draft',
    JSON.stringify({ value: 'Recovered unsaved content', revision: 'draft-revision' })
  );
});

test('Fallback draft selection and Diff find remain scoped to the visible preview', async ({
  page
}) => {
  await page.goto(`${fixture.url}file-editor-layout.html?text=fallback&draft=1&shortcuts=1`);
  const text = page.locator('.file-text-preview');
  await expect(text).toHaveValue('Recovered unsaved content');
  await text.focus();
  await page.getByRole('button', { name: 'Select preview content' }).click();
  expect(
    await text.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      return input.value.slice(input.selectionStart, input.selectionEnd);
    })
  ).toBe('Recovered unsaved content');
  await page.getByRole('button', { name: 'Find in file', exact: true }).click();
  await expect(page.locator('.inline-find-bar')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.url}file-editor-layout.html?diff=HISTORY&shortcuts=1`);
  const outside = page.getByRole('button', { name: 'Select preview content' });
  await outside.focus();
  await page.keyboard.press('ArrowRight');
  expect(await page.locator('html').getAttribute('data-moved-file')).toBeNull();
  await expect(page.locator('.inline-find-bar')).toHaveCount(0);
  await page.locator('.workspace-file-page-frame').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('html')).toHaveAttribute('data-moved-file', '1');
  await page.getByRole('button', { name: 'Find in file', exact: true }).click();
  await expect(page.locator('.inline-find-bar')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.inline-find-bar')).toHaveCount(0);
  await page.getByRole('button', { name: 'Select preview content' }).click();
  const selected = await page.evaluate(() => window.getSelection()?.toString());
  expect(selected).toContain('+new');
  expect(selected).not.toContain('Select preview content');
  await page.goto(`${fixture.url}file-editor-layout.html?diff=HISTORY&inactive=1&shortcuts=1`);
  await page
    .locator('.workspace-file-page-frame')
    .dispatchEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
  expect(await page.locator('html').getAttribute('data-moved-file')).toBeNull();
  await expect(page.locator('.inline-find-bar')).toHaveCount(0);
});

test('Git Diff retry uses a neutral action in both themes and viewports', async ({ page }) => {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.goto(
        `${fixture.url}file-editor-layout.html?diff=HISTORY&load-failed=1&theme=${theme}`
      );
      await page.mouse.move(0, 0);
      const retry = page.locator('.file-preview-state').getByRole('button', { name: 'Retry' });
      await expect(retry).not.toHaveClass(/is-link|is-text|el-button--(?:primary|danger)/);
      await expect(retry).toHaveCSS('border-top-width', '1px');
      await expect(retry).toHaveCSS('border-top-style', 'solid');
      const color = await retry.evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--el-text-color-regular)';
        element.append(probe);
        const action = getComputedStyle(probe).color;
        probe.style.color = 'var(--el-button-bg-color)';
        const background = getComputedStyle(probe).color;
        probe.style.color = 'var(--el-button-border-color)';
        const border = getComputedStyle(probe).color;
        probe.style.color = 'var(--mar-text-secondary)';
        const message = getComputedStyle(probe).color;
        probe.remove();
        return { action, background, border, message };
      });
      await expect(retry).toHaveCSS('color', color.action);
      await expect(retry).toHaveCSS('background-color', color.background);
      await expect(retry).toHaveCSS('border-top-color', color.border);
      await expect(page.locator('.file-preview-state p')).toHaveCSS('color', color.message);
      await retry.click();
      await expect(page.locator('html')).toHaveAttribute('data-diff-retries', '1');
      await expect(page.locator('.file-preview-state p')).toBeVisible();
    }
  }
});

test('Unified Diff keeps only its responsive content inset without an outer frame', async ({
  page
}, testInfo) => {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const source of ['HISTORY', 'TOOL_CHANGE']) {
      await page.goto(`${fixture.url}file-editor-layout.html?diff=${source}`);
      const diff = page.locator('.unified-history-diff');
      await expect(diff).toBeVisible();
      await expect(diff).toHaveCSS('margin', '0px');
      await expect(diff).toHaveCSS('box-shadow', 'none');
      await expect(diff).toHaveCSS('padding-left', '0px');
      await expect(diff).toHaveCSS('padding-right', '0px');
      const bounds = await diff.evaluate((element) => {
        const content = element.parentElement!.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        return [rect.left - content.left, rect.top - content.top, content.right - rect.right];
      });
      const expectedInset = await page.evaluate(() =>
        window.innerWidth < 768
          ? 0
          : 0.5 * parseFloat(getComputedStyle(document.documentElement).fontSize)
      );
      for (const inset of bounds) expect(Math.abs(inset - expectedInset)).toBeLessThan(1);
      await expect(diff.getByText('+new', { exact: true })).toHaveClass('is-added');
      await expect(diff.getByText('-old', { exact: true })).toHaveClass('is-deleted');
      await page.screenshot({ path: testInfo.outputPath(`diff-${source}-${width}.png`) });
    }
  }
});

test('Text editors and large-file previews have no outer inset', async ({ page }) => {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const mode of ['code', 'fallback']) {
      await page.goto(`${fixture.url}file-editor-layout.html?text=${mode}`);
      const content = page.locator('.mar-file-preview-content');
      const editor = page.locator(mode === 'code' ? '.code-file-editor' : '.file-text-preview');
      await expect(editor).toBeVisible();
      await expect(content).toHaveCSS('padding', '0px');
      const bounds = await editor.evaluate((element) => {
        const parent = element.parentElement!;
        const contentRect = parent.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left - contentRect.left,
          top: rect.top - contentRect.top,
          right: contentRect.right - rect.right,
          overflow: parent.scrollHeight - parent.clientHeight
        };
      });
      for (const inset of Object.values(bounds)) expect(Math.abs(inset)).toBeLessThan(1);
      if (mode === 'fallback') {
        await expect(editor).toHaveValue('Original content');
        await expect(content.locator('.mar-empty')).toBeVisible();
      }
    }
  }
});

test('Long Diff and fallback text scroll inside the preview without moving the header', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const mode of ['diff=TOOL_CHANGE', 'text=fallback']) {
    await page.goto(`${fixture.url}file-editor-layout.html?${mode}&long=1`);
    const scroller = page.locator('.unified-history-diff, .file-text-preview');
    await expect(scroller).toBeVisible();
    const header = page.locator('.workspace-file-page-frame-header');
    const before = await header.boundingBox();
    const scroll = await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return { top: element.scrollTop, height: element.clientHeight };
    });
    expect(scroll.top).toBeGreaterThan(0);
    expect(scroll.height).toBeGreaterThan(100);
    expect(await header.boundingBox()).toEqual(before);
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - innerWidth,
      y: document.documentElement.scrollHeight - innerHeight
    }));
    expect(overflow).toEqual({ x: 0, y: 0 });
    if (mode === 'text=fallback') {
      const notice = page.locator('.mar-file-preview-content > .mar-empty');
      await expect(notice).toBeInViewport();
    }
  }
});
