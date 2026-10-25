import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewImageTool, viewResourceImage } from '../../src/agent-core/tools/local/view-image.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/agent-core/tools/execution-limits.js';
import { WorkspacePathResolver } from '../../src/agent-core/tools/shared/path-resolver.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(data: Buffer) {
  const root = await fs.mkdtemp(join(tmpdir(), 'mar-image-integrity-'));
  roots.push(root);
  const path = join(root, 'image.bin');
  await fs.writeFile(path, data);
  return { path, tool: new ViewImageTool(new WorkspacePathResolver(root)) };
}

async function stripedPng() {
  const width = 4;
  const height = 2;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      pixels.set(x < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], offset);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

describe('Session resource image input', () => {
  it('reopens immutable bytes and uses the same crop/resize pipeline as paths', async () => {
    const bytes = await stripedPng();
    const reader = vi.fn(async () => ({ dataBase64: bytes.toString('base64') }));
    const whole = await viewResourceImage(
      { resourceId: 'stored-image', region: null, resize: null },
      reader
    );
    expect(reader).toHaveBeenCalledWith('stored-image');
    expect(whole.data).toMatchObject({ resourceId: 'stored-image', width: 4, height: 2 });
    expect(whole.images?.[0]?.dataBase64).toBe(bytes.toString('base64'));
    const input = { region: { x: 2, y: 0, width: 2, height: 2 }, resize: { maxWidth: 1 } };
    const detail = await viewResourceImage({ resourceId: 'stored-image', ...input }, reader);
    const local = await fixture(bytes);
    const pathResult = await local.tool.execute({ path: local.path, ...input });
    expect(detail.images).toEqual(pathResult.images);
    expect(detail.data).toMatchObject({
      resourceId: 'stored-image',
      width: 1,
      height: 1,
      sourceWidth: 4,
      sourceHeight: 2
    });
  });

  it('rejects ambiguous sources before reading and reports missing Session resources', async () => {
    const reader = vi.fn(async () => undefined);
    await expect(
      viewResourceImage({ path: 'image.png', resourceId: 'stored' }, reader)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    expect(reader).not.toHaveBeenCalled();
    await expect(viewResourceImage({ resourceId: 'missing' }, reader)).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID',
      message: expect.stringContaining('this Session')
    });
  });
});

async function noisyPng(width: number, height: number) {
  const pixels = Buffer.alloc(width * height * 3);
  let value = 0x12345678;
  for (let index = 0; index < pixels.length; index++) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    pixels[index] = value & 0xff;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

function jpegWithCommentPadding(jpeg: Buffer, targetBytes: number): Buffer {
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || targetBytes < jpeg.length)
    throw new Error('Expected a JPEG and a target size no smaller than the source.');

  const segments: Buffer[] = [jpeg.subarray(0, 2)];
  let remaining = targetBytes - jpeg.length;
  while (remaining >= 4) {
    let segmentBytes = Math.min(65_537, remaining);
    const remainder = remaining - segmentBytes;
    if (remainder > 0 && remainder < 4) segmentBytes -= 4 - remainder;
    const payloadBytes = segmentBytes - 4;
    const segment = Buffer.alloc(segmentBytes, 0x20);
    segment[0] = 0xff;
    segment[1] = 0xfe;
    segment.writeUInt16BE(payloadBytes + 2, 2);
    segments.push(segment);
    remaining -= segmentBytes;
  }
  if (remaining !== 0) throw new Error('Could not represent the requested JPEG size.');
  segments.push(jpeg.subarray(2));
  return Buffer.concat(segments);
}

function pngWithTextPadding(png: Buffer, targetBytes: number): Buffer {
  const iendOffset = png.byteLength - 12;
  const payloadBytes = targetBytes - png.byteLength - 12;
  if (
    iendOffset < 8 ||
    png.toString('ascii', iendOffset + 4, iendOffset + 8) !== 'IEND' ||
    payloadBytes < 10
  )
    throw new Error('Expected a complete PNG and a larger target size.');

  const payload = Buffer.alloc(payloadBytes, 0x20);
  Buffer.from('benchmark\0').copy(payload);
  const chunk = Buffer.alloc(payloadBytes + 12);
  chunk.writeUInt32BE(payloadBytes, 0);
  chunk.write('tEXt', 4, 'ascii');
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32(chunk.subarray(4, 8 + payloadBytes)), 8 + payloadBytes);
  return Buffer.concat([png.subarray(0, iendOffset), chunk, png.subarray(iendOffset)]);
}

