import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { assertPublicSkillHost } from './skill-network-policy.js';

const execFileAsync = promisify(execFile);
const MAX_REPOSITORY_FILES = 5_000;
const MAX_REPOSITORY_BYTES = 100 * 1024 * 1024;
const MAX_SKILL_FILES = 1_000;
const MAX_SKILL_BYTES = 25 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const GIT_SSH_COMMAND =
  'ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null';

export interface GitSkillCandidate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly skillPath: string;
}

interface SkillBundleFile {
  readonly path: string;
  readonly contentBase64: string;
}
interface GitResolvedSkillBundle {
  readonly repositoryIdentity: string;
  readonly repositoryUrl: string;
  readonly skillPath: string;
  readonly name: string;
  readonly description: string;
  readonly commitSha: string;
  readonly contentHash: string;
  readonly archiveHash: string;
  readonly contentBytes: number;
  readonly tlsVerified: boolean;
  readonly files: readonly SkillBundleFile[];
}

export class GitSkillRepository {
  async discover(
    locator: string,
    query: string,
    limit: number
  ): Promise<readonly GitSkillCandidate[]> {
    return this.withRepository(locator, async (repository) => {
      const skillFiles = repository.files.map((file) => file.path).filter(isDiscoverableSkillPath);
      const candidates = skillFiles
        .map((skillFile) => {
          const skillPath =
            skillFile === 'SKILL.md' ? '.' : skillFile.slice(0, -'/SKILL.md'.length);
          const name = skillPath === '.' ? repository.name : skillPath.split('/').at(-1)!;
          return {
            id: `${repository.identity}/${skillPath}`,
            name,
            skillFile,
            source: repository.identity,
            skillPath
          };
        })
        .filter((candidate) =>
          query === ''
            ? true
            : `${candidate.name} ${candidate.skillPath}`.toLowerCase().includes(query.toLowerCase())
        )
        .slice(0, limit);
      return Promise.all(
        candidates.map(async ({ skillFile, ...candidate }) => {
          const content = await gitText(
            repository.directory,
            ['show', `HEAD:${skillFile}`],
            MAX_FILE_BYTES
          );
          const metadata = parseFrontmatter(content);
          return {
            ...candidate,
            name: normalizeSkillName(metadata.name),
            description: metadata.description
          };
        })
      );
    });
  }

  async resolve(input: {
    readonly repositoryUrl: string;
    readonly skillPath?: string;
    readonly skillName?: string;
  }): Promise<GitResolvedSkillBundle> {
    return this.withRepository(input.repositoryUrl, async (repository) => {
      const skillPath = resolveSkillPath(repository.files, input.skillPath, input.skillName);
      const selected = repository.files
        .filter((file) => skillPath === '.' || file.path.startsWith(`${skillPath}/`))
        .map((file) => ({
          ...file,
          relativePath: skillPath === '.' ? file.path : file.path.slice(skillPath.length + 1)
        }));
      if (selected.length === 0 || selected.length > MAX_SKILL_FILES)
        throw new Error('SKILL_SOURCE_LIMIT_EXCEEDED');
      if (selected.reduce((total, file) => total + file.size, 0) > MAX_SKILL_BYTES)
        throw new Error('SKILL_SOURCE_LIMIT_EXCEEDED');
      const files: SkillBundleFile[] = [];
      let contentBytes = 0;
      for (const file of selected.sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath)
      )) {
        assertSafeRelativePath(file.relativePath);
        if (file.size > MAX_FILE_BYTES) throw new Error('SKILL_SOURCE_LIMIT_EXCEEDED');
        const content = await gitBuffer(
          repository.directory,
          ['show', `HEAD:${file.path}`],
          MAX_FILE_BYTES
        );
        if (content.length !== file.size) throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
        contentBytes += content.length;
        files.push({ path: file.relativePath, contentBase64: content.toString('base64') });
      }
      return finalizeBundle({
        repositoryIdentity: repository.identity,
        repositoryUrl: input.repositoryUrl,
        skillPath,
        commitSha: repository.commitSha,
        contentBytes,
        tlsVerified: false,
        files
      });
    });
  }

  private async withRepository<T>(
    locator: string,
    operation: (repository: GitRepositorySnapshot) => Promise<T>
  ): Promise<T> {
    const parsed = parseSshLocator(locator);
    await assertPublicSkillHost(parsed.hostname);
    const directory = await mkdtemp(path.join(tmpdir(), 'mar-skill-git-'));
    try {
      await gitText(
        process.cwd(),
        [
          '-c',
          'protocol.file.allow=never',
          'clone',
          '--depth=1',
          '--filter=blob:none',
          '--no-checkout',
          '--no-tags',
          '--',
          locator,
          directory
        ],
        1024 * 1024,
        60_000
      );
      const commitSha = (await gitText(directory, ['rev-parse', 'HEAD'], 1024)).trim();
      if (!/^[0-9a-f]{40}$/u.test(commitSha)) throw new Error('SKILL_VERSION_COMMIT_INVALID');
      const output = await gitBuffer(
        directory,
        ['ls-tree', '-r', '-l', '-z', 'HEAD'],
        5 * 1024 * 1024
      );
      const files = output
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .map(parseTreeLine)
        .filter((file): file is GitTreeFile => file !== undefined);
      if (
        files.length > MAX_REPOSITORY_FILES ||
        files.reduce((sum, file) => sum + file.size, 0) > MAX_REPOSITORY_BYTES
      )
        throw new Error('SKILL_SOURCE_LIMIT_EXCEEDED');
      return await operation({
        directory,
        commitSha,
        files,
        identity: `${parsed.hostname.toLowerCase()}/${parsed.repositoryPath.toLowerCase()}`,
        name: parsed.repositoryPath.split('/').at(-1)!
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('SKILL_')) throw error;
      throw new Error('SKILL_SOURCE_UNAVAILABLE');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

interface GitTreeFile {
  readonly path: string;
  readonly size: number;
}
interface GitRepositorySnapshot {
  readonly directory: string;
  readonly commitSha: string;
  readonly files: readonly GitTreeFile[];
  readonly identity: string;
  readonly name: string;
}

function parseSshLocator(locator: string): { hostname: string; repositoryPath: string } {
  const match = /^git@([A-Za-z0-9.-]+):([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+?)(?:\.git)?$/u.exec(
    locator
  );
  if (match === null || match[1]!.startsWith('.') || match[1]!.endsWith('.'))
    throw new Error('SKILL_SOURCE_PROVIDER_UNSUPPORTED');
  return { hostname: match[1]!, repositoryPath: match[2]!.replace(/\.git$/u, '') };
}

function parseTreeLine(line: string): GitTreeFile | undefined {
  const match = /^\d+ (blob|commit) [0-9a-f]{40}\s+(\d+|-)\t([\s\S]+)$/u.exec(line);
  if (match === null) throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
  if (match[1] !== 'blob') return undefined;
  const size = Number(match[2]);
  const filePath = match[3]!;
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
  assertSafeRelativePath(filePath);
  return { path: filePath, size };
}

async function gitText(
  directory: string,
  args: readonly string[],
  maxBuffer: number,
  timeout = 20_000
): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    env: gitEnvironment(),
    maxBuffer,
    timeout,
    windowsHide: true
  });
  return result.stdout;
}

async function gitBuffer(
  directory: string,
  args: readonly string[],
  maxBuffer: number
): Promise<Buffer> {
  const result = await execFileAsync('git', args, {
    cwd: directory,
    encoding: null,
    env: gitEnvironment(),
    maxBuffer,
    timeout: 20_000,
    windowsHide: true
  });
  return result.stdout;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND
  };
}

