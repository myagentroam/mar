/** Default CSS viewport, independent of the encoded raster. */
export const BROWSER_VIEWPORT = { width: 960, height: 600 } as const;
export const BROWSER_DEVICE_SCALE_FACTOR = 2;
const LIMIT = { width: 1920, height: 1080 } as const;

export type BrowserSize = { width: number; height: number };

/** Density only changes the capture raster, never the page's CSS viewport. */
export function browserStreamSize(viewport: BrowserSize, density: number): BrowserSize {
  const scale = Math.min(density, 1);
  const width = viewport.width * scale;
  const height = viewport.height * scale;
  const limit = scale < 1 ? { width: 864, height: 486 } : LIMIT;
  const portrait = height > width;
  const maxWidth = portrait ? limit.height : limit.width;
  const maxHeight = portrait ? limit.width : limit.height;
  const even = (edge: number) => Math.max(2, 2 * Math.floor(edge / 2));
  if (width <= maxWidth && height <= maxHeight) return { width: even(width), height: even(height) };
  return {
    width: even(Math.min(maxWidth, (width * maxHeight) / height)),
    height: even(Math.min(maxHeight, (height * maxWidth) / width))
  };
}
