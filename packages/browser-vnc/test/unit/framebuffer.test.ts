import { inflateSync, constants } from 'node:zlib';
import { expect, test, vi } from 'vitest';
import {
  BrowserRfbPeer,
  BrowserVncRate,
  encodeBrowserVncUpdate,
  RFB_COPY_RECT,
  RFB_TIGHT
} from '../../src/index.js';

const options = { resize: false, tight: true, copyRect: true, quality: 'high' } as const;
const raster = (width: number, height: number, data?: Buffer) => ({
  width,
  height,
  rgb: data ?? Buffer.alloc(width * height * 3)
});

test('writes MSB-first mono rows with padding and exact RGB palette entries', async () => {
  const width = 13,
    height = 16;
  const frame = raster(width, height);
  const color = [21, 43, 65];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((x + y) % 2) frame.rgb.set(color, (y * width + x) * 3);
    }
  }
  const data = (await encodeBrowserVncUpdate(frame, undefined, options))!.data.subarray(16);
  expect([...data.subarray(0, 9)]).toEqual([0x41, 1, 1, 0, 0, 0, ...color]);
  expect(data[9]).toBe(data.length - 10);
  const indices = inflateSync(data.subarray(10), { finishFlush: constants.Z_SYNC_FLUSH });
  expect([...indices]).toEqual(
    Array.from({ length: height }, (_, y) => (y % 2 ? [0xaa, 0xa8] : [0x55, 0x50])).flat()
  );
});

test('repairs the lossy tile even if the capture equals the source reference', async () => {
  const frame = raster(256, 128);
  const lossyTiles = new Map([
    [64, 350],
    [128, 450]
  ]);
  const update = (await encodeBrowserVncUpdate(frame, frame, {
    ...options,
    lossyTiles,
    repairThrough: 350,
    motion: true
  }))!;
  expect(update).toMatchObject({ lossy: false, motion: false, restoredTiles: [64] });
  expect(update.data.readUInt16BE(2)).toBe(1);
  expect([...update.data.subarray(4, 12)]).toEqual([0, 64, 0, 0, 0, 64, 0, 64]);
});

test('defers repairing a region that is still broadly changing', async () => {
  const base = raster(256, 128);
  const frame = raster(256, 128, Buffer.alloc(256 * 128 * 3, 5));
  const repair = { lossyTiles: new Map([[0, 350]]), repairThrough: 350, motion: true };
  const active = (await encodeBrowserVncUpdate(frame, base, { ...options, ...repair }))!;
  // A naturally lossless delta can also restore a fully overwritten tile.
  expect(active).toMatchObject({ motion: true, repairBytes: 0, restoredTiles: [0] });
  const stopped = (await encodeBrowserVncUpdate(frame, frame, {
    ...options,
    ...repair
  }))!;
  expect(stopped).toMatchObject({ lossy: false, motion: false, restoredTiles: [0] });
  expect(stopped.repairBytes).toBeGreaterThan(0);
});

test('a trimmed lossless delta does not mark an entire JPEG tile as restored', async () => {
  const base = raster(256, 128);
  const frame = raster(256, 128);
  frame.rgb[0] = 1;
  const delta = await encodeBrowserVncUpdate(frame, base, {
    ...options,
    lossyTiles: new Map([[0, 350]]),
    repairThrough: 100
  });
  expect(delta).toMatchObject({ restoredTiles: [], repairBytes: 0 });
  expect(delta?.data.readUInt16BE(8)).toBe(1);
});

test('a small moving caret does not postpone the rest of its JPEG tile repair', async () => {
  const base = raster(256, 128);
  const frame = raster(256, 128);
  for (let y = 8; y < 40; y++) frame.rgb[(y * frame.width + 28) * 3] = 255;
  const delta = await encodeBrowserVncUpdate(frame, base, {
    ...options,
    lossyTiles: new Map([[0, 350]]),
    repairThrough: 350,
    motion: true
  });
  expect(delta).toMatchObject({ restoredTiles: [0], motion: false });
  expect(delta!.repairBytes).toBeGreaterThan(0);
  expect([...delta!.data.subarray(4, 12)]).toEqual([0, 0, 0, 0, 0, 64, 0, 64]);
});

test('a static surface needs no update and a local change sends only its exact bounds', async () => {
  const base = raster(160, 128);
  const changed = raster(160, 128);
  expect(await encodeBrowserVncUpdate(base, base, options)).toBeUndefined();
  for (let x = 1; x <= 33; x++) changed.rgb[x * 3] = x;
  const frame = (await encodeBrowserVncUpdate(changed, base, options))!.data;
  expect(frame.readUInt16BE(2)).toBe(1);
  expect([...frame.subarray(4, 12)]).toEqual([0, 1, 0, 0, 0, 33, 0, 1]);
  expect(frame.readInt32BE(12)).toBe(7);
  expect(frame[16]).toBe(1);
  const offset = frame[17]! & 128 ? 19 : 18;
  expect(inflateSync(frame.subarray(offset), { finishFlush: constants.Z_SYNC_FLUSH })).toEqual(
    changed.rgb.subarray(3, 102)
  );
});

