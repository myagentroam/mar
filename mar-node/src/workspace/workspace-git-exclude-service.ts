import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { GitCommandError, resolveWorkspaceGitRoot } from './git.js';

const MAR_TEMP_DIRECTORY = '/.mar/';
const BLOCK_BEGIN = '# BEGIN MyAgentRoam';
const BLOCK_END = '# END MyAgentRoam';
const LEGACY_BLOCK_BEGIN = '# BEGIN MyAgentRoam Skills';
const LEGACY_BLOCK_END = '# END MyAgentRoam Skills';

export async function ensureWorkspaceGitExclude(
  workspace: string,
  includeParentRepository = true
): Promise<void> {
  await mutateGitExclude(workspace, () => undefined, includeParentRepository);
}

export async function updateWorkspaceSkillGitExclude(
  workspace: string,
  name: string,
  add: boolean,
  includeParentRepository = true
): Promise<void> {
  await mutateGitExclude(
    workspace,
    (entries, prefix) => {
      for (const root of ['.agents', '.claude']) {
        const line = `${prefix}${root}/skills/${name}/`;
        if (add) entries.add(line);
        else entries.delete(line);
      }
    },
    includeParentRepository
  );
}

export async function rewriteWorkspaceGitExclude(
  workspace: string,
  names: ReadonlySet<string>,
  includeParentRepository = true
): Promise<void> {
  await mutateGitExclude(
    workspace,
    (entries, prefix) => {
      for (const entry of entries)
        if (['.agents', '.claude'].some((root) => entry.startsWith(`${prefix}${root}/skills/`)))
          entries.delete(entry);
      for (const name of names)
        for (const root of ['.agents', '.claude']) entries.add(`${prefix}${root}/skills/${name}/`);
    },
    includeParentRepository
  );
}

export async function hasBrokenWorkspaceSkillGitExclude(
  workspace: string,
  names: readonly string[],
  includeParentRepository = true
): Promise<boolean> {
  try {
    const target = await gitExcludeTarget(workspace, includeParentRepository);
    if (target === undefined) return false;
    const { exclude, prefix } = target;
    const content = await readFile(exclude, 'utf8');
    return names
      .flatMap((name) => [`${prefix}.agents/skills/${name}/`, `${prefix}.claude/skills/${name}/`])
      .some((entry) => !content.includes(entry));
  } catch {
    return true;
  }
}

const mutationTails = new Map<string, Promise<void>>();

async function gitExcludeTarget(workspace: string, includeParentRepository: boolean) {
  let root: string;
  try {
    root = await resolveWorkspaceGitRoot(workspace, includeParentRepository);
  } catch (error) {
    if (
      (error instanceof GitCommandError && error.code === 128) ||
      (error instanceof Error && error.message === 'WORKSPACE_NOT_GIT') ||
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      return undefined;
    throw error;
  }
  const relative = path
    .relative(root, await realpath(workspace))
    .split(path.sep)
    .join('/');
  const escaped = relative.replace(/[\\*?[\]#! ]/g, '\\$&');
  return { exclude: await resolveGitExclude(root), prefix: relative === '' ? '/' : `/${escaped}/` };
}

async function mutateGitExclude(
  workspace: string,
  mutate: (entries: Set<string>, prefix: string) => void,
  includeParentRepository: boolean
): Promise<void> {
  const target = await gitExcludeTarget(workspace, includeParentRepository);
  if (target === undefined) return;
  const { exclude, prefix } = target;
  const request = (mutationTails.get(exclude) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => writeGitExclude(exclude, (entries) => mutate(entries, prefix)));
  mutationTails.set(exclude, request);
  try {
    await request;
  } finally {
    if (mutationTails.get(exclude) === request) mutationTails.delete(exclude);
  }
}

async function writeGitExclude(
  exclude: string,
  mutate: (entries: Set<string>) => void
): Promise<void> {
  await mkdir(path.dirname(exclude), { recursive: true });
  let content = '';
  try {
    const excludeStat = await lstat(exclude);
    if (!excludeStat.isFile() || excludeStat.isSymbolicLink())
      throw new Error('WORKSPACE_SKILL_GIT_EXCLUDE_FAILED');
    content = await readFile(exclude, 'utf8');
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const pattern = managedBlockPattern();
  const existing = [...content.matchAll(pattern)].map((match) => match[0]).join('\n');
  const entries = new Set(existing.split(/\r?\n/u).filter((line) => line.startsWith('/')));
  entries.delete(MAR_TEMP_DIRECTORY);
  mutate(entries);
  const block =
    entries.size === 0 ? '' : `${BLOCK_BEGIN}\n${[...entries].sort().join('\n')}\n${BLOCK_END}\n`;
  const unmanaged = content.replace(pattern, '');
  const next = block === '' ? unmanaged : unmanaged.replace(/\s*$/u, '\n') + block;
  if (next === content) return;
  const staging = path.join(path.dirname(exclude), `.mar-git-exclude-${randomUUID()}.tmp`);
  try {
    await writeFile(staging, next, { encoding: 'utf8', flag: 'wx' });
    await rename(staging, exclude);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
}

async function resolveGitExclude(workspace: string): Promise<string> {
  try {
    const result = await promisify(execFile)(
      'git',
      ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude', '--git-common-dir'],
      { timeout: 5_000, windowsHide: true }
    );
    const [excludeOutput, commonOutput] = result.stdout.trim().split(/\r?\n/u);
    if (!excludeOutput || !commonOutput) throw new Error();
    const exclude = path.resolve(workspace, excludeOutput);
    const common = path.resolve(workspace, commonOutput);
    const relative = path.relative(common, exclude);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error();
    return exclude;
  } catch {
    throw new Error('WORKSPACE_SKILL_GIT_EXCLUDE_FAILED');
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function managedBlockPattern(): RegExp {
  const current = `${escapeRegExp(BLOCK_BEGIN)}\\r?\\n[\\s\\S]*?${escapeRegExp(BLOCK_END)}(?:\\r?\\n)?`;
  const legacy = `${escapeRegExp(LEGACY_BLOCK_BEGIN)}\\r?\\n[\\s\\S]*?${escapeRegExp(LEGACY_BLOCK_END)}(?:\\r?\\n)?`;
  return new RegExp(`(?:${current}|${legacy})`, 'gu');
}
