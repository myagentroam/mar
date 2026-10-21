import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { directDownloadServiceWorkerPlugin } from '../../scripts/direct-download-service-worker.js';

async function fixture() {
  let source = '';
  (directDownloadServiceWorkerPlugin().generateBundle as (...args: unknown[]) => void).call({
    emitFile: (asset: { source: string }) => {
      source = asset.source;
    }
  });
  const binding = {
    enabled: true,
    account: 'alice',
    subscriptionId: 'record-1',
    bindingVersion: 2
  };
  const state: { binding: unknown; failure: boolean } = { binding, failure: false };
  const listeners = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => undefined);
  const close = vi.fn();
  const windows: Array<{
    id: string;
    url: string;
    account: string;
    foreground: boolean;
    valid: boolean;
    postMessage: (message: { account: string }, ports: MessagePort[]) => void;
  }> = [];
  function addWindow(id: string, account = 'alice', foreground = false) {
    const client = {
      id,
      account,
      foreground,
      valid: true,
      url: 'https://console.example.test/console',
      postMessage(message: { account: string }, ports: MessagePort[]) {
        ports[0]!.postMessage({
          valid: client.valid && message.account === client.account,
          foreground: client.foreground
        });
        ports[0]!.close();
      }
    };
    windows.push(client);
    return client;
  }
  runInNewContext(source, {
    self: {
      addEventListener: (name: string, listener: (event: unknown) => void) =>
        listeners.set(name, listener),
      location: { origin: 'https://console.example.test' },
      registration: { showNotification, getNotifications: async () => [] },
      clients: {
        matchAll: async () => windows,
        get: async (id: string) => windows.find((entry) => entry.id === id),
        openWindow
      }
    },
    indexedDB: {
      open: () => {
        if (state.failure) throw new Error('Private storage is unavailable');
        const read: Record<string, unknown> = {};
        const request: Record<string, unknown> = {
          result: {
            close,
            transaction: () => ({
              objectStore: () => ({
                get: () => {
                  queueMicrotask(() => {
                    read.result = state.binding;
                    (read.onsuccess as () => void)();
                  });
                  return read;
                }
              })
            })
          }
        };
        queueMicrotask(() => (request.onsuccess as () => void)());
        return request;
      }
    },
    URL,
    MessageChannel,
    setTimeout,
    clearTimeout
  });
  const message = {
    title: 'Private task title',
    body: 'Private task text',
    expiresAt: Date.now() + 60_000,
    locale: 'zh-CN',
    data: {
      type: 'mar.workbench.notification',
      account: 'alice',
      id: 'notice-1',
      subscriptionId: binding.subscriptionId,
      bindingVersion: binding.bindingVersion,
      clientUrl: 'https://evil.example/steal'
    }
  };
  async function push(payload: unknown = message) {
    let done!: Promise<void>;
    listeners.get('push')!({
      data: { json: () => payload },
      waitUntil: (value: Promise<void>) => {
        done = value;
      }
    });
    await done;
    return showNotification.mock.calls.at(-1) as unknown as [
      string,
      { body: string; tag: string; data: unknown }
    ];
  }
  async function click(data: unknown) {
    let done!: Promise<void>;
    listeners.get('notificationclick')!({
      notification: { data, close },
      waitUntil: (value: Promise<void>) => {
        done = value;
      }
    });
    await done;
  }
  async function desktop(client: ReturnType<typeof addWindow>, id = 'notice-1') {
    let done: Promise<void> | undefined;
    const port = { postMessage: vi.fn(), close: vi.fn() };
    listeners.get('message')!({
      source: client,
      ports: [port],
      data: {
        type: 'mar.workbench.notification.show',
        account: 'alice',
        id,
        projectionId: `projection:${client.id}`,
        title: message.title,
        body: message.body,
        expiresAt: message.expiresAt
      },
      waitUntil: (value: Promise<void>) => {
        done = value;
      }
    });
    await done;
    return port;
  }
  return {
    listeners,
    state,
    message,
    push,
    click,
    desktop,
    addWindow,
    showNotification,
    openWindow
  };
}

