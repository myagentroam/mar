import { afterEach, describe, expect, it, vi } from 'vitest';
import { X11DesktopTopology } from '../../src/remote-desktop/x11-desktop-topology.js';
import { X11RemoteDesktopRuntime } from '../../src/remote-desktop/x11-remote-desktop-runtime.js';

afterEach(() => vi.restoreAllMocks());

describe('X11 Remote Desktop composition', () => {
  it('uses the accessible X11 topology without a lock notification provider and invalidates old revisions', async () => {
    let revision = 1;
    let generation = '';
    const stop = vi.fn(async () => {});
    const fence = vi.fn();
    vi.spyOn(X11DesktopTopology, 'start').mockImplementation(async (options) => {
      generation = options.generation;
      return {
        describe: () => ({
          desktopGeneration: options.generation,
          topologyRevision: revision,
          framebuffer: { width: 800, height: 600 },
          displays: []
        }),
        matches: () => true,
        stop
      } as unknown as X11DesktopTopology;
    });
    const options = {
      binaryPath: '/vnc', topologyBinary: '/topology', display: ':1',
      xAuthority: '/auth', maxPixels: 1_000_000, fence
    };
    const runtime = await X11RemoteDesktopRuntime.start(options, new AbortController().signal);
    const command = { attachmentId: 'one', mode: 'CONTROL' as const, desktopGeneration: generation, topologyRevision: 1 };
    expect(runtime.isCurrent(command)).toBe(true);
    revision = 2;
    expect(runtime.isCurrent(command)).toBe(false);
    expect(runtime.isCurrent({ ...command, topologyRevision: 2 })).toBe(true);
    await runtime.dispose();
    expect(stop).toHaveBeenCalledOnce();
    const recreated = await X11RemoteDesktopRuntime.start(options, new AbortController().signal);
    expect(recreated.describe().desktopGeneration).not.toBe(command.desktopGeneration);
    expect(recreated.isCurrent({ ...command, topologyRevision: 2 })).toBe(false);
    await recreated.dispose();
  });

  it('does not advertise a desktop when the X11 topology cannot be opened', async () => {
    vi.spyOn(X11DesktopTopology, 'start').mockRejectedValue(new Error('unavailable'));
    await expect(X11RemoteDesktopRuntime.start({
      binaryPath: '/vnc', topologyBinary: '/topology', display: ':1',
      xAuthority: '/auth', maxPixels: 1_000_000, fence: vi.fn()
    }, new AbortController().signal)).rejects.toThrow('unavailable');
  });
});
