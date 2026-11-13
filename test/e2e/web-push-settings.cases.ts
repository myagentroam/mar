import { expect, test } from '@playwright/test';
import { mockConsoleApi, json } from './support/web-console-api.js';

for (const device of ['desktop', 'mobile'] as const) {
  for (const language of [
    {
      locale: 'zh-CN',
      open: '进入控制台',
      settings: '设置',
      notifications: '系统通知',
      online: '系统通知',
      summary: '切换到其他页面或应用时，仍可收到通知。关闭工作台后不再提醒。',
      pushSummary: '所有设备上的工作台都离线时，向当前设备发送通知。实际送达受浏览器和系统限制。',
      push: '离线推送',
      disable: '关闭系统通知',
      enabled: '已开启',
      serverUnavailable: '服务器尚未配置离线推送，请联系管理员。',
      systemDisabled: '管理员未开启离线推送。'
    },
    {
      locale: 'en-US',
      open: 'Open console',
      settings: 'Settings',
      notifications: 'System notifications',
      online: 'System notifications',
      summary:
        'Receive notifications when you switch to another page or app. Notifications stop when you close the workbench.',
      pushSummary:
        'Receive notifications on this device when all your workbenches are offline. Delivery depends on your browser and system.',
      push: 'Offline Push',
      disable: 'Disable system notifications',
      enabled: 'Enabled',
      serverUnavailable:
        'This Server is not configured for offline Push. Contact your administrator.',
      systemDisabled: 'Offline Push is disabled by the administrator.'
    }
  ]) {
    test(`System notification channels match device capability: ${device} ${language.locale}`, async ({
      page
    }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
      const capability: { enabled: boolean; available: boolean; publicKey: string | null } = {
        enabled: false,
        available: false,
        publicKey: null
      };
      let capabilityReads = 0;
      await page.route('**/api/notifications/push', (route) => {
        capabilityReads++;
        return json(route, { ...capability, account: 'admin' });
      });
      let registrations = 0;
      await page.route('**/api/notifications/push/clients', (route) => {
        registrations++;
        return json(route, {}, 500);
      });
      await page.addInitScript(
        ({ locale, device }) => {
          if (device === 'mobile')
            Object.defineProperty(navigator, 'userAgent', {
              configurable: true,
              get: () => 'Mozilla/5.0 iPhone'
            });
          // This capability scenario starts without an existing Push subscription.
          if (device === 'mobile' && typeof PushManager !== 'undefined')
            PushManager.prototype.getSubscription = async () => null;
          // Headless Chromium has no OS notification permission integration.
          Object.defineProperty(Notification, 'permission', {
            configurable: true,
            get: () => 'granted'
          });
          localStorage.setItem('mar.locale.v2', locale);
          localStorage.setItem('mar.workbench.system-notifications.v1.admin', 'true');
        },
        { locale: language.locale, device }
      );
      await page.goto('/console');
      await page.getByRole('button', { name: language.open, exact: true }).click();
      await page.getByRole('button', { name: language.settings, exact: true }).click();
      await page.getByRole('button', { name: language.notifications, exact: true }).click();
      await expect(
        page.getByText(device === 'desktop' ? language.summary : language.pushSummary, {
          exact: true
        })
      ).toBeVisible();
      const panel = page.locator('.system-notification-control');
      const online = panel.locator('.notification-channel').first();
      const push = online;
      await expect(panel.locator('.notification-channel')).toHaveCount(1);
      await expect(
        online.getByRole('heading', {
          name: device === 'desktop' ? language.online : language.push,
          exact: true
        })
      ).toBeVisible();
      await expect(online.getByRole('status').first()).toHaveText(language.enabled);
      await expect(online.getByRole('status').first().locator('.el-tag')).toHaveClass(
        /el-tag--success/
      );
      const action = online.getByRole('button').first();
      await expect(action).toHaveClass(/(?:^|\s)mar-text-action(?:\s|$)/);
      await expect(action).toHaveClass(/(?:^|\s)is-link(?:\s|$)/);
      await expect(action).toBeEnabled();
      await action.hover();
      await expect(online.getByRole('button').first()).toHaveCSS(
        'background-color',
        'rgba(0, 0, 0, 0)'
      );
      if (device === 'desktop') {
        await expect(
          online.getByRole('button', { name: language.disable, exact: true })
        ).toBeVisible();
        await expect(panel.getByRole('heading', { name: language.push, exact: true })).toHaveCount(
          0
        );
      } else {
        await expect(push.getByRole('status').last()).toHaveText(language.serverUnavailable);
        expect(capabilityReads).toBeGreaterThan(0);
      }
      const assertLayout = async () => {
        const first = await online.boundingBox();
        const rootFontSize = await page.evaluate(() =>
          Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
        );
        expect(first!.width).toBeLessThanOrEqual(48 * rootFontSize + 1);
        expect(first!.x).toBeGreaterThanOrEqual(0);
        expect(first!.x + first!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        const button = await online.getByRole('button').boundingBox();
        expect(button!.x).toBeGreaterThanOrEqual(first!.x - 1);
        expect(button!.x + button!.width).toBeLessThanOrEqual(first!.x + first!.width + 1);
      };
      await assertLayout();
      await page.screenshot({
        path: test.info().outputPath(`notification-channels-${language.locale}-desktop.png`),
        animations: 'disabled'
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await assertLayout();
      await expect
        .poll(() =>
          online.getByRole('heading').evaluate((node) => {
            const bounds = node.getBoundingClientRect();
            return node.contains(
              document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
            );
          })
        )
        .toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`notification-channels-${language.locale}-mobile.png`),
        animations: 'disabled'
      });
      if (device === 'mobile') {
        capability.available = true;
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect(push.getByRole('status').last()).toHaveText(language.systemDisabled);
        capability.enabled = true;
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect(push.getByRole('status').last()).toHaveText(language.serverUnavailable);
      }
      expect(registrations).toBe(0);
    });
  }
}

