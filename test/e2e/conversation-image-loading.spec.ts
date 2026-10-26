import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { ImagePreviewService } from '../../mar-node/src/service/image-preview-service.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

// @test-covers packages/web-core/src/view/conversation/DecodedPreviewImage.vue
// @test-covers packages/web-core/src/view/conversation/ConversationImageThumbnail.vue
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
let images: Server;
let imageOrigin: string;
let full: Buffer;
let thumbnail: Buffer;
let detail: Buffer;
let small: Buffer;
let smallDetail: Buffer;
let requests: string[] = [];
let halfSent = false;
let finishTransfer = () => {};
let retries = 0;

test.beforeAll(async () => {
  const require = createRequire(new URL('../../mar-node/package.json', import.meta.url));
  const sharp = require('sharp');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="3600" height="2250"><rect width="3600" height="2250" fill="#dce8f5"/>${Array.from({ length: 75 }, (_, i) => `<text x="30" y="${30 + i * 28}" font-size="20">Image loading fixture line ${i}: Readable original text and symbols</text>`).join('')}</svg>`;
  full = await sharp(Buffer.from(svg)).png().toBuffer();
  const previews = new ImagePreviewService();
  thumbnail = Buffer.from(
    (await previews.create(full, { maxWidth: 320, maxHeight: 240 })).dataBase64,
    'base64'
  );
  detail = Buffer.from(
    (await previews.create(full, { maxWidth: 2560, maxHeight: 2560 })).dataBase64,
    'base64'
  );
  small = await sharp(full).resize({ width: 640 }).png().toBuffer();
  const smallPreview = await previews.create(small, { maxWidth: 2560, maxHeight: 2560 });
  expect(smallPreview.resized).toBe(false);
  smallDetail = Buffer.from(smallPreview.dataBase64, 'base64');
  images = createServer((request, response) => {
    requests.push(request.url!);
    const url = new URL(request.url!, 'http://localhost');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-expose-headers', 'x-mar-image-resized');
    if (url.searchParams.get('maxWidth') === '320') {
      response.writeHead(200, { 'content-type': 'image/webp', 'x-mar-image-resized': '1' });
      response.end(thumbnail);
    } else if (url.pathname.endsWith('/retry') && retries++ === 0) {
      response.writeHead(503).end();
    } else {
      const preview = url.searchParams.has('maxWidth');
      const isSmall = url.pathname.endsWith('/small');
      const bytes = isSmall ? (preview ? smallDetail : small) : preview ? detail : full;
      response.writeHead(200, {
        'content-type': !preview ? 'image/png' : 'image/webp',
        'content-length': bytes.length,
        ...(preview ? { 'x-mar-image-resized': isSmall ? '0' : '1' } : {})
      });
      if (url.pathname.endsWith('/slow')) {
        const midpoint = Math.floor(bytes.length / 2);
        response.write(bytes.subarray(0, midpoint));
        finishTransfer = () => {
          finishTransfer = () => {};
          response.end(bytes.subarray(midpoint));
        };
        halfSent = true;
      } else response.end(bytes);
    }
  });
  await new Promise<void>((resolve) => images.listen(0, '127.0.0.1', resolve));
  const address = images.address();
  if (typeof address !== 'object' || address === null) throw new Error('Image fixture unavailable');
  imageOrigin = `http://127.0.0.1:${address.port}`;
  fixture = await startCustomThemeFixture('test/e2e/support/conversation-image-loading.html');
});

test.afterAll(async () => {
  images?.closeAllConnections();
  await Promise.all([
    fixture?.close(),
    new Promise<void>((resolve) => images?.close(() => resolve()))
  ]);
});

test.beforeEach(async ({ page }) => {
  requests = [];
  halfSent = false;
  retries = 0;
  finishTransfer = () => {};
  await page.route('**/api/agent-runs/fixture/images/**', (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      status: 307,
      headers: { location: `${imageOrigin}${url.pathname}${url.search}` }
    });
  });
  await page.addInitScript(() => {
    const original = HTMLImageElement.prototype.decode;
    const urls = new Set<string>();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object) => {
      const url = create(object);
      urls.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      urls.delete(url);
      revoke(url);
    };
    Object.assign(window, { previewObjectUrls: urls });
    const gates: Record<string, () => void> = {};
    const state = { block: true, gates };
    Object.assign(window, { imageDecodeGates: gates, imageDecodeState: state });
    HTMLImageElement.prototype.decode = async function () {
      await original.call(this);
      if (state.block && this.classList.contains('attachment-preview-image')) {
        state.block = false;
        await new Promise<void>((resolve) => {
          gates.slow = () => {
            delete gates.slow;
            resolve();
          };
        });
      }
    };
  });
});

