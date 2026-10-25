export interface ModelImage {
  readonly mimeType: string;
  readonly dataBase64?: string;
  readonly resourceId?: string;
  readonly byteSize?: number;
  /** Fixed published resource; image bytes are persisted separately. */
  readonly url?: string;
  readonly urlExpiresAt?: number;
}

export function modelImageUrl(image: ModelImage): string {
  if (image.url !== undefined && isModelImageUrl(image.url)) return image.url;
  if (typeof image.dataBase64 !== 'string' || image.dataBase64.length === 0)
    throw new Error('Model image has no usable source.');
  return `data:${image.mimeType};base64,${image.dataBase64}`;
}

export function modelImageKey(image: ModelImage): string {
  return `${image.mimeType}\u0000${modelImageUrl(image)}`;
}

/** Only immutable URL references may enter durable model history. */
export function persistedModelImages(images: readonly ModelImage[] | undefined): ModelImage[] {
  return (images ?? [])
    .filter((image) => isModelImageUrl(image.url) || image.resourceId !== undefined)
    .map((image) => ({
      mimeType: image.mimeType,
      ...(image.url === undefined ? {} : { url: image.url }),
      ...(image.urlExpiresAt === undefined ? {} : { urlExpiresAt: image.urlExpiresAt }),
      ...(image.resourceId === undefined ? {} : { resourceId: image.resourceId }),
      ...(image.byteSize === undefined ? {} : { byteSize: image.byteSize })
    }));
}

/** Durable images contain a URL or resource reference, never inline image bytes. */
export function parseModelImages(value: unknown): ModelImage[] | undefined {
  if (
    !Array.isArray(value) ||
    !value.every(
      (image) =>
        image &&
        typeof image.mimeType === 'string' &&
        (image.url === undefined || isModelImageUrl(image.url)) &&
        (image.resourceId === undefined ||
          (typeof image.resourceId === 'string' && /^[a-f0-9]{64}$/u.test(image.resourceId))) &&
        (image.byteSize === undefined ||
          (Number.isSafeInteger(image.byteSize) && image.byteSize > 0)) &&
        (image.urlExpiresAt === undefined ||
          (Number.isSafeInteger(image.urlExpiresAt) && image.urlExpiresAt > 0)) &&
        (image.url !== undefined || image.resourceId !== undefined)
    )
  )
    return undefined;
  return persistedModelImages(value);
}

export function isModelImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}
