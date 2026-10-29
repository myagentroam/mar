import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AgentError } from '../../../error.js';
import { acquireFileLock } from '../../../storage/file-lock.js';
import type { SessionIndex, SessionMeta } from '../types.js';
import {
  normalizeSessionSource,
  persistFormatSelection,
  prepareSessionIndexCommit,
  readSessionIndex
} from './directory-index.js';
import { treeDeleteMarker } from './transaction-recovery.js';
export class ParentPublicationRejected extends AgentError {}
/** Runs the short disk index transaction; the caller owns its cache. */
export async function commitSessionIndex(
  root: string,
  snapshot: () => {
    index: SessionIndex;
    dirty: ReadonlyMap<string, number>;
    derivedOnly: ReadonlySet<string>;
  },
  committed: (
    index: SessionIndex,
    dirty: ReadonlyMap<string, number>,
    created: ReadonlySet<string>
  ) => void,
  deletedIds?: string | readonly string[],
  createdIds: readonly string[] = [],
  onPersisted?: () => void,
  storageSelection?: { readonly before: SessionMeta; readonly generation: string },
  deleteExpected?: readonly SessionMeta[]
): Promise<void> {
  const release = await acquireFileLock(join(root, 'sessions', 'index.lock'));
  const path = join(root, 'sessions', 'index.json');
  let failure: unknown;
  try {
    const disk = await readSessionIndex(path);
    if (!disk) throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session index is missing.');
    for (const id of createdIds) {
      const created = snapshot().index.sessions.find((entry) => entry.id === id);
      if (!created)
        throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session publication is missing.');
      const source = normalizeSessionSource(created.source);
      if (source.parentSessionId === undefined) continue;
      if (!disk.sessions.some((entry) => entry.id === source.parentSessionId))
        throw new ParentPublicationRejected(
          'MAR_AGENT_SESSION_NOT_FOUND',
          'Parent Session was not found.'
        );
      try {
        await lstat(treeDeleteMarker(join(root, 'sessions'), source.parentSessionId));
        throw new ParentPublicationRejected(
          'MAR_AGENT_SESSION_LOCKED',
          'Parent Session is under maintenance.'
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (deleteExpected) {
      for (const expected of deleteExpected) {
        const current = disk.sessions.find((entry) => entry.id === expected.id);
        if (
          !current ||
          current.createdAt !== expected.createdAt ||
          current.workspace !== expected.workspace ||
          !isDeepStrictEqual(current.source, expected.source) ||
          !isDeepStrictEqual(current.storage, expected.storage) ||
          current.storageTransactionId !== expected.storageTransactionId ||
          current.nextSequence !== expected.nextSequence
        )
          throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session changed during deletion.');
      }
    }
    const local = snapshot();
    const dirty = local.dirty;
    const derivedOnly = local.derivedOnly;
    const created = new Set(createdIds);
    const updated = prepareSessionIndexCommit(
      disk,
      local.index,
      dirty,
      derivedOnly,
      deletedIds,
      createdIds
    );
    if (storageSelection) {
      const before = storageSelection.before;
      const selected = disk.sessions.find((item) => item.id === before.id);
      const replacement = updated.sessions.find((item) => item.id === before.id);
      if (
        !selected ||
        !replacement ||
        !isDeepStrictEqual(selected.storage, before.storage) ||
        selected.nextSequence !== before.nextSequence ||
        selected.storageTransactionId !== before.storageTransactionId
      )
        throw new AgentError(
          'MAR_AGENT_SESSION_CORRUPT',
          'Session history changed during replacement.'
        );
      replacement.storage = { encoding: 2, generation: storageSelection.generation };
    }
    await persistFormatSelection(path, updated);
    onPersisted?.();
    committed(updated, dirty, created);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (failure !== undefined) await release().catch(() => undefined);
    else await release();
  }
}
