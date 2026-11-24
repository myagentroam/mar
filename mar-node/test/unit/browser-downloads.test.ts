import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserDownloadPageSchema } from '@myagentroam/protocol';
import type { Download, Page } from 'playwright';
import { expect, test } from 'vitest';
import { BrowserDownloads } from '../../src/browser/browser-downloads.js';

test('tracks active downloads and deletes a completed temporary file only after settlement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-browser-downloads-'));
  try {
    const path = join(directory, 'chromium-artifact');
    await writeFile(path, 'data');
    const result = Promise.withResolvers<string | null>();
    const settled = Promise.withResolvers<void>();
    const downloads = new BrowserDownloads(() => {
      if (downloads.activeCount === 0) settled.resolve();
    });
    const native = {
      suggestedFilename: () => 'report.txt',
      failure: () => result.promise,
      path: async () => path
    } satisfies Pick<Download, 'suggestedFilename' | 'failure' | 'path'>;
    const page = {
      on: (_event: 'download', receive: (download: Download) => void) => receive(native as Download)
    };
    downloads.listen(page as unknown as Page);
    const list = async () =>
      browserDownloadPageSchema.parse(await downloads.execute({ action: 'list', offset: 0 }));
    const entry = (await list()).items[0]!;
    expect(entry).toMatchObject({ state: 'downloading', name: 'report.txt' });
    expect(downloads.activeCount).toBe(1);
    await expect(downloads.execute({ action: 'delete', id: entry.id })).rejects.toThrow(
      'BROWSER_DOWNLOAD_IN_PROGRESS'
    );

    result.resolve(null);
    await settled.promise;
    expect((await list()).items).toEqual([{ ...entry, state: 'ready', size: 4 }]);
    await downloads.execute({ action: 'delete', id: entry.id });
    expect((await list()).items).toEqual([]);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(downloads.execute({ action: 'info', id: entry.id })).rejects.toThrow(
      'BROWSER_DOWNLOAD_ENDED'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
