import { expect, test } from '@playwright/test';
import { emitMockSessionEvent, mockConsoleApi, json, write } from './support/web-console-api.js';

for (const language of [
  {
    locale: 'zh-CN',
    login: '进入控制台',
    settings: '设置',
    title: '系统通知',
    enable: '开启系统通知',
    disable: '关闭系统通知',
    enabled: '已开启',
    disabled: '未开启',
    summary: '切换到其他页面或应用时，仍可收到通知。关闭工作台后不再提醒。',
    work: '工作',
    center: '打开通知中心'
  },
  {
    locale: 'en-US',
    login: 'Open console',
    settings: 'Settings',
    title: 'System notifications',
    enable: 'Enable system notifications',
    disable: 'Disable system notifications',
    enabled: 'Enabled',
    disabled: 'Disabled',
    summary:
      'Receive notifications when you switch to another page or app. Notifications stop when you close the workbench.',
    work: 'Work',
    center: 'Open notification center'
  }
]) {
  test(`System notifications opt in from settings and remind a visible unfocused window: ${language.locale}`, async ({
    page
  }) => {
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    await page.context().route('**/service-worker.js*', async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body:
          "self.registration.showNotification = async (title, options = {}) => {\n  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });\n  for (const client of windows) client.postMessage({ type: 'test.system-notification.shown', record: { title, options } });\n};\nself.registration.getNotifications = async () => [];\n" +
          (await response.text())
      });
    });
    const initializeNotifications = (locale: string) => {
      localStorage.setItem('mar.locale.v2', locale);
      const state = {
        focused: true,
        permission: (localStorage.getItem('mar.workbench.system-notifications.v1.admin') === 'true'
          ? 'granted'
          : 'default') as NotificationPermission,
        permissionRequests: 0,
        records: [] as { title: string; options: NotificationOptions }[]
      };
      Object.assign(window, { __systemNotificationTest: state });
      Object.defineProperty(document, 'hasFocus', {
        configurable: true,
        value: () => state.focused
      });
      // Mock the permission boundary; the headless shell has no OS notifier.
      Object.defineProperty(Notification, 'permission', {
        configurable: true,
        get: () => state.permission
      });
      Object.defineProperty(Notification, 'requestPermission', {
        configurable: true,
        value: () => {
          state.permissionRequests += 1;
          state.permission = 'granted';
          return Promise.resolve(state.permission);
        }
      });
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'test.system-notification.shown')
          state.records.push(event.data.record);
      });
    };
    await page.addInitScript(initializeNotifications, language.locale);
    const now = Date.now();
    const entry = (id: string) => ({
      id,
      kind: 'run',
      title: `Completed ${id}`,
      message: 'Run completed',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 60_000,
      read: false,
      target: {
        targetType: 'WORKSPACE_SESSION',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1'
      }
    });
    let notifications: ReturnType<typeof entry>[] = [];
    const reads: string[] = [];
    await page.route('**/api/notifications', (route) => json(route, { notifications }));
    await page.route(/\/api\/notifications\/[^/]+\/read$/, (route) => {
      const path = new URL(route.request().url()).pathname;
      reads.push(path);
      const id = path.split('/')[3];
      notifications = notifications.map((value) =>
        value.id === id ? { ...value, read: true } : value
      );
      return json(route, {});
    });
    await page.route('**/api/notifications/session/read', (route) => {
      reads.push('/api/notifications/session/read');
      notifications = notifications.map((value) => ({ ...value, read: true }));
      return json(route, {});
    });
    await page.goto('/console');
    await page.getByRole('button', { name: language.login, exact: true }).click();
    await page.getByRole('button', { name: language.settings, exact: true }).click();
    await page.getByRole('button', { name: language.title, exact: true }).click();
    await expect(
      page.getByRole('heading', { name: language.title, level: 2, exact: true })
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          async () => !!(await navigator.serviceWorker.getRegistration('/console'))?.active
        )
      )
      .toBe(true);
    const testState = () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __systemNotificationTest: {
                focused: boolean;
                permissionRequests: number;
                records: { title: string; options: NotificationOptions }[];
              };
            }
          ).__systemNotificationTest
      );
    expect((await testState()).permissionRequests).toBe(0);
    const settingsPanel = page.locator('.settings-panel').filter({
      has: page.getByRole('heading', { name: language.title, exact: true })
    });
    await expect(settingsPanel.locator('p.account-summary')).toHaveText([language.summary]);
    await expect(settingsPanel.getByRole('status').first()).toHaveText(language.disabled);
    await expect(settingsPanel.getByRole('status').first().locator('.el-tag')).toHaveClass(
      /el-tag--info/
    );
    const enable = page.getByRole('button', { name: language.enable, exact: true });
    await enable.click();
    await expect(page.getByRole('button', { name: language.disable, exact: true })).toBeVisible();
    await expect(settingsPanel.getByRole('status').first()).toHaveText(language.enabled);
    expect((await testState()).permissionRequests).toBe(1);
    expect(
      await page.evaluate(() => localStorage.getItem('mar.workbench.system-notifications.v1.admin'))
    ).toBe('true');
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await page
      .getByRole('button', { name: language.disable, exact: true })
      .boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: language.work, exact: true }).click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
    await page.locator('.session-list button').first().click();
    await expect.poll(() => reads.includes('/api/notifications/session/read')).toBe(true);
    notifications = [entry('unfocused'), entry('same-session')];
    await page.evaluate((value) => {
      const w = window as unknown as {
        __systemNotificationTest: { focused: boolean };
        __consoleMockWorkbenchWebSocket: {
          instances: { url: string; readyState: number; dispatchEvent(event: Event): void }[];
        };
      };
      w.__systemNotificationTest.focused = false;
      const socket = w.__consoleMockWorkbenchWebSocket.instances.find(
        (item) => item.url.includes('/api/workbench/live') && item.readyState === 1
      );
      if (socket === undefined) throw new Error('Mock workbench connection is not ready');
      socket.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'notification.created', notification: value })
        })
      );
    }, notifications[0]);
    await expect.poll(async () => (await testState()).records.length).toBe(1);
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
    expect((await testState()).records[0]?.title).toBe('Completed unfocused');
    const sibling = await page.context().newPage();
    await mockConsoleApi(sibling, 'MANAGED', ['history.read', 'turn.start'], []);
    await sibling.addInitScript(initializeNotifications, language.locale);
    await sibling.route('**/api/notifications', (route) => json(route, { notifications }));
    await sibling.goto('/console');
    await sibling.getByRole('button', { name: language.login, exact: true }).click();
    await sibling.getByRole('button', { name: language.settings, exact: true }).click();
    await sibling.getByRole('button', { name: language.title, exact: true }).click();
    await expect(
      sibling.getByRole('button', { name: language.disable, exact: true })
    ).toBeVisible();
    const duplicate = entry('two-background-tabs');
    notifications = [duplicate, ...notifications];
    await Promise.all(
      [page, sibling].map((target) =>
        target.evaluate((value) => {
          const w = window as unknown as {
            __systemNotificationTest: { focused: boolean };
            __consoleMockWorkbenchWebSocket: {
              instances: { url: string; readyState: number; dispatchEvent(event: Event): void }[];
            };
          };
          w.__systemNotificationTest.focused = false;
          const socket = w.__consoleMockWorkbenchWebSocket.instances.find(
            (item) => item.url.includes('/api/workbench/live') && item.readyState === 1
          );
          if (socket === undefined) throw new Error('Mock workbench connection is not ready');
          socket.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ type: 'notification.created', notification: value })
            })
          );
        }, duplicate)
      )
    );
    await expect.poll(async () => (await testState()).records.length).toBe(2);
    expect(
      (await testState()).records.filter((record) => record.title === duplicate.title)
    ).toHaveLength(1);
    await sibling.close();
    const readsBeforeClick = reads.length;
    await page.evaluate(() => {
      const w = window as unknown as {
        __systemNotificationTest: { focused: boolean };
        __consoleMockWorkbenchWebSocket: { dispatch(frame: unknown): void };
      };
      w.__systemNotificationTest.focused = true;
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'mar.workbench.notification.click', account: 'admin', id: 'unfocused' }
        })
      );
    });
    await expect
      .poll(() => reads.slice(readsBeforeClick))
      .toEqual(['/api/notifications/unfocused/read']);
    expect(notifications.find((value) => value.id === 'same-session')?.read).toBe(false);
    await page.getByRole('button', { name: language.center, exact: true }).click();
    const notificationPanel = page.locator('.workbench-notification-panel');
    await expect(notificationPanel).toBeVisible();
    await expect(
      notificationPanel.getByRole('button', { name: language.disable, exact: true })
    ).toHaveCount(0);
    await expect(
      notificationPanel.getByRole('button', { name: language.enable, exact: true })
    ).toHaveCount(0);
    await expect(notificationPanel.getByRole('status')).toHaveCount(0);
    await page.getByRole('button', { name: language.settings, exact: true }).click();
    await page.getByRole('button', { name: language.title, exact: true }).click();
    await expect(page.getByRole('button', { name: language.disable, exact: true })).toBeVisible();
    await page.getByRole('button', { name: language.disable, exact: true }).click();
    await expect(page.getByRole('button', { name: language.enable, exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem('mar.workbench.system-notifications.v1.admin'))
    ).toBe('false');
  });
}

