import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AgentError } from '../../../error.js';
import type { SessionListInput, SessionSource } from '../../types.js';
import type { SessionIndex, SessionMeta } from '../types.js';

/** Root format fence; history and directory revision are unchanged. */
export function upgradeSessionIndex(index: SessionIndex): SessionIndex {
  if (index.version === 2) return index;
  return {
    ...index,
    version: 2,
    sessions: index.sessions.map((session) => ({ ...session, storage: { encoding: 1 } }))
  };
}

/** Merge only derived fields, and only onto the history they were computed from. */
export function mergeSessionDerivedCache(current: SessionMeta, cached: SessionMeta): SessionMeta {
  if (
    current.nextSequence !== cached.nextSequence ||
    current.storageTransactionId !== cached.storageTransactionId
  )
    return current;
  const preview =
    cached.resume?.firstUserMessageIndexed === true &&
    current.resume?.firstUserMessagePreview === undefined &&
    !(
      current.resume?.firstUserMessageIndexed === true &&
      cached.resume.firstUserMessagePreview === undefined
    );
  const count = current.resume?.userTurns === undefined && cached.resume?.userTurns !== undefined;
  if (!preview && !count) return current;
  return {
    ...current,
    resume: {
      ...(current.resume ?? { version: 1, todoRevision: 0 }),
      ...(count ? { userTurns: cached.resume!.userTurns } : {}),
      ...(preview ? { firstUserMessageIndexed: true } : {}),
      ...(!preview || cached.resume?.firstUserMessagePreview === undefined
        ? {}
        : { firstUserMessagePreview: cached.resume.firstUserMessagePreview })
    }
  };
}

/** Restore the same entry object while the index serialization queue is held. */
export function restoreSessionIndexMeta(meta: SessionMeta, original: SessionMeta): void {
  if (original.storage === undefined) delete meta.storage;
  else meta.storage = structuredClone(original.storage);
  meta.id = original.id;
  meta.title = original.title;
  meta.workspace = original.workspace;
  meta.createdAt = original.createdAt;
  meta.lastActivityAt = original.lastActivityAt;
  if (original.source === undefined) delete meta.source;
  else meta.source = structuredClone(original.source);
  meta.nextSequence = original.nextSequence;
  if (original.storageTransactionId === undefined) delete meta.storageTransactionId;
  else meta.storageTransactionId = original.storageTransactionId;
  if (original.automaticTitlePending === undefined) delete meta.automaticTitlePending;
  else meta.automaticTitlePending = original.automaticTitlePending;
  if (original.resume === undefined) delete meta.resume;
  else meta.resume = structuredClone(original.resume);
  if (original.segments === undefined) delete meta.segments;
  else meta.segments = structuredClone(original.segments);
}

/** Prepare one committed index from a locked disk snapshot and the caller's dirty snapshot. */
export function prepareSessionIndexCommit(
  disk: SessionIndex,
  local: SessionIndex,
  dirty: ReadonlyMap<string, number>,
  derivedOnly: ReadonlySet<string>,
  deletedIds: string | readonly string[] | undefined,
  createdIds: readonly string[]
): SessionIndex {
  const sessions = new Map(disk.sessions.map((session) => [session.id, session]));
  const created = new Set(createdIds);
  for (const session of local.sessions) {
    const current = sessions.get(session.id);
    // Disk membership is authoritative: a stale in-memory snapshot cannot revive a deletion.
    if (created.has(session.id) || (current && dirty.has(session.id)))
      sessions.set(
        session.id,
        current && derivedOnly.has(session.id)
          ? mergeSessionDerivedCache(current, session)
          : {
              ...structuredClone(session),
              ...(current?.storage === undefined ? {} : { storage: current.storage })
            }
      );
  }
  for (const deletedId of typeof deletedIds === 'string' ? [deletedIds] : (deletedIds ?? []))
    sessions.delete(deletedId);
  return {
    version: disk.version,
    revision:
      createdIds.length > 0 ||
      deletedIds !== undefined ||
      [...dirty.keys()].some((id) => !derivedOnly.has(id))
        ? Math.max(disk.revision, local.revision) + 1
        : disk.revision,
    sessions: [...sessions.values()]
  };
}

export async function readSessionIndex(path: string): Promise<SessionIndex | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw cause;
  }
  try {
    const value = JSON.parse(raw) as SessionIndex;
    if (Number.isSafeInteger(value?.version) && value.version !== 1 && value.version !== 2)
      throw new AgentError(
        'MAR_AGENT_SESSION_VERSION_UNSUPPORTED',
        'Session encoding is unsupported.'
      );
    if (value?.version === 2 && Array.isArray(value.sessions))
      for (const session of value.sessions) {
        const encoding = session?.storage?.encoding;
        if (Number.isSafeInteger(encoding) && encoding !== 1 && encoding !== 2)
          throw new AgentError(
            'MAR_AGENT_SESSION_VERSION_UNSUPPORTED',
            'Session encoding is unsupported.'
          );
      }
    if (
      (value?.version !== 1 && value?.version !== 2) ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      !Array.isArray(value.sessions) ||
      value.sessions.some(
        (session) =>
          typeof session?.id !== 'string' ||
          !/^[0-9a-f-]{36}$/iu.test(session.id) ||
          typeof session.title !== 'string' ||
          typeof session.workspace !== 'string' ||
          typeof session.createdAt !== 'string' ||
          typeof session.lastActivityAt !== 'string' ||
          !Number.isSafeInteger(session.nextSequence) ||
          session.nextSequence < 1 ||
          (value.version === 2 &&
            session.storage?.encoding !== 1 &&
            (session.storage?.encoding !== 2 ||
              !/^[0-9a-f-]{36}$/iu.test(session.storage.generation))) ||
          (session.resume?.userTurns !== undefined &&
            (!Number.isSafeInteger(session.resume.userTurns) || session.resume.userTurns < 0))
      )
    )
      throw new Error('invalid index shape');
    return value;
  } catch (cause) {
    if (cause instanceof AgentError && cause.code === 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED')
      throw cause;
    throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session index is corrupt.', { cause });
  }
}

