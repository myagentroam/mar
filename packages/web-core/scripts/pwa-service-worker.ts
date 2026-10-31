import { PrecacheController } from 'workbox-precaching';
import 'mar-legacy-worker-handlers';

declare const __MAR_BUILD_ID__: string;
declare const __MAR_BUILD_VERSION__: string;
declare const __MAR_PRECACHE_MANIFEST__: Array<{ url: string; revision: string | null }>;

const worker = self as unknown as ServiceWorkerGlobalScope;
const cacheName = 'mar-static-precache';
const controller = new PrecacheController({ cacheName });
const manifest = __MAR_PRECACHE_MANIFEST__;
controller.addToCacheList(manifest);

async function hasEntry(): Promise<boolean> {
  const key = controller.getCacheKeyForURL(new URL('/index.html', worker.location.origin).href);
  return key !== undefined && Boolean(await (await caches.open(cacheName)).match(key));
}

worker.addEventListener('install', (event) => {
  event.waitUntil(controller.install(event));
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(controller.activate(event).then(() => worker.clients.claim()));
});

function currentUrl(request: Request): string | undefined {
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin || request.method !== 'GET') return undefined;
  if (url.pathname.startsWith('/__mar_direct_download__/')) return undefined;
  if (url.pathname === '/docs' || url.pathname.startsWith('/docs/')) return undefined;
  if (url.pathname.startsWith('/api/')) return undefined;
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
  const url = currentUrl(event.request);
  if (url === undefined || controller.getCacheKeyForURL(url) === undefined) return;
  event.respondWith(
    (async () => {
      return (await controller.matchPrecache(url)) ?? fetch(event.request);
    })()
  );
});

worker.addEventListener('message', (event) => {
  const data: unknown = event.data;
  const port = event.ports[0];
  if (port === undefined || typeof data !== 'object' || data === null) return;
  const message = data as Record<string, unknown>;
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
          // An already-open Console can still expect the previous status shape.
          supported: true,
          degraded: false,
          entry: await hasEntry()
        });
        return;
      }
      const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.length !== 1 || clients[0]?.id !== source.id) {
        port.postMessage({ applied: false, reason: 'OTHER_WINDOWS' });
      } else if (!(await hasEntry())) {
        port.postMessage({ applied: false, reason: 'UNAVAILABLE' });
      } else {
        await worker.skipWaiting();
        port.postMessage({ applied: true });
      }
    })()
  );
});