// Workbench Live and the capability baseline

test('Workbench controls preserve selection, foreground-only emphasis, focus, and compact mobile controls', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '展开工作区' }).click();
  await page.locator('.workspace-branch-button').first().click();
  const navigation = page.getByRole('button', { name: '工作', exact: true });
  const expectSelectedNavigation = async () => {
    const colors = await navigation.evaluate((button) => {
      const reference = document.createElement('span');
      reference.style.cssText =
        'background-color: var(--mar-fill-selection); color: var(--mar-color-brand-text);';
      button.append(reference);
      const actual = getComputedStyle(button);
      const expected = getComputedStyle(reference);
      const result = {
        background: actual.backgroundColor,
        text: actual.color,
        expectedBackground: expected.backgroundColor,
        expectedText: expected.color,
        radii: [
          actual.borderTopLeftRadius,
          actual.borderTopRightRadius,
          actual.borderBottomRightRadius,
          actual.borderBottomLeftRadius
        ].map(Number.parseFloat),
        leftBorder: actual.borderLeftWidth,
        bottomBorder: actual.borderBottomWidth,
        shadow: actual.boxShadow
      };
      reference.remove();
      return result;
    });
    expect(colors.background).toBe(colors.expectedBackground);
    expect(colors.text).toBe(colors.expectedText);
    for (const radius of colors.radii) expect(radius).toBeGreaterThan(0);
    expect(colors.leftBorder).toBe('0px');
    expect(colors.bottomBorder).toBe('0px');
    expect(colors.shadow).not.toContain('inset');
  };
  const refresh = page.getByRole('button', { name: '刷新文件', exact: true });
  await expect(refresh).toBeEnabled();
  for (const theme of ['daylight', 'vscode-dark-2026']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.mouse.move(0, 0);
    await expectSelectedNavigation();
    const selection = await page.locator('html').evaluate((root) => {
      const reference = document.createElement('span');
      reference.style.cssText =
        'background: var(--mar-fill-selection); color: var(--mar-text-primary);';
      root.append(reference);
      const style = getComputedStyle(reference);
      const colors = { background: style.backgroundColor, text: style.color };
      reference.remove();
      return colors;
    });
    const workspace = page.locator('.workspace-tab.active').first();
    await expect(workspace.locator('.workspace-tab-content > span')).toHaveCSS(
      'color',
      selection.text
    );
    await expect
      .poll(() => workspace.evaluate((element) => getComputedStyle(element).backgroundImage))
      .toContain(selection.background);
    const treeWorkspace = page.locator('.workspace-branches > li.selected').first();
    await expect(treeWorkspace).toHaveCSS('background-color', selection.background);
    await expect(treeWorkspace.locator('.workspace-branch-button')).toHaveCSS(
      'color',
      selection.text
    );
    await treeWorkspace.hover();
    await expect(treeWorkspace).toHaveCSS('background-color', selection.background);
    const idle = await refresh.evaluate((button) => ({
      color: getComputedStyle(button).color,
      background: getComputedStyle(button).backgroundColor
    }));
    await refresh.hover();
    await expect(refresh).toHaveCSS('background-color', idle.background);
    await expect
      .poll(() => refresh.evaluate((button) => getComputedStyle(button).color))
      .not.toBe(idle.color);
    await page.mouse.move(0, 0);
    await page.keyboard.press('Tab');
    await refresh.focus();
    await expect(refresh).toBeFocused();
    await expect
      .poll(() => refresh.evaluate((button) => button.matches(':focus-visible')))
      .toBe(true);
    await expect
      .poll(() => refresh.evaluate((button) => getComputedStyle(button).outlineStyle))
      .not.toBe('none');
    await expect(refresh).toHaveCSS('background-color', idle.background);
    await refresh.evaluate((button) => (button as HTMLElement).blur());
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(navigation).toBeVisible();
  await expectSelectedNavigation();
  const navigationBox = await navigation.boundingBox();
  expect(navigationBox).not.toBeNull();
  expect(navigationBox!.width).toBeGreaterThanOrEqual(36);
  expect(navigationBox!.height).toBeGreaterThanOrEqual(36);
  expect(navigationBox!.x).toBeGreaterThanOrEqual(0);
  expect(navigationBox!.x + navigationBox!.width).toBeLessThanOrEqual(390);
  const compactSize = await page
    .locator('html')
    .evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).getPropertyValue('--mar-compact-control-size'))
    );
  for (const [opener, control, size] of [
    ['打开文件', refresh, 26],
    ['打开会话列表', page.getByRole('button', { name: '刷新当前工作区会话' }), compactSize]
  ] as const) {
    await page.getByRole('button', { name: opener, exact: true }).click();
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box?.width).toBe(size);
    expect(box?.height).toBe(size);
    const scrim = page.getByRole('button', { name: '关闭工作区工具', exact: true });
    const bounds = await scrim.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.click(bounds!.x + bounds!.width - 12, bounds!.y + 64);
    await expect(scrim).toHaveCount(0);
  }
});

