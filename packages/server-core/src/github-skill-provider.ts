import { createHash } from 'node:crypto';
import { GitSkillRepository } from './git-skill-repository.js';

const MAX_REPOSITORY_FILES = 5_000;
const MAX_REPOSITORY_BYTES = 100 * 1024 * 1024;
const MAX_SKILL_FILES = 1_000;
const MAX_SKILL_BYTES = 25 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface SkillBundleFile {
  readonly path: string;
  readonly contentBase64: string;
}

export interface ResolvedSkillBundle {
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

export class GithubSkillProvider {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly tlsVerificationDisabled: () => Promise<boolean> = async () => false,
    private readonly gitRepository: GitSkillRepository = new GitSkillRepository()
  ) {}

  async resolve(input: {
    readonly repositoryUrl: string;
    readonly skillPath?: string;
    readonly skillName?: string;
  }): Promise<ResolvedSkillBundle> {
    if (input.skillPath !== undefined) assertSkillPath(input.skillPath);
    if (input.repositoryUrl.startsWith('git@')) return this.gitRepository.resolve(input);
    if (new URL(input.repositoryUrl).hostname.toLowerCase() !== 'github.com')
      return this.resolveGitlab(input);
    const repository = parseGithubRepository(input.repositoryUrl);
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'MyAgentRoam' };
    const metadata = await this.json(
      `https://api.github.com/repos/${repository.owner}/${repository.repo}`,
      headers
    );
    const defaultBranch = textField(metadata, 'default_branch');
    const commit = await this.json(
      `https://api.github.com/repos/${repository.owner}/${repository.repo}/commits/${encodeURIComponent(defaultBranch)}`,
      headers
    );
    const commitSha = textField(commit, 'sha');
    if (!/^[0-9a-f]{40}$/u.test(commitSha)) throw new Error('SKILL_VERSION_COMMIT_INVALID');
    const treePayload = await this.json(
      `https://api.github.com/repos/${repository.owner}/${repository.repo}/git/trees/${commitSha}?recursive=1`,
      headers
    );
    const tree = arrayField(treePayload, 'tree');
    if (tree.length > MAX_REPOSITORY_FILES) throw new Error('SKILL_SOURCE_LIMIT_EXCEEDED');
    const blobs = tree
      .map(treeBlob)
      .filter((entry): entry is { path: string; sha: string; size: number } => entry !== undefined);
    if (blobs.reduce((total, file) => total + file.size, 0) > MAX_REPOSITORY_BYTES)
      throw new Error('SKILL_SOURCE_LIMIT_EXCEEDED');
    const skillPath = resolveSkillPath(blobs, input.skillPath, input.skillName);
    const selected = blobs
      .filter((entry) => skillPath === '.' || entry.path.startsWith(`${skillPath}/`))
      .map((entry) => ({
        ...entry,
        relativePath: skillPath === '.' ? entry.path : entry.path.slice(skillPath.length + 1)
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
      const blob = await this.json(
        `https://api.github.com/repos/${repository.owner}/${repository.repo}/git/blobs/${file.sha}`,
        headers
      );
      if (blob['encoding'] !== 'base64') throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
      const encoded = textField(blob, 'content').replace(/\s/gu, '');
      const content = Buffer.from(encoded, 'base64');
      if (content.length !== file.size) throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
      contentBytes += content.length;
      files.push({ path: file.relativePath, contentBase64: content.toString('base64') });
    }
    const skillFile = files.find((file) => file.path === 'SKILL.md');
    if (skillFile === undefined) throw new Error('SKILL_CONTENT_INVALID');
    if (files.some((file) => file.path === '.mar-skill-install.json'))
      throw new Error('SKILL_CONTENT_INVALID');
    const metadataFields = parseFrontmatter(
      Buffer.from(skillFile.contentBase64, 'base64').toString('utf8')
    );
    const normalizedName = normalizeSkillName(metadataFields.name);
    const canonicalFiles = files.map((file) => `${file.path}\0${file.contentBase64}`).join('\0');
    const contentHash = createHash('sha256').update(canonicalFiles).digest('hex');
    const bundleJson = JSON.stringify({ schemaVersion: 1, files });
    return {
      repositoryIdentity: `github.com/${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}`,
      repositoryUrl: `https://github.com/${repository.owner}/${repository.repo}`,
      skillPath,
      name: normalizedName,
      description: metadataFields.description,
      commitSha,
      contentHash,
      archiveHash: createHash('sha256').update(bundleJson).digest('hex'),
      contentBytes,
      tlsVerified: !(await this.tlsVerificationDisabled()),
      files
    };
  }

  private async resolveGitlab(input: {
    readonly repositoryUrl: string;
    readonly skillPath?: string;
    readonly skillName?: string;
  }): Promise<ResolvedSkillBundle> {
    const repository = parseGitlabRepository(input.repositoryUrl);
    const headers = { accept: 'application/json', 'user-agent': 'MyAgentRoam' };
    const projectKey = encodeURIComponent(repository.projectPath);
    const metadata = await this.json(`${repository.origin}/api/v4/projects/${projectKey}`, headers);
    const defaultBranch = textField(metadata, 'default_branch');
    const commit = await this.json(
      `${repository.origin}/api/v4/projects/${projectKey}/repository/commits/${encodeURIComponent(defaultBranch)}`,
      headers
    );
    const commitSha = textField(commit, 'id');
    if (!/^[0-9a-f]{40}$/u.test(commitSha)) throw new Error('SKILL_VERSION_COMMIT_INVALID');
    const tree: unknown[] = [];
    for (let page = 1; page <= 51; page += 1) {
      const result = await this.arrayJson(
        `${repository.origin}/api/v4/projects/${projectKey}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${commitSha}`,
        headers
      );
      tree.push(...result);
      if (tree.length > MAX_REPOSITORY_FILES) throw new Error('SKILL_SOURCE_LIMIT_EXCEEDED');
      if (result.length < 100) break;
    }
    const blobs = tree
      .map(gitlabTreeBlob)
      .filter((entry): entry is { path: string; sha: string; size: number } => entry !== undefined);
    const skillPath = resolveSkillPath(blobs, input.skillPath, input.skillName);
    const selected = blobs
      .filter((entry) => skillPath === '.' || entry.path.startsWith(`${skillPath}/`))
      .map((entry) => ({
        ...entry,
        relativePath: skillPath === '.' ? entry.path : entry.path.slice(skillPath.length + 1)
      }));
    if (selected.length === 0 || selected.length > MAX_SKILL_FILES)
      throw new Error('SKILL_SOURCE_LIMIT_EXCEEDED');
    const files: SkillBundleFile[] = [];
    let contentBytes = 0;
    for (const file of selected.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath)
    )) {
      assertSafeRelativePath(file.relativePath);
      const blob = await this.json(
        `${repository.origin}/api/v4/projects/${projectKey}/repository/blobs/${file.sha}`,
        headers
      );
      if (blob['encoding'] !== 'base64') throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
      const declaredSize = Number(blob['size']);
      const content = Buffer.from(textField(blob, 'content').replace(/\s/gu, ''), 'base64');
      if (!Number.isSafeInteger(declaredSize) || declaredSize !== content.length)
        throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
      if (content.length > MAX_FILE_BYTES) throw new Error('SKILL_SOURCE_LIMIT_EXCEEDED');
      contentBytes += content.length;
      if (contentBytes > MAX_SKILL_BYTES) throw new Error('SKILL_SOURCE_LIMIT_EXCEEDED');
      files.push({ path: file.relativePath, contentBase64: content.toString('base64') });
    }
    return finalizeBundle({
      repositoryIdentity: `${new URL(repository.origin).hostname.toLowerCase()}/${repository.projectPath.toLowerCase()}`,
      repositoryUrl: `${repository.origin}/${repository.projectPath}`,
      skillPath,
      commitSha,
      contentBytes,
      tlsVerified: !(await this.tlsVerificationDisabled()),
      files
    });
  }

  private async json(
    url: string,
    headers: Readonly<Record<string, string>>
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (response.status === 403 || response.status === 429)
      throw new Error('SKILL_SOURCE_RATE_LIMITED');
    if (!response.ok) throw new Error('SKILL_SOURCE_UNAVAILABLE');
    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
    return payload as Record<string, unknown>;
  }

  private async arrayJson(
    url: string,
    headers: Readonly<Record<string, string>>
  ): Promise<readonly unknown[]> {
    const response = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (response.status === 403 || response.status === 429)
      throw new Error('SKILL_SOURCE_RATE_LIMITED');
    if (!response.ok) throw new Error('SKILL_SOURCE_UNAVAILABLE');
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
    return payload;
  }
}

