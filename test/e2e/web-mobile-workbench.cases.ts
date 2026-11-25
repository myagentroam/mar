import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  emitMockSessionEvent,
  fulfillMockSessionWatch,
  json,
  mockConsoleApi,
  write
} from './support/web-console-api.js';

const currentVersion = (
  JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

// Mobile Workbench

test.describe('Aside terminal touch interaction', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('opens from Files and retains its PTY when switching away and back', async ({ page }) => {
    test.setTimeout(90_000);
    let created = false;
    let creations = 0;
    const terminal = {
      id: 'terminal-1',
      workspaceId: 'workspace-1',
      profileId: 'default',
      state: 'RUNNING',
      latestSequence: 0
    };
    await page.addInitScript(() => {
      class MockWebSocket extends EventTarget {
        static readonly OPEN = 1;
        static readonly CLOSED = 3;
        static readonly resizeRows: number[] = [];
        static readonly instances: MockWebSocket[] = [];
        readyState = MockWebSocket.OPEN;
        constructor(readonly url: string) {
          super();
          MockWebSocket.instances.push(this);
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 })
              })
            )
          );
        }
        send(data: string): void {
          const frame = JSON.parse(data) as { type: string; rows?: number };
          if (frame.type === 'resize' && frame.rows !== undefined)
            MockWebSocket.resizeRows.push(frame.rows);
        }
        close(): void {
          this.readyState = MockWebSocket.CLOSED;
        }
      }
      Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
    });
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    await page.route('**/api/terminals**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/attach-ticket')) return json(route, { ticket: 'ticket-1' });
      if (route.request().method() === 'POST') {
        created = true;
        creations++;
        return json(route, { terminal });
      }
      return json(route, { terminals: created ? [terminal] : [] });
    });
    await page.goto('/console');
    await page.getByRole('button', { name: '进入控制台' }).tap();
    await page.getByRole('button', { name: '工作', exact: true }).tap();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .tap();
    await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).tap();
    await page.getByRole('button', { name: '打开辅助工作面' }).tap();
    const aside = page.locator('.workbench-aside');
    await expect(aside.getByRole('tab', { name: '终端', exact: true })).toHaveCount(0);
    await aside.getByRole('button', { name: '添加辅助面标签页' }).tap();
    await page.getByRole('menuitem', { name: '终端', exact: true }).tap();
    const dock = page.locator('.terminal-dock');
    await expect(dock).toBeVisible();
    await expect(dock).not.toHaveAttribute('inert', '');
    await expect.poll(() => creations).toBe(1);
    const input = dock.locator('.xterm-helper-textarea');
    await expect(input).toBeAttached();
    await input.focus();
    await expect(input).toBeFocused();
    let desktopRows = 0;
    for (const viewport of [
      { width: 1600, height: 900 },
      { width: 1600, height: 1200 },
      { width: 390, height: 844 }
    ]) {
      await page.setViewportSize(viewport);
      if (viewport.width < 768) {
        await expect(aside).toBeHidden();
        await page.getByRole('button', { name: '打开辅助工作面' }).tap();
      }
      await expect(dock).toBeVisible();
      await expect
        .poll(() =>
          dock.evaluate((element) => {
            const body = element.querySelector('.admin-terminal-body')!.getBoundingClientRect();
            return Math.abs(element.getBoundingClientRect().bottom - body.bottom);
          })
        )
        .toBeLessThanOrEqual(1);
      const rows = () =>
        page.evaluate(
          () => (window.WebSocket as unknown as { resizeRows: number[] }).resizeRows.at(-1) ?? 0
        );
      await expect.poll(rows).toBeGreaterThan(0);
      if (viewport.width === 1600) {
        await expect.poll(rows).toBeGreaterThan(desktopRows);
        desktopRows = await rows();
      }
      await aside.screenshot({
        path: test.info().outputPath(`terminal-fill-${viewport.width}-${viewport.height}.png`)
      });
    }
    await aside.getByRole('tab', { name: '文件', exact: true }).tap();
    await expect(dock).not.toBeVisible();
    await aside.getByRole('button', { name: '关闭工作区工具' }).tap();
    await expect(page.getByRole('textbox', { name: '输入消息' })).toBeVisible();
    await page.getByRole('button', { name: '打开辅助工作面' }).tap();
    await aside.getByRole('tab', { name: '终端', exact: true }).tap();
    await expect(dock).toBeVisible();
    expect(creations).toBe(1);
  });
});

for (const labels of [
  { locale: 'zh-CN', enter: '进入控制台', work: '工作', sessions: '打开会话列表' },
  { locale: 'en-US', enter: 'Open console', work: 'Work', sessions: 'Open session list' }
]) {
  test(`Composer toolbar stays compact and left-aligned on mobile and desktop (${labels.locale})`, async ({
    page
  }, testInfo) => {
    const capabilities = ['history.read', 'events.live', 'turn.start', 'turn.interrupt'];
    await page.setViewportSize({ width: 1600, height: 900 });
    await mockConsoleApi(page, 'MANAGED', capabilities, [], 'GIT_WORKSPACE', true, 'RUNNING');
    await page.addInitScript(
      (locale) => localStorage.setItem('mar.locale.v2', locale),
      labels.locale
    );
    const session = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex' as const,
      externalSessionId: 'vscode-thread-1',
      activity: 'RUNNING' as const,
      control: { level: 'MANAGED', capabilities }
    };
    await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
      fulfillMockSessionWatch(page, route, session, {
        kind: 'session-watch-snapshot',
        sequence: 1,
        session,
        runs: [{ id: 'run-1', status: 'RUNNING', recoveryState: 'ACTIVE' }],
        queue: { version: 0, paused: false, items: [] },
        context: { model: 'GPT-5.6 Sol', usedTokens: 34_700, maxTokens: 100_000, percentage: 34.7 },
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
    await page.goto('/console');
    await page.getByRole('button', { name: labels.enter }).click();
    await page.getByRole('button', { name: labels.work, exact: true }).click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: 'project', exact: true })
      .click();

    const toolbar = page.locator('.composer-toolbar');
    const input = page.locator('.composer-input');
    for (const state of ['draft', 'running', 'queue'] as const) {
      if (state === 'running') {
        await page.setViewportSize({ width: 390, height: 900 });
        await page.getByRole('button', { name: labels.sessions }).click();
        await page.locator('.session-list button').first().click();
        await expect(toolbar.locator('.composer-context-button')).toHaveText('34.7%');
        await expect(toolbar.locator('.composer-stop-button')).toBeEnabled();
        await expect(toolbar.locator('.composer-send-button')).toHaveCount(0);
      }
      if (state === 'queue') {
        await input.fill('Follow-up message');
        await expect(toolbar.locator('.composer-send-button')).toBeEnabled();
      }
      for (const width of [320, 390, 767, 768, 1280, 1600]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(toolbar.locator('.composer-hint')).toHaveCount(width < 768 ? 0 : 1);
        const geometry = await toolbar.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const controls = Array.from(
            element.querySelectorAll<HTMLElement>(
              '.composer-attachment-button, .mar-ui-select__field, .composer-context-button, .composer-send-button, .composer-stop-button'
            )
          ).map((control) => {
            const rect = control.getBoundingClientRect();
            return {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom
            };
          });
          return {
            left: bounds.left,
            right: bounds.right,
            verticalSpace:
              bounds.height -
              (Math.max(...controls.map((c) => c.bottom)) -
                Math.min(...controls.map((c) => c.top))),
            controls
          };
        });
        expect(geometry.verticalSpace).toBeLessThanOrEqual(8);
        expect(
          geometry.controls[0]!.left - geometry.left,
          `${state} at ${width}px: attachment stays near the toolbar's left edge`
        ).toBeLessThanOrEqual(6);
        if (width < 768) {
          expect(
            geometry.controls[1]!.left - geometry.controls[0]!.right,
            `${state} at ${width}px: attachment stays close to the first configuration option`
          ).toBeLessThanOrEqual(8);
          for (const [index, control] of geometry.controls.entries()) {
            expect(control.left).toBeGreaterThanOrEqual(geometry.left);
            expect(control.right).toBeLessThanOrEqual(geometry.right);
            expect(
              Math.abs(
                (control.top + control.bottom) / 2 -
                  (geometry.controls[0]!.top + geometry.controls[0]!.bottom) / 2
              )
            ).toBeLessThanOrEqual(1);
            if (index > 0)
              expect(control.left).toBeGreaterThanOrEqual(geometry.controls[index - 1]!.right);
          }
        }
        if (width === 390 || width === 1600) {
          await page.locator('.composer-shell').screenshot({
            animations: 'disabled',
            path: testInfo.outputPath(`${state}-${width}.png`)
          });
        }
      }
    }
  });
}

