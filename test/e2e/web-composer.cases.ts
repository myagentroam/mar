import { expect, test } from '@playwright/test';
import { fulfillMockSessionWatch, mockConsoleApi, json, write } from './support/web-console-api.js';

// Composer, attachments, commands, and context

test('New Session focuses the Composer from buttons and keyboard shortcuts', async ({ page }) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const tree = page.locator('.workspace-tree');
  await tree.getByRole('button', { name: /node-1/ }).click();
  await tree.getByRole('button', { name: 'project', exact: true }).click();

  const composer = page.getByRole('textbox', { name: '输入消息' });
  const existingSession = page.locator('.session-link').first();
  const newSession = page.locator('.new-session-button');
  await existingSession.click();
  await newSession.click();
  await expect(page.locator('.session-link.selected')).toHaveCount(0);
  await expect(composer).toBeFocused();
  await page.keyboard.type('Draft message');
  await newSession.click();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('Draft message');
  await page.keyboard.type(' continued');
  await expect(composer).toHaveValue('Draft message continued');

  for (const modifier of ['Alt', 'Control']) {
    await existingSession.click();
    await expect(page.locator('.session-link.selected')).toHaveCount(1);
    await existingSession.focus();
    await expect(composer).not.toBeFocused();
    await page.keyboard.press(`${modifier}+n`);
    await expect(page.locator('.session-link.selected')).toHaveCount(0);
    await expect(composer).toBeFocused();
  }
});

test('Composer delegates plain text paste to native textarea behavior', async ({
  page,
  browserName
}) => {
  test.skip(browserName === 'firefox', 'Firefox does not expose text from synthetic paste events.');
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();

  const composer = page.getByRole('textbox', { name: '输入消息' });
  await composer.click();
  await composer.pressSequentially('已有内容');
  const pasteResult = await composer.evaluate((element) => {
    const editor = element as HTMLTextAreaElement;
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '纯文本');
    clipboardData.setData('text/html', '<strong>富文本</strong>');
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData
    });
    editor.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, value: editor.value };
  });

  expect(pasteResult).toEqual({ defaultPrevented: false, value: '已有内容' });
  await expect(composer).toHaveValue('已有内容');
});

test('Native Composer text paste can be undone', async ({ page, context, browserName }) => {
  test.skip(
    browserName === 'firefox',
    'Firefox Playwright does not support clipboard permissions.'
  );
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('纯文本'));
  const composer = page.getByRole('textbox', { name: '输入消息' });
  await composer.click();
  await composer.pressSequentially('已有内容');
  await composer.press('Control+V');
  await expect(composer).toHaveValue('已有内容纯文本');
  await composer.press('Control+KeyZ');
  await expect(composer).toHaveValue('已有内容');

  await composer.fill('');
  await page.evaluate(() => navigator.clipboard.writeText('/plan'));
  await composer.press('Control+V');
  await expect(composer).toHaveValue('/plan');
  await expect(page.locator('.command-picker')).toBeHidden();
});

test('Composer suppresses submission and suggestions during IME composition until final native input', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();

  const composer = page.getByRole('textbox', { name: '输入消息' });
  const result = await composer.evaluate((element) => {
    const editor = element as HTMLTextAreaElement;
    editor.focus();
    editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    editor.value = '中';
    editor.setSelectionRange(1, 1);
    editor.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: '中',
        inputType: 'insertCompositionText',
        isComposing: true
      })
    );
    const enter = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      isComposing: true
    });
    editor.dispatchEvent(enter);
    editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
    editor.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: '中',
        inputType: 'insertText',
        isComposing: false
      })
    );
    return { enterPrevented: enter.defaultPrevented, value: editor.value };
  });

  expect(result).toEqual({ enterPrevented: false, value: '中' });
  await expect(composer).toHaveValue('中');
  await expect(page.locator('.command-picker')).toBeHidden();
  expect(writes.filter((write) => write.url.includes('/messages'))).toHaveLength(0);
});

test('Composer converts large pasted text into TXT attachments instead of editor content', async ({
  page,
  browserName
}) => {
  test.skip(browserName === 'firefox', 'Firefox does not expose text from synthetic paste events.');
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  let uploadedName = '';
  await page.route('**/api/workspaces/workspace-1/uploads', async (route) => {
    uploadedName = (await route.request().postDataJSON()).name as string;
    return json(route, {
      upload: { uploadId: 'long-text-upload', receivedBytes: 0, size: 20_000 }
    });
  });
  await page.route(/\/api\/workspaces\/workspace-1\/uploads\/[^/]+\/chunks(?:\?.*)?$/, (route) =>
    json(route, {
      upload: { receivedBytes: route.request().postDataBuffer()?.byteLength ?? 0 }
    })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/uploads\/[^/]+\/complete$/, (route) =>
    json(route, {})
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();

  const composer = page.getByRole('textbox', { name: '输入消息' });
  await composer.fill('保留正文');
  const result = await composer.evaluate((editor) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData(
      'text/plain',
      Array.from({ length: 100 }, (_, index) => `line-${index}`).join('\n')
    );
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData });
    editor.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, childNodes: editor.childNodes.length };
  });

  expect(result.defaultPrevented).toBe(true);
  expect(result.childNodes).toBeLessThan(10);
  await expect(composer).toHaveValue('保留正文');
  await expect(page.getByText(/pasted-text-\d{8}-\d{6}\.txt/)).toBeVisible();
  expect(uploadedName).toMatch(/^pasted-text-\d{8}-\d{6}\.txt$/);
});

test('Composer image paste prevents default rich-text insertion', async ({ page, browserName }) => {
  test.skip(
    browserName === 'firefox',
    'Firefox synthetic DataTransfer does not expose the added file to paste handlers.'
  );
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  let uploadCompleted = false;
  await page.route('**/api/workspaces/workspace-1/uploads', (route) =>
    json(route, { upload: { uploadId: 'pasted-image-upload', receivedBytes: 0, size: 5 } })
  );
  await page.route(
    /\/api\/workspaces\/workspace-1\/uploads\/pasted-image-upload\/chunks(?:\?.*)?$/,
    (route) =>
      json(route, {
        upload: { receivedBytes: route.request().postDataBuffer()?.byteLength ?? 0 }
      })
  );
  await page.route(
    /\/api\/workspaces\/workspace-1\/uploads\/pasted-image-upload\/complete$/,
    (route) => {
      uploadCompleted = true;
      return json(route, {});
    }
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();

  const composer = page.getByRole('textbox', { name: '输入消息' });
  await composer.fill('保留正文');
  const defaultPrevented = await composer.evaluate((editor) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File(['image'], 'pasted.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData
    });
    editor.dispatchEvent(event);
    return event.defaultPrevented;
  });

  expect(defaultPrevented).toBe(true);
  await expect(composer).toHaveValue('保留正文');
  await expect(composer.locator('img')).toHaveCount(0);
  await expect.poll(() => uploadCompleted).toBe(true);
});

test('Dark theme uses consistent blue emphasis for new sessions and primary management actions', async ({
  page
}) => {
  await page.addInitScript(() => localStorage.setItem('mar.theme', 'vscode-dark-2026'));
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();

  const newSession = page.getByRole('button', { name: '新建会话', exact: true });
  await expect(newSession).toHaveCSS('background-color', 'rgb(48, 147, 255)');
  await newSession.hover();
  await expect(newSession).toHaveCSS('background-color', 'rgb(74, 163, 255)');
  await expect(page.locator('html')).toHaveCSS(
    '--el-color-primary-light-9',
    'rgb(48 147 255 / 0.14)'
  );
});

