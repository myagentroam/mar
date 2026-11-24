/** Default CSS viewport, independent of the encoded raster. */
export const BROWSER_VIEWPORT = { width: 960, height: 600 } as const;
const BROWSER_VIDEO_LIMIT = { width: 1280, height: 720 } as const;
export const BROWSER_CAPTURE_QUALITY = 85;
export const BROWSER_VIDEO_FRAMERATE = 24;
export const BROWSER_VIDEO_BITRATE = 1_500_000;

export type BrowserSize = { width: number; height: number };

export function browserEncodeSize({ width, height }: BrowserSize): BrowserSize {
  const portrait = height > width;
  const maxWidth = portrait ? BROWSER_VIDEO_LIMIT.height : BROWSER_VIDEO_LIMIT.width;
  const maxHeight = portrait ? BROWSER_VIDEO_LIMIT.width : BROWSER_VIDEO_LIMIT.height;
  const even = (edge: number) => Math.max(2, 2 * Math.floor(edge / 2));
  if (width <= maxWidth && height <= maxHeight) return { width: even(width), height: even(height) };
  return {
    width: even(Math.min(maxWidth, (width * maxHeight) / height)),
    height: even(Math.min(maxHeight, (height * maxWidth) / width))
  };
}
