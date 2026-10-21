import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const MAR_TEMP_DIRECTORY = '/.mar/';
const BLOCK_BEGIN = '# BEGIN MyAgentRoam';
const BLOCK_END = '# END MyAgentRoam';
const LEGACY_BLOCK_BEGIN = '# BEGIN MyAgentRoam Skills';
const LEGACY_BLOCK_END = '# END MyAgentRoam Skills';

export async function ensureWorkspaceGitExclude(workspace: string): Promise<void> {
  await mutateGitExclude(workspace, () => undefined);
}

export async function updateWorkspaceSkillGitExclude(
  workspace: string,
  name: string,
  add: boolean
): Promise<void> {
  await mutateGitExclude(workspace, (entries) => {
    for (const root of ['.agents', '.claude']) {
      const line = `/${root}/skills/${name}/`;
      if (add) entries.add(line);
      else entries.delete(line);
    }
  });
}

export async function rewriteWorkspaceGitExclude(
  workspace: string,
  names: ReadonlySet<string>
): Promise<void> {
  await mutateGitExclude(workspace, (entries) => {
    entries.clear();
    for (const name of names)
      for (const root of ['.agents', '.claude']) entries.add(`/${root}/skills/${name}/`);
  });
}

export async function hasBrokenWorkspaceSkillGitExclude(
  workspace: string,
  names: readonly string[]
): Promise<boolean> {
  if (!(await exists(path.join(workspace, '.git')))) return false;
  try {
    const exclude = await resolveGitExclude(workspace);
    const content = await readFile(exclude, 'utf8');
    return names
      .flatMap((name) => [`/.agents/skills/${name}/`, `/.claude/skills/${name}/`])
      .some((entry) => !content.includes(entry));
  } catch {
    return true;
  }
}

async function mutateGitExclude(
  workspace: string,
  mutate: (entries: Set<string>) => void
): Promise<void> {
  if (!(await exists(path.join(workspace, '.git')))) return;
  const exclude = await resolveGitExclude(workspace);
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
  const entries = new Set(existing.split(/\r?\n/u).filter((line) => line.startsWith('/.')));
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

async function exists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
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