for (const recovery of [
  { label: 'Fresh connection', resumed: false, action: 'reconnect' },
  { label: 'Resumed connection', resumed: true, action: 'reconnect' },
  { label: 'Returning from background', resumed: false, action: 'visibility' },
  { label: 'Window focus restoration', resumed: false, action: 'focus' },
  { label: 'Reconnection before focus', resumed: false, action: 'late-focus' },
  { label: 'Returning to work', resumed: false, action: 'navigation' },
  { label: 'Notification center click', resumed: false, action: 'notification' }
]) {
  test(`${recovery.label} reconciles notification reads while preserving unrelated unread counts`, async ({
    page
  }) => {
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    const now = Date.now();
    const target = (sessionId: string) => ({
      targetType: 'WORKSPACE_SESSION',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId
    });
    const entries = ['current-1', 'current-2', 'other'].map((id) => ({
      id,
      kind: 'run',
      title: `Completed ${id}`,
      message: 'Run completed',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 60_000,
      read: false,
      target: target(id === 'other' ? 'session-other' : 'session-1')
    }));
    let notifications: typeof entries = [];
    const readTargets: { nodeId: string; workspaceId: string; sessionId: string }[] = [];
    let listReads = 0;
    await page.route('**/api/notifications', (route) => {
      listReads += 1;
      return json(route, { notifications });
    });
    const singleReads: string[] = [];
    await page.route(/\/api\/notifications\/current-[12]\/read$/, (route) => {
      const id = new URL(route.request().url()).pathname.split('/')[3]!;
      singleReads.push(id);
      notifications = notifications.map((entry) => ({
        ...entry,
        read: entry.read || entry.id === id
      }));
      return json(route, {});
    });
    await page.route('**/api/notifications/session/read', (route) => {
      const reading = route.request().postDataJSON() as (typeof readTargets)[number];
      readTargets.push(reading);
      notifications = notifications.map((entry) => ({
        ...entry,
        read:
          entry.read ||
          (entry.target.nodeId === reading.nodeId &&
            entry.target.workspaceId === reading.workspaceId &&
            entry.target.sessionId === reading.sessionId)
      }));
      return json(route, {});
    });
    await page.goto('/console');
    await page.getByRole('button', { name: '进入控制台' }).click();
    await page.getByRole('button', { name: '工作', exact: true }).click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
    const selectedSession = page.locator('.session-list button').first();
    const listsBeforeSelection = listReads;
    await selectedSession.click();
    await expect(selectedSession).toHaveClass(/selected/);
    await expect(page.getByRole('status', { name: '正在加载会话记录…' })).toHaveCount(0);
    expect(readTargets).toHaveLength(0);
    expect(listReads).toBe(listsBeforeSelection);
    if (recovery.action === 'notification')
      await page.getByRole('button', { name: '新建会话', exact: true }).click();
    if (recovery.action === 'focus' || recovery.action === 'late-focus') {
      await page.evaluate(() =>
        Object.defineProperty(document, 'hasFocus', {
          configurable: true,
          value: () => false
        })
      );
    }
    notifications = entries;
    const center = page.getByRole('button', { name: '打开通知中心' });
    await center.click();
    await expect(center.locator('.workbench-notification-badge')).toHaveText('3');
    await expect(selectedSession.locator('.session-unread-label')).toBeVisible();
    const readsBeforeRecovery = readTargets.length;
    const connectionCount = () =>
      page.evaluate(
        () =>
          (window as unknown as { __consoleMockWorkbenchWebSocket: { instances: unknown[] } })
            .__consoleMockWorkbenchWebSocket.instances.length
      );
    const connectionsBefore = await connectionCount();
    if (recovery.action === 'notification') {
      await page.getByRole('button', { name: /^Completed current-1/ }).click();
    } else if (recovery.action === 'navigation') {
      await center.click();
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '工作', exact: true }).click();
    } else {
      if (recovery.action === 'late-focus')
        notifications = [
          ...notifications,
          { ...entries[2]!, id: 'recovery-snapshot', title: 'Recovered snapshot' }
        ];
      await page.evaluate(({ resumed, action }) => {
        const mock = (
          window as unknown as {
            __consoleMockWorkbenchWebSocket: { resumeAsResumed: boolean; closeActive(): void };
          }
        ).__consoleMockWorkbenchWebSocket;
        mock.resumeAsResumed = resumed;
        if (action === 'visibility') {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden'
          });
          document.dispatchEvent(new Event('visibilitychange'));
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible'
          });
          document.dispatchEvent(new Event('visibilitychange'));
        } else if (action === 'focus') {
          Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
          window.dispatchEvent(new Event('focus'));
        } else mock.closeActive();
      }, recovery);
      if (recovery.action === 'late-focus') {
        await expect(center.locator('.workbench-notification-badge')).toHaveText('4');
        expect(readTargets).toHaveLength(readsBeforeRecovery);
        await page.evaluate(() => {
          Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
          window.dispatchEvent(new Event('focus'));
        });
      }
    }
    const singleItem = recovery.action === 'notification';
    await expect(center.locator('.workbench-notification-badge')).toHaveText(
      singleItem || recovery.action === 'late-focus' ? '2' : '1'
    );
    await expect(selectedSession.locator('.session-unread-label')).toHaveCount(singleItem ? 1 : 0);
    expect(readTargets.slice(readsBeforeRecovery)).toEqual(
      singleItem ? [] : [{ nodeId: 'node-1', workspaceId: 'workspace-1', sessionId: 'session-1' }]
    );
    expect(singleReads).toEqual(singleItem ? ['current-1'] : []);
    if (recovery.action === 'focus') expect(await connectionCount()).toBe(connectionsBefore);
    expect(notifications.find((entry) => entry.id === 'other')?.read).toBe(false);
    if (recovery.action === 'late-focus')
      expect(notifications.find((entry) => entry.id === 'recovery-snapshot')?.read).toBe(false);
  });
}

