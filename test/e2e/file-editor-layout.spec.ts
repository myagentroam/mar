import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
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
