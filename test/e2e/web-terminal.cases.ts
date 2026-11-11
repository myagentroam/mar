import { expect, test } from '@playwright/test';
import { mockConsoleApi, mockEmptyWorkspaceFiles, json, write } from './support/web-console-api.js';

// Terminal

for (const locale of ['zh-CN', 'en-US'] as const) {
  for (const method of ['POST', 'DELETE'] as const) {
    test(`Terminal ${method} transport failure shows one uncertain-result warning in ${locale}`, async ({
      page
    }) => {
      await page.addInitScript((locale) => {
        localStorage.setItem('mar.locale.v2', locale);
        const BrowserWebSocket = window.WebSocket;
        class MockWebSocket extends EventTarget {
          static readonly OPEN = 1;
          static readonly CLOSED = 3;
          static readonly instances: MockWebSocket[] = [];
          readyState = MockWebSocket.OPEN;
          constructor(
            readonly url: string,
            protocols?: string | string[]
          ) {
            super();
            // Only fake product traffic; the dev server must retain its native reload channel.
            if (!new URL(url, location.href).pathname.startsWith('/api/'))
              return new BrowserWebSocket(url, protocols);
            MockWebSocket.instances.push(this);
            queueMicrotask(() =>
              this.dispatchEvent(
                new MessageEvent('message', {
                  data: JSON.stringify({
                    type: 'attach',
                    terminalId: 'terminal-unknown',
                    afterSequence: 0
                  })
                })
              )
            );
          }
          send(): void {}
          close(): void {
            this.readyState = MockWebSocket.CLOSED;
          }
        }
        Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
      }, locale);
      await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
      await mockEmptyWorkspaceFiles(page, ['workspace-1']);
      const terminal = {
        id: 'terminal-unknown',
        workspaceId: 'workspace-1',
        profileId: 'default',
        state: 'RUNNING',
        latestSequence: 0
      };
      const writes: string[] = [];
      await page.route('**/api/terminals**', (route) => {
        const path = new URL(route.request().url()).pathname;
        const requestMethod = route.request().method();
        if (path.endsWith('/attach-ticket')) return json(route, { ticket: 'fixture-ticket' });
        if (requestMethod === 'POST' || requestMethod === 'DELETE') {
          writes.push(requestMethod);
          if (requestMethod === method) return route.abort('failed');
          return json(route, { terminal });
        }
        return json(route, { terminals: [terminal] });
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto('/console');
      await page
        .getByRole('button', {
          name: locale === 'zh-CN' ? '进入控制台' : 'Open console',
          exact: true
        })
        .click();
      await page
        .getByRole('button', { name: locale === 'zh-CN' ? '工作' : 'Work', exact: true })
        .click();
      const tree = page.locator('.workspace-tree');
      await tree.getByRole('button', { name: /node-1/ }).click();
      await tree.getByRole('button', { name: 'project', exact: true }).click();
      await expect(
        page.getByRole('tab', { name: locale === 'zh-CN' ? '终端' : 'Terminal', exact: true })
      ).toBeVisible();
      await page.keyboard.press('Control+Shift+Backquote');
      if (method === 'DELETE') {
        await expect(page.locator('.terminal-tab-close')).toBeVisible();
        await page.locator('.terminal-tab-close').click();
      }
      const warning = page.locator('.el-message--warning');
      await expect(warning).toHaveCount(1);
      await expect(warning).toContainText(
        locale === 'zh-CN'
          ? method === 'POST'
            ? '终端创建结果未知，终端可能已经创建'
            : '终端关闭结果未知，终端可能已经关闭'
          : method === 'POST'
            ? 'The terminal creation result is unknown. A terminal may have been created.'
            : 'The terminal closure result is unknown. The terminal may have been closed.'
      );
      await expect(warning).toContainText('NETWORK_UNAVAILABLE');
      await expect(page.locator('.el-message--error, .el-message--success')).toHaveCount(0);
      await expect(page.locator('.workspace-offline-placeholder')).toBeVisible();
      expect(writes.filter((write) => write === method)).toHaveLength(1);
      // Dismissing feedback must not replay the uncertain write.
      await warning.locator('.mar-message-close').click();
      await expect(page.locator('.el-message')).toHaveCount(0);
      expect(writes.filter((write) => write === method)).toHaveLength(1);
    });
  }
}

for (const scenario of ['cached', 'evicted', 'navigation'] as const) {
  const evicted = scenario === 'evicted';
  test(`Terminal pending creation ${scenario === 'navigation' ? 'survives temporary settings and conversation navigation' : evicted ? 'closes after Workspace Tab eviction' : 'stays with its cached Workspace Tab without stealing focus'}`, async ({
    page
  }) => {
    let resolveOpen!: () => void;
    const openGate = new Promise<void>((resolve) => (resolveOpen = resolve));
    let opens = 0;
    const closes: { terminalId: string; nodeId: string }[] = [];
    const terminals = new Map<
      string,
      {
        id: string;
        workspaceId: string;
        profileId: string;
        state: 'RUNNING';
        latestSequence: number;
      }
    >();
    await page.addInitScript(() => {
      class MockWebSocket extends EventTarget {
        static readonly OPEN = 1;
        static readonly CLOSED = 3;
        static readonly instances: MockWebSocket[] = [];
        readyState = MockWebSocket.OPEN;
        constructor(readonly url: string) {
          super();
          MockWebSocket.instances.push(this);
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  type: 'attach',
                  terminalId: 'terminal-pending',
                  afterSequence: 0
                })
              })
            )
          );
        }
        send(): void {}
        close(): void {
          this.readyState = MockWebSocket.CLOSED;
          this.dispatchEvent(new CloseEvent('close'));
        }
      }
      Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
    });
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    if (scenario === 'navigation') {
      await page.route('**/api/hosted-conversations?limit=20', (route) =>
        json(route, { items: [], nextCursor: null })
      );
      await page.route('**/api/conversation-templates', (route) => json(route, { templates: [] }));
    }
    await mockEmptyWorkspaceFiles(page, ['workspace-1', 'workspace-2']);
    await page.route('**/api/workspaces?nodeId=node-1', (route) =>
      json(route, {
        workspaces: [1, 2].map((id) => ({
          id: `workspace-${id}`,
          path: `/project-${id}`,
          kind: 'DIRECTORY'
        }))
      })
    );
    await page.route('**/api/terminals**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/terminals' && route.request().method() === 'POST') {
        opens++;
        const body = route.request().postDataJSON() as { nodeId: string; workspaceId: string };
        expect(body).toMatchObject({ nodeId: 'node-1', workspaceId: 'workspace-1' });
        await openGate;
        const terminal = {
          id: 'terminal-pending',
          workspaceId: body.workspaceId,
          profileId: 'default',
          state: 'RUNNING' as const,
          latestSequence: 0
        };
        terminals.set(terminal.id, terminal);
        return json(route, { terminal });
      }
      if (route.request().method() === 'DELETE') {
        const terminalId = path.split('/').at(-1)!;
        closes.push({ terminalId, ...(route.request().postDataJSON() as { nodeId: string }) });
        terminals.delete(terminalId);
        return json(route, {});
      }
      if (path.endsWith('/attach-ticket')) return json(route, { ticket: 'pending-ticket' });
      return json(route, { terminals: [...terminals.values()] });
    });
    try {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto('/console');
      await page.getByRole('button', { name: '进入控制台' }).click();
      await page.getByRole('button', { name: '工作', exact: true }).click();
      const tree = page.locator('.workspace-tree');
      await tree.getByRole('button', { name: /node-1/ }).click();
      await tree.getByRole('button', { name: 'project-1', exact: true }).click();
      await expect(page.getByRole('tab', { name: '终端', exact: true })).toBeVisible();
      await page.keyboard.press('Control+Shift+Backquote');
      await expect.poll(() => opens).toBe(1);
      const first = page.locator('.workspace-tab[data-tab-id="node-1:workspace-1"]');
      if (scenario === 'navigation') {
        for (const name of ['设置', '对话']) {
          await page.getByRole('button', { name, exact: true }).click();
          await expect(page.locator('.terminal-dock')).toHaveCount(1);
          await expect(page.locator('.terminal-dock')).toBeHidden();
          expect(closes).toEqual([]);
        }
        const conversationNavigation = page.getByRole('button', { name: '对话', exact: true });
        await conversationNavigation.focus();
        resolveOpen();
        await expect(page.locator('.xterm-host')).toHaveCount(1);
        await expect(page.locator('.xterm-host')).toBeHidden();
        await expect(conversationNavigation).toBeFocused();
        expect(closes).toEqual([]);
        await page.getByRole('button', { name: '工作', exact: true }).click();
        await expect(page.locator('.xterm-host')).toBeVisible();
        for (const name of ['设置', '对话']) {
          await page.getByRole('button', { name, exact: true }).click();
          await expect(page.locator('.xterm-host')).toBeHidden();
          expect(closes).toEqual([]);
          await page.getByRole('button', { name: '工作', exact: true }).click();
          await expect(page.locator('.xterm-host')).toBeVisible();
          await expect(page.locator('.terminal-tab-select')).toHaveCount(1);
        }
        expect(opens).toBe(1);
        await first.locator('.tab-close').click();
        await expect
          .poll(() => closes)
          .toEqual([{ terminalId: 'terminal-pending', nodeId: 'node-1' }]);
        expect(terminals.size).toBe(0);
        return;
      }
      await tree.getByRole('button', { name: 'project-2', exact: true }).click();
      const second = page.locator('.workspace-tab[data-tab-id="node-1:workspace-2"]');
      await expect(second.getByRole('tab')).toHaveAttribute('aria-selected', 'true');
      if (evicted) {
        await first.hover();
        await first.locator('.tab-close').click();
        await expect(first).toHaveCount(0);
      }
      await second.getByRole('tab').focus();
      resolveOpen();
      if (evicted) {
        await expect
          .poll(() => closes)
          .toEqual([{ terminalId: 'terminal-pending', nodeId: 'node-1' }]);
        expect(terminals.size).toBe(0);
        await expect(page.locator('.xterm-host')).toHaveCount(0);
      } else {
        await expect(page.locator('.xterm-host')).toHaveCount(1);
        await expect(page.locator('.xterm-host')).toBeHidden();
        await expect(second.getByRole('tab')).toBeFocused();
        expect(closes).toEqual([]);
        await first.getByRole('tab').click();
        await expect(page.locator('.xterm-host')).toBeVisible();
        await expect(page.locator('.terminal-tab-select')).toHaveCount(1);
        expect(opens).toBe(1);
        await page.locator('.terminal-tab-close').click();
        await expect
          .poll(() => closes)
          .toEqual([{ terminalId: 'terminal-pending', nodeId: 'node-1' }]);
        expect(terminals.size).toBe(0);
      }
      await expect(second.getByRole('tab')).toHaveAttribute(
        'aria-selected',
        evicted ? 'true' : 'false'
      );
    } finally {
      resolveOpen();
    }
  });
}

