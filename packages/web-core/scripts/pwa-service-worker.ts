import { PrecacheController } from 'workbox-precaching';
import 'mar-legacy-worker-handlers';

declare const __MAR_BUILD_ID__: string;
declare const __MAR_BUILD_VERSION__: string;
declare const __MAR_IMMUTABLE_URLS__: readonly string[];
declare const __MAR_PRECACHE_MANIFEST__: Array<{ url: string; revision: string | null }>;

const worker = self as unknown as ServiceWorkerGlobalScope;
const cacheName = 'mar-static-precache';
const metadataUrl = new URL('/__mar_pwa_metadata__/active', worker.location.origin).href;
const lockName = 'mar-static-precache';
const controller = new PrecacheController({ cacheName });
const manifest = __MAR_PRECACHE_MANIFEST__;
controller.addToCacheList(manifest);
const supported = typeof worker.navigator.locks?.request === 'function';
let degraded = false;

async function hasEntry(): Promise<boolean> {
  const key = controller.getCacheKeyForURL(new URL('/index.html', worker.location.origin).href);
  return supported && key !== undefined && Boolean(await (await caches.open(cacheName)).match(key));
}

async function markDegraded(): Promise<void> {
  if (degraded) return;
  degraded = true;
  try {
    for (const client of await worker.clients.matchAll({ type: 'window' })) {
      client.postMessage({ type: 'MAR_PWA_DEGRADED', buildId: __MAR_BUILD_ID__ });
    }
  } catch {
    // A closing client must not prevent the normal network fallback.
  }
}

interface ActiveDescriptor {
  readonly buildId: string;
  readonly current: readonly string[];
  readonly previous: readonly string[];
}

async function readDescriptor(cache: Cache): Promise<ActiveDescriptor | undefined> {
  try {
    const response = await cache.match(metadataUrl);
    if (response === undefined) return undefined;
    const value: unknown = await response.json();
    if (typeof value !== 'object' || value === null) return undefined;
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.buildId !== 'string' ||
      !Array.isArray(candidate.current) ||
      !Array.isArray(candidate.previous) ||
      !candidate.current.every((url) => typeof url === 'string') ||
      !candidate.previous.every((url) => typeof url === 'string')
    )
      return undefined;
    return candidate as unknown as ActiveDescriptor;
  } catch {
    return undefined;
  }
}

worker.addEventListener('install', (event) => {
  if (!supported) return;
  event.waitUntil(worker.navigator.locks.request(lockName, () => controller.install(event)));
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (supported) {
        const cache = await caches.open(cacheName);
        const old = await readDescriptor(cache);
        const descriptor: ActiveDescriptor = {
          buildId: __MAR_BUILD_ID__,
          current: __MAR_IMMUTABLE_URLS__,
          previous: (old?.current ?? []).filter((url) => {
            const path = new URL(url, worker.location.origin).pathname;
            return path !== '/docs' && !path.startsWith('/docs/');
          })
        };
        try {
          await cache.put(
            metadataUrl,
            new Response(JSON.stringify(descriptor), {
              headers: { 'content-type': 'application/json' }
            })
          );
          await worker.navigator.locks.request(lockName, { ifAvailable: true }, async (lock) => {
            if (lock === null || worker.registration.installing || worker.registration.waiting)
              return;
            // An absent descriptor may represent a legacy or interrupted activation.
            if (old === undefined) return;
            const keep = new Set(controller.getURLsToCacheKeys().values());
            keep.add(metadataUrl);
            for (const url of descriptor.previous)
              keep.add(new URL(url, worker.location.origin).href);
            for (const request of await cache.keys()) {
              if (!keep.has(request.url)) await cache.delete(request);
            }
          });
        } catch {
          // Retain old entries when metadata or cleanup cannot be safely completed.
        }
      }
      await worker.clients.claim();
    })()
  );
});

