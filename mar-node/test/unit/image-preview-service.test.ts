import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeWorkspace } from '../../src/database.js';
import {
  ImagePreviewService,
  MAX_IMAGE_PREVIEW_SOURCE_BYTES
} from '../../src/service/image-preview-service.js';
import { WorkspaceFileService } from '../../src/service/workspace-file-service.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('image previews', () => {
  it('decodes real PNGs to bounded WebP without changing the source bytes', async () => {
    const service = new ImagePreviewService();
    const source = await png(640, 480);
    const original = Buffer.from(source);
    const preview = { maxWidth: 320, maxHeight: 240 };

    const image = await service.create(source, preview);
    const decoded = await sharp(Buffer.from(image.dataBase64, 'base64')).metadata();

    expect(image.mime).toBe('image/webp');
    expect(image.resized).toBe(true);
    expect(decoded).toMatchObject({ format: 'webp', width: 320, height: 240 });
    expect(source).toEqual(original);
  });

  it('coalesces concurrent decodes and continues after invalid or oversized input', async () => {
    const service = new ImagePreviewService();
    const source = await png(900, 600);
    const preview = { maxWidth: 320, maxHeight: 240 };
    const first = service.create(source, preview);
    const second = service.create(source, preview);
    const pending = (service as unknown as { pending: Map<string, Promise<unknown>> }).pending;

    expect(pending.size).toBe(1);
    const [firstImage, secondImage] = await Promise.all([first, second]);
    expect(firstImage).toEqual(secondImage);
    await expect(service.fromImage({ dataBase64: '' }, preview)).rejects.toThrow(
      'IMAGE_PREVIEW_INVALID'
    );
    await expect(service.create(Buffer.from('not an image'), preview)).rejects.toThrow(
      'IMAGE_PREVIEW_INVALID'
    );
    await expect(
      service.create(Buffer.alloc(MAX_IMAGE_PREVIEW_SOURCE_BYTES + 1), preview)
    ).rejects.toThrow('IMAGE_PREVIEW_TOO_LARGE');
    await expect(service.create(await png(32, 24), preview)).resolves.toMatchObject({
      mime: 'image/webp',
      resized: false
    });
  });

  it('rejects oversized base64 before allocating its decoded Buffer', async () => {
    const service = new ImagePreviewService();
    const encodedLimit = Math.ceil(MAX_IMAGE_PREVIEW_SOURCE_BYTES / 3) * 4;
    const dataBase64 = 'A'.repeat(encodedLimit + 1);
    const bufferFrom = vi.spyOn(Buffer, 'from');
    let result: Promise<unknown> | undefined;
    let thrown: unknown;

    try {
      result = service.fromImage({ dataBase64 }, { maxWidth: 320, maxHeight: 240 });
    } catch (error) {
      thrown = error;
    }
    const decodeCalls = bufferFrom.mock.calls.length;
    bufferFrom.mockRestore();

    if (result !== undefined) {
      await expect(result).rejects.toThrow('IMAGE_PREVIEW_TOO_LARGE');
    } else {
      expect(thrown).toMatchObject({ message: 'IMAGE_PREVIEW_TOO_LARGE' });
    }
    expect(decodeCalls).toBe(0);
  });

  it('enforces the pending-byte budget and releases it after failed decodes', async () => {
    const service = new ImagePreviewService();
    const preview = { maxWidth: 320, maxHeight: 240 };
    const sources = [
      Buffer.alloc(24 * 1024 * 1024, 1),
      Buffer.alloc(24 * 1024 * 1024, 2),
      Buffer.alloc(24 * 1024 * 1024, 3)
    ];

    const first = service.create(sources[0]!, preview);
    const second = service.create(sources[1]!, preview);
    const duplicate = service.create(sources[0]!, preview);
    const overBudget = service.create(sources[2]!, preview);
    const results = await Promise.allSettled([first, second, duplicate, overBudget]);
    const messages = results.map((result) =>
      result.status === 'rejected' ? result.reason.message : 'fulfilled'
    );

    expect(messages).toEqual([
      'IMAGE_PREVIEW_INVALID',
      'IMAGE_PREVIEW_INVALID',
      'IMAGE_PREVIEW_INVALID',
      'IMAGE_PREVIEW_BUSY'
    ]);
    await expect(service.create(sources[0]!, preview)).rejects.toThrow('IMAGE_PREVIEW_INVALID');
  });

  it('keeps cached outputs isolated by requested dimensions', async () => {
    const service = new ImagePreviewService();
    const source = await png(1024, 512);
    const wide = await service.create(source, { maxWidth: 320, maxHeight: 240 });
    const small = await service.create(source, { maxWidth: 64, maxHeight: 64 });

    expect(wide.dataBase64).not.toBe(small.dataBase64);
    expect(wide.resized).toBe(true);
    expect(small.resized).toBe(true);
    expect(await sharp(Buffer.from(wide.dataBase64, 'base64')).metadata()).toMatchObject({
      width: 320,
      height: 160
    });
    expect(await sharp(Buffer.from(small.dataBase64, 'base64')).metadata()).toMatchObject({
      width: 64,
      height: 32
    });
  });

  it('scales a 2560px long edge and does not enlarge smaller images', async () => {
    const service = new ImagePreviewService();
    const options = { maxWidth: 2560, maxHeight: 2560 };
    const large = await service.create(await png(4096, 2048), options);
    const small = await service.create(await png(800, 400), options);

    expect(large.resized).toBe(true);
    expect(await sharp(Buffer.from(large.dataBase64, 'base64')).metadata()).toMatchObject({
      width: 2560,
      height: 1280
    });
    expect(small.resized).toBe(false);
    expect(await sharp(Buffer.from(small.dataBase64, 'base64')).metadata()).toMatchObject({
      width: 800,
      height: 400
    });
  });

  it('revalidates a Workspace source before returning a cached preview', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-image-preview-'));
    directories.push(directory);
    const path = join(directory, 'image.png');
    const source = await png(48, 32);
    await writeFile(path, source);
    const files = new WorkspaceFileService({} as never, () => undefined);
    const workspace = { id: 'workspace-1', path: directory } as NodeWorkspace;

    const preview = { maxWidth: 2560, maxHeight: 2560 };
    const image = await files.previewImage(workspace, { path: 'image.png', preview });
    expect(image.mime).toBe('image/webp');
    expect(image.resized).toBe(false);
    expect(await readFile(path)).toEqual(source);

    await unlink(path);
    await expect(files.previewImage(workspace, { path: 'image.png', preview })).rejects.toThrow();
  });

  it('reports resizing against the displayed EXIF orientation rather than raw axes', async () => {
    const source = await sharp(await png(200, 400))
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const service = new ImagePreviewService();
    const unchanged = await service.create(source, { maxWidth: 450, maxHeight: 220 });
    expect(unchanged.resized).toBe(false);
    expect(await sharp(Buffer.from(unchanged.dataBase64, 'base64')).metadata()).toMatchObject({
      width: 400,
      height: 200
    });
    const resized = await service.create(source, { maxWidth: 320, maxHeight: 240 });
    expect(resized.resized).toBe(true);
    expect(await sharp(Buffer.from(resized.dataBase64, 'base64')).metadata()).toMatchObject({
      width: 320,
      height: 160
    });
  });

  it('rejects images beyond the decoded-pixel limit', async () => {
    const service = new ImagePreviewService();
    const source = await sharp({
      create: { width: 8193, height: 8192, channels: 3, background: { r: 0, g: 0, b: 0 } }
    })
      .png()
      .toBuffer();

    await expect(service.create(source, { maxWidth: 320, maxHeight: 240 })).rejects.toThrow(
      'IMAGE_PREVIEW_INVALID'
    );
  });
});

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 50, g: 100, b: 150 } }
  })
    .png()
    .toBuffer();
}
