import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MarAgentError } from '../error.js';

const JOURNAL = 'storage-transaction.json';
const SEGMENT = /^events-\d{6}\.jsonl$/u;
const TRANSACTION_ID = /^[0-9a-f-]{36}$/iu;
const STAGING_FILE = /^events-\d{6}\.jsonl\.[0-9a-f-]{36}\.rollback-tmp$/iu;
const JOURNAL_TEMP = /^storage-transaction\.json\.[0-9a-f-]{36}\.tmp$/iu;

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
  committedTransactionId?: string
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
      ).test(transaction.sidecarBackup)
    )
      throw new Error('invalid session transaction');
  } catch (cause) {
    throw new MarAgentError(
      'MAR_AGENT_SESSION_CORRUPT',
      'Session storage transaction is corrupt.',
      {
        cause
      }
    );
  }
  const committed = transaction.id === committedTransactionId;
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
      if (!originals.has(entry.path)) await rm(join(directory, entry.path), { force: true });
  for (const entry of transaction.stagedSegments)
    await rm(join(directory, entry.temporary), { force: true });

  const sidecar = join(directory, 'context-world-state.json');
  const backup = join(directory, transaction.sidecarBackup);
  if (await exists(backup)) {
    if (committed) await rm(backup, { force: true });
    else {
      await rm(sidecar, { force: true });
      await rename(backup, sidecar);
    }
  }
  for (const folder of ['input_images', 'generated_images', 'tool_results']) {
    const path = join(directory, folder);
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
