import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  macosCombinedDesktopLayout,
  MacosRemoteDesktopRuntime
} from '../../src/remote-desktop/macos-remote-desktop-runtime.js';

it('maps a combined desktop with negative origin and mixed display scales', () => {
  const layout = macosCombinedDesktopLayout(
    [
      {
        id: 2,
        primary: false,
        x: -1280,
        y: 100,
        width: 1280,
        height: 720,
        pixelWidth: 1280,
        pixelHeight: 720
      },
      {
        id: 1,
        primary: true,
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
        pixelWidth: 2880,
        pixelHeight: 1800
      }
    ],
    'desktop-generation',
    1
  );
  expect(layout.framebuffer).toEqual({ width: 5440, height: 1800 });
  expect(layout.displays[0]?.framebufferBounds).toEqual({
    x: 0,
    y: 200,
    width: 2560,
    height: 1440
  });
  expect(layout.displays[1]?.framebufferBounds).toEqual({
    x: 2560,
    y: 0,
    width: 2880,
    height: 1800
  });
  expect(layout.displays[0]?.nativeToFramebuffer).toEqual([2, 0, 0, 2, 2560, 0]);
});

it('describes a single display at its native pixel scale and rejects an empty topology', () => {
  const layout = macosCombinedDesktopLayout(
    [
      {
        id: 1,
        primary: true,
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
        pixelWidth: 2880,
        pixelHeight: 1800
      }
    ],
    'desktop-generation',
    1
  );
  expect(layout.framebuffer).toEqual({ width: 2880, height: 1800 });
  expect(layout.displays).toHaveLength(1);
  expect(layout.displays[0]?.nativeToFramebuffer).toEqual([2, 0, 0, 2, 0, 0]);
  expect(() => macosCombinedDesktopLayout([], 'desktop-generation', 1)).toThrowError(
    expect.objectContaining({ code: 'DESKTOP_TOPOLOGY_UNAVAILABLE' })
  );
});

it('refreshes the layout when a secondary display changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mar-macos-layout-'));
  const topology = join(dir, 'topology.json');
  const helper = join(dir, 'topology');
  const primary = {
    id: 1,
    primary: true,
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    pixelWidth: 800,
    pixelHeight: 600
  };
  const secondary = {
    id: 2,
    primary: false,
    x: -640,
    y: 0,
    width: 640,
    height: 480,
    pixelWidth: 640,
    pixelHeight: 480
  };
  try {
    await writeFile(
      helper,
      `#!/usr/bin/env node\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(topology)}))\n`,
      { mode: 0o755 }
    );
    await writeFile(topology, JSON.stringify({ displays: [primary] }));
    const fence = vi.fn();
    const runtime = await MacosRemoteDesktopRuntime.start(
      {
        binaryPath: 'unused',
        topologyBinary: helper,
        maxPixels: 10_000_000,
        fence
      },
      new AbortController().signal
    );
    await writeFile(topology, JSON.stringify({ displays: [secondary, primary] }));
    await runtime.refresh(new AbortController().signal);
    expect(runtime.describe()).toMatchObject({
      topologyRevision: 2,
      framebuffer: { width: 1440, height: 600 },
      displays: [{ displayId: 'display_1' }, { displayId: 'display_2' }]
    });
    expect(fence).toHaveBeenCalledWith('DESKTOP_TOPOLOGY_UNAVAILABLE');
    await runtime.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
