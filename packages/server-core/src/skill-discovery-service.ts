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

/** Owns bounded search caches and in-flight searches; repository reads belong to the Git reader. */
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
    return (await this.gitRepository.discover(locator, query, limit)).map((candidate) => ({
      ...candidate,
      repositoryUrl: locator,
      installs: null
    }));
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