function pngCrc32(data: Buffer): number {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function webpWithOddXmpChunk(): Promise<Buffer> {
  const webp = await sharp({
    create: { width: 1, height: 1, channels: 3, background: '#ff0000' }
  })
    .webp()
    .toBuffer();
  let payload = Buffer.from(
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>'
  );
  if (payload.byteLength % 2 === 0) payload = Buffer.concat([payload, Buffer.from(' ')]);
  const chunk = Buffer.alloc(8 + payload.byteLength + 1);
  chunk.write('XMP ', 0, 'ascii');
  chunk.writeUInt32LE(payload.byteLength, 4);
  payload.copy(chunk, 8);
  const output = Buffer.concat([webp, chunk]);
  output.writeUInt32LE(output.byteLength - 8, 4);
  return output;
}

async function webpWithXmpPadding(targetBytes: number): Promise<Buffer> {
  const webp = await sharp({
    create: { width: 1, height: 1, channels: 3, background: '#ff0000' }
  })
    .webp()
    .toBuffer();
  const chunkBytes = targetBytes - webp.byteLength;
  if (chunkBytes < 10 || chunkBytes % 2 !== 0)
    throw new Error('Expected an even RIFF padding size large enough for XMP.');
  const payloadBytes = chunkBytes - 9;
  const prefix = Buffer.from(
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description>'
  );
  const suffix = Buffer.from('</rdf:Description></rdf:RDF></x:xmpmeta>');
  const fillerBytes = payloadBytes - prefix.byteLength - suffix.byteLength;
  if (fillerBytes < 0) throw new Error('The XMP target is too small.');
  const chunk = Buffer.alloc(chunkBytes);
  chunk.write('XMP ', 0, 'ascii');
  chunk.writeUInt32LE(payloadBytes, 4);
  prefix.copy(chunk, 8);
  chunk.fill(0x20, 8 + prefix.byteLength, 8 + prefix.byteLength + fillerBytes);
  suffix.copy(chunk, 8 + prefix.byteLength + fillerBytes);
  const output = Buffer.concat([webp, chunk]);
  output.writeUInt32LE(output.byteLength - 8, 4);
  return output;
}

async function rejectionCode(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code: unknown }).code
        : undefined
  );
}