test('Mobile conversation tools stay aligned to the right of the title bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const notificationNow = Date.now();
  await page.route('**/api/notifications', (route) =>
    json(route, {
      notifications: [
        {
          id: 'mobile-notification',
          kind: 'run',
          title: 'Run complete',
          message: 'Open the run.',
          createdAt: notificationNow,
          updatedAt: notificationNow,
          expiresAt: notificationNow + 60_000,
          read: false,
          target: {
            targetType: 'WORKSPACE_SESSION',
            nodeId: 'node-1',
            workspaceId: 'workspace-1',
            sessionId: 'session-1'
          }
        }
      ]
    })
  );
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  const notificationButton = page.getByRole('button', { name: '会话与通知' });
  const badge = notificationButton.locator('.activity-entry-count');
  await expect(badge).toHaveText('1');
  const badgePosition = await notificationButton.evaluate((button) => {
    const icon = button.querySelector('.mar-icon')!.getBoundingClientRect();
    const badge = button.querySelector('.activity-entry-count')!.getBoundingClientRect();
    return {
      horizontalOverlap: icon.right - badge.left,
      rightInset: button.getBoundingClientRect().right - badge.right,
      leftInset: badge.left - button.getBoundingClientRect().left,
      topInset: badge.top - button.getBoundingClientRect().top,
      verticalOverlap: badge.bottom - icon.top
    };
  });
  expect(badgePosition.horizontalOverlap).toBeGreaterThanOrEqual(6);
  expect(badgePosition.rightInset).toBeGreaterThanOrEqual(0);
  expect(badgePosition.leftInset).toBeGreaterThanOrEqual(0);
  expect(badgePosition.topInset).toBeGreaterThanOrEqual(0);
  expect(badgePosition.verticalOverlap).toBeGreaterThanOrEqual(6);
  const nodesButton = page.getByRole('button', { name: '工作', exact: true });
  await nodesButton.click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await expect(page.locator('.conversation-header').getByRole('heading')).toHaveText('新建会话');

  for (const width of [390, 420]) {
    await page.setViewportSize({ width, height: 844 });
    const bounds = await page.locator('.conversation-header').evaluate((header) => {
      const tools = header.querySelector('.conversation-header-tools');
      if (tools === null) throw new Error('Mobile conversation tools are missing');
      return {
        headerRight: header.getBoundingClientRect().right,
        toolsRight: tools.getBoundingClientRect().right,
        padding: Number.parseFloat(getComputedStyle(header).paddingRight)
      };
    });
    expect(Math.abs(bounds.headerRight - bounds.padding - bounds.toolsRight)).toBeLessThan(1);
  }
  await page.getByRole('button', { name: '打开会话列表' }).click();
  const newSession = page.locator('.new-session-button');
  await expect(newSession).not.toHaveClass(/\bmar-ui-button--primary\b/);
  await expect(newSession).toHaveCSS('border-top-width', '1px');
  await expect(newSession).toHaveCSS('height', '26px');
  const composer = page.getByRole('textbox', { name: '输入消息' });
  await newSession.click();
  await expect(page.locator('.new-session-button')).toBeHidden();
  await expect(composer).toBeFocused();
  await composer.fill('Mobile draft');
  await page.getByRole('button', { name: '打开会话列表' }).click();
  await page.locator('.new-session-button').click();
  await expect(page.locator('.new-session-button')).toBeHidden();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('Mobile draft');
});

test('Mobile file upload confirmation remains fully visible with accessible actions', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route(/\/api\/workspaces\/workspace-1\/uploads\/preflight(?:\?.*)?$/, (route) =>
    json(route, {
      uploads: [
        {
          name: 'mobile-upload-confirmation.json',
          status: 'READY',
          path: 'mobile-upload-confirmation.json'
        }
      ]
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  const nodesButton = page.getByRole('button', { name: '工作', exact: true });
  await nodesButton.click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await nodesButton.click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('button', { name: '打开辅助工作面' }).click();
  await expect(page.locator('.workbench-aside')).toBeVisible();
  await page.getByRole('tab', { name: '文件', exact: true }).click();
  await page.locator('.file-explorer .workspace-upload-input').setInputFiles({
    name: 'mobile-upload-confirmation.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{}')
  });

  const dialog = page.locator(
    '.upload-confirm-dialog.mar-ui-dialog, .upload-confirm-dialog .mar-ui-dialog'
  );
  await expect(dialog).toBeVisible();
  const layout = await dialog.evaluate((element) => {
    const dialogBounds = element.getBoundingClientRect();
    const buttons = [...element.querySelectorAll<HTMLButtonElement>('button')].map((button) =>
      button.getBoundingClientRect()
    );
    return {
      dialogLeft: dialogBounds.left,
      dialogRight: dialogBounds.right,
      dialogBottom: dialogBounds.bottom,
      buttons: buttons.map(({ left, right, bottom }) => ({ left, right, bottom })),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    };
  });

  expect(layout.dialogLeft).toBeGreaterThanOrEqual(0);
  expect(layout.dialogRight).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.dialogBottom).toBeLessThanOrEqual(layout.viewportHeight);
  for (const button of layout.buttons) {
    expect(button.left).toBeGreaterThanOrEqual(0);
    expect(button.right).toBeLessThanOrEqual(layout.viewportWidth);
    expect(button.bottom).toBeLessThanOrEqual(layout.viewportHeight);
  }
  await expect(dialog.getByRole('button', { name: '取消' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '开始上传' })).toBeVisible();
});

