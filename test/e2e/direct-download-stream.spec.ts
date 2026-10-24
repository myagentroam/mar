import { stat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { directDownloadServiceWorkerPlugin } from '../../packages/web-core/scripts/direct-download-service-worker.js';

// This standalone service fixture uses the production page bridge and Service Worker,
// not the Workbench, a fake download, or a mocked MessageChannel.
// @test-covers packages/web-core/src/service/workspace-direct-download-stream-service.ts
for (const [fileName, content] of [
  ['empty.bin', ''],
  ['nonempty.bin', 'direct download']
] as const) {
  test(`Service Worker completes the browser download and cleans up ${fileName}`, async ({
    page
  }, testInfo) => {
    const root = resolve(import.meta.dirname, '../..');
    const server = await createServer({
      root,
      configFile: false,
      plugins: [directDownloadServiceWorkerPlugin()],
      optimizeDeps: { entries: ['test/e2e/support/direct-download.html'] },
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
      logLevel: 'error'
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls!.local[0]!;
      await page.goto(`${origin}test/e2e/support/direct-download.html`);
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: fileName, exact: true }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(fileName);
      const path = testInfo.outputPath(fileName);
      await download.saveAs(path);
      expect(await download.failure()).toBeNull();
      expect((await stat(path)).size).toBe(Buffer.byteLength(content));
      expect(await readFile(path, 'utf8')).toBe(content);
      await expect(page.locator('output')).toHaveText('closed');
      // Only the real Worker's finished event removes the page bridge frame.
      await expect(page.locator('iframe')).toHaveCount(0);
      await testInfo.attach(fileName, { path, contentType: 'application/octet-stream' });
    } finally {
      await page.goto('about:blank').catch(() => undefined);
      await server.close();
    }
  });
}
