import { expect, test, type Page } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

async function prepareFiles(page: Page): Promise<void> {
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'turn.start'],
    [],
    'GIT_WORKSPACE',
    true,
    undefined,
    undefined,
    '0.9.95',
    true
  );
  const files = ['first.ts', 'second.ts', 'README.md'];
  await page.context().route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) =>
    json(route, {
      files: {
        entries: files.map((path) => ({ path, name: path, kind: 'FILE', size: 32, modifiedAt: 1 })),
        nextCursor: null,
        truncated: false
      }
    })
  );
  await page.context().route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? 'first.ts';
    const content = path.endsWith('.md') ? '# Preview\n' : `export const value = '${path}';\n`;
    return json(route, {
      file: {
        path,
        encoding: 'utf-8',
        size: content.length,
        content,
        truncated: false,
        nextOffset: null,
        revision: 'a'.repeat(64)
      }
    });
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
}

async function openFile(page: Page, path: string): Promise<void> {
  // Exercise the existing tree intent without requiring access through the file overlay.
  await page
    .locator(`.file-tree-row[data-file-path="${path}"]`)
    .evaluate((element: HTMLElement) => element.click());
  await expect(page.locator('.workspace-file-tab.is-active')).toContainText(path);
  await expect(
    page.getByRole('region', { name: `${path} 文件预览` }).locator('.cm-content')
  ).toBeVisible();
}

for (const shortcut of ['Escape', 'Alt+Shift+w']) {
  test(`File window ${shortcut} closes all tabs while Alt+W closes only the current file, not the workspace`, async ({
    page
  }) => {
    await prepareFiles(page);
    await openFile(page, 'first.ts');
    await openFile(page, 'second.ts');
    const tabs = page.getByRole('tablist', { name: '文件预览标签' });
    const editor = page
      .getByRole('region', { name: 'second.ts 文件预览', exact: true })
      .locator('.cm-content');
    await editor.click();
    await page.keyboard.press('Alt+w');
    await expect(tabs.getByRole('tab')).toHaveCount(1);
    await expect(tabs.getByRole('tab', { name: 'first.ts' })).toBeVisible();
    await expect(page.locator('.workspace-tab')).toHaveCount(1);

    await openFile(page, 'second.ts');
    await editor.click();
    await page.keyboard.press('Control+f');
    const search = page
      .getByRole('region', { name: 'second.ts 文件预览', exact: true })
      .locator('.cm-search');
    await expect(search).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(search).toHaveCount(0);
    await expect(tabs.getByRole('tab')).toHaveCount(2);
    await editor.click();
    await page.keyboard.press(shortcut);
    await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
    await expect(page.locator('.workspace-tab')).toHaveCount(1);
  });
}

for (const width of [1280, 390]) {
  test(`Escape closes only the topmost Markdown settings dialog, leaving the file window open at ${width}px`, async ({
    page
  }) => {
    await prepareFiles(page);
    await page.setViewportSize({ width, height: 844 });
    await openFile(page, 'README.md');
    const preview = page.getByRole('dialog', { name: 'README.md 文件预览' });
    const previewState = await page.evaluate(() => history.state);
    const settingsButton = preview.getByRole('button', { name: 'Markdown 预览设置' });
    const settings = page.getByRole('dialog', { name: 'Markdown 预览设置', exact: true });
    await settingsButton.click();
    await expect(settings).toBeVisible();
    await expect(settings.locator('.el-dialog__header')).toBeVisible();
    await expect(settings.locator('.el-dialog__headerbtn')).toBeVisible();
    await expect(settings.locator('.el-dialog__body')).toHaveCSS('display', 'block');
    await settings.locator('.el-dialog__headerbtn').click();
    await expect(settings).toHaveCount(0);
    await expect(preview).toBeVisible();
    await expect(settingsButton).toBeFocused();
    await expect.poll(() => page.evaluate(() => history.state)).toEqual(previewState);

    await settingsButton.click();
    await settings.getByRole('textbox').focus();
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
    await expect(preview).toBeVisible();
    await expect(settingsButton).toBeFocused();
    await expect.poll(() => page.evaluate(() => history.state)).toEqual(previewState);
    if (width === 390) {
      await settingsButton.click();
      await expect(settings).toBeVisible();
      await page.goBack();
      await expect(settings).toHaveCount(0);
      await expect(preview).toBeVisible();
      await expect(settingsButton).toBeFocused();
      await expect.poll(() => page.evaluate(() => history.state)).toEqual(previewState);
    }
    await expect(page.locator('.workspace-file-tabs')).toHaveCount(1);
    await preview.locator('.cm-content').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
  });
}

test('Mobile Back confirms all files, preserves cancelled windows, and can close on the next attempt', async ({
  page
}) => {
  await prepareFiles(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const initialHistoryLength = await page.evaluate(() => history.length);
  const initialState = await page.evaluate(() => history.state);
  await openFile(page, 'first.ts');
  await openFile(page, 'second.ts');
  expect(await page.evaluate(() => history.length)).toBe(initialHistoryLength + 1);
  const editor = page
    .getByRole('region', { name: 'second.ts 文件预览', exact: true })
    .locator('.cm-content');
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('// dirty');
  await page.evaluate(() => history.back());
  const confirm = page.locator('.el-message-box');
  await expect(confirm).toContainText('未保存的修改');
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.el-overlay-message-box')).toHaveCount(0);
  await expect(page.getByRole('tablist', { name: '文件预览标签' }).getByRole('tab')).toHaveCount(2);
  await expect(editor).toContainText('// dirty');
  await page.evaluate(() => history.back());
  await expect(confirm).toContainText('未保存的修改');
  await confirm.locator('.el-button--primary').click();
  await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
  await expect(page.locator('.el-overlay-message-box')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => history.state)).toEqual(initialState);
  await expect(page.locator('.workspace-tab')).toHaveCount(1);

  await openFile(page, 'first.ts');
  expect(await page.evaluate(() => history.length)).toBe(initialHistoryLength + 1);
  await page.keyboard.press('Alt+w');
  await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => history.state)).toEqual(initialState);
});

