import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { NodeStreamMux } from '../../packages/protocol/src/node-stream-mux.js';
import { encodeNodeRelayHandshake } from '../../packages/protocol/src/node-stream-wire.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';
import { mockWorkspaceFileRelay } from './support/mock-workspace-file-relay.js';

// @test-covers packages/web-core/src/view/workspace/StandaloneFilePreviewPage.vue
// @test-covers packages/web-core/src/styles/code-syntax-theme.css

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

async function mockWorkspaceFileStream(
  page: Page,
  path: string,
  bytes: Buffer,
  ready?: Promise<void>
) {
  let oldBodyRequests = 0;
  await page.route(/\/api\/workspaces\/workspace\/files\/(read|content)\?/u, (route) => {
    oldBodyRequests++;
    return route.abort();
  });
  const snapshot = await mockWorkspaceFileRelay(page, 'node', 'workspace', async (requestPath) => {
    expect(requestPath).toBe(path);
    await ready;
    return bytes;
  });
  return () => ({ ...snapshot(), oldBodyRequests });
}

test('Standalone Workspace image uses only HTTP until the user downloads it', async ({ page }) => {
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const snapshot = await mockWorkspaceFileStream(page, 'picture.png', bytes);
  let workbenchSockets = 0;
  await page.routeWebSocket('**/api/workbench/live', () => {
    workbenchSockets++;
  });
  await page.route('**/api/workspaces/workspace/files/content?**', (route) =>
    route.fulfill({ contentType: 'image/png', body: bytes })
  );
  await page.goto(
    `${fixture.url}standalone-preview.html?standaloneFile=1&nodeId=node&workspaceId=workspace&path=picture.png`
  );
  const image = page.locator('img[src*="/files/content"]');
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBe(1);
  expect(snapshot()).toMatchObject({ carriers: 0, descriptors: [] });
  expect(workbenchSockets).toBe(0);

  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: /^(Download file|下载文件)$/iu }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('picture.png');
  expect(await readFile(await download.path())).toEqual(bytes);
  expect(snapshot()).toMatchObject({
    carriers: 1,
    descriptors: [{ resource: { path: 'picture.png' } }],
    oldBodyRequests: 0
  });
});

test('Standalone Workspace surfaces a stream grant failure without retrying the HTTP body', async ({
  page
}) => {
  const snapshot = await mockWorkspaceFileStream(
    page,
    'guide.md',
    Buffer.from('# Not authorized\n')
  );
  await page.route('**/api/workspaces/workspace/file-stream-ticket', (route) =>
    route.fulfill({ status: 403, json: { code: 'RESOURCE_DENIED' } })
  );
  await page.goto(
    `${fixture.url}standalone-preview.html?markdownPreview=1&nodeId=node&workspaceId=workspace&path=guide.md`
  );
  await expect(page.locator('.standalone-error')).toBeVisible();
  expect(snapshot()).toMatchObject({ carriers: 1, oldBodyRequests: 0 });
});

test('Standalone Hosted preview and download share a Relay without HTTP file bodies', async ({
  page
}) => {
  await page.addInitScript(() => sessionStorage.setItem('mar.user.csrf-token', 'fixture-csrf'));
  const bytes = Buffer.from('Hosted snapshot z\u00e9ro\n');
  const filePath = '**/api/nodes/node/hosted-conversations/conversation/files/file';
  const descriptors: Array<{ range?: { offset: number; length: number } }> = [];
  let carriers = 0;
  let oldRequests = 0;
  await page.route(`${filePath}/content**`, (route) => {
    oldRequests++;
    return route.abort();
  });
  await page.route(`${filePath}/metadata`, (route) =>
    route.fulfill({
      json: {
        id: 'file',
        conversationId: 'conversation',
        category: 'UPLOAD',
        relativePath: 'file.txt',
        displayName: 'file.txt',
        mimeType: 'text/plain',
        size: bytes.byteLength,
        source: 'USER',
        createdAt: 1,
        updatedAt: 2
      }
    })
  );
  await page.route(`${filePath}/stream-ticket`, (route) => {
    const descriptor = route.request().postDataJSON() as {
      revision: string;
      range?: { offset: number; length: number };
    };
    expect(descriptor.revision).toBe(`2-${bytes.byteLength}`);
    descriptors.push(descriptor);
    return route.fulfill({ json: { ticket: String(descriptors.length - 1) } });
  });
  await page.routeWebSocket(/\/api\/relay\/node\?hostedConversationId=conversation$/u, (socket) => {
    carriers++;
    const mux = new NodeStreamMux({
      maxStreams: 2,
      async send(frame) {
        socket.send(Buffer.from(frame));
      },
      async accept({ kind, grant }) {
        const descriptor = descriptors[Number(grant)];
        if (kind !== 'hosted-file-download' || descriptor === undefined) return undefined;
        return async (stream) => {
          const { offset, length } = descriptor.range ?? { offset: 0, length: bytes.byteLength };
          await stream.write(bytes.subarray(offset, offset + length));
          await stream.endWrite();
          for await (const _chunk of stream) throw new Error('Unexpected reverse DATA');
        };
      }
    });
    socket.onMessage((message) => mux.receive(message));
    socket.onClose(() => mux.disconnect());
    socket.send(Buffer.from(encodeNodeRelayHandshake({ type: 'RELAY_READY' })));
  });
  await page.goto(
    `${fixture.url}standalone-preview.html?standaloneFile=1&source=hosted&nodeId=node&workspaceId=conversation&conversationId=conversation&fileId=file&path=file.txt&mimeType=text/plain&size=${bytes.byteLength}`
  );
  await expect(page.locator('.cm-content')).toContainText('Hosted snapshot z\u00e9ro');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: /^(Download file|下载文件)$/iu }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('file.txt');
  expect(await readFile(await download.path())).toEqual(bytes);
  expect(descriptors.map((descriptor) => descriptor.range)).toEqual([
    { offset: 0, length: bytes.byteLength },
    undefined
  ]);
  expect(carriers).toBe(1);
  expect(oldRequests).toBe(0);
});

