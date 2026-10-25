import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

async function captureScreenshot(page: Page, name: string): Promise<void> {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const directory = resolve(process.cwd(), 'test/runs', runId);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, name), fullPage: true, animations: 'disabled' });
}

for (const width of [1280, 390]) {
  test(`File tabs preserve keyboard navigation and bounded loading at ${width}px`, async ({
    page
  }) => {
    const fixture = await startCustomThemeFixture();
    try {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${fixture.url}file-tabs.html`);
      const tabs = page.getByRole('tab');
      await expect(tabs).toHaveCount(12);
      await page.locator('html').evaluate((element) => {
        element.style.setProperty('--mar-text-primary', '#d6dfc9');
        element.style.setProperty('--mar-color-brand-text', '#af79d0');
      });
      for (const close of [
        page.locator('.workspace-file-tab-close').first(),
        page.locator('.workspace-file-window-close')
      ]) {
        await close.hover();
        await expect(close).toHaveCSS('color', 'rgb(214, 223, 201)');
        await expect(close).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await close.focus();
        await expect(close).toHaveCSS('outline-style', 'solid');
        await expect(close).toHaveCSS('outline-width', '2px');
      }
      await expect(tabs.nth(0)).toHaveAttribute('tabindex', '0');
      await expect(tabs.nth(1)).toHaveAttribute('tabindex', '-1');
      await tabs.nth(0).focus();
      await page.keyboard.press('ArrowLeft');
      await expect(tabs.nth(11)).toBeFocused();
      await expect(tabs.nth(11)).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Home');
      await expect(tabs.nth(0)).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(tabs.nth(1)).toBeFocused();
      await page.keyboard.press('End');
      await expect(tabs.nth(11)).toBeFocused();
      const list = page.getByRole('tablist');
      expect(await list.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      expect((await tabs.nth(11).boundingBox())!.width).toBeGreaterThan(60);
      const frame = page.locator('.workspace-file-page-frame:visible');
      await expect(frame).toHaveAttribute('aria-busy', 'true');
      const content = frame.locator('.workspace-file-page-frame-content');
      const status = frame.getByRole('status');
      await expect(status).toBeVisible();
      const region = (await content.boundingBox())!;
      const overlay = (await status.boundingBox())!;
      expect(overlay.y).toBeGreaterThanOrEqual(region.y - 1);
      expect(overlay.y + overlay.height).toBeLessThanOrEqual(region.y + region.height + 1);
      expect(region.height).toBeGreaterThan(500);
      await expect(page.locator('html')).not.toHaveClass(/file-preview-open/);
      await expect(page.locator('body')).not.toHaveClass(/file-preview-open/);
      if (width === 1280) {
        await frame.getByRole('button', { name: 'Finish loading' }).click();
        await expect(status).toHaveCount(0);
        await expect(frame).not.toHaveAttribute('aria-busy', 'true');
      }
      await page.locator('.workspace-file-window-close').click();
      await expect(page.getByText('Files closed')).toBeVisible();
      await expect(page.locator('html')).not.toHaveClass(/file-preview-open/);
      await expect(page.locator('body')).not.toHaveClass(/file-preview-open/);
    } finally {
      await fixture.close();
    }
  });
}

for (const [kind, label] of [
  ['WORKTREE_DIFF', 'Git Diff'],
  ['HISTORY_DIFF', 'Git Diff'],
  ['TOOL_CHANGE_DIFF', 'This change']
] as const) {
  test(`File preview keeps the source-aware modal name for ${kind}`, async ({ page }) => {
    const fixture = await startCustomThemeFixture();
    try {
      await page.goto(`${fixture.url}file-tabs.html?kind=${kind}`);
      await expect(
        page.getByRole('dialog', { name: `/workspace/file-1.txt ${label}`, exact: true })
      ).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(1);
      await page.mouse.click(8, 8);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByText('Files closed')).toBeVisible();
    } finally {
      await fixture.close();
    }
  });
}

for (const width of [1280, 390]) {
  test(`Git Diff keeps focus through repeated file navigation at ${width}px`, async ({ page }) => {
    const fixture = await startCustomThemeFixture();
    try {
      await page.setViewportSize({ width, height: 800 });
      const paths = ['src/first.ts', 'src/second.ts', 'src/third.ts'] as const;
      await page.route('**/api/workspaces/workspace/changes?*', (route) =>
        route.fulfill({
          json: {
            repositories: [
              {
                repositoryPath: '',
                repositoryName: 'project',
                source: 'ROOT',
                changes: paths.map((path) => ({
                  path,
                  state: 'UNSTAGED',
                  change: 'MODIFIED',
                  diffAvailable: true
                }))
              }
            ]
          }
        })
      );
      await page.route('**/api/workspaces/workspace/changes/diff?*', (route) => {
        const path = new URL(route.request().url()).searchParams.get('path');
        return route.fulfill({
          json: { diff: { binary: false, text: `@@ -1 +1 @@\n-before\n+${path}` } }
        });
      });
      await page.goto(`${fixture.url}file-tabs.html?diff-navigation=1`);
      await page.getByRole('tab', { name: 'Git Changes', exact: true }).click();
      await page.getByRole('button', { name: 'View diff for src/first.ts', exact: true }).click();
      const frame = page.locator('.workspace-file-page-frame:visible');
      await expect(frame.locator('.unified-history-diff')).toContainText('src/first.ts');
      await captureScreenshot(page, `file-preview-diff-${width}.png`);
      const content = frame.locator('.unified-diff-content');
      for (const panel of ['#171e28', '#ffffff', '#263b32']) {
        await page.locator('html').evaluate((element, color) => {
          element.style.setProperty('--mar-bg-panel', color);
        }, panel);
        const background = await frame
          .locator('.unified-history-diff')
          .evaluate((element) => getComputedStyle(element).backgroundColor);
        await expect(content).toHaveCSS('background-color', background);
      }
      await page.locator('html').evaluate((element) => {
        element.style.removeProperty('--mar-bg-panel');
      });
      await frame.focus();
      for (const [key, path] of [
        ['ArrowRight', paths[1]],
        ['ArrowRight', paths[2]],
        ['ArrowRight', paths[0]],
        ['ArrowLeft', paths[2]],
        ['ArrowLeft', paths[1]],
        ['ArrowLeft', paths[0]]
      ] as const) {
        await page.keyboard.press(key);
        await expect(frame.locator('.unified-history-diff')).toContainText(path);
        await expect(frame).toBeFocused();
      }
      await frame.getByRole('button', { name: 'Next file', exact: true }).click();
      await expect(frame.locator('.unified-history-diff')).toContainText(paths[1]);
      await page.keyboard.press('ArrowRight');
      await expect(frame.locator('.unified-history-diff')).toContainText(paths[2]);
      await page.keyboard.press('Control+f');
      const findInput = frame.locator('.inline-find-bar input');
      await findInput.fill('before');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowRight');
      await expect(findInput).toBeFocused();
      await expect(frame.locator('.unified-history-diff')).toContainText(paths[2]);
      await page.keyboard.press('Escape');
      await expect(frame).toBeFocused();
      await page.keyboard.press('ArrowLeft');
      await expect(frame.locator('.unified-history-diff')).toContainText(paths[1]);
      const tabs = page.getByRole('tablist', { name: 'File preview tabs' }).getByRole('tab');
      await tabs.first().click();
      await expect(tabs.first()).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(tabs.nth(1)).toBeFocused();
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    } finally {
      await fixture.close();
    }
  });
}

for (const kind of ['worktree', 'history']) {
  test(`Git format preview restores actual focus when reopening ${kind}`, async ({ page }) => {
    const fixture = await startCustomThemeFixture('test/e2e/support/file-tabs.html');
    try {
      await page.route('**/api/workspaces/workspace/**/content?*', (route) =>
        route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="2000"><rect width="1200" height="2000" fill="navy"/></svg>'
        })
      );
      await page.goto(`${fixture.url}file-tabs.html?format-focus=${kind}`);
      const source = page.locator('#git-format-source');
      const frame = page.locator('.workspace-file-page-frame:visible');
      await source.click();
      await expect(source).toHaveAttribute('data-completed-opens', '1');
      await expect(frame).toBeFocused();
      await expect(frame.locator('img')).toBeVisible();
      await expect
        .poll(() => frame.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
        .toBe(1200);
      const originalFrame = await frame.elementHandle();
      const tabs = page.getByRole('tablist', { name: 'File preview tabs' }).getByRole('tab');
      await expect(tabs).toHaveCount(1);
      const originalTab = await tabs.first().elementHandle();
      await source.focus();
      await expect(source).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(source).toHaveAttribute('data-completed-opens', '2');
      await expect(frame).toBeFocused();
      await expect(tabs).toHaveCount(1);
      await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
      expect(
        await tabs.first().evaluate((element, original) => element === original, originalTab)
      ).toBe(true);
      expect(await frame.evaluate((element, original) => element === original, originalFrame)).toBe(
        true
      );
      await expect(frame.locator('img')).toBeVisible();
      await page.keyboard.press('Alt+w');
      await expect(frame).toHaveCount(0);
    } finally {
      await fixture.close();
    }
  });
}

test('File preview overlay stays bounded, modal, and stable across viewport changes', async ({
  page
}) => {
  const fixture = await startCustomThemeFixture();
  try {
    await page.setViewportSize({ width: 1920, height: 1200 });
    await page.goto(`${fixture.url}file-tabs.html`);
    const surface = page.locator('.file-preview-surface.el-dialog');
    const dialog = page.getByRole('dialog');
    const tabs = page.getByRole('tab');
    await expect(surface).toBeVisible();
    await expect(dialog).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'File preview tabs' })).toBeVisible();
    await expect(page.locator('.workspace-file-tabs')).not.toHaveAttribute('role', 'dialog');
    await expect(page.locator('html')).not.toHaveClass(/file-preview-open/);
    await expect(page.locator('body')).not.toHaveClass(/file-preview-open/);

    const expectBounds = async (expected: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) => {
      await expect
        .poll(async () => {
          const bounds = await surface.boundingBox();
          return bounds === null
            ? null
            : {
                x: Math.round(bounds.x),
                y: Math.round(bounds.y),
                width: Math.round(bounds.width),
                height: Math.round(bounds.height)
              };
        })
        .toEqual(expected);
    };
    const expectFlushChrome = async () => {
      await expect
        .poll(() =>
          surface.evaluate((element) => {
            const outer = element.getBoundingClientRect();
            const inner = element.querySelector('.workspace-file-tabs')!.getBoundingClientRect();
            const style = getComputedStyle(element);
            return [
              inner.left - outer.left - parseFloat(style.borderLeftWidth),
              inner.top - outer.top - parseFloat(style.borderTopWidth),
              outer.right - inner.right - parseFloat(style.borderRightWidth),
              outer.bottom - inner.bottom - parseFloat(style.borderBottomWidth)
            ].map(Math.round);
          })
        )
        .toEqual([0, 0, 0, 0]);
      const content = page.locator('.workspace-file-page-frame-content:visible');
      for (const side of ['top', 'right', 'bottom', 'left']) {
        await expect(content).toHaveCSS(`padding-${side}`, '0px');
      }
    };

    await expectBounds({ x: 240, y: 120, width: 1440, height: 960 });
    await expectFlushChrome();
    await captureScreenshot(page, 'file-preview-overlay-1920x1200.png');
    await page.getByRole('button', { name: 'Finish loading', exact: true }).click();
    await page.getByText('Content of Long project file-1.txt', { exact: true }).click();
    await expect(surface).toBeVisible();
    await page.mouse.move(300, 300);
    await page.mouse.down();
    await page.mouse.move(12, 12);
    await page.mouse.up();
    await expect(surface).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.dataset.fileTabsCloseAllowed = 'false';
    });
    await page.mouse.click(12, 12);
    await expect(surface).toBeVisible();
    await expect(tabs).toHaveCount(12);
    await page.evaluate(() => {
      document.documentElement.dataset.fileTabsCloseAllowed = 'true';
    });
    await page.mouse.click(12, 12);
    await expect(surface).toHaveCount(0);
    await expect(page.getByText('Files closed')).toBeVisible();
    await page.getByRole('button', { name: 'Reopen file previews' }).click();
    await expect(surface).toBeVisible();
    await expect(tabs).toHaveCount(12);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expectBounds({ x: 16, y: 16, width: 1248, height: 768 });
    await expectFlushChrome();
    await expect(tabs).toHaveCount(12);
    await captureScreenshot(page, 'file-preview-overlay-1280x800.png');
    await page.setViewportSize({ width: 390, height: 844 });
    await expectBounds({ x: 0, y: 0, width: 390, height: 844 });
    await expectFlushChrome();
    await expect(tabs).toHaveCount(12);
    await captureScreenshot(page, 'file-preview-overlay-390x844.png');

    await tabs.first().focus();
    for (let index = 0; index < 30; index += 1) {
      await page.keyboard.press('Tab');
      expect(await surface.evaluate((element) => element.contains(document.activeElement))).toBe(
        true
      );
    }
    for (let index = 0; index < 30; index += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(await surface.evaluate((element) => element.contains(document.activeElement))).toBe(
        true
      );
    }

    await page.evaluate(() => {
      document.documentElement.dataset.fileTabsCloseAllowed = 'false';
    });
    await page.keyboard.press('Alt+w');
    await expect(tabs).toHaveCount(12);
    await expect(surface).toBeVisible();

    await page.evaluate(() => {
      document.documentElement.dataset.fileTabsCloseAllowed = 'true';
    });
    await page.keyboard.press('Alt+w');
    await expect(tabs).toHaveCount(11);
    await expect(surface).toBeVisible();

    await page.evaluate(() => {
      document.documentElement.dataset.fileTabsCloseAllowed = 'false';
    });
    await page.keyboard.press('Escape');
    await expect(surface).toBeVisible();
    await expect(tabs).toHaveCount(11);

    await page.evaluate(() => {
      document.documentElement.dataset.fileTabsCloseAllowed = 'true';
    });
    await page.keyboard.press('Escape');
    await expect(page.getByText('Files closed')).toBeVisible();
    await expect(surface).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveClass(/file-preview-open/);
    await expect(page.locator('body')).not.toHaveClass(/file-preview-open/);
  } finally {
    await fixture.close();
  }
});

test('Window presentation remains full-screen without a Dialog', async ({ page }) => {
  const fixture = await startCustomThemeFixture();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${fixture.url}file-tabs.html?presentation=window`);
    const windowSurface = page.locator('.workspace-file-tabs');
    await expect(windowSurface).toHaveAttribute('role', 'region');
    await expect(page.locator('.el-overlay-dialog')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('html')).toHaveClass(/file-preview-open/);
    await expect(page.locator('body')).toHaveClass(/file-preview-open/);

    const expectWindowBounds = async (width: number, height: number) => {
      const bounds = await windowSurface.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeCloseTo(0, 0);
      expect(bounds!.y).toBeCloseTo(0, 0);
      expect(bounds!.width).toBeCloseTo(width, 0);
      expect(bounds!.height).toBeCloseTo(height, 0);
    };
    await expectWindowBounds(1280, 800);
    await captureScreenshot(page, 'file-preview-window-1280x800.png');
    await page.setViewportSize({ width: 390, height: 844 });
    await expectWindowBounds(390, 844);
    await expect(page.getByRole('tab')).toHaveCount(12);

    await page.keyboard.press('Escape');
    await expect(page.getByText('Files closed')).toBeVisible();
    await expect(windowSurface).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveClass(/file-preview-open/);
    await expect(page.locator('body')).not.toHaveClass(/file-preview-open/);
  } finally {
    await fixture.close();
  }
});