test('Tight JPEG is limited to expensive motion remaining after CopyRect', async () => {
  const width = 128,
    height = 192,
    stride = width * 3;
  let seed = 1;
  const texture = (length: number) =>
    Buffer.from(
      Uint8Array.from({ length }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed >>> 24;
      })
    );
  const base = raster(width, height, texture(stride * height));
  const frame = raster(width, height, texture(stride * height));
  const jpeg = vi.fn(async () => Buffer.of(0xff, 0xd8, 0xff, 0xd9));
  const moving = { ...options, motion: true, jpeg };

  expect((await encodeBrowserVncUpdate(frame, undefined, moving))?.lossy).toBe(false);
  expect(jpeg).not.toHaveBeenCalled();
  const update = await encodeBrowserVncUpdate(frame, base, moving);
  expect(update?.lossy).toBe(true);
  expect(update?.data[16]).toBe(0x90);
  expect(jpeg).toHaveBeenCalledOnce();

  jpeg.mockClear();
  base.rgb.copy(frame.rgb, 0, stride * 12);
  const scroll = await encodeBrowserVncUpdate(frame, base, { ...moving, scroll: 12 });
  expect(scroll?.data.readInt32BE(12)).toBe(1);
  expect(scroll?.lossy).toBe(false);
  expect(jpeg).not.toHaveBeenCalled();
});

test('scroll uses CopyRect only for identical source pixels and resize is its own update', async () => {
  const width = 32,
    height = 64;
  const base = raster(
    width,
    height,
    Buffer.from(Uint8Array.from({ length: width * height * 3 }, (_, i) => i % 251))
  );
  const frame = raster(width, height);
  base.rgb.copy(frame.rgb, 0, width * 3 * 4);
  const shifted = (await encodeBrowserVncUpdate(frame, base, { ...options, scroll: 4 }))!.data;
  expect(shifted.readInt32BE(12)).toBe(1);
  expect(shifted.readUInt16BE(18)).toBe(4);
  frame.rgb[0] ^= 1;
  const mixed = (await encodeBrowserVncUpdate(frame, base, { ...options, scroll: 4 }))!.data;
  expect(mixed.readInt32BE(12)).toBe(1);
  expect(mixed.readUInt16BE(6)).toBe(1);
  expect(mixed.readUInt16BE(10)).toBe(59);
  const resize = (await encodeBrowserVncUpdate(frame, undefined, { ...options, resize: true }))!
    .data;
  expect(resize.readInt32BE(12)).toBe(-223);
  expect(resize.readUInt16BE(18)).toBeGreaterThan(0);
});

test('scroll repairs a lossy reference before emitting any CopyRect', async () => {
  const width = 64;
  const height = 96;
  const stride = width * 3;
  const base = raster(width, height);
  for (let y = 0; y < height; y++) base.rgb.fill(y, y * stride, (y + 1) * stride);
  const shifted = raster(width, height);
  base.rgb.copy(shifted.rgb, 0, stride * 16);
  const update = await encodeBrowserVncUpdate(shifted, base, {
    ...options,
    lossyTiles: new Map([
      [0, Infinity],
      [64 * width, Infinity]
    ]),
    scroll: 16,
    motion: true
  });
  expect(update).toMatchObject({ restoredTiles: [0, 64 * width], lossy: false, motion: false });
  expect(update?.data.readInt32BE(12)).toBe(RFB_TIGHT);

  const next = raster(width, height);
  shifted.rgb.copy(next.rgb, 0, stride * 16);
  expect(
    (await encodeBrowserVncUpdate(next, shifted, { ...options, scroll: 16 }))?.data.readInt32BE(12)
  ).toBe(RFB_COPY_RECT);
});

test('Tight JPEG detects high texture when motion contains repeated pairs of pixels', async () => {
  const frame = raster(256, 128);
  let seed = 1;
  for (let offset = 0; offset < frame.rgb.length; offset += 6) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    frame.rgb.writeUIntBE(seed >>> 8, offset, 3);
    frame.rgb.copy(frame.rgb, offset + 3, offset, offset + 3);
  }
  const jpeg = vi.fn(async () => Buffer.alloc(256));
  const base = raster(frame.width, frame.height);
  const moving = await encodeBrowserVncUpdate(frame, base, { ...options, motion: true, jpeg });
  expect(moving).toMatchObject({ lossy: true, motion: true });
  expect(moving?.data[16]).toBe(0x90);
  expect(jpeg).toHaveBeenCalledOnce();

  const still = await encodeBrowserVncUpdate(frame, undefined, { ...options, jpeg });
  expect(still).toMatchObject({ lossy: false, motion: false });
  expect(jpeg).toHaveBeenCalledOnce();

  jpeg.mockResolvedValueOnce(frame.rgb);
  const larger = await encodeBrowserVncUpdate(frame, base, { ...options, motion: true, jpeg });
  expect(larger).toMatchObject({ lossy: false, motion: true });
  expect(jpeg).toHaveBeenCalledTimes(2);
});

