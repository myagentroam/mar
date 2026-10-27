import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentError } from '../../../error.js';
import { decodeJsonlRecord, encodeJsonlRecord } from './jsonl-codec.js';
import { syncAndClose, syncJsonlDirectory } from './fs-durability.js';
import type { SessionMeta } from '../types.js';

interface GenerationPreparation {
  readonly source: string;
  readonly destination: string;
  readonly sessionId: string;
  readonly nextSequence: number;
}

/** Prepare a candidate only; the caller owns locking and the index commit. */
export async function prepareJsonlV2Generation(input: GenerationPreparation): Promise<{
  segments: NonNullable<SessionMeta['segments']>;
}> {
  await mkdir(input.destination, { mode: 0o700 });
  const names = (await readdir(input.source))
    .filter((name) => /^events-\d{6}\.jsonl$/u.test(name))
    .sort();
  if (!names.length) throw corruptHistory();
  const originalHash = createHash('sha256');
  const candidateHash = createHash('sha256');
  const segments: NonNullable<SessionMeta['segments']> = [];
  let lastSequence = 0;
  let originalCount = 0;
  let candidateCount = 0;
  for (const name of names) {
    const source = await readFile(join(input.source, name), 'utf8');
    if (!source.endsWith('\n')) throw corruptHistory();
    const output: string[] = [];
    let firstSequence: number | undefined;
    for (const line of source.split('\n')) {
      if (!line) continue;
      const record = decodeJsonlRecord(line, 1);
      if (record.sessionId !== input.sessionId || record.sequence <= lastSequence)
        throw corruptHistory();
      firstSequence ??= record.sequence;
      lastSequence = record.sequence;
      originalHash.update(JSON.stringify(record)).update('\n');
      originalCount++;
      const encoded = encodeJsonlRecord(record, 2);
      const reread = decodeJsonlRecord(encoded, 2);
      candidateHash.update(JSON.stringify(reread)).update('\n');
      candidateCount++;
      output.push(`${encoded}\n`);
    }
    if (firstSequence === undefined) throw corruptHistory();
    const content = output.join('');
    await writeFile(join(input.destination, name), content, {
      flag: 'wx',
      mode: 0o600,
      flush: true
    });
    segments.push({
      number: Number(name.slice(7, 13)),
      firstSequence,
      lastSequence,
      bytes: Buffer.byteLength(content)
    });
  }
  if (
    lastSequence + 1 !== input.nextSequence ||
    originalCount !== candidateCount ||
    originalHash.digest('hex') !== candidateHash.digest('hex')
  )
    throw corruptHistory();
  await copyOptionalFile(
    join(input.source, 'context-world-state.json'),
    join(input.destination, 'context-world-state.json')
  );
  await copyPrivateDirectory(
    input.source,
    input.destination,
    'resources',
    /^[a-f0-9]{64}\.(?:bin|json)$/u
  );
  await copyPrivateDirectory(
    input.source,
    input.destination,
    'tool_results',
    /^[0-9a-f-]{36}\.(?:diff|json)$/iu
  );
  await syncJsonlDirectory(input.destination);
  return { segments };
}

async function copyPrivateDirectory(
  source: string,
  target: string,
  name: string,
  accepted: RegExp
) {
  let entries: string[];
  try {
    entries = await readdir(join(source, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const files = entries.filter((entry) => accepted.test(entry));
  if (!files.length) return;
  const directory = join(target, name);
  await mkdir(directory, { mode: 0o700 });
  for (const file of files) await copyOptionalFile(join(source, name, file), join(directory, file));
  await syncJsonlDirectory(directory);
}

async function copyOptionalFile(source: string, target: string) {
  let sourceInfo;
  try {
    sourceInfo = await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!sourceInfo.isFile()) return;
  await copyFile(source, target);
  const handle = await open(target, 'r');
  await syncAndClose(handle);
}

function corruptHistory(): AgentError {
  return new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session history is corrupt.');
}