test('Composer Alt+M opens the model menu and delegates arrow keys to it', async ({ page }) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();

  const composer = page.getByRole('textbox', { name: '输入消息' });
  const model = page.locator('.composer-model-effort-select');
  const menu = page.locator('.el-select-dropdown.composer-model-effort-popper');
  await expect(model).toContainText('GPT-5.6 Sol Medium');
  await composer.fill('draft');
  await composer.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(2, 2));
  await composer.focus();
  await composer.press('Alt+m');
  const select = model.getByRole('combobox');
  await expect(select).toBeFocused();
  await expect(menu).toBeVisible();
  await select.press('ArrowDown');
  await expect(menu.locator('.el-select-dropdown__item.is-hovering')).toHaveCount(1);
  await select.press('Enter');
  await expect(menu).not.toBeVisible();
  await expect(model).toContainText('GPT-5.6 Sol Low');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('draft');
  await expect(composer).toHaveJSProperty('selectionStart', 2);

  await model.click();
  await expect(menu).toBeVisible();
  await select.press('Tab');
  await expect(select).toBeFocused();
  await expect(menu.locator('.el-select-dropdown__item.is-hovering')).toHaveText('GPT-5.6 Sol');
  await select.press('Shift+Tab');
  await expect(menu.locator('.el-select-dropdown__item.is-hovering')).toHaveText('Low');
  await select.press('ArrowDown');
  await expect(menu.locator('.el-select-dropdown__item.is-hovering')).toHaveText('Medium');
  await select.press('Tab');
  await expect(menu.locator('.el-select-dropdown__item.is-hovering')).toHaveText('GPT-5.6 Sol');
  await select.press('Shift+Tab');
  await expect(menu.locator('.el-select-dropdown__item.is-hovering')).toHaveText('Low');
  await select.press('ArrowDown');
  await select.press('Enter');
  await expect(model).toContainText('GPT-5.6 Sol Medium');
  await select.press('Tab');
  await expect(page.locator('.composer-access-select').getByRole('combobox')).toBeFocused();

  await model.click();
  await select.press('Tab');
  await select.press('ArrowDown');
  await expect(menu.locator('.el-select-dropdown__item.is-hovering')).toHaveText('GPT-5.6 Terra');
  await select.press('Enter');
  await expect(model).toContainText('GPT-5.6 Terra Medium');
  await expect(composer).toBeFocused();
  await model.click();
  await select.press('Shift+Tab');
  await expect(menu.locator('.el-select-dropdown__item.is-hovering')).toHaveText('Medium');
  await select.press('ArrowDown');
  await expect(menu.locator('.el-select-dropdown__item.is-hovering')).toHaveText('High');
  await menu.getByText('High', { exact: true }).click();
  await expect(model).toContainText('GPT-5.6 Terra High');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveJSProperty('selectionStart', 2);
  await model.click();
  await menu.getByText('GPT-5.6 Sol', { exact: true }).click();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveJSProperty('selectionStart', 2);
});

test('New Codex sessions enable the service tier with /fast without adding it to the first message', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route(/\/api\/runner-profiles\?.*\bnodeId=node-1(?:&|$)/, (route) =>
    json(route, {
      profiles: [
        {
          runner: 'codex',
          models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', supportedEfforts: ['medium'] }],
          accessOptions: [{ id: 'on-request', label: 'On-request' }],
          capabilities: ['history.read', 'turn.start'],
          commands: [
            {
              id: 'fast',
              runner: 'codex',
              label: '/fast',
              description: 'Toggle the fast service tier.',
              inputHint: '/fast',
              source: 'CODEX_APP_SERVER',
              interaction: 'TOGGLE',
              available: true,
              reasonCode: null
            }
          ]
        }
      ]
    })
  );
  await page.route('**/api/runner-commands', (route) => {
    const input = (route.request().postDataJSON() as { input: string }).input;
    return write(route, writes, { command: 'fast', enabled: input === '/fast on' });
  });
  await page.route('**/api/agent-sessions/start', (route) =>
    write(route, writes, {
      session: {
        id: 'fast-thread',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'fast-thread',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
      },
      run: {
        id: 'fast-run',
        sessionId: 'fast-thread',
        workspaceId: 'workspace-1',
        status: 'STARTING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'fast-message'
      }
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();

  const composer = page.getByRole('textbox', { name: '输入消息' });
  await composer.pressSequentially('/fast');
  await expect(page.getByRole('option', { name: /\/fast/ })).toBeVisible();
  await composer.press('Enter');
  await expect
    .poll(() => writes.filter((entry) => entry.url.includes('/api/runner-commands')))
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: JSON.stringify({
            nodeId: 'node-1',
            runner: 'codex',
            commandId: 'fast',
            input: '/fast on'
          })
        })
      ])
    );
  await expect(composer).toHaveValue('');
  await expect(page.getByRole('heading', { name: '新建会话' })).toBeVisible();
  expect(writes.some((entry) => entry.url.includes('/api/agent-sessions/start'))).toBe(false);
  await composer.fill('First message');
  await composer.press('Enter');
  await expect
    .poll(() => writes.find((entry) => entry.url.includes('/api/agent-sessions/start')))
    .toBeDefined();
  expect(
    JSON.parse(writes.find((entry) => entry.url.includes('/api/agent-sessions/start'))!.body)
  ).toMatchObject({ content: 'First message', deferredCommands: [] });
});

