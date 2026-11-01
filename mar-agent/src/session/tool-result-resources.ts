import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AgentError } from '../error.js';
import {
  parseToolResultExtensions,
  type AvailableToolResultResource,
  type ToolResultExtension
} from '../tools/result-extensions.js';
import type { SessionRecord } from './store/types.js';

const REF = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const MAX_BYTES = 16 * 1024 * 1024;
export interface ToolResultResourceInput {
  resourceRef: string;
  cursor?: string;
  maxBytes?: number;
}
export interface ToolResultResourcePage {
  type: 'file_changes';
  version: 1;
  format: 'unified-diff';
  resourceRef: string;
  byteSize: number;
  sha256: string;
  content: string;
  nextCursor?: string;
}

export async function writeToolResultResource(
  directory: string,
  text: string
): Promise<AvailableToolResultResource> {
  const bytes = Buffer.from(text);
  if (bytes.length > MAX_BYTES)
    throw resourceError('LIMIT', 'Tool result resource exceeds its limit.');
  const resourceRef = randomUUID();
  const folder = join(directory, 'tool_results');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temporary = join(folder, `.${resourceRef}.tmp`);
  await writeFile(join(folder, `.${resourceRef}.pending`), '', {
    flag: 'wx',
    mode: 0o600,
    flush: true
  });
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true });
    await rename(temporary, join(folder, `${resourceRef}.diff`));
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    status: 'available',
    resourceRef,
    format: 'unified-diff',
    byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

export function recordToolResources(
  record: Pick<SessionRecord, 'type' | 'payload'>
): AvailableToolResultResource[] {
  if (!['tool.completed', 'tool.failed'].includes(record.type)) return [];
  const payload = record.payload as {
    resultExtensions?: unknown;
    data?: { calls?: Array<{ resultExtensions?: unknown }> };
  };
  const sources = [
    payload?.resultExtensions,
    ...(Array.isArray(payload?.data?.calls)
      ? payload.data.calls.map((call) => call.resultExtensions)
      : [])
  ];
  return sources.flatMap((source) =>
    (parseToolResultExtensions(source) ?? []).flatMap((extension) =>
      extension.entries.flatMap((entry) => (entry.diff.status === 'available' ? [entry.diff] : []))
    )
  );
}

/** A locator is only a hint: reads must verify its exact committed record identity. */
export async function bindToolResultResources(
  directory: string,
  record: SessionRecord,
  readRecord?: (sequence: number) => Promise<SessionRecord | undefined>,
  degrade = false
): Promise<void> {
  for (const resource of recordToolResources(record)) {
    try {
      await bindToolResultResource(directory, record, resource, readRecord);
    } catch (error) {
      if (!degrade) throw error;
      // Shared descriptors are downgraded before persistence and live publication, never the tool outcome.
      const payload = record.payload as {
        resultExtensions?: ToolResultExtension[];
        data?: { calls?: { resultExtensions?: ToolResultExtension[] }[] };
      };
      for (const extensions of [
        payload.resultExtensions,
        ...(payload.data?.calls ?? []).map((call) => call.resultExtensions)
      ]) {
        for (const extension of extensions ?? [])
          for (const entry of extension.entries) {
            if (
              entry.diff.status === 'available' &&
              entry.diff.resourceRef === resource.resourceRef
            )
              entry.diff = { status: 'unavailable', reason: 'storage-failed' };
          }
      }
    }
  }
}

