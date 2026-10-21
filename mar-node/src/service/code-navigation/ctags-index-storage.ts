import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { logNodeCommandFailure } from '../../operational.js';
import type { WorkspaceFileEntry } from '../../workspace.js';
import { compareTagNames } from './ctags-query.js';
import { sourceFileFingerprint } from './navigation-target-validator.js';

const BUILD_TIMEOUT_MS = 120_000;
const BUILD_QUEUE_LIMIT = 4;
const BUILD_QUEUE_TIMEOUT_MS = 120_000;
const MAX_TAGS_BYTES = 512 * 1024 * 1024;

let activeBuilds = 0;
const buildWaiters: Array<() => void> = [];

export interface IndexManifest {
  readonly schemaVersion: number;
  readonly optionsVersion: number;
  readonly ctagsVersion: string;
  readonly sourceFingerprint: string;
  readonly sourceFiles?: Readonly<Record<string, string>>;
  readonly truncated: boolean;
  readonly generation: string;
}

export interface IndexLocation {
  readonly directory: string;
  readonly manifest: string;
  readonly generations: string;
}

export function sourceDelta(
  previous: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>
): { readonly changed: readonly string[]; readonly removed: readonly string[] } {
  const changed = Object.entries(current)
    .filter(([path, fingerprint]) => previous[path] !== fingerprint)
    .map(([path]) => path);
  const removed = Object.keys(previous).filter((path) => current[path] === undefined);
  return { changed, removed };
}

export function manifestEntry(path: string, fingerprint: string): WorkspaceFileEntry | undefined {
  const match = /^([0-9]+):(-1|[0-9]+(?:\.[0-9]+)?)$/u.exec(fingerprint);
  if (match === null) return undefined;
  const size = Number(match[1]);
  const modifiedAt = match[2] === '-1' ? null : Number(match[2]);
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    (modifiedAt !== null && !Number.isFinite(modifiedAt))
  )
    return undefined;
  return {
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    kind: 'FILE',
    size,
    modifiedAt
  };
}

export function sourceFingerprint(entries: readonly WorkspaceFileEntry[]): string {
  const hash = createHash('sha256');
  for (const entry of entries)
    hash.update(
      `${entry.path}\0${sourceFileFingerprint(entry.size ?? -1, entry.modifiedAt)}\0`,
      'utf8'
    );
  return hash.digest('hex');
}

export async function buildIncrementalTags(
  executable: string,
  root: string,
  previousTags: string,
  delta: { readonly changed: readonly string[]; readonly removed: readonly string[] },
  staging: string,
  destination: string
): Promise<number> {
  const changedTags = resolve(staging, 'changed.tags');
  if (delta.changed.length > 0) {
    const list = resolve(staging, 'changed.files.list');
    await writeFile(list, delta.changed.join('\n'), { encoding: 'utf8', mode: 0o600 });
    const release = await acquireBuild();
    try {
      const ctagsMs = await runCtags(executable, root, list, changedTags);
      await mergeTags(
        previousTags,
        changedTags,
        new Set([...delta.changed, ...delta.removed]),
        destination
      );
      return ctagsMs;
    } finally {
      release();
    }
  } else await writeFile(changedTags, '', { encoding: 'utf8', mode: 0o600 });
  await mergeTags(
    previousTags,
    changedTags,
    new Set([...delta.changed, ...delta.removed]),
    destination
  );
  return 0;
}

async function mergeTags(
  previous: string,
  changed: string,
  replacedPaths: ReadonlySet<string>,
  destination: string
): Promise<void> {
  const output = createWriteStream(destination, { encoding: 'utf8', mode: 0o600 });
  const oldLines = tagLines(previous)[Symbol.asyncIterator]();
  const changedLines = tagLines(changed)[Symbol.asyncIterator]();
  const write = async (line: string) => {
    if (!output.write(`${line}\n`))
      await new Promise<void>((resolvePromise) => output.once('drain', resolvePromise));
  };
  let old = await oldLines.next();
  while (!old.done && old.value.startsWith('!_TAG_')) {
    await write(old.value);
    old = await oldLines.next();
  }
  let nextChanged = await nextDataTag(changedLines);
  while (!old.done || nextChanged !== undefined) {
    while (!old.done && tagPath(old.value) !== undefined && replacedPaths.has(tagPath(old.value)!))
      old = await oldLines.next();
    if (old.done) {
      await write(nextChanged!);
      nextChanged = await nextDataTag(changedLines);
      continue;
    }
    if (nextChanged === undefined || compareTagLines(old.value, nextChanged) <= 0) {
      await write(old.value);
      old = await oldLines.next();
    } else {
      await write(nextChanged);
      nextChanged = await nextDataTag(changedLines);
    }
  }
  await new Promise<void>((resolvePromise, reject) => {
    output.once('error', reject);
    output.end(resolvePromise);
  });
}

async function* tagLines(path: string): AsyncGenerator<string> {
  const input = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });
  for await (const line of input) yield line;
}

async function nextDataTag(iterator: AsyncIterator<string>): Promise<string | undefined> {
  for (;;) {
    const next = await iterator.next();
    if (next.done) return undefined;
    if (!next.value.startsWith('!_TAG_')) return next.value;
  }
}

function tagPath(line: string): string | undefined {
  const second = line.indexOf('\t');
  if (second < 0) return undefined;
  const third = line.indexOf('\t', second + 1);
  return third < 0 ? undefined : line.slice(second + 1, third);
}

function compareTagLines(left: string, right: string): number {
  const leftName = left.slice(0, left.indexOf('\t'));
  const rightName = right.slice(0, right.indexOf('\t'));
  return (
    compareTagNames(leftName, rightName) || Buffer.compare(Buffer.from(left), Buffer.from(right))
  );
}

