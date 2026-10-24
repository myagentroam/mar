import { ref, type Ref } from 'vue';
import { isMobileNotificationClient } from '../util/notification-capability.js';
import { ApiError } from '../util/api-error.js';
import type { WebPushBinding, WebPushSubscription } from '@myagentroam/protocol';
import {
  createWebPushClientStore,
  type BrowserPushClient,
  type WebPushClientStore
} from './web-push-client-store.js';

interface PushCapability {
  readonly enabled: boolean;
  readonly available: boolean;
  readonly publicKey: string | null;
  readonly account: string;
}
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

/** One actual subscription per browser storage environment, not per tab or account. */
export function createWebPushSubscriptionService(
  account: Ref<string | undefined>,
  request: Request | undefined,
  store: WebPushClientStore = createWebPushClientStore()
) {
  const status = ref<
    | 'loading'
    | 'unsupported'
    | 'systemDisabled'
    | 'serverUnavailable'
    | 'actionRequired'
    | 'ready'
    | 'disabled'
    | 'unavailable'
  >('loading');
  let capability: PushCapability | undefined;
  let registration: ServiceWorkerRegistration | undefined;
  let subscription: PushSubscription | null = null;
  let generation = 0;
  const prepared = ref(false);

  function supported(): boolean {
    return (
      request !== undefined &&
      globalThis.isSecureContext === true &&
      typeof PushManager !== 'undefined' &&
      typeof indexedDB !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      navigator.locks !== undefined &&
      'serviceWorker' in navigator
    );
  }
  const current = (epoch: number, owner: string) => epoch === generation && account.value === owner;
  function keyBytes(key: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(atob(key.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
      char.charCodeAt(0)
    );
  }
  function material(value: PushSubscription): WebPushSubscription {
    const json = value.toJSON();
    if (
      json.endpoint === undefined ||
      json.keys?.['p256dh'] === undefined ||
      json.keys['auth'] === undefined
    )
      throw new Error('WEB_PUSH_SUBSCRIPTION_INVALID');
    return {
      endpoint: json.endpoint,
      expirationTime: json.expirationTime ?? null,
      keys: { p256dh: json.keys['p256dh'], auth: json.keys['auth'] }
    };
  }
  async function retire(previous: BrowserPushClient, owner: string): Promise<void> {
    let binding = previous.binding;
    if (binding === undefined) {
      const resolved = await request!<{ binding: WebPushBinding | null }>(
        '/api/notifications/push/clients/resolve',
        {
          method: 'POST',
          body: JSON.stringify({
            clientToken: previous.request.clientToken,
            expectedAccount: owner
          })
        }
      );
      binding = resolved.binding ?? undefined;
    }
    const { bindingVersion: _old, ...base } = previous.request;
    const client: BrowserPushClient = {
      account: previous.account,
      request: {
        ...base,
        enabled: false,
        ...(binding === undefined ? {} : { bindingVersion: binding.bindingVersion })
      }
    };
    await store.write(client);
    const disabled = await request!<WebPushBinding>('/api/notifications/push/clients', {
      method: 'POST',
      body: JSON.stringify({ ...client.request, expectedAccount: owner })
    });
    await store.write({ ...client, binding: disabled });
  }

  async function sync(
    owner: string,
    value: PushSubscription,
    enabled: boolean,
    epoch: number,
    explicit: boolean
  ): Promise<void> {
    await store.locked(async () => {
      if (!current(epoch, owner)) return;
      const previous = await store.read();
      if (!current(epoch, owner)) return;
      if (
        !explicit &&
        (previous?.request.enabled === false || previous?.binding?.enabled === false)
      ) {
        // A stale page preference cannot override a durable disable or a newer closed binding.
        await store.display(undefined);
        if (current(epoch, owner)) status.value = 'actionRequired';
        return;
      }
      const actual = material(value);
      if (previous !== undefined && previous.request.subscription.endpoint !== actual.endpoint) {
        if (!explicit) throw new Error('WEB_PUSH_SUBSCRIPTION_CHANGED');
      }
      if (previous !== undefined && previous.account !== owner && !explicit)
        throw new Error('WEB_PUSH_ACCOUNT_CHANGED');
      const token =
        previous?.request.clientToken ??
        btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replaceAll('=', '');
      let client: BrowserPushClient = {
        account: owner,
        request: {
          clientKind: 'mobile',
          clientToken: token,
          subscription: actual,
          enabled,
          ...(previous?.binding === undefined
            ? previous?.request.bindingVersion === undefined
              ? {}
              : { bindingVersion: previous.request.bindingVersion }
            : { bindingVersion: previous.binding.bindingVersion })
        }
      };
      // Persist the exact retry input before the first request, including versioned updates.
      await store.display(undefined);
      await store.write(client);
      if (!current(epoch, owner)) return;
      const submit = () =>
        request!<WebPushBinding & { account: string }>('/api/notifications/push/clients', {
          method: 'POST',
          body: JSON.stringify({ ...client.request, expectedAccount: owner })
        });
      let binding: WebPushBinding & { account: string };
      try {
        binding = await submit();
      } catch (error) {
        if (
          !explicit ||
          !current(epoch, owner) ||
          !(error instanceof ApiError) ||
          error.code !== 'WEB_PUSH_BINDING_STALE'
        )
          throw error;
        const resolved = await request!<{ binding: WebPushBinding | null }>(
          '/api/notifications/push/clients/resolve',
          {
            method: 'POST',
            body: JSON.stringify({
              clientToken: client.request.clientToken,
              expectedAccount: owner
            })
          }
        );
        if (!current(epoch, owner)) return;
        if (resolved.binding !== null) {
          // Learn a newer closed binding, but require a new explicit intent to reopen it.
          await store.write({ ...client, binding: resolved.binding });
          throw error;
        }
        // Session cleanup may have removed this record. Never reset a version automatically.
        const { bindingVersion: _old, ...input } = client.request;
        client = { account: owner, request: input };
        await store.write(client);
        if (!current(epoch, owner)) return;
        binding = await submit();
      }
      if (binding.account !== owner) throw new Error('WEB_PUSH_ACCOUNT_CHANGED');
      await store.write({ ...client, binding });
      if (binding.enabled && enabled && current(epoch, owner))
        await store.display({ ...binding, account: owner });
      if (!current(epoch, owner)) await store.display(undefined);
      if (current(epoch, owner)) status.value = binding.enabled && enabled ? 'ready' : 'disabled';
    });
  }

  async function refresh(enabled: boolean): Promise<void> {
    const owner = account.value;
    prepared.value = false;
    if (!supported() || owner === undefined) {
      status.value = 'unsupported';
      return;
    }
    // A personal disable must converge even while Server delivery is unavailable or switched off.
    const disabling = !enabled && isMobileNotificationClient() ? disable() : undefined;
    const epoch = generation;
    try {
      await disabling;
      if (!current(epoch, owner) || (disabling !== undefined && status.value === 'unavailable'))
        return;
      const worker = await navigator.serviceWorker.getRegistration('/console');
      if (!current(epoch, owner)) return;
      await store.locked(async () => {
        if (!current(epoch, owner)) return;
        const saved = await store.read();
        if (!current(epoch, owner)) return;
        if (saved !== undefined && saved.request.clientKind === 'mobile') return;
        await store.display(undefined);
        const old = await worker?.pushManager?.getSubscription();
        if (!current(epoch, owner)) return;
        if (old != null && !(await old.unsubscribe())) throw new Error('WEB_PUSH_RETIRE_FAILED');
        if (current(epoch, owner)) await store.write(undefined);
      });
      if (!current(epoch, owner)) return;
      if (!isMobileNotificationClient()) {
        status.value = 'unsupported';
        return;
      }
      const next = await request!<PushCapability>('/api/notifications/push');
      if (!current(epoch, owner)) return;
      capability = next;
      registration = worker;
      if (next.account !== owner) throw new Error('WEB_PUSH_ACCOUNT_CHANGED');
      if (!next.available || (next.enabled && next.publicKey === null)) {
        status.value = 'serverUnavailable';
        return;
      }
      if (!next.enabled) {
        status.value = 'systemDisabled';
        return;
      }
      if (worker?.active == null || worker.pushManager === undefined) {
        status.value = 'unavailable';
        return;
      }
      subscription = await worker.pushManager.getSubscription();
      if (!current(epoch, owner)) return;
      const saved = await store.read();
      if (!current(epoch, owner)) return;
      if (saved?.account !== owner) await store.display(undefined);
      if (subscription !== null && saved === undefined) {
        // Lost management credentials must not adopt an existing account's endpoint.
        if (!(await subscription.unsubscribe())) throw new Error('WEB_PUSH_RETIRE_FAILED');
        subscription = null;
      }
      prepared.value = true;
      if (!enabled) {
        status.value = 'disabled';
        return;
      }
      if (
        subscription === null ||
        saved === undefined ||
        saved.account !== owner ||
        saved.request.subscription.endpoint !== subscription.endpoint
      ) {
        status.value = 'actionRequired';
        return;
      }
      await sync(owner, subscription, true, epoch, false);
    } catch {
      if (current(epoch, owner)) status.value = 'unavailable';
    }
  }

  // Must be called directly from the click handler: do not await HTTP/IDB before subscribe().
  function canSubscribe(): boolean {
    return (
      isMobileNotificationClient() &&
      prepared.value &&
      registration !== undefined &&
      capability?.enabled === true &&
      capability.available
    );
  }

  function enable(): Promise<void> {
    const owner = account.value;
    const epoch = generation;
    if (
      !supported() ||
      !isMobileNotificationClient() ||
      !prepared.value ||
      owner === undefined ||
      registration?.active == null ||
      capability?.account !== owner ||
      !capability.enabled ||
      !capability.available ||
      capability.publicKey === null
    ) {
      if (supported() && isMobileNotificationClient() && owner !== undefined) return refresh(true);
      else status.value = 'unsupported';
      return Promise.resolve();
    }
    const pending =
      subscription === null
        ? registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: keyBytes(capability.publicKey)
          })
        : Promise.resolve(subscription);
    return pending
      .then(async (value) => {
        if (!current(epoch, owner)) return;
        subscription = value;
        await sync(owner, value, true, epoch, true);
      })
      .catch(() => {
        if (current(epoch, owner)) status.value = 'unavailable';
      });
  }

  async function disable(): Promise<void> {
    const owner = account.value;
    const epoch = ++generation;
    status.value = 'disabled';
    // Queue invalidation before waiting for any in-flight registration/lock.
    try {
      if (typeof indexedDB !== 'undefined') await store.display(undefined);
      if (!supported() || owner === undefined) return;
      await store.locked(async () => {
        if (!current(epoch, owner)) return;
        const saved = await store.read();
        if (saved === undefined || saved.account !== owner) return;
        if (saved.request.clientKind !== 'mobile') return;
        // Another tab may have restored display while this disable waited for the lock.
        await store.display(undefined);
        await retire(saved, owner);
      });
    } catch {
      if (owner !== undefined && current(epoch, owner)) status.value = 'unavailable';
    }
  }

  function dispose(): void {
    generation++;
    prepared.value = false;
    capability = undefined;
    registration = undefined;
    subscription = null;
    // Page close does not unbind. Explicit logout/account change invokes invalidate().
  }
  async function invalidate(): Promise<void> {
    dispose();
    if (typeof indexedDB !== 'undefined') await store.display(undefined).catch(() => undefined);
  }
  return { status, canSubscribe, refresh, enable, disable, dispose, invalidate };
}
