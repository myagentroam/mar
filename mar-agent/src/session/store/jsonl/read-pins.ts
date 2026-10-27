import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { AgentError } from '../../../error.js';
import { acquireFileLock } from '../../../storage/file-lock.js';
import { treeDeleteMarker } from './transaction-recovery.js';

const heldPins = new AsyncLocalStorage<ReadonlySet<string>>();
const PIN = /^[0-9a-f-]{36}$/u;

async function pinPaths(root: string): Promise<{ gate: string; directory: string }> {
  const parent = join(dirname(root), '.read-pins');
  try {
    await mkdir(parent, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const id = basename(root);
  return { gate: join(parent, `${id}.lock`), directory: join(parent, id) };
}

/** Pin before selecting the index entry; nested reads reuse their caller's pin. */
export async function withSessionReadPin<T>(
  root: string,
  action: () => Promise<T>,
  allowMissing = false
): Promise<T> {
  const current = heldPins.getStore();
  if (current?.has(root)) return action();
  const paths = await pinPaths(root);
  const releaseGate = await acquireFileLock(paths.gate);
  let releasePin: (() => Promise<void>) | undefined;
  let failure: { error: unknown } | undefined;
  try {
    try {
      await lstat(treeDeleteMarker(dirname(root), basename(root)));
      throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session deletion recovery is required.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      if (!(await stat(root)).isDirectory())
        throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) {
        // Metadata may legitimately outlive a missing directory until stale-index cleanup.
      } else if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new AgentError('MAR_AGENT_SESSION_NOT_FOUND', 'Session was not found.');
      else throw error;
    }
    await mkdir(paths.directory, { mode: 0o700, recursive: true });
    releasePin = await acquireFileLock(join(paths.directory, randomUUID()));
  } catch (error) {
    failure = { error };
  }
  try {
    await releaseGate();
  } catch (error) {
    failure ??= { error };
  }
  if (failure) {
    await releasePin?.().catch(() => undefined);
    throw failure.error;
  }
  let result: T | undefined;
  try {
    result = await heldPins.run(new Set([...(current ?? []), root]), action);
  } catch (error) {
    failure = { error };
  }
  try {
    await releasePin!();
  } catch (error) {
    failure ??= { error };
  }
  if (failure) throw failure.error;
  return result as T;
}

/** Caller holds the Session writer; block new pins and drain existing readers before retirement. */
export async function withSessionReadDrain<T>(root: string, action: () => Promise<T>): Promise<T> {
  const paths = await pinPaths(root);
  const releaseGate = await acquireFileLock(paths.gate);
  let result: T | undefined;
  let failure: { error: unknown } | undefined;
  try {
    let entries: string[];
    try {
      entries = await readdir(paths.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      entries = [];
    }
    const deadline = Date.now() + 30_000;
    for (const name of entries.filter((entry) => PIN.test(entry))) {
      const release = await acquireFileLock(
        join(paths.directory, name),
        'Session readers are busy.',
        Math.max(0, deadline - Date.now())
      );
      await release();
    }
    try {
      await rmdir(paths.directory);
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
    }
    const current = heldPins.getStore();
    result = await heldPins.run(new Set([...(current ?? []), root]), action);
  } catch (error) {
    failure = { error };
  }
  try {
    await releaseGate();
  } catch (error) {
    failure ??= { error };
  }
  if (failure) throw failure.error;
  return result as T;
}
