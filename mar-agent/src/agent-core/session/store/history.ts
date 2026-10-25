import { randomUUID } from 'node:crypto';
import { open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MarAgentError } from '../../error.js';
import { MAX_SEGMENT_BYTES } from './records.js';
import type { SessionMeta, SessionRecord } from './types.js';

export async function renameIfExists(from: string, to: string): Promise<boolean> {
  try {
    await rename(from, to);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

interface StagedSessionSegments {
  readonly files: readonly { readonly path: string; readonly temporaryPath: string }[];
  readonly segments: NonNullable<SessionMeta['segments']>;
}

export async function stageSessionSegments(
  sessionDirectory: string,
  records: readonly SessionRecord[],
  operation: 'rollback' | 'fork' = 'rollback'
): Promise<StagedSessionSegments> {
  let group:
    | {
        lines: string[];
        bytes: number;
        firstSequence: number;
        lastSequence: number;
      }
    | undefined;
  if (records.length === 0)
    throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session history is corrupt.');
  const transactionId = randomUUID();
  const files: Array<{ path: string; temporaryPath: string }> = [];
  const segments: NonNullable<SessionMeta['segments']> = [];
  const flush = async () => {
    if (group === undefined) return;
    const number = segments.length + 1;
    const path = join(sessionDirectory, `events-${String(number).padStart(6, '0')}.jsonl`);
    const temporaryPath = `${path}.${transactionId}.${operation}-tmp`;
    const handle = await open(temporaryPath, 'wx', 0o600);
    files.push({ path, temporaryPath });
    try {
      await handle.writeFile(group.lines.join(''));
      await handle.sync();
    } finally {
      await handle.close();
    }
    segments.push({
      number,
      firstSequence: group.firstSequence,
      lastSequence: group.lastSequence,
      bytes: group.bytes
    });
    group = undefined;
  };
  try {
    for (const record of records) {
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line);
      if (group !== undefined && group.bytes > 0 && group.bytes + bytes > MAX_SEGMENT_BYTES)
        await flush();
      if (group === undefined) {
        group = {
          lines: [],
          bytes: 0,
          firstSequence: record.sequence,
          lastSequence: record.sequence
        };
      }
      group.lines.push(line);
      group.bytes += bytes;
      group.lastSequence = record.sequence;
    }
    await flush();
    return { files, segments };
  } catch (error) {
    await Promise.all(files.map((item) => rm(item.temporaryPath, { force: true }))).catch(
      () => undefined
    );
    throw error;
  }
}

export async function stageUnreferencedImages(
  sessionDirectory: string,
  directoryName: 'input_images' | 'generated_images' | 'tool_results' | 'images',
  retained: ReadonlySet<string>,
  transactionId: string
): Promise<Array<{ from: string; to: string; trash: string }>> {
  const directory = join(sessionDirectory, directoryName);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const moved: Array<{ from: string; to: string; trash: string }> = [];
  try {
    for (const name of names) {
      if (retained.has(name)) continue;
      const from = join(directory, name);
      const trash = join(directory, `.${name}.${transactionId}.rollback-trash`);
      await rename(from, trash);
      moved.push({ from: trash, to: from, trash });
    }
    return moved;
  } catch (error) {
    await restoreRenamedFiles(moved);
    throw error;
  }
}

export async function restoreRenamedFiles(
  files: readonly { readonly from: string; readonly to: string }[]
): Promise<void> {
  for (const file of files.toReversed()) await rename(file.from, file.to).catch(() => undefined);
}

export function retainedSessionTitle(records: readonly SessionRecord[], fallback: string): string {
  let title = fallback;
  for (const record of records) {
    if (
      (record.type === 'session.created' || record.type === 'session.title.updated') &&
      isObject(record.payload) &&
      typeof record.payload.title === 'string' &&
      record.payload.title.trim().length > 0
    )
      title = record.payload.title;
  }
  return title;
}

export function forkedPayload(
  type: string,
  value: unknown,
  sourceSessionId: string,
  targetSessionId: string,
  title: string,
  identities: ReadonlyMap<string, { recordId: string; sequence: number }>
): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const payload = { ...(value as Record<string, unknown>) };
  if (payload.sessionId === sourceSessionId) payload.sessionId = targetSessionId;
  const application = (input: Record<string, unknown>) => {
    if (typeof input.inputRef !== 'string') return input;
    const identity = identities.get(input.inputRef);
    if (!identity)
      throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Fork input reference is missing.');
    return {
      ...input,
      inputRef: identity.recordId,
      ...(isObject(input.metadata)
        ? { metadata: { ...input.metadata, recordId: identity.recordId } }
        : {})
    };
  };
  if (type === 'model.context') return application(payload);
  if (type === 'compact.completed') {
    if (Array.isArray(payload.retainedModelContext))
      payload.retainedModelContext = payload.retainedModelContext.map((item) =>
        isObject(item) ? application(item) : item
      );
    if (Array.isArray(payload.pendingInputs))
      payload.pendingInputs = payload.pendingInputs.map((record: SessionRecord) => {
        const identity = identities.get(record.recordId);
        if (!identity)
          throw new MarAgentError(
            'MAR_AGENT_SESSION_CORRUPT',
            'Fork pending input reference is missing.'
          );
        return { ...record, ...identity, sessionId: targetSessionId };
      });
  }
  if (type === 'session.title.updated') {
    payload.title = title;
    payload.automatic = false;
  }
  return payload;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
