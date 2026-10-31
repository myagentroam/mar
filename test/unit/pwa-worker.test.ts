import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';

const origin = 'https://pwa.test';
const metadata = `${origin}/__mar_pwa_metadata__/active`;

class FixtureCache {
  readonly entries = new Map<string, Response>();
  async match(request: Request | string): Promise<Response | undefined> {
    return this.entries.get(typeof request === 'string' ? request : request.url)?.clone();
  }
  async put(request: Request | string, response: Response): Promise<void> {
    const url = typeof request === 'string' ? request : request.url;
    this.entries.set(url, response.clone());
  }
  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
  async delete(request: Request | string): Promise<boolean> {
    return this.entries.delete(typeof request === 'string' ? request : request.url);
  }
}

async function workerFixture(
  cache: FixtureCache,
  buildId: string,
  fixtureOptions: { otherWindow?: boolean } = {}
) {
  const bundle = await build({
    absWorkingDir: process.cwd(),
    entryPoints: ['packages/web-core/scripts/pwa-service-worker.ts'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    define: {
      'process.env.NODE_ENV': '"production"',
      __MAR_BUILD_ID__: JSON.stringify(buildId),
      __MAR_BUILD_VERSION__: '"1"',
      __MAR_PRECACHE_MANIFEST__: JSON.stringify([
        { url: '/index.html', revision: 'index' },
        { url: '/icons/app-icon-192.png', revision: 'icon' },
        { url: '/manifest.webmanifest', revision: 'manifest' },
        { url: '/assets/b.js', revision: null }
      ])
    },
    plugins: [
      {
        name: 'legacy-fixture',
        setup(builder) {
          builder.onResolve({ filter: /^mar-legacy-worker-handlers$/ }, () => ({
            path: 'empty',
            namespace: 'test'
          }));
          builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
            contents: '',
            loader: 'js'
          }));
        }
      }
    ]
  });
  const listeners = new Map<string, (event: any) => void>();
  const clientMessage = vi.fn();
  const source = { id: 'window-1', url: `${origin}/console`, postMessage: clientMessage };
  const skipWaiting = vi.fn(async () => undefined);
  const network = vi.fn(async (_request: Request | string) => new Response('network'));
  const cacheStorage = {
    open: async () => cache,
    match: (request: Request | string) => cache.match(request)
  };
  const claim = vi.fn(async () => undefined);
  const self = {
    location: new URL(`${origin}/service-worker.js`),
    caches: cacheStorage,
    navigator: {
      languages: ['en-US']
    },
    registration: {
      active: null,
      waiting: null,
      installing: null,
      scope: `${origin}/`
    },
    clients: {
      get: async () => source,
      matchAll: async () => (fixtureOptions.otherWindow ? [source, { id: 'window-2' }] : [source]),
      claim
    },
    skipWaiting,
    addEventListener: (type: string, listener: (event: any) => void) =>
      listeners.set(type, listener)
  };
  runInNewContext(bundle.outputFiles[0]!.text, {
    self,
    location: self.location,
    navigator: self.navigator,
    caches: cacheStorage,
    fetch: network,
    URL,
    Request,
    Response,
    Headers,
    MessageChannel,
    setTimeout,
    clearTimeout,
    FetchEvent: class {},
    console
  });
  return {
    skipWaiting,
    network,
    clientMessage,
    claim,
    async install() {
      const promises: Promise<unknown>[] = [];
      listeners.get('install')!({
        type: 'install',
        waitUntil: (promise: Promise<unknown>) => promises.push(promise)
      });
      await Promise.all(promises);
    },
    async activate() {
      const promises: Promise<unknown>[] = [];
      listeners.get('activate')!({
        waitUntil: (promise: Promise<unknown>) => promises.push(promise)
      });
      await Promise.all(promises);
    },
    async fetch(path: string, navigate = false) {
      let response: Promise<Response> | undefined;
      const request = navigate
        ? { url: `${origin}${path}`, method: 'GET', mode: 'navigate', headers: new Headers() }
        : new Request(`${origin}${path}`);
      listeners.get('fetch')!({
        request,
        respondWith: (value: Promise<Response>) => {
          response = Promise.resolve(value);
        }
      });
      return response === undefined ? undefined : await response;
    },
    async message(data: { type: string; pageBuildId?: string }) {
      const messages: unknown[] = [];
      const promises: Promise<unknown>[] = [];
      listeners.get('message')!({
        data,
        source,
        ports: [{ postMessage: (value: unknown) => messages.push(value) }],
        waitUntil: (promise: Promise<unknown>) => promises.push(promise)
      });
      await Promise.all(promises);
      return messages[0];
    },
    async apply(pageBuildId: string) {
      return this.message({ type: 'MAR_PWA_APPLY', pageBuildId });
    }
  };
}

