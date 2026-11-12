import { describe, expect, it } from 'vitest';
import type { RemoteDesktopDescription } from '@myagentroam/protocol';
import { remoteDesktopViewport } from '../../src/service/remote-desktop-viewport.js';

const layout: RemoteDesktopDescription = {
  desktopGeneration: 'desktop-123',
  topologyRevision: 1,
  framebuffer: { width: 3000, height: 1200 },
  displays: [
    {
      displayId: 'display-a',
      name: 'Left',
      primary: false,
      nativeBounds: { x: -1000, y: 0, width: 1000, height: 1200 },
      framebufferBounds: { x: 0, y: 0, width: 1000, height: 1200 },
      nativeToFramebuffer: [1, 0, 0, 1, 1000, 0]
    },
    {
      displayId: 'display-b',
      name: 'Primary',
      primary: true,
      nativeBounds: { x: 0, y: 0, width: 1000, height: 600 },
      framebufferBounds: { x: 1000, y: 0, width: 2000, height: 1200 },
      nativeToFramebuffer: [2, 0, 0, 2, 1000, 0]
    }
  ]
};
describe('Remote Desktop framebuffer viewport', () => {
  it('clips and scales a nonzero-origin screen while preserving framebuffer pointer coordinates', () => {
    const viewport = remoteDesktopViewport(layout, 'display-b', { width: 1000, height: 800 })!;
    expect(viewport).toEqual({
      width: 1000,
      height: 600,
      framebufferWidth: 1500,
      framebufferHeight: 600,
      left: -500,
      top: -0
    });
    // noVNC receives a canvas whose real bounding rect begins at left/top.
    expect((250 - viewport.left) / (viewport.framebufferWidth / layout.framebuffer.width)).toBe(
      1500
    );
  });
  it('fits the complete framebuffer and refuses a stale screen or empty viewport', () => {
    expect(remoteDesktopViewport(layout, undefined, { width: 900, height: 600 })).toEqual({
      width: 900,
      height: 360,
      framebufferWidth: 900,
      framebufferHeight: 360,
      left: -0,
      top: -0
    });
    expect(remoteDesktopViewport(layout, 'missing', { width: 900, height: 600 })).toBeUndefined();
    expect(remoteDesktopViewport(layout, 'display-a', { width: 0, height: 600 })).toBeUndefined();
  });
});
