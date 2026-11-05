import { expect, test, type Page } from '@playwright/test';
import {
  emitMockSessionEvent,
  fulfillMockWorkspaceWatch,
  json,
  mockConsoleApi
} from './support/web-console-api.js';

async function prepareFiles(page: Page, extraFiles: string[] = []): Promise<void> {
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
  const files = ['first.ts', 'second.ts', 'README.md', ...extraFiles];
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
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: 'project', exact: true })
    .click();
}

test('Workspace HTML conversation links and Files preview use the single Aside browser', async ({
  page
}, testInfo) => {
  test.setTimeout(90_000);
  page.on('pageerror', (error) => console.error('Browser error:', error.message));
  await prepareFiles(page, ['index.html', 'second.htm']);
  const grants: string[] = [];
  await page.context().route('**/api/html-preview/grants', async (route) => {
    const path = route.request().postDataJSON().path as string;
    grants.push(path);
    await json(route, { url: new URL(`/html-preview-test/${path}`, page.url()).href });
  });
  await page.context().route('**/html-preview-test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<h1>${new URL(route.request().url()).pathname}</h1>`
    })
  );
  await page.locator('.session-list button').first().click();
  await emitMockSessionEvent(page, 'conversation', {
    sessionId: 'session-1',
    runId: 'run-1',
    item: {
      itemId: 'html-links',
      kind: 'assistant_message',
      status: 'COMPLETED',
      segmentId: 'turn-1:segment:0',
      segmentIndex: 0,
      payload: {
        text: '[First HTML](index.html)\n\n[Second HTML](second.htm)',
        format: 'markdown',
        model: null
      }
    }
  });
  const first = page.locator('.agent-markdown').getByRole('link', { name: 'First HTML' });
  await first.click();
  await expect(
    page.frameLocator('iframe[title="index.html"]').getByText('/html-preview-test/index.html')
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('html-aside-desktop.png'),
    animations: 'disabled'
  });
  await page.locator('.agent-markdown').getByRole('link', { name: 'Second HTML' }).click();
  await expect(
    page.frameLocator('iframe[title="second.htm"]').getByText('/html-preview-test/second.htm')
  ).toBeVisible();
  await expect(page.locator('iframe[title="index.html"]')).toHaveCount(0);
  const popupPromise = page.waitForEvent('popup');
  await first.click({ modifiers: ['Control'] });
  const popup = await popupPromise;
  await expect(
    popup.frameLocator('iframe[title]').getByText('/html-preview-test/index.html')
  ).toBeVisible();
  await expect(
    page.frameLocator('iframe[title="second.htm"]').getByText('/html-preview-test/second.htm')
  ).toBeVisible();
  expect(grants).toEqual(['index.html', 'second.htm', 'index.html']);
  await popup.close();
  await page.getByRole('tab', { name: '文件', exact: true }).click();
  const row = page.locator('.file-tree-row[data-file-path="index.html"]');
  await row.hover();
  await row.locator('..').locator('.file-tree-more').click();
  await page.getByRole('menuitem', { name: '预览', exact: true }).click();
  await expect(
    page.frameLocator('iframe[title="index.html"]').getByText('/html-preview-test/index.html')
  ).toBeVisible();
  await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
  await page.evaluate(() => {
    const mock = (
      window as unknown as {
        __consoleMockWorkbenchWebSocket: {
          emitNodeConnection(nodeId: string, connected: boolean): void;
        };
      }
    ).__consoleMockWorkbenchWebSocket;
    mock.emitNodeConnection('node-1', false);
  });
  await expect(page.locator('.workspace-offline-placeholder')).toBeVisible();
  await expect(page.locator('.workspace-grid')).toBeHidden();
  await expect(page.locator('iframe[title="index.html"]')).toHaveCount(0);
  await page.evaluate(() => {
    const mock = (
      window as unknown as {
        __consoleMockWorkbenchWebSocket: {
          emitNodeConnection(nodeId: string, connected: boolean): void;
        };
      }
    ).__consoleMockWorkbenchWebSocket;
    mock.emitNodeConnection('node-1', true);
  });
  await expect(page.locator('.workspace-offline-placeholder')).toHaveCount(0);
  await expect(
    page.frameLocator('iframe[title="index.html"]').getByText('/html-preview-test/index.html')
  ).toBeVisible();
  expect(grants).toEqual(['index.html', 'second.htm', 'index.html', 'index.html', 'index.html']);
});