test('Mobile Composer anchors to the visual viewport bottom with matching conversation spacing', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route('**/api/notifications', (route) => json(route, { notifications: [] }));

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await expect(page.getByRole('button', { name: 'Web 性能诊断' })).toHaveCount(0);
  const nodesButton = page.getByRole('button', { name: '工作', exact: true });
  await nodesButton.click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();

  await page.getByRole('button', { name: '打开会话列表' }).click();
  await page.locator('.session-list button').first().click();
  await expect(page.locator('.conversation-empty')).toHaveCount(0);
  await expect(page.locator('.composer')).toHaveCSS('position', 'fixed');
  const reservedHeightDifference = () =>
    page.locator('.composer-host').evaluate((host) => {
      const composer = host.querySelector('.composer')!;
      return Math.abs(
        host.getBoundingClientRect().height - composer.getBoundingClientRect().height
      );
    });
  await expect.poll(reservedHeightDifference).toBeLessThanOrEqual(1);

  const layout = await page.evaluate(() => {
    const composerHost = document.querySelector<HTMLElement>('.composer-host');
    const composer = document.querySelector<HTMLElement>('.composer');
    const conversationScroll = document.querySelector<HTMLElement>('.conversation-scroll-region');
    if (composerHost === null || composer === null || conversationScroll === null)
      throw new Error('Composer layout is unavailable');
    const hostBounds = composerHost.getBoundingClientRect();
    const composerBounds = composer.getBoundingClientRect();
    const scrollBounds = conversationScroll.getBoundingClientRect();
    return {
      documentHeight: document.scrollingElement?.scrollHeight ?? 0,
      viewportHeight: window.innerHeight,
      composerPosition: getComputedStyle(composer).position,
      composerTop: composerBounds.top,
      composerBottom: composerBounds.bottom,
      composerHeight: composerBounds.height,
      hostHeight: hostBounds.height,
      scrollBottom: scrollBounds.bottom
    };
  });

  expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(layout.composerPosition).toBe('fixed');
  expect(layout.composerBottom).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(Math.abs(layout.hostHeight - layout.composerHeight)).toBeLessThanOrEqual(1);
  expect(layout.scrollBottom).toBeLessThanOrEqual(layout.composerTop + 1);

  const navigationTop = await page
    .getByTestId('workbench-brand')
    .evaluate((element) => element.getBoundingClientRect().top);
  await page.setViewportSize({ width: 390, height: 600 });
  await expect
    .poll(() =>
      page.locator('.composer').evaluate((element) => element.getBoundingClientRect().bottom)
    )
    .toBeCloseTo(600, 2);
  await expect.poll(reservedHeightDifference).toBeLessThanOrEqual(1);
  expect(
    await page
      .getByTestId('workbench-brand')
      .evaluate((element) => element.getBoundingClientRect().top)
  ).toBe(navigationTop);
});

