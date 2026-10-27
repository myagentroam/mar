import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentError } from '../../../error.js';
import { retiredSessionTrashPath } from './transaction-recovery.js';
import { decodeJsonlValue } from './jsonl-codec.js';

const SEGMENT_OR_STAGE =
  /^events-\d{6}\.jsonl(?:\.[0-9a-f-]{36}\.(?:rollback-tmp|rollback-backup|clear-backup))?$/iu;
const WORLD_STATE =
  /^context-world-state\.json(?:\.\d+\.[0-9a-f-]+\.(?:rollback|clear)-backup)?$/iu;
const JOURNAL_TEMP = /^storage-transaction\.json\.[0-9a-f-]{36}\.tmp$/iu;

/** Read-only version admission before any v1 recovery can modify its evidence. */
export async function preflightV1Session(directory: string): Promise<void> {
  await preflightSession(directory, 1, false);
}

/** Inspect history only when an existing v2 recovery may replace or remove it. */
export async function preflightV2Recovery(directory: string): Promise<void> {
  await preflightSession(directory, 2, true);
}

/** Retired paths may be restored or deleted by the same journal, including other generations. */
export async function preflightRetiredRecovery(
  root: string,
  journalDirectory: string
): Promise<void> {
  let journal: unknown;
  try {
    journal = await readJsonIfComplete(join(journalDirectory, 'storage-transaction.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!isObject(journal) || typeof journal.id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(journal.id))
    return;
  if (
    typeof journal.targetGeneration === 'string' &&
    /^[0-9a-f-]{36}$/iu.test(journal.targetGeneration)
  )
    await preflightSession(join(root, 'v2', journal.targetGeneration), 2, false);
  if (!Array.isArray(journal.retiredPaths)) return;
  for (const path of journal.retiredPaths) {
    if (
      typeof path !== 'string' ||
      !/^(?:events-\d{6}\.jsonl|resources|tool_results|context-world-state\.json|v2\/[0-9a-f-]{36})$/u.test(
        path
      )
    )
      continue;
    for (const candidate of [join(root, path), retiredSessionTrashPath(root, path, journal.id)]) {
      if (path.startsWith('v2/')) await preflightSession(candidate, 2, false);
      else if (path === 'resources') await admitResourceDirectory(candidate);
      else if (path === 'context-world-state.json') {
        try {
          admitWorldStateVersion(await readJsonIfComplete(candidate));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      } else if (path.startsWith('events-')) await admitSegment(candidate, 1);
    }
  }
}

async function admitSegment(path: string, encoding: 1 | 2): Promise<void> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const line of content.split('\n')) {
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    admitRecordVersion(value, encoding);
  }
}

async function preflightSession(
  directory: string,
  encoding: 1 | 2,
  recoveryOnly: boolean
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const journalPresent = names.includes('storage-transaction.json');
  for (const name of names) {
    const path = join(directory, name);
    if (SEGMENT_OR_STAGE.test(name)) {
      if (recoveryOnly && !journalPresent && /^events-\d{6}\.jsonl$/iu.test(name)) continue;
      await admitSegment(path, encoding);
    } else if (
      name === 'storage-transaction.json' ||
      JOURNAL_TEMP.test(name) ||
      WORLD_STATE.test(name)
    ) {
      if (recoveryOnly && !journalPresent && name === 'context-world-state.json') continue;
      const value = await readJsonIfComplete(path);
      if (isObject(value)) {
        if (name === 'storage-transaction.json' || JOURNAL_TEMP.test(name))
          rejectFuture(value.version, 1);
        else admitWorldStateVersion(value);
      }
    }
  }
  if (recoveryOnly && !journalPresent) {
    await admitPendingResources(join(directory, 'resources'));
    return;
  }
  await admitResourceDirectory(join(directory, 'resources'));
  await admitPendingResources(join(directory, 'resources'));
}

async function admitPendingResources(directory: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const metadata = new Set<string>();
  for (const name of names) {
    const pending = /^\.([a-f0-9]{64})\.pending$/u.exec(name);
    if (pending) metadata.add(`${pending[1]}.json`);
    if (/^\.[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/u.test(name)) metadata.add(name);
  }
  for (const name of metadata) {
    try {
      admitResourceMetadataVersion(await readJsonIfComplete(join(directory, name)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function admitResourceDirectory(resources: string): Promise<void> {
  let resourceNames: string[];
  try {
    resourceNames = await readdir(resources);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of resourceNames) {
    if (
      !/^(?:[a-f0-9]{64}\.json|\.[a-f0-9]{64}\.json\.[0-9a-f-]{36}\.rollback-trash)$/iu.test(name)
    )
      continue;
    const value = await readJsonIfComplete(join(resources, name));
    admitResourceMetadataVersion(value);
  }
}

/** Check known versioned fields without treating ordinary corruption as a future format. */
export function admitV1RecordVersion(line: string): void {
  const value: unknown = JSON.parse(line);
  admitRecordVersion(value, 1);
}

function admitRecordVersion(value: unknown, encoding: 1 | 2): void {
  try {
    decodeJsonlValue(value, encoding);
  } catch (error) {
    if (error instanceof AgentError && error.code === 'MAR_AGENT_SESSION_VERSION_UNSUPPORTED')
      throw error;
  }
}

async function readJsonIfComplete(path: string): Promise<unknown> {
  const content = await readFile(path, 'utf8');
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

function rejectFuture(version: unknown, supported: number): void {
  if (typeof version === 'number' && Number.isSafeInteger(version) && version > supported)
    throw new AgentError(
      'MAR_AGENT_SESSION_VERSION_UNSUPPORTED',
      'Session encoding is unsupported.'
    );
}

export function admitWorldStateVersion(value: unknown): void {
  if (!isObject(value)) return;
  rejectFuture(value.version, 1);
  if (isObject(value.state)) rejectFuture(value.state.version, 2);
}

export function admitResourceMetadataVersion(value: unknown): void {
  if (isObject(value)) rejectFuture(value.resourceInputVersion, 1);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
