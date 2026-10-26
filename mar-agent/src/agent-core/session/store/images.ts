import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { MarAgentError } from '../../error.js';
import type { SessionRecord } from './types.js';
import { isModelImageUrl } from '../../model/image.js';

export const MAX_INPUT_IMAGES = 5;

const MAX_INPUT_IMAGE_BYTES = 5 * 1024 * 1024;

const MAX_INPUT_IMAGES_BYTES = 10 * 1024 * 1024;

const INPUT_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function generatedImageFileNames(records: readonly SessionRecord[]): readonly string[] {
  const names = new Set<string>();
  for (const record of records) {
    if (record.type !== 'tool.completed' || !isObject(record.payload)) continue;
    const artifacts = record.payload.artifacts;
    if (!Array.isArray(artifacts)) continue;
    for (const artifact of artifacts) {
      if (
        !isObject(artifact) ||
        artifact.kind !== 'image' ||
        typeof artifact.fileName !== 'string' ||
        basename(artifact.fileName) !== artifact.fileName ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.png$/u.test(artifact.fileName)
      )
        continue;
      names.add(artifact.fileName);
    }
  }
  return [...names];
}

export async function copyGeneratedImages(
  sourceSessionDirectory: string,
  targetSessionDirectory: string,
  fileNames: readonly string[]
): Promise<void> {
  if (fileNames.length === 0) return;
  const source = join(sourceSessionDirectory, 'generated_images');
  const target = join(targetSessionDirectory, 'generated_images');
  await mkdir(target, { recursive: true });
  for (const fileName of fileNames) await copyFile(join(source, fileName), join(target, fileName));
}

interface InputImageReference {
  readonly name: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly resourceId?: string;
  readonly url?: string;
  readonly urlExpiresAt?: number;
}

export function inputImageReferences(value: unknown): InputImageReference[] {
  if (!Array.isArray(value)) return [];
  const references: InputImageReference[] = [];
  let totalBytes = 0;
  for (const image of value) {
    const reference = inputImageReference(image);
    if (reference === undefined) continue;
    totalBytes += reference.byteSize;
    if (references.length >= MAX_INPUT_IMAGES || totalBytes > MAX_INPUT_IMAGES_BYTES)
      throw corruptInputImageReference();
    references.push(reference);
  }
  return references;
}

export function inputImageReference(value: unknown): InputImageReference | undefined {
  if (!isObject(value) || !Object.hasOwn(value, 'fileName')) return undefined;
  if (
    typeof value.name !== 'string' ||
    typeof value.mimeType !== 'string' ||
    !INPUT_IMAGE_MIME_TYPES.has(value.mimeType) ||
    typeof value.byteSize !== 'number' ||
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize <= 0 ||
    value.byteSize > MAX_INPUT_IMAGE_BYTES ||
    typeof value.fileName !== 'string' ||
    !validInputImageFileName(value.fileName) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    (value.resourceId !== undefined &&
      (typeof value.resourceId !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(value.resourceId) ||
        value.fileName !== `${value.resourceId}.bin`)) ||
    (value.url !== undefined && !isModelImageUrl(value.url)) ||
    (value.urlExpiresAt !== undefined &&
      (typeof value.urlExpiresAt !== 'number' ||
        !Number.isSafeInteger(value.urlExpiresAt) ||
        value.urlExpiresAt <= 0)) ||
    (value.urlExpiresAt !== undefined && value.url === undefined)
  )
    throw corruptInputImageReference();
  return {
    name: value.name,
    fileName: value.fileName,
    mimeType: value.mimeType,
    byteSize: value.byteSize,
    sha256: value.sha256,
    ...(typeof value.resourceId === 'string' ? { resourceId: value.resourceId } : {}),
    ...(value.url === undefined ? {} : { url: value.url }),
    ...(typeof value.urlExpiresAt === 'number' ? { urlExpiresAt: value.urlExpiresAt } : {})
  };
}

export function validInputImageFileName(fileName: string): boolean {
  return (
    basename(fileName) === fileName && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.bin$/u.test(fileName)
  );
}

export async function readInputImageBytes(
  directory: string,
  reference: InputImageReference
): Promise<Buffer> {
  try {
    return await readFile(join(directory, reference.fileName));
  } catch (cause) {
    throw new MarAgentError('MAR_AGENT_IMAGE_UNAVAILABLE', 'Session input image is unavailable.', {
      cause
    });
  }
}

function corruptInputImageReference(cause?: unknown): MarAgentError {
  return new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session input image is corrupt.', {
    ...(cause === undefined ? {} : { cause })
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
