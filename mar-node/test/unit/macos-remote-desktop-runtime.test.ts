import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  macosCombinedDesktopLayout,
  MacosRemoteDesktopRuntime
} from '../../src/remote-desktop/macos-remote-desktop-runtime.js';
import { MacVncManagedProcess } from '../../src/remote-desktop/macvnc-managed-process.js';
import { TigerVncRfbSession } from '../../src/remote-desktop/tigervnc-rfb-session.js';
import { DesktopByteStream } from '../../src/remote-desktop/desktop-byte-stream.js';

it.each(['none', 'before', 'after', 'cancelled'] as const)(
  'isolates per-display backends and retains cleanup ownership when topology races startup: %s',
  async (race) => {
    const dir = await mkdtemp(join(tmpdir(), 'mar-macos-capture-'));
    const topology = join(dir, 'topology.json');
    const helper = join(dir, 'topology');
    const screens = [
      {
        id: 8,
        primary: false,
        x: -640,
        y: 0,
        width: 640,
        height: 480,
        pixelWidth: 1280,
        pixelHeight: 960
      },
      {
        id: 3,
        primary: true,
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        pixelWidth: 800,
        pixelHeight: 600
      }
    ];
    const backends = screens.map(() => ({
      connect: vi.fn(async () => ({})),
      stop: vi.fn(async () => {})
    }));
    const start = vi.spyOn(MacVncManagedProcess, 'start').mockImplementation(async (options) => {
      if (race === 'after')
        await writeFile(topology, JSON.stringify({ displays: [...screens].reverse() }));
      return backends[options.displayIndex!] as unknown as MacVncManagedProcess;
    });
    const session = vi
      .spyOn(TigerVncRfbSession, 'open')
      .mockImplementation(async (options, signal) => {
        await options.backend.connect(10_000_000, signal);
        return { fence() {}, close: async () => {} } as unknown as TigerVncRfbSession;
      });
    let runtime: MacosRemoteDesktopRuntime | undefined;
    const attachments: ReturnType<MacosRemoteDesktopRuntime['createAttachment']>[] = [];
    const frontends: DesktopByteStream[] = [];
    const fence = vi.fn();
    try {
      await writeFile(
        helper,
        `#!/usr/bin/env node\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(topology)}))\n`,
        { mode: 0o755 }
      );
      await writeFile(topology, JSON.stringify({ displays: screens }));
      runtime = await MacosRemoteDesktopRuntime.start(
        { binaryPath: 'unused', topologyBinary: helper, maxPixels: 10_000_000, fence },
        new AbortController().signal
      );
      const create = (displayId: string) => {
        const layout = runtime!.describe({ displayId });
        const frontend = new DesktopByteStream(
          { readyState: 'open', close: vi.fn() } as unknown as RTCDataChannel,
          65_536
        );
        frontends.push(frontend);
        const attachment = runtime!.createAttachment(
          {
            attachmentId: `attachment-${attachments.length}`,
            desktopGeneration: layout.desktopGeneration,
            topologyRevision: layout.topologyRevision,
            mode: 'VIEW'
          },
          frontend,
          { attached: vi.fn(), failed: vi.fn() }
        );
        attachments.push(attachment);
        return attachment;
      };
      const secondary = runtime.describe({ displayId: 'display_8' });
      const previousBinding = {
        attachmentId: 'previous',
        desktopGeneration: secondary.desktopGeneration,
        topologyRevision: secondary.topologyRevision,
        mode: 'VIEW' as const
      };
      const first = create('display_3');
      if (race === 'before') {
        await writeFile(topology, JSON.stringify({ displays: [...screens].reverse() }));
        await expect(first.open(new AbortController().signal)).rejects.toMatchObject({
          code: 'DESKTOP_TOPOLOGY_UNAVAILABLE'
        });
        expect(start).not.toHaveBeenCalled();
        expect(runtime.isCurrent(previousBinding)).toBe(false);
        expect(fence).toHaveBeenCalledExactlyOnceWith('DESKTOP_TOPOLOGY_UNAVAILABLE');
        await first.close(new AbortController().signal);
      } else if (race === 'cancelled') {
        const controller = new AbortController();
        const opening = first.open(controller.signal);
        await Promise.resolve();
        controller.abort();
        await expect(opening).rejects.toThrow();
        expect(start).not.toHaveBeenCalled();
        expect(fence).not.toHaveBeenCalled();
        expect(runtime.isCurrent(previousBinding)).toBe(true);
        await first.close(new AbortController().signal);
      } else if (race === 'after') {
        backends[1]!.stop.mockRejectedValueOnce(new Error('stop failed'));
        await expect(first.open(new AbortController().signal)).rejects.toMatchObject({
          code: 'DESKTOP_TOPOLOGY_UNAVAILABLE'
        });
        expect(backends[1]!.connect).not.toHaveBeenCalled();
        expect(backends[1]!.stop).not.toHaveBeenCalled();
        await expect(first.close(new AbortController().signal)).rejects.toThrow('stop failed');
        expect(backends[1]!.stop).toHaveBeenCalledOnce();
        expect(runtime.isCurrent(previousBinding)).toBe(false);
        expect(fence).toHaveBeenCalledExactlyOnceWith('DESKTOP_TOPOLOGY_UNAVAILABLE');
        await first.close(new AbortController().signal);
        expect(backends[1]!.stop).toHaveBeenCalledTimes(2);
      } else {
        await first.open(new AbortController().signal);
        const peer = create('display_3');
        await peer.open(new AbortController().signal);
        const other = create('display_8');
        await other.open(new AbortController().signal);
        expect(start.mock.calls.map(([options]) => options.displayIndex)).toEqual([1, 0]);
        await first.close(new AbortController().signal);
        expect(backends[1]!.stop).not.toHaveBeenCalled();
        await other.close(new AbortController().signal);
        expect(backends[0]!.stop).toHaveBeenCalledOnce();
        expect(backends[1]!.stop).not.toHaveBeenCalled();
        await peer.close(new AbortController().signal);
        expect(backends[1]!.stop).toHaveBeenCalledOnce();
      }
      if (race === 'before' || race === 'after') {
        await runtime.refresh(new AbortController().signal);
        const recovered = runtime.describe({ displayId: 'display_8' });
        expect(runtime.isCurrent(previousBinding)).toBe(false);
        expect(
          runtime.isCurrent({ ...previousBinding, topologyRevision: recovered.topologyRevision })
        ).toBe(true);
      }
    } finally {
      await Promise.all(
        attachments.map((attachment) => attachment.close(new AbortController().signal))
      );
      await runtime?.dispose();
      frontends.forEach((frontend) => frontend.destroy());
      start.mockRestore();
      session.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  }
);

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

it.each([
  { width: 2560, height: 1440, pixelWidth: 3840, pixelHeight: 2160 },
  { width: 853, height: 480, pixelWidth: 1280, pixelHeight: 720 }
])('preserves actual primary framebuffer pixels for scaled bounds %j', (bounds) => {
  const layout = macosCombinedDesktopLayout(
    [{ id: 1, primary: true, x: 0, y: 0, ...bounds }],
    'desktop-generation',
    1
  );
  expect(layout.framebuffer).toEqual({ width: bounds.pixelWidth, height: bounds.pixelHeight });
  expect(layout.displays[0]?.framebufferBounds).toEqual({
    x: 0,
    y: 0,
    width: bounds.pixelWidth,
    height: bounds.pixelHeight
  });
  expect(layout.displays[0]?.nativeToFramebuffer).toEqual([
    bounds.pixelWidth / bounds.width,
    0,
    0,
    bounds.pixelHeight / bounds.height,
    0,
    0
  ]);
});

it.each(['oversized', 'empty', 'malformed'] as const)(
  'fences both capture generations before rejecting a %s topology and never revives old grants',
  async (failure) => {
    const dir = await mkdtemp(join(tmpdir(), 'mar-macos-invalid-layout-'));
    const topology = join(dir, 'topology.json');
    const helper = join(dir, 'topology');
    const primary = {
      id: 1,
      primary: true,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      pixelWidth: 100,
      pixelHeight: 100
    };
    const secondary = { ...primary, id: 2, primary: false, x: 100 };
    const valid = JSON.stringify({ displays: [primary, secondary] });
    const invalid =
      failure === 'oversized'
        ? JSON.stringify({
            displays: [primary, { ...secondary, pixelWidth: 1000, pixelHeight: 1000 }]
          })
        : failure === 'empty'
          ? JSON.stringify({ displays: [] })
          : '{';
    const fence = vi.fn();
    let runtime: MacosRemoteDesktopRuntime | undefined;
    try {
      await writeFile(
        helper,
        `#!/usr/bin/env node\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(topology)}))\n`,
        { mode: 0o755 }
      );
      await writeFile(topology, valid);
      runtime = await MacosRemoteDesktopRuntime.start(
        { binaryPath: 'unused', topologyBinary: helper, maxPixels: 100_000, fence },
        new AbortController().signal
      );
      const bindings = [runtime.describe(), runtime.describe({ displayId: 'display_2' })].map(
        (description) => ({
          attachmentId: 'attachment-test',
          mode: 'VIEW' as const,
          desktopGeneration: description.desktopGeneration,
          topologyRevision: description.topologyRevision
        })
      );
      expect(bindings.every((binding) => runtime!.isCurrent(binding))).toBe(true);
      fence.mockImplementationOnce(() => {
        expect(bindings.every((binding) => !runtime!.isCurrent(binding))).toBe(true);
      });
      await writeFile(topology, invalid);
      await expect(runtime.refresh(new AbortController().signal)).rejects.toThrow();
      expect(fence).toHaveBeenCalledExactlyOnceWith('DESKTOP_TOPOLOGY_UNAVAILABLE');
      for (const binding of bindings) {
        expect(runtime.isCurrent(binding)).toBe(false);
        expect(() =>
          runtime!.describe({ desktopGeneration: binding.desktopGeneration })
        ).toThrowError(expect.objectContaining({ code: 'DESKTOP_TOPOLOGY_UNAVAILABLE' }));
      }
      await expect(runtime.refresh(new AbortController().signal)).rejects.toThrow();
      expect(fence).toHaveBeenCalledTimes(1);
      await writeFile(topology, valid);
      await runtime.refresh(new AbortController().signal);
      for (const binding of bindings) {
        const recovered = runtime.describe({ desktopGeneration: binding.desktopGeneration });
        expect(recovered.topologyRevision).toBeGreaterThan(binding.topologyRevision);
        expect(runtime.isCurrent(binding)).toBe(false);
        expect(
          runtime.isCurrent({ ...binding, topologyRevision: recovered.topologyRevision })
        ).toBe(true);
      }
    } finally {
      try {
        await runtime?.dispose();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
);

it('offers independent display captures while defaulting to the primary and invalidating changed topology', async () => {
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
      framebuffer: { width: 800, height: 600 },
      displays: [{ displayId: 'display_1' }]
    });
    expect(fence).toHaveBeenCalledWith('DESKTOP_TOPOLOGY_UNAVAILABLE');
    const initial = runtime.describe();
    const other = runtime.describe({ displayId: 'display_2' });
    expect(other).toMatchObject({
      framebuffer: { width: 640, height: 480 },
      selectableDisplays: [
        { displayId: 'display_2', primary: false },
        { displayId: 'display_1', primary: true }
      ],
      displays: [
        {
          displayId: 'display_2',
          primary: true,
          nativeBounds: { x: -640, y: 0 },
          nativeToFramebuffer: [1, 0, 0, 1, 640, 0]
        }
      ]
    });
    expect(other.desktopGeneration).not.toBe(initial.desktopGeneration);
    expect(runtime.describe({ desktopGeneration: other.desktopGeneration })).toEqual(other);
    expect(runtime.describe()).toEqual(initial);
    expect(fence).toHaveBeenCalledTimes(1);
    expect(() => runtime.describe({ displayId: 'display_3' })).toThrowError(
      expect.objectContaining({ code: 'DESKTOP_TOPOLOGY_UNAVAILABLE' })
    );
    await writeFile(topology, JSON.stringify({ displays: [primary] }));
    await runtime.refresh(new AbortController().signal);
    expect(() => runtime.describe({ desktopGeneration: other.desktopGeneration })).toThrowError(
      expect.objectContaining({ code: 'DESKTOP_TOPOLOGY_UNAVAILABLE' })
    );
    expect(runtime.describe().desktopGeneration).toBe(initial.desktopGeneration);
    expect(runtime.describe().topologyRevision).toBe(3);
    await runtime.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
