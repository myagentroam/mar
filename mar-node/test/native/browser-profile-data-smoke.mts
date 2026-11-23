import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { attachBrowserProfileData } from '../../src/browser/browser-profile-data.js';
import { createBrowserLauncher } from '../../src/browser/browser-launcher.js';
import { BROWSER_VIEWPORT } from '../../src/browser/browser-video-config.js';

// Local trusted fixtures only. This proves native semantics, not deployment isolation.
const root = await mkdtemp(join(tmpdir(), 'mar-browser-profile-data-'));
const runs = join(root, 'runs');
const launch = createBrowserLauncher(runs, (error) => {
  throw error;
});
const hits = new Map<string, number>();
const server = createServer((request, response) => {
  const path = request.url ?? '/';
  if (path.startsWith('/asset/')) {
    const count = (hits.get(path) ?? 0) + 1;
    hits.set(path, count);
    response.writeHead(200, { 'cache-control': 'public, max-age=3600' }).end(String(count));
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  const title = request.url === '/earlier' ? 'Earlier' : 'Recent';
  response.end(`<!doctype html><title>${title}</title><input id="draft">`);
});
let owned: Awaited<ReturnType<typeof launch>> | undefined;
try {
  await writeFile(runs, 'temporarily block the run directory');
  await assert.rejects(launch(join(root, 'profile')));
  await rm(runs);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bound = server.address();
  assert(bound && typeof bound !== 'string');
  const origin = `http://127.0.0.1:${bound.port}`;
  owned = await launch(join(root, 'profile'));
  const { context } = owned;
  const page = context.pages()[0]!;
  assert.deepEqual(page.viewportSize(), BROWSER_VIEWPORT);
  await page.goto(`${origin}/earlier`);
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
  await data.clear({ range: 'hour', categories: ['cache'] });
  assert.equal(await asset('earlier'), '1');
  assert.equal(await asset('recent'), '2');
  assert.equal((await search()).items.length, 2);
  assert.equal((await context.cookies(origin)).length, 2);
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
  console.log(
    'Browser data: loopback, native history, cutoff, category selection and live page preservation passed.'
  );
} finally {
  try {
    await owned?.close();
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}
