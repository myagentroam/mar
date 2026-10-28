import { describe, expect, it } from 'vitest';
import {
  finalizeSkillBundle,
  normalizeSkillName,
  parseSkillFrontmatter
} from '../../src/skill-bundle.js';

describe('Skill bundle construction', () => {
  const file = {
    path: 'SKILL.md',
    contentBase64: 'LS0tCm5hbWU6IHJldmlldwpkZXNjcmlwdGlvbjogUmV2aWV3IGNvZGUKLS0tCg=='
  };
  const input = {
    repositoryIdentity: 'github.com/acme/skills',
    repositoryUrl: 'https://github.com/acme/skills',
    skillPath: '.',
    commitSha: 'a'.repeat(40),
    contentBytes: Buffer.from(file.contentBase64, 'base64').length,
    tlsVerified: true,
    files: [file]
  };

  it('preserves canonical content and archive hash representations across source identities', () => {
    const github = finalizeSkillBundle(input);
    const git = finalizeSkillBundle({ ...input, repositoryIdentity: 'git.example/acme/skills' });
    expect(github).toMatchObject({
      name: 'review',
      description: 'Review code',
      contentHash: 'a9731ba2dbb95e8f24ee01b21722f347565f05c4bb8095a9fcce83ed859f73a3',
      archiveHash: '92b077afc62cc072073a109eb7199c21677bc0c94d0368f78ba4b565c65ea7da'
    });
    expect(git.contentHash).toBe(github.contentHash);
    expect(git.archiveHash).toBe(github.archiveHash);
    expect(
      finalizeSkillBundle({
        ...input,
        files: [
          {
            ...file,
            contentBase64: Buffer.from('---\nname: review\ndescription: Changed\n---\n').toString(
              'base64'
            )
          }
        ]
      }).contentHash
    ).not.toBe(github.contentHash);
  });

  it('rejects invalid names, frontmatter and forged installation metadata', () => {
    for (const name of ['con', 'a'.repeat(129), '../name'])
      expect(() => normalizeSkillName(name)).toThrow('SKILL_CONTENT_INVALID');
    expect(() => parseSkillFrontmatter('no metadata')).toThrow('SKILL_CONTENT_INVALID');
    expect(() => finalizeSkillBundle({ ...input, files: [] })).toThrow('SKILL_CONTENT_INVALID');
    expect(() =>
      finalizeSkillBundle({
        ...input,
        files: [file, { path: '.mar-skill-install.json', contentBase64: 'e30=' }]
      })
    ).toThrow('SKILL_CONTENT_INVALID');
  });

  it('canonicalizes an independent copy regardless of input order', () => {
    const script = { path: 'z.sh', contentBase64: 'ZWNobyByZXZpZXcK' };
    const unordered = [script, file];
    const first = finalizeSkillBundle({ ...input, files: unordered });
    const second = finalizeSkillBundle({ ...input, files: [file, script] });
    expect(unordered).toEqual([script, file]);
    expect(first.files).toEqual([file, script]);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.archiveHash).toBe(second.archiveHash);
  });
});