test('Web Push settings use real browser storage and a gesture-bound mocked subscription', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const writes: { clientToken: string; enabled: boolean; bindingVersion?: number }[] = [];
  let resolves = 0;
  await page.route('**/api/notifications/push', (route) =>
    json(route, {
      enabled: true,
      available: true,
      account: 'admin',
      publicKey: 'B' + 'A'.repeat(86)
    })
  );
  await page.route('**/api/notifications/push/clients', (route) => {
    const body = route.request().postDataJSON();
    expect(body.expectedAccount).toBe('admin');
    expect(body.clientKind).toBe('mobile');
    writes.push(body);
    return json(route, {
      subscriptionId: 'c45c8a1f-5d5a-4b55-bb7c-336b7629e5f8',
      bindingVersion: writes.length,
      enabled: body.enabled,
      account: 'admin'
    });
  });
  await page.route('**/api/notifications/push/clients/resolve', (route) => {
    resolves++;
    return json(route, { binding: null });
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () => 'Mozilla/5.0 iPhone'
    });
    localStorage.setItem('mar.locale.v2', 'en-US');
    const state = {
      permission: 'default' as NotificationPermission,
      explicitPrompts: 0,
      gestures: [] as boolean[]
    };
    Object.assign(window, { __pushTest: state });
    Object.defineProperty(Notification, 'permission', {
      configurable: true,
      get: () => state.permission
    });
    Object.defineProperty(Notification, 'requestPermission', {
      configurable: true,
      value: async () => {
        state.explicitPrompts++;
        state.permission = 'granted';
        return 'granted';
      }
    });
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/browser-fixture',
      toJSON: () => ({
        endpoint: subscription.endpoint,
        expirationTime: null,
        keys: { p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22) }
      }),
      unsubscribe: async () => {
        localStorage.removeItem('fixture.push');
        return true;
      }
    };
    PushManager.prototype.getSubscription = async () =>
      localStorage.getItem('fixture.push') === 'true'
        ? (subscription as unknown as PushSubscription)
        : null;
    PushManager.prototype.subscribe = async () => {
      state.gestures.push(navigator.userActivation.isActive);
      state.permission = 'granted';
      localStorage.setItem('fixture.push', 'true');
      return subscription as unknown as PushSubscription;
    };
    ServiceWorkerRegistration.prototype.showNotification = async () => undefined;
  });
  await page.goto('/console');
  await expect
    .poll(() =>
      page.evaluate(
        async () => !!(await navigator.serviceWorker.getRegistration('/console'))?.active
      )
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Open console', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'System notifications', exact: true }).click();
  const panel = page.locator('.system-notification-control');
  await expect(panel.getByRole('status').last()).toHaveText(
    'Offline Push is disabled for this browser.'
  );
  await page.getByRole('button', { name: 'Enable / retry offline Push', exact: true }).click();
  await expect(panel.getByRole('status').last()).toHaveText(
    'Offline Push is ready for this browser. Delivery is best effort.'
  );
  expect(writes).toHaveLength(1);
  expect(writes[0]?.clientToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(
    await page.evaluate(() => (window as unknown as { __pushTest: unknown }).__pushTest)
  ).toMatchObject({
    explicitPrompts: 0,
    gestures: [true]
  });
  const display = () =>
    page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve) => {
        const open = indexedDB.open('mar.web-push.v1', 1);
        open.onsuccess = () => resolve(open.result);
      });
      try {
        return await new Promise<unknown>((resolve) => {
          const read = database.transaction('bindings').objectStore('bindings').get('display');
          read.onsuccess = () => resolve(read.result);
        });
      } finally {
        database.close();
      }
    });
  expect(await display()).toMatchObject({ account: 'admin', enabled: true, bindingVersion: 1 });
  await page.getByRole('button', { name: 'Disable offline Push', exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({
    clientToken: writes[0]!.clientToken,
    enabled: false,
    bindingVersion: 1
  });
  expect(await display()).toBeUndefined();
  expect(resolves).toBe(0);
  // A stale enabled preference from another tab must not reopen the durable closed binding.
  await page.evaluate(() => {
    const key = 'mar.workbench.system-notifications.v1.admin';
    localStorage.setItem(key, 'true');
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: 'true' }));
  });
  await expect(panel.getByRole('status').last()).toHaveText(
    'Enable offline Push for this browser. On iOS, open the app from the Home Screen.'
  );
  expect(writes).toHaveLength(2);
  expect(await display()).toBeUndefined();
  await panel.getByRole('button', { name: 'Enable / retry offline Push', exact: true }).click();
  await expect(panel.getByRole('status').last()).toHaveText(
    'Offline Push is ready for this browser. Delivery is best effort.'
  );
  expect(writes).toHaveLength(3);
  expect(writes[2]).toMatchObject({
    clientToken: writes[0]!.clientToken,
    bindingVersion: 2,
    enabled: true
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
});
