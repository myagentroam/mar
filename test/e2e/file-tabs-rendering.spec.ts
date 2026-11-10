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

for (const theme of ['daylight', 'vscode-dark-2026']) {
  for (const width of [1280, 390]) {
    test(`file toolbar icons replace rather than accompany loading in ${theme} at ${width}px`, async ({
      page
    }) => {
      const fixture = await startCustomThemeFixture('test/e2e/support/file-tabs.html');
      try {
        await page.setViewportSize({ width, height: 900 });
        const toolbar =
          width >= 768 ? '.file-preview-desktop-actions' : '.workspace-file-mobile-actions-body';
        for (const kind of ['text', 'video']) {
          await page.goto(`${fixture.url}file-tabs.html?toolbar-loading=${kind}&theme=${theme}`);
          await expect(page.locator(`#toolbar-${kind}`)).toBeVisible();
          const actions = page.locator(`#toolbar-${kind} ${toolbar}`);
          const download = actions.getByRole('button', { name: 'Download file', exact: true });
          const before = (await download.boundingBox())!;
          await expect(download.locator('[data-mar-icon="download"]')).toHaveCount(1);
          await download.click();
          await expect(download).toBeDisabled();
          await expect(download.locator('[data-mar-icon]')).toHaveCount(1);
          await expect(download.locator('[data-mar-icon="loading-action"]')).toBeVisible();
          const busy = (await download.boundingBox())!;
          expect(busy.width).toBeCloseTo(before.width, 1);
          expect(busy.height).toBeCloseTo(before.height, 1);
          if (kind === 'video') {
            await captureScreenshot(page, `download-loading-${theme}-${width}.png`);
          }
          await page.locator('#finish-toolbar-download').click();
          await expect(download).toBeEnabled();
          await expect(download.locator('[data-mar-icon="download"]')).toHaveCount(1);
          await expect(download.locator('[data-mar-icon="loading-action"]')).toHaveCount(0);
          if (kind === 'text') {
            const editor = page.locator('#toolbar-text .cm-content');
            if (!(await editor.isEditable())) {
              await actions.getByRole('button', { name: 'Edit file', exact: true }).click();
            }
            await editor.fill('const ready = false;');
            const save = actions.getByRole('button', { name: 'Save', exact: true });
            await save.click();
            await expect(save).toBeDisabled();
            await expect(save.locator('[data-mar-icon]')).toHaveCount(1);
            await expect(save.locator('[data-mar-icon="loading-action"]')).toBeVisible();
            await page.locator('#finish-toolbar-save').click();
            await expect(save.locator('[data-mar-icon="document-save"]')).toHaveCount(1);
            await expect(save.locator('[data-mar-icon="loading-action"]')).toHaveCount(0);
          }
        }
      } finally {
        await fixture.close();
      }
    });
  }
}