test('RFB 3.8 accepts fragmented negotiation but never accepts keyboard input', () => {
  const replies: Uint8Array[] = [];
  let requests = 0;
  const peer = new BrowserRfbPeer(
    (data) => replies.push(data),
    () => requests++
  );
  peer.start();
  peer.receive(Buffer.from('RFB 003.'));
  peer.receive(Buffer.from('008\n'));
  peer.receive(Buffer.of(1, 1));
  expect(replies.map((data) => data.length)).toEqual([12, 2, 4, 39]);
  peer.receive(Buffer.of(2, 0, 0, 1, 255, 255, 255, 33));
  peer.receive(Buffer.of(3, 0, 0, 0, 0, 0, 0, 1, 0, 1));
  expect(peer.requested).toBe(true);
  peer.consume();
  expect(requests).toBe(1);
  expect(peer.requested).toBe(false);
  expect(() => peer.receive(Buffer.of(4))).toThrow(/Unsupported/u);
});

test('automatic quality first reduces cadence, then scale, and can recover within its limit', () => {
  const rate = new BrowserVncRate(false);
  const slow = () => {
    for (let i = 0; i < 3; i++) rate.observe(120, 220, true);
  };
  const fast = () => {
    for (let i = 0; i < 4; i++) rate.observe(4, 35, true);
  };
  expect(rate.profile).toEqual({ quality: 'high', fps: 24, scale: 1 });
  slow();
  expect(rate.profile).toEqual({ quality: 'high', fps: 12, scale: 1 });
  slow();
  expect(rate.profile).toEqual({ quality: 'medium', fps: 10, scale: 1 });
  slow();
  expect(rate.profile).toEqual({ quality: 'low', fps: 6, scale: 1 });
  slow();
  expect(rate.profile).toEqual({ quality: 'low', fps: 4, scale: 0.65 });
  fast();
  fast();
  expect(rate.profile.quality).toBe('medium');
  rate.limit('medium');
  fast();
  expect(rate.profile.quality).toBe('medium');
  rate.limit('auto');
  fast();
  expect(rate.profile.quality).toBe('high');
});

test('reacts after one confirmed motion frame that took a second to write, but not a still', () => {
  const rate = new BrowserVncRate(false);
  expect(rate.observe(1_100, 1_130, true)).toBe(false);
  expect(rate.profile.fps).toBe(24);
  expect(rate.observe(1_100, 1_130, true, 250_000)).toBe(true);
  expect(rate.profile).toEqual({ quality: 'high', fps: 12, scale: 1 });
  expect(rate.observe(1_100, 1_130, true, 250_000)).toBe(true);
  expect(rate.profile).toEqual({ quality: 'medium', fps: 10, scale: 1 });
});

test('severe sustained motion reduces cadence in two updates before reducing raster', () => {
  const rate = new BrowserVncRate(false);
  expect(rate.observe(4, 35, true, 400_000)).toBe(false);
  expect(rate.observe(4, 35, true, 400_000)).toBe(true);
  expect(rate.profile).toMatchObject({ fps: 12, scale: 1 });
});

test('fast direct motion has more headroom than relay but still adapts to delayed draws', () => {
  const direct = new BrowserVncRate(false);
  const relay = new BrowserVncRate(true);
  for (let i = 0; i < 9; i++) {
    direct.observe(4, 35, true, 90_000, 28);
    relay.observe(4, 35, true, 90_000, 28);
  }
  expect(direct.profile).toMatchObject({ fps: 24, quality: 'high' });
  expect(relay.profile).toMatchObject({ fps: 12, quality: 'high' });
  for (let i = 0; i < 9; i++) direct.observe(4, 230, true, 90_000, 28);
  expect(direct.profile).toMatchObject({ fps: 6, quality: 'low', scale: 1 });
  for (let i = 0; i < 12; i++) direct.observe(4, 35, true, 4_000, 15);
  expect(direct.profile).toMatchObject({ fps: 24, quality: 'high', scale: 1 });
});

