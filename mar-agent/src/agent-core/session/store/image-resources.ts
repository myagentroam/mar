import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { MarAgentError } from '../../error.js';
import { isModelImageUrl, type ModelImage } from '../../model/image.js';
import { readInputImageBytes } from './images.js';
import type { SessionRecord } from './types.js';

export interface SessionImageResource {
  readonly resourceId: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly url?: string;
  readonly urlExpiresAt?: number;
}

const idPattern = /^[a-f0-9]{64}$/u;
const mimeTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export async function imageResource(
  directory: string,
  resourceId: string
): Promise<SessionImageResource | undefined> {
  if (!idPattern.test(resourceId)) return undefined;
  let text: string;
  try {
    text = await readFile(join(directory, `${resourceId}.json`), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let value: SessionImageResource | undefined;
  try {
    value = JSON.parse(text) as SessionImageResource;
  } catch {
    // Invalid JSON is reported below without exposing metadata contents.
  }
  if (
    !value ||
    value.resourceId !== resourceId ||
    !mimeTypes.has(value.mimeType) ||
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize <= 0 ||
    value.byteSize > 20 * 1024 * 1024 ||
    !idPattern.test(value.sha256) ||
    (value.url !== undefined &&
      (!isModelImageUrl(value.url) ||
        !Number.isSafeInteger(value.urlExpiresAt) ||
        value.urlExpiresAt! <= 0)) ||
    (value.url === undefined && value.urlExpiresAt !== undefined)
  )
    throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session image resource is corrupt.');
  return value;
}

export async function persistImageResource(
  directory: string,
  image: ModelImage
): Promise<SessionImageResource> {
  if (image.resourceId !== undefined && image.dataBase64 === undefined) {
    const existing = await imageResource(directory, image.resourceId);
    if (existing !== undefined && existing.mimeType === image.mimeType) return existing;
    throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session image resource is missing.');
  }
  const data = Buffer.from(image.dataBase64 ?? '', 'base64');
  if (data.toString('base64') !== image.dataBase64)
    throw new MarAgentError(
      'MAR_AGENT_SESSION_INPUT_INVALID',
      'Image resource data is not canonical base64.'
    );
  if (!mimeTypes.has(image.mimeType) || data.length === 0 || data.length > 20 * 1024 * 1024)
    throw new MarAgentError(
      'MAR_AGENT_HOST_LIMIT_EXCEEDED',
      'Image resource exceeds supported limits.'
    );
  const sha256 = createHash('sha256').update(data).digest('hex');
  const resourceId = createHash('sha256')
    .update(image.mimeType)
    .update('\0')
    .update(sha256)
    .digest('hex');
  if (image.resourceId !== undefined && image.resourceId !== resourceId)
    throw new MarAgentError(
      'MAR_AGENT_SESSION_INPUT_INVALID',
      'Image resource identity does not match its bytes.'
    );
  const existing = await imageResource(directory, resourceId);
  if (existing !== undefined) return existing;
  const resource: SessionImageResource = {
    resourceId,
    mimeType: image.mimeType,
    byteSize: data.length,
    sha256
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, `.${resourceId}.pending`), '', { mode: 0o600, flush: true });
  await atomicWrite(join(directory, `${resourceId}.bin`), data);
  await atomicWrite(join(directory, `${resourceId}.json`), JSON.stringify(resource));
  return resource;
}

export async function setImageResourceUrl(
  directory: string,
  resourceId: string,
  published: { url: string; urlExpiresAt: number }
): Promise<SessionImageResource> {
  const resource = await imageResource(directory, resourceId);
  if (!resource)
    throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session image resource is missing.');
  if (resource.url !== undefined) return resource;
  if (
    !isModelImageUrl(published.url) ||
    !Number.isSafeInteger(published.urlExpiresAt) ||
    published.urlExpiresAt <= 0
  )
    throw new MarAgentError('MAR_AGENT_IMAGE_PUBLICATION_FAILED', 'Image URL publication failed.');
  const result = { ...resource, url: published.url, urlExpiresAt: published.urlExpiresAt };
  await atomicWrite(join(directory, `${resourceId}.json`), JSON.stringify(result));
  return result;
}

export async function readImageResource(directory: string, resourceId: string) {
  const resource = await imageResource(directory, resourceId);
  if (!resource) return undefined;
  const bytes = await readInputImageBytes(directory, {
    ...resource,
    name: 'image',
    fileName: `${resourceId}.bin`
  });
  return { mimeType: resource.mimeType, dataBase64: bytes.toString('base64') };
}

/** Resource identities are SDK-owned metadata, never interpreted as file paths. */
export function imageResourceFiles(records: readonly SessionRecord[]): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if (typeof item.resourceId === 'string' && idPattern.test(item.resourceId))
      ids.add(item.resourceId);
    for (const key of ['images', 'input', 'pendingInputs', 'payload', 'retainedModelContext'])
      if (item[key] !== undefined) visit(item[key]);
  };
  for (const record of records) visit(record.payload);
  return new Set([...ids].flatMap((id) => [`${id}.bin`, `${id}.json`]));
}

export async function copyImageResources(
  source: string,
  target: string,
  records: readonly SessionRecord[]
) {
  const files = imageResourceFiles(records);
  if (!files.size) return;
  await mkdir(join(target, 'images'), { recursive: true, mode: 0o700 });
  for (const file of files) {
    if (!file.endsWith('.bin')) continue;
    const resourceId = file.slice(0, -4);
    const resource = await imageResource(join(source, 'images'), resourceId);
    if (resource === undefined)
      throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session image resource is missing.');
    const bytes = await readInputImageBytes(join(source, 'images'), {
      ...resource,
      name: 'image',
      fileName: file
    });
    await writeFile(join(target, 'images', file), bytes, { mode: 0o600, flag: 'wx', flush: true });
    await writeFile(join(target, 'images', `${resourceId}.json`), JSON.stringify(resource), {
      mode: 0o600,
      flag: 'wx',
      flush: true
    });
  }
}

export async function completeImageResources(directory: string, record: SessionRecord) {
  for (const file of imageResourceFiles([record]))
    if (file.endsWith('.bin'))
      await rm(join(directory, `.${file.slice(0, -4)}.pending`), { force: true });
}

export async function recoverImageResources(
  directory: string,
  readHistory: () => Promise<SessionRecord[]>
) {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const pending = names.filter((name) => /^\.[a-f0-9]{64}\.pending$/u.test(name));
  if (pending.length) {
    const retained = imageResourceFiles(await readHistory());
    for (const name of pending) {
      const id = name.slice(1, -8);
      if (!retained.has(`${id}.bin`))
        for (const suffix of ['bin', 'json'])
          await rm(join(directory, `${id}.${suffix}`), { force: true });
      await rm(join(directory, name), { force: true });
    }
  }
  for (const name of names)
    if (/^\.[a-f0-9]{64}\.(?:bin|json)\.[a-f0-9-]{36}\.tmp$/u.test(name))
      await rm(join(directory, name), { force: true });
}

async function atomicWrite(path: string, data: string | Buffer) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: 'wx', flush: true });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
