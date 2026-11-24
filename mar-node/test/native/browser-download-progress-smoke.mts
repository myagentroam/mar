import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { browserDownloadPageSchema } from '@myagentroam/protocol';
import { createBrowserLauncher } from '../../src/browser/browser-launcher.js';
import { BrowserTabs } from '../../src/browser/browser-tabs.js';

const directory = await mkdtemp(join(tmpdir(), 'mar-browser-download-progress-'));
const runs = join(directory, 'runs');
const errors: unknown[] = [];
const failed = (error: unknown) => errors.push(error);
const launcher = createBrowserLauncher(runs, join(directory, 'profiles'), failed);
const size = 4 * 1024 * 1024;
const first = Buffer.alloc(size / 4, 1);
const requests = new Map<string, ServerResponse>();
const server = createServer((request, response) => {
  const path = request.url;
  if (path !== '/known' && path !== '/unknown') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<a href="/known">Known</a><a href="/unknown">Unknown</a>');
    return;
  }
  response.setHeader('Content-Type', 'application/octet-stream');
  response.setHeader('Content-Disposition', `attachment; filename="${path.slice(1)}.bin"`);
  if (path === '/known') response.setHeader('Content-Length', size);
  requests.set(path, response);
  response.write(first);
});

async function until<T>(get: () => Promise<T | undefined>): Promise<T> {
  const end = performance.now() + 8_000;
  while (performance.now() < end) {
    const value = await get();
    if (value !== undefined) return value;
    await sleep(50);
  }
  throw new Error('Timed out waiting for browser download state');
}

let browser: Awaited<ReturnType<typeof launcher.launch>> | undefined;
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  browser = await launcher.launch();
  assert(browser.downloads);
  let byteUpdates = 0;
  const tabs = new BrowserTabs(browser.context, {
    limit: 8,
    failed,
    downloads: browser.downloads,
    onDownloadBytesReceived: () => byteUpdates++
  });
  const list = async (progress = true) =>
    browserDownloadPageSchema.parse(
      await tabs.download({ action: 'list', offset: 0, ...(progress && { progress: true }) })
    ).items;
  const page = browser.context.pages()[0]!;
  await page.goto(`http://127.0.0.1:${address.port}`);

  await page.getByRole('link', { name: 'Known', exact: true }).click();
  const known = await until(async () =>
    (await list()).find((item) => item.name === 'known.bin' && item.receivedBytes === first.length)
  );
  assert.equal(tabs.startedDownloadCount, 1);
  assert.equal(tabs.activeDownloadCount, 1);
  assert.equal(known.totalBytes, size);
  const oldClient = (await list(false))[0];
  assert.deepEqual(oldClient, { id: known.id, name: known.name, state: 'downloading' });
  assert(byteUpdates > 0);
  const initialUpdates = byteUpdates;
  requests.get('/known')!.write(first);
  await until(async () =>
    (await list()).find((item) => item.id === known.id && item.receivedBytes === 2 * first.length)
  );
  assert(byteUpdates > initialUpdates);
  requests.get('/known')!.end(Buffer.alloc(size - 2 * first.length, 2));
  const ready = await until(async () =>
    (await list()).find((item) => item.id === known.id && item.state === 'ready')
  );
  assert.equal(ready.size, size);
  assert.deepEqual(await tabs.download({ action: 'chunk', id: ready.id, offset: 0, limit: 3 }), {
    contentBase64: first.subarray(0, 3).toString('base64'),
    offset: 0
  });

  await page.getByRole('link', { name: 'Unknown', exact: true }).click();
  const unknown = await until(async () =>
    (await list()).find(
      (item) => item.name === 'unknown.bin' && item.receivedBytes === first.length
    )
  );
  assert.equal(tabs.startedDownloadCount, 2);
  assert.equal(unknown.totalBytes, undefined);
  await tabs.download({ action: 'cancel', id: unknown.id });
  await until(async () =>
    (await list()).find((item) => item.id === unknown.id && item.state === 'canceled')
  );
  assert.equal(tabs.activeDownloadCount, 0);
  assert.deepEqual(errors, []);
  console.log('Browser download byte progress, completion, file reads, and cancellation passed.');
} finally {
  try {
    await browser?.close();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
