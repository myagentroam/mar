import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { expect, it, vi } from 'vitest';
import { BrowserRuntime } from '../../src/browser/browser-runtime.js';

const scope = { workspaceId: 'workspace', userId: 1 };

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
    encoder: async () => {
      throw new Error('No attachment expected');
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
