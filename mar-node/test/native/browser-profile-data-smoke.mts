import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { attachBrowserProfileData } from '../../src/browser/browser-profile-data.js';
import { BrowserCacheMaintenance } from '../../src/browser/browser-cache-maintenance.js';
import { createBrowserLauncher } from '../../src/browser/browser-launcher.js';
import { chromiumProfileLock } from '../../src/browser/browser-profile-lock.js';
import { BROWSER_VIEWPORT } from '../../src/browser/browser-capture-config.js';

// Local trusted fixtures only. This proves native semantics, not deployment isolation.
const root = await mkdtemp(join(tmpdir(), 'mar-browser-profile-data-'));
const runs = join(root, 'runs');
const profiles = join(root, 'profiles');
const profile = join(profiles, 'a'.repeat(64), 'data');
const { launch } = createBrowserLauncher(runs, profiles, (error) => {
  throw error;
});
const hits = new Map<string, number>();
const favicon = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP47NtIEmIY1TCqYfhqAAAlYMEQZSHRQgAAAABJRU5ErkJggg==',
  'base64'
);
const server = createServer((request, response) => {
  const path = request.url ?? '/';
  if (path === '/site-icon.png') {
    response.writeHead(200, { 'content-type': 'image/png' }).end(favicon);
    return;
  }
  if (path.startsWith('/asset/')) {
    const count = (hits.get(path) ?? 0) + 1;
    hits.set(path, count);
    response.writeHead(200, { 'cache-control': 'public, max-age=3600' }).end(String(count));
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  const title = request.url === '/earlier' ? 'Earlier' : 'Recent';
  response.end(
    `<!doctype html><title>${title}</title><link rel="icon" href="/site-icon.png"><input id="draft">`
  );
});
let owned: Awaited<ReturnType<typeof launch>> | undefined;
try {
  await writeFile(runs, 'temporarily block the run directory');
  await assert.rejects(launch(profile));
  await rm(runs);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bound = server.address();
  assert(bound && typeof bound !== 'string');
  const origin = `http://127.0.0.1:${bound.port}`;
  owned = await launch(profile);
  assert.equal(
    await readFile(join(owned.directory, 'profile-owner'), 'utf8'),
    `${'a'.repeat(64)}\n`
  );
  assert.equal(await chromiumProfileLock(profile), 'live');
  const { context } = owned;
  const page = context.pages()[0]!;
  assert.deepEqual(page.viewportSize(), BROWSER_VIEWPORT);
  await page.goto(`${origin}/earlier`);
  const iconColor = async () => {
    const icon = await owned!.data.favicon(`${origin}/earlier`);
    if (!icon) return;
    return page.evaluate(async (png) => {
      const bitmap = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${png}`)).blob()
      );
      const context = new OffscreenCanvas(16, 16).getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return [...context.getImageData(8, 8, 1, 1).data];
    }, icon);
  };
  for (let attempt = 0; attempt < 25; attempt++) {
    if ((await iconColor())?.[0] === 243) break;
    await delay(80);
  }
  assert.deepEqual(await iconColor(), [243, 77, 129, 255]);
  await page.evaluate(() => {
    document.cookie = 'earlier=kept; path=/';
  });
  const asset = (name: string) =>
    page.evaluate((name) => fetch(`/asset/${name}`).then((response) => response.text()), name);
  assert.equal(await asset('earlier'), '1');
  assert.equal(await asset('earlier'), '1');
  // Chromium's disk-cache index stores whole seconds. Keep fixture entries
  // away from the range boundary so either side remains unambiguous.
  await delay(1_100);
  const cutoff = Date.now();
  await delay(1_100);
  await page.goto(`${origin}/recent`);
  await page.evaluate(() => {
    document.cookie = 'recent=deleted; path=/';
  });
  assert.equal(await asset('recent'), '1');
  assert.equal(await asset('recent'), '1');
  await page.locator('#draft').fill('not reset by deletion');
  const data = await attachBrowserProfileData(context, () => cutoff + 60 * 60_000);
  const search = () => data.search({ text: origin, startTime: 0 });
  assert.deepEqual(
    (await search()).items.map(({ url }) => url),
    [`${origin}/recent`, `${origin}/earlier`]
  );
  assert.deepEqual(
    await data.search({ text: origin, startTime: 0, suggestions: true }),
    await search()
  );
  await data.clear({ range: 'hour', categories: ['cache'] });
  assert.equal(await asset('earlier'), '1');
  assert.equal(await asset('recent'), '2');
  assert.equal((await search()).items.length, 2);
  assert.equal((await context.cookies(origin)).length, 2);

  const now = Date.now();
  const recorded: number[] = [];
  const maintenance = new BrowserCacheMaintenance({
    lastCleanupAt: now - 2 * 86_400_000,
    now: () => now,
    clear: () => data.clear({ range: 'all', categories: ['cache'] }),
    record: async (timestamp) => {
      recorded.push(timestamp);
    },
    failed: (error) => {
      throw error;
    }
  });
  try {
    assert.equal(maintenance.sync().cacheCleanupDays, 30);
    assert.equal(await asset('earlier'), '1');
    maintenance.sync({ revision: 1, cacheCleanupDays: 1 });
  } finally {
    await maintenance.close();
  }
  assert.deepEqual(recorded, [now]);
  assert.equal(await asset('earlier'), '2');
  assert.equal((await search()).items.length, 2);
  assert.equal((await context.cookies(origin)).length, 2);
  assert.equal(await page.locator('#draft').inputValue(), 'not reset by deletion');

  await data.clear({ range: 'hour', categories: ['history', 'site-data'] });
  assert.deepEqual(
    (await search()).items.map(({ url }) => url),
    [`${origin}/earlier`]
  );
  assert.deepEqual(
    (await context.cookies(origin)).map(({ name }) => name),
    ['earlier']
  );
  assert.equal(await page.locator('#draft').inputValue(), 'not reset by deletion');
  await data.deleteUrls([`${origin}/earlier`]);
  assert.deepEqual((await search()).items, []);
  await owned.close();
  assert.deepEqual(await readdir(runs), ['profile-data-extension']);
  console.log(
    'Browser data: loopback, native history and suggestions, cutoff, category selection and live page preservation passed.'
  );
} finally {
  try {
    await owned?.close();
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}
