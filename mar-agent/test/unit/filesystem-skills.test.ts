import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentInstructions, loadAgentSkill } from '../../src/runtime/context/instructions.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(content: string) {
  const root = await mkdtemp(join(tmpdir(), 'mar-filesystem-skills-'));
  roots.push(root);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const directory = join(home, '.agents', 'skills', 'review');
  await Promise.all([
    mkdir(directory, { recursive: true }),
    mkdir(join(workspace, '.git'), { recursive: true })
  ]);
  await writeFile(join(directory, 'SKILL.md'), content);
  return { home, workspace };
}

describe('Filesystem Skill catalog metadata', () => {
  it.each([
    ['Review code # comment', 'Review code'],
    ['"Review: code # keep"', 'Review: code # keep'],
    ["'Review ''quoted'' code'", "Review 'quoted' code"],
    ['"Review\\ncode\\t\\u00e9"', 'Review\ncode\té'],
    ['|\n  Review code\n  Use for changes.', 'Review code\nUse for changes.\n'],
    ['|-\n  Review code\n  Use for changes.', 'Review code\nUse for changes.'],
    ['|+\n  Review code\n\n', 'Review code\n\n\n'],
    ['>\n  Review code\n  Use for changes.', 'Review code Use for changes.\n'],
    ['>-\n  Review code\n\n  Use for changes.', 'Review code\nUse for changes.'],
    ['|2-\n    Review code\n    Keep indentation.', '  Review code\n  Keep indentation.'],
    ['on', 'on'],
    ['2026-11-15', '2026-11-15'],
    ['""', '']
  ])('projects YAML description %s into the model-visible catalog', async (value, expected) => {
    const content = `---\nname: different-name\ndescription: ${value}\n---\nBody guidance.`;
    const paths = await fixture(content);
    const result = await loadAgentInstructions(paths);
    expect([...result.skills.keys()]).toEqual(['review']);
    const skill = result.skills.get('review')!;
    expect(skill.description).toBe(expected);
    expect(result.skillCatalog).toContain(`- review: ${expected} (source:`);
    expect(result.skillCatalog).not.toContain('Body guidance.');
    const loaded = await loadAgentSkill(skill);
    expect(loaded).toContain('<content>---\nname: different-name\n');
    expect(loaded).toContain('\n---\nBody guidance.</content>');
  });

  it('parses quoted YAML keys, unrelated nested metadata and CRLF line endings', async () => {
    const paths = await fixture(
      '---\r\n"description": |\r\n  Résumé\r\n  Review code\r\nmetadata:\r\n  description: Nested metadata\r\n---\r\nBody'
    );
    const result = await loadAgentInstructions(paths);
    expect(result.skills.get('review')?.description).toBe('Résumé\nReview code\n');
    expect(result.skillCatalog).not.toContain('Nested metadata');
  });

  it('supports a YAML flow mapping without using its name as filesystem identity', async () => {
    const paths = await fixture('---\n{ name: other, description: "Review code" }\n---\nBody');
    const result = await loadAgentInstructions(paths);
    expect([...result.skills.keys()]).toEqual(['review']);
    expect(result.skills.get('review')?.description).toBe('Review code');
  });

  it.each([
    'description: Markdown body only',
    '---\nname: review\n---\ndescription: Markdown body, not metadata',
    '---\ndescription: "Unterminated\n---\nBody',
    '---\ndescription: Review\ndescription: Duplicate\n---\nBody',
    '---\ndescription: Review\nBody without a closing delimiter',
    '---\n[description, Review]\n---\nBody',
    '---\nnot a mapping\n---\nBody',
    '---\ndescription: true\n---\nBody',
    '---\ndescription: 12\n---\nBody',
    '---\ndescription: null\n---\nBody',
    '---\ndescription: [Review, code]\n---\nBody',
    '---\ndescription: { text: Review code }\n---\nBody',
    '---\ndescription: !!js/function "function() {}"\n---\nBody'
  ])('uses the existing generic summary for missing or unusable metadata: %s', async (content) => {
    const paths = await fixture(content);
    const result = await loadAgentInstructions(paths);
    const skill = result.skills.get('review')!;
    expect(skill.description).toBe('Agent skill');
    expect(result.skillCatalog).toContain('- review: Agent skill (source:');
    expect(await loadAgentSkill(skill)).toContain(content);
  });

  it('keeps file overrides and Host Skill metadata on their existing paths', async () => {
    const paths = await fixture('---\ndescription: |\n  User review\n---\nUser guidance');
    const load = async () => 'Host guidance';
    const hostSkills = [
      { name: 'review', description: 'Host review', requiredTools: [], load },
      { name: 'host-only', description: 'Host-provided description: |', requiredTools: [], load }
    ];
    let result = await loadAgentInstructions({ ...paths, hostSkills });
    expect(result.skills.get('review')?.description).toBe('User review\n');
    expect(result.skills.get('host-only')?.description).toBe('Host-provided description: |');
    const directory = join(paths.workspace, '.agents', 'skills', 'review');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'SKILL.md'),
      '---\ndescription: >-\n  Workspace review\n---\nBody'
    );
    result = await loadAgentInstructions({ ...paths, hostSkills });
    expect(result.skills.size).toBe(2);
    expect(result.skills.get('review')?.description).toBe('Workspace review');
    expect(result.skills.get('host-only')?.description).toBe('Host-provided description: |');
  });
});
