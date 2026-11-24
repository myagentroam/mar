import { promisify } from 'node:util';
import { deflate, constants } from 'node:zlib';
import { RFB_COPY_RECT, RFB_DESKTOP_SIZE, RFB_RAW, RFB_TIGHT } from './rfb.js';

const compress = promisify(deflate);
export type Raster = Readonly<{ width: number; height: number; rgb: Buffer }>;
type Area = { x: number; y: number; width: number; height: number };
type Delta = Area & { repair: boolean };
export type BrowserVncQuality = 'low' | 'medium' | 'high';
type Rectangle = Area & { encoding: number; payload: Buffer };
export interface BrowserVncUpdate {
  data: Buffer;
  lossy: boolean;
  lossyTiles: number[];
  restoredTiles: number[];
  motion: boolean;
  repairBytes: number;
  updates: 1 | 2;
}

const TILE = 64;
const MAX_RECT_WIDTH = 512;
const MAX_RECT_HEIGHT = 256;

function identical(frame: Raster, previous: Raster, region: Area, x = region.x, y = region.y) {
  const bytes = region.width * 3;
  for (let row = 0; row < region.height; row++) {
    const a = ((region.y + row) * frame.width + region.x) * 3;
    const b = ((y + row) * previous.width + x) * 3;
    if (!frame.rgb.subarray(a, a + bytes).equals(previous.rgb.subarray(b, b + bytes))) return false;
  }
  return true;
}

function trim(frame: Raster, base: Raster, area: Area): Area {
  let { x, y, width, height } = area;
  while (height > 1 && identical(frame, base, { x, y, width, height: 1 })) {
    y++;
    height--;
  }
  while (height > 1 && identical(frame, base, { x, y: y + height - 1, width, height: 1 })) height--;
  while (width > 1 && identical(frame, base, { x, y, width: 1, height })) {
    x++;
    width--;
  }
  while (width > 1 && identical(frame, base, { x: x + width - 1, y, width: 1, height })) width--;
  return { x, y, width, height };
}

function changedAreas(
  frame: Raster,
  base?: Raster,
  copied: ReadonlyArray<Area> = [],
  repairTile?: (area: Area, changed: boolean) => boolean
) {
  const areas: Delta[] = [];
  let changedPixels = 0;
  for (let y = 0, index = 0; y < frame.height;) {
    const copy = copied[index];
    if (copy?.y === y) {
      y += copy.height;
      index++;
      continue;
    }
    const height = Math.min(TILE, (copy?.y ?? frame.height) - y);
    for (let x = 0; x < frame.width; x += TILE) {
      const area = { x, y, width: Math.min(TILE, frame.width - x), height };
      const changed = !base || !identical(frame, base, area);
      const repair = repairTile?.(area, changed) ?? false;
      if (!repair && !changed) continue;
      if (changed) changedPixels += area.width * area.height;
      const left = areas.at(-1);
      if (
        left?.y === y &&
        left.repair === repair &&
        left.x + left.width === x &&
        left.width + area.width <= MAX_RECT_WIDTH
      )
        left.width += area.width;
      else areas.push({ ...area, repair });
    }
    y += height;
  }
  const prior = new Map<string, Area>();
  const merged = areas.filter((area) => {
    const key = `${area.x}:${area.width}:${area.repair}`;
    const above = prior.get(key);
    if (
      above &&
      above.y + above.height === area.y &&
      above.height + area.height <= MAX_RECT_HEIGHT
    ) {
      above.height += area.height;
      return false;
    }
    prior.set(key, area);
    return true;
  });
  return { areas: merged, changedPixels };
}

function stillMoving(frame: Raster, base: Raster, area: Area): boolean {
  // Sample only changed, due tiles. A caret should not prevent an exact refresh.
  let changed = 0;
  for (let row = 0; row < 8; row++) {
    const y = area.y + Math.floor(((row + 0.5) * area.height) / 8);
    for (let column = 0; column < 8; column++) {
      const x = area.x + Math.floor(((column + 0.5) * area.width) / 8);
      if (!identical(frame, base, { x, y, width: 1, height: 1 }) && ++changed >= 8) return true;
    }
  }
  return false;
}

