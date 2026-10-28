import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { WorkspaceContentMatch, WorkspaceContentSearch } from '@myagentroam/protocol';
import type { NodeWorkspace } from './contracts.js';
import { logNodeCommandFailure } from '../operational.js';
import { bundledRipgrepPath } from '../ripgrep-binary.js';
import type { WorkspaceFileService } from './workspace-file-service.js';

const RESULT_LIMIT = 200;
const PER_FILE_LIMIT = 20;
const FILE_BYTE_LIMIT = 2 * 1024 * 1024;
const SCAN_BYTE_LIMIT = 64 * 1024 * 1024;
const OUTPUT_BYTE_LIMIT = 2 * 1024 * 1024;
const TIMEOUT_MS = 5_000;
const WINDOWS_ARGUMENT_BATCH_BYTES = 24 * 1024;
const POSIX_ARGUMENT_BATCH_BYTES = 96 * 1024;
const SEARCH_CONCURRENCY = 2;
const SEARCH_QUEUE_LIMIT = 16;
const CANDIDATE_VALIDATION_CONCURRENCY = 32;

type SearchEngine = WorkspaceContentSearch['engine'];
interface SearchInput {
  readonly query: string;
  readonly regex: boolean;
}
interface Candidate {
  readonly path: string;
  readonly absolutePath: string;
}
interface CommandResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

let activeSearches = 0;
const searchWaiters: (() => void)[] = [];

async function acquireSearch(deadline: number): Promise<() => void> {
  if (activeSearches >= SEARCH_CONCURRENCY) {
    if (searchWaiters.length >= SEARCH_QUEUE_LIMIT) throw new Error('FILE_CONTENT_SEARCH_BUSY');
    await new Promise<void>((resolve, reject) => {
      const resume = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(
        () => {
          const index = searchWaiters.indexOf(resume);
          if (index >= 0) searchWaiters.splice(index, 1);
          reject(new Error('CONTENT_SEARCH_TIMEOUT'));
        },
        Math.max(1, deadline - Date.now())
      );
      searchWaiters.push(resume);
    });
  }
  activeSearches += 1;
  return () => {
    activeSearches -= 1;
    searchWaiters.shift()?.();
  };
}

export class WorkspaceContentSearchService {
  private readonly pending = new Map<string, Promise<WorkspaceContentSearch>>();

  constructor(
    private readonly files: WorkspaceFileService,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly ripgrep: string | null = resolveRipgrep()
  ) {}

