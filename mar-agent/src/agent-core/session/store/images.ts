import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { MarAgentError } from '../../error.js';
import type { SessionInputImage, SessionInputImageMetadata, SessionRecord } from './types.js';
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

export function inputImageReferencesFromRecords(
  records: readonly SessionRecord[]
): readonly InputImageReference[] {
  const references = new Map<string, InputImageReference>();
  for (const record of records) {
    if (record.type !== 'turn.user' || !isObject(record.payload)) continue;
    for (const reference of inputImageReferences(record.payload.images)) {
      if (reference.resourceId !== undefined) continue;
      const existing = references.get(reference.fileName);
      if (
        existing !== undefined &&
        (existing.mimeType !== reference.mimeType ||
          existing.byteSize !== reference.byteSize ||
          existing.sha256 !== reference.sha256)
      )
        throw corruptInputImageReference();
      references.set(reference.fileName, reference);
    }
  }
  return [...references.values()];
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
  const path = join(directory, reference.fileName);
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try {
      const before = await lstat(path);
      if (!before.isFile() || before.size !== reference.byteSize)
        throw corruptInputImageReference();
      const flags =
        process.platform === 'win32'
          ? constants.O_RDONLY
          : constants.O_RDONLY | constants.O_NOFOLLOW;
      handle = await open(path, flags);
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.size !== reference.byteSize ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino
      )
        continue;
      const data = await readExactBytes(handle, reference.byteSize);
      const after = await handle.stat();
      if (
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs
      )
        continue;
      if (createHash('sha256').update(data).digest('hex') !== reference.sha256)
        throw corruptInputImageReference();
      return data;
    } catch (cause) {
      if (cause instanceof MarAgentError) throw cause;
      throw corruptInputImageReference(cause);
    } finally {
      await handle?.close();
    }
  }
  throw corruptInputImageReference();
}

async function readExactBytes(
  handle: Awaited<ReturnType<typeof open>>,
  byteSize: number
): Promise<Buffer> {
  const data = Buffer.alloc(byteSize);
  let offset = 0;
  while (offset < byteSize) {
    const { bytesRead } = await handle.read(data, offset, byteSize - offset, offset);
    if (bytesRead === 0) throw corruptInputImageReference();
    offset += bytesRead;
  }
  const extra = Buffer.allocUnsafe(1);
  if ((await handle.read(extra, 0, 1, byteSize)).bytesRead !== 0)
    throw corruptInputImageReference();
  return data;
}

export async function copyInputImages(
  sourceSessionDirectory: string,
  targetSessionDirectory: string,
  references: readonly InputImageReference[]
): Promise<void> {
  if (references.length === 0) return;
  const source = join(sourceSessionDirectory, 'input_images');
  const target = join(targetSessionDirectory, 'input_images');
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const reference of references) {
    const data = await readInputImageBytes(source, reference);
    await writeFile(join(target, reference.fileName), data, { mode: 0o600, flag: 'wx' });
  }
}

function corruptInputImageReference(cause?: unknown): MarAgentError {
  return new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session input image is corrupt.', {
    ...(cause === undefined ? {} : { cause })
  });
}

/** A pending marker is removable only after the committed JSONL references are checked. */
export async function recoverPendingInputImages(
  sessionDirectory: string,
  readHistory: () => Promise<SessionRecord[]>
): Promise<void> {
  const directory = join(sessionDirectory, 'input_images');
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const pending = names.filter((name) => /^\.[0-9a-f-]{36}\.bin\.pending$/iu.test(name));
  const temporary = names.filter((name) =>
    /^\.[0-9a-f-]{36}\.bin\.[0-9a-f-]{36}\.tmp$/iu.test(name)
  );
  if (pending.length === 0 && temporary.length === 0) return;
  const referenced =
    pending.length === 0
      ? new Set<string>()
      : new Set(
          inputImageReferencesFromRecords(await readHistory()).map((image) => image.fileName)
        );
  for (const name of pending) {
    const fileName = name.slice(1, -'.pending'.length);
    if (!referenced.has(fileName)) await rm(join(directory, fileName), { force: true });
    await rm(join(directory, name), { force: true });
  }
  for (const name of temporary) await rm(join(directory, name), { force: true });
}

export async function writeInputImages(
  directory: string,
  images: readonly SessionInputImage[]
): Promise<SessionInputImageMetadata[]> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  const pending: string[] = [];
  let temporary: string | undefined;
  let totalBytes = 0;
  try {
    const metadata: SessionInputImageMetadata[] = [];
    for (const image of images) {
      if (!INPUT_IMAGE_MIME_TYPES.has(image.mimeType))
        throw new MarAgentError(
          'MAR_AGENT_INPUT_CAPABILITY_UNSUPPORTED',
          'Image input MIME type is unsupported.'
        );
      const data = Buffer.from(image.dataBase64 ?? '', 'base64');
      if (
        (image.url !== undefined && !isModelImageUrl(image.url)) ||
        (image.urlExpiresAt !== undefined &&
          (!Number.isSafeInteger(image.urlExpiresAt) || image.urlExpiresAt <= 0)) ||
        (image.urlExpiresAt !== undefined && image.url === undefined)
      )
        throw new MarAgentError('MAR_AGENT_SESSION_INPUT_INVALID', 'Image model URL is invalid.');
      totalBytes += data.byteLength;
      if (
        data.byteLength === 0 ||
        data.byteLength > MAX_INPUT_IMAGE_BYTES ||
        totalBytes > MAX_INPUT_IMAGES_BYTES
      )
        throw new MarAgentError(
          'MAR_AGENT_HOST_LIMIT_EXCEEDED',
          'Image input exceeds the supported size limit.'
        );
      const fileName = `${randomUUID()}.bin`;
      temporary = join(directory, `.${fileName}.${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const marker = join(directory, `.${fileName}.pending`);
      await writeFile(marker, '', { mode: 0o600, flag: 'wx', flush: true });
      pending.push(marker);
      await rename(temporary, join(directory, fileName));
      temporary = undefined;
      written.push(fileName);
      metadata.push({
        name: image.name,
        mimeType: image.mimeType,
        byteSize: data.byteLength,
        fileName,
        sha256: createHash('sha256').update(data).digest('hex'),
        ...(image.url === undefined ? {} : { url: image.url }),
        ...(image.urlExpiresAt === undefined ? {} : { urlExpiresAt: image.urlExpiresAt })
      });
    }
    return metadata;
  } catch (error) {
    if (temporary !== undefined) await rm(temporary, { force: true }).catch(() => undefined);
    await Promise.all(pending.map((marker) => rm(marker, { force: true })));
    await Promise.all(
      written.map((fileName) =>
        rm(join(directory, fileName), { force: true }).catch(() => undefined)
      )
    );
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