export async function acquireBuild(): Promise<() => void> {
  if (activeBuilds >= 1) {
    if (buildWaiters.length >= BUILD_QUEUE_LIMIT) throw new Error('SYMBOL_INDEX_BUILD_FAILED');
    await new Promise<void>((resolvePromise, reject) => {
      const resume = () => {
        clearTimeout(timer);
        resolvePromise();
      };
      const timer = setTimeout(() => {
        const index = buildWaiters.indexOf(resume);
        if (index >= 0) buildWaiters.splice(index, 1);
        reject(new Error('SYMBOL_INDEX_BUILD_FAILED'));
      }, BUILD_QUEUE_TIMEOUT_MS);
      timer.unref();
      buildWaiters.push(resume);
    });
  }
  activeBuilds += 1;
  return () => {
    activeBuilds -= 1;
    buildWaiters.shift()?.();
  };
}

export async function runCtags(
  executable: string,
  cwd: string,
  fileList: string,
  destination: string
): Promise<number> {
  const startedAt = Date.now();
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      executable,
      [
        '--options=NONE',
        '--output-format=u-ctags',
        '--excmd=number',
        '--sort=yes',
        '--tag-relative=no',
        '--pseudo-tags=-TAG_PROC_CWD',
        '--fields=+nKS',
        '--extras=+q',
        '-L',
        fileList,
        '-f',
        destination
      ],
      {
        cwd,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      }
    );
    const errors: Buffer[] = [];
    let errorBytes = 0;
    const stderr = () => Buffer.concat(errors).toString('utf8');
    const reportFailure = (reason: string, exitCode?: number) =>
      logNodeCommandFailure('ctags', {
        reason,
        ...(exitCode === undefined ? {} : { exitCode }),
        stderr: stderr(),
        durationMs: Date.now() - startedAt
      });
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const terminate = (): void => {
      if (child.pid !== undefined && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // Fall through to the direct process kill.
        }
      }
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      terminate();
      settle(() => {
        reportFailure('TIMEOUT');
        reject(new Error('SYMBOL_INDEX_BUILD_FAILED'));
      });
    }, BUILD_TIMEOUT_MS);
    timer.unref();
    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = Math.max(0, 1_000 - errorBytes);
      if (remaining === 0) return;
      const retained = chunk.subarray(0, remaining);
      errors.push(retained);
      errorBytes += retained.length;
    });
    child.once('error', (error) =>
      settle(() => {
        reportFailure((error as NodeJS.ErrnoException).code ?? 'START_FAILED');
        reject(new Error('SYMBOL_INDEX_BUILD_FAILED'));
      })
    );
    child.once('close', (code) =>
      settle(() => {
        if (code === 0) resolvePromise();
        else {
          reportFailure('EXIT', code ?? undefined);
          reject(new Error('SYMBOL_INDEX_BUILD_FAILED'));
        }
      })
    );
  });
  return Date.now() - startedAt;
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error('SYMBOL_INDEX_UNAVAILABLE');
}

export async function removeInactiveGenerations(
  directory: string,
  activeGeneration: string
): Promise<void> {
  const generations = await readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    generations
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name !== activeGeneration &&
          /^[0-9a-f-]{36}(?:\.staging)?$/u.test(entry.name)
      )
      .map((entry) => rm(resolve(directory, entry.name), { recursive: true, force: true }))
  );
}

export async function readManifest(path: string): Promise<IndexManifest | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<IndexManifest>;
    const sourceFiles = validManifestSourceFiles(value.sourceFiles) ? value.sourceFiles : undefined;
    const schemaVersion = value.schemaVersion;
    const optionsVersion = value.optionsVersion;
    return typeof value === 'object' &&
      value !== null &&
      typeof schemaVersion === 'number' &&
      Number.isInteger(schemaVersion) &&
      schemaVersion >= 0 &&
      typeof optionsVersion === 'number' &&
      Number.isInteger(optionsVersion) &&
      optionsVersion >= 0 &&
      typeof value.ctagsVersion === 'string' &&
      typeof value.sourceFingerprint === 'string' &&
      /^[a-f0-9]{64}$/u.test(value.sourceFingerprint) &&
      typeof value.truncated === 'boolean' &&
      typeof value.generation === 'string' &&
      /^[0-9a-f-]{36}$/u.test(value.generation)
      ? {
          schemaVersion,
          optionsVersion,
          ctagsVersion: value.ctagsVersion,
          sourceFingerprint: value.sourceFingerprint,
          ...(sourceFiles === undefined ? {} : { sourceFiles }),
          truncated: value.truncated,
          generation: value.generation
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function validManifestSourceFiles(value: unknown): value is Readonly<Record<string, string>> {
  if (value === undefined) return false;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 100_000 &&
    entries.every(
      ([path, fingerprint]) =>
        path.length > 0 &&
        path.length <= 4096 &&
        !path.includes('\0') &&
        !path.includes('\\') &&
        !path.startsWith('/') &&
        !path.split('/').some((part) => part.length === 0 || part === '.' || part === '..') &&
        typeof fingerprint === 'string' &&
        /^[0-9]+:(?:-1|[0-9]+(?:\.[0-9]+)?)$/u.test(fingerprint)
    )
  );
}

export async function tagsPath(location: IndexLocation, manifest: IndexManifest): Promise<string> {
  const path = resolve(location.generations, manifest.generation, 'tags');
  if (
    relative(location.generations, path)
      .split(sep)
      .some((part) => part === '..')
  )
    throw new Error('SYMBOL_INDEX_UNAVAILABLE');
  return path;
}

export async function tagsAvailable(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return metadata.isFile() && metadata.size <= MAX_TAGS_BYTES;
  } catch {
    return false;
  }
}
