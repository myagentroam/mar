import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SkillDirectoryService } from '../../src/service/skill-directory-service.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Node Skill directory scan', () => {
  it('reads only bounded metadata and install records without recomputing the version after the body changes', async () => {
    const home = await temporaryRoot();
    const skill = path.join(home, '.agents', 'skills', 'review');
    await mkdir(skill, { recursive: true });
    await writeFile(
      path.join(skill, 'SKILL.md'),
      '---\nname: review\ndescription: Review code\n---\noriginal body\n'
    );
    await writeFile(
      path.join(skill, '.mar-skill-install.json'),
      JSON.stringify({
        schemaVersion: 1,
        favoriteId: 'favorite-1',
        versionId: 'version-1',
        commitSha: 'a'.repeat(40),
        contentHash: 'b'.repeat(64),
        installedAt: 1
      })
    );
    const service = new SkillDirectoryService();
    const first = await service.inspectNodeHome(home);
    await writeFile(path.join(skill, 'script.sh'), 'locally changed');
    const second = await service.inspectNodeHome(home);
    expect(first.skills).toEqual(second.skills);
    expect(first.skills[0]).toMatchObject({
      name: 'review',
      description: 'Review code',
      localStatus: 'VALID',
      skillFilePath: path.join(home, '.agents', 'skills', 'review', 'SKILL.md'),
      install: { commitSha: 'a'.repeat(40) }
    });
  });

  it('reports PARTIAL when the Workspace copy is missing', async () => {
    const workspace = await temporaryRoot();
    await writeSkill(path.join(workspace, '.agents', 'skills', 'review'));
    const result = await new SkillDirectoryService().inspectWorkspace(workspace);
    expect(result.compatibilityMode).toBe('MANAGED_COPY');
    expect(result.skills[0]).toMatchObject({
      name: 'review',
      localStatus: 'PARTIAL',
      skillFilePath: path.join(workspace, '.agents', 'skills', 'review', 'SKILL.md')
    });
  });

  it('reads only the canonical Node HOME root despite Claude-only and conflicting skills', async () => {
    const home = await temporaryRoot();
    await writeSkill(path.join(home, '.agents', 'skills', 'review'), 'Agents version');
    await writeSkill(path.join(home, '.claude', 'skills', 'claude-only'), 'Claude only');
    await writeSkill(path.join(home, '.claude', 'skills', 'review'), 'Claude version');

    const result = await new SkillDirectoryService().inspectNodeHome(home);

    expect(result.skills).toEqual([
      expect.objectContaining({
        name: 'review',
        description: 'Agents version',
        localStatus: 'UNKNOWN_VERSION',
        skillFilePath: path.join(home, '.agents', 'skills', 'review', 'SKILL.md')
      })
    ]);
  });

  it('excludes Claude-only Workspace skills and compatibility state from the effective view', async () => {
    const workspace = await temporaryRoot();
    await writeSkill(path.join(workspace, '.agents', 'skills', 'review'), 'Agents version');
    await writeSkill(path.join(workspace, '.agents', 'skills', 'agents-only'));
    await writeSkill(path.join(workspace, '.claude', 'skills', 'review'), 'Claude version');
    await writeSkill(path.join(workspace, '.claude', 'skills', 'claude-only'));
    const service = new SkillDirectoryService();

    const result = await service.inspectWorkspace(workspace, true, {
      includeClaudeCompatibility: false
    });
    expect(result.skills).toEqual([
      expect.objectContaining({ name: 'agents-only', localStatus: 'UNKNOWN_VERSION' }),
      expect.objectContaining({
        name: 'review',
        description: 'Agents version',
        localStatus: 'UNKNOWN_VERSION',
        skillFilePath: path.join(workspace, '.agents', 'skills', 'review', 'SKILL.md')
      })
    ]);
    const managed = await service.inspectWorkspace(workspace);
    expect(managed.skills.map((skill) => skill.name)).toEqual([
      'agents-only',
      'claude-only',
      'review'
    ]);
  });

  it('does not follow Skill item symlinks', async () => {
    const home = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeSkill(path.join(outside, 'review'));
    await mkdir(path.join(home, '.agents', 'skills'), { recursive: true });
    await symlink(
      path.join(outside, 'review'),
      path.join(home, '.agents', 'skills', 'review'),
      'dir'
    );
    const result = await new SkillDirectoryService().inspectNodeHome(home);
    expect(result.skills[0]).toMatchObject({ name: 'review', localStatus: 'INVALID_LINK' });
  });

  it('shows a repairable status when a Git Workspace lacks managed exclusion rules', async () => {
    const workspace = await temporaryRoot();
    await promisify(execFile)('git', ['init', workspace]);
    await writeSkill(path.join(workspace, '.agents', 'skills', 'review'));
    await writeSkill(path.join(workspace, '.claude', 'skills', 'review'));
    const result = await new SkillDirectoryService().inspectWorkspace(workspace);
    expect(result.skills[0]).toMatchObject({
      name: 'review',
      localStatus: 'GIT_EXCLUDE_BROKEN'
    });
  });

  it('leaves Skill status unchanged when the MAR temporary-directory rule is missing', async () => {
    const workspace = await temporaryRoot();
    await promisify(execFile)('git', ['init', workspace]);
    await writeSkill(path.join(workspace, '.agents', 'skills', 'review'));
    await writeSkill(path.join(workspace, '.claude', 'skills', 'review'));
    await writeFile(
      path.join(workspace, '.git', 'info', 'exclude'),
      '/.agents/skills/review/\n/.claude/skills/review/\n'
    );

    const result = await new SkillDirectoryService().inspectWorkspace(workspace);

    expect(result.skills[0]).toMatchObject({
      name: 'review',
      localStatus: 'UNKNOWN_VERSION'
    });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mar-skill-test-'));
  roots.push(root);
  return root;
}

async function writeSkill(directory: string, description = 'Review code'): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${path.basename(directory)}\ndescription: ${description}\n---\n`
  );
}
