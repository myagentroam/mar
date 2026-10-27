import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { AgentError } from '../../../error.js';

const JOURNAL = 'storage-transaction.json';
const SEGMENT = /^events-\d{6}\.jsonl$/u;
const TRANSACTION_ID = /^[0-9a-f-]{36}$/iu;
const STAGING_FILE = /^events-\d{6}\.jsonl\.[0-9a-f-]{36}\.rollback-tmp$/iu;
const JOURNAL_TEMP = /^storage-transaction\.json\.[0-9a-f-]{36}\.tmp$/iu;

/** One authoritative journal for an entire Session tree; markers only locate it. */
export interface SessionTreeDeleteTransaction {
  readonly version: 1;
  readonly kind: 'delete';
  readonly id: string;
  readonly phase?: 'preparing' | 'ready' | 'restored';
  readonly members: readonly {
    readonly id: string;
    readonly existed: boolean;
    readonly identity: {
      readonly createdAt: string;
      readonly workspace: string;
      readonly source?: unknown;
      readonly storage?: unknown;
      readonly storageTransactionId?: string;
      readonly nextSequence: number;
    };
  }[];
}

export function treeDeleteMarker(root: string, sessionId: string): string {
  return join(root, '.delete-pending', sessionId);
}

function treeDeleteTrash(root: string, sessionId: string, id: string): string {
  return join(root, sessionId, `.delete-${id}.trash`);
}

export async function readTreeDeleteTransaction(
  root: string,
  sessionId: string
): Promise<SessionTreeDeleteTransaction | undefined> {
  let marker: string;
  try {
    marker = await readFile(treeDeleteMarker(root, sessionId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const anchor = marker.startsWith('{') ? sessionId : marker;
    if (!TRANSACTION_ID.test(anchor)) throw new Error('invalid deletion marker');
    const content =
      anchor === sessionId ? marker : await readFile(treeDeleteMarker(root, anchor), 'utf8');
    const journal = JSON.parse(content) as SessionTreeDeleteTransaction;
    if (typeof journal.version === 'number' && journal.version > 1)
      throw new AgentError(
        'MAR_AGENT_SESSION_VERSION_UNSUPPORTED',
        'Session encoding is unsupported.'
      );
    if (
      journal.version !== 1 ||
      journal.kind !== 'delete' ||
      !TRANSACTION_ID.test(journal.id) ||
      (journal.phase !== undefined &&
        journal.phase !== 'preparing' &&
        journal.phase !== 'ready' &&
        journal.phase !== 'restored') ||
      !Array.isArray(journal.members) ||
      journal.members.length === 0 ||
      journal.members[0]?.id !== anchor ||
      !journal.members.every(
        (member) =>
          TRANSACTION_ID.test(member.id) &&
          typeof member.existed === 'boolean' &&
          typeof member.identity?.createdAt === 'string' &&
          typeof member.identity.workspace === 'string' &&
          Number.isSafeInteger(member.identity.nextSequence) &&
          member.identity.nextSequence > 0
      ) ||
      new Set(journal.members.map((member) => member.id)).size !== journal.members.length ||
      !journal.members.some((member) => member.id === sessionId)
    )
      throw new Error('invalid deletion journal');
    return journal;
  } catch (cause) {
    if (cause instanceof AgentError && cause.code === 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED')
      throw cause;
    throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session deletion recovery is required.', {
      cause
    });
  }
}

export async function beginTreeDeleteTransaction(
  root: string,
  transaction: SessionTreeDeleteTransaction,
  sync: (path: string) => Promise<void>
): Promise<void> {
  const markers = join(root, '.delete-pending');
  await mkdir(markers, { recursive: true, mode: 0o700 });
  await sync(root);
  const anchor = transaction.members[0]!.id;
  const journal = treeDeleteMarker(root, anchor);
  await publishTreeDeleteMarker(journal, JSON.stringify({ ...transaction, phase: 'preparing' }));
  await sync(markers);
  for (const member of transaction.members.slice(1))
    await publishTreeDeleteMarker(treeDeleteMarker(root, member.id), anchor);
  await sync(markers);
  await publishTreeDeletePhase(root, transaction, 'ready', sync);
}

async function publishTreeDeletePhase(
  root: string,
  transaction: SessionTreeDeleteTransaction,
  phase: 'ready' | 'restored',
  sync: (path: string) => Promise<void>
): Promise<void> {
  const markers = join(root, '.delete-pending');
  const journal = treeDeleteMarker(root, transaction.members[0]!.id);
  const temporary = `${journal}.${randomUUID()}.tmp`;
  let failure: unknown;
  try {
    await writeFile(temporary, JSON.stringify({ ...transaction, phase }), {
      flag: 'wx',
      mode: 0o600,
      flush: true
    });
    await rename(temporary, journal);
    await sync(markers);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (failure !== undefined) await rm(temporary, { force: true }).catch(() => undefined);
    else await rm(temporary, { force: true });
  }
}

/** Callers hold the member read gate, so an existing marker must never be replaced. */
async function publishTreeDeleteMarker(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let failure: unknown;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600, flush: true });
    try {
      await lstat(path);
      throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session deletion recovery is required.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(temporary, path);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (failure !== undefined) await rm(temporary, { force: true }).catch(() => undefined);
    else await rm(temporary, { force: true });
  }
}