test('Terminal creation, attachment, resizing, and closure require explicit Node capability', async ({
  page
}) => {
  let terminalModuleRequested = false;
  let releaseTerminalModule!: () => void;
  const pendingTerminalModule = new Promise<void>((resolve) => (releaseTerminalModule = resolve));
  page.once('close', releaseTerminalModule);
  await page.route(/\/TerminalTabView(?:\.vue|-[^/]+\.js)(?:\?.*)?$/, async (route) => {
    terminalModuleRequested = true;
    await pendingTerminalModule;
    await route.continue();
  });
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('mar.theme', 'daylight');
    const clipboardWrites: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => 'clipboard paste',
        writeText: async (value: string) => {
          clipboardWrites.push(value);
        }
      }
    });
    Object.defineProperty(window, '__terminalClipboardWrites', {
      configurable: true,
      value: clipboardWrites
    });
    class MockWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: MockWebSocket[] = [];
      readonly url: string;
      readonly sent: string[] = [];
      readyState = MockWebSocket.OPEN;

      constructor(url: string) {
        super();
        this.url = url;
        MockWebSocket.instances.push(this);
        queueMicrotask(() => {
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 })
            })
          );
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'output',
                terminalId: 'terminal-1',
                sequence: 1,
                data: 'replayed output\\r\\n'
              })
            })
          );
        });
      }

      send(value: string): void {
        this.sent.push(value);
      }

      close(code = 1000, reason = ''): void {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close', { code, reason }));
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
    Object.defineProperty(window, '__terminalWebSockets', {
      configurable: true,
      value: MockWebSocket
    });
  });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route('**/api/nodes', (route) =>
    json(route, {
      nodes: [
        {
          id: 'node-1',
          platform: 'windows',
          architecture: 'x64',
          nodeAppVersion: '0.9.36',
          nodeVersion: 'v24.15.0',
          metadata: { osRelease: '10.0.19041' },
          connected: true,
          disabled: false,
          capabilities: {}
        }
      ]
    })
  );
  await page.route('**/api/nodes/node-1/workbench-capabilities', (route) =>
    json(route, {
      manifest: {
        manifestVersion: 1,
        revision: 1,
        observedAt: 1_900_000_000_000,
        platform: 'windows',
        conversation: { available: true, reasonCode: null },
        files: { available: true, reasonCode: null },
        git: { available: true, reasonCode: null, supportsHistory: true },
        terminal: {
          available: true,
          reasonCode: null,
          supportsPty: true,
          supportsConPty: true,
          supportsReplay: true,
          supportsReadonlyAttach: true,
          supportsTakeover: true,
          maxTerminals: 10,
          maxReplayBytes: 1_048_576,
          reconnectWindowMs: 60_000,
          profiles: [{ id: 'default', label: 'Default shell', isDefault: true }]
        },
        runners: []
      }
    })
  );
  let csrfRenewals = 0;
  await page.route('**/api/auth/csrf', (route) => {
    csrfRenewals += 1;
    expect(route.request().postData()).toBe('{}');
    return json(route, { csrfToken: 'csrf-2' });
  });
  let terminalSequence = 0;
  const terminals = new Map<
    string,
    {
      readonly id: string;
      readonly workspaceId: string | null;
      readonly profileId: string;
      readonly state: 'RUNNING';
      readonly latestSequence: number;
    }
  >();
  let rejectStaleAttachTicket = true;
  await page.route('**/api/terminals**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/terminals' && route.request().method() === 'POST') {
      const request = JSON.parse(route.request().postData() ?? '{}') as { workspaceId?: string };
      const terminal = {
        id: `terminal-${++terminalSequence}`,
        workspaceId: request.workspaceId ?? null,
        profileId: 'default',
        state: 'RUNNING' as const,
        latestSequence: 0
      };
      terminals.set(terminal.id, terminal);
      return write(route, writes, { terminal });
    }
    if (path.endsWith('/attach-ticket')) {
      if (rejectStaleAttachTicket) {
        rejectStaleAttachTicket = false;
        writes.push({
          url: route.request().url(),
          csrf: route.request().headers()['x-csrf-token'],
          body: route.request().postData() ?? ''
        });
        return json(route, { error: { code: 'CSRF_INVALID' } }, 403);
      }
      return write(route, writes, { ticket: 'single-use-ticket' });
    }
    if (path.startsWith('/api/terminals/')) {
      terminals.delete(path.split('/').at(-1) ?? '');
      return write(route, writes, {
        terminal: { id: path.split('/').at(-1), state: 'CLOSED', latestSequence: 1 }
      });
    }
    if (path !== '/api/terminals') return route.fallback();
    return json(route, { terminals: [...terminals.values()] });
  });
  async function toggleTerminalShortcut(focusedTerminal = false): Promise<void> {
    if (focusedTerminal) {
      await page.locator('.xterm-host').evaluate((host) => {
        host.addEventListener('keydown', (event) => event.stopPropagation(), { once: true });
        return host.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            code: 'Backquote',
            ctrlKey: true,
            key: '~',
            shiftKey: true
          })
        );
      });
      return;
    }
    await page.evaluate(() =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          code: 'Backquote',
          ctrlKey: true,
          key: '~',
          shiftKey: true
        })
      )
    );
  }
  async function emitTerminalOutput(data: string, sequence: number): Promise<void> {
    await page.evaluate(
      ({ data, sequence }) => {
        const sockets = (
          window as unknown as {
            __terminalWebSockets: {
              instances: Array<{ dispatchEvent(event: Event): boolean }>;
            };
          }
        ).__terminalWebSockets.instances;
        sockets.at(-1)?.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({ type: 'output', terminalId: 'terminal-1', sequence, data })
          })
        );
      },
      { data, sequence }
    );
  }
  async function terminalGeometry(): Promise<{
    readonly cols: number;
    readonly rows: number;
    readonly cursorColumn: number;
    readonly cursorRow: number;
    readonly hostWidth: number;
    readonly hostHeight: number;
    readonly screenWidth: number;
    readonly screenHeight: number;
    readonly lines: readonly string[];
  } | null> {
    return page.locator('.xterm-host').evaluate((host) => {
      const screen = host.querySelector<HTMLElement>('.xterm-screen');
      const cursor = host.querySelector<HTMLElement>('.xterm-cursor');
      const rows = [...host.querySelectorAll<HTMLElement>('.xterm-rows > div')];
      if (screen === null || cursor === null || rows.length === 0) return null;
      const cursorBounds = cursor.getBoundingClientRect();
      const screenBounds = screen.getBoundingClientRect();
      const hostBounds = host.getBoundingClientRect();
      const cursorRow = rows.findIndex((row) => row.contains(cursor));
      if (cursorBounds.width <= 0 || cursorRow < 0) return null;
      return {
        cols: Math.round(screenBounds.width / cursorBounds.width),
        rows: rows.length,
        cursorColumn: Math.round(
          (cursorBounds.left - rows[cursorRow]!.getBoundingClientRect().left) / cursorBounds.width
        ),
        cursorRow,
        hostWidth: hostBounds.width,
        hostHeight: hostBounds.height,
        screenWidth: screenBounds.width,
        screenHeight: screenBounds.height,
        lines: rows.map((row) => (row.textContent ?? '').replaceAll('\u00a0', ' ').trimEnd())
      };
    });
  }

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.getByRole('button', { name: '节点操作' }).click();
  await page.getByRole('menuitem', { name: '添加工作区' }).click();
  const registration = page.getByRole('dialog', { name: '登记工作区', exact: true });
  await expect(registration).toBeVisible();
  await registration.getByRole('button', { name: '关闭此对话框' }).click();
  await expect(registration).toBeHidden();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('tab', { name: /project/ }).click();
  await expect(page.getByRole('button', { name: '展开终端' })).toBeVisible();
  expect(terminals.size).toBe(0);
  await expect(page.locator('.xterm-host')).toHaveCount(0);
  expect(terminalModuleRequested).toBe(false);
  await toggleTerminalShortcut();
  await expect.poll(() => terminalModuleRequested).toBe(true);
  await expect(page.getByRole('button', { name: '收起终端' })).toBeVisible();
  releaseTerminalModule();
  await expect(page.locator('.xterm-helper-textarea')).toBeAttached();
  await expect
    .poll(() =>
      page.locator('.xterm-host').evaluate((host) => host.contains(document.activeElement))
    )
    .toBe(true);
  await expect(page.locator('.terminal-tab-add')).toBeEnabled();
  await page.getByRole('button', { name: '收起终端' }).click();
  await expect(page.locator('.xterm-host')).toBeHidden();
  await toggleTerminalShortcut();
  await expect(page.getByRole('heading', { name: '终端' })).toHaveCSS('font-weight', '500');
  await expect(page.getByRole('heading', { name: '终端' })).toHaveCSS('font-size', '14px');
  await expect(page.locator('.admin-terminal-header')).toHaveCSS('min-height', '32px');
  await expect(page.getByRole('button', { name: '重新连接' })).toHaveCount(0);
  await expect(page.locator('.xterm-host')).toBeVisible();
  await expect
    .poll(() =>
      page.locator('.xterm-host').evaluate((host) => host.contains(document.activeElement))
    )
    .toBe(true);
  await expect(page.locator('.admin-terminal-status')).toHaveCount(0);
  const chromeBackground = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'var(--mar-bg-chrome)';
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  await expect(page.locator('.admin-terminal')).toHaveCSS('background-color', chromeBackground);
  await expect(page.locator('.admin-terminal-body')).toHaveCSS(
    'background-color',
    'rgb(14, 17, 22)'
  );
  await expect(page.locator('.xterm-host')).toHaveCSS('height', '220px');
  await expect(page.locator('.xterm-host')).toHaveJSProperty(
    'clientWidth',
    await page.locator('.admin-terminal-body').evaluate((element) => element.clientWidth - 8)
  );
  await expect(page.locator('.xterm-host')).toHaveJSProperty(
    'clientHeight',
    await page.locator('.admin-terminal-body').evaluate((element) => element.clientHeight - 8)
  );
  await expect
    .poll(() =>
      page.locator('.xterm-host').evaluate((host) => {
        const screen = host.querySelector<HTMLElement>('.xterm-screen');
        if (screen === null) return Number.NEGATIVE_INFINITY;
        return host.getBoundingClientRect().height - screen.getBoundingClientRect().height;
      })
    )
    .toBeGreaterThanOrEqual(0);
  await expect
    .poll(() =>
      page.locator('.xterm-host').evaluate((host) => {
        const screen = host.querySelector<HTMLElement>('.xterm-screen');
        const row = host.querySelector<HTMLElement>('.xterm-rows > div');
        if (screen === null || row === null) return Number.POSITIVE_INFINITY;
        return (
          host.getBoundingClientRect().height -
          screen.getBoundingClientRect().height -
          row.getBoundingClientRect().height
        );
      })
    )
    .toBeLessThan(0);
  await expect
    .poll(() =>
      page.locator('.xterm-host').evaluate((host) => {
        const lastRow = host.querySelector<HTMLElement>('.xterm-rows > div:last-child');
        return lastRow === null
          ? Number.POSITIVE_INFINITY
          : lastRow.getBoundingClientRect().bottom - host.getBoundingClientRect().bottom;
      })
    )
    .toBeLessThanOrEqual(0);
  await expect(page.locator('.terminal-tab-select')).toHaveCSS('cursor', 'pointer');
  await expect(page.locator('.terminal-tab-select')).toHaveCSS('font-size', '13px');
  await expect(page.locator('.terminal-tab-select')).toHaveCSS('font-weight', '500');
  await expect(page.locator('.terminal-tab-close')).toHaveCSS('cursor', 'pointer');
  await expect(page.locator('.terminal-tab-close')).toHaveCount(1);
  await expect(page.locator('.terminal-tab-close')).toHaveCSS('width', '24px');
  await expect(page.locator('.terminal-tab-close svg')).toHaveCount(1);
  await expect(page.locator('.terminal-tab:not(.terminal-tab-add)')).toHaveCount(1);
  await expect(
    page.locator('.admin-terminal-actions').getByRole('button', { name: '新建终端' })
  ).toHaveCount(0);
  await expect(page.locator('.terminal-tab-add')).toBeVisible();
  const terminalTabPlacement = await page.locator('.terminal-tabs').evaluate((element) => {
    const tabs = [...element.querySelectorAll<HTMLElement>('.terminal-tab:not(.terminal-tab-add)')];
    const add = element.querySelector<HTMLElement>('.terminal-tab-add');
    return {
      lastRight: tabs.at(-1)?.getBoundingClientRect().right,
      addLeft: add?.getBoundingClientRect().left
    };
  });
  if (terminalTabPlacement.addLeft === undefined) throw new Error('TERMINAL_ADD_TAB_MISSING');
  expect(terminalTabPlacement.addLeft - (terminalTabPlacement.lastRight ?? 0)).toBeCloseTo(3, 0);
  expect(csrfRenewals).toBe(1);
  const terminalRow = page.locator('.xterm-rows > div').filter({ hasText: 'replayed output' });
  await expect(terminalRow).toBeVisible();
  await page.locator('.xterm-screen').dblclick({ position: { x: 35, y: 8 } });
  const clipboardWrites = () =>
    page.evaluate(
      () => (window as unknown as { __terminalClipboardWrites: string[] }).__terminalClipboardWrites
    );
  expect(await clipboardWrites()).toEqual([]);
  await page.locator('.xterm-screen').click({ button: 'right' });
  const terminalMenu = page
    .getByRole('menu')
    .filter({ has: page.getByRole('menuitem', { name: '清屏' }) });
  await expect(terminalMenu).toBeVisible();
  await expect(terminalMenu.getByRole('menuitem', { name: '复制' })).toBeEnabled();
  await terminalMenu.getByRole('menuitem', { name: '复制' }).click();
  await expect.poll(async () => (await clipboardWrites()).at(-1)).toContain('replayed');
  await page.locator('.xterm-screen').click({ button: 'right' });
  await expect(terminalMenu).toBeVisible();
  const inputBeforePaste = await page.evaluate(() => {
    const sockets = (
      window as unknown as {
        __terminalWebSockets: { instances: Array<{ sent: string[] }> };
      }
    ).__terminalWebSockets.instances;
    return sockets.at(-1)?.sent.filter((value) => JSON.parse(value).type === 'input').length ?? 0;
  });
  await terminalMenu.getByRole('menuitem', { name: '粘贴' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sockets = (
          window as unknown as {
            __terminalWebSockets: { instances: Array<{ sent: string[] }> };
          }
        ).__terminalWebSockets.instances;
        return sockets.at(-1)?.sent.some((value) => value.includes('clipboard paste')) ?? false;
      })
    )
    .toBe(true);
  expect(inputBeforePaste).toBe(0);
  await expect(terminalMenu).toHaveCount(0);
  await emitTerminalOutput('\r\nabc\nX', 2);
  await expect
    .poll(async () => (await terminalGeometry())?.lines.find((line) => line.endsWith('X')))
    .toBe('   X');

  await expect
    .poll(() =>
      page.evaluate(() => {
        const sent = (
          window as unknown as {
            __terminalWebSockets: { instances: Array<{ sent: string[] }> };
          }
        ).__terminalWebSockets.instances.at(-1)?.sent;
        return (
          sent
            ?.map((value) => JSON.parse(value) as { type?: string })
            .findLast((frame) => frame.type === 'resize') ?? null
        );
      })
    )
    .not.toBeNull();
  const resizeCountBeforeHostChange = await page.evaluate(
    () =>
      (
        window as unknown as {
          __terminalWebSockets: { instances: Array<{ sent: string[] }> };
        }
      ).__terminalWebSockets.instances
        .at(-1)
        ?.sent.map((value) => JSON.parse(value) as { type?: string })
        .filter((frame) => frame.type === 'resize').length ?? 0
  );
  await page.locator('.admin-terminal-body').evaluate((element) => {
    element.style.width = '620px';
  });
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __terminalWebSockets: { instances: Array<{ sent: string[] }> };
              }
            ).__terminalWebSockets.instances
              .at(-1)
              ?.sent.map((value) => JSON.parse(value) as { type?: string })
              .filter((frame) => frame.type === 'resize').length ?? 0
        ),
      { timeout: 5_000 }
    )
    .toBeGreaterThan(resizeCountBeforeHostChange);
  const resized = await page.evaluate(() => {
    const sent = (
      window as unknown as {
        __terminalWebSockets: { instances: Array<{ sent: string[] }> };
      }
    ).__terminalWebSockets.instances.at(-1)?.sent;
    return sent
      ?.map(
        (value) =>
          JSON.parse(value) as {
            type?: string;
            rows?: number;
            cols?: number;
          }
      )
      .findLast((frame) => frame.type === 'resize');
  });
  const resizedGeometry = await terminalGeometry();
  expect(resizedGeometry).not.toBeNull();
  expect(resized).toMatchObject({
    type: 'resize',
    rows: resizedGeometry?.rows,
    cols: resizedGeometry?.cols
  });
  expect(resizedGeometry!.screenWidth).toBeLessThanOrEqual(resizedGeometry!.hostWidth + 0.5);
  expect(resizedGeometry!.screenHeight).toBeLessThanOrEqual(resizedGeometry!.hostHeight + 0.5);

  const prompt = 'PS C:\\work> ';
  const previousCommand = prompt + 'o'.repeat(resizedGeometry!.cols + 8 - prompt.length);
  const recalledFirstLine =
    `${prompt}中文😀` + 'n'.repeat(resizedGeometry!.cols - prompt.length - 6);
  const recalledSecondLine = 'n'.repeat(5);
  const recalledCommand = recalledFirstLine + recalledSecondLine;
  await emitTerminalOutput(`\x1bc${previousCommand}\r\x1b[2K\x1b[1A\r\x1b[2K${recalledCommand}`, 3);
  await expect
    .poll(async () => {
      const geometry = await terminalGeometry();
      return geometry === null
        ? null
        : {
            firstLine: geometry.lines[0],
            secondLine: geometry.lines[1],
            cursorColumn: geometry.cursorColumn,
            cursorRow: geometry.cursorRow
          };
    })
    .toEqual({
      firstLine: recalledFirstLine,
      secondLine: recalledSecondLine,
      cursorColumn: 5,
      cursorRow: 1
    });
  const legacyWrappedLine = 'w'.repeat(resizedGeometry!.cols + 8);
  await emitTerminalOutput(`\x1bc${legacyWrappedLine}\r\n`, 4);
  await expect
    .poll(async () => {
      const geometry = await terminalGeometry();
      return geometry === null ? null : geometry.lines.slice(0, 2);
    })
    .toEqual([
      legacyWrappedLine.slice(0, resizedGeometry!.cols),
      legacyWrappedLine.slice(resizedGeometry!.cols)
    ]);
  const resizeCountBeforeConPtyWiden = await page.evaluate(
    () =>
      (
        window as unknown as {
          __terminalWebSockets: { instances: Array<{ sent: string[] }> };
        }
      ).__terminalWebSockets.instances
        .at(-1)
        ?.sent.map((value) => JSON.parse(value) as { type?: string })
        .filter((frame) => frame.type === 'resize').length ?? 0
  );
  await page.locator('.admin-terminal-body').evaluate((element) => {
    element.style.width = '900px';
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __terminalWebSockets: { instances: Array<{ sent: string[] }> };
            }
          ).__terminalWebSockets.instances
            .at(-1)
            ?.sent.map((value) => JSON.parse(value) as { type?: string })
            .filter((frame) => frame.type === 'resize').length ?? 0
      )
    )
    .toBeGreaterThan(resizeCountBeforeConPtyWiden);
  await expect
    .poll(async () => {
      const geometry = await terminalGeometry();
      return geometry === null ? null : geometry.lines.slice(0, 2);
    })
    .toEqual([
      legacyWrappedLine.slice(0, resizedGeometry!.cols),
      legacyWrappedLine.slice(resizedGeometry!.cols)
    ]);
  await page.locator('.xterm-screen').click({ button: 'right' });
  await expect(terminalMenu).toBeVisible();
  const framesBeforeClear = await page.evaluate(() => {
    const sockets = (
      window as unknown as {
        __terminalWebSockets: { instances: Array<{ sent: string[] }> };
      }
    ).__terminalWebSockets.instances;
    return sockets.at(-1)?.sent.length ?? 0;
  });
  await terminalMenu.getByRole('menuitem', { name: '清屏' }).click();
  await expect(page.locator('.xterm-rows')).not.toContainText(legacyWrappedLine.slice(0, 32));
  expect(
    await page.evaluate(() => {
      const sockets = (
        window as unknown as {
          __terminalWebSockets: { instances: Array<{ sent: string[] }> };
        }
      ).__terminalWebSockets.instances;
      return sockets.at(-1)?.sent.length ?? 0;
    })
  ).toBe(framesBeforeClear);
  await emitTerminalOutput('\x1b[?1000h\x1b[?1006h\r\nvim select 12345', 5);
  const vimTextRow = page.locator('.xterm-rows > div').filter({ hasText: 'vim select 12345' });
  await expect(vimTextRow).toBeVisible();
  const vimRowBounds = await vimTextRow.boundingBox();
  const cursorBounds = await page.locator('.xterm-cursor').boundingBox();
  expect(vimRowBounds).not.toBeNull();
  expect(cursorBounds).not.toBeNull();
  await page.keyboard.down('Shift');
  await page.mouse.move(vimRowBounds!.x + cursorBounds!.width * 4 + 2, vimRowBounds!.y + 7);
  await page.mouse.down();
  await page.mouse.move(vimRowBounds!.x + cursorBounds!.width * 10 + 2, vimRowBounds!.y + 7, {
    steps: 3
  });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const framesBeforeVimRightClick = await page.evaluate(() => {
    const sockets = (
      window as unknown as {
        __terminalWebSockets: { instances: Array<{ sent: string[] }> };
      }
    ).__terminalWebSockets.instances;
    return sockets.at(-1)?.sent.length ?? 0;
  });
  await page.locator('.xterm-screen').click({ button: 'right' });
  await expect(terminalMenu).toBeVisible();
  expect(
    await page.evaluate(() => {
      const sockets = (
        window as unknown as {
          __terminalWebSockets: { instances: Array<{ sent: string[] }> };
        }
      ).__terminalWebSockets.instances;
      return sockets.at(-1)?.sent.length ?? 0;
    })
  ).toBe(framesBeforeVimRightClick);
  await expect(terminalMenu.getByRole('menuitem', { name: '复制' })).toBeEnabled();
  await terminalMenu.getByRole('menuitem', { name: '复制' }).click();
  await expect.poll(async () => (await clipboardWrites()).at(-1)).toBe('select');
  await page.locator('.xterm-screen').click({ button: 'right' });
  await expect(terminalMenu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(terminalMenu).toHaveCount(0);
  await emitTerminalOutput('\x1b[?1000l\x1b[?1006l', 6);
  const socketCountBeforeNetworkDrop = await page.evaluate(
    () =>
      (
        window as unknown as {
          __terminalWebSockets: { instances: unknown[] };
        }
      ).__terminalWebSockets.instances.length
  );
  await page.evaluate(() => {
    const sockets = (
      window as unknown as {
        __terminalWebSockets: {
          instances: Array<{
            close(code?: number, reason?: string): void;
            dispatchEvent(event: Event): boolean;
          }>;
        };
      }
    ).__terminalWebSockets.instances;
    const stale = sockets.at(-1);
    stale?.close(1006, 'NETWORK_INTERRUPTED');
    stale?.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 })
      })
    );
  });
  await expect(page.locator('.admin-terminal-status')).toContainText(
    /终端连接中断，\d+ 秒后自动重连/
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __terminalWebSockets: { instances: unknown[] };
            }
          ).__terminalWebSockets.instances.length
      )
    )
    .toBe(socketCountBeforeNetworkDrop + 1);
  await expect(page.locator('.admin-terminal-status')).toHaveCount(0);
  const socketCountBeforeHiddenReconnect = await page.evaluate(
    () =>
      (
        window as unknown as {
          __terminalWebSockets: { instances: unknown[] };
        }
      ).__terminalWebSockets.instances.length
  );
  await toggleTerminalShortcut(true);
  await expect(page.getByRole('button', { name: '展开终端' })).toBeVisible();
  await expect(page.locator('.xterm-host')).toBeHidden();
  await page.evaluate(() => {
    const sockets = (
      window as unknown as {
        __terminalWebSockets: { instances: Array<{ close(code?: number, reason?: string): void }> };
      }
    ).__terminalWebSockets.instances;
    sockets.at(-1)?.close(1006, 'NETWORK_INTERRUPTED');
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __terminalWebSockets: { instances: unknown[] };
            }
          ).__terminalWebSockets.instances.length
      )
    )
    .toBe(socketCountBeforeHiddenReconnect + 1);
  await expect(page.locator('.admin-terminal-status')).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const sent = (
        window as unknown as {
          __terminalWebSockets: { instances: Array<{ sent: string[] }> };
        }
      ).__terminalWebSockets.instances.at(-1)?.sent;
      return (
        sent
          ?.map((value) => JSON.parse(value) as { type?: string })
          .filter((frame) => frame.type === 'resize').length ?? 0
      );
    })
  ).toBe(0);
  await toggleTerminalShortcut();
  await expect(page.locator('.xterm-host')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sent = (
          window as unknown as {
            __terminalWebSockets: { instances: Array<{ sent: string[] }> };
          }
        ).__terminalWebSockets.instances.at(-1)?.sent;
        return (
          sent
            ?.map((value) => JSON.parse(value) as { type?: string })
            .some((frame) => frame.type === 'resize') ?? false
        );
      })
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.locator('.xterm-host').evaluate((host) => host.contains(document.activeElement))
    )
    .toBe(true);
  await page.locator('.terminal-tab-add').click();
  await expect(page.locator('.terminal-tab:not(.terminal-tab-add)')).toHaveCount(2);
  await page.getByRole('button', { name: '关闭终端 2' }).click();
  await expect(page.locator('.terminal-tab:not(.terminal-tab-add)')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '收起终端' })).toBeVisible();
  await page.getByRole('button', { name: '关闭终端 1' }).click();
  await expect(page.getByRole('button', { name: '展开终端' })).toBeVisible();
  await expect(page.locator('.xterm-host')).toBeHidden();
  await page.getByRole('button', { name: '展开终端' }).click();
  await expect(page.locator('.terminal-tab:not(.terminal-tab-add)')).toHaveCount(1);
  await expect(page.locator('.admin-terminal-status')).toHaveCount(0);
  const previousTerminalId = [...terminals.keys()][0];
  await page.reload();
  await expect(page.getByRole('button', { name: '展开终端' })).toBeVisible();
  await expect(page.locator('.xterm-host')).toHaveCount(0);
  expect([...terminals.keys()]).toEqual([previousTerminalId]);
  await page.getByRole('button', { name: '展开终端' }).click();
  await expect(page.locator('.terminal-tab:not(.terminal-tab-add)')).toHaveCount(1);
  expect(terminals.size).toBe(2);
  expect(terminals.has(previousTerminalId!)).toBe(true);
  expect(writes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining('/api/terminals'),
        body: expect.stringContaining('"workspaceId":"workspace-1"')
      }),
      expect.objectContaining({
        url: expect.stringContaining('/attach-ticket'),
        csrf: 'csrf-1'
      }),
      expect.objectContaining({
        url: expect.stringContaining('/attach-ticket'),
        csrf: 'csrf-2'
      }),
      expect.objectContaining({
        url: expect.stringMatching(/\/api\/terminals\/terminal-\d+$/)
      })
    ])
  );
});
