import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ImagePreviewOptions } from '@myagentroam/protocol';

export const MAX_IMAGE_PREVIEW_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 64;
const MAX_PENDING = 16;
const MAX_PENDING_BYTES = 64 * 1024 * 1024;

export interface ImagePreview {
  readonly mime: 'image/webp';
  readonly dataBase64: string;
  readonly resized: boolean;
}

/** Sources must be read through their original authorization boundary before every call. */
export class ImagePreviewService {
  private readonly cache = new Map<string, { readonly bytes: Buffer; readonly resized: boolean }>();
  private readonly pending = new Map<string, Promise<ImagePreview>>();
  private cacheBytes = 0;
  private pendingBytes = 0;
  private tail: Promise<unknown> = Promise.resolve();

  async create(bytes: Buffer, options: ImagePreviewOptions): Promise<ImagePreview> {
    if (bytes.length === 0) throw new Error('IMAGE_PREVIEW_INVALID');
    if (bytes.length > MAX_IMAGE_PREVIEW_SOURCE_BYTES) throw new Error('IMAGE_PREVIEW_TOO_LARGE');
    const key = createHash('sha256')
      .update(`${options.maxWidth}x${options.maxHeight}\0`)
      .update(bytes)
      .digest('hex');
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return {
        mime: 'image/webp',
        dataBase64: cached.bytes.toString('base64'),
        resized: cached.resized
      };
    }
    const current = this.pending.get(key);
    if (current !== undefined) return current;
    if (this.pending.size >= MAX_PENDING || this.pendingBytes + bytes.length > MAX_PENDING_BYTES)
      throw new Error('IMAGE_PREVIEW_BUSY');
    this.pendingBytes += bytes.length;
    const result = this.tail
      .catch(() => undefined)
      .then(async () => {
        let output: Buffer;
        let resized: boolean;
        try {
          const pipeline = sharp(bytes, { limitInputPixels: 64 * 1024 * 1024, pages: 1 });
          const metadata = await pipeline.metadata();
          const rotated = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
          const width = rotated ? metadata.height : metadata.width;
          const height = rotated ? metadata.width : metadata.height;
          if (width === undefined || height === undefined) throw new Error('IMAGE_PREVIEW_INVALID');
          resized = width > options.maxWidth || height > options.maxHeight;
          output = await pipeline
            .rotate()
            .resize({
              width: options.maxWidth,
              height: options.maxHeight,
              fit: 'inside',
              withoutEnlargement: true
            })
            .webp({ quality: 85, effort: 3 })
            .toBuffer();
        } catch {
          throw new Error('IMAGE_PREVIEW_INVALID');
        }
        this.cache.set(key, { bytes: output, resized });
        this.cacheBytes += output.length;
        while (this.cache.size > MAX_CACHE_ENTRIES || this.cacheBytes > MAX_CACHE_BYTES) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.cacheBytes -= this.cache.get(oldest)!.bytes.length;
          this.cache.delete(oldest);
        }
        return { mime: 'image/webp' as const, dataBase64: output.toString('base64'), resized };
      });
    this.pending.set(key, result);
    this.tail = result;
    try {
      return await result;
    } finally {
      this.pending.delete(key);
      this.pendingBytes -= bytes.length;
    }
  }

  fromImage(image: unknown, options: ImagePreviewOptions): Promise<ImagePreview> {
    const source = image as { readonly dataBase64?: unknown } | null;
    if (typeof source?.dataBase64 !== 'string') throw new Error('IMAGE_PREVIEW_INVALID');
    if (source.dataBase64.length > Math.ceil(MAX_IMAGE_PREVIEW_SOURCE_BYTES / 3) * 4)
      throw new Error('IMAGE_PREVIEW_TOO_LARGE');
    if (this.pendingBytes + Math.floor((source.dataBase64.length * 3) / 4) > MAX_PENDING_BYTES)
      throw new Error('IMAGE_PREVIEW_BUSY');
    return this.create(Buffer.from(source.dataBase64, 'base64'), options);
  }
}

export const imagePreviews = new ImagePreviewService();