test.afterEach(() => finishTransfer());

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 }
]) {
  test(`real thumbnail and fully decoded preview at ${viewport.width}px`, async ({
    page
  }, info) => {
    await page.setViewportSize(viewport);
    await page.goto(
      `${fixture.url}conversation-image-loading.html?theme=${viewport.width === 390 ? 'daylight' : 'dark'}`
    );
    const listImage = page.locator('.conversation-user-image');
    await expect
      .poll(() => listImage.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(320);
    expect(requests.every((url) => url.includes('maxWidth=320&maxHeight=240'))).toBe(true);
    expect(thumbnail.length).toBeLessThan(full.length / 2);
    await listImage.click();
    const dialog = page.getByRole('dialog', { name: 'Image preview', exact: true });
    const image = dialog.locator('img');
    await expect.poll(() => halfSent).toBe(true);
    await expect(image).toBeHidden();
    await expect(dialog.getByRole('status')).toBeVisible();
    finishTransfer();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(
            (window as unknown as { imageDecodeGates: Record<string, () => void> }).imageDecodeGates
              .slow
          )
        )
      )
      .toBe(true);
    await expect(image).toBeHidden();
    await expect(dialog.getByRole('status')).toBeVisible();
    await page.screenshot({ path: info.outputPath('decoding.png'), animations: 'disabled' });
    await page.evaluate(() =>
      (window as unknown as { imageDecodeGates: Record<string, () => void> }).imageDecodeGates
        .slow!()
    );
    await expect(image).toBeVisible();
    expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(2560);
    expect(requests.some((url) => url.includes('maxWidth=2560&maxHeight=2560'))).toBe(true);
    const original = dialog.getByRole('button', { name: 'View original', exact: true });
    await expect(original).toBeVisible();
    const bounds = await image.boundingBox();
    expect(bounds!.width).toBeLessThan(viewport.width);
    expect(bounds!.height).toBeLessThan(viewport.height);
    await page.screenshot({ path: info.outputPath('ready.png'), animations: 'disabled' });
    halfSent = false;
    await original.click();
    await expect.poll(() => halfSent).toBe(true);
    await expect(image).toBeHidden();
    await expect(dialog.getByRole('status')).toBeVisible();
    finishTransfer();
    await expect(image).toBeVisible();
    expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(3600);
    expect(
      await dialog
        .locator('.decoded-preview-image')
        .evaluate((element) => element.scrollWidth > element.clientWidth)
    ).toBe(true);
    expect(new URL(requests.at(-1)!, imageOrigin).searchParams.has('maxWidth')).toBe(false);
    await expect(original).toHaveCount(0);
    const originalArea = dialog.locator('.decoded-preview-image');
    await originalArea.focus();
    await page.keyboard.press('ArrowDown');
    await expect
      .poll(() => originalArea.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath('original.png'), animations: 'disabled' });
  });
}

test('late decode cannot replace a different image or a closed dialog', async ({ page }) => {
  await page.goto(`${fixture.url}conversation-image-loading.html`);
  await page.locator('.conversation-user-image').click();
  await expect.poll(() => halfSent).toBe(true);
  finishTransfer();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as unknown as { imageDecodeGates: Record<string, () => void> }).imageDecodeGates
            .slow
        )
      )
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Second image', exact: true }).dispatchEvent('click');
  const image = page.getByRole('dialog').locator('img');
  await expect(image).toBeVisible();
  const fastSource = await image.getAttribute('src');
  expect(
    requests.some((value) => {
      const url = new URL(value, imageOrigin);
      return url.pathname.endsWith('/fast') && url.searchParams.get('maxWidth') === '2560';
    })
  ).toBe(true);
  await page.evaluate(() =>
    (window as unknown as { imageDecodeGates: Record<string, () => void> }).imageDecodeGates.slow!()
  );
  await expect(image).toHaveAttribute('src', fastSource!);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { previewObjectUrls: Set<string> }).previewObjectUrls.size
    )
  ).toBe(0);
  halfSent = false;
  await page.evaluate(() => {
    (window as unknown as { imageDecodeState: { block: boolean } }).imageDecodeState.block = true;
  });
  await page.locator('.conversation-user-image').click();
  await expect.poll(() => halfSent).toBe(true);
  finishTransfer();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as unknown as { imageDecodeGates: Record<string, () => void> }).imageDecodeGates
            .slow
        )
      )
    )
    .toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { imageDecodeGates: Record<string, () => void> }).imageDecodeGates.slow!()
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('[data-image-preview]').click();
  await expect(page.getByRole('dialog').locator('img')).toBeVisible();
  const last = new URL(requests.at(-1)!, imageOrigin);
  expect(last.pathname).toContain('/fast');
  expect(last.searchParams.get('maxWidth')).toBe('2560');
  expect(last.searchParams.get('maxHeight')).toBe('2560');
});

