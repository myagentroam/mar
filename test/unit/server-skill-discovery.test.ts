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

  it('Repository sources discover SKILL.md only in standard directories through Provider APIs', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tree: [
              { type: 'blob', path: 'skills/review/SKILL.md' },
              { type: 'blob', path: 'random/deep/rejected/SKILL.md' }
            ]
          }),
          { status: 200 }
        )
      );
    const result = await new SkillDiscoveryService(fetch as typeof globalThis.fetch).search(
      {
        id: 'repo',
        kind: 'REPOSITORY',
        locator: 'https://github.com/acme/skills',
        enabled: true
      },
      'review'
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ skillPath: 'skills/review', name: 'review' });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.github.com/repos/acme/skills');
  });

  it('Rejects unsupported repository Providers', async () => {
    await expect(
      new SkillDiscoveryService().search(
        {
          id: 'repo',
          kind: 'REPOSITORY',
          locator: 'https://example.com/skills',
          enabled: true
        },
        ''
      )
    ).rejects.toThrow('SKILL_SOURCE_PROVIDER_UNSUPPORTED');
  });

  it('Discovers standard Skill directories through self-hosted GitLab APIs', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ type: 'blob', path: '.agents/skills/review/SKILL.md' }]), {
          status: 200
        })
      );
    const result = await new SkillDiscoveryService(fetch as typeof globalThis.fetch).search(
      {
        id: 'gitlab',
        kind: 'REPOSITORY',
        locator: 'https://git.example.com/acme/skills',
        enabled: true
      },
      'review'
    );
    expect(result).toEqual([
      expect.objectContaining({
        name: 'review',
        repositoryUrl: 'https://git.example.com/acme/skills'
      })
    ]);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://git.example.com/api/v4/projects/acme%2Fskills');
  });

  it('git@ sources discover skills through local Git and SSH configuration', async () => {
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
      vi.fn() as unknown as typeof globalThis.fetch,
      { discover } as unknown as GitSkillRepository
    ).search(
      {
        id: 'ssh',
        kind: 'REPOSITORY',
        locator: 'git@git.example.com:acme/skills.git',
        enabled: true
      },
      'review'
    );
    expect(discover).toHaveBeenCalledWith('git@git.example.com:acme/skills.git', 'review', 40);
    expect(result[0]).toMatchObject({
      name: 'review',
      description: 'Review changes before merge',
      skillPath: 'skills/review'
    });
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
