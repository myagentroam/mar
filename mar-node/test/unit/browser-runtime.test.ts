import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrowserContext, CDPSession } from 'playwright';
import { expect, it, vi } from 'vitest';
import { BrowserRuntime } from '../../src/browser/browser-runtime.js';

const scope = { workspaceId: 'workspace', userId: 1 };

it('keeps a detached browser alive only while a download receives new bytes', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  const profileRoot = await mkdtemp(join(tmpdir(), 'mar-browser-download-idle-'));
  const context = Object.assign(new EventEmitter(), { pages: () => [] });
  const cdp = new EventEmitter();
  const close = vi.fn(async () => {
    context.emit('close');
  });
  const runtime = new BrowserRuntime({
    maxBrowsers: 1,
    profileRoot,
    profileUnused: async () => true,
    launch: async () => ({
      context: context as unknown as BrowserContext,
      downloads: { session: cdp as unknown as CDPSession, directory: profileRoot },
      close
    }),
    failed: vi.fn()
  });
  const guid = 'dc17dcf2-df54-4095-aeb5-5fd7c50e071b';
  const progress = (receivedBytes: number, totalBytes: number) =>
    cdp.emit('Browser.downloadProgress', { guid, state: 'inProgress', receivedBytes, totalBytes });
  const minute = 60_000;
  try {
    const id = await runtime.open(scope);
    cdp.emit('Browser.downloadWillBegin', { guid, suggestedFilename: 'large.bin' });
    progress(1024, 0);
    // No Web attachment or Playwright client is connected after download starts.
    await vi.advanceTimersByTimeAsync(14 * minute);
    progress(2048, 0);
    await vi.advanceTimersByTimeAsync(minute);
    expect(runtime.lookup(scope)).toBe(id);
    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * minute);
    progress(2048, 4096); // Only the total size became known.
    progress(1024, 4096); // A restarted or regressed counter does not count twice.
    progress(2048, 4096);
    cdp.emit('Browser.downloadWillBegin', {
      guid: 'c0cfda08-e2e0-406d-957f-99dff47bbaa5',
      suggestedFilename: 'stalled.bin'
    });
    await vi.advanceTimersByTimeAsync(9 * minute - 1);
    expect(runtime.lookup(scope)).toBe(id);
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.lookup(scope)).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    try {
      await runtime.shutdown();
    } finally {
      vi.useRealTimers();
      await rm(profileRoot, { recursive: true, force: true });
    }
  }
});

it('protects background downloads from capacity eviction until they settle', async () => {
  const profileRoot = await mkdtemp(join(tmpdir(), 'mar-browser-download-capacity-'));
  function createBrowser(cdp = new EventEmitter()) {
    const context = Object.assign(new EventEmitter(), { pages: () => [] });
    return {
      context: context as unknown as BrowserContext,
      downloads: { session: cdp as unknown as CDPSession, directory: profileRoot },
      close: vi.fn(async () => {
        context.emit('close');
      })
    };
  }
  const cdp = new EventEmitter();
  const downloading = createBrowser(cdp);
  const otherCdp = new EventEmitter();
  const launch = vi
    .fn(async () => createBrowser())
    .mockResolvedValueOnce(downloading)
    .mockResolvedValueOnce(createBrowser(otherCdp));
  const runtime = new BrowserRuntime({
    maxBrowsers: 2,
    profileRoot,
    profileUnused: async () => true,
    launch,
    failed: vi.fn()
  });
  const idle = { ...scope, workspaceId: 'idle' };
  const next = { ...scope, workspaceId: 'next' };
  const guid = 'dc17dcf2-df54-4095-aeb5-5fd7c50e071b';
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  try {
    const id = await runtime.open(scope);
    cdp.emit('Browser.downloadWillBegin', { guid, suggestedFilename: 'large.bin' });
    cdp.emit('Browser.downloadProgress', { guid, state: 'inProgress', receivedBytes: 1024 });
    now.mockReturnValue(1);
    await runtime.open(idle);

    otherCdp.emit('Browser.downloadWillBegin', { guid, suggestedFilename: 'other.bin' });
    await expect(runtime.open(next)).rejects.toThrow('BROWSER_CAPACITY');
    otherCdp.emit('Browser.downloadProgress', { guid, state: 'canceled' });

    // The downloading instance is older and has no Web or Playwright connection.
    now.mockReturnValue(2);
    await runtime.open(next);
    expect(runtime.lookup(scope)).toBe(id);
    expect(runtime.lookup(idle)).toBeUndefined();
    expect(downloading.close).not.toHaveBeenCalled();

    cdp.emit('Browser.downloadProgress', { guid, state: 'canceled' });
    await runtime.open(idle);
    expect(runtime.lookup(scope)).toBeUndefined();
    expect(downloading.close).toHaveBeenCalledOnce();
  } finally {
    try {
      await runtime.shutdown();
    } finally {
      now.mockRestore();
      await rm(profileRoot, { recursive: true, force: true });
    }
  }
});

it('releases the live slot after confirmed exit even if the profile marker cannot be written', async () => {
  const profileRoot = await mkdtemp(join(tmpdir(), 'mar-browser-close-'));
  const failed = vi.fn();
  const close = vi.fn(async () => {});
  const profileUnused = vi.fn(async () => true);
  let markerTemp: string | undefined;
  const runtime = new BrowserRuntime({
    maxBrowsers: 1,
    profileRoot,
    profileUnused,
    launch: async (profilePath) => {
      if (profilePath) markerTemp = join(dirname(profilePath), 'retention.tmp');
      const context = Object.assign(new EventEmitter(), { pages: () => [] });
      return { context: context as unknown as BrowserContext, close };
    },
    failed
  });
  try {
    const id = await runtime.open(scope, true);
    const blockedMarker = markerTemp!;
    await mkdir(blockedMarker);
    try {
      await runtime.close(scope, id);
    } finally {
      await rm(blockedMarker, { recursive: true });
    }
    expect(close).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expect(await runtime.open({ ...scope, userId: 2 })).not.toBe(id);
    expect(await runtime.open(scope, true)).not.toBe(id);
    expect(profileUnused).toHaveBeenCalledOnce();
  } finally {
    await runtime.shutdown().catch(() => undefined);
    await rm(profileRoot, { recursive: true, force: true });
  }
});