  search(
    workspace: NodeWorkspace,
    input: Record<string, unknown>
  ): Promise<WorkspaceContentSearch> {
    if (typeof input.query !== 'string' || input.query.length < 1 || input.query.length > 256)
      throw new Error('FILE_CONTENT_SEARCH_INVALID');
    if (input.regex !== undefined && typeof input.regex !== 'boolean')
      throw new Error('FILE_CONTENT_SEARCH_INVALID');
    const search: SearchInput = { query: input.query, regex: input.regex === true };
    const queryKey = search.regex ? search.query : search.query.toLocaleLowerCase();
    const key = `${workspace.id}\0${search.regex}\0${queryKey}`;
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing;
    const task = this.perform(workspace, search).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  private async perform(
    workspace: NodeWorkspace,
    search: SearchInput
  ): Promise<WorkspaceContentSearch> {
    const deadline = Date.now() + TIMEOUT_MS;
    const release = await acquireSearch(deadline);
    try {
      if (search.regex && this.ripgrep === null) throw new Error('RIPGREP_RESOURCE_UNAVAILABLE');
      const prepared = await this.candidates(workspace, deadline);
      if (prepared.files.length === 0) {
        if (search.regex) await this.validateNativeRegex(workspace.path, search, deadline);
        return {
          matches: [],
          engine: 'NODE',
          truncated: prepared.truncated || Date.now() >= deadline,
          skippedFiles: prepared.skippedFiles
        };
      }
      if (this.ripgrep !== null) {
        try {
          const matches = await this.nativeSearch(
            'RIPGREP',
            workspace.path,
            prepared.files,
            search,
            deadline
          );
          return {
            matches: matches.slice(0, RESULT_LIMIT),
            engine: 'RIPGREP',
            truncated:
              prepared.truncated || matches.length > RESULT_LIMIT || Date.now() >= deadline,
            skippedFiles: prepared.skippedFiles
          };
        } catch (error) {
          if (search.regex) throw error;
          // Missing, incompatible or failed bundled resources safely fall through.
        }
      }
      const fallback = await nodeSearch(prepared.files, search.query, deadline);
      return {
        matches: fallback.matches.slice(0, RESULT_LIMIT),
        engine: 'NODE',
        truncated:
          prepared.truncated || fallback.matches.length > RESULT_LIMIT || Date.now() >= deadline,
        skippedFiles: prepared.skippedFiles + fallback.skippedFiles
      };
    } finally {
      release();
    }
  }

  private async validateNativeRegex(
    root: string,
    search: SearchInput,
    deadline: number
  ): Promise<void> {
    const command = commandFor('RIPGREP', [], search, this.ripgrep ?? undefined);
    const result = await runCommand(command.file, [...command.args, '-'], root, deadline);
    if (result.code === 2) {
      logNodeCommandFailure('rg', { exitCode: result.code, reason: 'INVALID_QUERY' });
      throw new Error('FILE_CONTENT_SEARCH_INVALID');
    }
    if (!command.validCodes.includes(result.code)) {
      logNodeCommandFailure('rg', { exitCode: result.code, stderr: result.stderr });
      throw new Error('CONTENT_SEARCH_COMMAND_FAILED');
    }
  }

  private async candidates(
    workspace: NodeWorkspace,
    deadline: number
  ): Promise<{
    readonly files: readonly Candidate[];
    readonly skippedFiles: number;
    readonly truncated: boolean;
  }> {
    const root = await realpath(workspace.path);
    let candidates: Awaited<
      ReturnType<ReturnType<WorkspaceFileService['index']>['contentCandidates']>
    >;
    try {
      candidates = await beforeDeadline(this.files.index(workspace).contentCandidates(), deadline);
    } catch (error) {
      if (error instanceof Error && error.message === 'CONTENT_SEARCH_TIMEOUT')
        return { files: [], skippedFiles: 0, truncated: true };
      throw error;
    }
    const files: Candidate[] = [];
    let skippedFiles = 0;
    let bytes = 0;
    let truncated = candidates.truncated;
    for (
      let offset = 0;
      offset < candidates.entries.length;
      offset += CANDIDATE_VALIDATION_CONCURRENCY
    ) {
      if (Date.now() >= deadline) {
        truncated = true;
        break;
      }
      const validated = await Promise.all(
        candidates.entries
          .slice(offset, offset + CANDIDATE_VALIDATION_CONCURRENCY)
          .map((entry) => validateCandidate(root, entry.path))
      );
      for (const candidate of validated) {
        if (candidate === undefined) {
          skippedFiles += 1;
          continue;
        }
        if (bytes + candidate.size > SCAN_BYTE_LIMIT) {
          truncated = true;
          break;
        }
        bytes += candidate.size;
        files.push({ path: candidate.path, absolutePath: candidate.absolutePath });
      }
      if (truncated) break;
    }
    return { files, skippedFiles, truncated };
  }

  private async nativeSearch(
    engine: SearchEngine,
    root: string,
    files: readonly Candidate[],
    search: SearchInput,
    deadline: number
  ): Promise<WorkspaceContentMatch[]> {
    const matches: WorkspaceContentMatch[] = [];
    const argumentBatchBytes =
      this.platform === 'win32' ? WINDOWS_ARGUMENT_BATCH_BYTES : POSIX_ARGUMENT_BATCH_BYTES;
    for (const batch of batches(files, argumentBatchBytes)) {
      if (Date.now() >= deadline || matches.length > RESULT_LIMIT) break;
      const command = commandFor(engine, batch, search, this.ripgrep ?? undefined);
      const result = await runCommand(
        command.file,
        command.args,
        root,
        deadline,
        engine === 'RIPGREP'
      );
      if (!command.validCodes.includes(result.code)) {
        if (search.regex && result.code === 2) {
          logNodeCommandFailure('rg', { exitCode: result.code, reason: 'INVALID_QUERY' });
          throw new Error('FILE_CONTENT_SEARCH_INVALID');
        }
        logNodeCommandFailure('rg', { exitCode: result.code, stderr: result.stderr });
        throw new Error('CONTENT_SEARCH_COMMAND_FAILED');
      }
      const paths = new Map(
        batch.flatMap((file) => [
          [normalizeResultPath(file.path, this.platform), file.path] as const,
          [normalizeResultPath(file.absolutePath, this.platform), file.path] as const
        ])
      );
      matches.push(
        ...parseOutput(engine, result.stdout, search).map((match) => ({
          ...match,
          path:
            paths.get(normalizeResultPath(match.path, this.platform)) ??
            (() => {
              throw new Error('CONTENT_SEARCH_OUTPUT_INVALID');
            })()
        }))
      );
    }
    return limitPerFile(matches);
  }
}

async function validateCandidate(
  root: string,
  path: string
): Promise<(Candidate & { readonly size: number }) | undefined> {
  try {
    const absolutePath = await realpath(join(root, path));
    const inside = relative(root, absolutePath);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
    const metadata = await lstat(absolutePath);
    return metadata.isFile() && metadata.size <= FILE_BYTE_LIMIT
      ? { path, absolutePath, size: metadata.size }
      : undefined;
  } catch {
    return undefined;
  }
}

async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('CONTENT_SEARCH_TIMEOUT')),
      Math.max(1, deadline - Date.now())
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function normalizeResultPath(path: string, platform: NodeJS.Platform): string {
  const normalized = path.replaceAll('\\', '/');
  return platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

function batches(files: readonly Candidate[], maximumBytes: number): Candidate[][] {
  const result: Candidate[][] = [];
  let current: Candidate[] = [];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file.path) + 1;
    if (current.length > 0 && bytes + size > maximumBytes) {
      result.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += size;
  }
  if (current.length > 0) result.push(current);
  return result;
}