function resolveSkillPath(
  files: readonly GitTreeFile[],
  requestedPath?: string,
  requestedName?: string
): string {
  const skillFiles = files
    .map((file) => file.path)
    .filter((file) => file === 'SKILL.md' || file.endsWith('/SKILL.md'));
  if (requestedPath !== undefined) {
    if (requestedPath !== '.') assertSafeRelativePath(requestedPath);
    if (!skillFiles.includes(requestedPath === '.' ? 'SKILL.md' : `${requestedPath}/SKILL.md`))
      throw new Error('SKILL_CONTENT_INVALID');
    return requestedPath;
  }
  if (requestedName === undefined) throw new Error('SKILL_CONTENT_INVALID');
  const matches = skillFiles.filter((file) => file.split('/').at(-2) === requestedName);
  if (matches.length === 0 && skillFiles.includes('SKILL.md')) return '.';
  if (matches.length !== 1) throw new Error('SKILL_CONTENT_INVALID');
  return matches[0]!.slice(0, -'/SKILL.md'.length);
}

function assertSafeRelativePath(value: string): void {
  if (
    value === '' ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new Error('SKILL_PATH_UNSAFE');
}

function isDiscoverableSkillPath(skillFile: string): boolean {
  if (skillFile === 'SKILL.md') return true;
  if (!skillFile.endsWith('/SKILL.md')) return false;
  const parts = skillFile.split('/');
  if (parts.length === 2) return true;
  return ['skills', '.agents/skills', '.claude/skills'].some((root) =>
    skillFile.startsWith(`${root}/`)
  );
}

function finalizeBundle(input: {
  repositoryIdentity: string;
  repositoryUrl: string;
  skillPath: string;
  commitSha: string;
  contentBytes: number;
  tlsVerified: boolean;
  files: readonly SkillBundleFile[];
}): GitResolvedSkillBundle {
  const skillFile = input.files.find((file) => file.path === 'SKILL.md');
  if (
    skillFile === undefined ||
    input.files.some((file) => file.path === '.mar-skill-install.json')
  )
    throw new Error('SKILL_CONTENT_INVALID');
  const metadata = parseFrontmatter(
    Buffer.from(skillFile.contentBase64, 'base64').toString('utf8')
  );
  const canonicalFiles = input.files
    .map((file) => `${file.path}\0${file.contentBase64}`)
    .join('\0');
  const contentHash = createHash('sha256').update(canonicalFiles).digest('hex');
  return {
    ...input,
    name: normalizeSkillName(metadata.name),
    description: metadata.description,
    contentHash,
    archiveHash: createHash('sha256')
      .update(JSON.stringify({ schemaVersion: 1, files: input.files }))
      .digest('hex')
  };
}

function parseFrontmatter(content: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (match === null) throw new Error('SKILL_CONTENT_INVALID');
  const values = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/u)) {
    const field = /^(name|description):\s*(.*?)\s*$/u.exec(line);
    if (field !== null) values.set(field[1]!, field[2]!.replace(/^['"]|['"]$/gu, ''));
  }
  const name = values.get('name');
  const description = values.get('description');
  if (name === undefined || description === undefined || description.length > 4096)
    throw new Error('SKILL_CONTENT_INVALID');
  return { name, description };
}

function normalizeSkillName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(normalized)) throw new Error('SKILL_CONTENT_INVALID');
  return normalized;
}
