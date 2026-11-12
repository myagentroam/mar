import { beforeEach, expect, it, vi } from 'vitest';
import {
  windowsDesktopLayout,
  WindowsRemoteDesktopRuntime
} from '../../src/remote-desktop/windows-remote-desktop-runtime.js';

const query = vi.hoisted(() => vi.fn<() => Promise<{ stdout: string }>>());
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return {
    ...original,
    execFile: Object.assign(vi.fn(), { [promisify.custom]: query })
  };
});

beforeEach(() => query.mockReset());

it('maps each Windows monitor into the full virtual framebuffer', () => {
  const layout = windowsDesktopLayout(
    [
      { name: 'DISPLAY1', primary: true, x: 0, y: 0, width: 1920, height: 1080 },
      { name: 'DISPLAY2', primary: false, x: -1280, y: 120, width: 1280, height: 1024 }
    ],
    'desktop-generation',
    1
  );
  expect(layout.framebuffer).toEqual({ width: 3200, height: 1144 });
  expect(layout.displays[0]?.framebufferBounds).toEqual({
    x: 1280,
    y: 0,
    width: 1920,
    height: 1080
  });
  expect(layout.displays[1]?.framebufferBounds).toEqual({
    x: 0,
    y: 120,
    width: 1280,
    height: 1024
  });
  expect(layout.displays[1]?.nativeToFramebuffer).toEqual([1, 0, 0, 1, 1280, 0]);
  expect(() => windowsDesktopLayout([], 'desktop-generation', 1)).toThrowError(
    expect.objectContaining({ code: 'DESKTOP_TOPOLOGY_UNAVAILABLE' })
  );
});

it('preserves physical pixels and negative origins across mixed-DPI monitors', () => {
  const layout = windowsDesktopLayout(
    [
      { name: 'DISPLAY1', primary: true, x: 0, y: 0, width: 2560, height: 1600 },
      { name: 'DISPLAY2', primary: false, x: 2560, y: -261, width: 3840, height: 2160 }
    ],
    'desktop-generation',
    1
  );
  expect(layout.framebuffer).toEqual({ width: 6400, height: 2160 });
  expect(layout.displays.map((display) => display.framebufferBounds)).toEqual([
    { x: 0, y: 261, width: 2560, height: 1600 },
    { x: 2560, y: 0, width: 3840, height: 2160 }
  ]);
  expect(layout.displays.map((display) => display.nativeToFramebuffer)).toEqual([
    [1, 0, 0, 1, 0, 261],
    [1, 0, 0, 1, 0, 261]
  ]);
});

it.each(['success', 'failure'] as const)(
  'serializes topology queries and continues after an earlier query ends in %s',
  async (outcome) => {
    const screen = { name: 'DISPLAY1', primary: true, x: 0, y: 0, width: 1920, height: 1080 };
    const previous = { stdout: JSON.stringify([screen]) };
    const current = {
      stdout: JSON.stringify([{ ...screen, width: 2560, height: 1440 }])
    };
    query.mockResolvedValueOnce(previous);
    const fence = vi.fn();
    const runtime = await WindowsRemoteDesktopRuntime.start(
      { binaryPath: 'unused', maxPixels: 10_000_000, fence },
      new AbortController().signal
    );
    const older = Promise.withResolvers<{ stdout: string }>();
    const newer = Promise.withResolvers<{ stdout: string }>();
    const entered = Promise.withResolvers<void>();
    const failure = new Error('PowerShell query failed');
    let results: Promise<PromiseSettledResult<void>[]> | undefined;
    try {
      const initial = runtime.describe();
      query
        .mockImplementationOnce(() => {
          entered.resolve();
          return older.promise;
        })
        .mockImplementationOnce(() => newer.promise);
      results = Promise.allSettled([
        runtime.refresh(new AbortController().signal),
        runtime.refresh(new AbortController().signal)
      ]);
      await entered.promise;
      // The initial probe and first refresh have started; the second refresh must wait.
      expect(query).toHaveBeenCalledTimes(2);
      newer.resolve(current);
      if (outcome === 'failure') older.reject(failure);
      else older.resolve(previous);
      expect(await results).toEqual([
        outcome === 'failure'
          ? { status: 'rejected', reason: failure }
          : { status: 'fulfilled', value: undefined },
        { status: 'fulfilled', value: undefined }
      ]);
      const layout = runtime.describe();
      expect(layout.framebuffer).toEqual({ width: 2560, height: 1440 });
      expect(layout.desktopGeneration).toBe(initial.desktopGeneration);
      expect(layout.topologyRevision).toBe(initial.topologyRevision + 1);
      expect(query).toHaveBeenCalledTimes(3);
      expect(fence).toHaveBeenCalledExactlyOnceWith('DESKTOP_TOPOLOGY_UNAVAILABLE');
    } finally {
      older.resolve(previous);
      newer.resolve(current);
      await results;
      await runtime.dispose();
    }
  }
);