describe('local image file integrity', () => {
  it('accepts absent geometry represented as null by strict tool protocols', async () => {
    const { tool } = await fixture(png);
    const result = await tool.execute({ path: 'image.bin', region: null, resize: null });
    expect(result.data).toMatchObject({ width: 1, height: 1 });
    expect(result.images?.[0]?.dataBase64).toBe(png.toString('base64'));
    expect(
      (await tool.execute({ path: 'image.bin', resize: { maxWidth: 1, maxHeight: null } })).data
    ).toMatchObject({ width: 1, height: 1 });
    await expect(
      tool.execute({ path: 'image.bin', resize: { maxWidth: null, maxHeight: null } })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
  });
  it('returns complete PNG bytes without conversion', async () => {
    const { tool } = await fixture(png);
    const result = await tool.execute({ path: 'image.bin' });
    expect(result.images).toEqual([{ mimeType: 'image/png', dataBase64: png.toString('base64') }]);
    expect(result.content).toContain('1×1 px');
    expect(result.data).toMatchObject({ width: 1, height: 1, bytes: png.byteLength });
  });

  it('crops in source pixels before resizing and reports only effective transforms', async () => {
    const source = await stripedPng();
    const { tool } = await fixture(source);
    const cropped = await tool.execute({
      path: 'image.bin',
      region: { x: 2, y: 0, width: 2, height: 2 },
      resize: { maxWidth: 1 }
    });
    expect(cropped.data).toMatchObject({
      width: 1,
      height: 1,
      sourceWidth: 4,
      sourceHeight: 2,
      region: { x: 2, y: 0, width: 2, height: 2 }
    });
    expect(cropped.content).toContain('1×1 px');
    expect(cropped.content).toContain('4×2 px');
    const decoded = await sharp(Buffer.from(cropped.images![0]!.dataBase64, 'base64'))
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect([...decoded]).toEqual([0, 0, 255, 255]);

    const resized = await tool.execute({
      path: 'image.bin',
      resize: { maxWidth: 2, maxHeight: 2 }
    });
    expect(resized.data).toMatchObject({ width: 2, height: 1, sourceWidth: 4, sourceHeight: 2 });
    expect(resized.data).not.toHaveProperty('region');

    const noOpResize = await tool.execute({ path: 'image.bin', resize: { maxWidth: 8 } });
    expect(noOpResize.data).toMatchObject({ width: 4, height: 2 });
    expect(noOpResize.data).not.toHaveProperty('sourceWidth');
    expect(noOpResize.data).not.toHaveProperty('sourceHeight');
  });

  it('uses EXIF-oriented source dimensions and crop coordinates', async () => {
    const pixels = Buffer.from([
      255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 0, 255, 255, 255, 0, 255, 128, 128, 128, 255,
      255, 255
    ]);
    const source = await sharp(pixels, { raw: { width: 4, height: 2, channels: 3 } })
      .png()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const { tool } = await fixture(source);
    const result = await tool.execute({
      path: 'image.bin',
      region: { x: 0, y: 0, width: 1, height: 2 }
    });
    expect(result.data).toMatchObject({
      width: 1,
      height: 2,
      sourceWidth: 2,
      sourceHeight: 4,
      region: { x: 0, y: 0, width: 1, height: 2 }
    });
    const decoded = await sharp(Buffer.from(result.images![0]!.dataBase64, 'base64'))
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect([...decoded]).toEqual([0, 255, 255, 255, 255, 0, 255, 255]);
  });

  it.each([
    { path: 'image.bin', resize: {} },
    { path: 'image.bin', region: { x: 0, y: 0, width: 0, height: 1 } },
    { path: 'image.bin', region: { x: -1, y: 0, width: 1, height: 1 } },
    { path: 'image.bin', region: { x: 0.5, y: 0, width: 1, height: 1 } },
    { path: 'image.bin', region: { x: Number.MAX_SAFE_INTEGER, y: 0, width: 1, height: 1 } },
    { path: 'image.bin', resize: { maxWidth: Number.MAX_SAFE_INTEGER + 1 } },
    { path: 'image.bin', region: { x: 0, y: 0, width: 1, height: 1 }, extra: true }
  ])('rejects invalid geometry before reading the source: %j', async (input) => {
    const { tool } = await fixture(png);
    await expect(tool.execute(input)).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
  });

  it('rejects source regions beyond oriented image bounds instead of clipping them', async () => {
    const { tool } = await fixture(await stripedPng());
    await expect(
      tool.execute({ path: 'image.bin', region: { x: 3, y: 0, width: 2, height: 2 } })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
  });

  it('enforces the 3 MiB path-only and transformed-output byte limit', async () => {
    const source = await noisyPng(1200, 1200);
    expect(source.byteLength).toBeGreaterThan(TOOL_EXECUTION_LIMITS.viewImageMaxBytes);
    const { tool } = await fixture(source);
    expect(await rejectionCode(tool.execute({ path: 'image.bin' }))).toBe(
      'MAR_AGENT_TOOL_OUTPUT_LIMIT'
    );
    expect(
      await rejectionCode(tool.execute({ path: 'image.bin', resize: { maxWidth: 1200 } }))
    ).toBe('MAR_AGENT_TOOL_OUTPUT_LIMIT');
  });

  it('allows a larger source when its resized PNG output fits the visual byte limit', async () => {
    const source = await noisyPng(1200, 1200);
    const { tool } = await fixture(source);
    const result = await tool.execute({
      path: 'image.bin',
      resize: { maxWidth: 120, maxHeight: 120 }
    });
    expect(result.data).toMatchObject({
      width: 120,
      height: 120,
      sourceWidth: 1200,
      sourceHeight: 1200
    });
    expect((result.data as { bytes: number }).bytes).toBeLessThanOrEqual(
      TOOL_EXECUTION_LIMITS.viewImageMaxBytes
    );
  });

  it.each(['PNG', 'JPEG', 'WebP'] as const)(
    'accepts a path-only %s exactly at 3 MiB without changing its bytes',
    async (format) => {
      const image = sharp({
        create: { width: 1, height: 1, channels: 3, background: '#ff0000' }
      });
      const base =
        format === 'PNG'
          ? await image.png().toBuffer()
          : format === 'JPEG'
            ? await image.jpeg().toBuffer()
            : await image.webp().toBuffer();
      const source =
        format === 'PNG'
          ? pngWithTextPadding(base, TOOL_EXECUTION_LIMITS.viewImageMaxBytes)
          : format === 'JPEG'
            ? jpegWithCommentPadding(base, TOOL_EXECUTION_LIMITS.viewImageMaxBytes)
            : await webpWithXmpPadding(TOOL_EXECUTION_LIMITS.viewImageMaxBytes);
      await sharp(source, { failOn: 'warning' }).raw().toBuffer();
      const { tool } = await fixture(source);
      const result = await tool.execute({ path: 'image.bin' });
      const outputBytes = Buffer.from(result.images![0]!.dataBase64, 'base64');
      expect(result.data).toMatchObject({
        mimeType: format === 'PNG' ? 'image/png' : format === 'JPEG' ? 'image/jpeg' : 'image/webp',
        width: 1,
        height: 1,
        bytes: source.byteLength,
        sha256: createHash('sha256').update(source).digest('hex')
      });
      expect(createHash('sha256').update(outputBytes).digest('hex')).toBe(
        createHash('sha256').update(source).digest('hex')
      );
    }
  );

  it('accepts a 20 MiB conversion source and rejects a larger one before processing', async () => {
    const jpeg = await sharp({
      create: { width: 1, height: 1, channels: 3, background: '#ff0000' }
    })
      .jpeg()
      .toBuffer();
    const atLimit = jpegWithCommentPadding(jpeg, TOOL_EXECUTION_LIMITS.viewImageMaxSourceBytes);
    const accepted = await fixture(atLimit);
    await expect(
      accepted.tool.execute({ path: 'image.bin', resize: { maxWidth: 1 } })
    ).resolves.toMatchObject({ data: { width: 1, height: 1 } });

    const overLimit = jpegWithCommentPadding(
      jpeg,
      TOOL_EXECUTION_LIMITS.viewImageMaxSourceBytes + 2
    );
    const rejected = await fixture(overLimit);
    expect(
      await rejectionCode(rejected.tool.execute({ path: 'image.bin', resize: { maxWidth: 1 } }))
    ).toBe('MAR_AGENT_TOOL_OUTPUT_LIMIT');
  });

  it('rejects dimensions above the explicit input pixel limit without decoding pixels', async () => {
    const source = await sharp({
      create: {
        width: 4097,
        height: 4097,
        channels: 3,
        background: { r: 250, g: 250, b: 250 }
      }
    })
      .png()
      .toBuffer();
    const { tool } = await fixture(source);
    await expect(tool.execute({ path: 'image.bin' })).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_OUTPUT_LIMIT',
      message: expect.stringContaining('4096×4096')
    });
  });

  it('allows a long side above 4096 when total pixel area is within the limit', async () => {
    const source = await sharp({
      create: { width: 8192, height: 1, channels: 3, background: '#ffffff' }
    })
      .png()
      .toBuffer();
    const { tool } = await fixture(source);
    expect((await tool.execute({ path: 'image.bin' })).data).toMatchObject({
      width: 8192,
      height: 1
    });
  });

  it.each([8, 20, 40, png.length - 12, png.length - 1])(
    'rejects an unfinished PNG prefix of %s bytes before publishing pixels',
    async (bytes) => {
      const { tool } = await fixture(png.subarray(0, bytes));
      await expect(tool.execute({ path: 'image.bin' })).rejects.toMatchObject({
        code: 'MAR_AGENT_IMAGE_INCOMPLETE',
        message: expect.stringContaining('writer')
      });
    }
  );

  it('rejects a malformed chunk length even when an IEND suffix exists', async () => {
    const malformed = Buffer.from(png);
    malformed.writeUInt32BE(0xffffffff, 33);
    const { tool } = await fixture(malformed);
    await expect(tool.execute({ path: 'image.bin' })).rejects.toMatchObject({
      code: 'MAR_AGENT_IMAGE_INCOMPLETE'
    });
  });

  it.each(['growth', 'same-size rewrite'])(
    'rejects %s during its read even when the captured PNG is complete',
    async (change) => {
      const { tool, path } = await fixture(png);
      const { open: originalOpen } =
        await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        const handle = await originalOpen(...args);
        const originalRead = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementationOnce(
          async (buffer, offset, length, position) => {
            const result = await originalRead(buffer, offset, length, position);
            const updated =
              change === 'growth' ? Buffer.concat([png, Buffer.from([0])]) : Buffer.from(png);
            updated[updated.length - 1] = updated[updated.length - 1]! ^ 1;
            await fs.writeFile(path, updated);
            await fs.utimes(path, new Date(0), new Date(0));
            return result;
          }
        );
        return handle;
      });
      await expect(tool.execute({ path: 'image.bin' })).rejects.toMatchObject({
        code: 'MAR_AGENT_IMAGE_INCOMPLETE'
      });
    }
  );

  it('honors cancellation during the post-read stat without publishing pixels', async () => {
    const { tool } = await fixture(png);
    const controller = new AbortController();
    const reason = new Error('fixture cancellation');
    const { open: originalOpen } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      const originalStat = handle.stat.bind(handle);
      let calls = 0;
      vi.spyOn(handle, 'stat').mockImplementation(async (options) => {
        const stat = await originalStat(options);
        if (++calls === 2) controller.abort(reason);
        return stat;
      });
      return handle;
    });
    await expect(tool.execute({ path: 'image.bin' }, controller.signal)).rejects.toBe(reason);
  });

  it('preserves complete JPEG bytes without conversion', async () => {
    const data = await sharp({
      create: { width: 1, height: 1, channels: 3, background: '#00ff00' }
    })
      .jpeg()
      .toBuffer();
    await sharp(data, { failOn: 'warning' }).raw().toBuffer();
    const { tool } = await fixture(data);
    expect((await tool.execute({ path: 'image.bin' })).images).toEqual([
      { mimeType: 'image/jpeg', dataBase64: data.toString('base64') }
    ]);
  });

  it('preserves complete WebP bytes', async () => {
    const data = Buffer.from(
      'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v02aAA=',
      'base64'
    );
    await sharp(data, { failOn: 'warning' }).raw().toBuffer();
    const { tool } = await fixture(data);
    expect((await tool.execute({ path: 'image.bin' })).images).toEqual([
      { mimeType: 'image/webp', dataBase64: data.toString('base64') }
    ]);
  });

  it('does not mistake an EOI inside JPEG metadata for a complete image', async () => {
    const data = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 6, 0, 0, 0xff, 0xd9]);
    const { tool } = await fixture(data);
    await expect(tool.execute({ path: 'image.bin' })).rejects.toMatchObject({
      code: 'MAR_AGENT_IMAGE_INCOMPLETE'
    });
  });

  it('preserves WebP bytes with an odd-sized padded XMP chunk', async () => {
    const data = await webpWithOddXmpChunk();
    await sharp(data, { failOn: 'warning' }).raw().toBuffer();
    const { tool } = await fixture(data);
    expect((await tool.execute({ path: 'image.bin' })).images).toEqual([
      { mimeType: 'image/webp', dataBase64: data.toString('base64') }
    ]);
  });

  it.each(['missing IHDR', 'missing IDAT', 'zero width', 'nonempty IEND'])(
    'rejects a PNG with %s',
    async (condition) => {
      let data = Buffer.from(png);
      if (condition === 'missing IHDR')
        data = Buffer.concat([data.subarray(0, 8), data.subarray(33)]);
      else if (condition === 'missing IDAT')
        data = Buffer.concat([data.subarray(0, 33), data.subarray(data.length - 12)]);
      else if (condition === 'zero width') data.writeUInt32BE(0, 16);
      else data.writeUInt32BE(1, data.length - 12);
      const { tool } = await fixture(data);
      await expect(tool.execute({ path: 'image.bin' })).rejects.toMatchObject({
        code: 'MAR_AGENT_IMAGE_INCOMPLETE'
      });
    }
  );

  it('rejects a WebP chunk extending beyond an otherwise complete RIFF container', async () => {
    const data = Buffer.from(
      'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v02aAA=',
      'base64'
    );
    data.writeUInt32LE(0xffff, 16);
    const { tool } = await fixture(data);
    await expect(tool.execute({ path: 'image.bin' })).rejects.toMatchObject({
      code: 'MAR_AGENT_IMAGE_INCOMPLETE'
    });
  });

  it.each([
    {
      name: 'JPEG without its end marker',
      data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0])
    },
    {
      name: 'WebP shorter than its RIFF declaration',
      data: Buffer.from('5249464610000000574542505650384c', 'hex')
    }
  ])('rejects $name', async ({ data }) => {
    const { tool } = await fixture(data);
    await expect(tool.execute({ path: 'image.bin' })).rejects.toMatchObject({
      code: 'MAR_AGENT_IMAGE_INCOMPLETE'
    });
  });
});
