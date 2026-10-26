import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MarAgentError } from '../error.js';
import {
  parseToolResultExtensions,
  type AvailableToolResultResource,
  type ToolResultExtension
} from '../tools/result-extensions.js';
import type { SessionRecord } from './store/index.js';

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
    await writeFile(
      path,
      JSON.stringify({ sequence: record.sequence, recordId: record.recordId }),
      { flag: 'wx', mode: 0o600, flush: true }
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      const locator = JSON.parse(await readFile(path, 'utf8')) as {
        sequence: number;
        recordId: string;
      };
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
    } catch (cause) {
      throw normalizedResourceError(cause);
    }
  }
}

export function toolResultResourceFiles(records: readonly SessionRecord[]): Set<string> {
  return new Set(
    records.flatMap((record) =>
      recordToolResources(record).flatMap((resource) => [
        `${resource.resourceRef}.diff`,
        `${resource.resourceRef}.json`
      ])
    )
  );
}

export async function copyToolResultResources(
  source: string,
  target: string,
  records: readonly SessionRecord[]
): Promise<void> {
  const copied = new Set<string>();
  for (const record of records) {
    for (const resource of recordToolResources(record)) {
      if (copied.has(resource.resourceRef)) continue;
      copied.add(resource.resourceRef);
      try {
        const bytes = await readResourceBytes(source, resource);
        const directory = join(target, 'tool_results');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(join(directory, `${resource.resourceRef}.diff`), bytes, {
          flag: 'wx',
          mode: 0o600,
          flush: true
        });
      } catch (error) {
        if (error instanceof MarAgentError && error.code === 'MAR_AGENT_TOOL_RESOURCE_NOT_FOUND')
          continue;
        throw error;
      }
    }
    if (recordToolResources(record).length) {
      await mkdir(join(target, 'tool_results'), { recursive: true, mode: 0o700 });
      await bindToolResultResources(target, record, async (sequence) =>
        records.find((item) => item.sequence === sequence)
      );
    }
  }
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
  let locator: { sequence: number; recordId: string };
  try {
    const file = join(directory, 'tool_results', `${input.resourceRef}.json`);
    locator = JSON.parse(await readFile(file, 'utf8')) as typeof locator;
  } catch (error) {
    throw normalizedResourceError(error);
  }
  if (
    !Number.isSafeInteger(locator.sequence) ||
    locator.sequence < 1 ||
    typeof locator.recordId !== 'string'
  )
    throw resourceError('CORRUPT', 'Invalid tool resource locator.');
  const record = await readRecord(locator.sequence);
  const resource =
    record?.recordId === locator.recordId
      ? recordToolResources(record).find((entry) => entry.resourceRef === input.resourceRef)
      : undefined;
  if (!resource)
    throw resourceError('NOT_FOUND', 'Tool resource is not part of this session history.');
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
        cursor.offset >= resource.byteSize
      )
        throw new Error('cursor');
      offset = cursor.offset;
    } catch {
      throw resourceError('INPUT_INVALID', 'Invalid tool resource cursor.');
    }
  }
  const bytes = await readResourceBytes(directory, resource);
  if (offset > 0 && (bytes[offset]! & 0xc0) === 0x80)
    throw resourceError('INPUT_INVALID', 'Invalid tool resource cursor boundary.');
  let end = Math.min(bytes.length, offset + (input.maxBytes ?? 256 * 1024));
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  if ((await readRecord(locator.sequence))?.recordId !== locator.recordId)
    throw resourceError('NOT_FOUND', 'Tool resource history has changed.');
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
  resource: AvailableToolResultResource
): Promise<Buffer> {
  try {
    return await readFile(join(directory, 'tool_results', `${resource.resourceRef}.diff`));
  } catch (error) {
    throw normalizedResourceError(error);
  }
}
function resourceError(suffix: string, message: string): MarAgentError {
  return new MarAgentError(`MAR_AGENT_TOOL_RESOURCE_${suffix}`, message);
}
function normalizedResourceError(error: unknown): Error {
  if (error instanceof MarAgentError) return error;
  return resourceError(
    (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'NOT_FOUND' : 'CORRUPT',
    'Tool result resource is unavailable.'
  );
}
