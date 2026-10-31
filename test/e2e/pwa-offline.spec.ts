import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  pwaFixturePrivateUserFile,
  startPwaOfflineFixture
} from './support/pwa-offline-fixture.js';

test('final PWA artifact cold-starts Console offline without caching docs or nonessential data', async ({
  browser
}) => {
  test.setTimeout(180_000);
  const fixture = await startPwaOfflineFixture({ suffix: 'offline' });
  const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'allow' });
  let page: Page | undefined;

  try {
    page = await context.newPage();
    const visitedPaths = new Set<string>();
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin === fixture.origin) visitedPaths.add(url.pathname);
    });

    await page.goto(`${fixture.origin}/console`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toBeVisible();

    await expect
      .poll(() => page!.evaluate(() => Boolean(navigator.serviceWorker.controller)), {
        timeout: 60_000
      })
      .toBe(true);

    const installedStatus = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const worker = navigator.serviceWorker.controller ?? registration.active;
      if (!worker) throw new Error('The installed PWA has no active service worker.');
      const channel = new MessageChannel();
      const response = new Promise<unknown>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('PWA status timed out.')), 5_000);
        channel.port1.onmessage = (event) => {
          window.clearTimeout(timeout);
          resolve(event.data);
          channel.port1.close();
        };
      });
      worker.postMessage({ type: 'MAR_PWA_STATUS' }, [channel.port2]);
      return response;
    });
    expect(installedStatus).toMatchObject({
      buildId: fixture.buildId,
      supported: true,
      degraded: false,
      entry: true
    });

    const privateResponses = await page.evaluate(async (privateFilePath) => {
      const apiResponse = await fetch('/api/pwa-fixture/profile');
      const userFileResponse = await fetch(privateFilePath);
      return {
        api: { status: apiResponse.status, body: await apiResponse.text() },
        userFile: { status: userFileResponse.status, body: await userFileResponse.text() }
      };
    }, pwaFixturePrivateUserFile.path);
    expect(privateResponses.api).toMatchObject({
      status: 200,
      body: '{"fixture":"private-api-response"}'
    });
    expect(privateResponses.userFile).toEqual({
      status: 200,
      body: pwaFixturePrivateUserFile.body
    });
    expect(fixture.requests).toEqual(
      expect.arrayContaining(['/api/pwa-fixture/profile', pwaFixturePrivateUserFile.path])
    );

    const noticeResponse = await page.evaluate(async () => {
      const response = await fetch('/THIRD_PARTY_NOTICES.txt');
      return {
        status: response.status,
        byteLength: Number(response.headers.get('content-length'))
      };
    });
    expect(noticeResponse.status).toBe(200);
    expect(noticeResponse.byteLength).toBeGreaterThan(0);
    expect(fixture.requests).toContain('/THIRD_PARTY_NOTICES.txt');

    await page.goto(`${fixture.origin}/docs/getting-started/overview`, {
      waitUntil: 'domcontentloaded'
    });
    await expect(page.locator('h1')).toContainText('MyAgentRoam 是什么');
    await page.goto(`${fixture.origin}/docs/en-US/getting-started/overview`, {
      waitUntil: 'domcontentloaded'
    });
    await expect(page.locator('h1')).toContainText('What Is MyAgentRoam?');
    await page.goto(`${fixture.origin}/console`, { waitUntil: 'domcontentloaded' });
    await waitForController(page);

    const forbiddenCacheEntries = await page.evaluate(async () => {
      const unexpected: string[] = [];
      for (const cacheName of await caches.keys()) {
        const cache = await caches.open(cacheName);
        for (const request of await cache.keys()) {
          const pathname = new URL(request.url).pathname;
          const allowed =
            pathname === '/index.html' ||
            pathname.startsWith('/assets/') ||
            pathname === '/manifest.webmanifest' ||
            pathname === '/favicon.ico' ||
            pathname === '/icons/app-icon-192.png' ||
            pathname === '/icons/app-icon-512.png';
          if (!allowed) unexpected.push(pathname);
        }
      }
      return unexpected;
    });
    expect(forbiddenCacheEntries, 'only app bundles and install metadata may be cached').toEqual(
      []
    );

    const unvisitedScript = fixture.scriptAssets.find((asset) => !visitedPaths.has(asset.path));
    expect(
      unvisitedScript,
      'the first app load should leave a built JavaScript chunk unvisited'
    ).toBeDefined();

    await page.close();
    page = undefined;
    await context.setOffline(true);
    const coldPage = await context.newPage();
    await disableHttpCache(context, coldPage);

    await coldPage.goto(`${fixture.origin}/console`, { waitUntil: 'domcontentloaded' });
    await expect
      .poll(() => coldPage.locator('#app').evaluate((element) => element.childElementCount))
      .toBeGreaterThan(0);
    await expect
      .poll(() => coldPage.evaluate(() => Boolean(navigator.serviceWorker.controller)))
      .toBe(true);

    const offlineChunk = await coldPage.evaluate(async (path) => {
      try {
        const response = await fetch(path);
        return {
          ok: response.ok,
          status: response.status,
          contentType: response.headers.get('content-type'),
          byteLength: (await response.arrayBuffer()).byteLength
        };
      } catch {
        return { ok: false, status: 0, contentType: null, byteLength: 0 };
      }
    }, unvisitedScript!.path);
    expect(
      offlineChunk.ok,
      `unvisited chunk should be served from the offline cache: ${unvisitedScript!.path}`
    ).toBe(true);
    expect(offlineChunk.status).toBe(200);
    expect(offlineChunk.contentType).toContain('javascript');
    expect(offlineChunk.byteLength).toBeGreaterThan(0);

    const offlinePrivateResponses = await coldPage.evaluate(async (privateFilePath) => {
      async function isReachable(path: string): Promise<boolean> {
        try {
          return (await fetch(path)).ok;
        } catch {
          return false;
        }
      }
      return {
        api: await isReachable('/api/pwa-fixture/profile'),
        userFile: await isReachable(privateFilePath)
      };
    }, pwaFixturePrivateUserFile.path);
    expect(offlinePrivateResponses).toEqual({ api: false, userFile: false });

    const unavailableTitle = coldPage.getByRole('heading', { name: 'Sign-in status unavailable' });
    await expect(unavailableTitle).toBeVisible();
    const retryButton = coldPage.getByRole('button', { name: 'Retry connection' });
    await expect(retryButton).toBeVisible();
    await expect(coldPage.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(coldPage.locator('form')).toHaveCount(0);
    const helpLink = coldPage.getByRole('link', { name: 'Open documentation' });
    await expect(helpLink).toHaveAttribute('href', '/docs/en-US/getting-started/overview');
    await retryButton.click();
    await expect(unavailableTitle).toBeVisible();

    const offlineDocsPage = await context.newPage();
    await disableHttpCache(context, offlineDocsPage);
    const offlineDocsResponse = await offlineDocsPage
      .goto(`${fixture.origin}/docs/getting-started/overview`, { waitUntil: 'domcontentloaded' })
      .catch(() => null);
    expect(
      offlineDocsResponse?.status() ?? null,
      'offline docs must not resolve to the cached Console entry'
    ).not.toBe(200);
    await expect(
      offlineDocsPage.getByRole('heading', { name: 'Sign-in status unavailable' })
    ).toHaveCount(0);

    const offlineNoticesResponse = await offlineDocsPage
      .goto(`${fixture.origin}/THIRD_PARTY_NOTICES.txt`, { waitUntil: 'domcontentloaded' })
      .catch(() => null);
    expect(
      offlineNoticesResponse?.status() ?? null,
      'nonessential declarations must stay online and not fall back to the Console'
    ).not.toBe(200);
  } finally {
    await context.close();
    await fixture.close();
  }
});

