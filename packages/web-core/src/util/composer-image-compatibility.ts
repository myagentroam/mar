import { errorCode } from './api-error.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;

export function isBmpAttachment(file: File): boolean {
  return (
    ['image/bmp', 'image/x-bmp', 'image/x-ms-bmp', 'image/x-windows-bmp'].includes(file.type) ||
    ((file.type === '' || file.type === 'application/octet-stream') && /\.bmp$/iu.test(file.name))
  );
}

export async function normalizeComposerImage(file: File): Promise<File> {
  if (!isBmpAttachment(file)) return file;
  if (file.size === 0 || file.size > MAX_FILE_BYTES)
    throw new Error('COMPOSER_IMAGE_LIMIT_EXCEEDED');
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    if (bitmap.width * bitmap.height > MAX_PIXELS) throw new Error('COMPOSER_IMAGE_LIMIT_EXCEEDED');
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('COMPOSER_IMAGE_CONVERSION_FAILED');
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (png === null || png.size === 0 || png.type !== 'image/png')
      throw new Error('COMPOSER_IMAGE_CONVERSION_FAILED');
    if (png.size > MAX_FILE_BYTES) throw new Error('COMPOSER_IMAGE_LIMIT_EXCEEDED');
    const name = /\.bmp$/iu.test(file.name)
      ? file.name.replace(/\.bmp$/iu, '.png')
      : `${file.name}.png`;
    return new File([png], name, { type: 'image/png', lastModified: file.lastModified });
  } catch (error) {
    if (errorCode(error) === 'COMPOSER_IMAGE_LIMIT_EXCEEDED') throw error;
    throw new Error('COMPOSER_IMAGE_CONVERSION_FAILED');
  } finally {
    bitmap?.close();
  }
}
