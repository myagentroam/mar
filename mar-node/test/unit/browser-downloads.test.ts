import { mkdir, mkdtemp, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserDownloadPageSchema, type BrowserDownloadInfo } from '@myagentroam/protocol';
import type { Download, Page } from 'playwright';
import { expect, test, vi } from 'vitest';
import { BrowserDownloads } from '../../src/browser/browser-downloads.js';

test('tracks active downloads and deletes a completed temporary file only after settlement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-browser-downloads-'));
  const settled = Promise.withResolvers<void>();
  const downloads = new BrowserDownloads(() => {
    if (downloads.activeCount === 0) settled.resolve();
  }, vi.fn());
  try {
    const path = join(directory, 'chromium-artifact');
    await writeFile(path, 'data');
    const result = Promise.withResolvers<string | null>();
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
    downloads.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

function observeDownloads() {
  const changed = vi.fn();
  const failed = vi.fn();
  const downloads = new BrowserDownloads(changed, failed);
  let receive!: (download: Download) => void;
  const page = {
    on: (_event: 'download', callback: (download: Download) => void) => (receive = callback)
  };
  downloads.listen(page as unknown as Page);
  return {
    changed,
    downloads,
    failed,
    start(name: string, failure: Promise<string | null>, path?: string) {
      receive({
        suggestedFilename: () => name,
        failure: () => failure,
        path: async () => path
      } as Download);
    },
    async list() {
      const items: BrowserDownloadInfo[] = [];
      for (;;) {
        const page = browserDownloadPageSchema.parse(
          await downloads.execute({ action: 'list', offset: items.length })
        );
        items.push(...page.items);
        if (!page.more) return items;
      }
    }
  };
}

test('an open context expires files from completion, not from download start or save activity', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const root = await mkdtemp(join(tmpdir(), 'mar-browser-download-retention-'));
  const early = join(root, 'early');
  const late = join(root, 'late');
  const { downloads, start, list, changed, failed } = observeDownloads();
  const long = Promise.withResolvers<string | null>();
  const hour = 60 * 60_000;
  try {
    await Promise.all([writeFile(early, 'old'), writeFile(late, 'late')]);
    start('early', Promise.resolve(null), early);
    start('late', long.promise, late);
    start('active', new Promise(() => {}));
    await expect.poll(async () => (await list()).at(-1)?.state).toBe('ready');
    const old = (await list()).at(-1)!;

    clock.mockReturnValue(30 * 24 * hour - 1);
    await vi.advanceTimersByTimeAsync(hour);
    expect((await list()).find(({ id }) => id === old.id)?.state).toBe('ready');
    long.resolve(null);
    await expect
      .poll(async () => (await list()).find(({ name }) => name === 'late')?.state)
      .toBe('ready');
    // A fresh HTTP save protects the expiring file across the hourly sweep.
    await downloads.execute({ action: 'info', id: old.id });
    clock.mockReturnValue(30 * 24 * hour);
    await vi.advanceTimersByTimeAsync(hour);
    expect(await downloads.execute({ action: 'read', id: old.id, offset: 0, limit: 3 })).toEqual({
      contentBase64: Buffer.from('old').toString('base64'),
      offset: 0
    });
    const before = changed.mock.calls.length;
    clock.mockReturnValue(30 * 24 * hour + hour);
    await vi.advanceTimersByTimeAsync(hour);
    await expect
      .poll(async () => (await list()).map(({ name }) => name))
      .toEqual(['active', 'late']);
    await expect(stat(early)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(changed.mock.calls.length).toBeGreaterThan(before);
    expect(downloads.activeCount).toBe(1);
    expect(failed).not.toHaveBeenCalled();
  } finally {
    downloads.dispose();
    expect(vi.getTimerCount()).toBe(0);
    clock.mockRestore();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});

test('bounds settled records without evicting ongoing downloads', async () => {
  const { downloads, start, list } = observeDownloads();
  try {
    start('active', new Promise(() => {}));
    for (let i = 0; i < 260; i++) start(`failed-${i}`, Promise.resolve('interrupted'));
    await expect.poll(async () => (await list()).length).toBe(257);
    expect((await list()).slice(-2).map(({ name }) => name)).toEqual(['failed-4', 'active']);
    expect(downloads.activeCount).toBe(1);
  } finally {
    downloads.dispose();
  }
});

test('a manual deletion already in flight satisfies the record budget without evicting another item', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-browser-download-manual-'));
  const { downloads, start, list } = observeDownloads();
  try {
    const path = join(root, 'download');
    await writeFile(path, 'data');
    for (let i = 0; i < 255; i++) start(`failed-${i}`, Promise.resolve('interrupted'));
    start('manual', Promise.resolve(null), path);
    const extra = Promise.withResolvers<string | null>();
    start('extra', extra.promise);
    await expect.poll(async () => (await list())[1]?.state).toBe('ready');

    const removal = downloads.execute({ action: 'delete', id: (await list())[1]!.id });
    extra.resolve('interrupted');
    await removal;
    await expect
      .poll(async () => (await list()).find(({ name }) => name === 'extra')?.state)
      .toBe('failed');
    const items = await list();
    expect(items).toHaveLength(256);
    expect(items.at(-1)?.name).toBe('failed-0');
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    downloads.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('file pressure removes the older file but keeps the latest even above the byte target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-browser-download-budget-'));
  const { downloads, start, list, failed } = observeDownloads();
  try {
    const previous = join(root, 'previous');
    const latest = join(root, 'latest');
    await writeFile(previous, 'previous');
    await writeFile(latest, 'latest');
    // Sparse file: exercise real stat/unlink without allocating a gigabyte.
    await truncate(latest, 1024 ** 3 + 1);
    start('previous', Promise.resolve(null), previous);
    await expect.poll(async () => (await list())[0]?.state).toBe('ready');
    start('latest', Promise.resolve(null), latest);
    await expect
      .poll(async () => (await list()).map(({ name, state }) => [name, state]))
      .toEqual([['latest', 'ready']]);
    await expect(stat(previous)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(latest)).size).toBe(1024 ** 3 + 1);
    expect(failed).not.toHaveBeenCalled();
  } finally {
    downloads.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed removal retains the record and a later sweep retries it', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const root = await mkdtemp(join(tmpdir(), 'mar-browser-download-removal-'));
  const path = join(root, 'download');
  const saved = join(root, 'original');
  const { downloads, start, list, failed } = observeDownloads();
  const hour = 60 * 60_000;
  try {
    await writeFile(path, 'data');
    start('old', Promise.resolve(null), path);
    await expect.poll(async () => (await list())[0]?.state).toBe('ready');
    // Replace the path with a directory to make the nonrecursive unlink fail.
    await rename(path, saved);
    await mkdir(path);
    clock.mockReturnValue(30 * 24 * hour);
    await vi.advanceTimersByTimeAsync(hour);
    await expect.poll(() => failed.mock.calls.length).toBe(1);
    expect((await list())[0]?.state).toBe('ready');

    await rm(path, { recursive: true });
    await rename(saved, path);
    await vi.advanceTimersByTimeAsync(hour);
    await expect.poll(list).toEqual([]);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    downloads.dispose();
    clock.mockRestore();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});