test('Reopening a mobile file window ignores stale Back cleanup from its predecessor', async ({
  page
}) => {
  await prepareFiles(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const initialHistoryLength = await page.evaluate(() => history.length);
  const initialState = await page.evaluate(() => history.state);
  await openFile(page, 'first.ts');
  await page.evaluate(async () => {
    document.querySelector<HTMLButtonElement>('.workspace-file-window-close')!.click();
    await Promise.resolve();
    await Promise.resolve();
    document
      .querySelector<HTMLButtonElement>('.file-tree-row[data-file-path="second.ts"]')!
      .click();
  });
  await expect(page.locator('.workspace-file-tab.is-active')).toContainText('second.ts');
  await expect(
    page.getByRole('dialog', { name: 'second.ts 文件预览' }).locator('.cm-content')
  ).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(initialHistoryLength + 1);
  await page.goBack();
  await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => history.state)).toEqual(initialState);
});

for (const rendered of [false, true]) {
  const mode = rendered ? '独立 Markdown 渲染预览' : '独立文件 Tab 页面';
  const url = `/console?standaloneFile=1&nodeId=node-1&workspaceId=workspace-1&path=${rendered ? 'README.md&markdownPreview=1' : 'first.ts'}`;

  test(`${mode} preserves file-close keyboard shortcuts`, async ({ page }) => {
    await prepareFiles(page);
    for (const shortcut of ['Alt+w', 'Alt+Shift+w', 'Escape']) {
      const popupPromise = page.waitForEvent('popup');
      await page.evaluate(() => window.open('about:blank', '_blank'));
      const popup = await popupPromise;
      await popup.goto(url);
      if (rendered)
        await expect(popup.getByRole('heading', { name: 'Preview', exact: true })).toBeVisible();
      else {
        await expect(popup.locator('.workspace-file-tabs')).toBeVisible();
        await openFile(popup, 'second.ts');
        if (shortcut === 'Alt+w') {
          await popup.locator('.workspace-file-tab.is-active').click();
          await popup.keyboard.press(shortcut);
          await expect(
            popup.getByRole('tablist', { name: '文件预览标签' }).getByRole('tab')
          ).toHaveCount(1);
          expect(popup.isClosed()).toBe(false);
        }
      }
      const closed = popup.waitForEvent('close');
      await popup.keyboard.press(shortcut).catch((error: unknown) => {
        if (!popup.isClosed()) throw error;
      });
      await closed;
      await expect(page.locator('.workspace-tab')).toHaveCount(1);
    }
  });

  test(`${mode} closes the window on mobile Back`, async ({ page }) => {
    await prepareFiles(page);
    const popupPromise = page.waitForEvent('popup');
    await page.evaluate(() => window.open('about:blank', '_blank'));
    const popup = await popupPromise;
    await popup.setViewportSize({ width: 390, height: 844 });
    await popup.goto(url);
    if (rendered)
      await expect(popup.getByRole('heading', { name: 'Preview', exact: true })).toBeVisible();
    else {
      await expect(popup.locator('.workspace-file-tabs')).toBeVisible();
      await openFile(popup, 'second.ts');
    }
    const closed = popup.waitForEvent('close');
    await popup
      .evaluate(() => history.back())
      .catch((error: unknown) => {
        if (!popup.isClosed()) throw error;
      });
    await closed;
    await expect(page.locator('.workspace-tab')).toHaveCount(1);
  });
}

test('Standalone rendered HTML supports content shortcuts and mobile Back to close', async ({
  page
}) => {
  await prepareFiles(page);
  await page
    .context()
    .route('**/api/html-preview/grants', (route) =>
      json(route, { url: new URL('/html-preview-test/index.html', page.url()).href })
    );
  await page.context().route('**/html-preview-test/index.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<input aria-label="Preview input">
          <div class="el-overlay-dialog"><input aria-label="Nested input"></div>
          <script>document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') event.target.closest('.el-overlay-dialog')?.remove();
          });</script>`
    })
  );
  for (const shortcut of ['Alt+w', 'Alt+Shift+w', 'Escape', 'Back']) {
    const popupPromise = page.waitForEvent('popup');
    await page.evaluate(() => window.open('about:blank', '_blank'));
    const popup = await popupPromise;
    if (shortcut === 'Back') await popup.setViewportSize({ width: 390, height: 844 });
    await popup.goto(
      '/console?standaloneFile=1&htmlPreview=1&nodeId=node-1&workspaceId=workspace-1&path=index.html'
    );
    const input = popup
      .frameLocator('.html-preview-frame')
      .getByRole('textbox', { name: 'Preview input' });
    await expect(input).toBeVisible();
    if (shortcut === 'Escape') {
      const nested = popup
        .frameLocator('.html-preview-frame')
        .getByRole('textbox', { name: 'Nested input' });
      await nested.press('Escape');
      await expect(nested).toHaveCount(0);
      expect(popup.isClosed()).toBe(false);
    }
    await input.focus();
    const closed = popup.waitForEvent('close');
    if (shortcut === 'Back') await popup.evaluate(() => history.back());
    else
      await input.press(shortcut).catch((error: unknown) => {
        if (!popup.isClosed()) throw error;
      });
    await closed;
    await expect(page.locator('.workspace-tab')).toHaveCount(1);
  }
});