test('New sessions open Composer directly and submit settings with the first message and attachments', async ({
  page
}) => {
  test.setTimeout(60_000);
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  let sessionListRequests = 0;
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/agent-sessions')
      sessionListRequests += 1;
  });
  let composerUploadCount = 0;
  let composerUploadShouldFail = false;
  let releaseFirstUpload: (() => void) | undefined;
  let blockFirstUpload = true;
  await page.route('**/api/workspaces/workspace-1/uploads', (route) => {
    composerUploadCount += 1;
    return write(route, writes, {
      upload: { uploadId: `composer-upload-${composerUploadCount}`, receivedBytes: 0, size: 4096 }
    });
  });
  await page.route(
    /\/api\/workspaces\/workspace-1\/uploads\/[^/]+\/chunks(?:\?.*)?$/,
    async (route) => {
      if (composerUploadShouldFail)
        return route.fulfill({
          contentType: 'application/json',
          status: 409,
          body: JSON.stringify({ error: { code: 'UPLOAD_TARGET_EXISTS' } })
        });
      if (blockFirstUpload) {
        await new Promise<void>((resolve) => {
          releaseFirstUpload = resolve;
        });
        blockFirstUpload = false;
      }
      const url = new URL(route.request().url());
      const offset = Number(url.searchParams.get('offset') ?? '0');
      return new Promise<void>((resolve) => setTimeout(resolve, 120)).then(() =>
        write(route, writes, {
          upload: { receivedBytes: offset + (route.request().postDataBuffer()?.length ?? 0) }
        })
      );
    }
  );
  await page.route(/\/api\/workspaces\/workspace-1\/uploads\/[^/]+\/complete$/, (route) =>
    write(route, writes, { upload: { receivedBytes: 4096 } })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/uploads\/[^/]+\/cancel$/, (route) =>
    route.fulfill({ status: 204 })
  );
  await page.route('**/api/agent-sessions/start', (route) =>
    write(route, writes, {
      session: {
        id: 'session-created',
        workspaceId: 'workspace-1',
        runner: 'codex',
        runnerTitle: '分析这张图片',
        externalSessionId: 'session-created',
        activity: 'MANAGED_ACTIVE',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.steer'] }
      },
      run: {
        id: 'run-created',
        sessionId: 'session-created',
        workspaceId: 'workspace-1',
        status: 'SUCCEEDED',
        recoveryState: 'ACTIVE',
        clientMessageId: 'first'
      }
    })
  );
  await page.route('**/api/agent-sessions/session-created?nodeId=node-1', (route) =>
    json(route, {
      session: {
        id: 'session-created',
        workspaceId: 'workspace-1',
        runner: 'codex',
        runnerTitle: '分析这张图片',
        externalSessionId: 'session-created',
        activity: 'MANAGED_ACTIVE',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.steer'] }
      }
    })
  );
  await page.route('**/api/agent-sessions/session-created/watch*', (route) => {
    const items = showHistoricalImageAttachment
      ? [
          {
            id: 'historical-image-user',
            kind: 'user_message',
            status: 'COMPLETED',
            payload: {
              text: '历史图片',
              attachments: [
                {
                  name: 'diagram.png',
                  mime: 'image/png',
                  byteSize: 14,
                  runId: 'historical-image-run'
                }
              ]
            }
          }
        ]
      : [];
    return fulfillMockSessionWatch(
      page,
      route,
      {
        id: 'session-created',
        workspaceId: 'workspace-1'
      },
      {
        kind: 'session-watch-snapshot',
        sequence: 10,
        session: {
          id: 'session-created',
          workspaceId: 'workspace-1',
          runner: 'codex',
          externalSessionId: 'session-created',
          runnerTitle: '分析这张图片',
          activity: 'IDLE',
          control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
        },
        runs: [],
        queue: { version: 0, paused: false, items: [] },
        context: null,
        conversation: {
          unit: 'SEGMENT',
          segments: showHistoricalImageAttachment
            ? [
                {
                  id: 'historical-image-turn:segment:0',
                  turnId: 'historical-image-turn',
                  sessionId: 'session-created',
                  runId: null,
                  index: 0,
                  status: 'SUCCEEDED',
                  items
                }
              ]
            : [],
          nextCursor: null
        }
      }
    );
  });
  await page.route('**/api/agent-sessions/session-created/runs?nodeId=node-1', (route) =>
    json(route, { runs: [] })
  );
  await page.route('**/api/agent-sessions/session-created/messages', (route) =>
    write(route, writes, {
      session: {
        id: 'session-created',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'session-created',
        activity: 'MANAGED_ACTIVE',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.steer'] }
      },
      run: {
        id: 'run-follow-up',
        sessionId: 'session-created',
        workspaceId: 'workspace-1',
        status: 'RUNNING',
        recoveryState: 'ACTIVE'
      }
    })
  );
  let showHistoricalImageAttachment = false;
  await page.route(
    /\/api\/agent-sessions\/session-created\/turns\?nodeId=node-1&limit=10(?:&unit=SEGMENT)?$/,
    (route) => {
      const items = showHistoricalImageAttachment
        ? [
            {
              id: 'historical-image-user',
              kind: 'user_message',
              status: 'COMPLETED',
              payload: {
                text: '历史图片',
                attachments: [
                  {
                    name: 'diagram.png',
                    mime: 'image/png',
                    byteSize: 14,
                    runId: 'historical-image-run'
                  }
                ]
              }
            }
          ]
        : [];
      return route.request().url().includes('unit=SEGMENT')
        ? json(route, {
            unit: 'SEGMENT',
            segments: showHistoricalImageAttachment
              ? [
                  {
                    id: 'historical-image-turn:segment:0',
                    turnId: 'historical-image-turn',
                    sessionId: 'session-created',
                    runId: null,
                    index: 0,
                    status: 'SUCCEEDED',
                    items
                  }
                ]
              : [],
            nextCursor: null
          })
        : json(route, {
            turns: showHistoricalImageAttachment
              ? [
                  {
                    id: 'historical-image-turn',
                    sessionId: 'session-created',
                    runId: null,
                    status: 'SUCCEEDED',
                    items
                  }
                ]
              : [],
            nextCursor: null
          });
    }
  );
  await page.route('**/api/agent-sessions/session-created/context?nodeId=node-1', (route) =>
    json(route, { context: null })
  );
  await page.route(
    '**/api/workspaces/workspace-1/queue?nodeId=node-1&sessionId=session-created',
    (route) => json(route, { queue: { version: 0, paused: false, items: [] } })
  );
  await page.route('**/api/agent-runs/*/images/0?nodeId=node-1', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="160"></svg>'
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.locator('.el-dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '新建会话' })).toBeVisible();
  await expect(page.locator('.composer-shell')).toHaveCount(1);
  await expect(page.getByText('Runner 默认', { exact: true })).toHaveCount(0);
  const draftComposer = page.getByRole('textbox', { name: '输入消息' });
  const modelAndEffort = page.locator('.composer-model-effort-select');
  await expect(modelAndEffort).toContainText('GPT-5.6 Sol Medium');
  await expect(page.locator('.composer-model-effort-select')).toBeVisible();
  await expect(page.locator('.composer-runner-select')).toBeVisible();
  await expect(page.locator('.composer-runner-select')).toHaveClass(/el-select--small/);
  await expect(page.locator('.composer-runner-select .el-select__wrapper')).toHaveCSS(
    'box-shadow',
    'none'
  );
  await expect(page.locator('.composer-model-effort-select .el-select__wrapper')).toHaveCSS(
    'box-shadow',
    'none'
  );
  const controlLayout = await page.locator('.composer-configuration').evaluate((element) => {
    const controls = [...element.children].map((control) => ({
      rect: control.getBoundingClientRect(),
      flexGrow: getComputedStyle(control).flexGrow
    }));
    return {
      display: getComputedStyle(element).display,
      flexWrap: getComputedStyle(element).flexWrap,
      width: element.getBoundingClientRect().width,
      overflow: controls.some(
        (control) =>
          control.rect.left < element.getBoundingClientRect().left ||
          control.rect.right > element.getBoundingClientRect().right
      ),
      controls: controls.map((control) => ({
        flexGrow: control.flexGrow,
        width: control.rect.width
      }))
    };
  });
  expect(controlLayout.display).toBe('flex');
  expect(controlLayout.flexWrap).toBe('wrap');
  expect(controlLayout.overflow).toBe(false);
  expect(controlLayout.controls).toHaveLength(4);
  expect(controlLayout.controls.every((control) => control.flexGrow === '0')).toBe(true);
  expect(controlLayout.controls.every((control) => control.width < controlLayout.width)).toBe(true);
  expect(
    await modelAndEffort
      .locator('.el-select__selected-item:not(.el-select__input-wrapper)')
      .evaluate((element) => element.clientWidth)
  ).toBeGreaterThan(100);
  expect(
    await page
      .locator('.composer-runner-select .el-select__selected-item:not(.el-select__input-wrapper)')
      .evaluate((element) => element.clientWidth)
  ).toBeGreaterThan(30);
  expect(
    await page
      .locator('.composer-access-select .el-select__selected-item:not(.el-select__input-wrapper)')
      .evaluate((element) => element.clientWidth)
  ).toBeGreaterThan(50);
  const access = page.getByRole('combobox', { name: '权限' });
  await expect(page.locator('.composer-access-select')).toContainText('按需确认');
  await expect(page.locator('.composer-access-select')).toBeVisible();
  await expect(page.locator('.composer-access-select .el-select__wrapper')).toHaveCSS(
    'box-shadow',
    'none'
  );
  await expect(page.getByRole('button', { name: '新建会话', exact: true })).toHaveClass(
    /new-session-button/
  );
  await page.locator('.composer-runner-select').click();
  const runnerMenu = page.locator('.el-select-dropdown.composer-runner-popper');
  await expect(runnerMenu).toBeVisible();
  await expect(runnerMenu.locator('.el-select-dropdown__item', { hasText: 'Codex' })).toHaveCSS(
    'height',
    '26px'
  );
  await expect(runnerMenu.evaluate((node) => node.closest('.composer-shell'))).resolves.toBeNull();
  await runnerMenu.getByText('Claude Code', { exact: true }).click();
  await expect(page.locator('.composer-runner-select')).toContainText('Claude Code');
  await page.locator('.composer-runner-select').click();
  await runnerMenu.getByText('Codex', { exact: true }).click();
  await expect(page.locator('.composer-runner-select')).toContainText('Codex');
  await modelAndEffort.click();
  const modelAndEffortMenu = page.locator('.el-select-dropdown.composer-model-effort-popper');
  await expect(modelAndEffortMenu).toBeVisible();
  await expect(
    modelAndEffortMenu.evaluate((node) => node.closest('.composer-shell'))
  ).resolves.toBeNull();
  await expect(
    modelAndEffortMenu.locator('.el-select-group__title', { hasText: '模型' })
  ).toBeVisible();
  await expect(
    modelAndEffortMenu.locator('.el-select-group__title', { hasText: '推理' })
  ).toBeVisible();
  await expect(modelAndEffortMenu.locator('.el-select-dropdown__wrap')).toHaveCSS(
    'max-height',
    'none'
  );
  await modelAndEffortMenu.getByText('High', { exact: true }).click();
  await expect(modelAndEffort).toContainText('GPT-5.6 Sol High');
  await modelAndEffort.click();
  const selectedHigh = modelAndEffortMenu.locator('.composer-model-effort-option-selected', {
    hasText: 'High'
  });
  await expect(selectedHigh).toBeVisible();
  await expect(selectedHigh).toHaveCSS('background-color', 'rgb(237, 241, 245)');
  await expect(selectedHigh).toHaveCSS('font-weight', '700');
  await expect(
    modelAndEffortMenu.locator('.composer-model-effort-option-selected', {
      hasText: 'GPT-5.6 Sol'
    })
  ).toBeVisible();
  await modelAndEffortMenu.getByText('GPT-5.6 Terra', { exact: true }).click();
  await expect(modelAndEffort).toContainText('GPT-5.6 Terra Medium');
  await expect(access).toBeVisible();
  await page.locator('.composer-access-select').click();
  const accessMenu = page.locator('.el-select-dropdown.composer-access-popper');
  await expect(accessMenu).toBeVisible();
  await accessMenu.getByText('完全访问', { exact: true }).click();
  await expect(page.locator('.composer-access-select')).toContainText('完全访问');
  await expect(page.locator('.composer-shell')).toHaveCSS('overflow', 'hidden');
  await expect(page.locator('.composer-shell .composer-input')).toHaveCSS(
    'border-top-width',
    '0px'
  );
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveAttribute(
    'placeholder',
    '输入 / 调用命令、# 使用快捷提示词、用 @ 提及工作区文件或文件夹，或添加附件，向 Codex 提问…'
  );
  await expect(page.getByRole('button', { name: '添加附件' })).toContainText('');
  await expect(page.getByRole('button', { name: '添加附件' })).toHaveCSS('cursor', 'pointer');
  const composerToolbarAlignment = await page.locator('.composer-toolbar').evaluate((toolbar) => {
    const attachment = toolbar.querySelector<HTMLButtonElement>('.composer-attachment-button');
    const runner = toolbar.querySelector<HTMLElement>(
      '.composer-runner-select .el-select__wrapper'
    );
    if (attachment === null || runner === null) throw new Error('composer controls are missing');
    const attachmentRect = attachment.getBoundingClientRect();
    const runnerRect = runner.getBoundingClientRect();
    return {
      topDifference: Math.abs(attachmentRect.top - runnerRect.top),
      heightDifference: Math.abs(attachmentRect.height - runnerRect.height)
    };
  });
  expect(composerToolbarAlignment.topDifference).toBeLessThanOrEqual(1);
  expect(composerToolbarAlignment.heightDifference).toBeLessThanOrEqual(1);
  await page.getByRole('textbox', { name: '输入消息' }).fill('分析这张图片');
  const composerShell = page.locator('.composer-shell');
  await composerShell.evaluate((shell) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['dropped'], 'dropped.pdf', { type: 'application/pdf' }));
    shell.dispatchEvent(
      new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer })
    );
  });
  await expect(composerShell).toHaveClass(/composer-drop-target/);
  await composerShell.evaluate((shell) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['dropped'], 'dropped.pdf', { type: 'application/pdf' }));
    shell.dispatchEvent(
      new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer })
    );
    shell.dispatchEvent(
      new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer })
    );
  });
  await expect(composerShell).toHaveClass(/composer-drop-target/);
  await composerShell.evaluate((shell) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['dropped'], 'dropped.pdf', { type: 'application/pdf' }));
    shell.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  });
  await expect(composerShell).not.toHaveClass(/composer-drop-target/);
  await expect(page.locator('.attachment-list')).toContainText('dropped.pdf');
  await expect.poll(() => composerUploadCount).toBe(1);
  await draftComposer.click();
  await draftComposer.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await draftComposer.pressSequentially('/plan');
  await expect(page.getByRole('option', { name: /\/plan/ })).toBeVisible();
  await draftComposer.press('Enter');
  await expect(page.getByRole('heading', { name: '新建会话' })).toBeVisible();
  await expect(page.locator('.composer-command-states')).toContainText('计划模式');
  await expect(page.getByText('附件仍在上传或上传失败，完成后才能发送。')).toHaveCount(0);
  expect(writes.some((entry) => entry.url === '/api/agent-sessions/start')).toBe(false);
  releaseFirstUpload?.();
  await page.locator('.attachment-file-input').setInputFiles([
    {
      name: 'diagram.png',
      mimeType: 'image/png',
      buffer: Buffer.from('not-a-real-png')
    },
    { name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('pdf') }
  ]);
  await expect(page.locator('.attachment-list img')).toHaveCount(1);
  await expect(page.locator('.attachment-list')).toContainText('notes.pdf');
  await expect(page.locator('.attachment-file-mark')).toHaveCount(0);
  await expect(page.locator('.attachment-list li')).toHaveCount(3);
  await expect(page.locator('.composer-attachment-remove')).toHaveCount(3);
  await expect(page.locator('.composer-attachment-remove').first()).toHaveCSS('width', '24px');
  await expect(page.locator('.composer-attachments')).toHaveCSS('gap', '0px');
  const attachmentLayout = await composerShell.evaluate((shell) => {
    const attachments = shell.querySelector('.composer-attachments')?.getBoundingClientRect();
    const input = shell.querySelector('.composer-input')?.getBoundingClientRect();
    if (attachments === undefined || input === undefined)
      throw new Error('composer attachment list or message input is missing');
    return { attachmentsBottom: attachments.bottom, inputTop: input.top };
  });
  expect(attachmentLayout.attachmentsBottom).toBeLessThanOrEqual(attachmentLayout.inputTop);
  await expect(page.getByRole('button', { name: '发送' })).toBeDisabled();
  await expect.poll(() => composerUploadCount).toBe(3);
  await expect(page.locator('.attachment-list')).toContainText('上传中…');
  await expect(page.locator('.attachment-list')).not.toContainText('上传中 0%');
  await expect(page.getByText('已上传', { exact: true })).toHaveCount(3);
  composerUploadShouldFail = true;
  await page.locator('.attachment-file-input').setInputFiles({
    name: 'image.png',
    mimeType: 'image/png',
    buffer: Buffer.from('second-image')
  });
  await expect(page.locator('.attachment-list')).toContainText('上传失败: UPLOAD_TARGET_EXISTS');
  await expect(page.locator('.attachment-list li')).toHaveCount(3, { timeout: 2500 });
  composerUploadShouldFail = false;
  await draftComposer.fill('分析这张图片');
  const send = page.getByRole('button', { name: '发送' });
  await expect(send).toBeEnabled();
  const sessionListRequestsBeforeSend = sessionListRequests;
  await send.click();
  await expect
    .poll(() => writes.filter((entry) => entry.url.endsWith('/agent-sessions/start')).length)
    .toBe(1);
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('');
  await expect(page.locator('.composer-attachments')).toHaveCount(0);
  await expect(page.locator('.conversation-user-image')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '分析这张图片' })).toBeVisible();
  const sessionLinks = page.locator('.session-list').locator('.session-link');
  await expect(sessionLinks.filter({ hasText: '分析这张图片' })).toHaveCount(1);
  expect(sessionListRequests).toBe(sessionListRequestsBeforeSend);
  const originalSessionLink = sessionLinks.filter({ hasText: '新建会话' });
  await originalSessionLink.click();
  await expect(originalSessionLink).toHaveClass(/selected/);
  showHistoricalImageAttachment = true;
  const historicalSessionLink = sessionLinks.filter({ hasText: '分析这张图片' });
  await historicalSessionLink.click();
  await expect(historicalSessionLink).toHaveClass(/selected/);
  const historicalImageButton = page
    .getByRole('article')
    .filter({ hasText: '历史图片' })
    .locator('.conversation-user-image-button');
  const historicalImage = historicalImageButton.locator('.conversation-user-image');
  await expect(historicalImage).toHaveCount(1, { timeout: 15_000 });
  const historicalImageLayout = await historicalImageButton.evaluate((button) => {
    const image = button.querySelector('img');
    if (image === null) throw new Error('historical image is missing');
    const buttonRect = button.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    return {
      buttonWidth: buttonRect.width,
      buttonHeight: buttonRect.height,
      imageWidth: imageRect.width,
      imageHeight: imageRect.height,
      imageContentWidth: image.clientWidth,
      imageContentHeight: image.clientHeight,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight
    };
  });
  expect(historicalImageLayout.buttonWidth).toBe(historicalImageLayout.imageWidth);
  expect(historicalImageLayout.buttonHeight).toBe(historicalImageLayout.imageHeight);
  expect(historicalImageLayout.imageContentWidth * historicalImageLayout.naturalHeight).toBe(
    historicalImageLayout.imageContentHeight * historicalImageLayout.naturalWidth
  );
  expect(historicalImageLayout.imageWidth).toBeLessThanOrEqual(160);
  expect(historicalImageLayout.imageHeight).toBeLessThanOrEqual(120);
  await historicalImageButton.click();
  const imagePreview = page.getByRole('dialog');
  await expect(imagePreview).toContainText('diagram.png');
  await page.keyboard.press('Escape');
  await expect(imagePreview).not.toBeVisible();

  expect(writes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining('/api/agent-sessions'),
        body: expect.stringContaining('"title":"分析这张图片"')
      }),
      expect.objectContaining({
        body: expect.stringContaining('"model":"gpt-5.6-terra"')
      }),
      expect.objectContaining({
        body: expect.stringContaining('"effort":"high"')
      }),
      expect.objectContaining({
        body: expect.stringContaining('"access":"full-access"')
      }),
      expect.objectContaining({
        url: expect.stringContaining('/agent-sessions/start'),
        body: expect.stringContaining('attachmentIds')
      })
    ])
  );

  await draftComposer.click();
  await draftComposer.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await draftComposer.pressSequentially('/xxx');
  const messageResponse = page.waitForResponse((item) => item.url().includes('/messages'));
  await draftComposer.press('Enter');
  const unknownSlashResponse = await messageResponse;
  expect(JSON.parse(unknownSlashResponse.request().postData() ?? '{}')).toMatchObject({
    content: '/xxx'
  });
});

