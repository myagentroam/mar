import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { BrowserTabs } from '../../src/browser/browser-tabs.js';

const requests: string[] = [];
const workspace = await mkdtemp(join(tmpdir(), 'mar-browser-html-'));
const server = createServer((request, response) => {
  const path = request.url ?? '/';
  requests.push(path);
  if (path === '/redirect') {
    response.writeHead(302, { Location: '/start' }).end();
    return;
  }
  if (path === '/redirect-to-error') {
    response.writeHead(302, { Location: '/network-error' }).end();
    return;
  }
  if (path === '/network-error') {
    response.destroy();
    return;
  }
  if (path === '/stall') return;
  response.writeHead(200, { 'Content-Type': 'text/html' }).end(`
    <a href="/popup" target="_blank" rel="opener">Open popup</a>
    <button onclick="history.pushState({}, '', '#chapter')">Add history</button>
    <button onclick="window.close()">Close window</button>
    <input aria-label="Message" />
  `);
}).listen(0, '127.0.0.1');
try {
  await once(server, 'listening');
  await mkdir(join(workspace, 'site'));
  await writeFile(
    join(workspace, 'site/index.html'),
    '<title>Workspace HTML</title><a href="next.htm">Relative page</a><script src="code.js"></script>'
  );
  await writeFile(join(workspace, 'site/code.js'), 'document.body.dataset.script = "loaded"');
  await writeFile(join(workspace, 'site/next.htm'), '<h1>Relative page loaded</h1>');
  await writeFile(join(workspace, 'outside.txt'), 'outside the preview directory');
  if (process.platform !== 'win32')
    await symlink('../outside.txt', join(workspace, 'site/escape.txt'));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
    chromiumSandbox: false
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: unknown[] = [];
    let changed = 0;
    const tabs = new BrowserTabs(context, {
      directory: workspace,
      limit: 2,
      workspacePath: () => workspace,
      failed: (error) => errors.push(error)
    });
    tabs.observe(() => changed++);
    assert.equal(changed, 0);
    const { activeId } = tabs.snapshot();
    const view = tabs.activeView;
    assert(view && activeId);
    await view.navigate(`${base}/redirect`);
    assert.equal(tabs.snapshot().tabs[0]?.url, `${base}/start`);
    await page.getByRole('button', { name: 'Add history' }).click();
    assert.equal((await view.history())?.canGoBack, true);
    await view.travel(-1);
    await page.waitForURL(`${base}/start`);
    assert.equal((await view.history())?.canGoForward, true);
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

    const urls: string[] = [];
    const errorShown = new EventEmitter();
    const stopWatching = tabs.observe(() => {
      const url = tabs.snapshot().tabs[0]?.url ?? '';
      urls.push(url);
      if (url === `${base}/network-error`) errorShown.emit('projected');
    });
    try {
      await assert.rejects(view.navigate(`${base}/redirect-to-error`), /BROWSER_NAVIGATION_FAILED/);
      await page.waitForURL('chrome-error://chromewebdata/');
      if (tabs.snapshot().tabs[0]?.url !== `${base}/network-error`)
        await once(errorShown, 'projected', { signal: AbortSignal.timeout(3_000) });
      assert(!urls.some((url) => url.startsWith('chrome-error:')));
      assert.equal(tabs.snapshot().tabs[0]?.url, `${base}/network-error`);
      await view.travel(-1);
      await page.waitForURL(`${base}/start#chapter`);
    } finally {
      stopWatching();
    }

    const blocked = `${base}/blocked`;
    await context.route(blocked, (route) => route.abort());
    await assert.rejects(tabs.open(blocked), /^Error: BROWSER_NAVIGATION_FAILED$/u);
    await assert.rejects(tabs.open('ftp://localhost'), /BROWSER_INVALID_ADDRESS/);
    assert.equal(tabs.snapshot().activeId, activeId);
    assert.equal(tabs.snapshot().tabs.length, 1);

    const viewer = {};
    await tabs.attach(viewer);
    const presented =
      Promise.withResolvers<NonNullable<ReturnType<typeof tabs.snapshot>['dialog']>>();
    const unobserve = tabs.observe(() => {
      const dialog = tabs.snapshot().dialog;
      if (dialog) presented.resolve(dialog);
    });
    const prompting = page.evaluate(() => window.prompt('Remote prompt', 'initial'));
    const dialog = await presented.promise;
    assert.equal(dialog.message, 'Remote prompt');
    await tabs.respondToDialog(crypto.randomUUID(), true, 'old response');
    assert.equal(tabs.snapshot().dialog?.id, dialog.id);
    await tabs.respondToDialog(dialog.id, true, 'remote response');
    assert.equal(await prompting, 'remote response');
    unobserve();
    await tabs.detach(viewer);
    assert.equal(await page.evaluate(() => window.confirm('Background prompt')), false);

    const request = page.waitForRequest(`${base}/stall`);
    const requestFailed = page.waitForEvent(
      'requestfailed',
      (request) => request.url() === `${base}/stall`
    );
    const navigation = assert.rejects(
      view.navigate(`${base}/stall`),
      /BROWSER_NAVIGATION_ABORTED/u
    );
    await request;
    const loadingVersion = tabs.snapshot().viewVersion;
    tabs.resize({ width: 391, height: 701 });
    assert.notEqual(tabs.snapshot().viewVersion, loadingVersion);
    await tabs.stopLoading(loadingVersion);
    await navigation;
    assert.match((await requestFailed).failure()?.errorText ?? '', /ERR_ABORTED/u);

    const popupEvent = page.waitForEvent('popup');
    await page.getByRole('link', { name: 'Open popup' }).click();
    const popup = await popupEvent;
    assert.equal(await popup.opener(), page);
    const popupId = tabs.snapshot().activeId;
    assert(popupId && popupId !== activeId);
    assert.equal(tabs.navigationView(loadingVersion), undefined);
    assert.equal(tabs.snapshot().tabs[1]?.url, `${base}/popup`);
    await assert.rejects(tabs.open(), /BROWSER_TAB_LIMIT/);
    tabs.select(activeId);
    assert.equal(tabs.activeView, view);
    await page
      .locator('body')
      .evaluate((body) => body.insertAdjacentHTML('beforeend', '<input type="file">'));
    await popup
      .locator('body')
      .evaluate((body) => body.insertAdjacentHTML('beforeend', '<input type="file">'));
    const fileInput = page.locator('input[type=file]');
    await tabs.attach(viewer);
    await Promise.all([
      popup.waitForEvent('filechooser'),
      popup.locator('input[type=file]').click()
    ]);
    assert.equal(tabs.snapshot().fileChooser, undefined);
    const choose = async () => {
      await Promise.all([page.waitForEvent('filechooser'), fileInput.click()]);
      const chooser = tabs.snapshot().fileChooser;
      assert(chooser);
      return { attachmentId: crypto.randomUUID(), chooserId: chooser.id };
    };
    async function stage(selection: Awaited<ReturnType<typeof choose>>) {
      const transferId = crypto.randomUUID();
      await tabs.upload({ ...selection, command: { action: 'begin', transferId } });
      await tabs.upload({
        ...selection,
        command: { action: 'file', transferId, index: 0, name: 'stale.txt', size: 2 }
      });
      await tabs.upload({
        ...selection,
        command: { action: 'chunk', transferId, index: 0, offset: 0, data: 'b2s=' }
      });
      return { ...selection, command: { action: 'finish' as const, transferId } };
    }
    const uploadDirectories = async () =>
      (await readdir(workspace)).filter((name) => name.startsWith('upload-'));
    const canceled = await choose();
    await tabs.upload({ ...canceled, command: { action: 'cancel' } });
    assert.equal(tabs.snapshot().fileChooser, undefined);
    const replaced = await stage(await choose());
    tabs.select(popupId);
    await assert.rejects(tabs.upload(replaced), /BROWSER_FILE_CHOOSER_ENDED/);
    const otherViewer = {};
    await tabs.attach(otherViewer);
    assert.deepEqual(await uploadDirectories(), []);
    assert.equal(await fileInput.evaluate((input: HTMLInputElement) => input.files?.length), 0);
    assert.equal(
      await popup
        .locator('input[type=file]')
        .evaluate((input: HTMLInputElement) => input.files?.length),
      0
    );
    tabs.select(activeId);
    const detached = await stage(await choose());
    await tabs.detach(viewer);
    assert.equal(tabs.snapshot().fileChooser?.id, detached.chooserId);
    const closing = tabs.detach(otherViewer);
    await assert.rejects(tabs.upload(detached), /BROWSER_FILE_CHOOSER_ENDED/);
    await closing;
    assert.deepEqual(await uploadDirectories(), []);
    await tabs.attach(viewer);
    const selection = await choose();
    const oldTransfer = crypto.randomUUID();
    const transferId = crypto.randomUUID();
    await tabs.upload({ ...selection, command: { action: 'begin', transferId: oldTransfer } });
    await tabs.upload({ ...selection, command: { action: 'begin', transferId } });
    await tabs.upload({
      ...selection,
      command: { action: 'file', transferId, index: 0, name: 'smoke.txt', size: 2 }
    });
    await assert.rejects(
      tabs.upload({
        ...selection,
        command: {
          action: 'chunk',
          transferId: oldTransfer,
          index: 0,
          offset: 0,
          data: 'bm8='
        }
      }),
      /BROWSER_UPLOAD_INVALID/
    );
    await tabs.upload({
      ...selection,
      command: { action: 'chunk', transferId, index: 0, offset: 0, data: 'b2s=' }
    });
    await tabs.upload({ ...selection, command: { action: 'finish', transferId } });
    assert.equal(
      await fileInput.evaluate((input: HTMLInputElement) => input.files?.[0]?.text()),
      'ok'
    );
    await tabs.close(popupId);
    await tabs.openHtml('site/index.html');
    const html = context.pages().at(-1)!;
    await html.waitForFunction(() => document.body.dataset.script === 'loaded');
    if (process.platform !== 'win32')
      assert.equal(await html.evaluate(async () => (await fetch('escape.txt')).status), 404);
    await html.getByRole('link', { name: 'Relative page' }).click();
    await html.getByRole('heading', { name: 'Relative page loaded' }).waitFor();
    const address = html.url();
    await tabs.detach(viewer);
    assert.equal((await html.goto(address))?.status(), 403);
    await tabs.attach(viewer);
    assert.equal((await html.goto(address))?.status(), 200);
    await tabs.close(tabs.snapshot().activeId!);
    await assert.rejects(tabs.openHtml('site/missing.html'), /BROWSER_HTML_UNAVAILABLE/);
    assert.equal(tabs.snapshot().activeId, activeId);
    await tabs.close(activeId);
    const replacement = tabs.snapshot();
    assert.equal(replacement.tabs.length, 1);
    assert.notEqual(replacement.activeId, activeId);
    assert.equal(replacement.tabs[0]?.url, 'about:blank');

    const blank = context.pages()[0]!;
    await blank.goto(`${base}/start`);
    const lastPopupEvent = blank.waitForEvent('popup');
    await blank.getByRole('link', { name: 'Open popup' }).click();
    const lastPopup = await lastPopupEvent;
    await tabs.close(replacement.activeId!);
    const nextBlankEvent = context.waitForEvent('page', { timeout: 3_000 });
    await lastPopup.getByRole('button', { name: 'Close window' }).click();
    const nextBlank = await nextBlankEvent;
    assert.equal(nextBlank.url(), 'about:blank');
    assert.deepEqual(
      tabs.snapshot().tabs.map(({ url }) => url),
      ['about:blank']
    );
    assert.equal(tabs.tabControls().reopen, true);
    await tabs.reopen();
    assert.equal(
      tabs.snapshot().tabs.find(({ id }) => id === tabs.snapshot().activeId)?.url,
      `${base}/start`
    );
    const reopened = context.pages().at(-1)!;
    const zoom = () => reopened.locator('html').evaluate((root) => getComputedStyle(root).zoom);
    const viewport = () => reopened.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
    const before = await viewport();
    await tabs.zoom(tabs.snapshot().viewVersion, 'in');
    assert.equal(tabs.tabControls().zoom, 110);
    assert.equal(await zoom(), '1.1');
    assert.deepEqual(await viewport(), before);
    await reopened.goto(`${base}/popup`);
    assert.equal(await zoom(), '1.1');
    await tabs.zoom(tabs.snapshot().viewVersion, 'reset');
    assert.equal(await zoom(), '1');
    await assert.rejects(tabs.restore([`${base}/start`]), /BROWSER_RESTORE_NOT_BLANK/);
    await tabs.close(tabs.snapshot().activeId!);
    await tabs.restore([`${base}/start`, `${base}/popup`]);
    assert.deepEqual(
      tabs.snapshot().tabs.map(({ url }) => url),
      [`${base}/start`, `${base}/popup`]
    );
    assert.equal(tabs.snapshot().tabs.at(-1)?.id, tabs.snapshot().activeId);
    for (const { id } of tabs.snapshot().tabs) await tabs.close(id);
    await assert.rejects(
      tabs.restore([`${base}/start`, `${base}/network-error`, `${base}/popup`]),
      /BROWSER_TAB_RESTORE_INCOMPLETE/
    );
    assert.deepEqual(
      tabs.snapshot().tabs.map(({ url }) => url),
      [`${base}/start`, `${base}/popup`]
    );
    assert.equal(tabs.snapshot().tabs.at(-1)?.id, tabs.snapshot().activeId);
    await context.close();
    assert.deepEqual(tabs.snapshot().tabs, []);
    assert(changed > 2);
    assert.deepEqual(errors, []);
    console.log('Browser tab and navigation smoke passed.');
  } finally {
    await browser.close();
  }
} finally {
  await rm(workspace, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
