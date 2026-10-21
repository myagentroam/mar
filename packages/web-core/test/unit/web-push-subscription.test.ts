import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createWebPushSubscriptionService } from '../../src/service/WebPushSubscriptionService.js';
import { ApiError } from '../../src/util/api-error.js';
import type {
  BrowserPushClient,
  PushDisplayBinding,
  WebPushClientStore
} from '../../src/service/WebPushClientStore.js';

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const account = ref<string | undefined>('alice');
  let client: BrowserPushClient | undefined;
  let display: PushDisplayBinding | undefined;
  let serial: Promise<unknown> = Promise.resolve();
  const store: WebPushClientStore = {
    read: vi.fn(async () => structuredClone(client)),
    write: vi.fn(async (value) => {
      client = structuredClone(value);
    }),
    display: vi.fn(async (value) => {
      display = structuredClone(value);
    }),
    locked<T>(action: () => Promise<T>): Promise<T> {
      const next = serial.then(action);
      serial = next.catch(() => undefined);
      return next;
    }
  };
  const material = {
    endpoint: 'https://fcm.googleapis.com/push/client',
    expirationTime: null,
    keys: { p256dh: 'A'.repeat(87), auth: 'A'.repeat(22) }
  };
  const subscription = {
    endpoint: material.endpoint,
    toJSON: () => material,
    unsubscribe: vi.fn(async () => true)
  } as unknown as PushSubscription;
  let actual: PushSubscription | null = null;
  const subscribe = vi.fn(() => {
    actual = subscription;
    return Promise.resolve(subscription);
  });
  const registration = {
    active: {},
    pushManager: {
      getSubscription: async () => actual,
      subscribe
    }
  };
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('indexedDB', {});
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', {
    locks: {},
    serviceWorker: { getRegistration: async () => registration }
  });
  let server: PushDisplayBinding | undefined;
  let serverToken: string | undefined;
  let loseResponse = false;
  const capability = {
    enabled: true,
    available: true,
    publicKey: 'A'.repeat(87),
    account: 'alice'
  };
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/notifications/push') return { ...capability, account: account.value };
    const input = JSON.parse(String(init?.body));
    if (input.expectedAccount !== account.value)
      throw new ApiError('WEB_PUSH_SESSION_INVALID', 'The account changed.');
    if (path.endsWith('/resolve'))
      return {
        binding:
          server === undefined
            ? null
            : {
                subscriptionId: server.subscriptionId,
                bindingVersion: server.bindingVersion,
                enabled: server.enabled
              }
      };
    // An initial registration's stable token is its idempotency key.
    if (serverToken !== input.clientToken) {
      serverToken = input.clientToken;
      server = {
        account: account.value!,
        subscriptionId: 'record-1',
        bindingVersion: 1,
        enabled: input.enabled
      };
    } else if (server !== undefined && input.bindingVersion === server.bindingVersion) {
      server = {
        ...server,
        account: account.value!,
        bindingVersion: server.bindingVersion + 1,
        enabled: input.enabled
      };
    }
    if (loseResponse) {
      loseResponse = false;
      throw new Error('Response lost');
    }
    return { ...server };
  });
  const service = createWebPushSubscriptionService(account, request as never, store);
  return {
    account,
    store,
    service,
    request,
    subscribe,
    capability,
    subscription,
    client: () => client,
    display: () => display,
    server: () => server,
    existing: () => {
      actual = subscription;
    },
    loseResponse: () => {
      loseResponse = true;
    },
    other: () => createWebPushSubscriptionService(account, request as never, store)
  };
}