test('Desktop Console uses 110% density and a continuous workspace layout', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  const notificationNow = Date.now();
  await page.route('**/api/notifications', (route) =>
    json(route, {
      notifications: [
        {
          id: 'desktop-notification',
          kind: 'run',
          title: 'Run complete',
          message: 'Open the run.',
          createdAt: notificationNow,
          updatedAt: notificationNow,
          expiresAt: notificationNow + 60_000,
          read: false
        }
      ]
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  const notificationButton = page.getByRole('button', { name: '打开通知中心' });
  await expect(notificationButton.locator('.workbench-notification-badge')).toHaveText('1');
  const badgePosition = await notificationButton.evaluate((button) => {
    const icon = button.querySelector('.el-icon')!.getBoundingClientRect();
    const badge = button.querySelector('.workbench-notification-badge')!.getBoundingClientRect();
    return {
      horizontalOverlap: icon.right - badge.left,
      verticalOverlap: badge.bottom - icon.top
    };
  });
  expect(badgePosition.horizontalOverlap).toBeGreaterThanOrEqual(6);
  expect(badgePosition.verticalOverlap).toBeGreaterThanOrEqual(6);
  await expect(page.locator('html')).toHaveClass(/console-ui/);
  await expect(page.locator('html')).toHaveCSS('font-size', '17.6px');
  await expect(page.locator('html')).toHaveCSS('--el-font-size-small', '14px');
  await expect(page.getByTestId('workbench-brand')).toHaveCSS('width', '296px');
  await expect(page.locator('.activity-rail')).toHaveCSS('width', '52px');
  const navigationBounds = await page
    .getByRole('button', { name: '工作', exact: true })
    .evaluate((button) => {
      const buttonBounds = button.getBoundingClientRect();
      const railBounds = button.closest('.activity-rail')!.getBoundingClientRect();
      const contentBounds = button.querySelector('.nav-item-content')!.getBoundingClientRect();
      return {
        buttonLeft: buttonBounds.left,
        buttonRight: buttonBounds.right,
        contentCenter: contentBounds.left + contentBounds.width / 2,
        railLeft: railBounds.left,
        railRight: railBounds.right,
        railCenter: railBounds.left + railBounds.width / 2
      };
    });
  const leftInset = navigationBounds.buttonLeft - navigationBounds.railLeft;
  const rightInset = navigationBounds.railRight - navigationBounds.buttonRight;
  expect(leftInset).toBeGreaterThanOrEqual(1);
  expect(rightInset).toBeGreaterThanOrEqual(1);
  expect(Math.abs(leftInset - rightInset)).toBeLessThanOrEqual(1);
  expect(
    Math.abs(navigationBounds.contentCenter - navigationBounds.railCenter)
  ).toBeLessThanOrEqual(1);
  await expect(page.locator('.workspace-tree')).toHaveCSS('width', '244px');
  await expect(page.locator('.workbench-header')).toHaveCSS('height', '44px');
  const helpLink = page.getByRole('link', { name: '帮助' });
  const helpStyle = await helpLink.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    color: getComputedStyle(element).color
  }));
  await helpLink.hover();
  await expect(helpLink).toHaveCSS('background-color', helpStyle.background);
  await expect
    .poll(() => helpLink.evaluate((element) => getComputedStyle(element).color))
    .not.toBe(helpStyle.color);
  const headerUtilityGeometry = await page.evaluate(() => {
    const header = document
      .querySelector<HTMLElement>('.workbench-header')!
      .getBoundingClientRect();
    const help = document
      .querySelector<HTMLElement>('.documentation-link')!
      .getBoundingClientRect();
    const notification = document
      .querySelector<HTMLElement>('.global-notification-center')!
      .getBoundingClientRect();
    const treeToggle = document
      .querySelector<HTMLElement>('.workbench-tree-toggle')!
      .getBoundingClientRect();
    const headerCenter = header.top + header.height / 2;
    return {
      helpCenterOffset: Math.abs(help.top + help.height / 2 - headerCenter),
      notificationCenterOffset: Math.abs(notification.top + notification.height / 2 - headerCenter),
      treeToggleCenterOffset: Math.abs(treeToggle.top + treeToggle.height / 2 - headerCenter)
    };
  });
  expect(headerUtilityGeometry.helpCenterOffset).toBeLessThanOrEqual(1);
  expect(headerUtilityGeometry.notificationCenterOffset).toBeLessThanOrEqual(1);
  expect(headerUtilityGeometry.treeToggleCenterOffset).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: '展开工作区' }).click();
  await page.locator('.workspace-branch-button').first().click();
  await expect(page.locator('.workbench-header .workspace-tab-strip-header')).toHaveCount(1);
  await expect(page.locator('.session-layout > .workspace-tab-strip')).toHaveCount(0);
  const headerWorkspaceTabs = page.locator('.workbench-header .workspace-tab');
  await expect(headerWorkspaceTabs).toHaveCount(1);
  await expect(headerWorkspaceTabs.first()).toContainText('project');
  await expect(headerWorkspaceTabs.first()).toContainText('node-1');
  const headerStartGeometry = await page.evaluate(() => {
    const toggle = document.querySelector<HTMLElement>('.workbench-tree-toggle')!;
    const tabs = document.querySelector<HTMLElement>('.workspace-tabs-slot')!;
    return {
      gap: tabs.getBoundingClientRect().left - toggle.getBoundingClientRect().right,
      previousScrollButtonCount: document.querySelectorAll(
        '.workspace-tab-strip-header [aria-label="向左浏览工作区标签"]'
      ).length
    };
  });
  expect(headerStartGeometry.gap).toBeLessThanOrEqual(1);
  expect(headerStartGeometry.previousScrollButtonCount).toBe(0);
  const headerTabGeometry = await page
    .locator('.workbench-header .workspace-tab-strip-header')
    .evaluate((strip) => {
      const header = strip.closest('.workbench-header')!.getBoundingClientRect();
      const tab = strip.querySelector('.workspace-tab')!.getBoundingClientRect();
      return { headerCenter: header.top + header.height / 2, tabCenter: tab.top + tab.height / 2 };
    });
  expect(
    Math.abs(headerTabGeometry.headerCenter - headerTabGeometry.tabCenter)
  ).toBeLessThanOrEqual(1);
  const [headerTabsBounds, helpBounds] = await Promise.all([
    page.locator('.workbench-header .workspace-tabs-slot').boundingBox(),
    page.getByRole('link', { name: '帮助' }).boundingBox()
  ]);
  expect(headerTabsBounds).not.toBeNull();
  expect(helpBounds).not.toBeNull();
  expect(headerTabsBounds!.x + headerTabsBounds!.width).toBeLessThanOrEqual(helpBounds!.x);

  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settingsPanel = page.locator('.settings-panel').first();
  await expect(settingsPanel).toHaveCSS('border-top-width', '0px');
  await expect(settingsPanel).toHaveCSS('max-width', '960px');
  await expect(page.locator('.account-summary')).toHaveCSS('font-size', '14px');
  await page.getByRole('button', { name: '快捷键', exact: true }).click();
  await expect(page.locator('.shortcut-list dd').first()).toHaveCSS('font-size', '14px');
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 }
  ]) {
    await page.setViewportSize(viewport);
    const bounds = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight
    }));
    expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.viewportWidth);
    expect(bounds.documentHeight).toBeLessThanOrEqual(bounds.viewportHeight);
  }
});