test('Workspace HTML conversation preview opens on mobile', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await prepareFiles(page, ['mobile.html']);
  await page
    .context()
    .route('**/api/html-preview/grants', (route) =>
      json(route, { url: new URL('/html-preview-mobile', page.url()).href })
    );
  await page
    .context()
    .route('**/html-preview-mobile', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<h1>Mobile rendered</h1>' })
    );
  await page.locator('.session-list button').first().click();
  await page.setViewportSize({ width: 390, height: 844 });
  await emitMockSessionEvent(page, 'conversation', {
    sessionId: 'session-1',
    runId: 'run-1',
    item: {
      itemId: 'mobile-html',
      kind: 'assistant_message',
      status: 'COMPLETED',
      segmentId: 'turn-1:segment:0',
      segmentIndex: 0,
      payload: { text: '[Mobile HTML](mobile.html)', format: 'markdown', model: null }
    }
  });
  await page.locator('.agent-markdown').getByRole('link', { name: 'Mobile HTML' }).click();
  await expect(
    page.frameLocator('iframe[title="mobile.html"]').getByText('Mobile rendered')
  ).toBeVisible();
  const browser = page.locator('.html-browser');
  expect(
    await browser.evaluate((element) => element.scrollWidth - element.clientWidth)
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath('html-aside-mobile.png'),
    animations: 'disabled'
  });
});

test('Workspace HTML source drafts and previews stay isolated across real Workspace switches', async ({
  page
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const fileEntries = [{ path: 'index.html', name: 'index.html', kind: 'FILE', size: 32 }];
  await page.route('**/api/workspaces?nodeId=node-1', (route) =>
    json(route, {
      workspaces: [
        { id: 'workspace-1', path: '/project', kind: 'GIT_WORKSPACE' },
        { id: 'workspace-2', path: '/other-project', kind: 'DIRECTORY' }
      ]
    })
  );
  await page.route(/\/api\/workspaces\/workspace-2\/files(?:\?.*)?$/, (route) =>
    json(route, { files: { entries: fileEntries, nextCursor: null, truncated: false } })
  );
  await page.route(/\/api\/workspaces\/workspace-2\/watch$/, (route) =>
    fulfillMockWorkspaceWatch(
      page,
      route,
      {
        id: 'session-2',
        workspaceId: 'workspace-2',
        runner: 'codex',
        externalSessionId: 'thread-2',
        activity: 'IDLE',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
      },
      'DIRECTORY',
      fileEntries
    )
  );
  await page.route(/\/api\/workspaces\/(workspace-[12])\/files\/read(?:\?.*)?$/, (route) => {
    const workspaceId = new URL(route.request().url()).pathname.split('/')[3]!;
    const content = `<h1>saved ${workspaceId}</h1>`;
    return json(route, {
      file: {
        path: 'index.html',
        encoding: 'utf-8',
        size: content.length,
        content,
        truncated: false,
        nextOffset: null,
        revision: 'a'.repeat(64)
      }
    });
  });
  await prepareFiles(page, ['index.html']);
  const grants: string[] = [];
  const writes: string[] = [];
  await page.context().route('**/api/html-preview/grants', (route) => {
    const workspaceId = route.request().postDataJSON().workspaceId as string;
    grants.push(workspaceId);
    return json(route, { url: new URL(`/html-isolation/${workspaceId}`, page.url()).href });
  });
  await page.context().route('**/html-isolation/*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<h1>saved ${new URL(route.request().url()).pathname.split('/').at(-1)}</h1>`
    })
  );
  page.on('request', (request) => {
    if (/\/files\/write$/.test(new URL(request.url()).pathname)) writes.push(request.url());
  });
  const editor = page
    .getByRole('region', { name: 'index.html 文件预览', exact: true })
    .locator('.cm-content');
  const browser = page.locator('.html-browser');
  async function editAndPreview(workspaceId: string, draft: string) {
    await page.getByRole('tab', { name: '文件', exact: true }).click();
    await page.locator('.file-tree-row[data-file-path="index.html"]').click();
    await expect(editor).toContainText(`saved ${workspaceId}`);
    if ((await editor.getAttribute('contenteditable')) !== 'true')
      await page.getByRole('button', { name: '编辑文件', exact: true }).click();
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(` ${draft}`);
    await expect(editor).toContainText(draft);
    await page.getByRole('button', { name: '运行 HTML 预览', exact: true }).click();
    await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
    await expect(
      page.frameLocator('iframe[title="index.html"]').getByText(`saved ${workspaceId}`)
    ).toBeVisible();
    await expect(page.frameLocator('iframe[title="index.html"]').locator('body')).not.toContainText(
      draft
    );
  }

  await editAndPreview('workspace-1', 'workspace-one-draft');
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: 'other-project', exact: true })
    .click();
  await page.getByRole('tab', { name: '浏览器', exact: true }).click();
  await expect(browser.getByText('从会话或文件中打开 HTML 文件，即可在此预览。')).toBeVisible();
  await expect(page.locator('iframe[title="index.html"]')).toHaveCount(0);
  await editAndPreview('workspace-2', 'workspace-two-draft');

  for (const [workspaceId, draft, otherDraft] of [
    ['workspace-1', 'workspace-one-draft', 'workspace-two-draft'],
    ['workspace-2', 'workspace-two-draft', 'workspace-one-draft']
  ] as const) {
    await page.locator(`.workspace-tab[data-tab-id="node-1:${workspaceId}"]`).click();
    await expect(
      page.frameLocator('iframe[title="index.html"]').getByText(`saved ${workspaceId}`)
    ).toBeVisible();
    await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
    await browser.getByRole('button', { name: '打开源码', exact: true }).click();
    await expect(editor).toContainText(draft);
    await expect(editor).not.toContainText(otherDraft);
    await expect(page.getByRole('tablist', { name: '文件预览标签' }).getByRole('tab')).toHaveCount(
      1
    );
    await page.getByRole('button', { name: '运行 HTML 预览', exact: true }).click();
  }
  expect(grants).toContain('workspace-1');
  expect(grants).toContain('workspace-2');
  expect(writes).toEqual([]);
});

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

