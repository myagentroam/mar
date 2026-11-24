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
  let remoteViewport: { width: number; height: number; narrow: boolean } | undefined;
  const largeFile = Buffer.alloc(9 * 1024 * 1024 + 17, 0x61);
  const longTabTitle = 'ICE fixture — A long webpage title showing how the browser tab fades';
  const favicon = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP47NtIEmIY1TCqYfhqAAAlYMEQZSHRQgAAAABJRU5ErkJggg==',
    'base64'
  );
  let canceledRequests = 0;
  let failPage = true;
  let finishPage: (() => void) | undefined;
  const site = createServer((request, response) => {
    requests.push(request.url ?? '');
    if (request.url === '/site-icon.png') {
      response.writeHead(200, { 'content-type': 'image/png' }).end(favicon);
      return;
    }
    if (request.url?.startsWith('/viewport-size?')) {
      const params = new URLSearchParams(request.url.split('?')[1]);
      remoteViewport = {
        width: Number(params.get('width')),
        height: Number(params.get('height')),
        narrow: params.get('narrow') === 'true'
      };
      response.writeHead(204).end();
      return;
    }
    if (request.url === '/retry-page' && failPage) {
      response.destroy();
      return;
    }
    if (request.url === '/retry-page') {
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<title>Retry fixture</title><body style="background:rgb(0,0,200)"></body>');
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
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
      <title>${request.url === '/relay' ? 'Relay fixture' : request.url === '/ice' ? longTabTitle : 'ICE fixture'}</title>
      <link rel="icon" href="/site-icon.png">
      <style>body{margin:0;background:${request.url === '/relay' ? 'rgb(200,0,0)' : request.url === '/ice' ? 'rgb(0,200,0)' : 'white'}}a{position:absolute;left:76%;top:20%;width:8%;height:10%;background:blue}</style>
      <a href="/clicked" aria-label="Click the Node page"></a>
      ${request.url === '/touch' ? `<input id="touch-field" style="position:absolute;left:24%;top:8%;width:18%;height:8%"><button id="touch-check" style="position:fixed;left:76%;top:8%;width:17%;height:8%">Check draft</button><input id="touch-slider" type="range" value="0" style="position:absolute;left:10%;top:60%;width:70%;height:8%;margin:0"><div style="height:200vh"></div>` : ''}
      <script>
        function publishViewport() {
          fetch('/viewport-size?' + new URLSearchParams({ width: innerWidth, height: innerHeight, narrow: matchMedia('(max-width: 500px)').matches }));
        }
        addEventListener('resize', publishViewport);
        publishViewport();
      </script>
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
          document.addEventListener('touchstart', ({ touches }) => {
            if (touches[0].clientX < 2) fetch('/touch-edge');
          });
          field.addEventListener('input', ({ target }) => fetch('/typed?text=' + encodeURIComponent(target.value)));
          document.querySelector('#touch-slider').addEventListener('change', ({ target }) => fetch('/slider?value=' + target.value));
          document.querySelector('#touch-check').addEventListener('click', () => fetch('/draft?text=' + encodeURIComponent(field.value)));
        }
        document.addEventListener('mouseup', ({ clientX }) => {
          if (clientX > innerWidth * 0.7) fetch('/released');
        });
        document.addEventListener('keydown', ({ code, key, altKey, ctrlKey }) => {
          if ((altKey || ctrlKey) && key.toLowerCase() === 'w') fetch('/unexpected-close');
          if (key === 'ArrowRight') fetch('/key-next');
          if (code === 'KeyY') fetch('/key-press');
        });
        document.addEventListener('keyup', ({ code }) => {
          if (code === 'KeyY') fetch('/key-release');
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
    async function expectContinuousPicture(change: () => Promise<void>) {
      const alpha = (element: HTMLCanvasElement) =>
        element.getContext('2d')!.getImageData(0, 0, 1, 1).data[3];
      await expect.poll(() => canvas.evaluate(alpha)).toBe(255);
      const watch = await canvas.evaluateHandle((element: HTMLCanvasElement) => {
        const context = element.getContext('2d')!;
        let empty = 0;
        let samples = 0;
        let request: number;
        function tick() {
          samples++;
          if (!context.getImageData(0, 0, 1, 1).data[3]) empty++;
          request = requestAnimationFrame(tick);
        }
        request = requestAnimationFrame(tick);
        return {
          stop() {
            cancelAnimationFrame(request);
            return { samples, empty };
          }
        };
      });
      let picture: { samples: number; empty: number };
      try {
        await change();
      } finally {
        picture = await watch.evaluate((sample) => sample.stop());
        await watch.dispose();
      }
      expect(picture.samples).toBeGreaterThan(0);
      expect(picture.empty).toBe(0);
    }
    async function expectViewportFits() {
      await expect
        .poll(async () => {
          const painted = await canvas.evaluate((element: HTMLCanvasElement) => ({
            width: element.clientWidth,
            height: element.clientHeight,
            ratio: element.width / element.height
          }));
          return {
            widthError: (remoteViewport?.width ?? 0) - painted.width,
            heightError: (remoteViewport?.height ?? 0) - painted.height,
            fits:
              painted.width > 0 &&
              painted.height > 0 &&
              Math.abs(painted.ratio - painted.width / painted.height) < 0.02,
            ratios: {
              decoded: painted.ratio,
              displayed: painted.width / painted.height
            }
          };
        })
        .toMatchObject({ widthError: 0, heightError: 0, fits: true });
    }
    const performanceInfo = page.getByRole('button', {
      name: /^(Browser streaming performance|浏览器投屏性能)$/u
    });
    const performancePanel = page.getByRole('region', {
      name: /^(Browser streaming performance|浏览器投屏性能)$/u
    });
    const relayLabel = /^(Server relay|Server 中继)$/u;
    async function checkRelay() {
      await performanceInfo.click();
      await expect(performancePanel.getByText(relayLabel)).toBeVisible({ timeout: 15_000 });
      await performanceInfo.press('Escape');
      await expect(performancePanel).toBeHidden();
    }
    const opener = page.getByRole('button', {
      name: /^(Open a website in MAR|在 MAR 中打开网址)$/u
    });
    const addAside = page.getByRole('button', { name: /^(Add Aside tab|添加辅助面标签页)$/u });
    const expandAside = page.getByRole('button', {
      name: /^(Open auxiliary workspace|打开辅助工作面)$/u
    });
    const addBrowser = page.getByRole('menuitem', { name: /^(Browser|浏览器)$/u });
    async function ensureWorkspace() {
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
            (await expandAside.isVisible()) ||
            ((await noWorkspace.isVisible()) &&
              ((await expand.isVisible()) || (await workspace.isVisible()))),
          { timeout: 15_000 }
        )
        .toBe(true);
      if (await noWorkspace.isVisible()) {
        if (await expand.isVisible()) await expand.click();
        await workspace.click();
      }
    }
    async function openWorkspaceBrowser() {
      await ensureWorkspace();
      if (!(await browserTab.isVisible())) {
        if (await opener.isVisible()) await opener.click();
        else {
          if (await expandAside.isVisible()) await expandAside.click();
          if (!(await browserTab.isVisible())) {
            await addAside.click();
            await addBrowser.click();
          }
        }
      }
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
    await ensureWorkspace();
    await expect(addAside.or(expandAside).first()).toBeVisible({ timeout: 15_000 });
    if (await expandAside.isVisible()) await expandAside.click();
    await expect(browserTab).toHaveCount(0);
    await addAside.click();
    await expect(browserTab).toHaveCount(0);
    await expect(addAside).toHaveAttribute('aria-expanded', 'true');
    await expect(addBrowser).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('browser-aside-add.png'),
      animations: 'disabled'
    });
    await addBrowser.click();
    await expect(browserTab).toHaveAttribute('aria-selected', 'true');
    await page.waitForFunction(
      () => document.documentElement.dataset.iceConnected === 'true',
      undefined,
      { timeout: 15_000 }
    );
    const newWebTab = page.getByRole('button', { name: /^(New tab|新建标签页)$/u });
    const tabRow = page.locator('.node-browser-tabs').getByRole('tablist');
    async function captureBrowserChrome(name: string) {
      const aside = (await page.locator('.workspace-aside').boundingBox())!;
      const toolbar = (await page.locator('.node-browser-toolbar').boundingBox())!;
      await page.screenshot({
        path: testInfo.outputPath(name),
        animations: 'disabled',
        clip: {
          x: aside.x,
          y: aside.y,
          width: aside.width,
          height: toolbar.y + toolbar.height - aside.y
        }
      });
    }
    const blankAddress = page.getByRole('textbox', { name: /^(Enter a web address|输入网址)$/u });
    await expect(tabRow.getByRole('tab', { name: /^(Blank|空白页)$/u })).toBeVisible();
    await expect(blankAddress).toBeVisible();
    await expect(canvas).toBeHidden();
    await expect(page.locator('.node-browser-body')).toHaveCSS('background-color', /rgba?\(/u);
    await page.screenshot({ path: testInfo.outputPath('browser-blank.png') });
    await expect(newWebTab).toBeEnabled();
    const initialTab = (await tabRow.getByRole('tab').first().boundingBox())!;
    const newWebTabBox = (await newWebTab.boundingBox())!;
    expect(newWebTabBox.x - initialTab.x - initialTab.width).toBeLessThan(60);
    expect(newWebTabBox.x).toBeGreaterThan(initialTab.x + initialTab.width);
    await newWebTab.click();
    await expect(tabRow.getByRole('tab')).toHaveCount(2);
    await expect(tabRow.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
    await blankAddress.fill(`127.0.0.1:${local.port}/ice`);
    await blankAddress.press('Enter');
    await expect(address).toHaveValue(`${origin}/ice`);
    await expect(blankAddress).toHaveCount(0);
    await expect(tabRow.getByRole('tab')).toHaveCount(2);
    await expect.poll(() => requests.includes('/ice')).toBe(true);
    await expectViewportFits();
    async function expectSiteIcon(tabName: string) {
      const icon = tabRow.getByRole('tab', { name: tabName, exact: true }).locator('img');
      await expect(icon).toHaveAttribute('src', /^data:image\/png;base64,/u);
      await expect
        .poll(() =>
          icon.evaluate((image: HTMLImageElement) => {
            if (!image.complete || !image.naturalWidth) return [];
            const canvas = new OffscreenCanvas(16, 16).getContext('2d')!;
            canvas.drawImage(image, 0, 0);
            return [...canvas.getImageData(8, 8, 1, 1).data];
          })
        )
        .toEqual([243, 77, 129, 255]);
    }
    await expectSiteIcon(longTabTitle);
    const longTab = tabRow.getByRole('tab', { name: longTabTitle, exact: true });
    await expect(longTab.locator('.browser-tab-clip')).toHaveCSS('mask-image', /linear-gradient/u);
    await expect(longTab.locator('.browser-tab-clip')).toHaveCSS('text-overflow', 'clip');
    await expect(tabRow.getByRole('tab').first().locator('.browser-tab-clip')).toHaveCSS(
      'mask-image',
      'none'
    );
    await expect(page.locator('.node-browser-tabs')).toHaveCSS('border-bottom-width', '1px');
    const activeWebTab = longTab.locator('..');
    await expect(activeWebTab).toHaveCSS('border-top-left-radius', /^(?:[89]|[1-9]\d+)px$/u);
    await expect(activeWebTab).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(tabRow.getByRole('tab').first().locator('..')).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)'
    );
    await captureBrowserChrome('browser-chrome-tabs-desktop.png');
    await page.screenshot({
      path: testInfo.outputPath('browser-site-tab.png'),
      animations: 'disabled'
    });
    await performanceInfo.click();
    const directDescription = await page
      .locator('.workspace-tab [aria-description].direct-available-node:visible')
      .first()
      .getAttribute('aria-description', { timeout: 15_000 });
    expect(directDescription).toBeTruthy();
    await expect(performancePanel.getByText(directDescription!, { exact: true })).toBeVisible();
    await expect(performancePanel.getByText('H.264', { exact: true })).toBeVisible();
    await expect(performancePanel.getByText(/^[\d.,]+ (?:[kM]?bit\/s)$/u)).toBeVisible();
    await expect(performancePanel.getByText(/^[\d.,]+ fps$/u)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('browser-performance-ice.png') });
    await performanceInfo.press('Escape');
    await expect(performancePanel).toBeHidden();
    const navigation = page.getByRole('group', { name: /^(Page navigation|网页导航)$/u });
    await expect(navigation.getByRole('button')).toHaveCount(3);
    await address.fill(`${origin}/loading-page`);
    await address.press('Enter');
    const busy = page.getByRole('status', { name: /^(Loading page…|正在加载网页…)$/u });
    await expect(busy.locator('.mar-busy-indicator')).toBeVisible();
    const stop = navigation.getByRole('button', { name: /^(Stop loading|停止加载)$/u });
    await expect(stop).toBeEnabled();
    await expect(stop.locator('[data-mar-icon="close"]')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('browser-loading.png'),
      animations: 'disabled'
    });
    await stop.click();
    await expect(busy).toHaveCount(0);
    finishPage?.();

    await address.fill(`${origin}/retry-page`);
    await address.press('Enter');
    await expect(address).toHaveValue(`${origin}/retry-page`);
    await expect(canvas).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('browser-navigation-failed.png'),
      animations: 'disabled'
    });
    await address.fill(`${origin}/unsubmitted`);
    const attempts = requests.filter((path) => path === '/retry-page').length;
    failPage = false;
    const reload = navigation.getByRole('button', { name: /^(Reload|刷新)$/u });
    await expectContinuousPicture(async () => {
      await reload.click();
      await expect
        .poll(() => requests.filter((path) => path === '/retry-page').length)
        .toBeGreaterThan(attempts);
      await expect(address).toHaveValue(`${origin}/retry-page`);
      await expect
        .poll(() =>
          canvas.evaluate((element: HTMLCanvasElement) => {
            const [r, g, b] = element.getContext('2d')!.getImageData(0, 0, 1, 1).data;
            return r! < 30 && g! < 30 && b! > 150;
          })
        )
        .toBe(true);
    });
    await expect(canvas).toBeVisible();
    expect(requests).not.toContain('/unsubmitted');
    await address.fill(`${origin}/ice`);
    await address.press('Enter');
    await expect(address).toHaveValue(`${origin}/ice`);
    async function canvasPoint(x: number, y: number) {
      await expectViewportFits();
      const box = (await canvas.boundingBox())!;
      return { x: box.x + box.width * x, y: box.y + box.height * y };
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
          await checkRelay();
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
    await checkRelay();
    await expect(address).toHaveValue(`${origin}/clicked`);
    await address.fill(`${origin}/relay`);
    await address.press('Enter');
    await expect.poll(() => requests.includes('/relay')).toBe(true);
    await expect(address).toHaveValue(`${origin}/relay`);
    await expectViewportFits();
    await expectSiteIcon('Relay fixture');
    const relayWidth = remoteViewport!.width;
    const divider = page.locator('.workbench-aside').getByRole('separator');
    const dividerBox = (await divider.boundingBox())!;
    await expectContinuousPicture(async () => {
      await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 40);
      await page.mouse.down();
      await page.mouse.move(dividerBox.x + dividerBox.width / 2 + 90, dividerBox.y + 40, {
        steps: 8
      });
      await page.mouse.up();
      await expect.poll(() => remoteViewport?.width).toBeLessThan(relayWidth);
      await expectViewportFits();
    });
    expect(requests.filter((path) => path === '/relay')).toHaveLength(1);
    await performanceInfo.click();
    await expect(performancePanel.getByText(relayLabel)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('browser-performance-relay.png') });
    await performanceInfo.press('Escape');
    await expect(performancePanel).toBeHidden();
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
      await checkRelay();
      await expect(address).toHaveValue(`${origin}/relay`);
    }

    const longHistoryPath = `/long-history?value=${'a'.repeat(350)}`;
    const longHistoryUrl = origin + longHistoryPath;
    await address.fill(longHistoryUrl);
    await address.press('Enter');
    await expect.poll(() => requests.includes(longHistoryPath)).toBe(true);
    await expect(address).toHaveValue(longHistoryUrl);
    await page.getByRole('button', { name: /^(Back|后退)$/u }).click();
    await expect(address).toHaveValue(`${origin}/relay`);

    const commands = page.getByRole('button', { name: /^(Browser commands|浏览器命令)$/u });
    await expect(commands).toBeEnabled();
    await commands.click();
    const browserMenu = page.getByRole('menu', { name: /^(Browser commands|浏览器命令)$/u });
    const browserCommands = browserMenu.getByRole('menuitem');
    await expect(browserCommands).toHaveCount(5);
    await expect(browserCommands.locator('svg')).toHaveCount(5);
    await expect(
      browserMenu.getByRole('menuitem', { name: /^(Copy selected text|复制网页所选文本)$/u })
    ).toHaveCount(0);
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
    await expect(
      clear.getByRole('checkbox', { name: /^(Cookies and site data|Cookie 和站点数据)$/u })
    ).toHaveAccessibleDescription(/sign you out|退出登录/u);
    const range = clear.getByRole('combobox', { name: /^(Time range|时间范围)$/u });
    await range.click();
    await page.getByRole('option', { name: /^(Last 24 hours|最近 24 小时)$/u }).click();
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
    const search = historyDialog.getByRole('textbox', {
      name: /^(Search titles and URLs|搜索标题或网址)$/u
    });
    await expect(search).toBeFocused();
    const history = historyDialog.getByRole('button', {
      name: `Relay fixture ${origin}/relay`,
      exact: true
    });
    await expect(history).toBeVisible();
    await expect(historyDialog.getByText(/Active persistent profile|当前持久资料/u)).toBeVisible();
    await expect(history).toContainText(`${origin}/relay`);
    const longUrl = historyDialog.getByText(longHistoryUrl, { exact: true });
    await expect(longUrl).toBeVisible();
    expect(
      await longUrl.evaluate((element) => {
        const text = document.createRange();
        text.selectNodeContents(element);
        const style = getComputedStyle(element);
        return {
          clipped: element.scrollWidth > element.clientWidth,
          lines: new Set(Array.from(text.getClientRects(), (rect) => rect.top)).size,
          overflow: style.textOverflow
        };
      })
    ).toEqual({ clipped: true, lines: 1, overflow: 'ellipsis' });
    await expect(historyDialog.getByText('false', { exact: true })).toHaveCount(0);
    await expect(canvas).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('browser-history.png'),
      animations: 'disabled'
    });
    await test.step('Filter by a local day using the MAR calendar', async () => {
      await historyDialog.getByRole('button', { name: /^(Filter by date|按日期筛选)$/u }).click();
      const through = historyDialog.getByRole('textbox', { name: /^(Through|结束日期)$/u });
      const calendar = historyDialog.getByRole('dialog', { name: /^(Calendar|日历)$/u });
      const confirm = calendar.getByRole('button', { name: /^(Confirm|确定)$/u });
      const day = await page.evaluate(() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      });
      await through.click();
      await expect(calendar).toBeVisible();
      await expect(calendar.locator('input[type=time]')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('browser-history-calendar.png') });
      await calendar.getByRole('button', { name: day, exact: true }).click();
      await confirm.click();
      await expect(calendar).toBeHidden();
      await expect(through).toHaveValue(day);
      await expect(history).toBeVisible();
      await through.fill('2000-01-01');
      await through.press('Enter');
      await expect(history).toHaveCount(0);
      await expect(
        historyDialog.getByText(/No matching browsing history|没有匹配的浏览历史/u)
      ).toBeVisible();
      await through
        .locator('..')
        .getByRole('button', { name: /^(Clear|清空)$/u })
        .click();
      await expect(history).toBeVisible();
    });
    const outsideMatch = historyDialog.getByRole('button', { name: /^ICE fixture/u }).first();
    await expect(outsideMatch).toBeVisible();
    await search.fill('Relay fixture');
    await expect(outsideMatch).toHaveCount(0);
    await expect(history).toBeVisible();
    const row = history.locator('..');
    const selectEntry = row.getByRole('checkbox');
    await selectEntry.check();
    await historyDialog.getByRole('button', { name: /^(Delete selected|删除所选)$/u }).click();
    const confirmation = page.getByRole('dialog', {
      name: /^(Delete browsing history|删除浏览历史)$/u
    });
    const cancelDeletion = confirmation.getByRole('button', { name: /^(Cancel|取消)$/u });
    await expect(cancelDeletion).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(confirmation).toBeHidden();
    await expect(search).toHaveValue('Relay fixture');
    await expect(selectEntry).toBeChecked();
    await row.getByRole('button', { name: /History actions for|历史记录操作/u }).click();
    await page.getByRole('menuitem', { name: /Remove from history|从历史记录中移除/u }).click();
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

    await test.step('Release a remote key even when its modifiers were released first', async () => {
      await page.keyboard.down('Control');
      await page.keyboard.down('Shift');
      // Playwright takes the literal key value. Both events still have code KeyY.
      await page.keyboard.down('Y');
      await page.keyboard.up('Shift');
      await page.keyboard.up('Control');
      await page.keyboard.up('y');
      await expect.poll(() => requests.includes('/key-press')).toBe(true);
      await expect.poll(() => requests.includes('/key-release')).toBe(true);
    });

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
    await expect(opener).toHaveCount(0);
    await openWorkspaceBrowser();
    await address.fill(`${origin}/touch`);
    await address.press('Enter');
    await expect(address).toHaveValue(`${origin}/touch`);
    await expect.poll(() => requests.includes('/touch')).toBe(true);
    await expectViewportFits();
    expect(remoteViewport?.narrow).toBe(true);
    const narrowTabs = tabRow.getByRole('tab');
    await expect(narrowTabs).toHaveCount(3);
    for (const tab of await narrowTabs.all()) await expect(tab).toBeInViewport({ ratio: 0.99 });
    await expect(newWebTab).toBeInViewport({ ratio: 0.99 });
    await captureBrowserChrome('browser-chrome-tabs-mobile.png');
    await test.step('Reveal focused tabs in the overflowing strip and restore focus on close', async () => {
      await newWebTab.click();
      await expect(narrowTabs).toHaveCount(4);
      const newest = narrowTabs.last();
      await expect(newest).toHaveAttribute('aria-selected', 'true');
      await newest.press('Home');
      await expect(narrowTabs.first()).toBeFocused();
      await expect(narrowTabs.first()).toBeInViewport({ ratio: 0.99 });
      await expect(newest).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('End');
      await expect(newest).toBeFocused();
      await expect(newest).toBeInViewport({ ratio: 0.99 });
      await newest
        .locator('..')
        .getByRole('button', { name: /^(Close Blank|关闭\s*空白页)$/u })
        .press('Enter');
      await expect(narrowTabs).toHaveCount(3);
      await expect(narrowTabs.last()).toBeFocused();
      await expect(address).toHaveValue(`${origin}/touch`);
    });
    const touchInput = page.getByRole('button', { name: /^(Show keyboard|显示键盘)$/u });
    const pageActions = page.getByRole('group', { name: /^(Remote page actions|远端网页操作)$/u });
    const copySelection = pageActions.getByRole('button', {
      name: /^(Copy selected text|复制网页所选文本)$/u
    });
    await expect(
      pageActions.getByRole('button', { name: /^(Show keyboard|显示键盘)$/u })
    ).toBeVisible();
    await expect(pageActions.locator('button')).toHaveCount(3);
    await address.fill(`${origin}/touch?query=${'long-address'.repeat(20)}`);
    const toolbar = page.locator('.node-browser-toolbar');
    await expect
      .poll(() =>
        toolbar.evaluate((element) => {
          const row = element.getBoundingClientRect();
          const controls = [...element.querySelectorAll('button, a[href], input')]
            .map((control) => control.getBoundingClientRect())
            .filter(({ width, height }) => width > 0 && height > 0);
          return (
            controls.length === 6 &&
            controls.every(
              (rect) =>
                Math.abs(rect.y + rect.height / 2 - (row.y + row.height / 2)) < 2 &&
                rect.left >= row.left &&
                rect.right <= row.right
            )
          );
        })
      )
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('browser-toolbar-mobile.png'),
      animations: 'disabled'
    });
    const beforeInvalid = await canvas.boundingBox();
    await address.fill('ftp://example.test');
    await address.press('Enter');
    const invalidNotice = page
      .locator('.node-browser-body')
      .getByRole('alert')
      .filter({
        hasText: /valid HTTP or HTTPS|有效的 HTTP 或 HTTPS/u
      });
    await expect(invalidNotice).toBeVisible();
    await expect(address).toHaveAttribute('aria-invalid', 'true');
    expect(await canvas.boundingBox()).toEqual(beforeInvalid);
    await invalidNotice.getByRole('button').click();
    await address.fill(`${origin}/touch`);
    const field = await canvasPoint(0.32, 0.12);
    const touchAt = (
      type: 'touchStart' | 'touchMove' | 'touchEnd',
      point?: { x: number; y: number }
    ) => touch.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [point] : [] });
    // Model a touch that starts in letterboxing: implicit capture must not clamp a new gesture.
    await canvas.evaluate((element) => {
      const pointerId = 123;
      const bounds = element.getBoundingClientRect();
      Object.defineProperty(element, 'hasPointerCapture', {
        configurable: true,
        value: () => true
      });
      try {
        element.dispatchEvent(
          new PointerEvent('pointerdown', {
            pointerId,
            pointerType: 'touch',
            isPrimary: true,
            clientX: bounds.left - 5,
            clientY: bounds.top + bounds.height / 2
          })
        );
        element.dispatchEvent(
          new PointerEvent('pointerup', { pointerId, pointerType: 'touch', isPrimary: true })
        );
      } finally {
        Reflect.deleteProperty(element, 'hasPointerCapture');
      }
    });
    await touchAt('touchStart', field);
    await touchAt('touchEnd');
    await touchInput.click();
    await expect(page.locator('[data-node-browser-input]')).toBeFocused();
    await page.keyboard.insertText('你好');
    await expect
      .poll(() => requests.includes(`/typed?text=${encodeURIComponent('你好')}`))
      .toBe(true);
    expect(requests).not.toContain('/touch-edge');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.keyboard.press('Control+a');
    const beforeCopy = await canvas.boundingBox();
    await copySelection.click();
    const copied = page
      .locator('.node-browser-body')
      .getByRole('status')
      .filter({
        hasText: /^(Text copied|已复制文本)$/u
      });
    await expect(copied).toBeVisible();
    expect(await canvas.boundingBox()).toEqual(beforeCopy);
    // Measure the placement owner, not the message translated during its entrance animation.
    const noticeBounds = await page
      .locator('.node-browser-body > .mar-feedback-stack--local')
      .boundingBox();
    expect(noticeBounds!.y - beforeCopy!.y).toBeCloseTo(8, 0);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('你好');
    await expect(copied).toBeHidden({ timeout: 8_000 });
    await touchInput.click();
    await page.evaluate(() => navigator.clipboard.writeText('已粘贴'));
    await page.keyboard.press('Control+v');
    await expect
      .poll(() => requests.includes(`/typed?text=${encodeURIComponent('已粘贴')}`))
      .toBe(true);
    await page.getByRole('button', { name: /^(Hide keyboard|收起键盘)$/u }).click();
    await expect(page.locator('[data-node-browser-input]')).not.toBeFocused();
    await touchAt('touchStart', await canvasPoint(0.126, 0.64));
    await touchAt('touchMove', await canvasPoint(0.72, 0.64));
    await touchAt('touchEnd');
    await expect
      .poll(() => requests.some((path) => /^\/slider\?value=(?:[7-9]\d|100)$/u.test(path)))
      .toBe(true);
    expect(requests).not.toContain('/touch-scrolled');
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
    await expectViewportFits();
    expect(remoteViewport?.narrow).toBe(false);
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

    await performanceInfo.click();
    await expect(performancePanel).toBeVisible();
    await performanceInfo.press('Escape');
    await expect(performancePanel).toBeHidden();
    await expect(canvas).toBeVisible();

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
    await expect(browserTab).toHaveCount(0);
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