test('Mobile Workbench keeps one conversation surface and opens sessions, files, and terminals as tool layers', async ({
  page
}) => {
  test.setTimeout(90_000);
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'turn.start'],
    writes,
    'GIT_WORKSPACE',
    true,
    undefined,
    undefined,
    '0.9.12'
  );
  const notificationNow = Date.now();
  await page.route('**/api/notifications', (route) =>
    json(route, {
      notifications: [
        {
          id: 'mobile-notification',
          kind: 'run',
          title: '后台运行已完成',
          message: '点击查看相关会话。',
          createdAt: notificationNow,
          updatedAt: notificationNow,
          expiresAt: notificationNow + 60_000,
          read: false,
          target: {
            targetType: 'WORKSPACE_SESSION',
            nodeId: 'node-1',
            workspaceId: 'workspace-1',
            sessionId: 'session-1',
            sessionName: 'session-1'
          }
        }
      ]
    })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) => {
    const directory = new URL(route.request().url()).searchParams.get('path');
    return json(route, {
      files: {
        entries:
          directory === 'src'
            ? [{ path: 'src/main.ts', name: 'main.ts', kind: 'FILE', size: 25, modifiedAt: 1 }]
            : [
                { path: 'AGENTS.md', name: 'AGENTS.md', kind: 'FILE', size: 25, modifiedAt: 1 },
                { path: 'src', name: 'src', kind: 'DIRECTORY', size: null, modifiedAt: 1 }
              ],
        nextCursor: null,
        truncated: false
      }
    });
  });
  await page.route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) =>
    json(route, {
      file: {
        path: new URL(route.request().url()).searchParams.get('path') ?? 'src/main.ts',
        encoding: 'utf-8',
        size: Buffer.byteLength('# Agent constraints\n'),
        content: '# Agent constraints\n',
        truncated: false,
        nextOffset: null,
        revision: 'a'.repeat(64)
      }
    })
  );
  await page.route('**/api/workspaces/workspace-1/symbols/prepare?**', (route) =>
    json(route, { preparation: { state: 'UNAVAILABLE' } })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/git\/fetch(?:\?.*)?$/, (route) =>
    json(route, { fetchFailed: false, updated: false })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/changes(?:\?.*)?$/, (route) =>
    json(route, {
      branch: 'main',
      changes: [
        { path: 'src/main.ts', state: 'UNSTAGED', change: 'MODIFIED', diffAvailable: true }
      ],
      repositories: [
        {
          repositoryPath: '',
          repositoryName: 'project',
          source: 'ROOT',
          branch: 'main',
          changes: [
            { path: 'src/main.ts', state: 'UNSTAGED', change: 'MODIFIED', diffAvailable: true }
          ]
        }
      ]
    })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/changes\/diff(?:\?.*)?$/, (route) =>
    json(route, {
      diff: {
        binary: false,
        afterText: 'export const answer = 42;\n',
        text: 'diff --git a/src/main.ts b/src/main.ts\n@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42;\n'
      }
    })
  );
  let mobileTerminalCreated = false;
  const terminalLifecycleRequests: string[] = [];
  await page.route('**/api/terminals**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/terminals' && route.request().method() === 'POST') {
      terminalLifecycleRequests.push('create');
      mobileTerminalCreated = true;
      return json(route, {
        terminal: {
          id: 'terminal-1',
          workspaceId: 'workspace-1',
          profileId: 'default',
          state: 'RUNNING',
          latestSequence: 0
        }
      });
    }
    if (path === '/api/terminals/terminal-1/attach-ticket')
      return json(route, { ticket: 'ticket-1' });
    if (path === '/api/terminals/terminal-1' && route.request().method() === 'DELETE') {
      terminalLifecycleRequests.push('close');
      mobileTerminalCreated = false;
      return json(route, {
        terminal: {
          id: 'terminal-1',
          workspaceId: 'workspace-1',
          profileId: 'default',
          state: 'CLOSED',
          latestSequence: 0
        }
      });
    }
    if (path === '/api/terminals') {
      return json(route, {
        terminals: mobileTerminalCreated
          ? [
              {
                id: 'terminal-1',
                workspaceId: 'workspace-1',
                profileId: 'default',
                state: 'RUNNING',
                latestSequence: 0
              }
            ]
          : []
      });
    }
    return route.fallback();
  });
  await page.route('**/api/agent-sessions/session-1/watch', (route) =>
    json(route, {
      session: {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'vscode-thread-1',
        activity: 'IDLE',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
      },
      watch: { expiresAt: 1_900_000_015_000 }
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  const nodesButton = page.getByRole('button', { name: '工作', exact: true });
  await expect(nodesButton).toBeVisible();
  await nodesButton.click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await expect(page.locator('.workspace-tree')).toBeVisible();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();

  const brand = page.getByTestId('workbench-brand');
  await expect(page.locator('html')).toHaveCSS('font-size', '16px');
  await page.locator('html').evaluate((element) => {
    element.setAttribute('data-theme', 'dark');
    element.classList.add('dark');
  });
  await expect(brand).toHaveCSS('border-top-width', '0px');
  await expect(brand).toHaveCSS('border-bottom-width', '1px');
  const themeBorder = await brand.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--mar-border-default)';
    element.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await expect(brand).toHaveCSS('border-bottom-color', themeBorder);
  expect(
    await page
      .locator('html')
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--mar-compact-control-size').trim()
      )
  ).toBe('26px');
  expect(
    await page
      .locator('html')
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--mar-font-size-body').trim()
      )
  ).toBe('13px');
  const logo = brand.getByRole('button', { name: 'MyAgentRoam 菜单' });
  await expect(logo.locator('img')).toBeVisible();
  await expect(logo.locator('svg')).toHaveCount(0);
  await expect(brand.getByText('MyAgentRoam')).not.toBeVisible();
  await expect(brand.locator('.brand-version')).not.toBeVisible();
  await expect(page.getByRole('link', { name: '帮助', exact: true })).toHaveCount(0);
  await logo.click();
  const brandMenu = page.getByRole('menu', { name: 'MyAgentRoam 菜单' });
  await expect(brandMenu.getByRole('menuitem')).toHaveText([
    `版本 v${currentVersion}`,
    'Web性能',
    '帮助'
  ]);
  await brandMenu.getByRole('menuitem', { name: 'Web性能' }).click();
  const diagnostics = page.getByRole('dialog', { name: 'Web 性能诊断' });
  await expect(brandMenu).toBeHidden();
  await expect(diagnostics.getByText(/DOM [1-9]\d* · 消息卡片/u)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(diagnostics).toHaveCount(0);
  await expect(logo).toBeFocused();

  const notificationsButton = page.getByRole('button', { name: '会话与通知' });
  await expect(notificationsButton.locator('.workbench-notification-trigger-label')).toHaveCount(0);
  const [nodesGeometry, notificationGeometry, brandGeometryBox] = await Promise.all([
    nodesButton.boundingBox(),
    notificationsButton.boundingBox(),
    brand.boundingBox()
  ]);
  expect(notificationGeometry?.y).toBe(nodesGeometry?.y);
  expect(notificationGeometry?.height).toBe(nodesGeometry?.height);
  await expect(nodesButton.locator('svg')).toHaveCSS('width', '22px');
  await expect(nodesButton.locator('svg')).toHaveCSS('height', '22px');
  expect(
    (notificationGeometry?.y ?? Infinity) + (notificationGeometry?.height ?? 0)
  ).toBeLessThanOrEqual((brandGeometryBox?.y ?? 0) + (brandGeometryBox?.height ?? 0));
  await notificationsButton.click();
  const notificationCenter = page.locator('.workbench-activity-panel.mobile-mode');
  await notificationCenter.getByRole('tab', { name: '通知', exact: true }).click();
  await expect(notificationCenter.getByText('后台运行已完成', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      notificationCenter.evaluate((element) => {
        const drawer = document.querySelector<HTMLElement>('.workspace-tree');
        const headerHeight = Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--mar-sidebar-header-height')
        );
        return (
          drawer?.contains(element) &&
          element.getBoundingClientRect().top >= headerHeight &&
          element.getBoundingClientRect().bottom <= window.innerHeight
        );
      })
    )
    .toBe(true);
  await notificationsButton.click();
  await expect(notificationsButton).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账户安全' })).toBeVisible();
  await expect(notificationsButton).toHaveAttribute('aria-expanded', 'false');
  await notificationsButton.click();
  await expect(notificationsButton).toHaveAttribute('aria-expanded', 'true');
  expect(pageErrors).toEqual([]);
  await expect(notificationCenter).toBeVisible();
  await notificationCenter
    .locator('.workbench-notification-list > li')
    .first()
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByRole('button', { name: '工作', exact: true })).toHaveClass(/active/);
  await expect(page.getByRole('button', { name: '打开会话列表' })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开辅助工作面' })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开文件', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开终端', exact: true })).toHaveCount(0);
  await page
    .locator('.conversation-header')
    .screenshot({ path: test.info().outputPath('mobile-more-entry.png'), animations: 'disabled' });
  await expect(page.locator('.workbench-header')).toHaveCount(0);
  await expect(page.locator('.conversation-sidebar')).not.toBeVisible();
  await expect(page.locator('.workspace-aside')).not.toBeVisible();
  await expect(page.locator('.terminal-dock')).not.toBeVisible();

  const initialLayout = await page.evaluate(() => {
    const composer = document.querySelector<HTMLElement>('.composer');
    if (composer === null) throw new Error('Composer 未渲染');
    return {
      documentHeight: document.scrollingElement?.scrollHeight ?? 0,
      viewportHeight: window.innerHeight,
      composerBottom: composer.getBoundingClientRect().bottom
    };
  });
  expect(initialLayout.documentHeight).toBeLessThanOrEqual(initialLayout.viewportHeight + 1);
  expect(initialLayout.composerBottom).toBeLessThanOrEqual(initialLayout.viewportHeight + 1);
  await expect(page.locator('body')).toHaveCSS('overflow-y', 'hidden');

  const mobileComposer = page.getByRole('textbox', { name: '输入消息' });
  await expect(mobileComposer).toHaveAttribute('enterkeyhint', 'enter');
  await mobileComposer.fill('第一行');
  await mobileComposer.press('Enter');
  await expect(mobileComposer).toHaveValue('第一行\n');
  await expect(page.getByText(/Enter 发送|Enter 排队/)).toHaveCount(0);
  await expect(page.locator('.composer-mobile-select-label')).toHaveCount(0);
  const composerRow = await page.locator('.composer-toolbar').evaluate((toolbar) => {
    const toolbarRect = toolbar.getBoundingClientRect();
    const controls = [
      '.composer-attachment-button',
      '.composer-model-slot',
      '.composer-access-slot',
      '.composer-send-button'
    ].map((selector) => {
      const element = toolbar.querySelector<HTMLElement>(selector);
      if (element === null) throw new Error(`缺少 Composer 控件：${selector}`);
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
    });
    return { toolbar: { left: toolbarRect.left, right: toolbarRect.right }, controls };
  });
  const controlCenters = composerRow.controls.map((control) => (control.top + control.bottom) / 2);
  const sendControl = composerRow.controls.at(-1);
  if (sendControl === undefined) throw new Error('发送按钮未渲染');
  expect(Math.max(...controlCenters) - Math.min(...controlCenters)).toBeLessThanOrEqual(1);
  expect(sendControl.right - sendControl.left).toBe(28);
  expect(sendControl.bottom - sendControl.top).toBe(28);
  expect(composerRow.controls.every((control) => control.left >= composerRow.toolbar.left)).toBe(
    true
  );
  expect(composerRow.controls.every((control) => control.right <= composerRow.toolbar.right)).toBe(
    true
  );

  const closeMobileWorkspaceSurface = async () => {
    const scrim = page.locator('.workspace-surface-scrim');
    await expect(scrim).toBeVisible();
    const asideClose = page
      .locator('.workspace-aside')
      .getByRole('button', { name: '关闭工作区工具' });
    if (await asideClose.isVisible()) {
      await asideClose.click();
      await expect(scrim).toHaveCount(0);
      return;
    }
    const bounds = await scrim.boundingBox();
    if (bounds === null) throw new Error('工作区工具遮罩未生成可点击区域');
    await page.mouse.click(bounds.x + bounds.width - 12, bounds.y + 64);
    await expect(scrim).toHaveCount(0);
  };

  await page.getByRole('button', { name: '打开会话列表' }).click();
  await expect(page.locator('.conversation-sidebar')).toBeVisible();
  await expect(page.locator('.conversation-sidebar')).toHaveCSS('top', '46px');
  await expect(page.getByRole('button', { name: '返回对话' })).toHaveCount(0);
  await closeMobileWorkspaceSurface();
  await expect(page.locator('.conversation-sidebar')).not.toBeVisible();
  await expect(
    page.locator('.conversation-header').getByRole('heading').locator('.conversation-title-text')
  ).toHaveText('新建会话');

  await page.getByRole('button', { name: '打开辅助工作面' }).click();
  await expect(page.locator('.workspace-aside')).toBeVisible();
  await expect(page.getByRole('tab', { name: '文件', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.locator('.workspace-aside')).toHaveCSS('top', '46px');
  const inspectorBounds = await page.locator('.workspace-aside').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { bottom: rect.bottom, viewportHeight: window.innerHeight };
  });
  expect(inspectorBounds.bottom).toBe(inspectorBounds.viewportHeight);
  await page.getByRole('button', { name: '刷新文件' }).click();
  await page.getByRole('treeitem', { name: 'AGENTS.md', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'AGENTS.md 文件预览' });
  const previewSurface = preview.locator('[data-mar-dialog-panel]');
  await expect(preview).toHaveCSS('position', 'fixed');
  await expect(preview).toBeVisible();
  await expect
    .poll(() =>
      previewSurface.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: window.innerWidth,
          height: window.innerHeight
        };
      })
    )
    .toEqual({
      left: 0,
      top: 0,
      right: 390,
      bottom: 844,
      width: 390,
      height: 844
    });
  await expect(preview.locator('.mobile-preview-actions')).toBeVisible();
  await expect(
    preview.locator('.mobile-preview-actions').getByRole('button', { name: '下载文件' })
  ).toBeVisible();
  await expect(preview.getByText(/^只读文件 · /u)).toBeVisible();
  await expect(
    preview.locator('.mobile-preview-actions').getByRole('button', { name: 'Markdown 预览设置' })
  ).toBeVisible();
  await expect(preview.getByRole('button', { name: '关闭预览', exact: true })).toBeVisible();
  const mobilePreviewActionBounds = await page
    .getByRole('button', { name: '关闭文件窗口', exact: true })
    .evaluate((close) => {
      const rect = close.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth
      };
    });
  expect(mobilePreviewActionBounds.left).toBeGreaterThanOrEqual(0);
  expect(mobilePreviewActionBounds.top).toBeGreaterThanOrEqual(0);
  expect(mobilePreviewActionBounds.right).toBeLessThanOrEqual(
    mobilePreviewActionBounds.viewportWidth
  );
  expect(mobilePreviewActionBounds.bottom).toBeLessThanOrEqual(
    mobilePreviewActionBounds.viewportHeight
  );
  await preview.getByRole('button', { name: '收起文件预览快捷操作' }).click();
  await expect(preview.locator('.workspace-floating-actions-body')).toHaveAttribute(
    'aria-hidden',
    'true'
  );
  await preview.getByRole('button', { name: '展开文件预览快捷操作' }).click();
  await expect(preview.locator('.workspace-floating-actions-body')).toHaveAttribute(
    'aria-hidden',
    'false'
  );
  await preview
    .locator('.mobile-preview-actions')
    .getByRole('button', { name: '文件内查找' })
    .click();
  await expect(preview.getByRole('search', { name: '文件内查找' })).toBeVisible();
  await preview.getByRole('button', { name: '收起文件预览快捷操作' }).click();
  await preview.getByRole('button', { name: '关闭查找' }).click();
  await page.getByRole('button', { name: '关闭文件窗口', exact: true }).click();

  await page.getByRole('tab', { name: 'Git 变更', exact: true }).click();
  await page.getByRole('button', { name: '查看 src/main.ts 的 Diff' }).click();
  const diff = page.getByRole('dialog', { name: 'src/main.ts Git 差异' });
  const diffSurface = diff.locator('[data-mar-dialog-panel]');
  await expect(diff).toHaveCSS('position', 'fixed');
  await expect(diff).toBeVisible();
  await expect
    .poll(() =>
      diffSurface.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: window.innerWidth,
          height: window.innerHeight
        };
      })
    )
    .toEqual({
      left: 0,
      top: 0,
      right: 390,
      bottom: 844,
      width: 390,
      height: 844
    });
  await expect(diff.locator('.mobile-preview-actions')).toBeVisible();
  const diffSummary = diff.getByLabel('Diff 摘要');
  await expect(diffSummary.getByText('文件 1 / 1', { exact: true })).toBeVisible();
  await expect(diffSummary.getByText('差异 1 / 1', { exact: true })).toBeVisible();
  const diffNavigation = diff.locator('.diff-mobile-navigation');
  const diffUtilities = diff.locator('.diff-mobile-utilities');
  for (const name of ['上一个文件', '下一个文件', '上一个差异', '下一个差异']) {
    await expect(diffNavigation.getByRole('button', { name })).toBeVisible();
  }
  const [navigationBounds, utilityBounds] = await Promise.all([
    diffNavigation.boundingBox(),
    diffUtilities.boundingBox()
  ]);
  expect((navigationBounds?.y ?? Infinity) + (navigationBounds?.height ?? 0)).toBeLessThanOrEqual(
    utilityBounds?.y ?? 0
  );
  await expect(diffUtilities.getByRole('button', { name: '下载 Diff' })).toBeVisible();
  await diff.getByRole('button', { name: '收起文件预览快捷操作' }).click();
  await expect(diff.locator('.workspace-floating-actions-body')).toHaveAttribute(
    'aria-hidden',
    'true'
  );
  await diff.getByRole('button', { name: '展开文件预览快捷操作' }).click();
  await expect(diff.locator('.workspace-floating-actions-body')).toHaveAttribute(
    'aria-hidden',
    'false'
  );
  await diffUtilities.getByRole('button', { name: '文件内查找' }).click();
  await expect(diff.getByRole('search', { name: '文件内查找' })).toBeVisible();
  await diff.getByRole('button', { name: '收起文件预览快捷操作' }).click();
  await diff.getByRole('button', { name: '关闭查找' }).click();
  await expect(diff.getByRole('button', { name: '关闭预览', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭文件窗口', exact: true }).click();
  await closeMobileWorkspaceSurface();
  await expect(page.locator('.workspace-aside')).not.toBeVisible();

  await page.getByRole('button', { name: '打开辅助工作面' }).click();
  await page.locator('.workspace-aside').getByRole('button', { name: '添加辅助面标签页' }).click();
  await page.getByRole('menuitem', { name: '终端', exact: true }).click();
  await expect(page.locator('.terminal-dock')).toBeVisible();
  const terminalDock = page.locator('.terminal-dock');
  const asidePanel = page.locator('.workspace-aside > .workbench-aside');
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 568 },
    { width: 430, height: 400 }
  ]) {
    await page.setViewportSize(viewport);
    await expect(terminalDock).toBeVisible();
    await expect
      .poll(() =>
        page.locator('.workspace-aside').evaluate((element) => element.getAnimations().length)
      )
      .toBe(0);
    const [dockBounds, asideBounds] = await Promise.all([
      terminalDock.boundingBox(),
      asidePanel.boundingBox()
    ]);
    expect(dockBounds).not.toBeNull();
    expect(asideBounds).not.toBeNull();
    const borderLeft = await asidePanel.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).borderLeftWidth)
    );
    expect(dockBounds!.x).toBeCloseTo(asideBounds!.x + borderLeft, 0);
    expect(dockBounds!.width).toBeCloseTo(asideBounds!.width - borderLeft, 0);
    expect(dockBounds!.y).toBeGreaterThanOrEqual(asideBounds!.y);
    expect(dockBounds!.y + dockBounds!.height).toBeCloseTo(viewport.height, 0);
    await expect(page.locator('.admin-terminal-body')).toBeVisible();
    await expect(terminalDock.locator('.admin-terminal-actions')).toHaveCount(0);
    const terminalChrome = await terminalDock.evaluate((dock) => {
      const header = dock.querySelector<HTMLElement>('.admin-terminal-header')!;
      const tabs = dock.querySelector<HTMLElement>('.terminal-tabs')!;
      const body = dock.querySelector<HTMLElement>('.admin-terminal-body')!;
      return {
        headerHeight: tabs.getBoundingClientRect().top - header.getBoundingClientRect().top,
        gap: body.getBoundingClientRect().top - tabs.getBoundingClientRect().bottom,
        height: body.getBoundingClientRect().top - header.getBoundingClientRect().top
      };
    });
    expect(terminalChrome.headerHeight).toBeLessThanOrEqual(36);
    expect(terminalChrome.gap).toBeGreaterThanOrEqual(0);
    expect(terminalChrome.gap).toBeLessThanOrEqual(12);
    expect(terminalChrome.height).toBeLessThanOrEqual(76);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.terminal-tab:not(.terminal-tab-add)')).toHaveCount(1);
  await expect(page.locator('.terminal-tab-select')).toHaveCSS('font-size', '13px');
  await expect(page.locator('.terminal-tab-select')).toHaveCSS('font-weight', '500');
  await expect(page.locator('.admin-terminal-body')).toBeVisible();
  const terminalFill = await page.locator('.terminal-dock').evaluate((dock) => {
    const body = dock.querySelector<HTMLElement>('.admin-terminal-body');
    if (body === null) return null;
    const dockBounds = dock.getBoundingClientRect();
    const bodyBounds = body.getBoundingClientRect();
    return {
      bottomGap: Math.round(dockBounds.bottom - bodyBounds.bottom),
      bodyHeight: Math.round(bodyBounds.height)
    };
  });
  expect(terminalFill).not.toBeNull();
  expect(terminalFill?.bottomGap).toBeLessThanOrEqual(1);
  expect(terminalFill?.bodyHeight).toBeGreaterThan(300);
  await page.screenshot({ path: test.info().outputPath('mobile-terminal-bottom-sheet.png') });
  expect(terminalLifecycleRequests).toEqual(['create']);
  await closeMobileWorkspaceSurface();
  await expect(terminalDock).not.toBeVisible();
  expect(mobileTerminalCreated).toBe(true);
  await page.getByRole('button', { name: '打开辅助工作面' }).click();
  await expect(terminalDock).toBeVisible();
  await expect(page.locator('.terminal-tab:not(.terminal-tab-add)')).toHaveCount(1);
  expect(terminalLifecycleRequests).toEqual(['create']);
  await page.getByRole('button', { name: '关闭终端 1' }).click();
  await expect(page.locator('.terminal-dock')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '关闭工作区工具' })).toHaveCount(0);
  expect(terminalLifecycleRequests).toEqual(['create', 'close']);
  await expect(page.getByRole('textbox', { name: '输入消息' })).toBeVisible();

  const header = page.locator('.conversation-header');
  await expect(header.locator('.conversation-title-text')).toHaveCSS('white-space', 'nowrap');
  await expect(header.locator('.conversation-title-button')).toBeVisible();
  await page.getByRole('button', { name: '打开会话列表', exact: true }).click();
  await page
    .locator('.conversation-sidebar')
    .getByRole('button', { name: '新建会话', exact: true })
    .click();
  await expect(header).toHaveClass(/conversation-header-draft/);
  await expect(header.locator('.conversation-title-button')).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('Mobile messages entered during a Run can be sent to the queue', async ({ page }) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'events.live', 'turn.start', 'turn.steer', 'turn.interrupt'],
    writes
  );
  await page.route('**/api/agent-sessions/session-1/runs?nodeId=node-1', (route) =>
    json(route, {
      runs: [
        {
          id: 'run-1',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          status: 'RUNNING',
          recoveryState: 'ACTIVE',
          clientMessageId: 'working-message'
        }
      ]
    })
  );
  await page.route('**/api/agent-sessions/session-1/messages', (route) =>
    write(route, writes, {
      session: {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'vscode-thread-1',
        activity: 'RUNNING',
        control: {
          level: 'MANAGED',
          capabilities: [
            'history.read',
            'events.live',
            'turn.start',
            'turn.steer',
            'turn.interrupt'
          ]
        }
      },
      run: {
        id: 'run-1',
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'working-message'
      },
      queueItemId: 'queue-item-2',
      delivery: 'QUEUED'
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  const work = page.getByRole('button', { name: '工作', exact: true });
  const tree = page.locator('.workspace-tree');
  await work.click();
  await tree.getByRole('button', { name: /node-1/ }).click();
  await expect(work).toHaveAttribute('aria-expanded', 'true');
  await tree.getByRole('button', { name: 'project' }).click();
  await page.getByRole('button', { name: '打开会话列表' }).click();
  await page.locator('.session-list button').first().click();

  const input = page.getByRole('textbox', { name: '输入消息' });
  await expect(page.getByRole('button', { name: '停止运行' })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止运行' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '发送' })).toHaveCount(0);
  await input.fill('移动端排队消息');
  await expect(page.getByRole('button', { name: '停止运行' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送' })).toBeVisible();
  await page.getByRole('button', { name: '发送' }).click();

  await emitMockSessionEvent(page, 'queue', {
    sessionId: 'session-1',
    queue: {
      version: 1,
      paused: false,
      items: [
        {
          queueItemId: 'queue-item-2',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'codex',
          clientMessageId: 'queue-message-2',
          sessionTitle: '现有会话',
          content: '移动端排队消息',
          createdAt: 2
        }
      ]
    }
  });
  const pendingWork = page.getByLabel('待执行工作');
  await expect(pendingWork).toContainText('移动端排队消息');
  async function expectQueueBottomAligned(): Promise<void> {
    const bottomGap = await pendingWork.evaluate((section) => {
      const lastItem = section.querySelector('ol')!.lastElementChild!;
      return (
        section.getBoundingClientRect().bottom -
        parseFloat(getComputedStyle(section).borderBottomWidth) -
        lastItem.getBoundingClientRect().bottom
      );
    });
    expect(bottomGap).toBeCloseTo(0, 1);
    await pendingWork.screenshot({
      path: test.info().outputPath('queue-bottom-' + page.viewportSize()!.width + '.png')
    });
  }
  await expectQueueBottomAligned();
  const mobileQueueLayout = await pendingWork.locator('.queue-item').evaluate((item) => {
    const kindElement = item.querySelector('.work-item-kind');
    const contentElement = item.querySelector('.work-item-content');
    const actionsElement = item.querySelector('.queue-item-actions');
    const kind = kindElement?.getBoundingClientRect();
    const content = contentElement?.getBoundingClientRect();
    const actions = actionsElement?.getBoundingClientRect();
    const edit = Array.from(item.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '编辑'
    );
    const runNow = Array.from(item.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '执行'
    );
    return {
      itemHeight: item.getBoundingClientRect().height,
      kindCenter: kind === undefined ? undefined : kind.top + kind.height / 2,
      kindRight: kind?.right,
      contentLeft: content?.left,
      contentCenter: content === undefined ? undefined : content.top + content.height / 2,
      actionsCenter: actions === undefined ? undefined : actions.top + actions.height / 2,
      contentFontSize:
        contentElement === null ? undefined : getComputedStyle(contentElement).fontSize,
      kindFontSize: kindElement === null ? undefined : getComputedStyle(kindElement).fontSize,
      actionLabelDisplay:
        edit === undefined
          ? undefined
          : getComputedStyle(edit.querySelector('.work-item-action-label')!).display,
      editColor: edit === undefined ? undefined : getComputedStyle(edit).color,
      runNowColor: runNow === undefined ? undefined : getComputedStyle(runNow).color
    };
  });
  expect(Math.abs(mobileQueueLayout.kindCenter! - mobileQueueLayout.contentCenter!)).toBeLessThan(
    3
  );
  expect(
    Math.abs(mobileQueueLayout.actionsCenter! - mobileQueueLayout.contentCenter!)
  ).toBeLessThan(3);
  expect(mobileQueueLayout.contentFontSize).toBe('11px');
  expect(mobileQueueLayout.kindFontSize).toBe(mobileQueueLayout.contentFontSize);
  expect(mobileQueueLayout.contentLeft! - mobileQueueLayout.kindRight!).toBeLessThanOrEqual(8);
  expect(mobileQueueLayout.itemHeight).toBeLessThanOrEqual(32);
  expect(mobileQueueLayout.actionLabelDisplay).toBe('inline');
  expect(mobileQueueLayout.runNowColor).toBe(mobileQueueLayout.editColor);
  const activeGoalSession = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    runner: 'codex',
    externalSessionId: 'vscode-thread-1',
    activity: 'RUNNING',
    control: {
      level: 'MANAGED',
      capabilities: ['history.read', 'events.live', 'turn.start', 'turn.steer', 'turn.interrupt']
    },
    commandStates: [
      {
        commandId: 'goal',
        active: true,
        label: 'Goal',
        detail: 'Goal is active.',
        closable: true,
        closeInput: '/goal --clear',
        goal: {
          id: 'goal-1',
          objective: '持续处理当前目标',
          revision: 1,
          status: 'active',
          turns: 1
        }
      }
    ]
  };
  await emitMockSessionEvent(page, 'session', { session: activeGoalSession });
  await expect(pendingWork.locator('.goal-kind')).toHaveText('目标');
  const mobileGoalLayout = await pendingWork.locator('.goal-card').evaluate((item) => {
    const textCenter = (selector: string): number | undefined => {
      const element = item.querySelector(selector);
      if (element === null) return undefined;
      const range = document.createRange();
      range.selectNodeContents(element);
      const bounds = range.getBoundingClientRect();
      return bounds.top + bounds.height / 2;
    };
    return {
      itemHeight: item.getBoundingClientRect().height,
      kindCenter: textCenter('.goal-kind'),
      objectiveCenter: textCenter('.goal-objective'),
      actionsCenter: textCenter('.goal-actions'),
      kindFontSize: getComputedStyle(item.querySelector('.goal-kind')!).fontSize,
      objectiveFontSize: getComputedStyle(item.querySelector('.goal-objective')!).fontSize
    };
  });
  expect(Math.abs(mobileGoalLayout.kindCenter! - mobileGoalLayout.objectiveCenter!)).toBeLessThan(
    3
  );
  expect(
    Math.abs(mobileGoalLayout.actionsCenter! - mobileGoalLayout.objectiveCenter!)
  ).toBeLessThan(3);
  expect(mobileGoalLayout.kindFontSize).toBe(mobileGoalLayout.objectiveFontSize);
  expect(mobileGoalLayout.itemHeight).toBeLessThanOrEqual(32);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expectQueueBottomAligned();
  const desktopQueueLayout = await pendingWork.locator('.queue-item').evaluate((item) => {
    const kind = item.querySelector('.work-item-kind');
    const content = item.querySelector('.work-item-content');
    return {
      itemHeight: item.getBoundingClientRect().height,
      kindRight: kind?.getBoundingClientRect().right,
      contentLeft: content?.getBoundingClientRect().left,
      kindFontSize: kind === null ? undefined : getComputedStyle(kind).fontSize,
      contentFontSize: content === null ? undefined : getComputedStyle(content).fontSize
    };
  });
  expect(desktopQueueLayout.kindFontSize).toBe(desktopQueueLayout.contentFontSize);
  expect(desktopQueueLayout.contentLeft! - desktopQueueLayout.kindRight!).toBeLessThanOrEqual(8.05);
  expect(desktopQueueLayout.itemHeight).toBeLessThanOrEqual(32);
  const desktopGoalLayout = await pendingWork.locator('.goal-card').evaluate((item) => {
    const textCenter = (selector: string): number | undefined => {
      const element = item.querySelector(selector);
      if (element === null) return undefined;
      const range = document.createRange();
      range.selectNodeContents(element);
      const bounds = range.getBoundingClientRect();
      return bounds.top + bounds.height / 2;
    };
    return {
      itemHeight: item.getBoundingClientRect().height,
      kindCenter: textCenter('.goal-kind'),
      objectiveCenter: textCenter('.goal-objective'),
      actionsCenter: textCenter('.goal-actions'),
      kindFontSize: getComputedStyle(item.querySelector('.goal-kind')!).fontSize,
      objectiveFontSize: getComputedStyle(item.querySelector('.goal-objective')!).fontSize
    };
  });
  expect(Math.abs(desktopGoalLayout.kindCenter! - desktopGoalLayout.objectiveCenter!)).toBeLessThan(
    3
  );
  expect(
    Math.abs(desktopGoalLayout.actionsCenter! - desktopGoalLayout.objectiveCenter!)
  ).toBeLessThan(3);
  expect(desktopGoalLayout.kindFontSize).toBe(desktopGoalLayout.objectiveFontSize);
  expect(desktopGoalLayout.itemHeight).toBeLessThanOrEqual(32);
  await page.setViewportSize({ width: 390, height: 844 });
  const goalCard = pendingWork.locator('.goal-card');
  await goalCard.getByRole('button', { name: '编辑', exact: true }).click();
  const goalEditor = goalCard.locator('.goal-objective-input textarea');
  await expect(goalEditor).toHaveCSS('font-size', mobileGoalLayout.objectiveFontSize);
  await expect(goalEditor).toHaveValue('持续处理当前目标');
  await goalCard.getByRole('button', { name: '取消', exact: true }).click();
  await expect(goalCard.locator('.goal-objective')).toHaveText('持续处理当前目标');
  await pendingWork.locator('.queue-item').getByRole('button', { name: '编辑' }).click();
  const mobileQueueEditLayout = await pendingWork
    .locator('.queue-item.editing')
    .evaluate((item) => {
      const kind = item.querySelector('.work-item-kind')?.getBoundingClientRect();
      const input = item.querySelector('textarea')?.getBoundingClientRect();
      const actions = item.querySelector('.queue-item-actions')?.getBoundingClientRect();
      const section = item.closest('.composer-queue')?.getBoundingClientRect();
      const itemBounds = item.getBoundingClientRect();
      return {
        itemHeight: itemBounds.height,
        inputHeight: input?.height,
        kindCenter: kind === undefined ? undefined : kind.top + kind.height / 2,
        inputCenter: input === undefined ? undefined : input.top + input.height / 2,
        actionsCenter: actions === undefined ? undefined : actions.top + actions.height / 2,
        bottomGap: section === undefined ? undefined : section.bottom - itemBounds.bottom
      };
    });
  expect(mobileQueueEditLayout.itemHeight).toBeLessThanOrEqual(32);
  expect(mobileQueueEditLayout.inputHeight).toBeLessThanOrEqual(28);
  expect(
    Math.abs(mobileQueueEditLayout.kindCenter! - mobileQueueEditLayout.inputCenter!)
  ).toBeLessThan(3);
  expect(
    Math.abs(mobileQueueEditLayout.actionsCenter! - mobileQueueEditLayout.inputCenter!)
  ).toBeLessThan(3);
  expect(mobileQueueEditLayout.bottomGap).toBeLessThanOrEqual(5);
  const queueEditor = pendingWork.locator('.composer-queue-input textarea');
  await expect(queueEditor).toHaveCSS('font-size', mobileQueueLayout.contentFontSize!);
  await queueEditor.fill('第一行\n第二行');
  await expect
    .poll(async () => (await queueEditor.boundingBox())?.height)
    .toBeGreaterThan(mobileQueueEditLayout.inputHeight!);
  expect(writes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining('/messages'),
        body: expect.stringContaining('"deliveryIntent":"QUEUE"')
      })
    ])
  );
  await emitMockSessionEvent(page, 'session', {
    session: { ...activeGoalSession, activity: 'IDLE', commandStates: [] }
  });
  await expect(pendingWork.locator('.goal-card')).toHaveCount(0);
  await emitMockSessionEvent(page, 'session', { session: activeGoalSession });
  await expect(pendingWork.locator('.goal-card')).toBeVisible();
  await page.route('**/api/agent-sessions/session-1/commands', (route) =>
    write(route, writes, {
      session: {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'vscode-thread-1',
        activity: 'RUNNING',
        control: {
          level: 'MANAGED',
          capabilities: [
            'history.read',
            'events.live',
            'turn.start',
            'turn.steer',
            'turn.interrupt'
          ]
        },
        commandStates: []
      },
      cleared: true,
      goalExit: { status: 'removed', elapsedWallMs: 12_000, turns: 1 }
    })
  );
  await pendingWork.locator('.goal-card').getByRole('button', { name: '移除' }).click();
  await expect(page.locator('.mar-ui-message')).toContainText(
    '已移除目标，当前执行未中断。累计耗时 12s，已开始 1 轮。'
  );
  expect(writes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining('/commands'),
        body: expect.stringContaining('"input":"/goal --clear"')
      })
    ])
  );
  await expect(pendingWork.locator('.goal-card')).toHaveCount(0);
  await emitMockSessionEvent(page, 'queue', {
    sessionId: 'session-1',
    queue: {
      version: 2,
      paused: false,
      items: Array.from({ length: 3 }, (_, index) => ({
        queueItemId: 'alignment-item-' + index,
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        clientMessageId: 'alignment-message-' + index,
        sessionTitle: 'Current session',
        content: 'Queued message ' + (index + 1),
        createdAt: index + 3
      }))
    }
  });
  await expect(pendingWork.locator('.queue-item')).toHaveCount(3);
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 800 }
  ]) {
    await page.setViewportSize(viewport);
    await expectQueueBottomAligned();
    const contentOffsets = await pendingWork.locator('.queue-item').evaluateAll((items) =>
      items.map((item) => {
        const row = item.getBoundingClientRect();
        const content = item.querySelector('.queue-item-content')!.getBoundingClientRect();
        return (content.top + content.bottom - row.top - row.bottom) / 2;
      })
    );
    for (const offset of contentOffsets) expect(Math.abs(offset)).toBeLessThanOrEqual(1);
  }
});

