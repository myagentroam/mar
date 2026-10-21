import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { MarAgentError } from '../../error.js';
import type { SessionListInput, SessionSource } from '../types.js';
import type { SessionIndex, SessionMeta } from './types.js';

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
    if (
      value?.version !== 1 ||
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
          (session.resume?.userTurns !== undefined &&
            (!Number.isSafeInteger(session.resume.userTurns) || session.resume.userTurns < 0))
      )
    )
      throw new Error('invalid index shape');
    return value;
  } catch (cause) {
    throw new MarAgentError('MAR_AGENT_SESSION_CORRUPT', 'Session index is corrupt.', { cause });
  }
}

export async function persistSessionIndex(path: string, index: SessionIndex): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(index), { mode: 0o600, flag: 'wx', flush: true });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function normalizeSessionSource(value: SessionSource | undefined): SessionSource {
  if (value === undefined || value.type === 'user') return { type: 'user' };
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
    throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Session source is invalid.');
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
  readonly source: SessionSource['type'];
  readonly parentSessionId?: string;
  readonly rootSessionId?: string;
}

export function sessionListFilter(input: SessionListInput): SessionListFilter {
  const source =
    input.source ??
    (input.parentSessionId !== undefined || input.rootSessionId !== undefined
      ? 'subagent'
      : 'user');
  if (
    (source !== 'user' && source !== 'subagent') ||
    (input.parentSessionId !== undefined &&
      (source !== 'subagent' || input.parentSessionId.length === 0)) ||
    (input.rootSessionId !== undefined &&
      (source !== 'subagent' || input.rootSessionId.length === 0))
  )
    throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Session list filter is invalid.');
  return {
    source,
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    ...(input.rootSessionId === undefined ? {} : { rootSessionId: input.rootSessionId })
  };
}

export function sessionMatchesFilter(meta: SessionMeta, filter: SessionListFilter): boolean {
  const source = normalizeSessionSource(meta.source);
  return (
    source.type === filter.source &&
    (filter.parentSessionId === undefined ||
      (source.type === 'subagent' && source.parentSessionId === filter.parentSessionId)) &&
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
    throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Session list cursor is invalid.');
  }
}

export function sessionTreeIds(sessions: readonly SessionMeta[], sessionId: string): string[] {
  if (!sessions.some((session) => session.id === sessionId)) return [];
  const ids = [sessionId];
  for (let index = 0; index < ids.length; index++) {
    const parentId = ids[index]!;
    for (const session of sessions) {
      const source = normalizeSessionSource(session.source);
      if (
        source.type === 'subagent' &&
        source.parentSessionId === parentId &&
        !ids.includes(session.id)
      )
        ids.push(session.id);
    }
  }
  return ids;
}