describe('browser Push subscription lifecycle', () => {
  it.each([
    { enabled: false, available: true, publicKey: null, expected: 'systemDisabled' },
    { enabled: false, available: false, publicKey: null, expected: 'serverUnavailable' },
    { enabled: true, available: true, publicKey: null, expected: 'serverUnavailable' }
  ])('distinguishes Server capability from the administrative switch: $expected', async (value) => {
    const f = fixture();
    const { expected, ...capability } = value;
    Object.assign(f.capability, capability);
    await f.service.refresh(true);
    expect(f.service.status.value).toBe(expected);
    expect(f.subscribe).not.toHaveBeenCalled();
    expect(f.request.mock.calls.every(([path]) => path === '/api/notifications/push')).toBe(true);
  });

  it('reprepares a late Worker without subscribing outside a fresh user gesture', async () => {
    const f = fixture();
    const worker = await navigator.serviceWorker.getRegistration('/console');
    navigator.serviceWorker.getRegistration = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(worker);
    await f.service.refresh(true);
    expect(f.service.status.value).toBe('unavailable');
    await f.service.enable();
    expect(f.service.status.value).toBe('actionRequired');
    expect(f.subscribe).not.toHaveBeenCalled();
    const pending = f.service.enable();
    expect(f.subscribe).toHaveBeenCalledOnce();
    await pending;
    expect(f.service.status.value).toBe('ready');
  });

  it('prepares without subscribing or prompting, then subscribes synchronously on a gesture', async () => {
    const f = fixture();
    await f.service.refresh(true);
    expect(f.service.status.value).toBe('actionRequired');
    expect(f.subscribe).not.toHaveBeenCalled();
    const enabling = f.service.enable();
    expect(f.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    await enabling;
    expect(f.service.status.value).toBe('ready');
    expect(f.display()).toMatchObject({ account: 'alice', enabled: true });
    const writeOrder = vi.mocked(f.store.write).mock.invocationCallOrder[0]!;
    const firstRegistration = f.request.mock.calls.findIndex(([path]) => path.endsWith('/clients'));
    expect(writeOrder).toBeLessThan(f.request.mock.invocationCallOrder[firstRegistration]!);
  });

  it('does not register if durable credential persistence fails', async () => {
    const f = fixture();
    await f.service.refresh(true);
    vi.mocked(f.store.write).mockRejectedValueOnce(new Error('Storage full'));
    await f.service.enable();
    expect(f.service.status.value).toBe('unavailable');
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/clients'))).toHaveLength(0);
    expect(f.display()).toBeUndefined();
  });

  it('recovers the same initial request after a lost response and page restart', async () => {
    const f = fixture();
    await f.service.refresh(true);
    f.loseResponse();
    await f.service.enable();
    const token = f.client()!.request.clientToken;
    expect(f.client()!.binding).toBeUndefined();
    await f.other().refresh(true);
    expect(f.client()!.request.clientToken).toBe(token);
    expect(f.client()!.binding?.bindingVersion).toBe(1);
    expect(f.display()?.enabled).toBe(true);
  });

  it('rotates subscription material on the same record without a disable or extra client', async () => {
    const f = fixture();
    await f.service.refresh(false);
    await f.service.enable();
    const previous = f.client()!;
    await f.store.write({
      ...previous,
      request: {
        ...previous.request,
        subscription: {
          ...previous.request.subscription,
          endpoint: 'https://fcm.googleapis.com/fcm/send/previous'
        }
      }
    });
    const before = f.request.mock.calls.length;
    await f.service.enable();
    expect(f.request.mock.calls.length - before).toBe(1);
    const input = JSON.parse(f.request.mock.calls.at(-1)![1]!.body as string);
    expect(input.clientToken).toBe(previous.request.clientToken);
    expect(input.bindingVersion).toBe(previous.binding!.bindingVersion);
    expect(f.client()?.binding?.subscriptionId).toBe(previous.binding!.subscriptionId);
  });

  it('serializes two tabs using the same actual subscription and durable token', async () => {
    const f = fixture();
    const other = f.other();
    await Promise.all([f.service.refresh(true), other.refresh(true)]);
    await Promise.all([f.service.enable(), other.enable()]);
    const sent = f.request.mock.calls
      .filter(([path]) => path.endsWith('/clients'))
      .map(([, init]) => JSON.parse(String(init?.body)).clientToken);
    expect(new Set(sent).size).toBe(1);
    expect(f.client()?.binding?.subscriptionId).toBe('record-1');
  });

  it('recovers a cleaned-up record only after a new explicit gesture and never auto-resets its version', async () => {
    const f = fixture();
    await f.service.refresh(false);
    await f.service.enable();
    const capability = await f.request('/api/notifications/push');
    f.request
      .mockResolvedValueOnce(capability)
      .mockRejectedValueOnce(new ApiError('WEB_PUSH_BINDING_STALE', 'Stale binding.'));
    await f.service.refresh(true);
    expect(f.service.status.value).toBe('unavailable');
    expect(f.request.mock.calls.some(([path]) => path.endsWith('/resolve'))).toBe(false);
    f.request
      .mockRejectedValueOnce(new ApiError('WEB_PUSH_BINDING_STALE', 'Stale binding.'))
      .mockResolvedValueOnce({ binding: null });
    await f.service.enable();
    const input = JSON.parse(f.request.mock.calls.at(-1)![1]!.body as string);
    expect(input.bindingVersion).toBeUndefined();
    expect(f.service.status.value).toBe('ready');
    expect(f.display()?.enabled).toBe(true);
  });

  it('learns a newer disabled binding without reviving it from an in-flight older intent', async () => {
    const f = fixture();
    await f.service.refresh(false);
    await f.service.enable();
    f.request
      .mockRejectedValueOnce(new ApiError('WEB_PUSH_BINDING_STALE', 'Stale binding.'))
      .mockResolvedValueOnce({
        binding: { subscriptionId: 'client-1', bindingVersion: 2, enabled: false }
      });
    await f.service.enable();
    expect(f.service.status.value).toBe('unavailable');
    expect(f.display()).toBeUndefined();
    expect(f.client()?.binding?.enabled).toBe(false);
    expect(f.request.mock.calls.at(-1)?.[0]).toContain('/resolve');
  });

  it('does not reopen a disabled client from a stale enabled preference during automatic refresh', async () => {
    const f = fixture();
    await f.service.refresh(true);
    await f.service.enable();
    await f.service.disable();
    const before = f.request.mock.calls.filter(([path]) => path.endsWith('/clients')).length;
    await f.service.refresh(true);
    expect(f.server()?.enabled).toBe(false);
    expect(f.display()).toBeUndefined();
    expect(f.service.status.value).toBe('actionRequired');
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/clients'))).toHaveLength(before);
    await f.service.enable();
    expect(f.service.status.value).toBe('ready');
    expect(f.server()?.enabled).toBe(true);
  });

  it('does not reopen a newer disabled binding learned while resolving a stale request', async () => {
    const f = fixture();
    await f.service.refresh(true);
    await f.service.enable();
    f.request
      .mockRejectedValueOnce(new ApiError('WEB_PUSH_BINDING_STALE', 'Stale binding.'))
      .mockResolvedValueOnce({
        binding: { subscriptionId: 'record-1', bindingVersion: 2, enabled: false }
      });
    await f.service.enable();
    const before = f.request.mock.calls.filter(([path]) => path.endsWith('/clients')).length;
    await f.service.refresh(true);
    expect(f.client()?.binding?.enabled).toBe(false);
    expect(f.display()).toBeUndefined();
    expect(f.service.status.value).toBe('actionRequired');
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/clients'))).toHaveLength(before);
  });

  it('invalidates display before disabling, and retries a failed disable while the system switch is off', async () => {
    const f = fixture();
    await f.service.refresh(true);
    await f.service.enable();
    f.loseResponse();
    await f.service.disable();
    expect(f.display()).toBeUndefined();
    expect(f.service.status.value).toBe('unavailable');
    f.capability.enabled = false;
    await f.service.refresh(false);
    expect(f.server()?.enabled).toBe(false);
    expect(f.display()).toBeUndefined();
  });

  it('drops the old version when an uncertain client has already expired on the Server', async () => {
    const f = fixture();
    await f.service.refresh(false);
    await f.service.enable();
    const client = f.client()!;
    await f.store.write({
      account: client.account,
      request: { ...client.request, bindingVersion: 99 }
    });
    f.request.mockImplementationOnce(async () => ({ binding: null }));
    await f.service.disable();
    const input = JSON.parse(f.request.mock.calls.at(-1)![1]!.body as string);
    expect(input.enabled).toBe(false);
    expect(input.bindingVersion).toBeUndefined();
    expect(f.display()).toBeUndefined();
  });

  it('does not silently transfer an account; an explicit enable uses the existing credential', async () => {
    const f = fixture();
    await f.service.refresh(true);
    await f.service.enable();
    const token = f.client()!.request.clientToken;
    await f.service.invalidate();
    f.account.value = 'bob';
    await f.service.refresh(true);
    expect(f.service.status.value).toBe('actionRequired');
    expect(f.display()).toBeUndefined();
    await f.service.enable();
    expect(f.client()!.request.clientToken).toBe(token);
    expect(f.display()?.account).toBe('bob');
  });

  it('retains the confirmed display binding on page close, but invalidates it on logout', async () => {
    const f = fixture();
    await f.service.refresh(true);
    await f.service.enable();
    f.service.dispose();
    expect(f.display()?.enabled).toBe(true);
    await f.service.invalidate();
    expect(f.display()).toBeUndefined();
  });

  it('does not adopt a subscription when its management credential was lost', async () => {
    const f = fixture();
    f.existing();
    await f.service.refresh(true);
    expect(f.subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(f.service.status.value).toBe('actionRequired');
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/clients'))).toHaveLength(0);
  });
});