async function bindToolResultResource(
  directory: string,
  record: SessionRecord,
  resource: AvailableToolResultResource,
  readRecord?: (sequence: number) => Promise<SessionRecord | undefined>
): Promise<void> {
  const path = join(directory, 'tool_results', `${resource.resourceRef}.json`);
  try {
    const locator = await readToolResourceLocator(path, resource.resourceRef);
    if (locator !== undefined) {
      const existing =
        locator.sequence === record.sequence && locator.recordId === record.recordId
          ? record
          : Number.isSafeInteger(locator.sequence)
            ? await readRecord?.(locator.sequence)
            : undefined;
      if (
        !existing ||
        existing.recordId !== locator.recordId ||
        !recordToolResources(existing).some(
          (entry) => entry.resourceRef === resource.resourceRef && entry.sha256 === resource.sha256
        )
      )
        throw resourceError('CORRUPT', 'Tool resource locator conflicts with committed history.');
      return;
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw normalizedResourceError(cause);
  }
  await writeFile(path, JSON.stringify({ sequence: record.sequence, recordId: record.recordId }), {
    flag: 'wx',
    mode: 0o600,
    flush: true
  });
}

export function toolResultResourceFiles(records: readonly SessionRecord[]): Set<string> {
  const files = new Set(
    records.flatMap((record) =>
      recordToolResources(record).flatMap((resource) => [
        `${resource.resourceRef}.diff`,
        `${resource.resourceRef}.json`
      ])
    )
  );
  if (files.size > 0) files.add('index.json');
  return files;
}

export interface ToolResourceLocator {
  sequence: number;
  recordId: string;
  bodySequences?: number[];
}

export async function prepareToolResultResources(
  source: string,
  records: readonly SessionRecord[]
): Promise<Map<string, { owner: string; bytes: Buffer }>> {
  type RetainedResource = { record: SessionRecord; resource: AvailableToolResultResource };
  const resources = new Map<string, RetainedResource>();
  for (const record of records) {
    for (const resource of recordToolResources(record)) {
      const previous = resources.get(resource.resourceRef);
      if (previous && previous.resource.sha256 !== resource.sha256)
        throw resourceError('CORRUPT', 'Tool resource locator conflicts with committed history.');
      if (!previous) resources.set(resource.resourceRef, { record, resource });
    }
  }
  const bodies = new Map<string, { owner: string; bytes: Buffer }>();
  if (resources.size === 0) return bodies;
  const bySequence = new Map(records.map((record) => [record.sequence, record]));
  const pending = resources.values();
  let failure: { error: unknown } | undefined;
  const read = async () => {
    while (!failure) {
      const next = pending.next();
      if (next.done) return;
      const { record, resource } = next.value;
      try {
        const bytes = await readResourceBytes(source, resource, async (sequence) =>
          bySequence.get(sequence)
        );
        bodies.set(resource.resourceRef, { owner: record.recordId, bytes });
      } catch (error) {
        if (!(error instanceof AgentError && error.code === 'MAR_AGENT_TOOL_RESOURCE_NOT_FOUND'))
          failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, resources.size) }, read));
  if (failure) throw failure.error;
  return bodies;
}

export async function writeToolResultResourceIndex(
  target: string,
  locators: ReadonlyMap<string, ToolResourceLocator>
): Promise<void> {
  if (locators.size === 0) return;
  const directory = join(target, 'tool_results');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, 'index.json'),
    JSON.stringify({ version: 1, locators: Object.fromEntries(locators) }),
    {
      flag: 'wx',
      mode: 0o600,
      flush: true
    }
  );
}

async function readToolResourceLocator(
  path: string,
  resourceRef: string
): Promise<ToolResourceLocator | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    text = await readFile(join(dirname(path), 'index.json'), 'utf8');
  }
  const value = JSON.parse(text);
  const locator = value?.version === 1 ? value.locators?.[resourceRef] : value;
  if (value?.version === 1 && locator === undefined) return undefined;
  if (
    !Number.isSafeInteger(locator?.sequence) ||
    locator.sequence < 1 ||
    typeof locator.recordId !== 'string'
  )
    throw resourceError('CORRUPT', 'Invalid tool resource locator.');
  if (
    locator.bodySequences !== undefined &&
    (!Array.isArray(locator.bodySequences) ||
      locator.bodySequences.length === 0 ||
      !locator.bodySequences.every(
        (sequence: unknown) =>
          Number.isSafeInteger(sequence) &&
          (sequence as number) > 0 &&
          (sequence as number) < locator.sequence
      ))
  )
    throw resourceError('CORRUPT', 'Invalid tool resource body locator.');
  return locator;
}

export async function completeToolResultResources(
  directory: string,
  record: SessionRecord
): Promise<void> {
  await Promise.all(
    recordToolResources(record).map((resource) =>
      rm(join(directory, 'tool_results', `.${resource.resourceRef}.pending`), {
        force: true
      }).catch(() => undefined)
    )
  );
}