test('Mobile Back closes one preview layer and restores its history state', async ({ page }) => {
  const fixture = await startCustomThemeFixture();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${fixture.url}file-tabs.html`);
    const baseState = await page.locator('html').getAttribute('data-file-tabs-base-history-state');
    const baseHistoryLength = Number(
      await page.locator('html').getAttribute('data-file-tabs-base-history-length')
    );
    const expectOneLayer = async () => {
      await expect
        .poll(() =>
          page.evaluate(() =>
            Object.hasOwn(
              (window.history.state as Record<string, unknown> | null) ?? {},
              '__marTemporaryLayer'
            )
          )
        )
        .toBe(true);
      expect(await page.evaluate(() => window.history.length)).toBe(baseHistoryLength + 1);
    };
    const expectRestoredHistory = async () => {
      await expect
        .poll(() => page.evaluate(() => JSON.stringify(window.history.state ?? null)))
        .toBe(baseState);
      expect(
        await page.evaluate(() =>
          Object.hasOwn(
            (window.history.state as Record<string, unknown> | null) ?? {},
            '__marTemporaryLayer'
          )
        )
      ).toBe(false);
    };

    await expect(page.getByRole('dialog')).toBeVisible();
    await expectOneLayer();
    await page.evaluate(() => window.history.back());
    await expect(page.getByText('Files closed')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectRestoredHistory();

    await page.getByRole('button', { name: 'Reopen file previews' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(12);
    await expectOneLayer();
    await page.evaluate(() => window.history.back());
    await expect(page.getByText('Files closed')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectRestoredHistory();
  } finally {
    await fixture.close();
  }
});