test('failed full-image loading offers retry without changing the original URL', async ({
  page
}) => {
  await page.goto(`${fixture.url}conversation-image-loading.html?first=retry`);
  await page.evaluate(() => {
    (window as unknown as { imageDecodeState: { block: boolean } }).imageDecodeState.block = false;
  });
  await page.locator('.conversation-user-image').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(dialog.locator('img')).toBeVisible();
  expect(retries).toBe(2);
});

test('a preview that was not resized has no original action', async ({ page }) => {
  await page.goto(`${fixture.url}conversation-image-loading.html?first=small`);
  await page.evaluate(() => {
    (window as unknown as { imageDecodeState: { block: boolean } }).imageDecodeState.block = false;
  });
  await page.locator('.conversation-user-image').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('img')).toBeVisible();
  expect(
    await dialog.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)
  ).toBe(640);
  await expect(dialog.getByRole('button', { name: 'View original', exact: true })).toHaveCount(0);
});

test('a valid Workspace attachment keeps its failed preview open for retry', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.url}conversation-image-loading.html?first=retry&attachment=1`);
  await page.evaluate(() => {
    (window as unknown as { imageDecodeState: { block: boolean } }).imageDecodeState.block = false;
  });
  await page.locator('.conversation-user-image').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(dialog.locator('img')).toBeVisible();
  expect(retries).toBe(2);
});

for (const width of [1440, 390]) {
  test(`localized original-image button remains readable beside a long filename at ${width}px`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const name = '项目运行记录与图片预览样式检查_'.repeat(8) + '.png';
    await page.goto(
      `${fixture.url}conversation-image-loading.html?first=fast&locale=zh-CN&theme=${width === 390 ? 'daylight' : 'dark'}&name=${encodeURIComponent(name)}`
    );
    await page.evaluate(() => {
      (window as unknown as { imageDecodeState: { block: boolean } }).imageDecodeState.block =
        false;
    });
    await page.locator('.conversation-user-image').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('img')).toBeVisible();
    const original = dialog.getByRole('button', { name: '查看原图', exact: true });
    await expect(original.locator('[data-mar-icon="image"]')).toBeVisible();
    await expect(original).not.toHaveClass(/\bis-text\b/u);
    await expect(original).toHaveCSS('border-top-style', 'solid');
    const originalBox = (await original.boundingBox())!;
    const closeBox = (await dialog.locator('.el-dialog__headerbtn').boundingBox())!;
    expect(originalBox.x + originalBox.width).toBeLessThanOrEqual(closeBox.x);
    await page.screenshot({ path: info.outputPath('original-button.png'), animations: 'disabled' });
    await original.click();
    await expect(dialog.locator('img')).toBeVisible();
    expect(
      await dialog.locator('img').evaluate((element: HTMLImageElement) => element.naturalWidth)
    ).toBe(3600);
  });
}

test('closing during transfer cannot allocate or restore a late preview', async ({ page }) => {
  await page.goto(`${fixture.url}conversation-image-loading.html`);
  await page.locator('.conversation-user-image').click();
  await expect.poll(() => halfSent).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  finishTransfer();
  expect(
    await page.evaluate(
      () => (window as unknown as { previewObjectUrls: Set<string> }).previewObjectUrls.size
    )
  ).toBe(0);
  await page.evaluate(() => {
    (window as unknown as { imageDecodeState: { block: boolean } }).imageDecodeState.block = false;
  });
  await page.getByRole('button', { name: 'Second image', exact: true }).click();
  await expect(page.getByRole('dialog').locator('img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { previewObjectUrls: Set<string> }).previewObjectUrls.size
      )
    )
    .toBe(0);
});
