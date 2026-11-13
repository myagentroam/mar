import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

const previewModule = '/packages/web-core/src/service/workspace-direct-object-url-service.ts';

async function createPreview(page: Page) {
  return page.evaluate(async (modulePath) => {
    const service = await import(modulePath);
    const target = await service.createWorkspaceDirectObjectUrlSink('preview.bin');
    await target.sink.write(new Uint8Array(64 * 1024).fill(42));
    await target.sink.close();
    return target.objectUrl() as Promise<string>;
  }, previewModule);
}

async function previewFiles(page: Page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const previews = await root.getDirectoryHandle('mar-direct-preview');
    const managed = await previews.getDirectoryHandle('managed-v1');
    const files: number[] = [];
    const entries = managed as FileSystemDirectoryHandle & {
      values(): AsyncIterableIterator<FileSystemFileHandle>;
    };
    for await (const handle of entries.values()) files.push((await handle.getFile()).size);
    return files;
  });
}

test('reclaims refreshed preview storage without deleting another window or legacy files', async ({
  page,
  context
}, testInfo) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/conversation-tool-detail.html', {
    protocolSource: true
  });
  const other = await context.newPage();
  const samples: unknown[] = [];
  try {
    const url = `${fixture.url}conversation-tool-detail.html?timeline=1&unified=1&performance=1`;
    await page.goto(url);
    await other.goto(url);
    const first = await createPreview(page);
    const second = await createPreview(other);
    expect(await previewFiles(page)).toEqual([65536, 65536]);
    expect(
      await page.evaluate(async (url) => (await (await fetch(url)).arrayBuffer()).byteLength, first)
    ).toBe(65536);
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const previews = await root.getDirectoryHandle('mar-direct-preview');
      const legacy = await previews.getFileHandle('legacy-preview.bin', { create: true });
      const writer = await legacy.createWritable();
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.close();
    });
    await page.evaluate(
      async ({ modulePath, url }) => {
        (await import(modulePath)).revokeWorkspaceDirectObjectUrl(url);
      },
      { modulePath: previewModule, url: first }
    );
    await expect.poll(async () => (await previewFiles(other)).length).toBe(1);
    expect(
      await other.evaluate(
        async (url) => (await (await fetch(url)).arrayBuffer()).byteLength,
        second
      )
    ).toBe(65536);
    for (let i = 0; i < 3; i++) {
      await other.reload();
      await createPreview(other);
      const files = await previewFiles(other);
      expect(files).toEqual([65536]);
      samples.push({ reload: i + 1, files });
    }
    const legacyBytes = await other.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const previews = await root.getDirectoryHandle('mar-direct-preview');
      return (await (await previews.getFileHandle('legacy-preview.bin')).getFile()).size;
    });
    expect(legacyBytes).toBe(3);
    await writeFile(
      testInfo.outputPath('preview-storage-samples.json'),
      JSON.stringify(samples, null, 2)
    );
  } finally {
    await other.close();
    await fixture.close();
  }
});