function collectTileCoverage(
  frame: Raster,
  rect: Area & { lossy?: true },
  reference: ReadonlyMap<number, number> | undefined,
  lossyTiles: number[],
  restoredTiles: number[]
) {
  if (!rect.lossy && !reference?.size) return;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  for (let y = Math.floor(rect.y / TILE) * TILE; y < bottom; y += TILE) {
    for (let x = Math.floor(rect.x / TILE) * TILE; x < right; x += TILE) {
      const tile = y * frame.width + x;
      if (rect.lossy) lossyTiles.push(tile);
      // A precise delta can overwrite only part of a tile. Don't mark it clean.
      else if (
        reference?.has(tile) &&
        x >= rect.x &&
        y >= rect.y &&
        Math.min(x + TILE, frame.width) <= right &&
        Math.min(y + TILE, frame.height) <= bottom
      )
        restoredTiles.push(tile);
    }
  }
}

function scrollAreas(frame: Raster, base: Raster, dy: number): Area[] {
  const first = Math.max(0, -dy);
  const last = Math.min(frame.height, frame.height - dy);
  const runs: Area[] = [];
  const row = { x: 0, width: frame.width, y: first, height: 1 };
  const bytes = frame.width * 3;
  for (; row.y < last; row.y++) {
    if (!identical(frame, base, row, 0, row.y + dy)) continue;
    // Don't emit CopyRect for bands already identical in their current position.
    const offset = row.y * bytes;
    const changed = !frame.rgb
      .subarray(offset, offset + bytes)
      .equals(base.rgb.subarray(offset, offset + bytes));
    const above = runs.at(-1);
    if (above && above.y + above.height === row.y) above.height++;
    else if (changed) runs.push({ ...row });
  }
  return runs.filter(({ height }) => height >= 16);
}

function pixels(frame: Raster, area: Area): Buffer {
  const result = Buffer.allocUnsafe(area.width * area.height * 3);
  const rowBytes = area.width * 3;
  for (let y = 0; y < area.height; y++) {
    const offset = ((area.y + y) * frame.width + area.x) * 3;
    frame.rgb.copy(result, y * rowBytes, offset, offset + rowBytes);
  }
  return result;
}

function tightLength(size: number): Buffer {
  if (size < 128) return Buffer.from([size]);
  if (size < 16384) return Buffer.from([(size & 127) | 128, size >> 7]);
  return Buffer.from([(size & 127) | 128, ((size >> 7) & 127) | 128, size >> 14]);
}

async function tightData(data: Buffer): Promise<Buffer> {
  if (data.length < 12) return data;
  const compressed = await compress(data, { level: 1, finishFlush: constants.Z_SYNC_FLUSH });
  return Buffer.concat([tightLength(compressed.length), compressed]);
}

function paletteOf(rgb: Buffer): Map<number, number> | undefined {
  const colors = new Map<number, number>();
  let last = -1;
  for (let offset = 0; offset < rgb.length; offset += 3) {
    const color = rgb.readUIntBE(offset, 3);
    if (color === last) continue;
    last = color;
    if (colors.has(color)) continue;
    // Prefer the indexed path only for low-color UI. Photographic content
    // exits early and goes to full-color Tight or JPEG.
    if (colors.size === 32) return undefined;
    colors.set(color, colors.size);
  }
  return colors;
}

