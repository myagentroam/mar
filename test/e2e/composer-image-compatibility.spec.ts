import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

// @test-covers packages/web-core/src/util/composer-image-compatibility.ts
// @test-covers packages/web-core/src/service/composer-attachment-service.ts
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/composer-image-compatibility.html');
});
test.afterAll(async () => fixture?.close());

for (const mimeType of ['image/bmp', 'image/x-windows-bmp']) {
  test(`uploads a full-resolution PNG from a 16-bit RGB565 oscilloscope BMP (${mimeType})`, async ({
    page
  }) => {
    const width = 800;
    const height = 480;
    const bmp = Buffer.alloc(66 + width * height * 2);
    bmp.write('BM');
    bmp.writeUInt32LE(bmp.length, 2);
    bmp.writeUInt32LE(66, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(width, 18);
    bmp.writeInt32LE(height, 22);
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(16, 28);
    bmp.writeUInt32LE(3, 30);
    bmp.writeUInt32LE(width * height * 2, 34);
    bmp.writeUInt32LE(0xf800, 54);
    bmp.writeUInt32LE(0x07e0, 58);
    bmp.writeUInt32LE(0x001f, 62);
    for (let offset = 66; offset < bmp.length; offset += 2) bmp.writeUInt16LE(0x07e0, offset);

    await page.goto(`${fixture.url}composer-image-compatibility.html`);
    await page.locator('#attachment').setInputFiles({ name: 'scope.bmp', mimeType, buffer: bmp });
    await expect(page.locator('#result')).toContainText('scope.png');
    const result = JSON.parse((await page.locator('#result').textContent()) ?? '{}');
    expect(result).toMatchObject({
      name: 'scope.png',
      mime: 'image/png',
      width,
      height,
      pixel: [0, 255, 0, 255],
      signature: [137, 80, 78, 71, 13, 10, 26, 10],
      descriptor: { fileName: 'scope.png', composerAttachment: { mime: 'image/png' } }
    });
  });
}