/** Called only with all tree writers and read gates held. */
export async function stageTreeDelete(
  root: string,
  transaction: SessionTreeDeleteTransaction,
  sync: (path: string) => Promise<void>
): Promise<void> {
  for (const member of transaction.members.toReversed()) {
    if (!member.existed) continue;
    const directory = join(root, member.id);
    const trash = treeDeleteTrash(root, member.id, transaction.id);
    await mkdir(trash, { mode: 0o700 });
    await sync(directory);
    for (const name of await readdir(directory)) {
      if (name === 'lock' || name === 'lock.reclaim' || join(directory, name) === trash) continue;
      await rename(join(directory, name), join(trash, name));
      await sync(trash);
      await sync(directory);
    }
    await sync(trash);
    await sync(directory);
  }
}

/** Index membership selects restore versus retirement; never infer commit from file presence. */
export async function finishTreeDelete(
  root: string,
  transaction: SessionTreeDeleteTransaction,
  committed: boolean,
  sync: (path: string) => Promise<void>
): Promise<void> {
  for (const member of transaction.members) {
    if (!member.existed) continue;
    const directory = join(root, member.id);
    const trash = treeDeleteTrash(root, member.id, transaction.id);
    if (committed) await rm(directory, { recursive: true, force: true });
    else {
      let names: string[];
      try {
        names = await readdir(trash);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // A missing stage is safe only while the original Session root still exists.
        if (!(await lstat(directory)).isDirectory())
          throw new AgentError(
            'MAR_AGENT_SESSION_CORRUPT',
            'Session deletion recovery is incomplete.'
          );
        continue;
      }
      for (const name of names) {
        await rename(join(trash, name), join(directory, name));
        await sync(directory);
        await sync(trash);
      }
      await rm(trash, { recursive: true, force: true });
      await sync(directory);
    }
  }
  await sync(root);
  if (!committed) await publishTreeDeletePhase(root, transaction, 'restored', sync);
  await finishTreeDeletePreparation(root, transaction, sync);
}

