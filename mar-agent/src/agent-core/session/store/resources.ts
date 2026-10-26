import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { MarAgentError } from '../../error.js';
import { isModelImageUrl, type ModelImage } from '../../model/image.js';
import { readInputImageBytes } from './images.js';
import type { SessionRecord } from './types.js';

export interface SessionResource {
  readonly resourceInputVersion?: 1;
  readonly resourceId: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly url?: string;
  readonly urlExpiresAt?: number;
}

const idPattern = /^[a-f0-9]{64}$/u;
const mimeTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function resourceIdentity(mimeType: string, sha256: string): string {
  return createHash('sha256').update(mimeType).update('\0').update(sha256).digest('hex');
}

export async function resourceMetadata(
  directory: string,
  resourceId: string
): Promise<SessionResource | undefined> {
  if (!idPattern.test(resourceId)) return undefined;
  try {
    const value = JSON.parse(
      await readFile(join(directory, `${resourceId}.json`), 'utf8')
    ) as unknown;
    const resource = value as Partial<SessionResource>;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof resource.resourceId !== 'string' ||
      typeof resource.mimeType !== 'string' ||
      typeof resource.byteSize !== 'number' ||
      typeof resource.sha256 !== 'string' ||
      (resource.url !== undefined &&
        (typeof resource.url !== 'string' ||
          !isModelImageUrl(resource.url) ||
          !Number.isSafeInteger(resource.urlExpiresAt) ||
          resource.urlExpiresAt! <= 0)) ||
      (resource.url === undefined && resource.urlExpiresAt !== undefined)
    )
      throw new Error('Invalid Session image resource metadata.');
    return value as SessionResource;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new MarAgentError(
      'MAR_AGENT_IMAGE_UNAVAILABLE',
      'Session image resource is unavailable.',
      {
        cause
      }
    );
  }
}

export async function persistResource(
  directory: string,
  image: ModelImage
): Promise<SessionResource> {
  if (image.resourceId !== undefined && image.dataBase64 === undefined) {
    const existing = await resourceMetadata(directory, image.resourceId);
    if (existing !== undefined && existing.mimeType === image.mimeType) return existing;
    throw new MarAgentError('MAR_AGENT_IMAGE_UNAVAILABLE', 'Session image resource is missing.');
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
  const resourceId = resourceIdentity(image.mimeType, sha256);
  if (image.resourceId !== undefined && image.resourceId !== resourceId)
    throw new MarAgentError(
      'MAR_AGENT_SESSION_INPUT_INVALID',
      'Image resource identity does not match its bytes.'
    );
  let existing: SessionResource | undefined;
  try {
    existing = await resourceMetadata(directory, resourceId);
  } catch (error) {
    if (!(error instanceof MarAgentError) || error.code !== 'MAR_AGENT_IMAGE_UNAVAILABLE')
      throw error;
  }
  const resource: SessionResource = {
    ...existing,
    resourceInputVersion: 1,
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

export async function setResourceUrl(
  directory: string,
  resourceId: string,
  published: { url: string; urlExpiresAt: number }
): Promise<SessionResource> {
  const resource = await resourceMetadata(directory, resourceId);
  if (!resource)
    throw new MarAgentError('MAR_AGENT_IMAGE_UNAVAILABLE', 'Session image resource is missing.');
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

export async function readResource(directory: string, resourceId: string) {
  const resource = await resourceMetadata(directory, resourceId);
  if (!resource) return undefined;
  const bytes = await readInputImageBytes(directory, {
    ...resource,
    name: 'image',
    fileName: `${resourceId}.bin`
  });
  return { mimeType: resource.mimeType, dataBase64: bytes.toString('base64') };
}

/** Resource identities are SDK-owned metadata, never interpreted as file paths. */
export function resourceFiles(records: readonly SessionRecord[]): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if (
      item.resourceInputVersion === 1 &&
      typeof item.resourceId === 'string' &&
      idPattern.test(item.resourceId)
    )
      ids.add(item.resourceId);
    for (const key of ['images', 'input', 'pendingInputs', 'payload', 'retainedModelContext'])
      if (item[key] !== undefined) visit(item[key]);
  };
  for (const record of records) visit(record.payload);
  return new Set([...ids].flatMap((id) => [`${id}.bin`, `${id}.json`]));
}

export async function copyResources(
  source: string,
  target: string,
  records: readonly SessionRecord[]
) {
  const files = resourceFiles(records);
  if (!files.size) return;
  await mkdir(join(target, 'resources'), { recursive: true, mode: 0o700 });
  for (const file of files) {
    if (!file.endsWith('.bin')) continue;
    const resourceId = file.slice(0, -4);
    const resource = await resourceMetadata(join(source, 'resources'), resourceId);
    if (resource === undefined)
      throw new MarAgentError('MAR_AGENT_IMAGE_UNAVAILABLE', 'Session image resource is missing.');
    const bytes = await readInputImageBytes(join(source, 'resources'), {
      ...resource,
      name: 'image',
      fileName: file
    });
    await writeFile(join(target, 'resources', file), bytes, {
      mode: 0o600,
      flag: 'wx',
      flush: true
    });
    await writeFile(join(target, 'resources', `${resourceId}.json`), JSON.stringify(resource), {
      mode: 0o600,
      flag: 'wx',
      flush: true
    });
  }
}

export async function completeResources(directory: string, record: SessionRecord) {
  for (const file of resourceFiles([record]))
    if (file.endsWith('.bin'))
      await rm(join(directory, `.${file.slice(0, -4)}.pending`), { force: true });
}

export async function recoverResources(
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
    const retained = resourceFiles(await readHistory());
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