test('Mobile Work mode mounts Workspace Tabs only above the main content', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await expect(page.locator('.workspace-tab-strip-header')).toHaveCount(0);
  await expect(page.locator('.session-layout > .workspace-tab-strip-body')).toHaveCount(0);
  await page.getByRole('button', { name: '展开工作区' }).click();
  await page.locator('.workspace-branch-button').first().click();

  await expect(page.locator('.workbench-header')).toHaveCount(0);
  await expect(page.locator('.session-layout > .workspace-tab-strip-body')).toHaveCount(1);
  const workspaceTabs = page.locator('.session-layout > .workspace-tab-strip-body .workspace-tab');
  await expect(workspaceTabs).toHaveCount(1);
  await expect(workspaceTabs.first()).toContainText('project');
  await expect(workspaceTabs.first()).toContainText('node-1');
  await expect(page.locator('.workspace-tab-strip-header')).toHaveCount(0);
});

test('Admin Console renders controlled Sessions, Runs, approvals, and text events from Node capabilities', async ({
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
    ['history.read', 'events.live', 'turn.start', 'turn.steer', 'turn.interrupt'],
    writes
  );
  await page.addInitScript(() => {
    // This case explicitly verifies the Daylight palette, independent of the default theme.
    localStorage.setItem('mar.theme', 'daylight');
    HTMLAnchorElement.prototype.click = function click(): void {
      (
        window as unknown as {
          __lastDownload?: { href: string; filename: string };
        }
      ).__lastDownload = { href: this.href, filename: this.download };
    };
  });
  await page.route('**/api/nodes', (route) =>
    json(route, {
      nodes: [
        {
          id: 'node-1',
          displayName: '开发节点',
          registeredAddress: '127.0.0.1',
          platform: 'linux',
          architecture: 'x64',
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
  await page.route('**/api/agent-runs/run-1/interrupt', (route) =>
    write(route, writes, {
      run: {
        id: 'run-1',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        status: 'INTERRUPTED',
        recoveryState: 'ACTIVE',
        clientMessageId: 'message-1'
      }
    })
  );
  await page.route(
    /\/api\/workspaces\/workspace-1\/queue\?nodeId=node-1&sessionId=session-1$/,
    (route) =>
      json(route, {
        queue: {
          version: 1,
          paused: false,
          items: [
            {
              queueItemId: 'queue-item-1',
              sessionId: 'session-1',
              workspaceId: 'workspace-1',
              runner: 'codex',
              clientMessageId: 'queued-message-1',
              sessionTitle: '现有会话',
              content: '稍后发送的消息',
              createdAt: 2
            }
          ]
        }
      })
  );

  await page.goto('/console');
  await expect(page).toHaveTitle('MyAgentRoam');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    'href',
    '/favicon.ico?v=logo-20261011'
  );
  await expect(page.locator('html')).toHaveCSS('--mar-color-brand', '#0a6fd8');
  await expect(page.locator('html')).toHaveCSS('--el-color-primary', '#0a6fd8');
  await expect(page.locator('html')).toHaveCSS('--mar-border-default', '#dce3ea');
  await expect(page.locator('html')).toHaveCSS('--mar-border-subtle', '#e7ecf2');
  await expect(page.getByRole('button', { name: '进入控制台' })).toHaveClass(/el-button/);
  await expect(page.getByRole('button', { name: '进入控制台' })).not.toHaveClass(
    /el-button--small/
  );
  await expect(page.locator('.auth-form .el-input').first()).not.toHaveClass(/el-input--small/);
  await expect(page.locator('.gate-panel')).toHaveCSS('border-radius', '8px');
  await expect(page.locator('.gate-panel')).toHaveCSS('box-shadow', 'none');
  await expect(page.locator('.auth-form .el-input__wrapper').first()).toHaveCSS(
    'min-height',
    '34px'
  );
  await expect(page.getByRole('button', { name: '进入控制台' })).toHaveCSS('min-height', '34px');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const placeholderTab = page.locator('.workbench-header .workspace-tab-placeholder');
  await expect(placeholderTab).toHaveCount(1);
  await expect(placeholderTab).toContainText('新标签页');
  await expect(placeholderTab).toContainText('选择一个工作区开始');
  await expect(placeholderTab.locator('.tab-close')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '工作', exact: true })).toHaveCSS(
    'border-left-color',
    'rgb(19, 95, 168)'
  );
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /开发节点/ })
    .click();
  await expect(page.locator('.tree-node-content > small')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toHaveCount(0);
  await expect(page.getByText('节点在线', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Node 在线，操作仍以 Node 返回的会话能力为准。')).toHaveCount(0);
  await expect(page.locator('.workspace-tabs')).toHaveCount(1);
  // Expanding a Node does not create a separate current-Node selection.
  await expect(placeholderTab).not.toContainText('开发节点');
  await expect(placeholderTab).toContainText('新标签页');
  await expect(placeholderTab).toContainText('选择一个工作区开始');
  const placeholderBackground = await placeholderTab.evaluate((tab) => {
    const style = getComputedStyle(tab);
    return [style.backgroundColor, style.backgroundImage].join(' ');
  });
  expect(placeholderBackground).toContain('rgb(228, 239, 251)');
  await expect(placeholderTab).toHaveCSS('color', 'rgb(19, 95, 168)');
  await expect(placeholderTab).toHaveCSS('min-height', '32px');
  const placeholderGeometry = await placeholderTab.evaluate((tab) => {
    const header = tab.closest('.workbench-header')!.getBoundingClientRect();
    const bounds = tab.getBoundingClientRect();
    return {
      centerOffset: Math.abs(bounds.top + bounds.height / 2 - (header.top + header.height / 2)),
      height: bounds.height
    };
  });
  expect(placeholderGeometry.centerOffset).toBeLessThanOrEqual(1);
  expect(placeholderGeometry.height).toBeGreaterThanOrEqual(32);
  await expect(page.getByText('最多打开六个工作区；从左侧资源管理器选择一个工作区。')).toHaveCount(
    0
  );
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: 'project', exact: true })
    .click();
  await expect(page).toHaveTitle('MyAgentRoam - project');
  await expect(page.getByRole('heading', { name: '新建会话' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '新建会话' })).toHaveCSS('font-weight', '500');
  await expect(page.getByRole('heading', { name: '会话', exact: true })).toHaveCSS(
    'font-weight',
    '500'
  );
  await expect(page.getByRole('heading', { name: '文件与更改' })).toHaveCSS('font-weight', '500');
  await expect(page.getByRole('heading', { name: '文件与更改' })).toHaveCSS('font-size', '13px');
  await expect(page.getByRole('heading', { name: '选择一个会话' })).toHaveCount(0);

  await expect(page.locator('.workspace-kind-tag')).toHaveText('Git');
  await expect(page.locator('.session-heading-meta .workspace-branch-tag')).toHaveText('master');
  await expect(page.locator('.session-count-tag')).toHaveCount(0);
  await expect(page.locator('.workspace-grid')).toHaveCSS('border-radius', '0px');
  await expect(page.locator('.workbench-header .workspace-tabs')).toHaveCSS('min-height', '0px');
  await expect(page.locator('.workspace-grid')).toHaveCSS('border-top-width', '0px');
  await expect(page.locator('.workspace-grid')).toHaveCSS(
    'border-bottom-color',
    'rgb(220, 227, 234)'
  );
  await expect(page.locator('.workspace-tab.active small')).toHaveText('开发节点');
  await expect(page.locator('.workspace-tab.active > button').first()).toHaveCSS(
    'cursor',
    'pointer'
  );
  await expect(page.locator('.workspace-tab.active .tab-close')).toHaveCSS('cursor', 'pointer');
  await expect(page.locator('.new-session-button')).toHaveCSS('justify-content', 'flex-start');
  await expect(page.locator('.new-session-button')).toHaveCSS('height', '32px');
  await expect(page.locator('.session-link').first()).toHaveCSS('min-height', '34px');
  const searchSessionsButton = page.getByRole('button', { name: '刷新当前工作区会话' });
  await expect(searchSessionsButton).toHaveCSS('height', '26px');
  await expect(searchSessionsButton).toHaveAttribute('type', 'submit');
  await expect(searchSessionsButton).toHaveClass(/utility-control/u);
  const workspaceMoreButton = page.locator('.new-session-form .workspace-more-button');
  await expect(workspaceMoreButton).toHaveAttribute('type', 'button');
  await expect(workspaceMoreButton).toHaveClass(/utility-control/u);
  const workspaceGridGeometry = await page.locator('.session-layout').evaluate((layout) => {
    const grid = layout.querySelector<HTMLElement>('.workspace-grid');
    if (grid === null) throw new Error('workspace grid is missing');
    const layoutRect = layout.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    return {
      leftInset: gridRect.left - layoutRect.left,
      rightInset: layoutRect.right - gridRect.right,
      topInset: gridRect.top - layoutRect.top
    };
  });
  expect(workspaceGridGeometry.leftInset).toBeLessThanOrEqual(1);
  expect(workspaceGridGeometry.rightInset).toBeLessThanOrEqual(1);
  expect(workspaceGridGeometry.topInset).toBeLessThanOrEqual(1);
  await expect(page.locator('.session-list')).toHaveCSS('overflow-y', 'auto');
  const workspaceBounds = await page.locator('.workspace-grid').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { height: rect.height, bottom: rect.bottom, viewportHeight: window.innerHeight };
  });
  expect(workspaceBounds.height).toBeGreaterThan(0);
  expect(workspaceBounds.bottom).toBeLessThanOrEqual(workspaceBounds.viewportHeight);
  const documentBounds = await page.evaluate(() => ({
    bodyHeight: document.body.scrollHeight,
    documentHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight
  }));
  expect(documentBounds.bodyHeight).toBeLessThanOrEqual(documentBounds.viewportHeight);
  expect(documentBounds.documentHeight).toBeLessThanOrEqual(documentBounds.viewportHeight);
  await expect(page.getByLabel('选择中断上传的原文件')).toBeHidden();
  expect(
    await page.locator('.workbench').evaluate((element) => element.getBoundingClientRect().top)
  ).toBe(0);
  await expect(page.getByRole('heading', { name: '文件与更改' })).toBeVisible();
  await expect(page.getByRole('button', { name: '返回上级', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '返回根目录' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '搜索文件' })).toHaveCount(0);
  const refreshFilesButton = page.getByRole('button', { name: '刷新文件' });
  await expect(refreshFilesButton).toBeVisible();
  await expect(page.getByRole('button', { name: '上传文件' })).toBeVisible();
  await expect(refreshFilesButton).toHaveAttribute('type', 'button');
  await expect(refreshFilesButton).toHaveClass(/file-explorer-utility-button/u);
  await expect(refreshFilesButton).toHaveClass(/utility-control/u);
  await expect(refreshFilesButton).not.toHaveClass(/el-button/u);
  await expect(page.getByRole('button', { name: '.. 返回上级目录' })).toHaveCount(0);
  await expect(page.getByRole('treeitem', { name: 'project' })).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  expect(
    await page.getByRole('tree', { name: '文件树' }).evaluate((element) => element.scrollHeight)
  ).toBeGreaterThan(0);
  const openedExplorerEntry = page
    .getByRole('tree', { name: '文件树' })
    .getByRole('treeitem', { name: 'main.ts' })
    .first();
  await expect(openedExplorerEntry).toBeVisible();
  await openedExplorerEntry.click();
  await expect(openedExplorerEntry).toHaveAttribute('aria-selected', 'true');
  const preview = page.getByRole('dialog', { name: 'src/main.ts 文件预览' });
  await expect(preview).toBeVisible();
  await expect(preview).toHaveCSS('position', 'static');
  await expect(page.getByText('export const answer = 42;')).toBeVisible();
  await expect(preview.locator('.cm-gutterElement').filter({ hasText: '1' })).toBeVisible();
  await expect(preview.locator('.cm-content')).toContainText('export const answer = 42;');
  await preview.getByRole('button', { name: '下载文件' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __lastDownload?: { href: string; filename: string };
            }
          ).__lastDownload
      )
    )
    .toMatchObject({
      href: expect.stringMatching(/\/api\/workspaces\/workspace-1\/files\/content\?.*download=1/u),
      filename: 'main.ts'
    });
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  const managedStatus = page.locator('.session-activity.managed_active');
  await expect(managedStatus).toHaveCount(1);
  await expect(managedStatus.first()).toHaveAttribute('role', 'img');
  await expect(managedStatus.first()).toHaveAttribute('aria-label', '运行中');
  await expect(managedStatus.first()).not.toHaveAttribute('title');
  await expect(managedStatus.first()).toHaveText('');
  await expect(managedStatus.first().locator('i')).toHaveCSS(
    'background-color',
    'rgb(23, 128, 61)'
  );
  const existingSession = page.locator('.session-list button').first();
  const existingSessionTitle =
    (await existingSession.locator('strong').textContent())?.trim() ?? '';
  await existingSession.click();
  await expect(page.locator('.conversation-header h2')).toHaveText(existingSessionTitle);
  await expect(page.locator('.conversation-title-runner-icon')).toHaveAttribute(
    'data-runner',
    'codex'
  );
  await expect(page.locator('.conversation-session-id')).toHaveText('session-1');
  await expect(page.locator('.conversation-session-id button')).toHaveAttribute(
    'title',
    /session-1/u
  );
  await expect(page.locator('.conversation-session-id code')).toHaveCSS('font-size', '12.1px');
  await expect(page.locator('.conversation-session-id code')).toHaveCSS(
    'color',
    'rgb(98, 115, 134)'
  );
  await expect(managedStatus).toHaveCount(2);
  await expect(page.locator('.session-link-content').first()).toHaveCSS('display', 'grid');
  await expect(page.locator('.session-link').first()).toHaveCSS('min-height', '34px');
  await expect(page.locator('.session-list .session-link').first()).toHaveCSS('cursor', 'pointer');
  const firstSessionTitle = page.locator('.session-link-content strong').first();
  await expect(firstSessionTitle).toHaveAttribute('title', existingSessionTitle);
  await expect(firstSessionTitle).toHaveCSS('text-overflow', 'ellipsis');
  await expect(page.locator('.conversation-header h2')).toHaveAttribute(
    'title',
    existingSessionTitle
  );
  await expect(page.locator('.session-title-row .runner-brand-icon')).toHaveAttribute(
    'data-runner',
    'codex'
  );
  await expect(page.locator('.conversation-title-row .runner-brand-icon')).toHaveAttribute(
    'data-runner',
    'codex'
  );
  await expect(page.locator('.session-runner')).toHaveCount(0);
  await expect(page.locator('.conversation-runner')).toHaveCount(0);
  await expect(page.getByText('运行记录', { exact: true })).toHaveCount(0);
  await expect(page.locator('.conversation-timeline ol')).toHaveCount(0);
  await expect(page.getByText('本轮快照', { exact: true })).toHaveCount(0);
  await expect(page.getByText('运行更新', { exact: true })).toHaveCount(0);
  await expect(page.getByText('此项由目标 Runner 提供。', { exact: true })).toHaveCount(0);
  await expect(
    page
      .locator('.conversation-message')
      .evaluateAll((items) => items.map((item) => item.textContent?.trim()))
  ).resolves.toEqual([]);
  await expect(page.locator('.agent-markdown').filter({ hasText: '正在同步对话' })).toHaveCount(1);
  await expect(page.locator('.conversation-item.assistant_message').first()).toHaveCSS(
    'border-radius',
    '8px'
  );
  await expect(page.locator('.conversation-item.assistant_message').first()).toHaveCSS(
    'box-shadow',
    'none'
  );
  await expect
    .poll(() =>
      page
        .locator('.conversation-scroll')
        .evaluate((element) => element.scrollWidth <= element.clientWidth)
    )
    .toBe(true);
  await expect(page.locator('.conversation-item.tool_call').first()).toHaveCSS(
    'background-color',
    'rgb(246, 248, 250)'
  );
  await expect(page.locator('.composer-model-effort-select input')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '权限' })).toBeVisible();
  await expect(page.locator('.composer-shell')).toHaveCSS('border-radius', '8px');
  await expect(page.locator('.composer-shell .composer-input')).toHaveCSS('min-height', '96px');
  await expect(page.locator('.composer-working')).toHaveText(/运行中 · \d+s/);
  await expect(page.getByRole('button', { name: '停止运行' })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止运行' })).toHaveCSS('cursor', 'pointer');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toHaveCount(0);
  await expect(page.getByText('Enter 排队 · Ctrl + Enter 插入消息', { exact: true })).toBeVisible();
  await expect(page.getByText('<img src=x onerror=alert(1)>')).toHaveCount(0);
  await expect(page.locator('.conversation-scroll img')).toHaveCount(0);
  await expect(page.locator('.conversation-item.approval_request')).toHaveCount(2);
  await expect(
    page.locator('.conversation-item.approval_request').filter({ hasText: 'pwd' })
  ).toBeVisible();
  await expect(page.getByText('git status', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '允许' })).toBeVisible();

  await page.getByRole('textbox', { name: '输入消息' }).focus();
  const interruptResponse = page.waitForResponse((response) =>
    response.url().includes('/interrupt')
  );
  await page.keyboard.press('Escape');
  await interruptResponse;
  await expect(page.getByRole('button', { name: '停止运行' })).toBeVisible();
  await expect(page.getByRole('button', { name: '暂停消息队列' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toHaveCount(0);

  const composer = page.getByRole('textbox', { name: '输入消息' });
  await composer.fill('insert safely');
  const queuedResponse = page.waitForResponse((response) => response.url().includes('/messages'));
  await composer.press('Enter');
  await queuedResponse;
  const decisionResponse = page.waitForResponse((response) => response.url().includes('/decision'));
  await page.getByRole('button', { name: '允许' }).click();
  await decisionResponse;
  await emitMockSessionEvent(page, 'conversation', {
    sessionId: 'session-1',
    runId: 'run-1',
    item: {
      itemId: 'run-1:approval:approval-1',
      kind: 'approval_request',
      status: 'COMPLETED',
      startedAt: 1,
      completedAt: 1_900_000_002_000,
      segmentId: 'turn-1:segment:0',
      segmentIndex: 0,
      payload: {
        approvalId: 'approval-1',
        approvalStatus: 'APPROVED',
        approval: { toolName: 'Bash', input: { command: 'pwd' } },
        expiresAt: 1_900_000_000_000
      }
    }
  });
  await expect(
    page.locator('.conversation-item.approval_request').filter({ hasText: 'pwd' })
  ).toContainText('已允许');
  await expect(page.getByRole('button', { name: '允许' })).toHaveCount(0);
  expect(writes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ url: expect.stringContaining('/messages'), csrf: 'csrf-1' }),
      expect.objectContaining({ url: expect.stringContaining('/interrupt'), csrf: 'csrf-1' }),
      expect.objectContaining({ url: expect.stringContaining('/decision'), csrf: 'csrf-1' })
    ])
  );
});