describe('shared Worker desktop notification projection', () => {
  it('deduplicates concurrent requests across background tabs and preserves the click target', async () => {
    const f = await fixture();
    await Promise.all([f.desktop(f.addWindow('one')), f.desktop(f.addWindow('two'))]);
    expect(f.showNotification).toHaveBeenCalledOnce();
    const [title, options] = f.showNotification.mock.calls[0] as unknown as [
      string,
      { tag: string; data: unknown }
    ];
    expect(title).toBe(f.message.title);
    expect(options.tag).toBe('mar.workbench:alice:notice-1');
    await f.click(options.data);
    expect(f.openWindow).toHaveBeenCalledWith(
      'https://console.example.test/console?notification=notice-1&notificationAccount=alice'
    );
  });

  it('suppresses background notifications only for a foreground Workbench of the same account', async () => {
    const f = await fixture();
    const background = f.addWindow('background');
    const foreground = f.addWindow('foreground', 'alice', true);
    await f.desktop(background);
    expect(f.showNotification).not.toHaveBeenCalled();
    foreground.account = 'bob';
    await f.desktop(background, 'other-notice');
    expect(f.showNotification).toHaveBeenCalledOnce();
  });

  it('does not show a notification after its source projection becomes invalid', async () => {
    const f = await fixture();
    const background = f.addWindow('background');
    background.valid = false;
    await f.desktop(background);
    expect(f.showNotification).not.toHaveBeenCalled();
  });

  it('does not show an expired request or an unanswered source projection', async () => {
    const f = await fixture();
    const background = f.addWindow('background');
    f.message.expiresAt = Date.now() - 1;
    await f.desktop(background);
    expect(f.showNotification).not.toHaveBeenCalled();
    f.message.expiresAt = Date.now() + 60_000;
    background.postMessage = () => {};
    const pending = f.desktop(background);
    await pending;
    expect(f.showNotification).not.toHaveBeenCalled();
  });
});

describe('shared Worker Web Push projection', () => {
  it('uses the existing notification tag and ignores cross-origin payload navigation', async () => {
    const f = await fixture();
    const [title, notification] = await f.push();
    expect(title).toBe(f.message.title);
    expect(notification.body).toBe(f.message.body);
    expect(notification.tag).toBe('mar.workbench:alice:notice-1');
    await f.click(notification.data);
    expect(f.openWindow).toHaveBeenCalledWith(
      'https://console.example.test/console?notification=notice-1&notificationAccount=alice'
    );
    expect(f.listeners.has('fetch')).toBe(true);
    expect(f.listeners.has('message')).toBe(true);
  });

  it.each([
    'missing',
    'disabled',
    'other-account',
    'old-version',
    'expired',
    'unreadable',
    'malformed'
  ] as const)(
    'shows only generic copy for %s metadata or payload and discards the old click target',
    async (mode) => {
      const f = await fixture();
      const binding = f.state.binding as Record<string, unknown>;
      if (mode === 'missing') f.state.binding = undefined;
      if (mode === 'disabled') binding.enabled = false;
      if (mode === 'other-account') binding.account = 'bob';
      if (mode === 'old-version') binding.bindingVersion = 3;
      if (mode === 'unreadable') f.state.failure = true;
      if (mode === 'expired') f.message.expiresAt = Date.now() - 1;
      const [title, notification] = await f.push(mode === 'malformed' ? {} : f.message);
      expect(title).not.toBe(f.message.title);
      expect(notification.body).not.toContain('Private');
      expect(notification.data).toEqual({ type: 'mar.workbench.notification.generic' });
      await f.click(notification.data);
      expect(f.openWindow).toHaveBeenCalledWith('https://console.example.test/console');
    }
  );

  it('rechecks account binding when a previously shown notification is clicked after logout', async () => {
    const f = await fixture();
    const [, notification] = await f.push();
    f.state.binding = undefined;
    await f.click(notification.data);
    expect(f.openWindow).toHaveBeenCalledWith('https://console.example.test/console');
  });
});