test('failed Worker updates retain the previous artifact before a multi-window-safe retry', async ({
  browser
}) => {
  test.setTimeout(240_000);
  const fixture = await startPwaOfflineFixture({ suffix: 'versions', includePrevious: true });
  const previous = fixture.previous!;
  const current = fixture.current;
  const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'allow' });
  let oldWindow: Page | undefined;
  let secondWindow: Page | undefined;

  try {
    fixture.setRelease('previous');
    oldWindow = await context.newPage();
    await oldWindow.goto(`${fixture.origin}/console`, { waitUntil: 'domcontentloaded' });
    await expect(oldWindow.locator('#app')).toBeVisible();
    await waitForController(oldWindow);
    expect(await readWorkerStatus(oldWindow, 'active')).toMatchObject({
      buildId: previous.buildId,
      supported: true,
      degraded: false,
      entry: true
    });

    secondWindow = await context.newPage();
    await secondWindow.goto(`${fixture.origin}/console`, { waitUntil: 'domcontentloaded' });
    await waitForController(secondWindow);

    const previousScriptPaths = new Set(previous.scriptAssets.map((asset) => asset.path));
    const candidateOnlyScript = current.scriptAssets.find(
      (asset) => !previousScriptPaths.has(asset.path)
    );
    expect(
      candidateOnlyScript,
      'the candidate artifact should contain a versioned script absent from the active artifact'
    ).toBeDefined();

    fixture.setRelease('current');
    fixture.blockPath(candidateOnlyScript!.path);
    expect(await observeWorkerUpdate(oldWindow)).toBe('redundant');
    expect(fixture.failedRequests).toContain(candidateOnlyScript!.path);
    expect(await readWorkerStatus(oldWindow, 'active')).toMatchObject({
      buildId: previous.buildId,
      supported: true,
      entry: true
    });
    expect(
      await oldWindow.evaluate(async () => Boolean((await navigator.serviceWorker.ready).waiting))
    ).toBe(false);

    await secondWindow.close();
    secondWindow = undefined;
    await context.setOffline(true);
    await oldWindow.close();
    oldWindow = await context.newPage();
    await disableHttpCache(context, oldWindow);
    await oldWindow.goto(`${fixture.origin}/console`, { waitUntil: 'domcontentloaded' });
    await expect
      .poll(() => oldWindow!.locator('#app').evaluate((element) => element.childElementCount))
      .toBeGreaterThan(0);
    await waitForController(oldWindow);
    expect(await readWorkerStatus(oldWindow, 'active')).toMatchObject({
      buildId: previous.buildId,
      entry: true
    });

    await context.setOffline(false);
    fixture.setRelease('current');
    fixture.blockPath(undefined);
    secondWindow = await context.newPage();
    await secondWindow.goto(`${fixture.origin}/console`, { waitUntil: 'domcontentloaded' });
    await waitForController(secondWindow);

    expect(await observeWorkerUpdate(oldWindow)).toBe('installed');
    expect(await readWorkerStatus(oldWindow, 'waiting')).toMatchObject({
      buildId: current.buildId,
      supported: true,
      degraded: false,
      entry: true
    });

    expect(await applyWaitingWorker(oldWindow, previous.buildId)).toEqual({
      applied: false,
      reason: 'OTHER_WINDOWS'
    });
    expect(await readWorkerStatus(oldWindow, 'active')).toMatchObject({
      buildId: previous.buildId
    });

    await secondWindow.close();
    secondWindow = undefined;
    const candidateEntry = await readFile(join(current.artifactRoot, 'index.html'), 'utf8');
    const removedEntry = await oldWindow.evaluate(async (html) => {
      const cache = await caches.open('mar-static-precache');
      for (const key of await cache.keys()) {
        if (new URL(key.url).pathname !== '/index.html') continue;
        const response = await cache.match(key);
        if (response && (await response.text()) === html) {
          await cache.delete(key);
          return key.url;
        }
      }
      return undefined;
    }, candidateEntry);
    expect(removedEntry, 'the waiting version entry must have been prepared').toBeDefined();
    expect(await applyWaitingWorker(oldWindow, previous.buildId)).toEqual({
      applied: false,
      reason: 'UNAVAILABLE'
    });
    expect(await readWorkerStatus(oldWindow, 'active')).toMatchObject({
      buildId: previous.buildId
    });
    expect(await readWorkerStatus(oldWindow, 'waiting')).toMatchObject({
      buildId: current.buildId,
      entry: false
    });
    // The test simulates storage eviction and restores the original response for the successful path.
    await oldWindow.evaluate(
      async ({ key, html }) => {
        await (
          await caches.open('mar-static-precache')
        ).put(key, new Response(html, { headers: { 'content-type': 'text/html' } }));
      },
      { key: removedEntry!, html: candidateEntry }
    );
    expect(await applyWaitingWorker(oldWindow, previous.buildId)).toEqual({ applied: true });
    await expect
      .poll(async () => (await readWorkerStatus(oldWindow!, 'active'))?.buildId, {
        timeout: 30_000
      })
      .toBe(current.buildId);

    await oldWindow.reload({ waitUntil: 'domcontentloaded' });
    await expect
      .poll(async () => (await readWorkerStatus(oldWindow!, 'active'))?.buildId, {
        timeout: 30_000
      })
      .toBe(current.buildId);
    await expect(oldWindow.locator('#app')).not.toBeEmpty();
  } finally {
    await context.close();
    await fixture.close();
  }
});