describe('PWA worker app shell and user-requested updates', () => {
  it('precaches without Web Locks and reuses unchanged resources without fetching them again', async () => {
    const cache = new FixtureCache();
    await cache.put(`${origin}/assets/b.js`, new Response('unchanged bundle'));
    const worker = await workerFixture(cache, 'B');
    await worker.install();
    expect(await (await cache.match(`${origin}/assets/b.js`))?.text()).toBe('unchanged bundle');
    expect(await (await worker.fetch('/console', true))?.text()).toBe('network');
    expect(worker.network.mock.calls.map(([request]) => (request as Request).url)).not.toContain(
      `${origin}/assets/b.js`
    );
    expect(worker.network).toHaveBeenCalledTimes(3);
    expect(worker.skipWaiting).not.toHaveBeenCalled();
  });

  it('does not serve or retain legacy documentation cache entries', async () => {
    const cache = new FixtureCache();
    await cache.put(
      metadata,
      Response.json({
        buildId: 'A',
        current: ['/assets/a.js', '/docs/assets/old.js'],
        previous: []
      })
    );
    await cache.put(`${origin}/docs/assets/old.js`, new Response('old help'));
    const worker = await workerFixture(cache, 'B');
    expect(await worker.fetch('/docs/assets/old.js')).toBeUndefined();
    expect(await worker.fetch('/docs/getting-started/overview', true)).toBeUndefined();
    expect(await worker.fetch('/docs', true)).toBeUndefined();
    await worker.activate();
    expect(await cache.match(`${origin}/docs/assets/old.js`)).toBeUndefined();
  });

  it('uses Workbox activation cleanup for obsolete resources and the former generation ledger', async () => {
    const cache = new FixtureCache();
    await cache.put(
      metadata,
      Response.json({ buildId: 'A', current: ['/assets/a.js'], previous: ['/assets/older.js'] })
    );
    await cache.put(`${origin}/assets/a.js`, new Response('A'));
    await cache.put(`${origin}/assets/b.js`, new Response('B'));
    await cache.put(`${origin}/assets/older.js`, new Response('older'));
    const worker = await workerFixture(cache, 'B');
    await worker.activate();
    expect(await cache.match(`${origin}/assets/a.js`)).toBeUndefined();
    expect(await (await cache.match(`${origin}/assets/b.js`))?.text()).toBe('B');
    expect(await cache.match(`${origin}/assets/older.js`)).toBeUndefined();
    expect(await cache.match(metadata)).toBeUndefined();
    expect(worker.claim).toHaveBeenCalledOnce();
  });

  it('activates on request without a generation ledger or an active-worker identity handshake', async () => {
    const cache = new FixtureCache();
    await cache.put(`${origin}/index.html?__WB_REVISION__=index`, new Response('entry'));
    const waiting = await workerFixture(cache, 'C');
    expect(await waiting.apply('C')).toEqual({ applied: true });
    expect(waiting.skipWaiting).toHaveBeenCalledOnce();
  });

  it('refuses activation while another app window is still open', async () => {
    const cache = new FixtureCache();
    await cache.put(`${origin}/index.html?__WB_REVISION__=index`, new Response('entry'));
    const waiting = await workerFixture(cache, 'C', { otherWindow: true });
    expect(await waiting.apply('B')).toEqual({ applied: false, reason: 'OTHER_WINDOWS' });
    expect(waiting.skipWaiting).not.toHaveBeenCalled();
  });

  it('refuses activation if the prepared entry disappears after status', async () => {
    const cache = new FixtureCache();
    const entry = `${origin}/index.html?__WB_REVISION__=index`;
    await cache.put(entry, new Response('entry'));
    const waiting = await workerFixture(cache, 'C');
    expect(await waiting.message({ type: 'MAR_PWA_STATUS' })).toMatchObject({
      supported: true,
      degraded: false,
      entry: true
    });
    await cache.delete(entry);
    expect(await waiting.apply('B')).toEqual({ applied: false, reason: 'UNAVAILABLE' });
    expect(waiting.skipWaiting).not.toHaveBeenCalled();
  });

  it('normalizes version queries only for the known product icons', async () => {
    const cache = new FixtureCache();
    await cache.put(
      `${origin}/icons/app-icon-192.png?__WB_REVISION__=icon`,
      new Response('cached icon')
    );
    await cache.put(
      `${origin}/manifest.webmanifest?__WB_REVISION__=manifest`,
      new Response('old manifest')
    );
    const worker = await workerFixture(cache, 'B');
    expect(await (await worker.fetch('/icons/app-icon-192.png?v=logo'))?.text()).toBe(
      'cached icon'
    );
    expect(await worker.fetch('/manifest.webmanifest?v=new')).toBeUndefined();
    expect(worker.network).not.toHaveBeenCalled();
  });

  it('passes through nonessential public navigation without applying the app fallback', async () => {
    const cache = new FixtureCache();
    const worker = await workerFixture(cache, 'B');
    expect(await worker.fetch('/THIRD_PARTY_NOTICES.txt', true)).toBeUndefined();
    expect(await worker.fetch('/share/abc', true)).toBeUndefined();
    expect(await worker.fetch('/missing.txt', true)).toBeUndefined();
    expect(await worker.fetch('/api/private.txt', true)).toBeUndefined();
    expect(worker.network).not.toHaveBeenCalled();
  });

  it('falls back to the network on a cache miss without caching arbitrary network responses', async () => {
    const cache = new FixtureCache();
    const worker = await workerFixture(cache, 'B');
    expect(await (await worker.fetch('/icons/app-icon-192.png'))?.text()).toBe('network');
    expect(await cache.match(`${origin}/icons/app-icon-192.png`)).toBeUndefined();
    expect(worker.clientMessage).not.toHaveBeenCalled();
  });
});
