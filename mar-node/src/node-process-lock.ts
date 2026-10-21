import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertLocalSqlitePath, isUnsupportedSqlitePath } from './storage.js';

export const NODE_OWNER_CONFLICT_EXIT_CODE = 76;

export class NodeProcessOwnerConflictError extends Error {
  readonly code = 'NODE_DATA_DIRECTORY_IN_USE';

  constructor() {
    super(
      'Another Node process is using this data directory. Stop that instance before starting another.'
    );
  }
}

/** The independent transaction owns the directory, not the business database. */
export async function acquireNodeProcessLock(dataDirectory: string): Promise<() => void> {
  if (isUnsupportedSqlitePath(dataDirectory))
    throw new Error('SQLITE_NETWORK_FILESYSTEM_UNSUPPORTED');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const path = join(await realpath(dataDirectory), 'node-owner.sqlite');
  await assertLocalSqlitePath(path);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { timeout: 0 });
    database.exec('PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;');
  } catch (error) {
    try {
      database?.close();
    } catch {
      /* Preserve the acquisition error. */
    }
    if (error instanceof Error && 'errcode' in error && error.errcode === 5)
      throw new NodeProcessOwnerConflictError();
    throw error;
  }
  const owner = database;
  let released = false;
  return () => {
    if (released) return;
    owner.close();
    released = true;
  };
}