async function disableHttpCache(context: BrowserContext, page: Page): Promise<void> {
  const session = await context.newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.setCacheDisabled', { cacheDisabled: true });
}

async function waitForController(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), {
      timeout: 60_000
    })
    .toBe(true);
}

async function readWorkerStatus(
  page: Page,
  target: 'active' | 'waiting'
): Promise<Record<string, unknown> | null> {
  return page.evaluate(async (workerTarget) => {
    const registration = await navigator.serviceWorker.ready;
    const worker = workerTarget === 'waiting' ? registration.waiting : registration.active;
    if (!worker) return null;
    const channel = new MessageChannel();
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error('PWA worker status timed out.')),
        5_000
      );
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timeout);
        resolve(event.data as Record<string, unknown>);
        channel.port1.close();
      };
    });
    worker.postMessage({ type: 'MAR_PWA_STATUS' }, [channel.port2]);
    return response;
  }, target);
}

async function observeWorkerUpdate(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return new Promise<string>((resolve) => {
      let timeout: number;
      let settled = false;
      const finish = (state: string) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(state);
      };
      const observe = () => {
        const worker = registration.installing ?? registration.waiting;
        if (!worker) return;
        const changed = () => {
          if (worker.state === 'installed' || worker.state === 'redundant') finish(worker.state);
        };
        worker.addEventListener('statechange', changed);
        changed();
      };
      timeout = window.setTimeout(() => finish('timeout'), 90_000);
      if (registration.installing || registration.waiting) {
        observe();
      } else {
        registration.addEventListener('updatefound', observe, { once: true });
        void registration.update().catch(() => finish('update-error'));
      }
    });
  });
}

async function applyWaitingWorker(
  page: Page,
  pageBuildId: string
): Promise<Record<string, unknown> | null> {
  return page.evaluate(async (buildId) => {
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.waiting;
    if (!worker) return null;
    const channel = new MessageChannel();
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error('PWA update apply timed out.')),
        5_000
      );
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timeout);
        resolve(event.data as Record<string, unknown>);
        channel.port1.close();
      };
    });
    worker.postMessage({ type: 'MAR_PWA_APPLY', pageBuildId: buildId }, [channel.port2]);
    return response;
  }, pageBuildId);
}