function parseGitlabRepository(locator: string): {
  origin: string;
  projectPath: string;
} {
  const url = new URL(locator);
  const parts = url.pathname.replace(/^\/+|\/+$/gu, '').split('/');
  const marker = parts.indexOf('-');
  const projectParts = (marker < 0 ? parts : parts.slice(0, marker)).filter(Boolean);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    projectParts.length < 2 ||
    projectParts.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part))
  )
    throw new Error('SKILL_SOURCE_PROVIDER_UNSUPPORTED');
  projectParts[projectParts.length - 1] = projectParts.at(-1)!.replace(/\.git$/u, '');
  return { origin: url.origin, projectPath: projectParts.join('/') };
}

function gitlabTreeBlob(value: unknown): { path: string; sha: string; size: number } | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (
    row['type'] !== 'blob' ||
    typeof row['path'] !== 'string' ||
    typeof row['id'] !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(row['id'])
  )
    return undefined;
  return { path: row['path'], sha: row['id'], size: 0 };
}

function finalizeBundle(input: {
  repositoryIdentity: string;
  repositoryUrl: string;
  skillPath: string;
  commitSha: string;
  contentBytes: number;
  tlsVerified: boolean;
  files: readonly SkillBundleFile[];
}): ResolvedSkillBundle {
  const skillFile = input.files.find((file) => file.path === 'SKILL.md');
  if (
    skillFile === undefined ||
    input.files.some((file) => file.path === '.mar-skill-install.json')
  )
    throw new Error('SKILL_CONTENT_INVALID');
  const metadataFields = parseFrontmatter(
    Buffer.from(skillFile.contentBase64, 'base64').toString('utf8')
  );
  const canonicalFiles = input.files
    .map((file) => `${file.path}\0${file.contentBase64}`)
    .join('\0');
  const contentHash = createHash('sha256').update(canonicalFiles).digest('hex');
  return {
    ...input,
    name: normalizeSkillName(metadataFields.name),
    description: metadataFields.description,
    contentHash,
    archiveHash: createHash('sha256')
      .update(JSON.stringify({ schemaVersion: 1, files: input.files }))
      .digest('hex')
  };
}

