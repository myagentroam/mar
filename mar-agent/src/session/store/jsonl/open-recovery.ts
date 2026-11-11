import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentError } from '../../../error.js';
import { acquireFileLock } from '../../../storage/file-lock.js';
import { cleanupUnreferencedToolResources } from '../../tool-result-resources.js';
import { persistFormatSelection, readSessionIndex } from './directory-index.js';
import { readRecords, repairSegmentTail } from './records.js';
import { recoverResources } from './resources.js';
import { withSessionReadDrain } from './read-pins.js';
import type { SessionIndex, SessionMeta, SessionRecord } from '../types.js';

export const CONTEXTUAL_WORLD_STATE_FILE = 'context-world-state.json';

/** Recover the physical tail and pending resources while the caller holds the Session lease. */
export async function recoverJsonlTail(
  directory: string,
  latestPath: string,
  readHistory: () => Promise<SessionRecord[]>,
  encoding = 1
): Promise<{ records: SessionRecord[]; segment: number }> {
  await repairSegmentTail(latestPath, encoding);
  const records = await readRecords(latestPath, encoding);
  let history: Promise<SessionRecord[]> | undefined;
  const sharedHistory = () => (history ??= readHistory());
  await recoverResources(join(directory, 'resources'), sharedHistory);
  await cleanupUnreferencedToolResources(directory, sharedHistory);
  const match = /events-(\d{6})\.jsonl$/.exec(latestPath);
  return { records, segment: Number(match?.[1] ?? 1) };
}

/** Open the index without recovering or changing any existing Session. */
export async function openJsonlIndex(root: string): Promise<SessionIndex> {
  const directory = join(root, 'sessions');
  const path = join(directory, 'index.json');
  await mkdir(directory, { recursive: true });
  const release = await acquireFileLock(join(directory, 'index.lock'));
  let index: SessionIndex;
  try {
    const disk = await readSessionIndex(path);
    if (disk) index = disk;
    else {
      const entries = await readdir(directory, { withFileTypes: true });
      if (
        entries.some(
          (entry) =>
            entry.isDirectory() &&
            entry.name !== 'index.lock' &&
            !entry.name.startsWith('index.lock.pending-')
        )
      )
        throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session index is missing.');
      index = { version: 2, revision: 0, sessions: [] };
      await persistFormatSelection(path, index);
    }
  } finally {
    await release();
  }
  return index;
}

/** Reclaim only marked unpublished creations, never published Session history. */
export async function reclaimUnpublishedSessions(root: string): Promise<void> {
  const directory = join(root, 'sessions');
  const path = join(directory, 'index.json');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/iu.test(entry.name)) continue;
    const candidate = join(directory, entry.name);
    const marker = join(candidate, 'publication-pending');
    try {
      if (!(await lstat(marker)).isFile()) continue;
    } catch {
      continue;
    }
    let release: () => Promise<void>;
    try {
      release = await acquireFileLock(join(candidate, 'lock'), 'Session already has a writer.', 0);
    } catch {
      continue;
    }
    try {
      const index = await readSessionIndex(path);
      if (!index) throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session index is missing.');
      try {
        if (!index.sessions.some((session) => session.id === entry.name))
          await withSessionReadDrain(candidate, () =>
            rm(candidate, { recursive: true, force: true })
          );
      } catch {
        // A damaged unrelated candidate must not prevent another Session from being written.
      }
    } finally {
      await release().catch(() => undefined);
    }
  }
}

export async function sessionDirectoryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function recoverContextualWorldStateTransactions(
  root: string,
  meta: SessionMeta
): Promise<void> {
  const sessionDirectory = join(root, 'sessions', meta.id);
  const directory =
    meta.storage?.encoding === 2
      ? join(sessionDirectory, 'v2', meta.storage.generation)
      : sessionDirectory;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const pattern = /^context-world-state\.json\.(\d+)\.[0-9a-f-]+\.(?:rollback|clear)-backup$/u;
  const backups = names.filter((name) => pattern.test(name));
  if (backups.length === 0) return;
  const eventNames = names.filter((name) => /^events-\d{6}\.jsonl$/u.test(name)).sort();
  const latestEventName = eventNames.at(-1);
  if (latestEventName === undefined)
    throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session history is corrupt.');
  const latestRecords = await readRecords(
    join(directory, latestEventName),
    meta.storage?.encoding ?? 1
  );
  const actualNextSequence = (latestRecords.at(-1)?.sequence ?? 0) + 1;
  const canonical = join(directory, CONTEXTUAL_WORLD_STATE_FILE);
  for (const name of backups) {
    const match = pattern.exec(name)!;
    const backup = join(directory, name);
    const targetNextSequence = Number(match[1]);
    if (actualNextSequence === targetNextSequence || (await sessionDirectoryExists(canonical)))
      await rm(backup, { force: true });
    else await rename(backup, canonical);
  }
}