function commandFor(
  engine: SearchEngine,
  files: readonly Candidate[],
  search: SearchInput,
  ripgrep?: string
) {
  const paths = files.map((file) => file.path);
  if (engine === 'RIPGREP')
    return {
      file:
        ripgrep ??
        (() => {
          throw new Error('RIPGREP_RESOURCE_UNAVAILABLE');
        })(),
      args: [
        '--json',
        '--no-config',
        '--ignore-case',
        '--max-count',
        String(PER_FILE_LIMIT),
        ...(search.regex ? [] : ['--fixed-strings']),
        '--',
        search.query,
        ...paths
      ],
      validCodes: [0, 1]
    };
  throw new Error('CONTENT_SEARCH_ENGINE_UNSUPPORTED');
}

function resolveRipgrep(): string | null {
  try {
    return bundledRipgrepPath();
  } catch {
    return null;
  }
}

async function runCommand(
  file: string,
  args: readonly string[],
  cwd: string,
  deadline: number,
  stopAfterResultLimit = false
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(file, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let pending = Buffer.alloc(0);
    let bytes = 0;
    let errorBytes = 0;
    let matches = 0;
    let stopped = false;
    let failed = false;
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill();
      },
      Math.max(1, deadline - Date.now())
    );
    child.once('error', (error) => {
      clearTimeout(timer);
      failed = true;
      logNodeCommandFailure('rg', {
        reason: (error as NodeJS.ErrnoException).code ?? 'START_FAILED',
        durationMs: Math.round(performance.now() - startedAt)
      });
      reject(error);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = Math.max(0, 1_000 - errorBytes);
      if (remaining === 0) return;
      const retained = chunk.subarray(0, remaining);
      errors.push(retained);
      errorBytes += retained.length;
    });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_BYTE_LIMIT) {
        child.kill();
        return;
      }
      if (!stopAfterResultLimit) {
        chunks.push(chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        const record = pending.subarray(0, newline + 1);
        chunks.push(record);
        if (record.includes(Buffer.from('"type":"match"'))) matches += 1;
        pending = pending.subarray(newline + 1);
        if (matches > RESULT_LIMIT) {
          stopped = true;
          child.kill();
          return;
        }
        newline = pending.indexOf(0x0a);
      }
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (failed) return;
      const stderr = Buffer.concat(errors).toString('utf8');
      if (stopped) resolve({ code: 0, stdout: Buffer.concat(chunks), stderr });
      else if (timedOut || signal !== null || bytes > OUTPUT_BYTE_LIMIT) {
        logNodeCommandFailure('rg', {
          reason: timedOut ? 'TIMEOUT' : bytes > OUTPUT_BYTE_LIMIT ? 'OUTPUT_LIMIT' : 'SIGNAL',
          stderr,
          durationMs: Math.round(performance.now() - startedAt)
        });
        reject(new Error('CONTENT_SEARCH_COMMAND_LIMIT'));
      } else {
        if (stopAfterResultLimit && pending.length > 0) chunks.push(pending);
        resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr });
      }
    });
  });
}

function parseOutput(
  engine: SearchEngine,
  output: Buffer,
  search: SearchInput
): WorkspaceContentMatch[] {
  if (engine === 'RIPGREP') return parseRipgrep(output, search);
  if (engine === 'GREP') return parseGrep(output, search);
  return parsePowerShell(output, search);
}

function parseRipgrep(output: Buffer, search: SearchInput): WorkspaceContentMatch[] {
  return output
    .toString('utf8')
    .split('\n')
    .flatMap((line) => {
      if (line === '') return [];
      const value = JSON.parse(line) as {
        readonly type?: unknown;
        readonly data?: {
          readonly path?: { readonly text?: unknown };
          readonly line_number?: unknown;
          readonly lines?: { readonly text?: unknown };
          readonly submatches?: readonly { readonly start?: unknown }[];
        };
      };
      if (value.type !== 'match') return [];
      const data = value.data;
      const preview = String(data?.lines?.text).replace(/[\r\n]+$/u, '');
      const column = search.regex
        ? regexRipgrepIndex(preview, data?.submatches)
        : lowerIndex(preview, search.query);
      if (typeof data?.path?.text !== 'string' || !Number.isInteger(data.line_number) || column < 0)
        throw new Error('CONTENT_SEARCH_OUTPUT_INVALID');
      return [
        {
          path: data.path.text,
          line: data.line_number as number,
          column: column + 1,
          preview: preview.slice(0, 8192)
        }
      ];
    });
}