for (const width of [1280, 390]) {
  test.describe(`Agent message file line ranges at ${width}px`, () => {
    test.use({ isMobile: width === 390, hasTouch: width === 390 });

    test('Deleted file links report FILE_NOT_FOUND without opening a browser window', async ({
      page
    }) => {
      await prepareFiles(page);
      const reads: string[] = [];
      await page
        .context()
        .route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) => {
          const path = new URL(route.request().url()).searchParams.get('path') ?? '';
          reads.push(path);
          if (path === 'src/deleted.ts')
            return json(
              route,
              {
                error: {
                  code: 'FILE_NOT_FOUND',
                  message: 'The file does not exist.',
                  requestId: 'deleted-file-preview'
                }
              },
              404
            );
          if (path === 'first.ts') {
            const content = "// First line\nexport const value = 'first.ts';\n// Last line\n";
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
          }
          return route.fallback();
        });
      await page.locator('.session-list button').first().click();
      await page.setViewportSize({ width, height: 844 });
      await emitMockSessionEvent(page, 'conversation', {
        sessionId: 'session-1',
        runId: 'run-1',
        item: {
          itemId: 'agent-review-file-ranges',
          kind: 'assistant_message',
          status: 'COMPLETED',
          segmentId: 'turn-1:segment:0',
          segmentIndex: 0,
          payload: {
            text: '[Deleted source](src/deleted.ts#L186-L217)\n\n[Existing source](first.ts#L2-L3)',
            format: 'markdown',
            model: null
          }
        }
      });
      const popups: Page[] = [];
      page.on('popup', (popup) => popups.push(popup));
      const deletedLink = page
        .locator('.agent-markdown')
        .getByRole('link', { name: 'Deleted source' });
      if (width === 390) await deletedLink.tap();
      else await deletedLink.click();
      await expect.poll(() => reads.length + popups.length).toBeGreaterThan(0);
      expect(popups.map((popup) => popup.url())).toEqual([]);
      const error = page.locator('.el-message--error');
      await expect(error).toContainText('FILE_NOT_FOUND');
      await expect(error).toContainText('deleted-file-preview');
      await expect.poll(() => reads).toContain('src/deleted.ts');
      await expect(page).toHaveURL(/\/console(?:[?#]|$)/u);
      await page.keyboard.press('Escape');

      const existingLink = page
        .locator('.agent-markdown')
        .getByRole('link', { name: 'Existing source' });
      if (width === 390) await existingLink.tap();
      else await existingLink.click();
      const preview = page.getByRole('dialog', { name: 'first.ts 文件预览' });
      await expect(preview.locator('.cm-activeLine')).toContainText(
        "export const value = 'first.ts';"
      );
      expect(popups).toHaveLength(0);
    });
  });
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