function currentUrl(request: Request): string | undefined {
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin || request.method !== 'GET') return undefined;
  if (url.pathname.startsWith('/__mar_direct_download__/')) return undefined;
  if (url.pathname === '/docs' || url.pathname.startsWith('/docs/')) return undefined;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__mar_pwa_metadata__/'))
    return undefined;
  if (request.mode === 'navigate') {
    if (
      url.pathname === '/' ||
      url.pathname === '/index.html' ||
      url.pathname === '/console' ||
      (url.pathname.startsWith('/console/') && !url.pathname.split('/').at(-1)?.includes('.'))
    )
      return new URL('/index.html', url.origin).href;
    const exact = new URL(url.pathname, url.origin).href;
    return url.search === '' && controller.getCacheKeyForURL(exact) !== undefined
      ? exact
      : undefined;
  }
  if (
    url.search !== '' &&
    !(
      ['/favicon.ico', '/icons/app-icon-192.png', '/icons/app-icon-512.png'].includes(
        url.pathname
      ) && /^\?v=[^&]+$/.test(url.search)
    )
  )
    return undefined;
  url.search = '';
  url.hash = '';
  return url.href;
}

worker.addEventListener('fetch', (event) => {
  if (!supported) return;
  const url = currentUrl(event.request);
  if (url === undefined) return;
  const key = controller.getCacheKeyForURL(url);
  event.respondWith(
    (async () => {
      const cache = await caches.open(cacheName);
      if (key !== undefined) {
        const cached = await controller.matchPrecache(url);
        if (cached !== undefined) return cached;
        await markDegraded();
        return fetch(event.request);
      }
      const descriptor = await readDescriptor(cache);
      const retained =
        descriptor?.buildId === __MAR_BUILD_ID__ ? descriptor.previous : descriptor?.current;
      if (retained?.some((entry) => new URL(entry, worker.location.origin).href === url)) {
        const cached = await cache.match(url);
        if (cached !== undefined) return cached;
      }
      return fetch(event.request);
    })()
  );
});

async function activeBuildId(active: ServiceWorker): Promise<string | undefined> {
  const channel = new MessageChannel();
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(undefined), 2000);
    const finish = (value: string | undefined) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(value);
    };
    channel.port1.onmessage = (event) => {
      const buildId: unknown = event.data?.buildId;
      finish(typeof buildId === 'string' ? buildId : undefined);
    };
    try {
      active.postMessage({ type: 'MAR_PWA_ACTIVE_ID' }, [channel.port2]);
    } catch {
      channel.port2.close();
      finish(undefined);
    }
  });
}

worker.addEventListener('message', (event) => {
  const data: unknown = event.data;
  const port = event.ports[0];
  if (port === undefined || typeof data !== 'object' || data === null) return;
  const message = data as Record<string, unknown>;
  if (message.type === 'MAR_PWA_ACTIVE_ID') {
    port.postMessage({ buildId: __MAR_BUILD_ID__ });
    return;
  }
  if (message.type !== 'MAR_PWA_STATUS' && message.type !== 'MAR_PWA_APPLY') return;
  event.waitUntil(
    (async () => {
      const sourceId = event.source && 'id' in event.source ? event.source.id : undefined;
      const source = sourceId === undefined ? undefined : await worker.clients.get(sourceId);
      if (source === undefined || new URL(source.url).origin !== worker.location.origin) return;
      if (message.type === 'MAR_PWA_STATUS') {
        port.postMessage({
          buildId: __MAR_BUILD_ID__,
          version: __MAR_BUILD_VERSION__,
          supported,
          degraded,
          entry: await hasEntry()
        });
        return;
      }
      if (!supported || typeof message.pageBuildId !== 'string') {
        port.postMessage({ applied: false, reason: 'UNAVAILABLE' });
        return;
      }
      const descriptor = await readDescriptor(await caches.open(cacheName));
      const active = worker.registration.active;
      const activeId = active === null ? undefined : await activeBuildId(active);
      const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.length !== 1 || clients[0]?.id !== source.id) {
        port.postMessage({ applied: false, reason: 'OTHER_WINDOWS' });
      } else if (
        descriptor === undefined ||
        active === null ||
        worker.registration.active !== active ||
        descriptor.buildId !== activeId ||
        (message.pageBuildId !== descriptor.buildId && message.pageBuildId !== __MAR_BUILD_ID__)
      ) {
        port.postMessage({ applied: false, reason: 'VERSION_UNKNOWN' });
      } else if (!(await hasEntry()) || degraded) {
        port.postMessage({ applied: false, reason: 'UNAVAILABLE' });
      } else {
        await worker.skipWaiting();
        port.postMessage({ applied: true });
      }
    })()
  );
});