async function tightPalette(
  rgb: Buffer,
  width: number,
  colors: Map<number, number>
): Promise<Buffer> {
  const header = Buffer.alloc(3 + colors.size * 3);
  header.set([0x41, 1, colors.size - 1]); // Explicit filter 1, reset stream 0.
  for (const [color, index] of colors) header.writeUIntBE(color, 3 + index * 3, 3);
  const height = rgb.length / (width * 3);
  const mono = colors.size === 2;
  const stride = mono ? Math.ceil(width / 8) : width;
  const data = Buffer.alloc(stride * height);
  for (let y = 0, offset = 0; y < height; y++) {
    for (let x = 0; x < width; x++, offset += 3) {
      const index = colors.get(rgb.readUIntBE(offset, 3))!;
      if (mono) {
        if (index) data[y * stride + (x >> 3)]! |= 0x80 >> (x & 7);
      } else data[y * stride + x] = index;
    }
  }
  return Buffer.concat([header, await tightData(data)]);
}

async function rectangle(
  frame: Raster,
  area: Area,
  options: Parameters<typeof encodeBrowserVncUpdate>[2],
  motion: boolean
): Promise<Rectangle & { lossy?: true }> {
  const rgb = pixels(frame, area);
  if (!options.tight) {
    const payload = Buffer.alloc((rgb.length / 3) * 4);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
      payload[j] = rgb[i]!;
      payload[j + 1] = rgb[i + 1]!;
      payload[j + 2] = rgb[i + 2]!;
    }
    return { ...area, encoding: RFB_RAW, payload };
  }
  const palette = paletteOf(rgb);
  if (palette?.size === 1)
    return { ...area, encoding: RFB_TIGHT, payload: Buffer.from([0x80, ...rgb.subarray(0, 3)]) };
  if (palette && rgb.length >= 96)
    return { ...area, encoding: RFB_TIGHT, payload: await tightPalette(rgb, area.width, palette) };
  const jpeg = options.jpeg;
  if (!motion || !jpeg || rgb.length < 48 * 1024)
    return {
      ...area,
      encoding: RFB_TIGHT,
      payload: Buffer.concat([Buffer.of(1), await tightData(rgb)])
    };

  const data = await compress(rgb, { level: 1, finishFlush: constants.Z_SYNC_FLUSH });
  // Try JPEG only for large, highly textured updates which are expensive lossless.
  if (data.length >= rgb.length / 8) {
    let edges = 0;
    for (let i = 3; i < rgb.length; i += 24) {
      if (
        i % (area.width * 3) >= 3 &&
        Math.abs(rgb[i]! - rgb[i - 3]!) +
          Math.abs(rgb[i + 1]! - rgb[i - 2]!) +
          Math.abs(rgb[i + 2]! - rgb[i - 1]!) >
          48
      )
        edges++;
    }
    if (edges < rgb.length / 100)
      return {
        ...area,
        encoding: RFB_TIGHT,
        payload: Buffer.concat([Buffer.of(1), tightLength(data.length), data])
      };
    const image = await jpeg(rgb, area, { high: 90, medium: 78, low: 65 }[options.quality]);
    if (image.length < data.length * 0.8)
      return {
        ...area,
        encoding: RFB_TIGHT,
        payload: Buffer.concat([Buffer.of(0x90), tightLength(image.length), image]),
        lossy: true
      };
  }
  return {
    ...area,
    encoding: RFB_TIGHT,
    payload: Buffer.concat([Buffer.of(1), tightLength(data.length), data])
  };
}

function update(rects: Rectangle[]): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(rects.length, 2);
  return Buffer.concat([
    header,
    ...rects.flatMap(({ x, y, width, height, encoding, payload }) => {
      const rect = Buffer.allocUnsafe(12);
      rect.writeUInt16BE(x, 0);
      rect.writeUInt16BE(y, 2);
      rect.writeUInt16BE(width, 4);
      rect.writeUInt16BE(height, 6);
      rect.writeInt32BE(encoding, 8);
      return [rect, payload];
    })
  ]);
}

/** Produce standard RFB framebuffer updates relative to the exact, confirmed
 * raster. The caller owns pacing, acknowledgments and coverage of lossy pixels. */
