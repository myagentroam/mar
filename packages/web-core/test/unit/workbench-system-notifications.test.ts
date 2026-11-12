import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { runInNewContext } from 'node:vm';
import { MessageChannel } from 'node:worker_threads';
import { directDownloadServiceWorkerPlugin } from '../../scripts/direct-download-service-worker.js';
import { createWorkbenchNotificationService } from '../../src/service/workbench-notification-service.js';

import type { ServerNotification as WorkbenchNotification } from '@myagentroam/protocol';

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.unstubAllGlobals();
});

function notification(id = 'new-run'): WorkbenchNotification {
  return {
    id,
    kind: 'run',
    title: 'Authoritative title',
    message: 'Run completed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    read: false,
    target: {
      targetType: 'WORKSPACE_SESSION',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1'
    }
  };
}

async function fixture(
  options: {
    permission?: NotificationPermission;
    secure?: boolean;
    enabled?: boolean;
    userAgent?: string;
    platform?: string;
    maxTouchPoints?: number;
  } = {}
) {
  const account = ref<string | undefined>('admin');
  const browser = {
    permission: options.permission ?? 'granted',
    focused: true,
    visibility: 'visible'
  };
  const storage = new Map<string, string>();
  if (options.enabled) storage.set('mar.workbench.system-notifications.v1.admin', 'true');
  const requestPermission = vi.fn(async () => browser.permission);
  vi.stubGlobal('Notification', {
    get permission() {
      return browser.permission;
    },
    requestPermission
  });
  vi.stubGlobal('isSecureContext', options.secure ?? true);
  vi.stubGlobal('document', {
    get visibilityState() {
      return browser.visibility;
    },
    hasFocus: () => browser.focused
  });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value)
  });
  const windowEvents = new EventTarget();
  const location = {
    href: 'https://example.test/console',
    origin: 'https://example.test',
    pathname: '/console'
  };
  vi.stubGlobal('window', {
    location,
    history: {
      replaceState: vi.fn((_state, _unused, url: string) => {
        location.href = new URL(url, location.href).href;
      })
    },
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents)
  });
  const workerEvents = new EventTarget();
  const displayed: {
    tag: string;
    data: { type: string; account: string; projectionId?: string };
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  const registration = {
    active: { postMessage: (_value: unknown, _ports: unknown[]) => {} },
    showNotification: vi.fn(
      async (_title: string, _options: NotificationOptions): Promise<void> => undefined
    ),
    getNotifications: vi.fn(async (filter?: { tag: string }) =>
      displayed.filter((entry) => filter === undefined || entry.tag === filter.tag)
    )
  };
  const getRegistration = vi.fn(async () => registration);
  let workerSource = '';
  (directDownloadServiceWorkerPlugin().generateBundle as (...args: unknown[]) => void).call({
    emitFile: (asset: { source: string }) => {
      workerSource = asset.source;
    }
  });
  const listeners = new Map<string, (event: unknown) => void>();
  const client = {
    id: 'page-1',
    url: location.href,
    postMessage: (data: unknown, ports: unknown[]) => {
      const event = new Event('message');
      Object.assign(event, { data, ports });
      workerEvents.dispatchEvent(event);
    }
  };
  const windows = [client];
  const reloadWorker = () =>
    runInNewContext(workerSource, {
      self: {
        addEventListener: (name: string, callback: (event: unknown) => void) =>
          listeners.set(name, callback),
        location: { origin: location.origin },
        registration,
        clients: { get: async () => client, matchAll: async () => windows }
      },
      URL,
      MessageChannel,
      setTimeout,
      clearTimeout
    });
  reloadWorker();
  registration.active.postMessage = (data, ports) =>
    listeners.get('message')!({
      data,
      ports,
      source: client,
      waitUntil: (pending: Promise<void>) => {
        void pending;
      }
    });
  vi.stubGlobal('navigator', {
    userAgent: options.userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    platform: options.platform ?? 'Win32',
    maxTouchPoints: options.maxTouchPoints ?? 0,
    serviceWorker: {
      getRegistration,
      addEventListener: workerEvents.addEventListener.bind(workerEvents),
      removeEventListener: workerEvents.removeEventListener.bind(workerEvents)
    }
  });
  const server = { entries: [] as WorkbenchNotification[] };
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/notifications') return { notifications: server.entries };
    if (init?.method === 'POST' && path.endsWith('/read')) {
      server.entries = server.entries.map((entry) =>
        path === `/api/notifications/${entry.id}/read` ? { ...entry, read: true } : entry
      );
      return {};
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const openNotification = vi.fn(async (_value: unknown) => {
    // Selection callbacks must not turn a system click into a target-wide read.
    state.markSessionRead('node-1', 'workspace-1', 'session-1');
    state.markConversationRead('node-1', 'conversation-1');
  });
  const state = createWorkbenchNotificationService(account, {
    request: request as never,
    activeTargets: () => [
      {
        targetType: 'WORKSPACE_SESSION',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1'
      }
    ],
    onNotificationClick: openNotification
  });
  disposers.push(state.dispose);
  await state.start();
  return {
    account,
    browser,
    storage,
    requestPermission,
    windowEvents,
    location,
    workerEvents,
    reloadWorker,
    windows,
    displayed,
    registration,
    getRegistration,
    server,
    request,
    openNotification,
    state,
    system: state.systemNotifications
  };
}

describe('Workbench system notifications', () => {
  it('deduplicates simultaneous PC system requests in the existing Worker', async () => {
    const f = await fixture({ enabled: true });
    f.browser.focused = false;
    await Promise.all([f.system.show(notification()), f.system.show(notification())]);
    expect(f.registration.showNotification).toHaveBeenCalledOnce();
    await f.system.show(notification());
    expect(f.registration.showNotification).toHaveBeenCalledOnce();
  });

  it('suppresses a background PC system request when another same-account workbench is foreground', async () => {
    const f = await fixture({ enabled: true });
    f.browser.focused = false;
    f.windows.push({
      id: 'page-2',
      url: f.location.href,
      postMessage: (_data, ports) => {
        const port = ports[0] as { postMessage(value: unknown): void; close(): void };
        port.postMessage({ valid: true, foreground: true });
        port.close();
      }
    });
    await f.system.show(notification());
    expect(f.registration.showNotification).not.toHaveBeenCalled();
    expect(f.state.notificationRevision.value).toBe(0);
  });

  it('requests permission only on explicit opt-in and shares the account preference across pages', async () => {
    const f = await fixture();
    expect(f.system.status.value).toBe('disabled');
    expect(f.requestPermission).not.toHaveBeenCalled();
    await f.system.setEnabled(true);
    expect(f.system.status.value).toBe('enabled');
    expect(f.requestPermission).toHaveBeenCalledOnce();
    expect(f.storage.get('mar.workbench.system-notifications.v1.admin')).toBe('true');
    const event = new Event('storage');
    Object.assign(event, { key: 'mar.workbench.system-notifications.v1.admin', newValue: 'false' });
    f.windowEvents.dispatchEvent(event);
    expect(f.system.enabled.value).toBe(false);
  });

  it.each([
    ['denied', true, 'denied'],
    ['default', true, 'disabled']
  ] as const)(
    'does not enable notifications with permission %s and secure origin %s',
    async (permission, secure, status) => {
      const f = await fixture({ permission, secure });
      await f.system.setEnabled(true);
      expect(f.system.status.value).toBe(status);
      expect(f.system.enabled.value).toBe(false);
      expect(f.registration.showNotification).not.toHaveBeenCalled();
    }
  );

  it('uses available notification APIs without imposing a secure-context policy', async () => {
    const f = await fixture({ permission: 'granted', secure: false });
    await f.system.setEnabled(true);
    expect(f.system.status.value).toBe('enabled');
    expect(f.system.enabled.value).toBe(true);
  });

  it('handles missing browser APIs, registration failures and rejected permission requests without affecting the center', async () => {
    const f = await fixture();
    f.getRegistration.mockRejectedValueOnce(new Error('No Service Worker'));
    await f.system.setEnabled(true);
    expect(f.system.status.value).toBe('unavailable');
    f.requestPermission.mockRejectedValueOnce(new Error('Permission unavailable'));
    await f.system.setEnabled(true);
    expect(f.system.status.value).toBe('unavailable');
    vi.stubGlobal('Notification', undefined);
    const state = createWorkbenchNotificationService(ref('other'));
    disposers.push(state.dispose);
    expect(state.systemNotifications.status.value).toBe('unsupported');
    state.notify({ id: 'local', kind: 'web-update', title: 'Update', message: 'Reload' });
    expect(state.unreadCount.value).toBe(1);
  });

  it.each([
    ['visible but unfocused', 'visible', false, true],
    ['hidden', 'hidden', false, true],
    ['foreground', 'visible', true, false]
  ] as const)(
    'projects a confirmed notification with the page %s',
    async (_label, visibility, focused, shouldShow) => {
      const f = await fixture({ enabled: true });
      f.browser.visibility = visibility;
      f.browser.focused = focused;
      const canonical = notification();
      f.server.entries = [canonical];
      f.state.projectServerMessage({
        type: 'notification.created',
        notification: { ...canonical, title: 'Stale event title' }
      });
      await vi.waitFor(() => expect(f.state.notifications.value[0]).toBeDefined());
      if (shouldShow) {
        await vi.waitFor(() => expect(f.registration.showNotification).toHaveBeenCalledOnce());
        expect(f.registration.showNotification).toHaveBeenCalledWith(
          canonical.title,
          expect.objectContaining({
            body: canonical.message,
            tag: 'mar.workbench:admin:new-run',
            data: expect.objectContaining({ account: 'admin', id: 'new-run' })
          })
        );
        expect(f.state.unreadCount.value).toBe(1);
        expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
      } else {
        await vi.waitFor(() => expect(f.state.unreadCount.value).toBe(0));
        expect(f.registration.showNotification).not.toHaveBeenCalled();
      }
      f.state.projectServerMessage({ type: 'notification.created', notification: canonical });
      await f.state.load();
      expect(f.registration.showNotification).toHaveBeenCalledTimes(shouldShow ? 1 : 0);
    }
  );

  it.each([
    [
      'Android Edge',
      'Mozilla/5.0 (Linux; Android 12) Chrome/146.0 EdgA/146.0',
      'Linux armv8l',
      5,
      false
    ],
    [
      'Android Chrome',
      'Mozilla/5.0 (Linux; Android 12) Chrome/146.0 Mobile Safari/537.36',
      'Linux armv8l',
      5,
      false
    ],
    ['iPhone Safari', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iPhone', 5, false],
    ['iPad mobile mode', 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', 'iPad', 5, false],
    ['iPad desktop mode', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 'MacIntel', 5, false],
    ['touchscreen desktop', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 10, true],
    ['Mac desktop', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 'MacIntel', 0, true]
  ] as const)(
    'applies online display policy without changing the notification preference: %s',
    async (_label, userAgent, platform, maxTouchPoints, shouldShow) => {
      const f = await fixture({ enabled: true, userAgent, platform, maxTouchPoints });
      f.browser.visibility = 'hidden';
      f.browser.focused = false;
      const canonical = notification();
      f.server.entries = [canonical];
      await f.state.load();
      await f.system.show(canonical);
      expect(f.registration.showNotification).toHaveBeenCalledTimes(shouldShow ? 1 : 0);
      expect(f.system.enabled.value).toBe(true);
      expect(f.system.status.value).toBe('enabled');
      expect(f.storage.get('mar.workbench.system-notifications.v1.admin')).toBe('true');
      expect(f.state.unreadCount.value).toBe(1);
    }
  );

  it('does not replay snapshots, local updates, unconfirmed events or expired notifications', async () => {
    const f = await fixture({ enabled: true });
    f.browser.focused = false;
    f.server.entries = [notification('restored')];
    await f.state.load();
    f.state.notify({ id: 'update', kind: 'web-update', title: 'Updated', message: 'Reload' });
    f.state.projectServerMessage({
      type: 'notification.created',
      notification: notification('missing')
    });
    await f.state.load();
    const expired = { ...notification('expired'), expiresAt: Date.now() - 1 };
    f.server.entries = [expired];
    f.state.projectServerMessage({ type: 'notification.created', notification: expired });
    await f.state.load();
    expect(f.registration.showNotification).not.toHaveBeenCalled();
  });

  it('keeps unread notifications when display fails or permission is revoked', async () => {
    const f = await fixture({ enabled: true });
    f.browser.focused = false;
    f.registration.showNotification.mockRejectedValueOnce(new Error('OS notification failed'));
    f.server.entries = [notification()];
    f.state.projectServerMessage({
      type: 'notification.created',
      notification: f.server.entries[0]
    });
    await vi.waitFor(() => expect(f.registration.showNotification).toHaveBeenCalledOnce());
    expect(f.state.unreadCount.value).toBe(1);
    f.browser.permission = 'denied';
    f.server.entries = [notification('revoked')];
    f.state.projectServerMessage({
      type: 'notification.created',
      notification: f.server.entries[0]
    });
    await f.state.load();
    expect(f.system.status.value).toBe('denied');
    expect(f.registration.showNotification).toHaveBeenCalledOnce();
  });

  it.each(['read', 'removed'] as const)(
    'does not display a notification that becomes %s while registration is pending',
    async (change) => {
      const f = await fixture({ enabled: true });
      f.browser.focused = false;
      let resolveRegistration!: (registration: typeof f.registration) => void;
      f.getRegistration.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRegistration = resolve;
          })
      );
      const entry = notification();
      f.server.entries = [entry];
      f.state.projectServerMessage({ type: 'notification.created', notification: entry });
      await vi.waitFor(() => expect(resolveRegistration).toBeDefined());
      f.server.entries = change === 'read' ? [{ ...entry, read: true }] : [];
      await f.state.load();
      resolveRegistration(f.registration);
      await vi.waitFor(() => expect(f.getRegistration).toHaveResolved());
      expect(f.registration.showNotification).not.toHaveBeenCalled();
    }
  );

  it('cancels a pending display across an off/on cycle', async () => {
    const f = await fixture({ enabled: true });
    f.browser.focused = false;
    let resolveRegistration!: (registration: typeof f.registration) => void;
    f.getRegistration.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRegistration = resolve;
        })
    );
    const displaying = f.system.show(notification());
    await f.system.setEnabled(false);
    await f.system.setEnabled(true);
    resolveRegistration(f.registration);
    await displaying;
    expect(f.registration.showNotification).not.toHaveBeenCalled();
  });

  it('cancels a pending permission request when another page explicitly opts out', async () => {
    const f = await fixture();
    let approve!: (value: NotificationPermission) => void;
    f.requestPermission.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          approve = resolve;
        })
    );
    const enabling = f.system.setEnabled(true);
    expect(f.system.requesting.value).toBe(true);
    const event = new Event('storage');
    Object.assign(event, { key: 'mar.workbench.system-notifications.v1.admin', newValue: 'false' });
    f.windowEvents.dispatchEvent(event);
    approve('granted');
    await enabling;
    expect(f.system.requesting.value).toBe(false);
    expect(f.system.enabled.value).toBe(false);
    // Only opt-out cleanup may query the registration; the cancelled opt-in must not.
    expect(f.getRegistration).toHaveBeenCalledOnce();
    expect(f.storage.get('mar.workbench.system-notifications.v1.admin')).not.toBe('true');
  });

  it('closes its own late projection when disabled while the display API is pending', async () => {
    const f = await fixture({ enabled: true });
    f.browser.focused = false;
    let completeDisplay!: () => void;
    f.registration.showNotification.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeDisplay = resolve;
        })
    );
    const displaying = f.system.show(notification());
    await vi.waitFor(() => expect(completeDisplay).toBeDefined());
    await f.system.setEnabled(false);
    const options = f.registration.showNotification.mock.calls[0]![1];
    const late = {
      tag: options.tag!,
      data: options.data as (typeof f.displayed)[number]['data'],
      close: vi.fn()
    };
    f.displayed.push(late);
    completeDisplay();
    await displaying;
    expect(late.close).toHaveBeenCalledOnce();
  });

  it('does not close a new projection when delayed off cleanup follows re-enabling', async () => {
    const f = await fixture({ enabled: true });
    let resolveNotifications!: (entries: typeof f.displayed) => void;
    f.registration.getNotifications.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNotifications = resolve;
        })
    );
    const disabling = f.system.setEnabled(false);
    await vi.waitFor(() => expect(resolveNotifications).toBeDefined());
    await f.system.setEnabled(true);
    const current = {
      tag: 'new',
      data: { type: 'mar.workbench.notification', account: 'admin' },
      close: vi.fn()
    };
    resolveNotifications([current]);
    await disabling;
    expect(current.close).not.toHaveBeenCalled();
  });

  it('does not close another display with the same tag when an old display completes after re-login', async () => {
    const f = await fixture({ enabled: true });
    f.browser.focused = false;
    let completeOldDisplay!: () => void;
    f.registration.showNotification.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeOldDisplay = resolve;
        })
    );
    const oldDisplay = f.system.show(notification());
    await vi.waitFor(() => expect(completeOldDisplay).toBeDefined());
    f.state.dispose();
    await f.state.start();
    // A restarted Worker may attempt the same ID; old cleanup must not close its projection.
    f.reloadWorker();
    await f.system.show(notification());
    const options = f.registration.showNotification.mock.calls[1]![1];
    const current = {
      tag: options.tag!,
      data: options.data as (typeof f.displayed)[number]['data'],
      close: vi.fn()
    };
    f.displayed.push(current);
    completeOldDisplay();
    await oldDisplay;
    expect(current.close).not.toHaveBeenCalled();
  });

  it('does not retry an automatic read after the foreground page loses focus', async () => {
    const f = await fixture({ enabled: true });
    const entry = notification();
    f.server.entries = [entry];
    f.request.mockImplementationOnce(async () => {
      f.browser.focused = false;
      throw new Error('Read failed after focus loss');
    });
    f.state.projectServerMessage({ type: 'notification.created', notification: entry });
    await vi.waitFor(() => expect(f.state.notifications.value[0]).toBeDefined());
    expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(f.state.unreadCount.value).toBe(1);
  });

  it('ignores a permission grant or delayed display after logout and account replacement', async () => {
    const f = await fixture();
    let approve!: (value: NotificationPermission) => void;
    f.requestPermission.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          approve = resolve;
        })
    );
    const enabling = f.system.setEnabled(true);
    f.state.dispose();
    f.account.value = 'other';
    approve('granted');
    await enabling;
    expect(f.system.enabled.value).toBe(false);
    expect(f.storage.has('mar.workbench.system-notifications.v1.admin')).toBe(false);
    expect(f.storage.has('mar.workbench.system-notifications.v1.other')).toBe(false);
    await f.state.start();
    await f.system.setEnabled(true);
    f.browser.focused = false;
    let release!: (value: typeof f.registration) => void;
    f.getRegistration.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const showing = f.system.show(notification());
    f.state.dispose();
    f.account.value = 'third';
    release(f.registration);
    await showing;
    expect(f.registration.showNotification).not.toHaveBeenCalled();
  });

  it('closes only the owning account notifications on disable and logout', async () => {
    const f = await fixture({ enabled: true });
    const own = {
      tag: 'own',
      data: { type: 'mar.workbench.notification', account: 'admin' },
      close: vi.fn()
    };
    const other = { ...own, tag: 'other', data: { ...own.data, account: 'other' }, close: vi.fn() };
    f.displayed.push(own, other);
    await f.system.setEnabled(false);
    expect(own.close).toHaveBeenCalledOnce();
    expect(other.close).not.toHaveBeenCalled();
    await f.system.setEnabled(true);
    f.account.value = undefined;
    f.state.dispose();
    await vi.waitFor(() => expect(own.close).toHaveBeenCalledTimes(2));
    expect(other.close).not.toHaveBeenCalled();
  });

  it('opens only an authoritative accessible notification for the same account and reads only that item', async () => {
    const f = await fixture({ enabled: true });
    f.server.entries = [notification('clicked'), notification('same-session')];
    const ack = { postMessage: vi.fn(), close: vi.fn() };
    const click = (account: string, id: string) => {
      const event = new Event('message');
      Object.assign(event, {
        data: { type: 'mar.workbench.notification.click', account, id },
        ports: [ack]
      });
      f.workerEvents.dispatchEvent(event);
    };
    click('other', 'clicked');
    expect(ack.postMessage).toHaveBeenLastCalledWith({ accepted: false });
    expect(f.openNotification).not.toHaveBeenCalled();
    click('admin', 'clicked');
    await f.state.recover();
    await vi.waitFor(() => expect(f.openNotification).toHaveBeenCalledOnce());
    expect(f.openNotification).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'clicked', title: 'Authoritative title' })
    );
    expect(
      f.request.mock.calls.filter(([, init]) => init?.method === 'POST').map(([path]) => path)
    ).toEqual(['/api/notifications/clicked/read']);
    expect(f.server.entries.find((entry) => entry.id === 'same-session')?.read).toBe(false);
    click('admin', 'deleted');
    await f.state.load();
    expect(f.openNotification).toHaveBeenCalledOnce();
  });

  it('consumes a reopened notification link only after authentication and rejects another account', async () => {
    const f = await fixture();
    f.server.entries = [notification('reopened')];
    f.location.href =
      'https://example.test/console?notification=reopened&notificationAccount=admin';
    await f.state.recover();
    expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
    expect(await f.state.openPendingSystemNotification()).toBe(true);
    expect(f.openNotification).toHaveBeenCalledWith(expect.objectContaining({ id: 'reopened' }));
    expect(f.location.href).toBe('https://example.test/console');
    f.location.href =
      'https://example.test/console?notification=reopened&notificationAccount=other';
    expect(await f.state.openPendingSystemNotification()).toBe(false);
    expect(f.openNotification).toHaveBeenCalledOnce();
  });

  it('does not block authenticated startup when a reopened notification cannot be refreshed', async () => {
    const f = await fixture();
    f.location.href =
      'https://example.test/console?notification=reopened&notificationAccount=admin';
    f.request.mockRejectedValueOnce(new Error('Server temporarily unavailable'));
    await expect(f.state.openPendingSystemNotification()).resolves.toBe(true);
    expect(f.openNotification).not.toHaveBeenCalled();
    expect(f.location.href).toBe('https://example.test/console');
  });
});

