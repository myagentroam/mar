import type { Plugin, ViteDevServer } from 'vite';
import { notificationsEnUS } from '../src/i18n/notifications.en-US.ts';
import { notificationsZhCN } from '../src/i18n/notifications.zh-CN.ts';

const serviceWorkerSource = String.raw`
const directDownloads = new Map();
const desktopNotificationAttempts = new Map();

function notificationClientState(client, account, projectionId) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => { channel.port1.close(); resolve({ valid: false }); }, 500);
    channel.port1.onmessage = (reply) => {
      clearTimeout(timeout);
      channel.port1.close();
      resolve({ valid: reply.data?.valid === true, foreground: reply.data?.foreground === true });
    };
    try { client.postMessage({ type: 'mar.workbench.notification.state', account, projectionId }, [channel.port2]); }
    catch { clearTimeout(timeout); channel.port1.close(); resolve({ valid: false }); }
  });
}

function showDesktopNotification(event) {
  const value = event.data;
  if (value?.type !== 'mar.workbench.notification.show') return;
  const source = event.source;
  if (!source || !event.ports[0] ||
      typeof value.account !== 'string' || value.account.length > 128 ||
      typeof value.id !== 'string' || value.id.length > 256 ||
      typeof value.projectionId !== 'string' || value.projectionId.length > 128 ||
      typeof value.title !== 'string' || value.title.length > 4000 ||
      typeof value.body !== 'string' || value.body.length > 4000 ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) return;
  if (typeof source.url !== 'string') return;
  const sourceUrl = new URL(source.url);
  if (sourceUrl.origin !== self.location.origin || sourceUrl.pathname !== '/console') return;
  const key = JSON.stringify([value.account, value.id]);
  for (const [id, expiresAt] of desktopNotificationAttempts) {
    if (expiresAt <= Date.now()) desktopNotificationAttempts.delete(id);
  }
  if (desktopNotificationAttempts.has(key) || desktopNotificationAttempts.size >= 2048) {
    event.ports[0].postMessage({ done: true }); event.ports[0].close(); return;
  }
  desktopNotificationAttempts.set(key, value.expiresAt);
  event.waitUntil((async () => {
    try {
      const client = await self.clients.get(source.id);
      if (!client) return;
      const url = new URL(client.url);
      if (url.origin !== self.location.origin || url.pathname !== '/console') return;
      const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
        .filter((entry) => { const candidate = new URL(entry.url); return candidate.origin === self.location.origin && candidate.pathname === '/console'; });
      if (windows.length > 32) return;
      const states = await Promise.all(windows.map((entry) => notificationClientState(entry, value.account, entry.id === client.id ? value.projectionId : undefined)));
      if (!states.some((state, index) => windows[index].id === client.id && state.valid) ||
          states.some((state) => state.valid && state.foreground) || value.expiresAt <= Date.now()) return;
      const tag = 'mar.workbench:' + value.account + ':' + value.id;
      await self.registration.showNotification(value.title, {
        body: value.body, icon: '/icons/app-icon-192.png', tag,
        data: { type: 'mar.workbench.notification', account: value.account, id: value.id,
          projectionId: value.projectionId, expiresAt: value.expiresAt, clientUrl: client.url }
      });
      if (!(await notificationClientState(client, value.account, value.projectionId)).valid) {
        for (const entry of await self.registration.getNotifications({ tag })) {
          if (entry.data?.projectionId === value.projectionId) entry.close();
        }
      }
    } catch { /* Optional projection: never bypass the in-page notification center. */ }
    finally { event.ports[0].postMessage({ done: true }); event.ports[0].close(); }
  })());
}
const genericPushMessages = ${JSON.stringify({ 'en-US': notificationsEnUS.workbenchNotificationCenter.webPush.generic, 'zh-CN': notificationsZhCN.workbenchNotificationCenter.webPush.generic })};

async function pushDisplayBinding() {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open('mar.web-push.v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('bindings');
      request.onerror = request.onblocked = () => resolve(undefined);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('bindings');
        const read = transaction.objectStore('bindings').get('display');
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => resolve(undefined);
        transaction.oncomplete = () => database.close();
        transaction.onabort = () => { database.close(); resolve(undefined); };
      };
    } catch { resolve(undefined); }
  });
}

function matchesPushBinding(binding, data) {
  return binding?.enabled === true && binding.account === data?.account &&
    binding.subscriptionId === data?.subscriptionId && binding.bindingVersion === data?.bindingVersion;
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let value;
    try { value = event.data?.json(); } catch { /* Fail closed to generic content. */ }
    const binding = await pushDisplayBinding();
    const valid = value?.data?.type === 'mar.workbench.notification' &&
      typeof value.data.account === 'string' && value.data.account.length <= 128 &&
      typeof value.data.id === 'string' && value.data.id.length <= 256 &&
      typeof value.title === 'string' && value.title.length <= 320 &&
      typeof value.body === 'string' && value.body.length <= 1200 &&
      Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now() &&
      matchesPushBinding(binding, value.data);
    const generic = Object.hasOwn(genericPushMessages, value?.locale)
      ? genericPushMessages[value.locale] : genericPushMessages['en-US'];
    const data = valid ? { ...value.data, expiresAt: value.expiresAt } : { type: 'mar.workbench.notification.generic' };
    await self.registration.showNotification(valid ? value.title : generic.title, {
      body: valid ? value.body : generic.body,
      icon: '/icons/app-icon-192.png',
      tag: valid ? 'mar.workbench:' + data.account + ':' + data.id : 'mar.workbench:generic',
      data
    });
    // If local disable/account change won the race, remove this projection immediately.
    if (valid && !matchesPushBinding(await pushDisplayBinding(), data)) {
      for (const entry of await self.registration.getNotifications({ tag: 'mar.workbench:' + data.account + ':' + data.id })) {
        if (entry.data?.subscriptionId === data.subscriptionId && entry.data?.bindingVersion === data.bindingVersion) entry.close();
      }
    }
  })());
});

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data;
  if (!['mar.workbench.notification', 'mar.workbench.notification.generic'].includes(data?.type)) return;
  event.notification.close();
  event.waitUntil((async () => {
    if (data.type === 'mar.workbench.notification.generic' ||
        typeof data.account !== 'string' || typeof data.id !== 'string' ||
        (data.subscriptionId !== undefined && (data.expiresAt <= Date.now() || !matchesPushBinding(await pushDisplayBinding(), data)))) {
      await self.clients.openWindow(new URL('/console', self.location.origin).href);
      return;
    }
    const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .filter((client) => new URL(client.url).pathname === '/console')
      .sort((left, right) => Number(right.url === data.clientUrl) - Number(left.url === data.clientUrl));
    for (const client of windows) {
      const accepted = await new Promise((resolve) => {
        const channel = new MessageChannel();
        const timeout = setTimeout(() => { channel.port1.close(); resolve(false); }, 1000);
        channel.port1.onmessage = (reply) => {
          clearTimeout(timeout);
          channel.port1.close();
          resolve(reply.data?.accepted === true);
        };
        client.postMessage({ type: 'mar.workbench.notification.click', account: data.account, id: data.id }, [channel.port2]);
      });
      if (accepted) { await client.focus(); return; }
    }
    const url = new URL('/console', self.location.origin);
    url.searchParams.set('notification', data.id);
    url.searchParams.set('notificationAccount', data.account);
    await self.clients.openWindow(url.href);
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'mar.workbench.notification.show') { showDesktopNotification(event); return; }
  const value = event.data;
  const port = event.ports[0];
  if (
    value?.type !== 'direct-download.create' ||
    typeof value.id !== 'string' ||
    typeof value.fileName !== 'string' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    port === undefined
  )
    return;
  const timeout = setTimeout(() => {
    const session = directDownloads.get(value.id);
    if (session?.port !== port) return;
    directDownloads.delete(value.id);
    port.postMessage({ type: 'cancel', reason: 'DIRECT_DOWNLOAD_NOT_STARTED' });
    port.close();
  }, 60_000);
  directDownloads.set(value.id, {
    fileName: value.fileName,
    size: value.size,
    port,
    timeout,
    closeRequested: false
  });
  port.onmessage = (message) => {
    const session = directDownloads.get(value.id);
    if (session?.port !== port) return;
    // Empty downloads can close before iframe navigation reaches the fetch handler.
    if (message.data?.type === 'close') { session.closeRequested = true; return; }
    if (message.data?.type !== 'abort') return;
    directDownloads.delete(value.id);
    clearTimeout(timeout);
    port.close();
  };
  port.postMessage({ type: 'created' });
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const prefix = '/__mar_direct_download__/';
  if (url.origin !== self.location.origin || !url.pathname.startsWith(prefix)) return;
  const id = url.pathname.slice(prefix.length);
  const session = directDownloads.get(id);
  if (session === undefined || event.request.method !== 'GET') {
    event.respondWith(new Response('Direct download unavailable', { status: 410 }));
    return;
  }
  directDownloads.delete(id);
  clearTimeout(session.timeout);
  let controller;
  let closed = false;
  let pullOutstanding = false;
  const finish = () => {
    closed = true;
    controller.close();
    session.port.postMessage({ type: 'finished' });
    session.port.close();
  };
  const requestChunk = () => {
    if (closed || pullOutstanding) return;
    pullOutstanding = true;
    session.port.postMessage({ type: 'pull' });
  };
  session.port.onmessage = (message) => {
    if (closed) return;
    const value = message.data;
    if (value?.type === 'chunk' && value.bytes instanceof ArrayBuffer) {
      if (!pullOutstanding) {
        closed = true;
        controller.error(new Error('Unexpected direct download chunk'));
        session.port.close();
        return;
      }
      pullOutstanding = false;
      controller.enqueue(new Uint8Array(value.bytes));
      return;
    }
    if (value?.type === 'close') {
      finish();
      return;
    }
    if (value?.type === 'abort') {
      closed = true;
      controller.error(new Error('Direct download failed'));
      session.port.close();
    }
  };
  const body = new ReadableStream({
    start(value) {
      controller = value;
      if (session.closeRequested) finish();
      else requestChunk();
    },
    pull() {
      requestChunk();
    },
    cancel() {
      if (closed) return;
      closed = true;
      session.port.postMessage({ type: 'cancel', reason: 'DIRECT_DOWNLOAD_CANCELLED' });
      session.port.close();
    }
  });
  const encodedName = encodeURIComponent(session.fileName).replaceAll("'", '%27');
  event.respondWith(
    new Response(body, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(session.size),
        'content-disposition': "attachment; filename*=UTF-8''" + encodedName,
        'cache-control': 'no-store'
      }
    })
  );
});
`;

export function directDownloadServiceWorkerPlugin(): Plugin {
  const installServiceWorker = (server: Pick<ViteDevServer, 'middlewares'>) => {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split('?')[0] !== '/service-worker.js') {
        next();
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        'service-worker-allowed': '/'
      });
      response.end(serviceWorkerSource);
    });
  };
  return {
    name: 'myagentroam-direct-download-service-worker',
    configureServer(server) {
      installServiceWorker(server);
    },
    configurePreviewServer(server) {
      installServiceWorker(server);
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'service-worker.js',
        source: serviceWorkerSource
      });
    }
  };
}