for (const labels of [
  {
    locale: 'zh-CN',
    enter: '进入控制台',
    work: '工作',
    help: '帮助',
    brand: 'MyAgentRoam 菜单',
    activity: '会话与通知',
    theme: 'dark'
  },
  {
    locale: 'en-US',
    enter: 'Open console',
    work: 'Work',
    help: 'Help',
    brand: 'MyAgentRoam menu',
    activity: 'Sessions & notifications',
    theme: 'daylight'
  }
]) {
  test(`Brand menu and notification navigation adapt across the breakpoint (${labels.locale})`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    await page.addInitScript(({ locale, theme }) => {
      localStorage.setItem('mar.locale.v2', locale);
      localStorage.setItem('mar.theme', theme);
    }, labels);
    await page.goto('/console');
    await page.getByRole('button', { name: labels.enter }).click();
    const help = page.getByRole('link', { name: labels.help, exact: true });
    const work = page.getByRole('button', { name: labels.work, exact: true });
    const notification = page.getByRole('button', { name: labels.activity, exact: true });
    await work.click();
    for (const width of [320, 390, 767, 768, 1600]) {
      await page.setViewportSize({ width, height: 844 });
      const logo = page.getByRole('button', { name: labels.brand });
      if (width >= 768) {
        await expect(logo).toHaveCount(0);
        await expect(help).toBeVisible();
        await expect(help.locator('.documentation-icon')).toBeVisible();
        await expect(help.locator('.documentation-icon')).toHaveCSS('width', '16px');
        const idleNavigation = page.locator('button.nav-menu-button:not(.active)').first();
        await idleNavigation.hover();
        const hoverBackground = await idleNavigation.evaluate(async (element) => {
          await Promise.all(element.getAnimations().map((animation) => animation.finished));
          return getComputedStyle(element).backgroundColor;
        });
        await notification.hover();
        await expect(notification).toHaveCSS('background-color', hoverBackground);
        continue;
      }
      await expect(help).toHaveCount(0);
      await expect(logo).toBeVisible();
      await expect(notification).toHaveCSS('width', '36px');
      await expect(notification).toHaveCSS('height', '36px');
      await expect(notification.locator('svg.mar-icon')).toHaveCSS('width', '22px');
      await expect(notification.locator('svg.mar-icon')).toHaveCSS('height', '22px');
      const [workBounds, notificationBounds] = await Promise.all([
        work.boundingBox(),
        notification.boundingBox()
      ]);
      expect(notificationBounds?.y).toBe(workBounds?.y);
      expect(notificationBounds?.height).toBe(workBounds?.height);
      const idleNavigation = page.locator('button.nav-menu-button:not(.active)').first();
      await page.mouse.move(0, 100);
      await expect(notification).toHaveCSS(
        'color',
        await idleNavigation.evaluate((element) => getComputedStyle(element).color)
      );
      await idleNavigation.hover();
      const hoverStyle = await idleNavigation.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
        const style = getComputedStyle(element);
        return {
          color: style.color,
          background: style.backgroundColor,
          radius: style.borderRadius
        };
      });
      await notification.hover();
      await expect(notification).toHaveCSS('color', hoverStyle.color);
      await expect(notification).toHaveCSS('background-color', hoverStyle.background);
      await expect(notification).toHaveCSS('border-radius', hoverStyle.radius);
      await expect(notification.locator('svg')).toHaveCSS('transform', 'none');
      await page.mouse.move(0, 100);
      await page.keyboard.press('Tab');
      await notification.focus();
      await expect(notification).toHaveCSS('outline-style', 'solid');
      await expect(notification).toHaveCSS('outline-width', '2px');
      await expect(notification).toHaveCSS('outline-offset', '-2px');
      await notification.click();
      await expect(notification).toHaveAttribute('aria-expanded', 'true');
      const activeStyle = await work.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
        const style = getComputedStyle(element);
        return { color: style.color, background: style.backgroundColor };
      });
      await page.mouse.move(0, 100);
      await expect(notification).toHaveCSS('color', activeStyle.color);
      await expect(notification).toHaveCSS('background-color', activeStyle.background);
      if (width === 390)
        await page.screenshot({ path: testInfo.outputPath('mobile-notification-open.png') });
      await notification.click();
      await expect(notification).toHaveAttribute('aria-expanded', 'false');
      await logo.click();
      const menu = page.getByRole('menu', { name: labels.brand });
      await expect(menu).toBeInViewport();
      await expect(
        menu.getByRole('menuitem', { name: labels.help, exact: true }).locator('svg')
      ).toHaveAttribute('data-mar-icon', 'document');
      if (width === 390)
        await page.screenshot({ path: testInfo.outputPath('mobile-brand-menu.png') });
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    }
  });
}
