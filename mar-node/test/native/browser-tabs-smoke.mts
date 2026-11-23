import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { BrowserTabs } from '../../src/browser/browser-tabs.js';

const requests: string[] = [];
const server = createServer((request, response) => {
  const path = request.url ?? '/';
  requests.push(path);
  if (path === '/redirect') {
    response.writeHead(302, { Location: '/start' }).end();
    return;
  }
  if (path === '/stall') return;
  response.writeHead(200, { 'Content-Type': 'text/html' }).end(`
    <a href="/popup" target="_blank" rel="opener">Open popup</a>
    <button onclick="history.pushState({}, '', '#chapter')">Add history</button>
    <input aria-label="Message" />
  `);
}).listen(0, '127.0.0.1');
try {
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    chromiumSandbox: true
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: unknown[] = [];
    let changed = 0;
    const tabs = new BrowserTabs(context, {
      limit: 2,
      changed: () => changed++,
      failed: (error) => errors.push(error)
    });
    assert.equal(changed, 0);
    const { activeId } = tabs.snapshot();
    const view = tabs.activeView;
    assert(view && activeId);
    await view.navigate(`${base}/redirect`);
    assert.equal(tabs.snapshot().tabs[0]?.url, `${base}/start`);
    await page.getByRole('button', { name: 'Add history' }).click();
    assert.equal((await view.history()).canGoBack, true);
    await view.travel(-1);
    await page.waitForURL(`${base}/start`);
    assert.equal((await view.history()).canGoForward, true);
    await view.travel(1);
    await page.waitForURL(`${base}/start#chapter`);
    const openings = requests.filter((request) => request === '/start').length;
    await view.reload();
    assert.equal(requests.filter((request) => request === '/start').length, openings + 1);
    const message = page.getByRole('textbox', { name: 'Message' });
    await message.focus();
    await view.input({ type: 'text', text: '你好', viewVersion: 1 });
    assert.equal(await message.inputValue(), '你好');
    await view.input({ type: 'key', edge: 'down', key: 'Backspace', viewVersion: 1 });
    await view.input({ type: 'key', edge: 'up', key: 'Backspace', viewVersion: 1 });
    assert.equal(await message.inputValue(), '你');

    const request = page.waitForRequest(`${base}/stall`);
    const navigation = assert.rejects(view.navigate(`${base}/stall`), /ERR_ABORTED/);
    await request;
    await view.stopLoading();
    await navigation;

    const popupEvent = page.waitForEvent('popup');
    await page.getByRole('link', { name: 'Open popup' }).click();
    const popup = await popupEvent;
    assert.equal(await popup.opener(), page);
    const popupId = tabs.snapshot().activeId;
    assert(popupId && popupId !== activeId);
    assert.equal(tabs.snapshot().tabs[1]?.url, `${base}/popup`);
    await assert.rejects(tabs.open(), /BROWSER_TAB_LIMIT/);
    tabs.select(activeId);
    assert.equal(tabs.activeView, view);
    await tabs.close(popupId);
    await tabs.close(activeId);
    const replacement = tabs.snapshot();
    assert.equal(replacement.tabs.length, 1);
    assert.notEqual(replacement.activeId, activeId);
    assert.equal(replacement.tabs[0]?.url, 'about:blank');
    assert(changed > 2);
    assert.deepEqual(errors, []);
    console.log('Browser tab and navigation smoke passed.');
  } finally {
    await browser.close();
  }
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