test('Runner menus show only Runners supported by the current Node Profile', async ({ page }) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route(/\/api\/runner-profiles\?.*\bnodeId=node-1(?:&|$)/, (route) =>
    json(route, {
      profiles: [
        {
          runner: 'codex',
          models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', supportedEfforts: ['medium'] }],
          accessOptions: [{ id: 'on-request', label: 'On-request' }],
          commands: [],
          capabilities: []
        },
        {
          runner: 'claude-code',
          models: [{ id: 'sonnet', label: 'Claude Sonnet', supportedEfforts: ['medium'] }],
          accessOptions: [{ id: 'default', label: 'Default' }],
          commands: [],
          capabilities: ['history.read', 'turn.start']
        }
      ]
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '输入消息' })).toBeEnabled();
  await expect(page.locator('.composer-runner-select')).toContainText('Claude Code');
  await page.locator('.composer-runner-select').click();

  const options = page.locator(
    '.el-select-dropdown.composer-runner-popper .el-select-dropdown__item'
  );
  await expect(options).toHaveCount(1);
  await expect(options).toContainText(['Claude Code']);
  await expect(options).not.toContainText('Codex');
});

test('Composer image attachments open an enlarged preview', async ({ page }) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route('**/api/workspaces/workspace-1/uploads', (route) =>
    json(route, { upload: { uploadId: 'image-preview-upload', receivedBytes: 0, size: 4 } })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/uploads\/[^/]+\/chunks(?:\?.*)?$/, (route) =>
    json(route, { upload: { receivedBytes: 4 } })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/uploads\/[^/]+\/complete$/, (route) =>
    json(route, { upload: { receivedBytes: 4 } })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await page.locator('.attachment-file-input').setInputFiles({
    name: 'diagram.png',
    mimeType: 'image/png',
    buffer: Buffer.from('png')
  });

  await page.getByRole('button', { name: '放大查看附件 diagram.png' }).click();
  const attachmentPreview = page.getByRole('dialog', { name: 'diagram.png' });
  await expect(attachmentPreview).toBeVisible();
  await expect(attachmentPreview.getByRole('img', { name: 'diagram.png' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(attachmentPreview).toHaveCount(0);
});

test('New sessions restore Node-saved Composer defaults per Runner and persist new selections', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'turn.start'],
    writes,
    'GIT_WORKSPACE',
    true,
    undefined,
    [
      { runner: 'codex', model: 'gpt-5.6-terra', effort: 'high', access: 'workspace-write' },
      { runner: 'claude-code', model: 'sonnet', effort: 'high', access: 'bypass' }
    ]
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();

  await expect(page.locator('.composer-runner-select')).toContainText('Codex');
  await expect(page.locator('.composer-model-effort-select')).toContainText('GPT-5.6 Terra High');
  await expect(page.locator('.composer-access-select')).toContainText('工作区写入');
  await expect(page.locator('.conversation-title-row .runner-brand-icon')).toHaveAttribute(
    'data-runner',
    'codex'
  );

  await page.locator('.composer-runner-select').click();
  await page
    .locator('.el-select-dropdown.composer-runner-popper')
    .getByText('Claude Code', { exact: true })
    .click();
  await expect(page.locator('.composer-model-effort-select')).toContainText('Claude Sonnet High');
  await expect(page.locator('.composer-access-select')).toContainText('跳过权限确认');

  await page.locator('.composer-access-select').click();
  await page
    .locator('.el-select-dropdown.composer-access-popper')
    .getByText('默认', { exact: true })
    .click();
  await expect
    .poll(() =>
      writes
        .filter((entry) => entry.url.includes('/api/runner-defaults'))
        .map((entry) => JSON.parse(entry.body))
    )
    .toContainEqual({
      nodeId: 'node-1',
      runner: 'claude-code',
      model: 'sonnet',
      effort: 'high',
      access: 'default'
    });
});

test('Composer Slash Commands support keyboard selection and structured submission', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route('**/api/agent-sessions/session-1/commands', (route) =>
    write(route, writes, { accepted: true })
  );
  await page.route(/\/api\/runner-profiles\?.*\bnodeId=node-1(?:&|$)/, (route) =>
    json(route, {
      profiles: [
        {
          runner: 'codex',
          models: [
            {
              id: 'gpt-5.6-sol',
              label: 'GPT-5.6 Sol',
              supportedEfforts: ['medium']
            }
          ],
          accessOptions: [{ id: 'on-request', label: 'On-request' }],
          capabilities: ['history.read', 'turn.start'],
          commands: [
            { id: 'compact', description: '立即压缩当前会话上下文。' },
            { id: 'plan', description: '开启或关闭协作规划模式。' },
            ...Array.from({ length: 10 }, (_, index) => ({
              id: `command-${index + 1}`,
              description: `用于验证键盘滚动跟随的较长命令描述 ${index + 1}`
            }))
          ].map((command) => ({
            ...command,
            runner: 'codex',
            label: `/${command.id}`,
            inputHint: `/${command.id}`,
            source: 'CODEX_APP_SERVER',
            interaction: command.id === 'plan' ? 'TOGGLE' : 'IMMEDIATE_ACTION',
            available: true,
            reasonCode: null
          }))
        }
      ]
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();
  const composer = page.getByRole('textbox', { name: '输入消息' });
  await composer.click();
  await composer.pressSequentially('/');
  await expect(page.getByRole('option', { name: /\/plan/ })).toBeVisible();
  await expect(page.getByText('当前 Runner 没有可执行的 Slash Command。')).toHaveCount(0);
  await composer.press('ArrowDown');
  await expect(page.getByRole('option', { name: /\/plan/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await composer.press('ArrowDown');
  await composer.press('ArrowDown');
  await composer.press('ArrowDown');
  await composer.press('ArrowDown');
  await composer.press('ArrowDown');
  await composer.press('ArrowDown');
  await composer.press('ArrowDown');
  await composer.press('ArrowDown');
  await expect(page.getByRole('option', { name: /\/command-8/ })).toBeInViewport();
  for (let index = 0; index < 8; index += 1) await composer.press('ArrowUp');
  await expect(page.getByRole('option', { name: /\/plan/ })).toBeInViewport();
  const response = page.waitForResponse((item) => item.url().includes('/commands'));
  await composer.press('Enter');
  await response;
  await expect(composer).toHaveValue('');
  expect(writes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining('/commands'),
        csrf: 'csrf-1',
        body: expect.stringMatching(/"commandId":"plan".*"input":"\/plan"/)
      })
    ])
  );
});

test('Confirmed MAR Agent /clear empties the session and recreates observation', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  const session = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    runner: 'mar-agent' as const,
    externalSessionId: 'mar-session-1',
    activity: 'IDLE' as const,
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  };
  const snapshot = (cleared: boolean) => ({
    kind: 'session-watch-snapshot',
    sequence: cleared ? 2 : 1,
    session,
    runs: cleared
      ? []
      : [
          {
            id: 'stale-run',
            sessionId: session.id,
            workspaceId: session.workspaceId,
            status: 'SUCCEEDED',
            recoveryState: 'IDLE',
            clientMessageId: 'stale-message'
          }
        ],
    queue: { version: 0, paused: false, items: [] },
    context: cleared
      ? null
      : {
          model: 'Coding',
          usedTokens: 156_000,
          maxTokens: 258_400,
          percentage: 60.4
        },
    conversation: {
      unit: 'SEGMENT',
      source: 'official',
      readAt: 1,
      latestVisibleAt: 1,
      nextCursor: null,
      snapshotSequence: cleared ? 2 : 1,
      segments: cleared
        ? []
        : [
            {
              id: 'turn-old:segment:0',
              sessionId: session.id,
              turnId: 'turn-old',
              runId: 'stale-run',
              index: 0,
              status: 'SUCCEEDED',
              startedAt: 1,
              completedAt: 2,
              items: [
                {
                  id: 'old-user',
                  sessionId: session.id,
                  turnId: 'turn-old',
                  runId: 'stale-run',
                  parentItemId: null,
                  sourceSequence: 1,
                  revision: 1,
                  kind: 'user_message',
                  status: 'COMPLETED',
                  startedAt: 1,
                  completedAt: 1,
                  payload: { text: '会被清空的历史' }
                }
              ]
            }
          ]
    }
  });
  let cleared = false;
  let watchReads = 0;
  let watchDeletes = 0;
  await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) =>
    json(route, { sessions: [session], nextCursor: null })
  );
  await page.route('**/api/agent-sessions/session-1?nodeId=node-1', (route) =>
    json(route, { session })
  );
  await page.route(/\/api\/runner-profiles\?.*\bnodeId=node-1(?:&|$)/, (route) =>
    json(route, {
      profiles: [
        {
          runner: 'mar-agent',
          models: [{ id: 'coding', label: 'Coding', supportedEfforts: ['high'] }],
          accessOptions: [{ id: 'full-access', label: 'Full access' }],
          capabilities: ['history.read', 'turn.start'],
          commands: [
            {
              id: 'clear',
              runner: 'mar-agent',
              label: '/clear',
              description: 'Permanently clear this session history while keeping the session.',
              inputHint: '/clear',
              source: 'MAR_RUNTIME',
              interaction: 'DESTRUCTIVE_ACTION',
              available: true,
              reasonCode: null
            }
          ]
        }
      ]
    })
  );
  await page.route('**/api/agent-sessions/session-1/commands', (route) => {
    cleared = true;
    return write(route, writes, { session });
  });
  await page.route('**/api/agent-sessions/session-1/config', (route) =>
    write(route, writes, { session })
  );
  await page.route('**/api/agent-sessions/session-1/watch*', async (route) => {
    if (route.request().method() === 'DELETE') {
      watchDeletes += 1;
      await json(route, { unwatched: true });
      return;
    }
    watchReads += 1;
    await fulfillMockSessionWatch(page, route, session, snapshot(cleared));
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();

  const composer = page.getByRole('textbox', { name: '输入消息' });
  await expect(page.getByText('会被清空的历史', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /上下文窗口：156k \/ 258k tokens/ })).toBeVisible();
  await composer.fill('/clear');
  await page.getByRole('option', { name: /\/clear/ }).click();
  const confirmation = page.getByRole('dialog', { name: '清空会话' });
  await expect(confirmation).toContainText('永久清空当前会话');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  expect(writes.filter((entry) => entry.url.includes('/commands'))).toHaveLength(0);
  await expect(page.getByText('会被清空的历史', { exact: true })).toBeVisible();

  await composer.fill('/clear');
  await page.getByRole('option', { name: /\/clear/ }).click();
  const commandResponse = page.waitForResponse((response) => response.url().includes('/commands'));
  await page
    .getByRole('dialog', { name: '清空会话' })
    .getByRole('button', { name: '清空会话', exact: true })
    .click();
  await commandResponse;
  await expect(page.getByText('会被清空的历史', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /上下文窗口：156k \/ 258k tokens/ })).toHaveCount(
    0
  );
  expect(JSON.parse(writes.find((entry) => entry.url.includes('/commands'))!.body)).toEqual({
    nodeId: 'node-1',
    workspaceId: 'workspace-1',
    commandId: 'clear',
    input: '/clear'
  });
  expect(watchDeletes).toBe(1);
  expect(watchReads).toBe(2);
});

