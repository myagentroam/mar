import { beforeEach, describe, expect, it, vi } from 'vitest';
import { skillErrorMessage } from '../../src/util/skill-errors.js';
import { i18n } from '../../src/service/LocalePreferenceService.js';
import { createSkillCenterService } from '../../src/service/SkillCenterService.js';

const candidate = {
  id: 'candidate',
  name: 'Example',
  description: 'Example skill',
  source: 'source',
  skillPath: 'skills/example',
  installs: null
};

describe('public Skill catalog client', () => {
  it('creates personal catalog entries and refreshes without querying organizations', async () => {
    const request = vi.fn(async (path: string) => {
      if (path === '/api/skill-sources') return { sources: [] };
      if (path.startsWith('/api/skill-favorites'))
        return { favorites: [], page: 1, pageSize: 20, total: 0, hasMore: false };
      throw new Error(`Unexpected request: ${path}`);
    });
    const service = createSkillCenterService(request as never);
    service.selectedSourceId.value = 'source';
    await service.favorite(candidate, { featured: true, tags: ['tools'] });
    expect(request).toHaveBeenCalledWith('/api/skill-favorites', {
      method: 'POST',
      body: JSON.stringify({
        sourceId: 'source',
        candidateId: 'candidate',
        skillPath: 'skills/example',
        featured: true,
        tags: ['tools'],
        scope: 'PERSONAL'
      })
    });
    expect(service.loading.value).toBe(false);
    expect(request.mock.calls.every(([path]) => path !== '/api/organizations')).toBe(true);
  });

  it('passes opaque catalog write context to the host and releases loading after rejection', async () => {
    const submitFavorite = vi.fn(async () => {
      throw new Error('DENIED');
    });
    const service = createSkillCenterService<string, { target: number }>(vi.fn() as never, {
      submitFavorite
    });
    service.selectedSourceId.value = 'source';
    await expect(
      service.favorite(candidate, { featured: false, tags: [] }, { target: 3 })
    ).rejects.toThrow('DENIED');
    expect(submitFavorite).toHaveBeenCalledWith(
      {
        sourceId: 'source',
        candidateId: 'candidate',
        skillPath: 'skills/example',
        featured: false,
        tags: []
      },
      { target: 3 }
    );
    expect(service.loading.value).toBe(false);
  });

  it('ignores an inspection response after the selected target is cleared', async () => {
    let resolve!: (value: unknown) => void;
    const service = createSkillCenterService(
      <T>() =>
        new Promise<T>((done) => {
          resolve = done as (value: unknown) => void;
        })
    );
    const pending = service.inspectTarget('node-a');
    service.clearTarget();
    resolve({ targetKind: 'NODE', skills: [] });
    await pending;
    expect(service.target.value).toBeUndefined();
    expect(service.targetLoading.value).toBe(false);
  });
});