test('Page-level Workbench WebSocket coalesces high-frequency events without turn backfill', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  let turnRequests = 0;
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'events.live', 'turn.start', 'turn.steer', 'turn.interrupt'],
    writes
  );
  await page.route(
    /\/api\/agent-sessions\/session-1\/turns\?nodeId=node-1&limit=10(?:&unit=SEGMENT)?$/,
    async (route) => {
      turnRequests += 1;
      await json(route, {
        turns: [
          {
            id: 'turn-1',
            sessionId: 'session-1',
            runId: 'run-1',
            userItemId: null,
            status: 'RUNNING',
            model: null,
            effort: null,
            access: null,
            items: [
              {
                id: 'official-input',
                kind: 'user_input_request',
                status: 'PENDING',
                payload: {
                  requestId: 'same-live-request',
                  questions: [
                    {
                      id: 'scope',
                      prompt: '实时问答不能重复',
                      input: 'SINGLE_SELECT',
                      options: [{ value: 'continue', label: '继续', description: null }],
                      allowOther: false
                    }
                  ]
                }
              }
            ],
            startedAt: 1,
            completedAt: null
          }
        ],
        nextCursor: null
      });
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
  await page.locator('.session-list button').first().click();
  for (let index = 1; index <= 24; index += 1)
    await emitMockSessionEvent(page, 'conversation', {
      sessionId: 'session-1',
      runId: 'run-1',
      item: {
        itemId: `run-1:tool-${index}`,
        kind: 'tool_call',
        status: 'IN_PROGRESS',
        segmentId: 'turn-1:segment:0',
        segmentIndex: 0,
        payload: { title: `读取文件 ${index}` }
      }
    });
  await emitMockSessionEvent(page, 'conversation', {
    sessionId: 'session-1',
    runId: 'run-1',
    item: {
      itemId: 'run-1:runtime-input',
      kind: 'user_input_request',
      status: 'PENDING',
      segmentId: 'turn-1:segment:0',
      segmentIndex: 0,
      payload: {
        requestId: 'same-live-request',
        questions: [
          {
            id: 'scope',
            prompt: '实时问答不能重复',
            input: 'SINGLE_SELECT',
            options: [{ value: 'continue', label: '继续', description: null }],
            allowOther: false
          }
        ]
      }
    }
  });
  await emitMockSessionEvent(page, 'session', {
    session: {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      externalSessionId: 'vscode-thread-1',
      runnerTitle: '推送后的会话标题',
      activity: 'MANAGED_ACTIVE',
      control: {
        level: 'MANAGED',
        capabilities: ['history.read', 'events.live', 'turn.start', 'turn.steer', 'turn.interrupt']
      }
    }
  });
  await page.waitForTimeout(400);
  expect(turnRequests).toBe(0);
  await page.locator('.conversation-item.tool_call summary').click();
  await expect(page.getByText('读取文件 24', { exact: true })).toHaveCount(1);
  await expect(page.locator('.user-input-card')).toHaveCount(1);
  await expect(page.getByText('实时问答不能重复')).toHaveCount(1);
  await expect(page.locator('.session-list')).toContainText('推送后的会话标题');
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { __consoleMockWorkbenchWebSocket: { instances: unknown[] } }
        ).__consoleMockWorkbenchWebSocket.instances.filter(
          (socket) =>
            typeof socket === 'object' &&
            socket !== null &&
            'url' in socket &&
            typeof (socket as { url?: unknown }).url === 'string' &&
            (socket as { url: string }).url.includes('/api/workbench/live')
        ).length
    )
  ).toBe(1);
});