test('Selecting a Slash skill adds a tag and submits hidden XML input', async ({ page }) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route('**/api/nodes', (route) =>
    json(route, {
      nodes: [
        {
          id: 'node-1',
          platform: 'linux',
          architecture: 'x64',
          // Composer skill tokens require the current Node contract.
          nodeAppVersion: '0.9.6',
          nodeVersion: 'v24.15.0',
          connected: true,
          disabled: false,
          capabilities: {
            codex: { available: true, version: '0.146' },
            claudeCode: { available: true, version: '2.1' }
          }
        }
      ]
    })
  );
  let skillRequests = 0;
  await page.route(/\/api\/workspaces\/workspace-1\/effective-skills(?:\?.*)?$/, (route) => {
    skillRequests += 1;
    return json(route, {
      skills: [
        {
          name: 'db-query',
          description: '查询数据库',
          localStatus: 'INSTALLED',
          source: 'WORKSPACE',
          skillFilePath: '/workspace/.agents/skills/db-query/SKILL.md'
        }
      ]
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
  await page.locator('.session-list .session-link').first().click();
  const composer = page.getByRole('textbox', { name: '输入消息' });

  const skillsResponse = page.waitForResponse((response) =>
    response.url().includes('/effective-skills')
  );
  await composer.click();
  await composer.pressSequentially('/');
  await skillsResponse;
  const picker = page.locator('.command-picker');
  await expect(picker.getByText('命令', { exact: true })).toBeVisible();
  await expect(picker.getByText('技能', { exact: true })).toBeVisible();
  await expect(picker.getByRole('option', { name: /\/compact/ })).toBeVisible();
  await expect(picker.getByRole('option', { name: /db-query/ })).toBeVisible();
  await expect(picker.getByRole('option', { name: /db-query/ }).locator('strong')).toHaveText(
    'db-query'
  );
  await expect(picker.getByRole('option', { name: /\/compact/ }).locator('span')).toHaveAttribute(
    'title',
    '立即压缩当前会话上下文。'
  );
  await expect(picker.getByRole('option', { name: /db-query/ }).locator('span')).toHaveAttribute(
    'title',
    '查询数据库'
  );
  expect(skillRequests).toBe(1);

  await composer.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await composer.pressSequentially('保留这段草稿 /db', { delay: 20 });
  await expect(composer).toHaveValue('保留这段草稿 /db');
  await expect(picker.getByRole('option', { name: /db-query/ })).toBeVisible();
  expect(skillRequests).toBe(1);

  await picker.getByRole('option', { name: /db-query/ }).click();
  await expect(page.locator('.composer-skill-state')).toContainText('db-query');
  const tokenHeight = await page
    .locator('.composer-skill-state')
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(tokenHeight).toBeLessThanOrEqual(30);
  expect(writes.filter((write) => write.url.includes('/messages'))).toHaveLength(0);
  await composer.fill('');
  await composer.press('Backspace');
  await expect(page.locator('.composer-skill-state')).toHaveCount(0);
  await expect(composer).toHaveValue('');
  await composer.fill('保留这段草稿 ');
  await composer.click();
  await composer.press('End');
  await composer.pressSequentially('/');
  await expect(picker.getByRole('option', { name: /db-query/ })).toBeVisible();
  await picker.getByRole('option', { name: /db-query/ }).click();
  await expect(page.locator('.composer-skill-state')).toContainText('db-query');
  await composer.fill('');
  const response = page.waitForResponse((item) => item.url().includes('/messages'));
  await composer.press('Enter');
  await response;
  await expect(composer).toHaveValue('');
  await expect(page.locator('.composer-skill-state')).toHaveCount(0);
  const submitted = JSON.parse(writes.find((entry) => entry.url.includes('/messages'))!.body);
  expect(submitted.content).toContain('<mar_skills action="use">');
  expect(submitted.content).not.toContain('[invoke skill]');
  await expect(page.locator('.conversation-item.user_message')).toHaveCount(0);
});

test('Runner Profile loading retries initial failure and distinguishes loading states', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  let profileRequests = 0;
  let releaseProfile: (() => void) | undefined;
  const profileReady = new Promise<void>((resolve) => {
    releaseProfile = resolve;
  });
  await page.route(/\/api\/runner-profiles\?.*\bnodeId=node-1(?:&|$)/, async (route) => {
    profileRequests += 1;
    if (profileRequests === 1) {
      await json(route, { error: { code: 'NODE_TEMPORARILY_UNAVAILABLE' } }, 503);
      return;
    }
    await profileReady;
    await json(route, {
      profiles: [
        {
          runner: 'codex',
          models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', supportedEfforts: ['medium'] }],
          accessOptions: [{ id: 'on-request', label: 'On-request' }],
          commands: [
            {
              id: 'plan',
              runner: 'codex',
              label: '/plan',
              description: '开启或关闭协作规划模式。',
              inputHint: '/plan',
              source: 'CODEX_APP_SERVER',
              interaction: 'TOGGLE',
              available: true,
              reasonCode: null
            }
          ],
          capabilities: ['history.read', 'turn.start']
        }
      ],
      defaults: []
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
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  const composer = page.getByRole('textbox', { name: '输入消息' });
  await expect.poll(() => profileRequests).toBe(2);
  await composer.fill('/');
  await expect(page.getByText('正在加载 Agent 命令…', { exact: true })).toBeVisible();
  await expect(page.getByText('当前 Agent 没有可执行的 Slash Command。')).toHaveCount(0);
  releaseProfile?.();
  await expect(page.getByText('正在加载 Agent 命令…', { exact: true })).toBeHidden();
  await composer.fill('/p');
  await expect(page.getByRole('option', { name: /\/plan/ })).toBeVisible();
  expect(profileRequests).toBe(2);
});

test('Composer displays Node-reported context usage and compacts only after confirmation', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  const session = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    runner: 'codex' as const,
    externalSessionId: 'vscode-thread-1',
    activity: 'IDLE' as const,
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  };
  await page.route(/\/api\/agent-sessions\/session-1\/watch(?:\?.*)?$/, (route) =>
    fulfillMockSessionWatch(page, route, session, {
      kind: 'session-watch-snapshot',
      sequence: 1,
      session,
      runs: [],
      queue: { version: 0, paused: false, items: [] },
      context: {
        model: 'GPT-5.6 Sol',
        usedTokens: 156_000,
        maxTokens: 258_400,
        percentage: 60.4
      },
      conversation: {
        unit: 'SEGMENT',
        source: 'official',
        readAt: 1,
        latestVisibleAt: 1,
        nextCursor: null,
        snapshotSequence: 1,
        segments: []
      }
    })
  );
  await page.route('**/api/agent-sessions/session-1/runs?nodeId=node-1', (route) =>
    json(route, { runs: [] })
  );
  let releaseCompact: (() => void) | undefined;
  const compactPending = new Promise<void>((resolve) => (releaseCompact = resolve));
  await page.route('**/api/agent-sessions/session-1/commands', async (route) => {
    await compactPending;
    return write(route, writes, {
      session: {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'vscode-thread-1',
        activity: 'MANAGED_ACTIVE',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.interrupt'] }
      },
      run: {
        id: 'compact-run',
        status: 'STARTING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'compact'
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
  await page.locator('.session-list .session-link').first().click();

  const indicator = page.getByRole('button', { name: /上下文窗口：156k \/ 258k tokens/ });
  await expect(indicator).toBeVisible();
  await indicator.evaluate((element) => (element as HTMLButtonElement).click());
  const confirmation = page.getByRole('dialog', { name: '压缩上下文' });
  await expect(confirmation).toContainText('释放窗口空间');
  const response = page.waitForResponse((item) => item.url().includes('/commands'));
  await confirmation.getByRole('button', { name: '压缩' }).click();
  await expect(page.locator('.composer-working')).toBeVisible();
  releaseCompact?.();
  await response;
  const commandWrite = writes.find((write) => write.url.includes('/commands'));
  expect(commandWrite).toBeDefined();
  expect(JSON.parse(commandWrite!.body)).toMatchObject({
    nodeId: 'node-1',
    workspaceId: 'workspace-1',
    commandId: 'compact',
    input: '/compact'
  });
});

test('Composer @ selects file and directory tags and submits hidden XML references', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  let searchUrl = '';
  let searchCount = 0;
  const longReferencePath = `src/${'very-long-directory-name/'.repeat(8)}LongTarget.ts`;
  await page.route('**/api/agent-sessions/start', (route) =>
    write(route, writes, {
      session: {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'session-1',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
      },
      run: {
        id: 'run-1',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        status: 'STARTING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'reference-message'
      }
    })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/files\/search(?:\?.*)?$/, (route) => {
    searchUrl = route.request().url();
    searchCount += 1;
    return json(route, {
      files: {
        entries: [
          { path: 'src/App.vue', name: 'App.vue', kind: 'FILE' },
          { path: 'src/App.test.ts', name: 'App.test.ts', kind: 'FILE' },
          ...Array.from({ length: 12 }, (_, index) => ({
            path: `src/app-result-${index}.ts`,
            name: `app-result-${index}.ts`,
            kind: 'FILE'
          })),
          { path: longReferencePath, name: 'LongTarget.ts', kind: 'FILE' },
          { path: 'src/app folder', name: 'app folder', kind: 'DIRECTORY' }
        ],
        nextCursor: null,
        truncated: false
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
  await page.getByRole('button', { name: '新建会话', exact: true }).click();

  const composer = page.getByRole('textbox', { name: '输入消息' });
  await expect(composer).toHaveAttribute('placeholder', /用 @ 提及工作区文件或文件夹，或添加附件/);
  await composer.fill('请检查 @app');
  await expect(page.getByRole('listbox', { name: '引用文件或文件夹' })).toBeVisible();
  await expect(page.getByRole('option', { name: /App\.vue/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /app folder.*文件夹/ })).toBeAttached();
  await composer.press('ArrowDown');
  await expect(page.getByRole('option', { name: /App\.test\.ts/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await page.waitForTimeout(250);
  await expect(page.getByRole('option', { name: /App\.test\.ts/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  expect(searchCount).toBe(1);
  for (let index = 0; index < 13; index += 1) await composer.press('ArrowDown');
  const targetOption = page.getByRole('option', { name: /LongTarget\.ts/ });
  await expect(targetOption).toHaveAttribute('aria-selected', 'true');
  const pickerLayout = await page
    .getByRole('listbox', { name: '引用文件或文件夹' })
    .evaluate((picker) => {
      const selected = picker.querySelector<HTMLElement>('[aria-selected="true"]');
      if (selected === null) throw new Error('未找到选中的文件引用');
      const pickerBounds = picker.getBoundingClientRect();
      const selectedBounds = selected.getBoundingClientRect();
      return {
        selectedVisible:
          selectedBounds.top >= pickerBounds.top && selectedBounds.bottom <= pickerBounds.bottom,
        horizontalOverflow: picker.scrollWidth > picker.clientWidth
      };
    });
  expect(pickerLayout).toEqual({ selectedVisible: true, horizontalOverflow: false });
  await composer.press('Enter');
  await expect(composer).toHaveValue('请检查 ');
  await expect(page.locator('.composer-file-reference-state')).toContainText('LongTarget.ts');
  await expect(page.locator('.composer-file-reference-state')).toHaveAttribute(
    'title',
    longReferencePath
  );
  expect(searchUrl).toContain('q=app');
  expect(searchUrl).toContain('includeDirectories=true');
  await composer.fill('请检查 @app');
  await page.getByRole('option', { name: /app folder.*文件夹/ }).click();
  await expect(composer).toHaveValue('请检查 ');
  await expect(page.locator('.composer-file-reference-state')).toHaveCount(2);
  await expect(page.locator('.composer-file-reference-state').last()).toContainText('app folder');
  await composer.press('Enter');
  await expect.poll(() => writes.filter((entry) => entry.url.includes('/start')).length).toBe(1);
  const submitted = JSON.parse(writes.find((entry) => entry.url.includes('/start'))!.body);
  expect(submitted.content).toContain('<mar_references>');
  expect(submitted.content).toContain(longReferencePath);
  expect(submitted.content).toContain('src/app folder');
  expect(submitted.content).not.toContain('@src');
  await expect(page.locator('.composer-file-reference-state')).toHaveCount(0);
  expect(writes.some((entry) => entry.url.includes('/uploads'))).toBe(false);
});