for (const width of [1280, 390]) {
  test(`Standalone legacy source remains readable and read-only on a writable Node at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const bytes = Buffer.from([47, 47, 32, 0xd6, 0xd0, 0xce, 0xc4, 13, 10]);
    const snapshot = await mockWorkspaceFileStream(page, 'DisplayBoard.c', bytes);
    await page.goto(
      `${fixture.url}standalone-preview.html?standaloneFile=1&nodeId=node&workspaceId=workspace&path=DisplayBoard.c&write=1`
    );
    const preview = page.locator('.cm-content');
    await expect(preview).toContainText('// 中文');
    await expect(preview).toHaveAttribute('contenteditable', 'false');
    await expect(page.locator('.mar-file-preview-eyebrow')).toContainText('GB18030');
    await expect(page.getByRole('button', { name: /^(Edit file|编辑文件)$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Save|保存)$/ })).toHaveCount(0);
    expect(snapshot()).toMatchObject({ carriers: 1, oldBodyRequests: 0 });
  });
}

for (const theme of ['daylight', 'dark', 'custom']) {
  test(`Standalone Markdown stays light under the ${theme} console theme`, async ({ page }) => {
    const content = '# Preview\n\nReadable text.\n\n```ts\nconst preview = true;\n```\n';
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mockWorkspaceFileStream(page, 'guide.md', Buffer.from(content), ready);
    await page.goto(
      `${fixture.url}standalone-preview.html?markdownPreview=1&nodeId=node&workspaceId=workspace&path=guide.md&theme=${theme}`
    );
    const root = page.locator('.standalone-file-preview');
    const header = page.locator('.standalone-markdown-header');
    const loading = page.locator('.file-preview-loading');
    try {
      await expect(loading).toBeVisible();
      if (theme === 'custom') {
        await page.evaluate(() => {
          for (const name of ['--mar-bg-chrome', '--mar-bg-panel', '--mar-text-secondary']) {
            document.documentElement.style.setProperty(name, '#ff00ff');
          }
        });
      }
      await expect(root).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      await expect(header).toHaveCSS('background-color', 'rgb(246, 248, 250)');
      await expect(header).toHaveCSS('color', 'rgb(87, 96, 106)');
      await expect(header).toHaveCSS('border-bottom-color', 'rgb(208, 215, 222)');
      await expect(loading).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      await expect(loading).toHaveCSS('color', 'rgb(87, 96, 106)');
    } finally {
      release();
    }
    await expect(page.locator('.markdown-body')).toContainText('Readable text.');
    await expect(page.locator('.markdown-body')).toHaveCSS('color', 'rgb(31, 35, 40)');
    await expect(root).toHaveCSS('overflow-y', 'auto');
    await expect(page.locator('.markdown-body')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.locator('.markdown-body > :first-child')).toHaveCSS('margin-top', '0px');
    const codeBlock = page.locator('.markdown-body pre');
    await expect(codeBlock).toHaveCSS('background-color', 'rgb(246, 248, 250)');
    await expect(codeBlock.locator('code')).toContainText('const preview = true;');
    await expect(codeBlock.locator('code')).toHaveCSS('color', 'rgb(31, 35, 40)');
    await expect(loading).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`${theme}-desktop.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(header).toHaveCSS('background-color', 'rgb(246, 248, 250)');
    await page.screenshot({ path: test.info().outputPath(`${theme}-mobile.png`) });
  });
}

