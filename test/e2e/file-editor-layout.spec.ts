import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
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

for (const theme of ['light', 'dark']) {
  test(`File toolbars share button shapes and states across viewports in ${theme} theme`, async ({
    browser
  }, testInfo) => {
    for (const mode of ['text=code&draft=1', 'diff=HISTORY&shortcuts=1', 'image=small']) {
      let desktopStyle: unknown;
      for (const width of [1280, 390]) {
        const context = await browser.newContext({
          viewport: { width, height: 844 },
          isMobile: width < 768,
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
            const enabled = await save.evaluate(
              (element) => getComputedStyle(element).backgroundColor
            );
            expect(enabled).toBe(tokens.background);
            await page.mouse.move(0, 0);
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
            await page.keyboard.down('Space');
            await expect(save).toHaveCSS('background-color', tokens.pressedBackground);
            await expect(save).toHaveCSS('color', tokens.hoverText);
            await page.keyboard.up('Space');
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
            for (const button of await search.locator('.el-button').all()) {
              await button.hover();
              await expect(button).toHaveCSS('color', tokens.hoverText);
              await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
              await expect(button).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)');
              await button.focus();
              await page.keyboard.press('Tab');
              await page.keyboard.press('Shift+Tab');
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
            await page.keyboard.press('Tab');
            await toggle.focus();
            await expect(toggle).toHaveCSS('border-radius', radius);
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

test('Unified Diff fills its content surface without an inset frame', async ({
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
      for (const inset of bounds) expect(Math.abs(inset)).toBeLessThan(1);
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
      const content = page.locator('.file-preview-content');
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
        await expect(content.locator('.empty')).toBeVisible();
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
      const notice = page.locator('.file-preview-content > .empty');
      await expect(notice).toBeInViewport();
    }
  }
});
