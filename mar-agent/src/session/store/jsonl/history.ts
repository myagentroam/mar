import { randomUUID } from 'node:crypto';
import { open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentError } from '../../../error.js';
import { parseInlineMediaState } from '../../inline-media.js';
import { MAX_SEGMENT_BYTES } from './records.js';
import { forEachTransactionFile } from './transaction-files.js';
import type { SessionMeta, SessionRecord } from '../types.js';

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
  readonly reused?: ReadonlySet<string>;
}

interface SegmentGroup {
  lines: string[];
  bytes: number;
  firstSequence: number;
  lastSequence: number;
}

export async function stageSessionSegments(
  sessionDirectory: string,
  records: readonly SessionRecord[],
  operation: 'rollback' | 'fork' = 'rollback'
): Promise<StagedSessionSegments> {
  let group: SegmentGroup | undefined;
  if (records.length === 0)
    throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session history is corrupt.');
  const transactionId = randomUUID();
  const files: Array<{ path: string; temporaryPath: string }> = [];
  const segments: NonNullable<SessionMeta['segments']> = [];
  const flush = async () => {
    if (group === undefined) return;
    const number = segments.length + 1;
    const staged = await writeStagedSegment(
      sessionDirectory,
      group,
      number,
      transactionId,
      operation
    );
    files.push(staged.file);
    segments.push(staged.segment);
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
    await forEachTransactionFile(files, (file) =>
      rm(file.temporaryPath, { force: true }).catch(() => undefined)
    );
    throw error;
  }
}

/** Reuse intact files in ordered v2 histories; journal only replacements and removals. */
export async function stageRollbackSegments(
  directory: string,
  prefix: readonly SessionRecord[],
  originals: NonNullable<SessionMeta['segments']>
): Promise<StagedSessionSegments & { readonly reused: ReadonlySet<string> }> {
  const files: Array<{ path: string; temporaryPath: string }> = [];
  const segments: NonNullable<SessionMeta['segments']> = [];
  const reused = new Set<string>();
  const transactionId = randomUUID();
  let offset = 0;
  try {
    for (const original of originals) {
      const start = offset;
      while (offset < prefix.length && prefix[offset]!.sequence <= original.lastSequence) offset++;
      const source = prefix.slice(start, offset);
      if (source.length === 0) break;
      const retained = source.filter((record) => record.type !== 'responses.continuation');
      if (retained.length === source.length && source.at(-1)!.sequence === original.lastSequence) {
        reused.add(`events-${String(original.number).padStart(6, '0')}.jsonl`);
        segments.push({ ...original });
      } else if (retained.length > 0) {
        const lines = retained.map((record) => `${JSON.stringify(record)}\n`);
        const staged = await writeStagedSegment(
          directory,
          {
            lines,
            bytes: lines.reduce((total, line) => total + Buffer.byteLength(line), 0),
            firstSequence: retained[0]!.sequence,
            lastSequence: retained.at(-1)!.sequence
          },
          original.number,
          transactionId,
          'rollback'
        );
        files.push(staged.file);
        segments.push(staged.segment);
      }
    }
    return { files, segments, reused };
  } catch (error) {
    await forEachTransactionFile(files, (file) =>
      rm(file.temporaryPath, { force: true }).catch(() => undefined)
    );
    throw error;
  }
}

async function writeStagedSegment(
  directory: string,
  group: SegmentGroup,
  number: number,
  transactionId: string,
  operation: 'rollback' | 'fork'
) {
  const path = join(directory, `events-${String(number).padStart(6, '0')}.jsonl`);
  const temporaryPath = `${path}.${transactionId}.${operation}-tmp`;
  const handle = await open(temporaryPath, 'wx', 0o600);
  let failed = false;
  let failure: unknown;
  try {
    await handle.writeFile(group.lines.join(''));
    await handle.sync();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw failure;
  }
  return {
    file: { path, temporaryPath },
    segment: {
      number,
      firstSequence: group.firstSequence,
      lastSequence: group.lastSequence,
      bytes: group.bytes
    }
  };
}

export async function stageUnreferencedImages(
  sessionDirectory: string,
  directoryName: 'generated_images' | 'tool_results' | 'resources',
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
    await forEachTransactionFile(
      names.filter((name) => !retained.has(name)),
      async (name) => {
        const from = join(directory, name);
        const trash = join(directory, `.${name}.${transactionId}.rollback-trash`);
        await rename(from, trash);
        moved.push({ from: trash, to: from, trash });
      }
    );
    return moved;
  } catch (error) {
    await restoreRenamedFiles(moved);
    throw error;
  }
}

export async function restoreRenamedFiles(
  files: readonly { readonly from: string; readonly to: string }[]
): Promise<void> {
  await forEachTransactionFile(files, (file) => rename(file.from, file.to).catch(() => undefined));
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
  const remapWindow = (value: unknown) => {
    const state = parseInlineMediaState(value);
    if (!state) return value;
    for (const cursor of [state.consideredThrough, state.evictedThrough]) {
      if (!cursor?.sourceId.startsWith('input:')) continue;
      const target = identities.get(cursor.sourceId.slice(6));
      if (!target)
        throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Fork media reference is missing.');
      cursor.sourceId = `input:${target.recordId}`;
    }
    return state;
  };
  if (type === 'resource.window') return remapWindow(payload);
  if (payload.sessionId === sourceSessionId) payload.sessionId = targetSessionId;
  const application = (input: Record<string, unknown>) => {
    if (typeof input.inputRef !== 'string') {
      const recordId = isObject(input.metadata) ? input.metadata.recordId : undefined;
      const identity = typeof recordId === 'string' ? identities.get(recordId) : undefined;
      return identity && isObject(input.metadata)
        ? { ...input, metadata: { ...input.metadata, recordId: identity.recordId } }
        : input;
    }
    const identity = identities.get(input.inputRef);
    if (!identity)
      throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Fork input reference is missing.');
    return {
      ...input,
      inputRef: identity.recordId,
      ...(isObject(input.metadata)
        ? { metadata: { ...input.metadata, recordId: identity.recordId } }
        : {})
    };
  };
  if (type === 'model.context' || type === 'input.applied') return application(payload);
  if (type === 'compact.completed') {
    if (payload.inlineMediaState) payload.inlineMediaState = remapWindow(payload.inlineMediaState);
    if (Array.isArray(payload.retainedModelContext))
      payload.retainedModelContext = payload.retainedModelContext.map((item) =>
        isObject(item) ? application(item) : item
      );
    if (Array.isArray(payload.pendingInputs))
      payload.pendingInputs = payload.pendingInputs.map((record: SessionRecord) => {
        const identity = identities.get(record.recordId);
        if (!identity)
          throw new AgentError(
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