function parseGithubRepository(locator: string): { owner: string; repo: string } {
  const url = new URL(locator);
  const parts = url.pathname.replace(/^\/+|\/+$/gu, '').split('/');
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    parts.length < 2 ||
    !/^[A-Za-z0-9_.-]+$/u.test(parts[0]!) ||
    !/^[A-Za-z0-9_.-]+(?:\.git)?$/u.test(parts[1]!)
  )
    throw new Error('SKILL_SOURCE_PROVIDER_UNSUPPORTED');
  return { owner: parts[0]!, repo: parts[1]!.replace(/\.git$/u, '') };
}

function treeBlob(value: unknown): { path: string; sha: string; size: number } | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (row['type'] !== 'blob' || typeof row['path'] !== 'string' || typeof row['sha'] !== 'string')
    return undefined;
  const size = Number(row['size']);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
  return { path: row['path'], sha: row['sha'], size };
}

function resolveSkillPath(
  blobs: readonly { path: string }[],
  requestedPath?: string,
  requestedName?: string
): string {
  const skillFiles = blobs
    .map((entry) => entry.path)
    .filter((path) => path === 'SKILL.md' || path.endsWith('/SKILL.md'));
  if (requestedPath !== undefined) {
    assertSkillPath(requestedPath);
    const skillFile = requestedPath === '.' ? 'SKILL.md' : `${requestedPath}/SKILL.md`;
    if (!skillFiles.includes(skillFile)) throw new Error('SKILL_CONTENT_INVALID');
    return requestedPath;
  }
  if (requestedName === undefined) throw new Error('SKILL_CONTENT_INVALID');
  const matches = skillFiles.filter((file) => file.split('/').at(-2) === requestedName);
  if (matches.length === 0 && skillFiles.includes('SKILL.md')) return '.';
  if (matches.length !== 1) throw new Error('SKILL_CONTENT_INVALID');
  return matches[0]!.slice(0, -'/SKILL.md'.length);
}

function assertSkillPath(value: string): void {
  if (value !== '.') assertSafeRelativePath(value);
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
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(normalized) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u.test(normalized) ||
    normalized.length > 128
  )
    throw new Error('SKILL_CONTENT_INVALID');
  return normalized;
}

function textField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== 'string') throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
  return result;
}

function arrayField(value: Record<string, unknown>, field: string): readonly unknown[] {
  const result = value[field];
  if (!Array.isArray(result)) throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
  return result;
}