test('Workbench direct discovery waits for ready and follows visible-page connection replacement', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'events.live'], []);
  let discoveries = 0;
  await page.route('**/api/nodes/node-1/workbench-capabilities', async (route) => {
    discoveries++;
    await json(route, {
      manifest: {
        manifestVersion: 1,
        observedAt: 1_900_000_000_000,
        nodeGeneration: 'mock-node-generation',
        conversation: { available: true, reasonCode: null },
        files: { available: true, reasonCode: null },
        git: { available: true, reasonCode: null, supportsHistory: true },
        terminal: { available: false, reasonCode: 'UNAVAILABLE' },
        directTransfer: { apiVersion: 3, transport: true }
      }
    });
  });
  await page.goto('/console');
  await page.evaluate(() => {
    const socketClass = (window as unknown as { __consoleMockWorkbenchWebSocket: typeof WebSocket })
      .__consoleMockWorkbenchWebSocket;
    const original = socketClass.prototype.send;
    const state = { prepares: 0 };
    Object.assign(window, { directLifecycle: state });
    socketClass.prototype.send = function (data) {
      const message = JSON.parse(String(data)) as { type: string };
      if (message.type === 'direct.prepare') state.prepares++;
      // Ready is delivered explicitly, including after reconnect removes the old socket.
      if (message.type !== 'resume') original.call(this, data);
    };
  });
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  const prepares = () =>
    page.evaluate(
      () =>
        (window as unknown as { directLifecycle: { prepares: number } }).directLifecycle.prepares
    );
  const ready = () =>
    page.evaluate(() => {
      const sockets = (
        window as unknown as { __consoleMockWorkbenchWebSocket: { instances: WebSocket[] } }
      ).__consoleMockWorkbenchWebSocket.instances;
      sockets.at(-1)!.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'workbench.ready',
            workbenchConnectionId: 'mock-workbench-connection',
            workbenchResumeToken: 'mock-workbench-token',
            resumed: true
          })
        })
      );
    });
  expect(await prepares()).toBe(0);
  await ready();
  await expect.poll(prepares).toBe(1);
  const socketCount = () =>
    page.evaluate(
      () =>
        (
          window as unknown as { __consoleMockWorkbenchWebSocket: { instances: WebSocket[] } }
        ).__consoleMockWorkbenchWebSocket.instances.filter((socket) =>
          socket.url.includes('/api/workbench/live')
        ).length
    );
  const beforeReplacement = await socketCount();
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(socketCount).toBe(beforeReplacement + 1);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { __consoleMockWorkbenchWebSocket: { instances: WebSocket[] } }
        ).__consoleMockWorkbenchWebSocket.instances.filter(
          (socket) =>
            socket.url.includes('/api/workbench/live') && socket.readyState === WebSocket.OPEN
        ).length
    )
  ).toBe(1);
  const beforeReady = discoveries;
  // A real event-loop turn must not discover using the replaced connection identity.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  expect(discoveries).toBe(beforeReady);
  expect(await prepares()).toBe(1);
  await ready();
  await expect.poll(prepares).toBe(2);
});