test('raises motion cadence only after frame processing fits the faster profile', () => {
  const rate = new BrowserVncRate(false);
  const observe = (workMs: number) => rate.observe(4, 20, true, 4_000, workMs);

  expect(observe(254)).toBe(false);
  expect(observe(254)).toBe(false);
  expect(observe(254)).toBe(true);
  expect(rate.profile).toMatchObject({ fps: 12, scale: 1 });
  // 65 ms fits 12 fps, but even with a fast link it cannot sustain 24 fps.
  for (let i = 0; i < 12; i++) expect(observe(65)).toBe(false);
  for (let i = 0; i < 3; i++) expect(observe(28)).toBe(false);
  expect(observe(28)).toBe(true);
  expect(rate.profile).toMatchObject({ fps: 24, scale: 1 });
});

test('quality choices cap the adaptive profile without discarding measured congestion', () => {
  const rate = new BrowserVncRate(false);
  expect(rate.limit('medium')).toBe(true);
  expect(rate.profile.quality).toBe('medium');
  for (let i = 0; i < 3; i++) rate.observe(120, 250, true);
  expect(rate.profile.quality).toBe('low');
  expect(rate.limit('medium')).toBe(false);
  expect(rate.limit('high')).toBe(false);
  expect(rate.profile.quality).toBe('low');
  for (let i = 0; i < 4; i++) rate.observe(4, 35, true, 4000);
  expect(rate.profile.quality).toBe('medium');
  expect(rate.limit('low')).toBe(true);
  for (let i = 0; i < 8; i++) rate.observe(4, 35, true, 4000);
  expect(rate.profile.quality).toBe('low');
});

test('recovering sooner requires consecutive cheap updates and still respects the projected budget', () => {
  const rate = new BrowserVncRate(false);
  for (let i = 0; i < 3; i++) rate.observe(120, 220, true);
  expect(rate.profile.fps).toBe(12);
  for (let i = 0; i < 3; i++) expect(rate.observe(4, 35, true, 4_000)).toBe(false);
  // Fits the 75% threshold but interrupts the four-update cheap streak.
  expect(rate.observe(4, 35, true, 60_000)).toBe(false);
  for (let i = 0; i < 3; i++) expect(rate.observe(4, 35, true, 4_000)).toBe(false);
  expect(rate.observe(4, 35, true, 4_000)).toBe(true);
  expect(rate.profile.fps).toBe(24);
});

test('adapts costly motion on a fast link without interpreting steady RTT as congestion', () => {
  const rate = new BrowserVncRate(false);
  for (let i = 0; i < 9; i++) rate.observe(3, 250, false);
  expect(rate.profile.fps).toBe(24);
  for (let i = 0; i < 9; i++) rate.observe(3, 25, true, 750_000);
  expect(rate.profile.quality).toBe('low');
  for (let i = 0; i < 12; i++) rate.observe(3, 25, true, 550_000);
  expect(rate.profile.fps).toBe(4);
  for (let i = 0; i < 32; i++) rate.observe(3, 25, true, 8_000);
  expect(rate.profile.fps).toBe(24);
});

test('CopyRect ordering in both scroll directions preserves the confirmed pixels behind a fixed bar', async () => {
  const width = 24,
    height = 96,
    stride = width * 3;
  const base = raster(
    width,
    height,
    Buffer.from(Uint8Array.from({ length: stride * height }, (_, i) => i % 251))
  );
  for (const scroll of [4, -4]) {
    const frame = raster(width, height, Buffer.from(base.rgb));
    for (let y = 8; y < 88; y++) {
      if (y >= 45 && y < 50) continue;
      base.rgb.copy(frame.rgb, y * stride, (y + scroll) * stride, (y + scroll + 1) * stride);
    }
    const update = (await encodeBrowserVncUpdate(frame, base, {
      ...options,
      tight: false,
      scroll
    }))!.data;
    const actual = Buffer.from(base.rgb);
    let position = 4,
      copies = 0;
    for (let i = 0; i < update.readUInt16BE(2); i++) {
      const x = update.readUInt16BE(position),
        y = update.readUInt16BE(position + 2);
      const w = update.readUInt16BE(position + 4),
        h = update.readUInt16BE(position + 6);
      const encoding = update.readInt32BE(position + 8);
      position += 12;
      if (encoding === 1) {
        copies++;
        expect(x).toBe(0);
        expect(w).toBe(width);
        const source = update.readUInt16BE(position + 2);
        actual.copy(actual, y * stride, source * stride, (source + h) * stride);
        position += 4;
      } else {
        expect(encoding).toBe(0);
        for (let row = y; row < y + h; row++) {
          for (let col = x; col < x + w; col++) {
            update.copy(actual, row * stride + col * 3, position, position + 3);
            position += 4;
          }
        }
      }
    }
    expect(copies).toBe(2);
    expect(actual).toEqual(frame.rgb);
  }
});
