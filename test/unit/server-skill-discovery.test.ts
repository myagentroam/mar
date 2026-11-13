// @test-covers packages/server-core/src/skill-discovery-service.ts
import { describe, expect, it, vi } from 'vitest';
import { SkillDiscoveryService } from '../../ee/server/src/skill/skill-discovery-service.js';
import type { GitSkillRepository } from '../../ee/server/src/skill/git-skill-repository.js';

describe('Server Skill discovery', () => {
  it('Preserves the upstream anonymous skills find search contract', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      void input;
      return new Response(
        JSON.stringify({
          skills: [
            {
              id: 'vercel-labs/skills/find-skills',
              name: 'find-skills',
              source: 'vercel-labs/skills',
              installs: 20
            },
            { id: 'example.com/demo', name: 'demo', source: 'example.com', installs: 10 }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const result = await new SkillDiscoveryService(fetch as typeof globalThis.fetch).search(
      { id: 'skills-sh', kind: 'SKILLS_SH', locator: 'skills.sh', enabled: true },
      'find',
      10
    );
    expect(fetch.mock.calls[0]?.[0]).toContain('https://skills.sh/api/search?');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'find-skills',
      repositoryUrl: 'https://github.com/vercel-labs/skills'
    });
  });

  it('Empty skills.sh searches load the anonymous Hot ranking and degrade safely on API failure', async () => {
    const source = {
      id: 'skills-sh',
      kind: 'SKILLS_SH' as const,
      locator: 'skills.sh',
      enabled: true
    };
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            skills: [
              {
                source: 'vercel-labs/skills',
                skillId: 'find-skills',
                name: 'find-skills',
                installs: 30
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );

    const result = await new SkillDiscoveryService(fetch as typeof globalThis.fetch).search(
      source,
      '',
      10
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://skills.sh/api/skills/hot/0',
      expect.objectContaining({ headers: { accept: 'application/json' } })
    );
    expect(result).toEqual([
      expect.objectContaining({
        id: 'vercel-labs/skills/find-skills',
        repositoryUrl: 'https://github.com/vercel-labs/skills',
        installs: 30
      })
    ]);

    const unavailableFetch = vi.fn(async () => new Response('unavailable', { status: 503 }));
    const unavailable = new SkillDiscoveryService(unavailableFetch as typeof globalThis.fetch);
    await expect(unavailable.search(source, '', 10)).resolves.toEqual([]);
    await expect(unavailable.search(source, '', 10)).resolves.toEqual([]);
    expect(unavailableFetch).toHaveBeenCalledTimes(2);
  });

  it('skills.sh Hot rankings reuse a cache for twenty-four hours', async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            skills: [
              {
                source: 'vercel-labs/skills',
                skillId: 'find-skills',
                name: 'find-skills',
                installs: 30
              }
            ]
          }),
          { status: 200 }
        )
      )
    );
    let now = 1_000;
    const service = new SkillDiscoveryService(
      fetch as typeof globalThis.fetch,
      undefined,
      () => now
    );
    const source = {
      id: 'skills-sh',
      kind: 'SKILLS_SH' as const,
      locator: 'skills.sh',
      enabled: true
    };

    await service.search(source, '', 40);
    now += 24 * 60 * 60_000 - 1;
    await service.search(source, '', 40);
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 2;
    await service.search(source, '', 40);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    'https://github.com/acme/skills',
    'https://git.example.com/acme/group/skills.git',
    'git@git.example.com:acme/skills.git'
  ])(
    'discovers %s through the shared Git reader without Provider API requests',
    async (locator) => {
      const fetch = vi.fn(() => {
        throw new Error('Provider APIs must not be used');
      });
      const discover = vi.fn(async () => [
        {
          id: 'git.example.com/acme/skills/skills/review',
          name: 'review',
          description: 'Review changes before merge',
          source: 'git.example.com/acme/skills',
          skillPath: 'skills/review'
        }
      ]);
      const result = await new SkillDiscoveryService(
        fetch as unknown as typeof globalThis.fetch,
        { discover } as unknown as GitSkillRepository
      ).search({ id: 'repo', kind: 'REPOSITORY', locator, enabled: true }, 'review');
      expect(discover).toHaveBeenCalledWith(locator, 'review', 40);
      expect(fetch).not.toHaveBeenCalled();
      expect(result).toEqual([
        expect.objectContaining({
          name: 'review',
          description: 'Review changes before merge',
          repositoryUrl: locator,
          skillPath: 'skills/review',
          installs: null
        })
      ]);
    }
  );

  it('does not cache failed clones and allows a later search to recover', async () => {
    const discover = vi
      .fn()
      .mockRejectedValueOnce(new Error('SKILL_SOURCE_UNAVAILABLE'))
      .mockResolvedValueOnce([]);
    const service = new SkillDiscoveryService(undefined, {
      discover
    } as unknown as GitSkillRepository);
    const source = {
      id: 'repo',
      kind: 'REPOSITORY' as const,
      locator: 'https://github.com/acme/skills',
      enabled: true
    };
    await expect(service.search(source, '')).rejects.toThrow('SKILL_SOURCE_UNAVAILABLE');
    await expect(service.search(source, '')).resolves.toEqual([]);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('Briefly caches identical searches and coalesces concurrent repository fetches', async () => {
    let release!: (
      value: readonly {
        id: string;
        name: string;
        description: string;
        source: string;
        skillPath: string;
      }[]
    ) => void;
    const discover = vi.fn(
      () =>
        new Promise<
          readonly {
            id: string;
            name: string;
            description: string;
            source: string;
            skillPath: string;
          }[]
        >((resolve) => {
          release = resolve;
        })
    );
    const service = new SkillDiscoveryService(
      vi.fn() as unknown as typeof globalThis.fetch,
      {
        discover
      } as unknown as GitSkillRepository
    );
    const source = {
      id: 'ssh',
      kind: 'REPOSITORY' as const,
      locator: 'git@git.example.com:acme/skills.git',
      enabled: true
    };
    const first = service.search(source, '', 40);
    const concurrent = service.search(source, '', 40);
    release([
      {
        id: 'review',
        name: 'review',
        description: 'Review changes',
        source: 'git.example.com/acme/skills',
        skillPath: 'skills/review'
      }
    ]);
    await expect(Promise.all([first, concurrent])).resolves.toHaveLength(2);
    await expect(service.search(source, '', 40)).resolves.toHaveLength(1);
    expect(discover).toHaveBeenCalledTimes(1);
  });
});