test('Explicit session searches query only the list without restarting Workspace Watch', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  const workspaceWatchRequests: string[] = [];
  const sessionListRequests: {
    readonly url: string;
    readonly workspaceWatchSnapshot: boolean;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname === '/api/workspaces/workspace-1/watch')
      workspaceWatchRequests.push(request.url());
    if (
      url.pathname === '/api/agent-sessions' &&
      url.searchParams.get('workspaceId') === 'workspace-1'
    )
      sessionListRequests.push({
        url: request.url(),
        workspaceWatchSnapshot: request.headers()['x-mar-e2e-workspace-watch-snapshot'] === '1'
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
  await expect(page.getByRole('heading', { name: '会话', exact: true })).toBeVisible();
  await expect.poll(() => workspaceWatchRequests.length).toBeGreaterThan(0);
  await expect.poll(() => sessionListRequests.length).toBeGreaterThan(0);
  const watchRequestsBeforeRefresh = workspaceWatchRequests.length;
  const sessionListRequestsBeforeRefresh = sessionListRequests.length;

  await page.getByRole('textbox', { name: '搜索工作区会话' }).fill('现有会话');
  await page.getByRole('button', { name: '搜索会话' }).click();

  await expect.poll(() => sessionListRequests.length).toBe(sessionListRequestsBeforeRefresh + 1);
  expect(new URL(sessionListRequests.at(-1)!.url).searchParams.get('query')).toBe('现有会话');
  expect(sessionListRequests.at(-1)).toMatchObject({ workspaceWatchSnapshot: false });
  expect(workspaceWatchRequests).toHaveLength(watchRequestsBeforeRefresh);
});