for (const locale of ['en-US', 'zh-CN']) {
  test(`Standalone HTML reports a missing file with diagnostics in ${locale}`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('mar.locale.v2', value), locale);
    await page.route('**/api/html-preview/grants', (route) =>
      route.fulfill({
        status: 404,
        json: {
          error: {
            code: 'FILE_NOT_FOUND',
            message: 'File not found.',
            details: 'Missing HTML document.',
            requestId: 'preview-request',
            upstreamRequestId: 'node-request'
          }
        }
      })
    );
    await page.goto(
      `${fixture.url}standalone-preview.html?htmlPreview=1&nodeId=node&workspaceId=workspace&path=missing.html`
    );
    const failure = page.locator('.standalone-error');
    await expect(failure).toContainText(locale === 'zh-CN' ? '文件不存在。' : 'File not found.');
    for (const fact of [
      'FILE_NOT_FOUND',
      'Missing HTML document.',
      'preview-request',
      'node-request'
    ])
      await expect(failure).toContainText(fact);
    await expect(failure).toHaveCSS('white-space', 'pre-wrap');
    await expect(page.locator('iframe')).toHaveCount(0);
  });
}

test('Standalone preview errors remain readable on the light surface', async ({ page }) => {
  await page.goto(`${fixture.url}standalone-preview.html?markdownPreview=1`);
  await expect(page.locator('.standalone-error')).toBeVisible();
  await expect(page.locator('.standalone-error')).toHaveCSS('color', 'rgb(207, 34, 46)');
  await expect(page.locator('.standalone-file-preview')).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)'
  );
});

test('Standalone Markdown prints complete pages without the console viewport clipping', async ({
  page
}) => {
  await mockWorkspaceFileStream(
    page,
    'guide.md',
    Buffer.from('# Print preview\n\n' + 'Long readable paragraph.\n\n'.repeat(150))
  );
  await page.goto(
    `${fixture.url}standalone-preview.html?markdownPreview=1&nodeId=node&workspaceId=workspace&path=guide.md`
  );
  const body = page.locator('.markdown-body');
  await expect(body).toContainText('Print preview');
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#app')).toHaveCSS('overflow', 'visible');
  await expect(page.locator('#app')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.standalone-file-preview')).toHaveCSS('display', 'block');
  await expect(page.locator('.standalone-markdown-header')).toBeHidden();
  const geometry = await page.locator('.markdown-preview-page').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      width: element.getBoundingClientRect().width,
      padding: parseFloat(style.paddingTop),
      height: element.getBoundingClientRect().height,
      viewport: innerHeight
    };
  });
  expect(geometry.width).toBeCloseTo((210 * 96) / 25.4, 0);
  expect(geometry.padding).toBeCloseTo((18 * 96) / 25.4, 0);
  expect(geometry.height).toBeGreaterThan(geometry.viewport);
});

test('Standalone HTML fills desktop and mobile widths without changing document styles', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  const documentReady = Promise.withResolvers<void>();
  await page.route('**/api/html-preview/grants', (route) =>
    route.fulfill({
      json: { url: new URL('/preview-document', fixture.url).href }
    })
  );
  await page.route('**/preview-document', async (route) => {
    await documentReady.promise;
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>.wide { display: none } @media (min-width: 768px) {
          .wide { display: block } .narrow { display: none }
        }</style>
        <body style="background:#123456;color:white">
          <h1 class="wide">Desktop document</h1><h1 class="narrow">Mobile document</h1>
        </body>`
    });
  });
  await page.goto(
    `${fixture.url}standalone-preview.html?htmlPreview=1&nodeId=node&workspaceId=workspace&path=guide.html`,
    { waitUntil: 'domcontentloaded' }
  );
  const header = page.getByRole('main').locator('header');
  const loading = page.getByRole('main').getByRole('status');
  const iframe = page.locator('iframe');
  const frame = iframe.contentFrame();
  const checkWidth = (width: number) =>
    expect.poll(async () => (await iframe.boundingBox())?.width).toBe(width);
  try {
    await expect(header).toHaveCSS('background-color', 'rgb(246, 248, 250)');
    await expect(loading).toBeVisible();
    await expect(loading).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect.poll(async () => (await loading.boundingBox())?.width).toBe(1280);
  } finally {
    documentReady.resolve();
  }
  await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(18, 52, 86)');
  await checkWidth(1280);
  await expect(frame.getByRole('heading', { name: 'Desktop document' })).toBeVisible();
  await expect(header).toHaveText('guide.html');
  await expect(loading).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await checkWidth(390);
  await expect(frame.getByRole('heading', { name: 'Mobile document' })).toBeVisible();
});
