import { describe, expect, it, vi } from 'vitest';
import { GithubSkillProvider } from '../../ee/server/src/skill/github-skill-provider.js';

describe('GitHub Skill provider', () => {
  it('builds identical canonical content from differently ordered GitHub and GitLab trees', async () => {
    const skill = Buffer.from('---\nname: review\ndescription: Review code\n---\n');
    const script = Buffer.from('echo review\n');
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/acme/skills') || url.endsWith('/api/v4/projects/acme%2Fskills'))
        return json({ default_branch: 'main' });
      if (url.includes('/commits/'))
        return url.includes('/api/v4/')
          ? json({ id: 'a'.repeat(40) })
          : json({ sha: 'a'.repeat(40) });
      if (url.includes('/git/trees/'))
        return json({
          tree: [
            {
              type: 'blob',
              path: 'skills/review/script.sh',
              sha: '2'.repeat(40),
              size: script.length
            },
            {
              type: 'blob',
              path: 'skills/review/SKILL.md',
              sha: '1'.repeat(40),
              size: skill.length
            }
          ]
        });
      if (url.includes('/repository/tree?'))
        return json([
          { type: 'blob', path: 'skills/review/SKILL.md', id: '1'.repeat(40) },
          { type: 'blob', path: 'skills/review/script.sh', id: '2'.repeat(40) }
        ]);
      const content = url.endsWith('1'.repeat(40)) ? skill : script;
      return json({
        encoding: 'base64',
        size: content.length,
        content: content.toString('base64')
      });
    });
    const provider = new GithubSkillProvider(fetch as typeof globalThis.fetch);
    const github = await provider.resolve({
      repositoryUrl: 'https://github.com/acme/skills',
      skillPath: 'skills/review'
    });
    const gitlab = await provider.resolve({
      repositoryUrl: 'https://git.example.com/acme/skills',
      skillPath: 'skills/review'
    });
    expect(github.files).toEqual(gitlab.files);
    expect(github.files.map((file) => file.path)).toEqual(
      ['script.sh', 'SKILL.md'].sort((a, b) => a.localeCompare(b))
    );
    expect(github.contentHash).toBe(gitlab.contentHash);
    expect(github.archiveHash).toBe(gitlab.archiveHash);
  });

  it('Pins the default-branch Commit and builds bounded immutable bundles', async () => {
    const skill = Buffer.from('---\nname: review\ndescription: Review code\n---\n');
    const script = Buffer.from('echo review\n');
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/acme/skills')) return json({ default_branch: 'main' });
      if (url.includes('/commits/')) return json({ sha: 'a'.repeat(40) });
      if (url.includes('/git/trees/'))
        return json({
          tree: [
            {
              type: 'blob',
              path: 'skills/review/SKILL.md',
              sha: '1'.repeat(40),
              size: skill.length
            },
            {
              type: 'blob',
              path: 'skills/review/script.sh',
              sha: '2'.repeat(40),
              size: script.length
            }
          ]
        });
      return url.endsWith('1'.repeat(40))
        ? json({ encoding: 'base64', content: skill.toString('base64') })
        : json({ encoding: 'base64', content: script.toString('base64') });
    });
    const bundle = await new GithubSkillProvider(fetch as typeof globalThis.fetch).resolve({
      repositoryUrl: 'https://github.com/acme/skills',
      skillPath: 'skills/review'
    });
    expect(bundle).toMatchObject({
      repositoryIdentity: 'github.com/acme/skills',
      skillPath: 'skills/review',
      name: 'review',
      commitSha: 'a'.repeat(40),
      contentBytes: skill.length + script.length
    });
    expect(bundle.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(fetch.mock.calls[2]?.[0]).toContain(`/git/trees/${'a'.repeat(40)}?recursive=1`);
  });

  it('Pins Commits and Skill paths through GitLab Provider APIs on arbitrary domains', async () => {
    const skill = Buffer.from('---\nname: review\ndescription: Review code\n---\n');
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/v4/projects/acme%2Fskills'))
        return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
      if (url.includes('/repository/commits/main'))
        return new Response(JSON.stringify({ id: 'd'.repeat(40) }), { status: 200 });
      if (url.includes('/repository/tree?'))
        return new Response(
          JSON.stringify([{ type: 'blob', path: 'skills/review/SKILL.md', id: 'e'.repeat(40) }]),
          { status: 200 }
        );
      if (url.includes(`/repository/blobs/${'e'.repeat(40)}`))
        return new Response(
          JSON.stringify({
            encoding: 'base64',
            size: skill.length,
            content: skill.toString('base64')
          }),
          { status: 200 }
        );
      return new Response(null, { status: 404 });
    });
    const result = await new GithubSkillProvider(fetch as typeof globalThis.fetch).resolve({
      repositoryUrl: 'https://git.example.com/acme/skills',
      skillPath: 'skills/review'
    });
    expect(result).toMatchObject({
      repositoryIdentity: 'git.example.com/acme/skills',
      commitSha: 'd'.repeat(40),
      name: 'review'
    });
  });

  it('Supports SKILL.md at the repository root', async () => {
    const skill = Buffer.from('---\nname: root-skill\ndescription: Root skill\n---\n');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ default_branch: 'main' }))
      .mockResolvedValueOnce(json({ sha: '1'.repeat(40) }))
      .mockResolvedValueOnce(
        json({
          tree: [{ type: 'blob', path: 'SKILL.md', sha: '2'.repeat(40), size: skill.length }]
        })
      )
      .mockResolvedValueOnce(json({ encoding: 'base64', content: skill.toString('base64') }));
    const result = await new GithubSkillProvider(fetch as typeof globalThis.fetch).resolve({
      repositoryUrl: 'https://github.com/acme/root-skill',
      skillPath: '.'
    });
    expect(result).toMatchObject({ skillPath: '.', name: 'root-skill' });
  });

  it('Delegates git@ repositories to the local SSH Git reader', async () => {
    const resolved = {
      repositoryIdentity: 'git.example.com/acme/skills',
      repositoryUrl: 'git@git.example.com:acme/skills.git',
      skillPath: 'skills/review',
      name: 'review',
      description: 'Review code',
      commitSha: 'a'.repeat(40),
      contentHash: 'b'.repeat(64),
      archiveHash: 'c'.repeat(64),
      contentBytes: 10,
      tlsVerified: true,
      files: []
    };
    const gitRepository = { resolve: vi.fn().mockResolvedValue(resolved) };
    const provider = new GithubSkillProvider(
      vi.fn() as unknown as typeof globalThis.fetch,
      async () => false,
      gitRepository as never
    );

    await expect(
      provider.resolve({
        repositoryUrl: 'git@git.example.com:acme/skills.git',
        skillPath: 'skills/review'
      })
    ).resolves.toEqual(resolved);
    expect(gitRepository.resolve).toHaveBeenCalledWith({
      repositoryUrl: 'git@git.example.com:acme/skills.git',
      skillPath: 'skills/review'
    });
  });

  it('Rejects repositories that forge MAR installation metadata', async () => {
    const skill = Buffer.from('---\nname: review\ndescription: Review code\n---\n');
    const marker = Buffer.from('{}');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ default_branch: 'main' }))
      .mockResolvedValueOnce(json({ sha: 'a'.repeat(40) }))
      .mockResolvedValueOnce(
        json({
          tree: [
            {
              type: 'blob',
              path: 'skills/review/SKILL.md',
              sha: '1'.repeat(40),
              size: skill.length
            },
            {
              type: 'blob',
              path: 'skills/review/.mar-skill-install.json',
              sha: '2'.repeat(40),
              size: marker.length
            }
          ]
        })
      )
      .mockImplementation(async (input: string | URL | Request) =>
        json({
          encoding: 'base64',
          content: (String(input).endsWith('1'.repeat(40)) ? skill : marker).toString('base64')
        })
      );
    await expect(
      new GithubSkillProvider(fetch as typeof globalThis.fetch).resolve({
        repositoryUrl: 'https://github.com/acme/skills',
        skillPath: 'skills/review'
      })
    ).rejects.toThrow('SKILL_CONTENT_INVALID');
  });

  it('Rejects Skill path traversal before upstream access', async () => {
    await expect(
      new GithubSkillProvider().resolve({
        repositoryUrl: 'https://example.com/acme/skills',
        skillPath: '../review'
      })
    ).rejects.toThrow('SKILL_PATH_UNSAFE');
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}
