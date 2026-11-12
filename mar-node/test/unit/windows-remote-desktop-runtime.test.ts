import { expect, it } from 'vitest';
import { windowsDesktopLayout } from '../../src/remote-desktop/windows-remote-desktop-runtime.js';

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