function parseGrep(output: Buffer, search: SearchInput): WorkspaceContentMatch[] {
  const matches: WorkspaceContentMatch[] = [];
  let offset = 0;
  while (offset < output.length) {
    const separator = output.indexOf(0, offset);
    const end = output.indexOf(10, separator + 1);
    if (separator < 0 || end < 0) throw new Error('CONTENT_SEARCH_OUTPUT_INVALID');
    const path = output.subarray(offset, separator).toString('utf8');
    const record = output.subarray(separator + 1, end).toString('utf8');
    const colon = record.indexOf(':');
    const preview = record.slice(colon + 1).replace(/\r$/u, '');
    const column = lowerIndex(preview, search.query);
    if (colon < 1 || column < 0) throw new Error('CONTENT_SEARCH_OUTPUT_INVALID');
    matches.push({
      path,
      line: Number(record.slice(0, colon)),
      column: column + 1,
      preview: preview.slice(0, 8192)
    });
    offset = end + 1;
  }
  return matches;
}

function parsePowerShell(output: Buffer, search: SearchInput): WorkspaceContentMatch[] {
  return output
    .toString('utf8')
    .split(/\r?\n/u)
    .flatMap((line) => {
      if (line === '') return [];
      const match = JSON.parse(line) as Partial<WorkspaceContentMatch>;
      if (
        typeof match.path !== 'string' ||
        !Number.isInteger(match.line) ||
        typeof match.preview !== 'string'
      )
        throw new Error('CONTENT_SEARCH_OUTPUT_INVALID');
      const column = lowerIndex(match.preview, search.query);
      if (column < 0) throw new Error('CONTENT_SEARCH_OUTPUT_INVALID');
      return [
        {
          path: match.path,
          line: match.line as number,
          column: column + 1,
          preview: match.preview.slice(0, 8192)
        }
      ];
    });
}

async function nodeSearch(
  files: readonly Candidate[],
  query: string,
  deadline: number
): Promise<{ readonly matches: WorkspaceContentMatch[]; readonly skippedFiles: number }> {
  const matches: WorkspaceContentMatch[] = [];
  let skippedFiles = 0;
  for (const file of files) {
    if (Date.now() >= deadline || matches.length > RESULT_LIMIT) break;
    const fileResults: WorkspaceContentMatch[] = [];
    const stream = createReadStream(file.absolutePath);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '';
    let line = 0;
    let fileMatches = 0;
    const addLine = (value: string): boolean => {
      line += 1;
      const preview = value.endsWith('\r') ? value.slice(0, -1) : value;
      const column = lowerIndex(preview, query);
      if (column >= 0) {
        fileResults.push({
          path: file.path,
          line,
          column: column + 1,
          preview: preview.slice(0, 8192)
        });
        fileMatches += 1;
      }
      return (
        fileMatches >= PER_FILE_LIMIT ||
        matches.length + fileResults.length > RESULT_LIMIT ||
        Date.now() >= deadline
      );
    };
    try {
      let stopped = false;
      for await (const chunk of stream) {
        pending += decoder.decode(chunk as Buffer, { stream: true });
        let newline = pending.indexOf('\n');
        while (newline >= 0) {
          if (addLine(pending.slice(0, newline))) {
            stopped = true;
            break;
          }
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
        if (stopped) break;
      }
      if (!stopped) {
        pending += decoder.decode();
        if (pending !== '') addLine(pending);
      }
      matches.push(...fileResults);
    } catch {
      // Files that disappear, become unreadable or contain invalid UTF-8 are skipped atomically.
      skippedFiles += 1;
    }
  }
  return { matches, skippedFiles };
}

function lowerIndex(source: string, query: string): number {
  return source.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
}

function regexRipgrepIndex(
  preview: string,
  submatches: readonly { readonly start?: unknown }[] | undefined
): number {
  const start = submatches?.[0]?.start;
  if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) return -1;
  return Buffer.from(preview, 'utf8').subarray(0, start).toString('utf8').length;
}

function limitPerFile(matches: readonly WorkspaceContentMatch[]): WorkspaceContentMatch[] {
  const counts = new Map<string, number>();
  return matches.filter((match) => {
    const count = counts.get(match.path) ?? 0;
    if (count >= PER_FILE_LIMIT) return false;
    counts.set(match.path, count + 1);
    return true;
  });
}