test('HTML preview waits for a pending save without handing off the editor', async ({ page }) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/file-tabs.html');
  let finishSave: (() => void) | undefined;
  try {
    await page.addInitScript(() => localStorage.setItem('mar.locale.v2', 'en-US'));
    await page.route('**/api/workspaces/workspace/files/read?*', (route) =>
      route.fulfill({
        json: {
          file: {
            encoding: 'utf-8',
            size: 13,
            content: '<h1>disk</h1>',
            nextOffset: null,
            revision: 'r1'
          }
        }
      })
    );
    await page.route('**/api/workspaces/workspace/files/write', async (route) => {
      await new Promise<void>((resolve) => {
        finishSave = resolve;
      });
      await route.fulfill({ json: { file: { revision: 'r2', size: 20 } } });
    });
    let grants = 0;
    await page.route('**/api/html-preview/grants', (route) => {
      grants += 1;
      return grants === 1
        ? route.fulfill({
            status: 404,
            json: {
              error: {
                code: 'FILE_NOT_FOUND',
                message: 'File not found.',
                details: 'Missing index.html.',
                requestId: 'preview-request',
                upstreamRequestId: 'node-request'
              }
            }
          })
        : route.fulfill({ json: { url: `${fixture.url}rendered-html` } });
    });
    await page.route('**/rendered-html', (route) =>
      route.fulfill({ contentType: 'text/html', body: 'Recovered' })
    );
    await page.goto(`${fixture.url}file-tabs.html?html-handoff`);
    await page.locator('#open-html-source').click();
    const editor = page.locator('.cm-content');
    await expect(editor).toBeVisible();
    if ((await editor.getAttribute('contenteditable')) !== 'true')
      await page.getByRole('button', { name: 'Edit file', exact: true }).first().click();
    await editor.fill('unsaved content');
    await page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await expect.poll(() => finishSave !== undefined).toBe(true);
    await page.getByRole('button', { name: 'Run HTML preview' }).first().click();
    await expect(editor).toContainText('unsaved content');
    expect(grants).toBe(0);
    finishSave?.();
    await expect(page.getByRole('button', { name: 'Save', exact: true }).first()).toBeDisabled();
    await page.getByRole('button', { name: 'Run HTML preview' }).first().click();
    await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
    await expect.poll(() => grants).toBe(1);
    const failure = page.locator('.html-browser-error');
    await expect(failure).toContainText('File not found.');
    for (const fact of ['FILE_NOT_FOUND', 'Missing index.html.', 'preview-request', 'node-request'])
      await expect(failure).toContainText(fact);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const theme of ['vscode-light-2026', 'vscode-dark-2026']) {
        await page
          .locator('html')
          .evaluate((element, value) => element.setAttribute('data-theme', value), theme);
        expect(
          await failure.evaluate((element) => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--mar-color-warning-text)';
            element.appendChild(probe);
            const matches = getComputedStyle(element).color === getComputedStyle(probe).color;
            probe.remove();
            return matches;
          })
        ).toBe(true);
        await expect(failure).toHaveCSS('border-top-width', '0px');
        await expect(failure).toHaveCSS('white-space', 'pre-wrap');
        expect(
          await failure.evaluate((element) => element.scrollWidth <= element.clientWidth)
        ).toBe(true);
      }
      await page.screenshot({
        path: test.info().outputPath(`html-preview-dark-error-${width}.png`)
      });
    }
    await page.getByRole('button', { name: 'Reload' }).click();
    await expect(
      page.frameLocator('iframe[title="index.html"]').getByText('Recovered')
    ).toBeVisible();
    await expect(failure).toHaveCount(0);
    expect(grants).toBe(2);
  } finally {
    finishSave?.();
    await fixture.close();
  }
});

test('restored unmounted drafts reject close until the user confirms', async ({ page }) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/file-tabs.html');
  let releaseRead!: () => void;
  let holdReads = false;
  const pendingRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  try {
    await page.route('**/api/workspaces/workspace/files/read?*', async (route) => {
      if (holdReads) await pendingRead;
      await route.fulfill({
        json: {
          file: { encoding: 'utf-8', size: 4, content: 'disk', nextOffset: null, revision: 'r1' }
        }
      });
    });
    await page.route('**/api/html-preview/grants', (route) =>
      route.fulfill({ json: { url: `${fixture.url}rendered-html` } })
    );
    await page.route('**/rendered-html', (route) =>
      route.fulfill({ contentType: 'text/html', body: 'saved disk' })
    );
    await page.goto(`${fixture.url}file-tabs.html?html-handoff`);
    await page.locator('#open-html-source').click();
    const editor = page.locator('.cm-content');
    await expect(editor).toBeVisible();
    if ((await editor.getAttribute('contenteditable')) !== 'true')
      await page.getByRole('button', { name: 'Edit file', exact: true }).first().click();
    await editor.fill('unsaved draft');
    await page.getByRole('button', { name: 'Run HTML preview' }).first().click();
    await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
    await page.locator('#snapshot-html-source').click();
    holdReads = true;
    await page.locator('#remount-html-source').click();
    await page.locator('#resume-html-source').click();
    await expect(page.locator('.workspace-file-tab')).toHaveCount(1);
    await page.locator('.workspace-file-tab-close').click();
    const dialog = page.getByRole('dialog', { name: 'Unsaved changes' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.workspace-file-tab')).toHaveCount(1);
    releaseRead();
    await expect(editor).toContainText('unsaved draft');
  } finally {
    releaseRead();
    await fixture.close();
  }
});

for (const width of [1280, 390]) {
  test(`HTML preview hands off and restores unsaved source at ${width}px`, async ({ page }) => {
    const fixture = await startCustomThemeFixture('test/e2e/support/file-tabs.html');
    try {
      await page.setViewportSize({ width, height: 800 });
      await page.route('**/api/workspaces/workspace/files/read?*', (route) =>
        route.fulfill({
          json: {
            file: {
              encoding: 'utf-8',
              size: 18,
              content: '<h1>disk</h1>',
              nextOffset: null,
              revision: 'r1'
            }
          }
        })
      );
      await page.route('**/api/html-preview/grants', (route) =>
        route.fulfill({
          json: { url: `${fixture.url}rendered-html` }
        })
      );
      await page.route('**/rendered-html', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<h1>saved disk</h1>' })
      );
      await page.goto(`${fixture.url}file-tabs.html?html-handoff`);
      await page.locator('#open-html-source').click();
      const editor = page.locator('.cm-content');
      await expect(editor).toBeVisible();
      if ((await editor.getAttribute('contenteditable')) !== 'true')
        await page.getByRole('button', { name: 'Edit file', exact: true }).first().click();
      await editor.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' draft');
      await expect(editor).toContainText('draft');
      await page.getByRole('button', { name: 'Run HTML preview' }).first().click();
      await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
      // Unload protection belongs to the page controller and is covered by its composition tests.
      await expect(
        page.frameLocator('iframe[title="index.html"]').getByText('saved disk')
      ).toBeVisible();
      expect(
        await page
          .locator('.html-browser')
          .evaluate((element) => element.scrollWidth - element.clientWidth)
      ).toBeLessThanOrEqual(1);
      if (width === 390)
        await page.screenshot({ path: test.info().outputPath('html-preview-mobile.png') });
      await page.locator('#snapshot-html-source').click();
      await page.locator('#restore-html-source').click();
      await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
      await page.getByRole('button', { name: 'Open source' }).click();
      await expect(editor).toContainText('draft');
      await expect(page.getByRole('tab', { name: /index\.html/ })).toHaveCount(1);
    } finally {
      await fixture.close();
    }
  });
}

