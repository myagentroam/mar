/** Default CSS viewport and landscape encoding envelope. */
export const BROWSER_VIEWPORT = { width: 960, height: 600 } as const;

export type BrowserSize = { width: number; height: number };

export function browserEncodeSize({ width, height }: BrowserSize): BrowserSize {
  const portrait = height > width;
  const maxWidth = portrait ? BROWSER_VIEWPORT.height : BROWSER_VIEWPORT.width;
  const maxHeight = portrait ? BROWSER_VIEWPORT.width : BROWSER_VIEWPORT.height;
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  const even = (edge: number) => Math.max(2, 2 * Math.round((edge * scale) / 2));
  return { width: even(width), height: even(height) };
}