export async function cleanupUnreferencedToolResources(
  directory: string,
  readRecords: () => Promise<readonly SessionRecord[]>
): Promise<void> {
  const folder = join(directory, 'tool_results');
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const pending = names.filter(
    (name) => name.startsWith('.') && name.endsWith('.pending') && REF.test(name.slice(1, -8))
  );
  if (!pending.length) return;
  const retained = toolResultResourceFiles(await readRecords());
  for (const marker of pending) {
    const ref = marker.slice(1, -8);
    for (const name of [`${ref}.diff`, `${ref}.json`, `.${ref}.tmp`]) {
      if (retained.has(name)) continue;
      const path = join(folder, name);
      try {
        if ((await lstat(path)).isFile()) await rm(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await rm(join(folder, marker), { force: true });
  }
}

/** Caller must hold a stable history and resource generation for the entire read. */
export async function readToolResultResource(
  directory: string,
  sessionId: string,
  input: ToolResultResourceInput,
  readRecord: (sequence: number) => Promise<SessionRecord | undefined>
): Promise<ToolResultResourcePage> {
  if (
    !REF.test(input.resourceRef) ||
    (input.maxBytes !== undefined &&
      (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 4 || input.maxBytes > 256 * 1024))
  )
    throw resourceError('INPUT_INVALID', 'Invalid tool resource request.');
  let locator: ToolResourceLocator | undefined;
  try {
    const file = join(directory, 'tool_results', `${input.resourceRef}.json`);
    locator = await readToolResourceLocator(file, input.resourceRef);
  } catch (error) {
    throw normalizedResourceError(error);
  }
  if (locator === undefined) throw resourceError('NOT_FOUND', 'Tool resource is unavailable.');
  const record = await readRecord(locator.sequence);
  const resource =
    record?.recordId === locator.recordId
      ? recordToolResources(record).find((entry) => entry.resourceRef === input.resourceRef)
      : undefined;
  if (!resource)
    throw resourceError('NOT_FOUND', 'Tool resource is not part of this session history.');
  const bytes = await readResourceBytes(directory, resource, readRecord, locator);
  let offset = 0;
  if (input.cursor !== undefined) {
    try {
      if (input.cursor.length > 1024) throw new Error('cursor');
      const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as {
        sessionId: string;
        ref: string;
        sha256: string;
        offset: number;
      };
      if (
        cursor.sessionId !== sessionId ||
        cursor.ref !== resource.resourceRef ||
        cursor.sha256 !== resource.sha256 ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 ||
        cursor.offset >= bytes.length
      )
        throw new Error('cursor');
      offset = cursor.offset;
    } catch {
      throw resourceError('INPUT_INVALID', 'Invalid tool resource cursor.');
    }
  }
  if (offset > 0 && (bytes[offset]! & 0xc0) === 0x80)
    throw resourceError('INPUT_INVALID', 'Invalid tool resource cursor boundary.');
  let end = Math.min(bytes.length, offset + (input.maxBytes ?? 256 * 1024));
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return {
    type: 'file_changes',
    version: 1,
    format: resource.format,
    resourceRef: resource.resourceRef,
    byteSize: resource.byteSize,
    sha256: resource.sha256,
    content: bytes.subarray(offset, end).toString('utf8'),
    ...(end < bytes.length
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({
              sessionId,
              ref: resource.resourceRef,
              sha256: resource.sha256,
              offset: end
            })
          ).toString('base64url')
        }
      : {})
  };
}

async function readResourceBytes(
  directory: string,
  resource: AvailableToolResultResource,
  readRecord?: (sequence: number) => Promise<SessionRecord | undefined>,
  knownLocator?: ToolResourceLocator
): Promise<Buffer> {
  try {
    return await readFile(join(directory, 'tool_results', `${resource.resourceRef}.diff`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw normalizedResourceError(error);
  }
  try {
    const locator =
      knownLocator ??
      (await readToolResourceLocator(
        join(directory, 'tool_results', `${resource.resourceRef}.json`),
        resource.resourceRef
      ));
    if (!locator?.bodySequences || !readRecord)
      throw resourceError('NOT_FOUND', 'Tool resource is unavailable.');
    const chunks: Buffer[] = [];
    for (const sequence of locator.bodySequences) {
      const record = await readRecord(sequence);
      const payload = record?.payload as
        { resourceRef?: unknown; dataBase64?: unknown } | undefined;
      if (
        record?.type !== 'tool.resource' ||
        payload?.resourceRef !== resource.resourceRef ||
        typeof payload.dataBase64 !== 'string'
      )
        throw resourceError('CORRUPT', 'Invalid tool resource body.');
      chunks.push(Buffer.from(payload.dataBase64, 'base64'));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    throw normalizedResourceError(error);
  }
}
function resourceError(suffix: string, message: string): AgentError {
  return new AgentError(`MAR_AGENT_TOOL_RESOURCE_${suffix}`, message);
}
function normalizedResourceError(error: unknown): Error {
  if (error instanceof AgentError) return error;
  return resourceError(
    (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'NOT_FOUND' : 'CORRUPT',
    'Tool result resource is unavailable.'
  );
}
