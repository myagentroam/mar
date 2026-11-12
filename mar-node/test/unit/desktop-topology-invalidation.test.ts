import { beforeEach, expect, it, vi } from 'vitest';
import { WindowsRemoteDesktopRuntime } from '../../src/remote-desktop/windows-remote-desktop-runtime.js';
import { MacosRemoteDesktopRuntime } from '../../src/remote-desktop/macos-remote-desktop-runtime.js';
import type { DesktopAttachmentBinding } from '../../src/remote-desktop/x11-remote-desktop-runtime.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  watch: vi.fn(),
  stop: vi.fn(async () => undefined),
  available: true,
  callbacks: undefined as { invalidate(): void; unavailable(): void } | undefined
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = Object.assign(() => undefined, { [promisify.custom]: mocks.query });
  return { ...actual, execFile };
});
vi.mock('../../src/remote-desktop/desktop-topology-notifications.js', () => ({
  startDesktopTopologyNotifications: mocks.watch
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockReset();
  mocks.available = true;
  mocks.watch.mockImplementation(async (callbacks: typeof mocks.callbacks) => {
    mocks.callbacks = callbacks;
    return { isAvailable: () => mocks.available, stop: mocks.stop };
  });
});

for (const platform of ['Windows', 'macOS'] as const) {
  const output = {
    stdout: JSON.stringify(
      platform === 'Windows'
        ? [{ name: 'DISPLAY1', primary: true, x: 0, y: 0, width: 800, height: 600 }]
        : {
            displays: [
              {
                id: 1,
                primary: true,
                x: 0,
                y: 0,
                width: 800,
                height: 600,
                pixelWidth: 800,
                pixelHeight: 600
              }
            ]
          }
    ),
    stderr: ''
  };
  async function start() {
    mocks.query.mockResolvedValue(output);
    const options = {
      binaryPath: 'unused',
      topologyBinary: 'unused-topology',
      maxPixels: 10_000_000,
      fence: vi.fn()
    };
    const runtime = await (platform === 'Windows'
      ? WindowsRemoteDesktopRuntime.start(options, new AbortController().signal)
      : MacosRemoteDesktopRuntime.start(options, new AbortController().signal));
    return { runtime, fence: options.fence };
  }

  it(`${platform} immediately fences topology events and never revives an old binding`, async () => {
    const { runtime, fence } = await start();
    try {
      const initial = runtime.describe();
      const binding = initial as unknown as DesktopAttachmentBinding;
      expect(runtime.isCurrent(binding)).toBe(true);
      mocks.callbacks!.invalidate();
      expect(fence).toHaveBeenCalledWith('DESKTOP_TOPOLOGY_UNAVAILABLE');
      expect(runtime.isCurrent(binding)).toBe(false);
      expect(() => runtime.describe()).toThrow();
      // The layout may already have returned to its old, identical dimensions.
      await runtime.refresh(new AbortController().signal);
      expect(runtime.describe().topologyRevision).toBe(initial.topologyRevision + 1);
      expect(runtime.isCurrent(binding)).toBe(false);
    } finally {
      await runtime.dispose();
    }
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it(`${platform} rejects a query overtaken by a native display event`, async () => {
    const { runtime } = await start();
    try {
      let resolve!: (value: typeof output) => void;
      mocks.query.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
      const pending = runtime.refresh(new AbortController().signal);
      mocks.callbacks!.invalidate();
      resolve(output);
      await expect(pending).rejects.toMatchObject({ code: 'DESKTOP_TOPOLOGY_UNAVAILABLE' });
      expect(() => runtime.describe()).toThrow();
      await runtime.refresh(new AbortController().signal);
      expect(runtime.describe().topologyRevision).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  it(`${platform} cannot reuse cached layout after observer or query failure`, async () => {
    const { runtime } = await start();
    try {
      const binding = runtime.describe() as unknown as DesktopAttachmentBinding;
      mocks.query.mockRejectedValueOnce(new Error('fixture query failure'));
      await expect(runtime.refresh(new AbortController().signal)).rejects.toThrow('fixture query');
      expect(runtime.isCurrent(binding)).toBe(false);
      await runtime.refresh(new AbortController().signal);
      mocks.available = false;
      mocks.callbacks!.unavailable();
      expect(() => runtime.describe()).toThrow();
      await expect(runtime.refresh(new AbortController().signal)).rejects.toMatchObject({
        code: 'DESKTOP_TOPOLOGY_UNAVAILABLE'
      });
    } finally {
      await runtime.dispose();
    }
  });
}
