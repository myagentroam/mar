import type { VisibleSkillSource } from './skill-source-service.js';
import { GitSkillRepository } from './git-skill-repository.js';

export interface SkillCandidate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly repositoryUrl: string;
  readonly skillPath: string | null;
  readonly installs: number | null;
}

export class SkillDiscoveryService {
  private readonly searchCache = new Map<
    string,
    { readonly expiresAt: number; readonly candidates: readonly SkillCandidate[] }
  >();
  private readonly pendingSearches = new Map<string, Promise<readonly SkillCandidate[]>>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly gitRepository: GitSkillRepository = new GitSkillRepository(),
    private readonly now: () => number = Date.now
  ) {}

  async search(
    source: VisibleSkillSource,
    query: string,
    limit = 40
  ): Promise<readonly SkillCandidate[]> {
    const normalized = query.trim();
    if (normalized.length > 200 || limit < 1 || limit > 100)
      throw new Error('SKILL_SOURCE_QUERY_INVALID');
    const cacheKey = `${source.kind}\0${source.locator}\0${normalized.toLowerCase()}\0${limit}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.candidates;
    const pending = this.pendingSearches.get(cacheKey);
    if (pending !== undefined) return pending;
    const discovery =
      source.kind === 'SKILLS_SH'
        ? normalized === ''
          ? this.loadSkillsShHot(limit)
          : this.searchSkillsSh(normalized, limit)
        : this.searchRepository(source.locator, normalized, limit);
    const request = discovery.then((result) => {
      const candidates = result ?? [];
      if (result === undefined) return candidates;
      if (this.searchCache.size >= 200)
        this.searchCache.delete(this.searchCache.keys().next().value!);
      const ttl = source.kind === 'SKILLS_SH' && normalized === '' ? 24 * 60 * 60_000 : 60_000;
      this.searchCache.set(cacheKey, { expiresAt: this.now() + ttl, candidates });
      return candidates;
    });
    this.pendingSearches.set(cacheKey, request);
    try {
      return await request;
    } finally {
      this.pendingSearches.delete(cacheKey);
    }
  }

  private async searchSkillsSh(query: string, limit: number): Promise<readonly SkillCandidate[]> {
    if (query.length < 2) return [];
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    const response = await this.fetchImpl(`https://skills.sh/api/search?${params}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000)
    });
    if (response.status === 429) throw new Error('SKILL_SOURCE_RATE_LIMITED');
    if (!response.ok) throw new Error('SKILL_SOURCE_UNAVAILABLE');
    const payload = (await response.json()) as { readonly skills?: unknown };
    if (!Array.isArray(payload.skills)) throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
    return payload.skills
      .map((raw) => skillsShCandidate(raw))
      .filter((candidate): candidate is SkillCandidate => candidate !== undefined)
      .slice(0, limit);
  }

  private async loadSkillsShHot(limit: number): Promise<readonly SkillCandidate[] | undefined> {
    try {
      const response = await this.fetchImpl('https://skills.sh/api/skills/hot/0', {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) return undefined;
      const payload = (await response.json()) as { readonly skills?: unknown };
      if (!Array.isArray(payload.skills)) return undefined;
      return payload.skills
        .map((raw) => skillsShCandidate(raw))
        .filter((candidate): candidate is SkillCandidate => candidate !== undefined)
        .slice(0, limit);
    } catch {
      return undefined;
    }
  }

  private async searchRepository(
    locator: string,
    query: string,
    limit: number
  ): Promise<readonly SkillCandidate[]> {
    if (locator.startsWith('git@')) {
      return (await this.gitRepository.discover(locator, query, limit)).map((candidate) => ({
        ...candidate,
        repositoryUrl: locator,
        installs: null
      }));
    }
    if (new URL(locator).hostname.toLowerCase() !== 'github.com')
      return this.searchGitlabRepository(locator, query, limit);
    const repository = githubRepository(locator);
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'MyAgentRoam' };
    const metadata = await this.fetchImpl(
      `https://api.github.com/repos/${repository.owner}/${repository.repo}`,
      { headers, signal: AbortSignal.timeout(10_000) }
    );
    if (!metadata.ok) throw new Error('SKILL_SOURCE_UNAVAILABLE');
    const repo = (await metadata.json()) as { readonly default_branch?: unknown };
    if (typeof repo.default_branch !== 'string') throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
    const treeResponse = await this.fetchImpl(
      `https://api.github.com/repos/${repository.owner}/${repository.repo}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`,
      { headers, signal: AbortSignal.timeout(20_000) }
    );
    if (!treeResponse.ok) throw new Error('SKILL_SOURCE_UNAVAILABLE');
    const treePayload = (await treeResponse.json()) as { readonly tree?: unknown };
    if (!Array.isArray(treePayload.tree)) throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
    const paths = treePayload.tree
      .map((entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        (entry as Record<string, unknown>)['type'] === 'blob' &&
        typeof (entry as Record<string, unknown>)['path'] === 'string'
          ? String((entry as Record<string, unknown>)['path'])
          : undefined
      )
      .filter((path): path is string => path !== undefined && isDiscoverableSkillPath(path));
    const candidates: SkillCandidate[] = [];
    for (const skillFile of paths.slice(0, 500)) {
      const skillPath = skillFile === 'SKILL.md' ? '.' : skillFile.slice(0, -'/SKILL.md'.length);
      const name = skillPath === '.' ? repository.repo : skillPath.split('/').at(-1)!;
      if (query !== '' && !`${name} ${skillPath}`.toLowerCase().includes(query.toLowerCase()))
        continue;
      candidates.push({
        id: `${repository.owner}/${repository.repo}/${skillPath}`,
        name,
        description: '',
        source: `${repository.owner}/${repository.repo}`,
        repositoryUrl: `https://github.com/${repository.owner}/${repository.repo}`,
        skillPath,
        installs: null
      });
      if (candidates.length === limit) break;
    }
    return candidates;
  }

  private async searchGitlabRepository(
    locator: string,
    query: string,
    limit: number
  ): Promise<readonly SkillCandidate[]> {
    const repository = gitlabRepository(locator);
    const projectKey = encodeURIComponent(repository.projectPath);
    const headers = { accept: 'application/json', 'user-agent': 'MyAgentRoam' };
    const metadata = await this.fetchImpl(`${repository.origin}/api/v4/projects/${projectKey}`, {
      headers,
      signal: AbortSignal.timeout(10_000)
    });
    if (!metadata.ok) throw new Error('SKILL_SOURCE_UNAVAILABLE');
    const project = (await metadata.json()) as { readonly default_branch?: unknown };
    if (typeof project.default_branch !== 'string')
      throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
    const entries: unknown[] = [];
    for (let page = 1; page <= 6; page += 1) {
      const response = await this.fetchImpl(
        `${repository.origin}/api/v4/projects/${projectKey}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(project.default_branch)}`,
        { headers, signal: AbortSignal.timeout(20_000) }
      );
      if (!response.ok) throw new Error('SKILL_SOURCE_UNAVAILABLE');
      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
      entries.push(...payload);
      if (payload.length < 100) break;
    }
    const paths = entries
      .map((entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        (entry as Record<string, unknown>)['type'] === 'blob' &&
        typeof (entry as Record<string, unknown>)['path'] === 'string'
          ? String((entry as Record<string, unknown>)['path'])
          : undefined
      )
      .filter((path): path is string => path !== undefined && isDiscoverableSkillPath(path));
    return paths
      .map((skillFile) => {
        const skillPath = skillFile === 'SKILL.md' ? '.' : skillFile.slice(0, -'/SKILL.md'.length);
        const name =
          skillPath === '.'
            ? repository.projectPath.split('/').at(-1)!
            : skillPath.split('/').at(-1)!;
        return {
          id: `${repository.projectPath}/${skillPath}`,
          name,
          description: '',
          source: `${new URL(repository.origin).hostname}/${repository.projectPath}`,
          repositoryUrl: `${repository.origin}/${repository.projectPath}`,
          skillPath,
          installs: null
        } satisfies SkillCandidate;
      })
      .filter((candidate) =>
        query === ''
          ? true
          : `${candidate.name} ${candidate.skillPath}`.toLowerCase().includes(query.toLowerCase())
      )
      .slice(0, limit);
  }
}

function skillsShCandidate(raw: unknown): SkillCandidate | undefined {
  if (raw === null || typeof raw !== 'object') throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
  const value = raw as Record<string, unknown>;
  if (typeof value['name'] !== 'string' || typeof value['source'] !== 'string')
    throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
  const sourceParts = value['source'].split('/');
  if (sourceParts.length !== 2) return undefined;
  const id =
    typeof value['id'] === 'string'
      ? value['id']
      : typeof value['skillId'] === 'string'
        ? `${value['source']}/${value['skillId']}`
        : undefined;
  if (id === undefined) throw new Error('SKILL_SOURCE_RESPONSE_INVALID');
  return {
    id: id.slice(0, 1024),
    name: value['name'].slice(0, 128),
    description: '',
    source: value['source'].slice(0, 512),
    repositoryUrl: `https://github.com/${value['source']}`,
    skillPath: null,
    installs:
      typeof value['installs'] === 'number' && Number.isSafeInteger(value['installs'])
        ? value['installs']
        : null
  };
}

function githubRepository(locator: string): { owner: string; repo: string } {
  const url = new URL(locator);
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com')
    throw new Error('SKILL_SOURCE_PROVIDER_UNSUPPORTED');
  const parts = url.pathname.replace(/^\/+|\/+$/gu, '').split('/');
  if (
    parts.length < 2 ||
    !/^[A-Za-z0-9_.-]+$/u.test(parts[0]!) ||
    !/^[A-Za-z0-9_.-]+$/u.test(parts[1]!)
  )
    throw new Error('SKILL_SOURCE_PROVIDER_UNSUPPORTED');
  return { owner: parts[0]!, repo: parts[1]!.replace(/\.git$/u, '') };
}

function gitlabRepository(locator: string): { origin: string; projectPath: string } {
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

function isDiscoverableSkillPath(skillFile: string): boolean {
  if (skillFile === 'SKILL.md') return true;
  if (!skillFile.endsWith('/SKILL.md')) return false;
  const parts = skillFile.split('/');
  if (parts.length === 2) return true;
  return ['skills', '.agents/skills', '.claude/skills'].some((root) =>
    skillFile.startsWith(`${root}/`)
  );
}
