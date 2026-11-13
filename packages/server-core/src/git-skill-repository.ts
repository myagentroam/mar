import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  finalizeSkillBundle,
  normalizeSkillName,
  parseSkillFrontmatter,
  type ResolvedSkillBundle,
  type SkillBundleFile
} from './skill-bundle.js';
import { assertPublicSkillHost } from './skill-network-policy.js';

const execFileAsync = promisify(execFile);
const GIT_SSH_COMMAND =
  'ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null';

export interface GitSkillCandidate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly skillPath: string;
}

/** Owns complete Git snapshots; discovery and bundles only read locally before cleanup. */
export class GitSkillRepository {
  constructor(
    private readonly tlsVerificationDisabled: () => Promise<boolean> = async () => false
  ) {}

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
      const result: GitSkillCandidate[] = [];
      for (const { skillFile, ...candidate } of candidates) {
        const content = await gitText(repository.directory, ['show', `HEAD:${skillFile}`]);
        const metadata = parseSkillFrontmatter(content);
        result.push({
          ...candidate,
          name: normalizeSkillName(metadata.name),
          description: metadata.description
        });
      }
      return result;
    });
  }

  async resolve(input: {
    readonly repositoryUrl: string;
    readonly skillPath?: string;
    readonly skillName?: string;
  }): Promise<ResolvedSkillBundle> {
    if (input.skillPath !== undefined && input.skillPath !== '.')
      assertSafeRelativePath(input.skillPath);
    return this.withRepository(input.repositoryUrl, async (repository) => {
      const skillPath = resolveSkillPath(repository.files, input.skillPath, input.skillName);
      const selected = repository.files
        .filter((file) => skillPath === '.' || file.path.startsWith(`${skillPath}/`))
        .map((file) => ({
          ...file,
          relativePath: skillPath === '.' ? file.path : file.path.slice(skillPath.length + 1)
        }));
      const files: SkillBundleFile[] = [];
      let contentBytes = 0;
      for (const file of selected) {
        const content = await gitBuffer(repository.directory, ['show', `HEAD:${file.path}`]);
        contentBytes += content.length;
        files.push({ path: file.relativePath, contentBase64: content.toString('base64') });
      }
      return finalizeSkillBundle({
        repositoryIdentity: repository.identity,
        repositoryUrl: input.repositoryUrl,
        skillPath,
        commitSha: repository.commitSha,
        contentBytes,
        tlsVerified: repository.tlsVerified,
        files
      });
    });
  }

  private async withRepository<T>(
    locator: string,
    operation: (repository: GitRepositorySnapshot) => Promise<T>
  ): Promise<T> {
    const parsed = parseLocator(locator);
    const address = await assertPublicSkillHost(parsed.hostname);
    const tlsDisabled = parsed.https ? await this.tlsVerificationDisabled() : undefined;
    const env = gitEnvironment(tlsDisabled);
    const transport = parsed.https
      ? [
          '-c',
          'protocol.allow=never',
          '-c',
          'protocol.https.allow=always',
          '-c',
          'http.followRedirects=false',
          '-c',
          'http.proxy=',
          '-c',
          `http.sslVerify=${!tlsDisabled}`,
          '-c',
          `http.curloptResolve=${parsed.hostname}:${parsed.port}:${address.family === 6 ? `[${address.address}]` : address.address}`
        ]
      : ['-c', 'protocol.file.allow=never'];
    const directory = await mkdtemp(path.join(tmpdir(), 'mar-skill-git-'));
    try {
      await gitText(
        directory,
        [
          ...transport,
          'clone',
          '--depth=1',
          '--no-checkout',
          '--no-tags',
          '--',
          parsed.locator,
          directory
        ],
        1024 * 1024,
        60_000,
        env
      );
      const commitSha = (await gitText(directory, ['rev-parse', 'HEAD'], 1024)).trim();
      if (!/^[0-9a-f]{40}$/u.test(commitSha)) throw new Error('SKILL_VERSION_COMMIT_INVALID');
      const output = await gitBuffer(directory, ['ls-tree', '-r', '-z', 'HEAD']);
      const files = output
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .map(parseTreeLine)
        .filter((file): file is GitTreeFile => file !== undefined);
      return await operation({
        directory,
        commitSha,
        files,
        identity: `${parsed.hostname.toLowerCase()}/${parsed.repositoryPath.toLowerCase()}`,
        name: parsed.repositoryPath.split('/').at(-1)!,
        tlsVerified: parsed.https && !tlsDisabled
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
}
interface GitRepositorySnapshot {
  readonly directory: string;
  readonly commitSha: string;
  readonly files: readonly GitTreeFile[];
  readonly identity: string;
  readonly name: string;
  readonly tlsVerified: boolean;
}

function parseLocator(locator: string): {
  hostname: string;
  repositoryPath: string;
  locator: string;
  https: boolean;
  port: string;
} {
  if (locator.startsWith('https://')) {
    const url = new URL(locator);
    const repositoryPath = url.pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '');
    if (
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      repositoryPath === ''
    )
      throw new Error('SKILL_SOURCE_PROVIDER_UNSUPPORTED');
    return {
      hostname: url.hostname,
      port: url.port || '443',
      repositoryPath,
      locator: url.href,
      https: true
    };
  }
  const match = /^git@([A-Za-z0-9.-]+):([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+?)(?:\.git)?$/u.exec(
    locator
  );
  if (match === null || match[1]!.startsWith('.') || match[1]!.endsWith('.'))
    throw new Error('SKILL_SOURCE_PROVIDER_UNSUPPORTED');
  return {
    hostname: match[1]!,
    repositoryPath: match[2]!.replace(/\.git$/u, ''),
    locator,
    https: false,
    port: '22'
  };
}

function parseTreeLine(line: string): GitTreeFile | undefined {
  const match = /^\d+ (blob|commit) [0-9a-f]{40}\t([\s\S]+)$/u.exec(line);
  if (match === null) throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
  if (match[1] !== 'blob') return undefined;
  const filePath = match[2]!;
  assertSafeRelativePath(filePath);
  return { path: filePath };
}

async function gitText(
  directory: string,
  args: readonly string[],
  maxBuffer = Infinity,
  timeout = 20_000,
  env = gitEnvironment()
): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    env,
    maxBuffer,
    timeout,
    windowsHide: true
  });
  return result.stdout;
}

async function gitBuffer(directory: string, args: readonly string[]): Promise<Buffer> {
  const result = await execFileAsync('git', args, {
    cwd: directory,
    encoding: null,
    env: gitEnvironment(),
    maxBuffer: Infinity,
    timeout: 20_000,
    windowsHide: true
  });
  return result.stdout;
}

function gitEnvironment(tlsDisabled?: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND
  };
  if (tlsDisabled !== undefined) {
    // HTTPS must not inherit URL rewrites, proxy routing, or TLS policy overrides.
    env['GIT_CONFIG_NOSYSTEM'] = '1';
    env['GIT_CONFIG_GLOBAL'] = devNull;
    if (tlsDisabled) env['GIT_SSL_NO_VERIFY'] = 'true';
    else delete env['GIT_SSL_NO_VERIFY'];
    delete env['GIT_CONFIG_COUNT'];
    delete env['GIT_CONFIG_PARAMETERS'];
  }
  return env;
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
