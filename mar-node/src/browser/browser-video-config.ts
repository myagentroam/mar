/** Default CSS viewport, independent of the encoded raster. */
export const BROWSER_VIEWPORT = { width: 960, height: 600 } as const;
const BROWSER_VIDEO_LIMIT = { width: 1280, height: 720 } as const;
export const BROWSER_VIDEO_HD_LIMIT = { width: 1920, height: 1080 } as const;
export const BROWSER_CAPTURE_QUALITY = 85;
export const BROWSER_VIDEO_FRAMERATE = 24;
export const BROWSER_VIDEO_BITRATE = 1_500_000;
export const BROWSER_VIDEO_HD_BITRATE = 4_000_000;

export type BrowserSize = { width: number; height: number };

export function browserEncodeSize({ width, height }: BrowserSize, hd = false): BrowserSize {
  const limit = hd ? BROWSER_VIDEO_HD_LIMIT : BROWSER_VIDEO_LIMIT;
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