/** Remove only markers owned by the preparing or fully restored transaction. */
export async function finishTreeDeletePreparation(
  root: string,
  transaction: SessionTreeDeleteTransaction,
  sync: (path: string) => Promise<void>
): Promise<void> {
  const anchor = transaction.members[0]!.id;
  for (const member of transaction.members.slice(1)) {
    const marker = treeDeleteMarker(root, member.id);
    let owner: string;
    try {
      owner = await readFile(marker, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (owner === anchor) await rm(marker, { force: true });
  }
  await sync(join(root, '.delete-pending'));
  const journal = treeDeleteMarker(root, anchor);
  try {
    const current = JSON.parse(await readFile(journal, 'utf8')) as { id?: unknown };
    if (current.id === transaction.id) await rm(journal, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await sync(join(root, '.delete-pending'));
}

export function isUnjournaledTransactionFile(name: string): boolean {
  return STAGING_FILE.test(name) || JOURNAL_TEMP.test(name);
}

export interface SessionStorageTransaction {
  readonly version: 1;
  readonly id: string;
  readonly kind: 'rollback' | 'clear';
  readonly originalSegments: readonly string[];
  readonly stagedSegments: readonly { readonly path: string; readonly temporary: string }[];
  readonly sidecarBackup: string;
  readonly retiredPaths?: readonly string[];
  readonly targetGeneration?: string;
}

/** Deterministic names make a partially staged retirement recoverable from the same journal. */
export function retiredSessionTrashPath(root: string, path: string, transactionId: string): string {
  const source = join(root, path);
  return join(dirname(source), `.${basename(source)}.${transactionId}.retired-trash`);
}

/** The index's transaction ID, not the journal's existence, decides the commit side. */
export async function beginSessionStorageTransaction(
  directory: string,
  transaction: SessionStorageTransaction
): Promise<void> {
  const temporary = join(directory, `${JOURNAL}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(transaction), {
      mode: 0o600,
      flag: 'wx',
      flush: true
    });
    await rename(temporary, join(directory, JOURNAL));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Must run under the corresponding Session writer lock. Safe to repeat after interruption. */
export async function recoverSessionStorageTransaction(
  directory: string,
  committedTransactionId?: string,
  sessionDirectory = directory
): Promise<void> {
  const journal = join(directory, JOURNAL);
  let raw: string;
  try {
    raw = await readFile(journal, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await removeUnjournaledTransactionFiles(directory);
      return;
    }
    throw error;
  }
  let transaction: SessionStorageTransaction;
  try {
    transaction = JSON.parse(raw) as SessionStorageTransaction;
    if (typeof transaction?.version === 'number' && transaction.version > 1)
      throw new AgentError(
        'MAR_AGENT_SESSION_VERSION_UNSUPPORTED',
        'Session encoding is unsupported.'
      );
    if (
      transaction?.version !== 1 ||
      !TRANSACTION_ID.test(transaction.id) ||
      (transaction.kind !== 'rollback' && transaction.kind !== 'clear') ||
      !Array.isArray(transaction.originalSegments) ||
      !transaction.originalSegments.every(
        (name) => typeof name === 'string' && SEGMENT.test(name)
      ) ||
      !Array.isArray(transaction.stagedSegments) ||
      !transaction.stagedSegments.every(
        (entry) =>
          typeof entry?.path === 'string' &&
          SEGMENT.test(entry.path) &&
          typeof entry.temporary === 'string' &&
          /^events-\d{6}\.jsonl\.[0-9a-f-]{36}\.rollback-tmp$/iu.test(entry.temporary) &&
          entry.temporary.startsWith(`${entry.path}.`)
      ) ||
      typeof transaction.sidecarBackup !== 'string' ||
      !new RegExp(
        `^context-world-state\\.json\\.\\d+\\.${transaction.id}\\.${transaction.kind}-backup$`,
        'u'
      ).test(transaction.sidecarBackup) ||
      (transaction.retiredPaths !== undefined &&
        (!Array.isArray(transaction.retiredPaths) ||
          !transaction.retiredPaths.every(
            (path) =>
              typeof path === 'string' &&
              (/^events-\d{6}\.jsonl$/u.test(path) ||
                ['resources', 'tool_results', 'context-world-state.json'].includes(path) ||
                /^v2\/[0-9a-f-]{36}$/u.test(path)) &&
              join(sessionDirectory, path) !== directory
          ))) ||
      (transaction.targetGeneration !== undefined &&
        (typeof transaction.targetGeneration !== 'string' ||
          !TRANSACTION_ID.test(transaction.targetGeneration) ||
          directory !== sessionDirectory))
    )
      throw new Error('invalid session transaction');
  } catch (cause) {
    if (cause instanceof AgentError && cause.code === 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED')
      throw cause;
    throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session storage transaction is corrupt.', {
      cause
    });
  }
  const committed = transaction.id === committedTransactionId;
  const stagedDirectory =
    transaction.targetGeneration === undefined
      ? directory
      : join(sessionDirectory, 'v2', transaction.targetGeneration);
  const originals = new Set(transaction.originalSegments);
  for (const name of transaction.originalSegments) {
    const canonical = join(directory, name);
    const backup = `${canonical}.${transaction.id}.${transaction.kind}-backup`;
    if (!(await exists(backup))) continue;
    if (committed) await rm(backup, { force: true });
    else {
      await rm(canonical, { force: true });
      await rename(backup, canonical);
    }
  }
  if (!committed)
    for (const entry of transaction.stagedSegments)
      if (stagedDirectory !== directory || !originals.has(entry.path))
        await rm(join(stagedDirectory, entry.path), { force: true });
  for (const entry of transaction.stagedSegments)
    await rm(join(stagedDirectory, entry.temporary), { force: true });
  if (!committed && transaction.targetGeneration !== undefined)
    await rm(stagedDirectory, { recursive: true, force: true });

  const sidecar = join(directory, 'context-world-state.json');
  const backup = join(directory, transaction.sidecarBackup);
  if (await exists(backup)) {
    if (committed) await rm(backup, { force: true });
    else {
      await rm(sidecar, { force: true });
      await rename(backup, sidecar);
    }
  }
  for (const folder of ['generated_images', 'tool_results', 'resources']) {
    const path = join(folder === 'generated_images' ? sessionDirectory : directory, folder);
    let names: string[];
    try {
      names = await readdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const suffix = `.${transaction.id}.rollback-trash`;
    for (const name of names) {
      if (!name.startsWith('.') || !name.endsWith(suffix)) continue;
      const trash = join(path, name);
      if (committed) await rm(trash, { force: true });
      else await rename(trash, join(path, name.slice(1, -suffix.length)));
    }
  }
  for (const path of transaction.retiredPaths ?? []) {
    const source = join(sessionDirectory, path);
    const trash = retiredSessionTrashPath(sessionDirectory, path, transaction.id);
    if (!(await exists(trash))) continue;
    if (committed) await rm(trash, { recursive: true, force: true });
    else await rename(trash, source);
  }
  await rm(journal);
  await removeUnjournaledTransactionFiles(directory);
}

async function removeUnjournaledTransactionFiles(directory: string): Promise<void> {
  for (const name of await readdir(directory))
    if (isUnjournaledTransactionFile(name)) await rm(join(directory, name), { force: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
