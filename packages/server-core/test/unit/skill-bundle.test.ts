import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  finalizeSkillBundle,
  normalizeSkillName,
  parseSkillFrontmatter,
  readSkillFrontmatter,
  type ResolvedSkillBundle
} from '../../src/skill-bundle.js';

const bundles: ResolvedSkillBundle[] = [];
afterEach(async () => {
  await Promise.all(bundles.splice(0).map((bundle) => bundle.dispose()));
});
async function finalize(input: Parameters<typeof finalizeSkillBundle>[0]) {
  const bundle = await finalizeSkillBundle(input);
  bundles.push(bundle);
  return bundle;
}
async function archive(bundle: ResolvedSkillBundle): Promise<string> {
  return (await bundle.archive().toArray()).join('');
}
function file(path: string, contentBase64: string) {
  return { path, open: () => Readable.from([Buffer.from(contentBase64, 'base64')]) };
}

describe('Skill bundle construction', () => {
  const skill = file(
    'SKILL.md',
    'LS0tCm5hbWU6IHJldmlldwpkZXNjcmlwdGlvbjogUmV2aWV3IGNvZGUKLS0tCg=='
  );
  const input = {
    repositoryIdentity: 'github.com/acme/skills',
    repositoryUrl: 'https://github.com/acme/skills',
    skillPath: '.',
    commitSha: 'a'.repeat(40),
    tlsVerified: true,
    files: [skill]
  };

  it('preserves canonical content and archive hash representations across source identities', async () => {
    const github = await finalize(input);
    const git = await finalize({ ...input, repositoryIdentity: 'git.example/acme/skills' });
    expect(github).toMatchObject({
      name: 'review',
      description: 'Review code',
      contentHash: 'a9731ba2dbb95e8f24ee01b21722f347565f05c4bb8095a9fcce83ed859f73a3',
      archiveHash: '92b077afc62cc072073a109eb7199c21677bc0c94d0368f78ba4b565c65ea7da'
    });
    expect(git.contentHash).toBe(github.contentHash);
    expect(git.archiveHash).toBe(github.archiveHash);
    expect(
      (
        await finalize({
          ...input,
          files: [
            file(
              'SKILL.md',
              Buffer.from('---\nname: review\ndescription: Changed\n---\n').toString('base64')
            )
          ]
        })
      ).contentHash
    ).not.toBe(github.contentHash);
  });

  it('rejects invalid names, frontmatter and forged installation metadata', async () => {
    for (const name of ['con', 'a'.repeat(129), '../name'])
      expect(() => normalizeSkillName(name)).toThrow('SKILL_CONTENT_INVALID');
    expect(() => parseSkillFrontmatter('no metadata')).toThrow('SKILL_CONTENT_INVALID');
    await expect(finalizeSkillBundle({ ...input, files: [] })).rejects.toThrow(
      'SKILL_CONTENT_INVALID'
    );
    await expect(
      finalizeSkillBundle({
        ...input,
        files: [skill, file('.mar-skill-install.json', 'e30=')]
      })
    ).rejects.toThrow('SKILL_CONTENT_INVALID');
  });

  it('canonicalizes an independent copy regardless of input order', async () => {
    const script = file('z.sh', 'ZWNobyByZXZpZXcK');
    const unordered = [script, skill];
    const first = await finalize({ ...input, files: unordered });
    const second = await finalize({ ...input, files: [skill, script] });
    expect(unordered).toEqual([script, skill]);
    expect(
      JSON.parse(await archive(first)).files.map((entry: { path: string }) => entry.path)
    ).toEqual(['SKILL.md', 'z.sh']);
    expect(first.fileCount).toBe(2);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.archiveHash).toBe(second.archiveHash);
  });

  it.each([1, 2, 3, 7])(
    'encodes binary data across %s-byte stream boundaries and removes its archive',
    async (size) => {
      const content = Buffer.from([0, 255, 128, 34, 10, 13, 92, 1, 2, 3]);
      const binary = {
        path: 'bin/"é.bin',
        open: () =>
          Readable.from(
            (function* () {
              for (let offset = 0; offset < content.length; offset += size)
                yield content.subarray(offset, offset + size);
            })()
          )
      };
      const bundle = await finalize({ ...input, files: [binary, skill] });
      const files = JSON.parse(await archive(bundle)).files;
      expect(files.find((entry: { path: string }) => entry.path === binary.path)).toEqual({
        path: binary.path,
        contentBase64: content.toString('base64')
      });
      expect(bundle.contentBytes).toBe(content.length + 46);
      await bundle.dispose();
      await expect(bundle.archive().toArray()).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('reads frontmatter without buffering or reading a large Markdown body', async () => {
    let bodyRead = false;
    let closed = false;
    async function* chunks() {
      try {
        for (const byte of Buffer.from('---\r\nname: review\r\ndescription: Résumé\r\n---\r\n'))
          yield Buffer.from([byte]);
        bodyRead = true;
        throw new Error('The Markdown body must not be read');
      } finally {
        closed = true;
      }
    }
    await expect(readSkillFrontmatter(chunks())).resolves.toEqual({
      name: 'review',
      description: 'Résumé'
    });
    expect(bodyRead).toBe(false);
    expect(closed).toBe(true);
  });
});
