import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, parse, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { MarAgentError } from '../../error.js';
import type { ClientToolDefinition } from '../../model/contracts.js';
import type { ApplyPatchFileResult, ApplyPatchResult } from '../contracts.js';
import { TOOL_EXECUTION_LIMITS } from '../execution-limits.js';
import { captureFileChange, reserveFileChangePaths } from '../result-extensions.js';
import { WorkspacePathResolver } from '../shared/path-resolver.js';
import {
  parsePatch,
  type PatchChange as Change,
  type PatchHunk as Hunk
} from './apply-patch-parser.js';
export type { ApplyPatchFileResult, ApplyPatchResult } from '../contracts.js';

export const applyPatchToolDefinition: ClientToolDefinition = {
  name: 'apply_patch',
  allowedCallers: ['direct', 'programmatic'],
  parallelSafety: 'serial',
  description: `Preferred for precise, reviewable local edits. Do not batch all task files merely to reduce tool calls. Group only a few tightly coupled edits whose combined patch is quick to generate and review; split broad or independent work into successive bounded patches before composing them. Submit a raw *** Begin Patch / *** End Patch patch, each marker on its own line. Surrounding marker whitespace and an optional trailing *** are accepted; incomplete markers or extra text are rejected. Add File content lines, including blank lines, must start with +. Syntax errors include line/column and a bounded caret diagnostic with file content omitted. Supports Add File, Update File, Delete File, and Move to. Add File may replace an existing regular file, and Move to may replace an existing regular destination; duplicate operations on the same resolved path remain invalid. Update hunks accept @@ or @@ <change context>. Context-only hunks, including trailing hunks, and unchanged file sections are validated in order but are not written or reported as edits. The patch must include a change or move. Context is searched forward with Codex-style exact, whitespace-tolerant, then common Unicode punctuation-tolerant matching. Syntax and resolved paths are validated before writing, then file units are committed in order. Each file unit is atomic, and a Move keeps its source and destination atomic. On MAR_AGENT_PATCH_PARTIAL, earlier files remain applied; the error lists applied, failed, and pending paths, so retry only failed and pending paths. Existing file permissions, line endings, and final-newline state are preserved. Returns changed file paths and operations with per-file and total line counts when all units succeed. In Code Mode, the Promise resolves on success and rejects with code/message on failure; the returned envelope has data.files and data.totals, not an ok or success flag. Oversized patches are rejected without advertising defensive limits as recommended patch sizes. A first-unit MAR_AGENT_PATCH_CONFLICT applies nothing; hunk match conflicts identify the affected path and hunk so you can reread only that file before retrying.`,
  inputMode: 'freeform',
  outputSchema: {
    type: 'object',
    required: ['content', 'data'],
    properties: {
      content: { type: 'string' },
      data: {
        type: 'object',
        required: ['files', 'totals'],
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              required: ['path', 'operation', 'addedLines', 'deletedLines'],
              properties: {
                path: { type: 'string' },
                targetPath: { type: 'string' },
                operation: { enum: ['added', 'modified', 'deleted', 'moved'] },
                addedLines: { type: 'number' },
                deletedLines: { type: 'number' }
              }
            }
          },
          totals: {
            type: 'object',
            required: ['files', 'addedLines', 'deletedLines'],
            properties: {
              files: { type: 'number' },
              addedLines: { type: 'number' },
              deletedLines: { type: 'number' }
            }
          }
        }
      }
    }
  },
  inputSchema: {
    type: 'object',
    properties: { patch: { type: 'string' } },
    required: ['patch'],
    additionalProperties: false
  }
};

export function applyPatchToolInput(input: unknown): string {
  const patch =
    typeof input === 'string' ? input : (input as { patch?: unknown } | undefined)?.patch;
  if (typeof patch !== 'string')
    throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Patch is required.');
  return patch;
}

type UpdateChange = Extract<Change, { kind: 'update' }>;
type MoveChange = Omit<UpdateChange, 'targetPath'> & { targetPath: string };
type ResolvedChange =
  | { kind: 'add'; change: Extract<Change, { kind: 'add' }>; target: string }
  | { kind: 'delete'; change: Extract<Change, { kind: 'delete' }>; source: string }
  | { kind: 'update'; change: UpdateChange; source: string }
  | { kind: 'move'; change: MoveChange; source: string; target: string };