export async function persistSessionIndex(path: string, index: SessionIndex): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let failure: unknown;
  try {
    await writeFile(temporary, JSON.stringify(index), { mode: 0o600, flag: 'wx', flush: true });
    await rename(temporary, path);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (failure !== undefined) await rm(temporary, { force: true }).catch(() => undefined);
    else await rm(temporary, { force: true });
  }
}

/** The format-selection commit needs both the file and its directory entry durable. */
export async function persistFormatSelection(path: string, index: SessionIndex): Promise<void> {
  await persistSessionIndex(path, index);
  if (process.platform === 'win32') return;
  const directory = await open(dirname(path), 'r');
  let failure: unknown;
  try {
    await directory.sync();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (failure !== undefined) await directory.close().catch(() => undefined);
    else await directory.close();
  }
}

export function normalizeSessionSource(value: SessionSource | undefined): SessionSource {
  if (value === undefined) return { type: 'user' };
  if (value.type === 'user') {
    if (
      value.parentSessionId !== undefined &&
      (typeof value.parentSessionId !== 'string' || !value.parentSessionId.trim())
    )
      throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Session source is invalid.');
    return {
      type: 'user',
      ...(value.parentSessionId === undefined ? {} : { parentSessionId: value.parentSessionId })
    };
  }
  if (
    value.type !== 'subagent' ||
    typeof value.parentSessionId !== 'string' ||
    !value.parentSessionId.trim() ||
    typeof value.rootSessionId !== 'string' ||
    !value.rootSessionId.trim() ||
    (!value.parentExecutionId && !value.parentOperationId) ||
    [
      value.parentExecutionId,
      value.parentOperationId,
      value.ownerInstanceId,
      value.extensionId
    ].some(
      (identity) => identity !== undefined && (typeof identity !== 'string' || !identity.trim())
    ) ||
    ((value.ownerInstanceId !== undefined || value.extensionId !== undefined) &&
      value.parentOperationId === undefined) ||
    typeof value.description !== 'string' ||
    !value.description.trim() ||
    (value.role !== 'general-purpose' && value.role !== 'explore')
  )
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Session source is invalid.');
  return {
    type: 'subagent',
    parentSessionId: value.parentSessionId,
    rootSessionId: value.rootSessionId,
    ...(value.parentExecutionId === undefined
      ? {}
      : { parentExecutionId: value.parentExecutionId }),
    ...(value.parentOperationId === undefined
      ? {}
      : { parentOperationId: value.parentOperationId }),
    ...(value.ownerInstanceId === undefined ? {} : { ownerInstanceId: value.ownerInstanceId }),
    ...(value.extensionId === undefined ? {} : { extensionId: value.extensionId }),
    role: value.role,
    description: value.description.trim()
  };
}

interface SessionListFilter {
  readonly source?: SessionSource['type'];
  readonly parentSessionId?: string;
  readonly rootSessionId?: string;
}

export function sessionListFilter(input: SessionListInput): SessionListFilter {
  const source = input.source;
  if (
    (source !== undefined && source !== 'user' && source !== 'subagent') ||
    (input.parentSessionId !== undefined && input.parentSessionId.length === 0) ||
    (input.rootSessionId !== undefined && (source === 'user' || input.rootSessionId.length === 0))
  )
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Session list filter is invalid.');
  return {
    ...(source === undefined ? {} : { source }),
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    ...(input.rootSessionId === undefined ? {} : { rootSessionId: input.rootSessionId })
  };
}

export function sessionMatchesFilter(meta: SessionMeta, filter: SessionListFilter): boolean {
  const source = normalizeSessionSource(meta.source);
  return (
    (filter.source === undefined || source.type === filter.source) &&
    (filter.parentSessionId === undefined || source.parentSessionId === filter.parentSessionId) &&
    (filter.rootSessionId === undefined ||
      (source.type === 'subagent' && source.rootSessionId === filter.rootSessionId))
  );
}

export function encodeSessionListCursor(
  revision: number,
  offset: number,
  filter: SessionListFilter
): string {
  return Buffer.from(JSON.stringify({ version: 1, revision, offset, filter })).toString(
    'base64url'
  );
}

export function decodeSessionListCursor(
  cursor: string | undefined,
  revision: number,
  filter: SessionListFilter
): number {
  if (cursor === undefined) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      version?: unknown;
      revision?: unknown;
      offset?: unknown;
      filter?: unknown;
    };
    if (
      value.version !== 1 ||
      value.revision !== revision ||
      !Number.isSafeInteger(value.offset) ||
      (value.offset as number) < 0 ||
      !isDeepStrictEqual(value.filter, filter)
    )
      throw new Error('invalid cursor');
    return value.offset as number;
  } catch {
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Session list cursor is invalid.');
  }
}

export function sessionTreeIds(sessions: readonly SessionMeta[], sessionId: string): string[] {
  if (!sessions.some((session) => session.id === sessionId)) return [];
  const ids = [sessionId];
  for (let index = 0; index < ids.length; index++) {
    const parentId = ids[index]!;
    for (const session of sessions) {
      const source = normalizeSessionSource(session.source);
      if (source.parentSessionId === parentId && !ids.includes(session.id)) ids.push(session.id);
    }
  }
  return ids;
}