describe('Service Worker notification clicks', () => {
  async function workerFixture(clients: unknown[]) {
    let source = '';
    const plugin = directDownloadServiceWorkerPlugin();
    const generate = plugin.generateBundle as (...arguments_: unknown[]) => void;
    generate.call({
      emitFile: (asset: { source: string }) => {
        source = asset.source;
      }
    });
    const listeners = new Map<string, (event: unknown) => void>();
    const openWindow = vi.fn(async () => undefined);
    runInNewContext(source, {
      self: {
        addEventListener: (name: string, handler: (event: unknown) => void) =>
          listeners.set(name, handler),
        location: { origin: 'https://example.test' },
        clients: { matchAll: async () => clients, openWindow }
      },
      URL,
      MessageChannel,
      setTimeout,
      clearTimeout
    });
    return { listeners, openWindow };
  }

  it('focuses a client only after its current account accepts the click', async () => {
    const client = {
      url: 'https://example.test/console',
      focus: vi.fn(async () => undefined),
      postMessage: vi.fn((_data, ports: MessagePort[]) => {
        ports[0]!.postMessage({ accepted: true });
      })
    };
    const f = await workerFixture([client]);
    let completion!: Promise<void>;
    const close = vi.fn();
    f.listeners.get('notificationclick')!({
      notification: {
        data: {
          type: 'mar.workbench.notification',
          account: 'admin',
          id: 'clicked',
          clientUrl: client.url
        },
        close
      },
      waitUntil: (value: Promise<void>) => {
        completion = value;
      }
    });
    await completion;
    expect(close).toHaveBeenCalledOnce();
    expect(client.postMessage.mock.calls[0]?.[0]).toEqual({
      type: 'mar.workbench.notification.click',
      account: 'admin',
      id: 'clicked'
    });
    expect(Array.isArray(client.postMessage.mock.calls[0]?.[1])).toBe(true);
    expect(client.focus).toHaveBeenCalledOnce();
    expect(f.openWindow).not.toHaveBeenCalled();
  });

  it('opens a same-origin Console link when no matching signed-in window remains', async () => {
    const client = {
      url: 'https://example.test/console',
      focus: vi.fn(),
      postMessage: (_data: unknown, ports: MessagePort[]) =>
        ports[0]!.postMessage({ accepted: false })
    };
    const f = await workerFixture([client]);
    let completion!: Promise<void>;
    f.listeners.get('notificationclick')!({
      notification: {
        data: {
          type: 'mar.workbench.notification',
          account: 'a&b',
          id: 'id/1',
          url: 'https://untrusted.test'
        },
        close: vi.fn()
      },
      waitUntil: (value: Promise<void>) => {
        completion = value;
      }
    });
    await completion;
    expect(client.focus).not.toHaveBeenCalled();
    expect(f.openWindow).toHaveBeenCalledWith(
      'https://example.test/console?notification=id%2F1&notificationAccount=a%26b'
    );
  });
});