type Mutation = {
  path: string;
  target: string;
  content?: Buffer;
  mode?: number;
  expectedExisting: boolean;
  original?: Buffer;
};

interface PatchFileOperations {
  rename(source: string, target: string): Promise<void>;
  rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
}

const defaultFileOperations: PatchFileOperations = { rename, rm };
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export class ApplyPatchTool {
  readonly #fileOperations: PatchFileOperations;

  constructor(
    private readonly paths: WorkspacePathResolver,
    operations: Partial<PatchFileOperations> = {}
  ) {
    this.#fileOperations = { ...defaultFileOperations, ...operations };
  }

  async execute(patch: string): Promise<ApplyPatchResult> {
    const changes = parsePatch(patch);
    reserveFileChangePaths(
      changes.flatMap((change) =>
        change.kind === 'update' && change.targetPath
          ? [change.path, change.targetPath]
          : [change.path]
      )
    );
    const resolvedChanges = await this.#resolveChanges(changes);
    const results: ApplyPatchFileResult[] = [];
    let totalBytes = 0;
    const pendingChanges: ResolvedChange[] = [];
    for (const resolvedChange of resolvedChanges) {
      if (
        resolvedChange.kind === 'update' &&
        resolvedChange.change.hunks.every((hunk) => hunk.anchor)
      )
        totalBytes = (await this.#preflight(resolvedChange, totalBytes)).totalBytes;
      else pendingChanges.push(resolvedChange);
    }
    for (const [index, resolvedChange] of pendingChanges.entries()) {
      try {
        const preflight = await this.#preflight(resolvedChange, totalBytes);
        if (preflight.mutations.length) await this.#commit(preflight.mutations);
        if (preflight.result) results.push(preflight.result);
        totalBytes = preflight.totalBytes;
      } catch (error) {
        if (
          !results.length ||
          (error instanceof MarAgentError && error.code === 'MAR_AGENT_PATCH_ROLLBACK_FAILED')
        )
          throw error;
        throw partialPatchError(error, results, pendingChanges.slice(index));
      }
    }
    return {
      files: results,
      totals: {
        files: results.length,
        addedLines: results.reduce((total, file) => total + file.addedLines, 0),
        deletedLines: results.reduce((total, file) => total + file.deletedLines, 0)
      }
    };
  }

  async #resolveChanges(changes: readonly Change[]): Promise<ResolvedChange[]> {
    const resolvedChanges: ResolvedChange[] = [];
    const claimedTargets = new Set<string>();
    const claimTarget = (target: string) => {
      const key = resolve(target);
      if (claimedTargets.has(key)) invalid('Patch contains duplicate or overlapping paths.');
      claimedTargets.add(key);
    };
    for (const change of changes) {
      if (change.kind === 'add') {
        const target = await this.paths.resolve(change.path, true, 'write');
        claimTarget(target);
        resolvedChanges.push({ kind: 'add', change, target });
        continue;
      }
      const source = await this.paths.resolve(change.path, true, 'write');
      claimTarget(source);
      if (change.kind === 'delete') {
        resolvedChanges.push({ kind: 'delete', change, source });
        continue;
      }
      if (change.targetPath) {
        const target = await this.paths.resolve(change.targetPath, true, 'write');
        claimTarget(target);
        resolvedChanges.push({
          kind: 'move',
          change: { ...change, targetPath: change.targetPath },
          source,
          target
        });
      } else resolvedChanges.push({ kind: 'update', change, source });
    }
    return resolvedChanges;
  }

  async #preflight(
    resolvedChange: ResolvedChange,
    currentTotalBytes: number
  ): Promise<{
    mutations: Mutation[];
    result?: ApplyPatchFileResult;
    totalBytes: number;
  }> {
    if (resolvedChange.kind === 'add') {
      const { change } = resolvedChange;
      const targetStat = await optionalLstat(resolvedChange.target);
      if (targetStat && !targetStat.isFile()) invalid('Patch targets must be regular files.');
      const content = Buffer.from(change.lines.length ? `${change.lines.join('\n')}\n` : '');
      const totalBytes = enforceContentLimits(content, currentTotalBytes);
      return {
        mutations: [
          {
            path: change.path,
            target: resolvedChange.target,
            content,
            ...(targetStat ? { mode: targetStat.mode & 0o7777 } : {}),
            expectedExisting: targetStat !== undefined,
            ...(targetStat ? { original: await readBoundedFile(resolvedChange.target) } : {})
          }
        ],
        result: {
          path: change.path,
          operation: 'added',
          addedLines: change.lines.length,
          deletedLines: 0
        } satisfies ApplyPatchFileResult,
        totalBytes
      };
    }
    const sourceStat = await lstat(resolvedChange.source);
    if (!sourceStat.isFile()) invalid('Patch sources must be regular files.');
    const original = await readBoundedFile(resolvedChange.source);
    let totalBytes = enforceContentLimits(original, currentTotalBytes);
    if (resolvedChange.kind === 'delete') {
      const { change } = resolvedChange;
      return {
        mutations: [
          { path: change.path, target: resolvedChange.source, expectedExisting: true, original }
        ],
        result: {
          path: change.path,
          operation: 'deleted',
          addedLines: 0,
          deletedLines: logicalLineCount(original)
        } satisfies ApplyPatchFileResult,
        totalBytes
      };
    }
    const { change } = resolvedChange;
    const content = change.hunks.length
      ? applyHunks(original, change.hunks, change.path)
      : original;
    totalBytes = enforceContentLimits(content, totalBytes);
    const addedLines = change.hunks.reduce((sum, hunk) => sum + hunk.addedLines, 0);
    const deletedLines = change.hunks.reduce((sum, hunk) => sum + hunk.deletedLines, 0);
    if (resolvedChange.kind === 'update' && !addedLines && !deletedLines)
      return { mutations: [], totalBytes };
    if (resolvedChange.kind === 'move') {
      const moveChange = resolvedChange.change;
      const targetStat = await optionalLstat(resolvedChange.target);
      if (targetStat && !targetStat.isFile()) invalid('Patch targets must be regular files.');
      return {
        mutations: [
          { path: change.path, target: resolvedChange.source, expectedExisting: true, original },
          {
            path: moveChange.targetPath,
            target: resolvedChange.target,
            content,
            mode: (targetStat ?? sourceStat).mode & 0o7777,
            expectedExisting: targetStat !== undefined,
            ...(targetStat ? { original: await readBoundedFile(resolvedChange.target) } : {})
          }
        ],
        result: {
          path: change.path,
          targetPath: moveChange.targetPath,
          operation: 'moved',
          addedLines,
          deletedLines
        } satisfies ApplyPatchFileResult,
        totalBytes
      };
    }
    return {
      mutations: [
        {
          path: change.path,
          target: resolvedChange.source,
          content,
          mode: sourceStat.mode & 0o7777,
          expectedExisting: true,
          original
        }
      ],
      result: {
        path: change.path,
        operation: 'modified',
        addedLines,
        deletedLines
      } satisfies ApplyPatchFileResult,
      totalBytes
    };
  }

  async #commit(mutations: Mutation[]) {
    const staged: Array<Mutation & { temporary: string }> = [];
    const backups: Array<{ target: string; backup: string }> = [];
    const installed: string[] = [];
    const createdDirectories: string[] = [];
    try {
      for (const mutation of mutations) {
        if (!mutation.content) continue;
        await ensureDirectory(dirname(mutation.target), createdDirectories);
        const temporary = `${mutation.target}.mar-patch-${randomUUID()}.tmp`;
        await writeFile(temporary, mutation.content, { flag: 'wx' });
        if (mutation.mode !== undefined) await chmod(temporary, mutation.mode);
        staged.push({ ...mutation, temporary });
      }
      for (const mutation of mutations)
        if ((await exists(mutation.target)) !== mutation.expectedExisting)
          throw new MarAgentError(
            'MAR_AGENT_PATCH_CONFLICT',
            'A patch target changed after preflight.'
          );
      for (const mutation of mutations) {
        if (!(await exists(mutation.target))) continue;
        const backup = `${mutation.target}.mar-patch-${randomUUID()}.bak`;
        await this.#fileOperations.rename(mutation.target, backup);
        backups.push({ target: mutation.target, backup });
        if (mutation.original && !(await readBoundedFile(backup)).equals(mutation.original))
          throw new MarAgentError(
            'MAR_AGENT_PATCH_CONFLICT',
            'A patch target changed after preflight.'
          );
      }
      for (const item of staged) {
        await this.#fileOperations.rename(item.temporary, item.target);
        installed.push(item.target);
      }
    } catch (error) {
      let rollbackError: unknown;
      for (const target of installed.reverse())
        await this.#fileOperations
          .rm(target, { force: true })
          .catch((cause) => (rollbackError ??= cause));
      for (const item of backups.reverse())
        await this.#fileOperations
          .rename(item.backup, item.target)
          .catch((cause) => (rollbackError ??= cause));
      await Promise.allSettled(
        staged.map((item) => this.#fileOperations.rm(item.temporary, { force: true }))
      );
      for (const directory of createdDirectories.reverse())
        await rmdir(directory).catch(() => undefined);
      if (rollbackError)
        throw new MarAgentError(
          'MAR_AGENT_PATCH_ROLLBACK_FAILED',
          'Patch commit failed and rollback could not restore every file.',
          { cause: rollbackError }
        );
      throw error;
    }
    await Promise.all(backups.map((item) => this.#fileOperations.rm(item.backup, { force: true })));
    for (const mutation of mutations)
      await captureFileChange(mutation.path, mutation.original, mutation.content);
  }
}

function applyHunks(original: Buffer, hunks: Hunk[], path: string) {
  let text: string;
  try {
    text = utf8Decoder.decode(original);
  } catch (cause) {
    throw new MarAgentError('MAR_AGENT_PATCH_CONFLICT', 'Patched files must be valid UTF-8.', {
      cause
    });
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  if (text.replaceAll('\r\n', '').includes('\r'))
    invalid('Patched files contain mixed carriage returns.');
  const normalized = text.replaceAll('\r\n', '\n');
  const finalNewline = normalized.endsWith('\n');
  let lines = (finalNewline ? normalized.slice(0, -1) : normalized).split('\n');
  if (lines.length === 1 && lines[0] === '') lines = [];
  let searchStart = 0;
  for (const [hunkIndex, hunk] of hunks.entries()) {
    if (hunk.changeContext !== undefined) {
      const contextPosition = seekSequence(lines, [hunk.changeContext], searchStart);
      if (contextPosition === undefined)
        throw new MarAgentError(
          'MAR_AGENT_PATCH_CONFLICT',
          `Patch hunk ${hunkIndex + 1} could not find change context in ${path}:\n${summarizePatchLines([hunk.changeContext])}`
        );
      searchStart = contextPosition + 1;
    }
    const position = seekSequence(lines, hunk.oldLines, searchStart);
    if (position === undefined)
      throw new MarAgentError(
        'MAR_AGENT_PATCH_CONFLICT',
        `Patch hunk ${hunkIndex + 1} could not find expected lines in ${path}:\n${summarizePatchLines(hunk.oldLines)}`
      );
    if (hunk.anchor) {
      searchStart = position + hunk.oldLines.length;
      continue;
    }
    const replacement = materializeHunk(lines, position, hunk.patchLines);
    lines.splice(position, hunk.oldLines.length, ...replacement);
    searchStart = position + replacement.length;
  }
  return Buffer.from(`${lines.join(newline)}${finalNewline ? newline : ''}`);
}

function materializeHunk(
  source: readonly string[],
  position: number,
  patchLines: readonly Hunk['patchLines'][number][]
) {
  const replacement: string[] = [];
  let sourceOffset = 0;
  for (const line of patchLines) {
    if (line.kind === 'addition') {
      replacement.push(line.value);
      continue;
    }
    if (line.kind === 'context') replacement.push(source[position + sourceOffset]!);
    sourceOffset++;
  }
  return replacement;
}

function seekSequence(lines: readonly string[], pattern: readonly string[], start: number) {
  if (!pattern.length) return start;
  if (pattern.length > lines.length) return undefined;
  const comparators = [
    (actual: string, expected: string) => actual === expected,
    (actual: string, expected: string) => actual.trimEnd() === expected.trimEnd(),
    (actual: string, expected: string) => actual.trim() === expected.trim(),
    (actual: string, expected: string) =>
      normalizePatchContext(actual) === normalizePatchContext(expected)
  ];
  for (const matches of comparators)
    for (let position = start; position <= lines.length - pattern.length; position++)
      if (pattern.every((line, offset) => matches(lines[position + offset]!, line)))
        return position;
  return undefined;
}

function normalizePatchContext(value: string) {
  return [...value.trim()]
    .map((character) => {
      if ('‐‑‒–—―−'.includes(character)) return '-';
      if ('‘’‚‛'.includes(character)) return "'";
      if ('“”„‟'.includes(character)) return '"';
      if ('            　'.includes(character)) return ' ';
      return character;
    })
    .join('');
}

function summarizePatchLines(lines: readonly string[]) {
  const value = lines.join('\n');
  return value.length <= 1_000 ? value : `${[...value].slice(0, 1_000).join('')}…`;
}

function logicalLineCount(content: Buffer) {
  if (!content.length) return 0;
  const text = content.toString('utf8').replaceAll('\r\n', '\n');
  return text.endsWith('\n') ? text.slice(0, -1).split('\n').length : text.split('\n').length;
}

async function readBoundedFile(path: string) {
  const info = await lstat(path);
  if (info.size > TOOL_EXECUTION_LIMITS.patchMaxFileBytes)
    throw new MarAgentError('MAR_AGENT_TOOL_OUTPUT_LIMIT', 'Patched file exceeds the byte limit.');
  return readFile(path);
}

function enforceContentLimits(content: Buffer, current: number) {
  if (content.byteLength > TOOL_EXECUTION_LIMITS.patchMaxFileBytes)
    throw new MarAgentError('MAR_AGENT_TOOL_OUTPUT_LIMIT', 'Patched file exceeds the byte limit.');
  const total = current + content.byteLength;
  if (total > TOOL_EXECUTION_LIMITS.patchMaxTotalBytes)
    throw new MarAgentError(
      'MAR_AGENT_TOOL_OUTPUT_LIMIT',
      'Patch working set exceeds the byte limit.'
    );
  return total;
}

function partialPatchError(
  cause: unknown,
  appliedResults: readonly ApplyPatchFileResult[],
  pendingChanges: readonly ResolvedChange[]
) {
  const appliedFiles = appliedResults.map(resultPath);
  const failedFile = changePath(pendingChanges[0]!.change);
  const pendingFiles = pendingChanges.slice(1).map(({ change }) => changePath(change));
  return new MarAgentError(
    'MAR_AGENT_PATCH_PARTIAL',
    `Patch partially applied. Applied: ${summarizePaths(appliedFiles)}. Failed: ${failedFile}. Pending: ${summarizePaths(pendingFiles)}. Retry only failed and pending paths.`,
    {
      cause,
      retryable: true,
      details: {
        appliedFiles,
        failedFile,
        pendingFiles,
        files: appliedResults,
        totals: {
          files: appliedResults.length,
          addedLines: appliedResults.reduce((total, file) => total + file.addedLines, 0),
          deletedLines: appliedResults.reduce((total, file) => total + file.deletedLines, 0)
        }
      }
    }
  );
}

function resultPath(result: ApplyPatchFileResult) {
  return result.targetPath === undefined ? result.path : `${result.path} -> ${result.targetPath}`;
}

function changePath(change: Change) {
  return change.kind === 'update' && change.targetPath !== undefined
    ? `${change.path} -> ${change.targetPath}`
    : change.path;
}

function summarizePaths(paths: readonly string[]) {
  if (!paths.length) return '(none)';
  const visible = paths.slice(0, 12);
  const suffix = paths.length > visible.length ? `, … (${paths.length} total)` : '';
  return `${visible.join(', ')}${suffix}`;
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function ensureDirectory(path: string, created: string[]) {
  const missing: string[] = [];
  let current = path;
  const root = parse(path).root;
  while (current !== root && !(await exists(current))) {
    missing.push(current);
    current = dirname(current);
  }
  await mkdir(path, { recursive: true });
  created.push(...missing.reverse());
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function invalid(message: string): never {
  throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', message);
}
