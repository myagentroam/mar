import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillInstallService } from '../../src/service/skill-install-service.js';
import { ensureWorkspaceGitExclude } from '../../src/service/workspace-git-exclude-service.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
);

describe('Node Skill install transaction', () => {
  it('removes only managed legacy temp rules and preserves user-owned ignores', async () => {
    const workspace = await root();
    await promisify(execFile)('git', ['init'], { cwd: workspace });
    const exclude = path.join(workspace, '.git', 'info', 'exclude');
    await writeFile(
      exclude,
      '# user\n/.mar/\n# BEGIN MyAgentRoam\n/.mar/\n/.agents/skills/review/\n# END MyAgentRoam\n'
    );
    await ensureWorkspaceGitExclude(workspace);
    const content = await readFile(exclude, 'utf8');
    expect(content.split('/.mar/')).toHaveLength(2);
    expect(content).toContain('# user\n/.mar/\n');
    expect(content).toContain('/.agents/skills/review/');
    await ensureWorkspaceGitExclude(workspace);
    expect(await readFile(exclude, 'utf8')).toBe(content);
  });
  it('writes both agents and claude copies in the Workspace and maintains Git exclude', async () => {
    const workspace = await root();
    await promisify(execFile)('git', ['init', workspace]);
    await writeFile(path.join(workspace, '.git', 'info', 'exclude'), '# local\n');
    await new SkillInstallService().installWorkspace(workspace, 'review', bundle(), metadata());
    for (const agent of ['.agents', '.claude']) {
      expect(
        await readFile(path.join(workspace, agent, 'skills', 'review', 'SKILL.md'), 'utf8')
      ).toContain('name: review');
      expect(
        JSON.parse(
          await readFile(
            path.join(workspace, agent, 'skills', 'review', '.mar-skill-install.json'),
            'utf8'
          )
        )
      ).toMatchObject({ favoriteId: 'favorite-1' });
    }
    const exclude = await readFile(path.join(workspace, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).not.toContain('/.mar/');
    expect(exclude).toContain('/.agents/skills/review/');
    expect(exclude).toContain('/.claude/skills/review/');
  });

  it('reinstall replaces the entire directory without preserving manual files', async () => {
    const workspace = await root();
    const service = new SkillInstallService();
    await service.installWorkspace(workspace, 'review', bundle(), metadata());
    await writeFile(path.join(workspace, '.agents', 'skills', 'review', 'local.txt'), 'manual');
    await service.installWorkspace(workspace, 'review', bundle(), metadata());
    await expect(
      readFile(path.join(workspace, '.agents', 'skills', 'review', 'local.txt'))
    ).rejects.toThrow();
  });

  it.runIf(process.platform !== 'win32')(
    'replaces a symlink at the skill path without modifying its external target',
    async () => {
      const workspace = await root();
      const external = await root();
      await writeFile(path.join(external, 'external.txt'), 'preserved');
      for (const agent of ['.agents', '.claude']) {
        const skillsRoot = path.join(workspace, agent, 'skills');
        await mkdir(skillsRoot, { recursive: true });
        await symlink(external, path.join(skillsRoot, 'review'));
      }

      await new SkillInstallService().installWorkspace(workspace, 'review', bundle(), metadata());

      await expect(readFile(path.join(external, 'external.txt'), 'utf8')).resolves.toBe(
        'preserved'
      );
      await expect(
        readFile(path.join(workspace, '.agents', 'skills', 'review', 'SKILL.md'), 'utf8')
      ).resolves.toContain('name: review');
    }
  );

  it('rejects replacing a same-named regular file with a skill directory', async () => {
    const workspace = await root();
    for (const agent of ['.agents', '.claude']) {
      const skillsRoot = path.join(workspace, agent, 'skills');
      await mkdir(skillsRoot, { recursive: true });
      await writeFile(path.join(skillsRoot, 'review'), 'manual file');
    }

    await expect(
      new SkillInstallService().installWorkspace(workspace, 'review', bundle(), metadata())
    ).rejects.toThrow('SKILL_INSTALL_INVALID_LINK');
    await expect(
      readFile(path.join(workspace, '.agents', 'skills', 'review'), 'utf8')
    ).resolves.toBe('manual file');
  });

  it('deleting a Workspace Skill removes both copies', async () => {
    const workspace = await root();
    await promisify(execFile)('git', ['init', workspace]);
    const service = new SkillInstallService();
    await service.installWorkspace(workspace, 'review', bundle(), metadata());
    await service.removeWorkspace(workspace, 'review');
    await expect(
      readFile(path.join(workspace, '.agents', 'skills', 'review', 'SKILL.md'))
    ).rejects.toThrow();
    await expect(
      readFile(path.join(workspace, '.claude', 'skills', 'review', 'SKILL.md'))
    ).rejects.toThrow();
    const exclude = await readFile(path.join(workspace, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).not.toContain('/.mar/');
    expect(exclude).not.toContain('/.agents/skills/review/');
    expect(exclude).not.toContain('/.claude/skills/review/');
  });

  it('removes the managed MAR temporary rule while repairing the Workspace Skill Git exclude', async () => {
    const workspace = await root();
    await promisify(execFile)('git', ['init', workspace]);
    await writeFile(
      path.join(workspace, '.git', 'info', 'exclude'),
      '# local\n# BEGIN MyAgentRoam\n/.mar/\n# END MyAgentRoam\n'
    );
    const skill = path.join(workspace, '.agents', 'skills', 'review');
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, 'SKILL.md'), '---\nname: review\ndescription: Review\n---\n');

    await new SkillInstallService().repairWorkspaceGitExclude(workspace);

    const exclude = await readFile(path.join(workspace, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).not.toContain('/.mar/');
    expect(exclude).toContain('/.agents/skills/review/');
    expect(exclude).toContain('/.claude/skills/review/');
  });

  it.runIf(process.platform !== 'win32')(
    'rejects following a skill root inside the Workspace that points outside',
    async () => {
      const workspace = await root();
      const external = await root();
      await mkdir(path.join(workspace, '.agents'), { recursive: true });
      await symlink(external, path.join(workspace, '.agents', 'skills'));

      await expect(
        new SkillInstallService().installWorkspace(workspace, 'review', bundle(), metadata())
      ).rejects.toThrow('SKILL_PATH_UNSAFE');
      await expect(readFile(path.join(external, 'review', 'SKILL.md'))).rejects.toThrow();
    }
  );

  it('rejects Windows device names and case-insensitive duplicate directories', async () => {
    const workspace = await root();
    const service = new SkillInstallService();
    await expect(service.installWorkspace(workspace, 'con', bundle(), metadata())).rejects.toThrow(
      'SKILL_NAME_CONFLICT'
    );
    await mkdir(path.join(workspace, '.agents', 'skills', 'Review'), { recursive: true });
    await expect(
      service.installWorkspace(workspace, 'review', bundle(), metadata())
    ).rejects.toThrow('SKILL_NAME_CONFLICT');
  });

  it('requires separate confirmation before replacing a Git-tracked Skill', async () => {
    const workspace = await root();
    await promisify(execFile)('git', ['init', workspace]);
    const tracked = path.join(workspace, '.agents', 'skills', 'review');
    await mkdir(tracked, { recursive: true });
    await writeFile(path.join(tracked, 'SKILL.md'), 'tracked');
    await promisify(execFile)('git', ['-C', workspace, 'add', '.agents/skills/review/SKILL.md']);
    const service = new SkillInstallService();

    await expect(
      service.installWorkspace(workspace, 'review', bundle(), metadata())
    ).rejects.toThrow('WORKSPACE_SKILL_TRACKED_CONFIRM_REQUIRED');
    await expect(
      service.installWorkspace(workspace, 'review', bundle(), metadata(), { confirmTracked: true })
    ).resolves.toBeUndefined();
  });

  it('rolls back a two-copy commit that exited abnormally using the transaction marker before the next scan', async () => {
    const workspace = await root();
    const transactionId = '11111111-1111-4111-8111-111111111111';
    const rootsByAgent = ['.agents', '.claude'].map((agent) =>
      path.join(workspace, agent, 'skills')
    );
    const items = rootsByAgent.map((rootPath) => ({
      target: path.join(rootPath, 'review'),
      staging: path.join(rootPath, '.mar-staging-stale'),
      backup: path.join(rootPath, '.mar-backup-stale'),
      hadTarget: false
    }));
    for (const [index, rootPath] of rootsByAgent.entries()) {
      await mkdir(rootPath, { recursive: true });
      if (index === 0) await mkdir(items[index]!.target, { recursive: true });
      else await mkdir(items[index]!.staging, { recursive: true });
      await writeFile(
        path.join(rootPath, `.mar-transaction-${transactionId}.json`),
        JSON.stringify({
          schemaVersion: 1,
          transactionId,
          state: 'PREPARED',
          roots: rootsByAgent,
          items
        })
      );
    }

    await new SkillInstallService().recoverWorkspace(workspace);
    await expect(readFile(path.join(items[0]!.target, 'SKILL.md'))).rejects.toThrow();
    await expect(readFile(path.join(items[1]!.staging, 'SKILL.md'))).rejects.toThrow();
  });

  it.runIf(process.platform !== 'win32')(
    'rolls back a committed two-copy installation when Git exclude is unsafe',
    async () => {
      const workspace = await root();
      await promisify(execFile)('git', ['init', workspace]);
      const service = new SkillInstallService();
      await service.installWorkspace(workspace, 'review', bundle(), metadata());
      await writeFile(path.join(workspace, '.agents', 'skills', 'review', 'local.txt'), 'keep');
      const exclude = path.join(workspace, '.git', 'info', 'exclude');
      const external = path.join(await root(), 'exclude');
      await writeFile(external, 'external');
      await rm(exclude);
      await symlink(external, exclude);

      await expect(
        service.installWorkspace(workspace, 'review', bundle(), metadata())
      ).rejects.toThrow('WORKSPACE_SKILL_GIT_EXCLUDE_FAILED');
      await expect(
        readFile(path.join(workspace, '.agents', 'skills', 'review', 'local.txt'), 'utf8')
      ).resolves.toBe('keep');
      await expect(readFile(external, 'utf8')).resolves.toBe('external');
    }
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), 'mar-skill-install-'));
  roots.push(value);
  return value;
}
function bundle() {
  return {
    schemaVersion: 1 as const,
    files: [
      {
        path: 'SKILL.md',
        contentBase64: Buffer.from('---\nname: review\ndescription: Review code\n---\n').toString(
          'base64'
        )
      }
    ]
  };
}
function metadata() {
  return {
    schemaVersion: 1 as const,
    favoriteId: 'favorite-1',
    versionId: 'version-1',
    commitSha: 'a'.repeat(40),
    contentHash: 'b'.repeat(64),
    installedAt: 1
  };
}