export async function encodeBrowserVncUpdate(
  frame: Raster,
  previous: Raster | undefined,
  options: {
    resize: boolean;
    tight: boolean;
    copyRect: boolean;
    scroll?: number;
    motion?: boolean;
    motionResize?: boolean;
    // Keys are 64px tile origins as pixel offsets in the confirmed raster.
    lossyTiles?: ReadonlyMap<number, number>;
    repairThrough?: number;
    quality: BrowserVncQuality;
    jpeg?: (
      rgb: Buffer,
      size: { width: number; height: number },
      quality: number
    ) => Promise<Buffer>;
  }
): Promise<BrowserVncUpdate | undefined> {
  const base =
    previous?.width === frame.width && previous.height === frame.height ? previous : undefined;
  const dy = options.scroll ?? 0;
  const scroll =
    base && options.copyRect && Number.isInteger(dy) && dy !== 0 && Math.abs(dy) < frame.height / 2
      ? scrollAreas(frame, base, dy)
      : [];
  const scrolling = scroll.reduce((rows, area) => rows + area.height, 0) >= frame.height / 2;
  const reference = base && options.lossyTiles?.size ? options.lossyTiles : undefined;
  // Matching source pixels can identify a scroll even before the viewer is
  // eligible for CopyRect. Send an exact refresh first so subsequent scrolls
  // can reuse the framebuffer without propagating JPEG artifacts.
  const repairScroll = scrolling && !!reference;
  const rects: Rectangle[] = [];
  const copied = reference ? [] : scroll;
  if (copied.length) {
    // Move in source-safe order; an earlier rectangle must not overwrite the
    // source of a later one. Pixel rectangles follow all copies.
    for (const area of dy > 0 ? copied : [...copied].reverse()) {
      const payload = Buffer.alloc(4);
      payload.writeUInt16BE(area.y + dy, 2);
      rects.push({ ...area, encoding: RFB_COPY_RECT, payload });
    }
  }
  const { areas, changedPixels } = changedAreas(
    frame,
    base,
    copied,
    base &&
      reference &&
      ((area, changed) => {
        const due = reference.get(area.y * frame.width + area.x);
        return (
          due !== undefined &&
          (repairScroll ||
            (due <= (options.repairThrough ?? -Infinity) &&
              (!options.motion || !changed || !stillMoving(frame, base, area))))
        );
      })
  );
  if (!areas.length && !rects.length) return undefined;
  // Coarse tiles make discovery and merging cheap. Trim the merged delta
  // when it is local so a caret does not retransmit the text behind it.
  const broad = changedPixels > (frame.width * frame.height) / 4;
  const motion =
    !repairScroll && options.motion === true && (!!base || options.motionResize === true) && broad;
  const lossyTiles: number[] = [];
  const restoredTiles: number[] = [];
  let repairBytes = 0;
  for (let i = 0; i < areas.length; i += 4) {
    const batch = await Promise.all(
      areas.slice(i, i + 4).map(async (area) => {
        const bounds = base && !area.repair && !broad ? trim(frame, base, area) : area;
        const rect = await rectangle(frame, bounds, options, motion && !area.repair);
        return { rect, repair: area.repair };
      })
    );
    for (const { rect, repair } of batch) {
      rects.push(rect);
      if (repair) repairBytes += 12 + rect.payload.length;
      collectTileCoverage(frame, rect, reference, lossyTiles, restoredTiles);
    }
  }
  const pixels = update(rects);
  const result = {
    lossy: lossyTiles.length > 0,
    lossyTiles,
    restoredTiles,
    motion,
    repairBytes
  };
  if (!options.resize) return { data: pixels, ...result, updates: 1 };
  // RFC 6143 requires DesktopSize to be the last rectangle in its update.
  const resize = update([
    {
      x: 0,
      y: 0,
      width: frame.width,
      height: frame.height,
      encoding: RFB_DESKTOP_SIZE,
      payload: Buffer.alloc(0)
    }
  ]);
  return { data: Buffer.concat([resize, pixels]), ...result, updates: 2 };
}
