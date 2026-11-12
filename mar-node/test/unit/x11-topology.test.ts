import { describe, expect, it } from 'vitest';
import { remoteDesktopDescriptionSchema } from '@myagentroam/protocol';
import { X11Topology } from '../../src/remote-desktop/x11-topology.js';
import type { X11TopologySnapshot } from '../../src/remote-desktop/x11-topology-source.js';

function snapshot(): X11TopologySnapshot {
  return {
    type: 'snapshot',
    width: 1920,
    height: 1080,
    monitors: [
      {
        id: 1,
        name: 'left',
        primary: true,
        x: 0,
        y: 0,
        width: 960,
        height: 1080,
        mmWidth: 300,
        mmHeight: 340,
        outputs: [
          {
            id: 11,
            name: 'left',
            x: 0,
            y: 0,
            width: 960,
            height: 1080,
            rotation: 2,
            transform: [65536, 0, 0, 0, 65536, 0, 0, 0, 65536]
          }
        ]
      },
      {
        id: 2,
        name: 'right',
        primary: false,
        x: 960,
        y: 0,
        width: 960,
        height: 1080,
        mmWidth: 400,
        mmHeight: 225,
        outputs: [
          {
            id: 22,
            name: 'right',
            x: 960,
            y: 0,
            width: 960,
            height: 1080,
            rotation: 1,
            transform: [131072, 0, 0, 0, 131072, 0, 0, 0, 65536]
          }
        ]
      }
    ]
  };
}

describe('X11 topology for one native desktop generation', () => {
  it('maps the root framebuffer and retires old grants even when a new snapshot is unchanged', () => {
    const topology = new X11Topology('session-1');
    const first = topology.accept(snapshot());
    expect(remoteDesktopDescriptionSchema.safeParse(first).success).toBe(true);
    expect(first).toMatchObject({
      desktopGeneration: 'session-1',
      topologyRevision: 1,
      framebuffer: { width: 1920, height: 1080 },
      displays: [
        {
          name: 'left',
          primary: true,
          nativeBounds: { x: 0, y: 0, width: 960, height: 1080 },
          framebufferBounds: { x: 0, y: 0, width: 960, height: 1080 }
        },
        {
          name: 'right',
          primary: false,
          framebufferBounds: { x: 960, y: 0, width: 960, height: 1080 }
        }
      ]
    });
    expect(topology.matchesFramebuffer(1920, 1080)).toBe(true);
    expect(topology.matchesFramebuffer(960, 1080)).toBe(false);
    expect(() => topology.accept(snapshot())).toThrow(
      expect.objectContaining({ code: 'DESKTOP_TOPOLOGY_UNAVAILABLE' })
    );
    topology.invalidate({});
    expect(() => topology.describe()).toThrow(
      expect.objectContaining({ code: 'DESKTOP_TOPOLOGY_UNAVAILABLE' })
    );
    const reordered = snapshot();
    reordered.monitors.reverse();
    const rediscovered = topology.accept(reordered);
    expect(rediscovered).toEqual({ ...first, topologyRevision: 2 });
    expect(rediscovered.displays.map((display) => display.displayId)).toEqual(
      first.displays.map((display) => display.displayId)
    );
  });

  it('keeps unaffected display identities but never reuses a disconnected output identity', () => {
    const topology = new X11Topology('session-1');
    const first = topology.accept(snapshot());
    topology.invalidate({ resetOutput: 22 });
    const reconnected = topology.accept(snapshot());
    expect(reconnected.topologyRevision).toBe(2);
    expect(reconnected.displays[0]!.displayId).toBe(first.displays[0]!.displayId);
    expect(reconnected.displays[1]!.displayId).not.toBe(first.displays[1]!.displayId);
  });

  it('increments the revision for transform changes even when rectangles are unchanged', () => {
    const topology = new X11Topology('session-1');
    const first = topology.accept(snapshot());
    topology.invalidate({});
    const changed = snapshot();
    changed.monitors[1]!.outputs[0]!.transform[0] = 65536;
    const second = topology.accept(changed);
    expect(second.topologyRevision).toBe(2);
    expect(second.displays.map((display) => display.displayId)).toEqual(
      first.displays.map((display) => display.displayId)
    );
  });

  it('retires all identities if a subscription is lost or reports an unknown resource change', () => {
    const topology = new X11Topology('session-1');
    const first = topology.accept(snapshot());
    topology.invalidate({ resetAll: true });
    const second = topology.accept(snapshot());
    expect(second.displays.map((display) => display.displayId)).not.toEqual(
      first.displays.map((display) => display.displayId)
    );
    topology.unavailable();
    expect(() => topology.describe()).toThrow(
      expect.objectContaining({ code: 'DESKTOP_TOPOLOGY_UNAVAILABLE' })
    );
    const third = topology.accept(snapshot());
    expect(third.displays.map((display) => display.displayId)).not.toEqual(
      second.displays.map((display) => display.displayId)
    );
  });

  it('rejects ambiguous primary, duplicate identities and unmappable monitor geometry', () => {
    const badPrimary = snapshot();
    badPrimary.monitors[0]!.primary = false;
    const duplicate = snapshot();
    duplicate.monitors[1]!.id = 1;
    const outside = snapshot();
    outside.monitors[1]!.x = 1500;
    for (const bad of [badPrimary, duplicate, outside]) {
      const topology = new X11Topology('session-1');
      expect(() => topology.accept(bad)).toThrow(
        expect.objectContaining({ code: 'DESKTOP_TOPOLOGY_UNAVAILABLE' })
      );
      expect(() => topology.describe()).toThrow(
        expect.objectContaining({ code: 'DESKTOP_TOPOLOGY_UNAVAILABLE' })
      );
    }
  });

  it('permits a single display without an XRandR primary and never exposes mutable internal state', () => {
    const topology = new X11Topology('session-1');
    const one = snapshot();
    one.monitors = [one.monitors[1]!];
    const result = topology.accept(one);
    expect(result.displays[0]!.primary).toBe(true);
    (result.framebuffer as { width: number }).width = 1;
    expect(topology.describe().framebuffer.width).toBe(1920);
  });
});