describe('Skill catalog and installation lifecycle', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'zh-CN';
  });
  it('keeps loading until parallel loads finish and hides internal error codes', async () => {
    let resolveSources!: (value: { sources: [] }) => void;
    let resolveCatalog!: (value: {
      favorites: [];
      page: 1;
      pageSize: 20;
      total: 0;
      hasMore: false;
    }) => void;
    const sources = new Promise<{ sources: [] }>((resolve) => (resolveSources = resolve));
    const catalog = new Promise<{ favorites: []; page: 1; pageSize: 20; total: 0; hasMore: false }>(
      (resolve) => (resolveCatalog = resolve)
    );
    const service = createSkillCenterService(
      (path) => (path === '/api/skill-sources' ? sources : catalog) as Promise<never>
    );
    const sourceLoad = service.loadSources();
    const catalogLoad = service.loadCatalog();
    expect(service.loading.value).toBe(true);
    resolveSources({ sources: [] });
    await sourceLoad;
    expect(service.loading.value).toBe(true);
    resolveCatalog({ favorites: [], page: 1, pageSize: 20, total: 0, hasMore: false });
    await catalogLoad;
    expect(service.loading.value).toBe(false);
    expect(skillErrorMessage(new Error('SKILL_SOURCE_IN_USE'), 'Operation failed.')).toBe(
      i18n.global.t('generated.skillErrors.SKILL_SOURCE_IN_USE')
    );
    expect(skillErrorMessage(new Error('UNKNOWN_INTERNAL_CODE'), 'Operation failed.')).toBe(
      'Operation failed.'
    );
  });

  it('discards a stale search response after switching skill sources', async () => {
    let resolveFirst!: (value: { skills: [{ id: string; name: string }] }) => void;
    let resolveSecond!: (value: { skills: [{ id: string; name: string }] }) => void;
    const first = new Promise<{ skills: [{ id: string; name: string }] }>(
      (resolve) => (resolveFirst = resolve)
    );
    const second = new Promise<{ skills: [{ id: string; name: string }] }>(
      (resolve) => (resolveSecond = resolve)
    );
    const service = createSkillCenterService(
      (path) =>
        (path.startsWith('/api/skill-favorites?')
          ? Promise.resolve({ favorites: [] })
          : path.includes('/first/')
            ? first
            : second) as Promise<never>
    );
    service.selectedSourceId.value = 'first';
    const firstSearch = service.search();
    service.selectedSourceId.value = 'second';
    const secondSearch = service.search();
    resolveSecond({ skills: [{ id: 'new', name: 'new' }] });
    await secondSearch;
    resolveFirst({ skills: [{ id: 'old', name: 'old' }] });
    await firstSearch;
    expect(service.candidates.value).toEqual([{ id: 'new', name: 'new' }]);
  });

  it('does not auto-load popular skills from skills.sh; searches only after a query is entered', async () => {
    const requests: string[] = [];
    const service = createSkillCenterService(async (path) => {
      requests.push(path);
      return { skills: [] } as never;
    });
    service.sources.value = [
      {
        id: 'skills-sh',
        name: 'skills.sh',
        kind: 'SKILLS_SH',
        scope: 'ENTERPRISE',
        locator: 'skills.sh',
        enabled: true,
        builtIn: true,
        manageable: true
      },
      {
        id: 'repository',
        name: 'Repository',
        kind: 'REPOSITORY',
        scope: 'PERSONAL',
        locator: 'https://github.com/acme/skills',
        enabled: true,
        builtIn: false,
        manageable: true
      }
    ];
    service.selectedSourceId.value = 'skills-sh';

    await service.loadCandidates();

    expect(requests).toEqual([]);
    service.query.value = 'code review';
    await service.search();
    expect(requests).toEqual(['/api/skill-sources/skills-sh/skills?query=code+review&limit=40']);

    service.selectedSourceId.value = 'repository';
    await service.loadCandidates();
    expect(requests).toContain('/api/skill-sources/repository/skills');
  });

  it('runs skill update checks concurrently without entering the global loading state', async () => {
    let resolveFirst!: (value: {
      readonly updateAvailable: boolean;
      readonly latestCommitSha: string;
    }) => void;
    let resolveSecond!: (value: {
      readonly updateAvailable: boolean;
      readonly latestCommitSha: string;
    }) => void;
    const first = new Promise<{
      readonly updateAvailable: boolean;
      readonly latestCommitSha: string;
    }>((resolve) => (resolveFirst = resolve));
    const second = new Promise<{
      readonly updateAvailable: boolean;
      readonly latestCommitSha: string;
    }>((resolve) => (resolveSecond = resolve));
    const requests: string[] = [];
    const service = createSkillCenterService((path) => {
      requests.push(path);
      return (path.includes('/first/') ? first : second) as Promise<never>;
    });

    const firstCheck = service.checkUpdate('first');
    const secondCheck = service.checkUpdate('second');

    expect(service.loading.value).toBe(false);
    expect(requests).toEqual([
      '/api/skill-favorites/first/check-update',
      '/api/skill-favorites/second/check-update'
    ]);
    resolveFirst({ updateAvailable: false, latestCommitSha: 'a'.repeat(40) });
    resolveSecond({ updateAvailable: true, latestCommitSha: 'b'.repeat(40) });
    await expect(firstCheck).resolves.toMatchObject({ updateAvailable: false });
    await expect(secondCheck).resolves.toMatchObject({ updateAvailable: true });
  });

  it('selects an enabled skills.sh source on the initial load', async () => {
    const service = createSkillCenterService(async (path) => {
      if (path === '/api/skill-sources')
        return {
          sources: [
            {
              id: 'repo-first',
              name: 'AAA Repo',
              kind: 'REPOSITORY',
              scope: 'ENTERPRISE',
              locator: 'https://github.com/acme/skills',
              enabled: true,
              builtIn: false,
              manageable: true
            },
            {
              id: 'skills-sh',
              name: 'skills.sh',
              kind: 'SKILLS_SH',
              scope: 'ENTERPRISE',
              locator: 'skills.sh',
              enabled: true,
              builtIn: true,
              manageable: true
            }
          ]
        } as never;
      return { favorites: [], page: 1, pageSize: 20, total: 0, hasMore: false } as never;
    });

    await service.load();

    expect(service.selectedSourceId.value).toBe('skills-sh');
  });

  it('updates only featured and category tags, then refreshes the catalog', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const service = createSkillCenterService(async (path, init) => {
      requests.push({ path, ...(init === undefined ? {} : { init }) });
      if (path.startsWith('/api/skill-favorites'))
        return { favorites: [], page: 1, pageSize: 20, total: 0, hasMore: false } as never;
      return undefined as never;
    });

    await service.updatePresentation('favorite-1', {
      featured: true,
      tags: ['quality', 'review']
    });

    expect(requests[0]).toMatchObject({
      path: '/api/skill-favorites/favorite-1',
      init: { method: 'PATCH' }
    });
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
      featured: true,
      tags: ['quality', 'review']
    });
    expect(requests[1]?.path).toBe('/api/skill-favorites?page=1&limit=20');
  });

  it("can retry a failed skill installation without changing the page's current target", async () => {
    let attempts = 0;
    const requests: string[] = [];
    const service = createSkillCenterService(async (path, init) => {
      requests.push(`${init?.method ?? 'GET'} ${path}`);
      if (init?.method === 'POST') {
        attempts += 1;
        return { installJobId: `job-${attempts}` } as never;
      }
      if (path.endsWith('/job-1'))
        return { status: 'FAILED', errorCode: 'SKILL_CONTENT_INVALID' } as never;
      if (path.endsWith('/job-2')) return { status: 'SUCCEEDED' } as never;
      throw new Error(`UNEXPECTED_REQUEST:${path}`);
    });

    await expect(service.install('favorite-1', 'node-1')).rejects.toThrow('SKILL_CONTENT_INVALID');
    await expect(service.install('favorite-1', 'node-1')).resolves.toBeUndefined();
    expect(requests).toEqual([
      'POST /api/nodes/node-1/skills',
      'GET /api/skill-install-jobs/job-1',
      'POST /api/nodes/node-1/skills',
      'GET /api/skill-install-jobs/job-2'
    ]);
  });
});