test('Text file commands follow the focused preview and ignore composition', async ({ page }) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/file-tabs.html');
  try {
    await page.goto(`${fixture.url}file-tabs.html?text-shortcuts`);
    const frame = page.locator('.workspace-file-page-frame');
    const count = page.locator('#format-opens');
    await page.locator('#outside-text-preview').focus();
    await page.keyboard.press('Control+Shift+v');
    await expect(count).toHaveText('0');
    await frame.focus();
    await frame.dispatchEvent('keydown', {
      key: 'v',
      code: 'KeyV',
      ctrlKey: true,
      shiftKey: true,
      isComposing: true
    });
    await expect(count).toHaveText('0');
    await page.keyboard.press('Control+Shift+v');
    await expect(count).toHaveText('1');
  } finally {
    await fixture.close();
  }
});

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
      for (const tab of await tabs.all()) {
        expect(
          await tab.evaluate((el) => {
            const panel = document.getElementById(el.getAttribute('aria-controls') ?? '');
            return Boolean(
              el.id &&
              panel?.getAttribute('role') === 'tabpanel' &&
              panel.getAttribute('aria-labelledby') === el.id
            );
          })
        ).toBe(true);
      }
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
      await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
      await expect(tabs.nth(11)).toHaveAttribute('aria-selected', 'false');
      await page.keyboard.press('Enter');
      await expect(tabs.nth(11)).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Home');
      await expect(tabs.nth(0)).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(tabs.nth(1)).toBeFocused();
      await page.keyboard.press('End');
      await expect(tabs.nth(11)).toBeFocused();
      await expect(tabs.nth(11)).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Home');
      await expect(tabs.nth(11)).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Space');
      await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
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
      await expect(frame).toBeFocused();
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
      await expect(frame.locator('.inline-find-count')).toContainText('1 / 1');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Shift+Enter');
      await expect(frame.locator('.inline-find-count')).toContainText('1 / 1');
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
      await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Enter');
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    } finally {
      await fixture.close();
    }
  });
}

