import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isBmpAttachment,
  normalizeComposerImage
} from '../../src/util/composer-image-compatibility.js';

afterEach(() => vi.unstubAllGlobals());

function decoder(options: { width?: number; height?: number; output?: Blob | null } = {}) {
  const bitmap = { width: options.width ?? 800, height: options.height ?? 480, close: vi.fn() };
  const decode = vi.fn(async () => bitmap);
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    toBlob: (callback: BlobCallback) =>
      callback(
        options.output === undefined ? new Blob(['png'], { type: 'image/png' }) : options.output
      )
  };
  const createElement = vi.fn(() => canvas);
  vi.stubGlobal('createImageBitmap', decode);
  vi.stubGlobal('document', { createElement });
  return { bitmap, canvas, decode, drawImage, createElement };
}

describe('Composer BMP compatibility', () => {
  it.each([
    'image/bmp',
    'image/x-bmp',
    'image/x-ms-bmp',
    'image/x-windows-bmp',
    '',
    'application/octet-stream'
  ])('recognizes BMP input with MIME %s', (type) =>
    expect(isBmpAttachment(new File(['bmp'], 'capture.BMP', { type }))).toBe(true)
  );

  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain'])(
    'preserves supported images and ordinary files (%s)',
    async (type) => {
      const file = new File(['original'], 'capture.bmp', { type });
      expect(isBmpAttachment(file)).toBe(false);
      expect(await normalizeComposerImage(file)).toBe(file);
    }
  );

  it.each(['image/bmp', 'image/x-windows-bmp'])(
    'exports full-resolution PNG bytes and updates the name and MIME (%s)',
    async (type) => {
      const f = decoder();
      const source = new File(['bmp'], 'scope.BMP', { type, lastModified: 123 });
      const converted = await normalizeComposerImage(source);
      expect(converted.name).toBe('scope.png');
      expect(converted.type).toBe('image/png');
      expect(converted.lastModified).toBe(123);
      expect(await converted.text()).toBe('png');
      expect(f.canvas).toMatchObject({ width: 800, height: 480 });
      expect(f.drawImage).toHaveBeenCalledWith(f.bitmap, 0, 0);
      expect(f.bitmap.close).toHaveBeenCalledOnce();
    }
  );

  it('rejects oversized sources before decoding', async () => {
    const f = decoder();
    await expect(
      normalizeComposerImage(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.bmp'))
    ).rejects.toThrow('COMPOSER_IMAGE_LIMIT_EXCEEDED');
    expect(f.decode).not.toHaveBeenCalled();
  });

  it('bounds canvas allocation without resizing and releases the decoded bitmap', async () => {
    const f = decoder({ width: 8192, height: 8192 });
    await expect(normalizeComposerImage(new File(['bmp'], 'large.bmp'))).rejects.toThrow(
      'COMPOSER_IMAGE_LIMIT_EXCEEDED'
    );
    expect(f.createElement).not.toHaveBeenCalled();
    expect(f.bitmap.close).toHaveBeenCalledOnce();
  });

  it('rejects oversized PNG output', async () => {
    const f = decoder({
      output: new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/png' })
    });
    await expect(normalizeComposerImage(new File(['bmp'], 'scope.bmp'))).rejects.toThrow(
      'COMPOSER_IMAGE_LIMIT_EXCEEDED'
    );
    expect(f.bitmap.close).toHaveBeenCalledOnce();
  });

  it('reports decode and encoding failures instead of returning the BMP', async () => {
    const f = decoder({ output: null });
    await expect(normalizeComposerImage(new File(['bmp'], 'scope.bmp'))).rejects.toThrow(
      'COMPOSER_IMAGE_CONVERSION_FAILED'
    );
    expect(f.bitmap.close).toHaveBeenCalledOnce();
    f.decode.mockRejectedValueOnce(new Error('decoder failed'));
    await expect(normalizeComposerImage(new File(['bmp'], 'scope.bmp'))).rejects.toThrow(
      'COMPOSER_IMAGE_CONVERSION_FAILED'
    );
  });
});
