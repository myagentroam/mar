import { describe, expect, it, vi } from 'vitest';
import { X11DesktopTopology } from '../../src/remote-desktop/x11-desktop-topology.js';
import { X11TopologySource } from '../../src/remote-desktop/x11-topology-source.js';

const snapshot = {
  type: 'snapshot' as const,
  width: 800,
  height: 600,
  monitors: [
    {
      id: 1,
      name: 'screen',
      primary: true,
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      mmWidth: 0,
      mmHeight: 0,
      outputs: [
        {
          id: 1,
          name: 'screen',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          rotation: 1,
          transform: [65536, 0, 0, 0, 65536, 0, 0, 0, 65536]
        }
      ]
    }
  ]
};

describe('X11 subscription topology fence', () => {
  it('fences before rediscovery and never revives a pre-invalidation grant', async () => {
    let events!: Parameters<typeof X11TopologySource.start>[0];
    const stop = vi.fn(async () => {});
    const source = vi.fn(async (options: typeof events) => {
      events = options;
      options.onSnapshot(snapshot);
      return { stop } as unknown as X11TopologySource;
    });
    let owner!: X11DesktopTopology;
    const fence = vi.fn(() => expect(owner.matches('session', 1, 800, 600)).toBe(false));
    owner = await X11DesktopTopology.start(
      { generation: 'session', binaryPath: '/helper', display: ':1', xAuthority: '/auth', fence },
      new AbortController().signal,
      source
    );
    expect(owner.matches('session', 1, 800, 600)).toBe(true);
    events.onInvalidated({});
    expect(fence).toHaveBeenCalledOnce();
    events.onSnapshot(snapshot);
    expect(owner.matches('session', 1, 800, 600)).toBe(false);
    expect(owner.matches('session', 2, 800, 600)).toBe(true);
    events.onUnavailable();
    expect(owner.matches('session', 2, 800, 600)).toBe(false);
    events.onSnapshot(snapshot);
    expect(owner.matches('session', 2, 800, 600)).toBe(false);
    await owner.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('stops a source which resolves without a usable initial snapshot', async () => {
    const stop = vi.fn(async () => {});
    const source = vi.fn(async () => ({ stop }) as unknown as X11TopologySource);
    await expect(
      X11DesktopTopology.start(
        {
          generation: 'session',
          binaryPath: '/helper',
          display: ':1',
          xAuthority: '/auth',
          fence: vi.fn()
        },
        new AbortController().signal,
        source
      )
    ).rejects.toMatchObject({ code: 'DESKTOP_TOPOLOGY_UNAVAILABLE' });
    expect(stop).toHaveBeenCalledOnce();
  });
});