test('opening a file preview does not reclaim focus the user moved during the transition', async ({
  page
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/file-tabs.html');
  try {
    await page.route('**/api/workspaces/workspace/changes?*', (route) =>
      route.fulfill({
        json: {
          repositories: [
            {
              repositoryPath: '',
              repositoryName: 'project',
              source: 'ROOT',
              changes: [
                { path: 'src/first.ts', state: 'UNSTAGED', change: 'MODIFIED', diffAvailable: true }
              ]
            }
          ]
        }
      })
    );
    await page.route('**/api/workspaces/workspace/changes/diff?*', (route) =>
      route.fulfill({ json: { diff: { binary: false, text: '@@ -1 +1 @@\n-before\n+after' } } })
    );
    await page.goto(`${fixture.url}file-tabs.html?diff-navigation=1`);
    await page.addStyleTag({ content: ':root { --el-transition-duration: 2s !important; }' });
    await page.getByRole('tab', { name: 'Git Changes', exact: true }).click();
    await page.getByRole('button', { name: 'View diff for src/first.ts', exact: true }).click();
    const dialog = page.locator('.file-preview-surface');
    await expect(dialog).toBeFocused();
    const tab = dialog.getByRole('tab', { name: /first\.ts/ });
    await tab.focus();
    await expect(tab).toBeFocused();
    await expect(page.locator('.dialog-fade-enter-active')).toHaveCount(0);
    await expect(tab).toBeFocused();
  } finally {
    await fixture.close();
  }
});

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

for (const [width, action] of [
  [1280, 'Escape'],
  [1280, 'mask'],
  [390, 'button'],
  [390, 'last-tab'],
  [390, 'back']
] as const) {
  test(`File preview finishes its exit before releasing tabs: ${action} at ${width}px`, async ({
    page
  }) => {
    const fixture = await startCustomThemeFixture('test/e2e/support/file-tabs.html');
    try {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.goto(`${fixture.url}file-tabs.html`);
      const surface = page.locator('.file-preview-surface.el-dialog');
      const overlay = page.locator('.el-overlay').filter({ has: surface });
      await expect(surface).toBeVisible();
      if (action === 'last-tab') {
        for (let index = 0; index < 11; index += 1) {
          await page.locator('.workspace-file-tab-close').first().click();
        }
        await expect(page.getByRole('tab')).toHaveCount(1);
      }
      await expect
        .poll(() => overlay.evaluate((element) => element.getAnimations().length))
        .toBe(0);
      await overlay.evaluate((element) => {
        element.addEventListener('animationstart', (event) => {
          if (event.target !== element) return;
          const state = document.documentElement.dataset;
          state.fileTabsExitCount = String(element.querySelectorAll('[role="tab"]').length);
          state.fileTabsExitInert = String(
            element.querySelector('.workspace-file-tabs')?.hasAttribute('inert')
          );
        });
        element.addEventListener('animationend', (event) => {
          if (event.target === element) document.documentElement.dataset.fileTabsExitEnded = 'true';
        });
      });
      if (action === 'mask') {
        await page.evaluate(() => {
          document.documentElement.dataset.fileTabsCloseAllowed = 'false';
        });
        await page.locator('.el-overlay-dialog').click({ position: { x: 4, y: 4 } });
        await expect(page.getByRole('tab')).toHaveCount(12);
        await expect(surface).toBeVisible();
        await page.evaluate(() => {
          document.documentElement.dataset.fileTabsCloseAllowed = 'true';
        });
        await page.locator('.el-overlay-dialog').click({ position: { x: 4, y: 4 } });
      } else if (action === 'Escape') await page.keyboard.press('Escape');
      else if (action === 'back') await page.goBack();
      else if (action === 'last-tab') await page.locator('.workspace-file-tab-close').click();
      else await page.locator('.workspace-file-window-close').click();
      await expect(page.getByText('Files closed')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute(
        'data-file-tabs-exit-count',
        action === 'last-tab' ? '1' : '12'
      );
      await expect(page.locator('html')).toHaveAttribute('data-file-tabs-exit-inert', 'true');
      await expect(page.locator('html')).toHaveAttribute('data-file-tabs-exit-ended', 'true');
      await expect(surface).toHaveCount(0);
      await expect(overlay).toHaveCount(0);
      await page.locator('#reopen-file-tabs').click();
      await expect(page.getByRole('tab')).toHaveCount(12);
      await expect(page.locator('.workspace-file-tabs')).not.toHaveAttribute('inert');
    } finally {
      await fixture.close();
    }
  });
}

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
