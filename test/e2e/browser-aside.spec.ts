import { once } from 'node:events';
import { createSocket } from 'node:dgram';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { NodeConnector } from '../../mar-node/src/connector.js';
import { unavailableCapabilities } from '../../mar-node/src/capabilities.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';
import { BROWSER_VIEWPORT } from '../../mar-node/src/browser/browser-video-config.js';

test.use({
  viewport: { width: 1600, height: 900 },
  launchOptions: { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] }
});

test('Browser Aside projects real Node Chromium over ICE and Server relay', async ({
  page,
  baseURL,
  browserName
}, testInfo) => {
  test.skip(
    browserName !== 'chromium',
    'This journey verifies the Chromium H.264 and ICE implementation.'
  );
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'mar-browser-aside-'));
  const requests: string[] = [];
  const largeFile = Buffer.alloc(9 * 1024 * 1024 + 17, 0x61);
  let canceledRequests = 0;
  let failPage = true;
  let finishPage: (() => void) | undefined;
  const site = createServer((request, response) => {
    requests.push(request.url ?? '');
    if (request.url === '/retry-page' && failPage) {
      response.destroy();
      return;
    }
    if (request.url === '/loading-page') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.write('<title>Loading fixture</title><p>Loading fixture</p>');
      finishPage = () => response.end();
      return;
    }
    if (request.url?.startsWith('/files/')) {
      const file = request.url.split('/').at(-1)!;
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${file}"`,
        'content-length': largeFile.length
      });
      if (file === 'cancel.bin' || file === 'fail.bin') {
        response.write(largeFile.subarray(0, 128));
        if (file === 'cancel.bin') response.once('close', () => canceledRequests++);
        else {
          const timer = setTimeout(() => response.destroy(), 200);
          response.once('close', () => clearTimeout(timer));
        }
      } else response.end(largeFile);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html>
      <title>${request.url === '/relay' ? 'Relay fixture' : 'ICE fixture'}</title>
      <style>body{margin:0;background:${request.url === '/relay' ? 'rgb(200,0,0)' : request.url === '/ice' ? 'rgb(0,200,0)' : 'white'}}a{position:absolute;left:76%;top:20%;width:8%;height:10%;background:blue}</style>
      <a href="/clicked" aria-label="Click the Node page"></a>
      ${request.url === '/touch' ? `<input id="touch-field" style="position:absolute;left:24%;top:8%;width:18%;height:8%"><button id="touch-check" style="position:fixed;left:76%;top:8%;width:17%;height:8%">Check draft</button><div style="height:200vh"></div>` : ''}
      <label style="position:absolute;left:20%;top:20%;width:20%;height:10%;background:yellow">
        Choose file <input type="file" multiple hidden>
      </label>
      <div style="position:absolute;left:20%;top:40%;width:60%;display:flex">
        <a style="position:static;width:33%;background:orange" href="/files/${request.url === '/relay' ? 'relay' : 'ice'}.bin">Download</a>
        <a style="position:static;width:33%;background:lime" href="/files/cancel.bin">Slow</a>
        <a style="position:static;width:33%;background:pink" href="/files/fail.bin">Fail</a>
      </div>
      <script>
        if (location.pathname === '/touch') {
          const field = document.querySelector('#touch-field');
          document.addEventListener('scroll', () => fetch('/touch-scrolled'), { once: true });
          field.addEventListener('input', ({ target }) => fetch('/typed?text=' + encodeURIComponent(target.value)));
          document.querySelector('#touch-check').addEventListener('click', () => fetch('/draft?text=' + encodeURIComponent(field.value)));
        }
        document.addEventListener('mouseup', ({ clientX }) => {
          if (clientX > innerWidth * 0.7) fetch('/released');
        });
        document.addEventListener('keydown', ({ key, altKey, ctrlKey }) => {
          if ((altKey || ctrlKey) && key.toLowerCase() === 'w') fetch('/unexpected-close');
          if (key === 'ArrowRight') fetch('/key-next');
        });
        document.querySelector('input').addEventListener('change', async ({ target }) => {
          const file = target.files[0];
          if (file) fetch('/received?name=' + encodeURIComponent(file.name) + '&size=' + file.size + '&count=' + target.files.length + '&first=' + encodeURIComponent(await file.slice(0, 1).text()) + '&last=' + encodeURIComponent(await file.slice(-1).text()));
        });
      </script>`);
  });
  let connector: NodeConnector | undefined;
  let headers: { 'x-csrf-token': string } | undefined;
  const password = 'browser-aside-test-password-123';
  try {
    await writeFile(
      join(directory, 'workspace-preview.html'),
      '<title>Workspace preview fixture</title><h1>Workspace HTML</h1>'
    );
    site.listen(0, '127.0.0.1');
    await once(site, 'listening');
    const local = site.address();
    if (!local || typeof local === 'string') throw new Error('FIXTURE_ADDRESS');
    const origin = `http://127.0.0.1:${local.port}`;
    const login = await page.request.post('/api/auth/login', {
      data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(login.ok()).toBe(true);
    const changed = await page.request.post('/api/auth/change-password', {
      headers: { 'x-csrf-token': (await login.json()).csrfToken },
      data: { currentPassword: INITIAL_ADMIN_PASSWORD, password }
    });
    expect(changed.ok()).toBe(true);
    headers = { 'x-csrf-token': (await changed.json()).csrfToken };
    const token = await page.request.post('/api/node-registration-tokens', {
      headers,
      data: { displayName: 'Browser Aside test Node' }
    });
    expect(token.ok()).toBe(true);
    const serverUrl = new URL(baseURL!);
    serverUrl.port = process.env.MAR_E2E_SERVER_PORT ?? String(Number(serverUrl.port) + 1);
    const udp = createSocket('udp4');
    const listening = once(udp, 'listening');
    udp.bind(0, '0.0.0.0');
    await listening;
    const udpPort = udp.address().port;
    await new Promise<void>((resolve) => udp.close(resolve));
    connector = new NodeConnector({
      configPath: join(directory, 'node.json'),
      config: {
        serverUrl: serverUrl.origin,
        allowedRoots: [directory],
        registrationToken: (await token.json()).token,
        directTransfer: { udpPortRangeBegin: udpPort, udpPortRangeEnd: udpPort }
      },
      capabilityDetector: async () => unavailableCapabilities(),
      reconnect: false
    });
    await connector.start();
    let nodeId = '';
    await expect
      .poll(
        async () => {
          const { nodes } = (await (await page.request.get('/api/nodes')).json()) as {
            nodes: { id: string; connected: boolean; displayName: string }[];
          };
          nodeId =
            nodes.find((node) => node.connected && node.displayName === 'Browser Aside test Node')
              ?.id ?? '';
          return nodeId;
        },
        { timeout: 30_000 }
      )
      .not.toBe('');
    const registered = await page.request.post('/api/workspaces', {
      headers,
      data: { nodeId, path: directory }
    });
    expect(registered.ok(), await registered.text()).toBe(true);
    const workspaceId = (await registered.json()).workspace.id as string;
    const route = `/console?view=nodes&node=${encodeURIComponent(nodeId)}&workspace=${encodeURIComponent(workspaceId)}`;
    const browserTab = page.getByRole('tab', { name: /^(Browser|浏览器)$/u });
    const address = page.getByRole('textbox', { name: /^(Address|地址栏?)$/u });
    const canvas = page.locator('.node-browser canvas');
    async function openWorkspaceBrowser() {
      const opener = page.getByRole('button', {
        name: /^(Open a website in MAR|在 MAR 中打开网址)$/u
      });
      const noWorkspace = page.getByRole('heading', {
        name: /^(Select a workspace|选择一个工作区)$/iu
      });
      const expand = page.getByRole('button', { name: /^(Expand workspaces|展开工作区)$/iu });
      const workspace = page.getByRole('button', { name: basename(directory), exact: true });
      // On a cold start Workbench may show the picker instead of restoring the route.
      await expect
        .poll(
          async () =>
            (await browserTab.isVisible()) ||
            (await opener.isVisible()) ||
            ((await noWorkspace.isVisible()) &&
              ((await expand.isVisible()) || (await workspace.isVisible()))),
          { timeout: 15_000 }
        )
        .toBe(true);
      if (await noWorkspace.isVisible()) {
        if (await expand.isVisible()) await expand.click();
        await workspace.click();
      }
      if (!(await browserTab.isVisible())) await opener.click();
      await expect(browserTab).toBeVisible({ timeout: 25_000 });
      await browserTab.click();
    }

    // Observe ICE readiness without replacing either production transport.
    await page.addInitScript(() => {
      const Socket = window.WebSocket;
      window.WebSocket = class extends Socket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (new URL(url, location.href).pathname === '/api/workbench/live') {
            const drop = () => this.close(4001, 'test reconnect');
            window.addEventListener('test-drop-workbench', drop, { once: true });
            this.addEventListener('close', () =>
              window.removeEventListener('test-drop-workbench', drop)
            );
          }
        }
      };
      const createPeer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends createPeer {
        constructor(config?: RTCConfiguration) {
          super(config);
          this.addEventListener('connectionstatechange', () => {
            if (this.connectionState === 'connected')
              document.documentElement.dataset.iceConnected = 'true';
          });
        }
      };
    });
    await page.goto(route);
    await openWorkspaceBrowser();
    await page.waitForFunction(
      () => document.documentElement.dataset.iceConnected === 'true',
      undefined,
      { timeout: 15_000 }
    );
    await page.getByRole('checkbox', { name: /Keep this workspace|保留/u }).check();
    await page.getByRole('button', { name: /^(Open browser|打开浏览器)$/u }).click();
    await expect(page.getByText(/^(ICE direct|ICE 直连)$/u)).toBeVisible({ timeout: 15_000 });
    await address.fill(`127.0.0.1:${local.port}/ice`);
    await address.press('Enter');
    await expect(address).toHaveValue(`${origin}/ice`);
    await expect.poll(() => requests.includes('/ice')).toBe(true);
    await expect(canvas).toHaveAttribute('width', String(BROWSER_VIEWPORT.width));
    const navigation = page.getByRole('group', { name: /^(Page navigation|网页导航)$/u });
    await expect(navigation.getByRole('button')).toHaveCount(3);
    await address.fill(`${origin}/loading-page`);
    await address.press('Enter');
    const busy = page.getByRole('status', { name: /^(Loading page…|正在加载网页…)$/u });
    await expect(busy.locator('.mar-busy-indicator')).toBeVisible();
    await expect(
      navigation.getByRole('button', { name: /^(Stop loading|停止加载)$/u })
    ).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath('browser-loading.png'),
      animations: 'disabled'
    });
    finishPage?.();
    await expect(busy).toHaveCount(0);

    await address.fill(`${origin}/retry-page`);
    await address.press('Enter');
    await expect(
      page.getByRole('heading', { name: /^(This page can’t be reached|无法访问此网页)$/u })
    ).toBeVisible();
    await expect(canvas).toBeHidden();
    await page.screenshot({
      path: testInfo.outputPath('browser-navigation-failed.png'),
      animations: 'disabled'
    });
    await address.fill(`${origin}/unsubmitted`);
    const attempts = requests.filter((path) => path === '/retry-page').length;
    failPage = false;
    await page.getByRole('button', { name: /^(Try again|重试)$/u }).click();
    await expect
      .poll(() => requests.filter((path) => path === '/retry-page').length)
      .toBeGreaterThan(attempts);
    await expect(address).toHaveValue(`${origin}/retry-page`);
    await expect(canvas).toBeVisible();
    expect(requests).not.toContain('/unsubmitted');
    await address.fill(`${origin}/ice`);
    await address.press('Enter');
    await expect(address).toHaveValue(`${origin}/ice`);
    async function canvasPoint(x: number, y: number) {
      const box = (await canvas.boundingBox())!;
      const scale = Math.min(
        box.width / BROWSER_VIEWPORT.width,
        box.height / BROWSER_VIEWPORT.height
      );
      const width = BROWSER_VIEWPORT.width * scale;
      const height = BROWSER_VIEWPORT.height * scale;
      expect(Math.abs(box.width / box.height - width / height)).toBeGreaterThan(0.1);
      return {
        x: box.x + (box.width - width) / 2 + width * x,
        y: box.y + (box.height - height) / 2 + height * y
      };
    }
    async function upload(label: string) {
      // The address snapshot can arrive before the first frame of the new view.
      await expect
        .poll(() =>
          canvas.evaluate((element, red) => {
            const pixel = (element as HTMLCanvasElement)
              .getContext('2d')
              ?.getImageData(5, 5, 1, 1).data;
            return (
              !!pixel &&
              (red ? pixel[0]! > 150 && pixel[1]! < 50 : pixel[1]! > 150 && pixel[0]! < 50)
            );
          }, label === 'relay')
        )
        .toBe(true);
      const target = await canvasPoint(0.3, 0.25);
      await page.mouse.click(target.x, target.y);
      const dialog = page.getByRole('dialog', {
        name: /^(Choose files for this page|为当前网页选择文件)$/u
      });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: /^(Cancel|取消)$/u }).click();
      await expect(dialog).toBeHidden();
      await page.mouse.click(target.x, target.y);
      await expect(dialog).toBeVisible();
      const largePath = join(directory, `${label}.txt`);
      await writeFile(largePath, largeFile);
      const paths = [largePath];
      for (let index = 0; index < 16; index++) {
        const path = join(directory, `additional-${index}.txt`);
        await writeFile(path, 'other');
        paths.push(path);
      }
      await dialog.locator('input[type=file]').setInputFiles(paths);
      await expect
        .poll(
          () =>
            requests.includes(
              `/received?name=${label}.txt&size=${largeFile.length}&count=17&first=a&last=a`
            ),
          { timeout: 30_000 }
        )
        .toBe(true);
    }
    async function download(action: 'saved' | 'cancel' | 'fail', route: 'ice' | 'relay') {
      const target = await canvasPoint({ saved: 0.3, cancel: 0.5, fail: 0.7 }[action], 0.415);
      const request = page.request;
      await page.mouse.click(target.x, target.y);
      await page.getByRole('button', { name: /^(Browser commands|浏览器命令)$/u }).click();
      await page.getByRole('menuitem', { name: /^(Downloads|下载)$/u }).click();
      const dialog = page.getByRole('dialog', { name: /^(Downloads|下载)$/u });
      const name = `${action === 'saved' ? route : action}.bin`;
      const row = dialog.getByRole('listitem').filter({ hasText: name });
      if (action === 'saved') {
        const save = row.getByRole('link', { name: /^(Save to device|保存到本机)$/u });
        await expect(save).toBeVisible();
        const href = (await save.getAttribute('href'))!;
        const mismatched = new URL(href, page.url());
        mismatched.searchParams.set('attachmentId', '12345678-1234-4234-8234-123456789012');
        expect((await request.get(mismatched.href)).status()).toBe(403);
        const pending = page.waitForEvent('download');
        await save.click();
        const file = await pending;
        expect(file.suggestedFilename()).toBe(name);
        expect((await readFile((await file.path())!)).equals(largeFile)).toBe(true);
        if (route === 'relay') {
          await page.keyboard.press('Escape');
          await expect(dialog).toBeHidden();
          const url = new URL(href, serverUrl);
          const cookie = (await page.context().cookies(url.href))
            .map(({ name, value }) => `${name}=${value}`)
            .join('; ');
          const stream = get(url, { headers: { cookie } });
          try {
            const [response] = await once(stream, 'response');
            expect(response.statusCode).toBe(200);
            const [first] = await once(response, 'data');
            response.pause();
            const aside = page.locator('.workspace-aside');
            await aside
              .getByRole('button', { name: /^(Close Browser|关闭\s*浏览器)$/u })
              .first()
              .click();
            const listing = new URL(href, page.url());
            listing.pathname = '/api/browser/downloads';
            listing.searchParams.delete('id');
            listing.searchParams.set('offset', '0');
            await expect
              .poll(async () => (await page.request.get(listing.href)).status())
              .toBe(403);
            expect(response.complete).toBe(false);
            let offset = first.length;
            expect(first.equals(largeFile.subarray(0, offset))).toBe(true);
            for await (const bytes of response) {
              expect(bytes.equals(largeFile.subarray(offset, offset + bytes.length))).toBe(true);
              offset += bytes.length;
            }
            expect(offset).toBe(largeFile.length);
          } finally {
            stream.destroy();
          }
          await openWorkspaceBrowser();
          await expect(page.getByText(/^(Server relay|Server 中继|服务器中继)$/u)).toBeVisible();
          return;
        }
      } else if (action === 'cancel') {
        const previous = canceledRequests;
        await row.getByRole('button', { name: /^(Cancel|取消)$/u }).click();
        await expect(row.getByText(/^(Canceled|已取消)$/u)).toBeVisible();
        await expect.poll(() => canceledRequests).toBeGreaterThan(previous);
      } else await expect(row.getByText(/^(Failed|失败)$/u)).toBeVisible({ timeout: 20_000 });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
    await upload('ice');
    await download('saved', 'ice');
    await download('cancel', 'ice');
    const target = await canvasPoint(0.8, 0.25);
    await page.mouse.move(target.x, target.y);
    await page.mouse.down();
    await canvas.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', button: -1 });
    await expect.poll(() => requests.includes('/released')).toBe(true);
    await page.mouse.up();
    await page.mouse.click(target.x, target.y);
    await expect.poll(() => requests.includes('/clicked')).toBe(true);
    await expect(address).toHaveValue(`${origin}/clicked`);

    // Suppress negotiation in the client, rather than simulating a relay socket.
    await page.addInitScript(() => {
      window.RTCPeerConnection = class extends window.RTCPeerConnection {
        constructor() {
          throw new Error('TEST_ICE_UNAVAILABLE');
        }
      };
    });
    await page.reload();
    await openWorkspaceBrowser();
    await expect(page.getByText(/^(Server relay|Server 中继|服务器中继)$/u)).toBeVisible({
      timeout: 15_000
    });
    await expect(address).toHaveValue(`${origin}/clicked`);
    await address.fill(`${origin}/relay`);
    await address.press('Enter');
    await expect.poll(() => requests.includes('/relay')).toBe(true);
    await expect(address).toHaveValue(`${origin}/relay`);
    await upload('relay');
    await download('saved', 'relay');
    await download('fail', 'relay');
    for (let attempt = 0; attempt < 2; attempt++) {
      const freshRelay = page.waitForEvent(
        'websocket',
        (socket) => new URL(socket.url()).pathname === '/api/browser/relay'
      );
      await page.evaluate(() => window.dispatchEvent(new Event('test-drop-workbench')));
      await freshRelay;
      await expect(page.getByText(/^(Server relay|Server 中继)$/u)).toBeVisible({
        timeout: 15_000
      });
      await expect(address).toHaveValue(`${origin}/relay`);
    }

    const commands = page.getByRole('button', { name: /^(Browser commands|浏览器命令)$/u });
    await expect(commands).toBeEnabled();
    await commands.click();
    const browserMenu = page.getByRole('menu', { name: /^(Browser commands|浏览器命令)$/u });
    await expect(browserMenu.getByRole('menuitem').locator('svg')).toHaveCount(6);
    await page.screenshot({
      path: testInfo.outputPath('browser-toolbar-menu.png'),
      animations: 'disabled'
    });
    await page.getByRole('menuitem', { name: /^(Clear browser cache|清理浏览器缓存)$/u }).click();
    const clear = page.getByRole('dialog', { name: /^(Clear browsing data|清除浏览数据)$/u });
    await expect(
      clear.getByRole('checkbox', { name: /^(Cached images and files|缓存的图片和文件)$/u })
    ).toBeChecked();
    await expect(
      clear.getByRole('checkbox', { name: /^(Browsing history|浏览历史)$/u })
    ).not.toBeChecked();
    await page.screenshot({
      path: testInfo.outputPath('browser-clear-data.png'),
      animations: 'disabled'
    });
    await clear.getByRole('button', { name: /^(Clear browsing data|清除浏览数据)$/u }).click();
    await expect(clear).toBeHidden();
    await expect(address).toHaveValue(`${origin}/relay`);

    await commands.click();
    await page.getByRole('menuitem', { name: /^(Browsing history|浏览历史)$/u }).click();
    const historyDialog = page.getByRole('dialog', { name: /^(Browsing history|浏览历史)$/u });
    const history = historyDialog.getByRole('button', { name: /Relay fixture/u });
    await expect(history).toBeVisible();
    await expect(history).toContainText(`${origin}/relay`);
    await expect(historyDialog.getByText('false', { exact: true })).toHaveCount(0);
    await expect(canvas).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('browser-history.png'),
      animations: 'disabled'
    });
    await history
      .locator('..')
      .getByRole('button', { name: /^(Delete|删除)$/u })
      .click();
    const confirmation = page.getByRole('dialog', {
      name: /^(Delete browsing history|删除浏览历史)$/u
    });
    await confirmation.getByRole('button', { name: /^(Delete|删除)$/u }).click();
    await expect(confirmation).toBeHidden();
    await expect(history).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(historyDialog).toBeHidden();
    await expect(address).toHaveValue(`${origin}/relay`);
    await commands.click();
    await page.getByRole('menuitem', { name: /^(Browser settings|浏览器设置)$/u }).click();
    await expect(
      page.getByRole('heading', { name: /^(Browser settings|浏览器设置)$/u })
    ).toBeVisible();
    await expect(page.getByRole('combobox', { name: /^(Web links|网页链接)$/u })).toBeVisible();
    await expect(page.getByRole('button', { name: /Back to browser|返回浏览器/u })).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath('browser-personal-settings.png'),
      animations: 'disabled'
    });
    await page.getByRole('button', { name: /^(Work|工作)$/u }).click();
    await expect(address).toHaveValue(`${origin}/relay`);

    const keyboard = page.locator('[data-node-browser-input]');
    await keyboard.focus();
    await keyboard.press('Alt+Shift+w');
    await expect(browserTab).toBeVisible();
    await keyboard.press('ArrowRight');
    await expect.poll(() => requests.filter((path) => path === '/key-next').length).toBe(1);
    await keyboard.press('Alt+w');
    await expect(browserTab).toHaveCount(0);
    await openWorkspaceBrowser();
    await expect(address).toHaveValue(`${origin}/relay`);
    await keyboard.focus();
    await keyboard.press('ArrowRight');
    await expect.poll(() => requests.filter((path) => path === '/key-next').length).toBe(2);
    expect(requests).not.toContain('/unexpected-close');

    const aside = page.locator('.workspace-aside');
    await aside.getByRole('tab', { name: /^(Files|文件)$/u }).click();
    await aside
      .getByRole('treeitem', { name: 'workspace-preview.html' })
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^(Preview|预览)$/u }).click();
    await expect(aside.getByRole('tab', { name: 'Workspace preview fixture' })).toBeVisible();
    await expect(aside.locator('iframe')).toHaveCount(0);
    const touch = await page.context().newCDPSession(page);
    await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await page.setViewportSize({ width: 390, height: 750 });
    await openWorkspaceBrowser();
    await address.fill(`${origin}/touch`);
    await address.press('Enter');
    await expect(address).toHaveValue(`${origin}/touch`);
    await expect.poll(() => requests.includes('/touch')).toBe(true);
    const touchInput = page.getByRole('button', { name: /^(Show keyboard|显示键盘)$/u });
    await expect(touchInput).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('browser-toolbar-mobile.png'),
      animations: 'disabled'
    });
    const field = await canvasPoint(0.32, 0.12);
    const touchAt = (
      type: 'touchStart' | 'touchMove' | 'touchEnd',
      point?: { x: number; y: number }
    ) => touch.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [point] : [] });
    await touchAt('touchStart', field);
    await touchAt('touchEnd');
    await touchInput.click();
    await expect(page.locator('[data-node-browser-input]')).toBeFocused();
    await page.keyboard.insertText('你好');
    await expect
      .poll(() => requests.includes(`/typed?text=${encodeURIComponent('你好')}`))
      .toBe(true);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.keyboard.press('Control+a');
    await page.getByRole('button', { name: /^(Browser commands|浏览器命令)$/u }).click();
    await page.getByRole('menuitem', { name: /^(Copy selected text|复制网页所选文本)$/u }).click();
    await expect(page.getByText(/^(Text copied|已复制文本)$/u)).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('你好');
    await touchInput.click();
    await page.evaluate(() => navigator.clipboard.writeText('已粘贴'));
    await page.keyboard.press('Control+v');
    await expect
      .poll(() => requests.includes(`/typed?text=${encodeURIComponent('已粘贴')}`))
      .toBe(true);
    await page.getByRole('button', { name: /^(Hide keyboard|收起键盘)$/u }).click();
    await expect(page.locator('[data-node-browser-input]')).not.toBeFocused();
    await touchAt('touchStart', await canvasPoint(0.6, 0.82));
    await touchAt('touchMove', await canvasPoint(0.6, 0.55));
    await touchAt('touchEnd');
    await expect.poll(() => requests.includes('/touch-scrolled')).toBe(true);

    const draftRequest = `/draft?text=${encodeURIComponent('已粘贴')}`;
    async function tapDraftCheck(): Promise<void> {
      await touchAt('touchStart', await canvasPoint(0.845, 0.12));
      await touchAt('touchEnd');
    }
    const beforeRotation = (await canvas.boundingBox())!;
    await page.setViewportSize({ width: 750, height: 390 });
    await expect
      .poll(async () => (await canvas.boundingBox())?.width ?? 0)
      .toBeGreaterThan(beforeRotation.width);
    await tapDraftCheck();
    await expect.poll(() => requests.filter((path) => path === draftRequest).length).toBe(1);
    const workspaceURL = page.url();
    await page.goBack();
    await expect(aside).toBeHidden();
    await expect(page).toHaveURL(workspaceURL);
    await openWorkspaceBrowser();
    await expect(address).toHaveValue(`${origin}/touch`);
    await expect(canvas).toBeVisible();
    await tapDraftCheck();
    await expect.poll(() => requests.filter((path) => path === draftRequest).length).toBe(2);

    await touchInput.click();
    const remoteInput = page.locator('[data-node-browser-input]');
    await expect(remoteInput).toBeFocused();
    await page.keyboard.down('Escape');
    await expect(remoteInput).not.toBeFocused();
    await expect(canvas).toBeVisible();
    await page.keyboard.down('Escape');
    await page.keyboard.up('Escape');
    await expect(canvas).toBeVisible();
    await tapDraftCheck();
    await expect.poll(() => requests.filter((path) => path === draftRequest).length).toBe(3);
    await page.keyboard.press('Escape');
    await expect(aside).toBeHidden();
    await expect(page).toHaveURL(workspaceURL);
    expect(requests.filter((path) => path === '/touch')).toHaveLength(1);

    await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await touch.detach();
    await page.setViewportSize({ width: 1600, height: 900 });
    await openWorkspaceBrowser();
    await expect(address).toHaveValue(`${origin}/touch`);
    const runs = join(directory, 'browser', 'runs');
    const runningBrowsers = async () =>
      (await readdir(runs)).filter((name) => name.startsWith('browser-'));
    expect(await runningBrowsers()).toHaveLength(1);
    await page.getByRole('button', { name: /^(Browser commands|浏览器命令)$/u }).click();
    await page.getByRole('menuitem', { name: /^(Close browser|关闭浏览器)$/u }).click();
    await expect.poll(runningBrowsers).toEqual([]);
  } finally {
    try {
      await connector?.stop();
      if (headers) {
        await page.request.post('/api/auth/change-password', {
          headers,
          data: { currentPassword: password, password: INITIAL_ADMIN_PASSWORD }
        });
      }
    } finally {
      site.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
