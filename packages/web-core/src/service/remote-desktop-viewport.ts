import type { RemoteDesktopDescription } from '@myagentroam/protocol';

/** Clips the framebuffer without changing its RFB coordinate space or host display layout. */
export function remoteDesktopViewport(
  description: RemoteDesktopDescription,
  displayId: string | undefined,
  available: { readonly width: number; readonly height: number }
) {
  const screen =
    displayId === undefined
      ? { x: 0, y: 0, ...description.framebuffer }
      : description.displays.find((display) => display.displayId === displayId)?.framebufferBounds;
  if (!screen || available.width <= 0 || available.height <= 0) return undefined;
  const scale = Math.min(available.width / screen.width, available.height / screen.height);
  return {
    width: screen.width * scale,
    height: screen.height * scale,
    framebufferWidth: description.framebuffer.width * scale,
    framebufferHeight: description.framebuffer.height * scale,
    left: -screen.x * scale,
    top: -screen.y * scale
  };
}
