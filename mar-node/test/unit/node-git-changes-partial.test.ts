import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import { WorkspaceChangeService } from '../../src/workspace/workspace-change-service.js';
import * as workspaceGit from '../../src/workspace/git.js';
import { workspaceChangesSummarySchema } from '../../../packages/protocol/src/index.js';

const execFile = promisify(execFileCallback);
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'mar-git-partial-'));
  directories.push(path);
  return path;
}
async function git(path: string, ...args: string[]) {
  return (await execFile('git', args, { cwd: path })).stdout.trim();
}
async function repository() {
  const path = await directory();
  await git(path, 'init', '-b', 'main');
  await git(path, 'config', 'user.name', 'Test');
  await git(path, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(path, 'root.txt'), 'base\n');
  await git(path, 'add', 'root.txt');
  await git(path, 'commit', '-m', 'fixture');
  await writeFile(join(path, 'root.txt'), 'changed\n');
  return path;
}
async function current(path: string, kind: 'GIT_WORKSPACE' | 'DIRECTORY' = 'GIT_WORKSPACE') {
  const database = new NodeDatabase(':memory:', 'git-partial-test');
  try {
    const workspace = database.saveWorkspace({ path, kind, gitSummary: null });
    return workspaceChangesSummarySchema.parse(
      await new WorkspaceChangeService().current(workspace)
    );
  } finally {
    database.close();
  }
}
async function gitlink(path: string, name: string, mapped = false) {
  await git(
    path,
    'update-index',
    '--add',
    '--cacheinfo',
    `160000,${await git(path, 'rev-parse', 'HEAD')},${name}`
  );
  if (mapped) {
    await git(path, 'config', '--file', '.gitmodules', `submodule.${name}.path`, name);
    await git(path, 'config', '--file', '.gitmodules', `submodule.${name}.url`, './local-source');
  }
}

describe('Git Changes partial success', () => {
  it('bounds the returned changes and marks a truncated repository', async () => {
    const path = await repository();
    const source = await repository();
    await git(path, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'child');
    await writeFile(join(path, 'child', 'root.txt'), 'child changes\n');
    await Promise.all(
      Array.from({ length: 1001 }, (_, index) =>
        writeFile(join(path, `extra-${String(index).padStart(4, '0')}.txt`), '')
      )
    );
    const result = await current(path);
    const root = result.repositories[0];
    expect(root?.changes).toHaveLength(1000);
    expect(root?.changesTruncated).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.changes).toEqual(root?.changes);
    expect(result.repositories.find((group) => group.repositoryPath === 'child')).toMatchObject({
      changes: [],
      changesTruncated: true
    });
    expect(result.repositories.reduce((count, group) => count + group.changes.length, 0)).toBe(
      1000
    );
  }, 30000);

  it.each(['CLEAN', 'DIRTY'] as const)(
    'returns the actual detached HEAD for a %s submodule and preserves named branches',
    async (status) => {
      const path = await repository();
      const source = await repository();
      await git(path, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'child');
      const child = join(path, 'child');
      const recordedHead = await git(child, 'rev-parse', 'HEAD');
      await git(child, 'checkout', '--detach');
      await git(
        child,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'detached commit'
      );
      const head = await git(child, 'rev-parse', 'HEAD');
      expect(head).not.toBe(recordedHead);
      if (status === 'DIRTY') await writeFile(join(child, 'root.txt'), 'child changes\n');

      const result = await current(path);
      const group = result.repositories.find((entry) => entry.repositoryPath === 'child');
      expect(result.partial).toBe(false);
      expect(group).toMatchObject({ source: 'SUBMODULE', branch: null, head, status });
      expect(group?.tracking).toBeUndefined();
      expect(group?.changes).toEqual(
        status === 'CLEAN' ? [] : [expect.objectContaining({ path: 'root.txt', state: 'UNSTAGED' })]
      );

      await git(child, 'checkout', 'main');
      expect(
        (await current(path)).repositories.find((entry) => entry.repositoryPath === 'child')
      ).toMatchObject({ branch: 'main', status });
    }
  );

  it('reports local upstream counts for root, submodule and linked worktree groups without fetching', async () => {
    const path = await repository();
    await git(path, 'add', 'root.txt');
    await git(path, 'commit', '-m', 'local base');
    expect((await current(path)).repositories[0]?.tracking).toBeUndefined();
    await git(path, 'config', 'remote.origin.url', '/missing-remote');
    await git(path, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    await git(path, 'config', 'branch.main.remote', 'origin');
    await git(path, 'config', 'branch.main.merge', 'refs/heads/main');
    await git(path, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect((await current(path)).repositories[0]?.tracking).toEqual({
      upstream: 'origin/main',
      ahead: 0,
      behind: 0
    });
    await git(path, 'checkout', '-b', 'remote-side');
    await git(path, 'commit', '--allow-empty', '-m', 'remote commit');
    await git(path, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    await git(path, 'checkout', 'main');
    expect((await current(path)).repositories[0]?.tracking).toMatchObject({ ahead: 0, behind: 1 });
    await git(path, 'commit', '--allow-empty', '-m', 'local commit');
    expect((await current(path)).repositories[0]?.tracking).toMatchObject({ ahead: 1, behind: 1 });

    const linked = join(await directory(), 'linked');
    await git(path, 'worktree', 'add', '-b', 'linked', linked, 'main');
    await git(linked, 'branch', '--set-upstream-to=origin/main');
    const child = await repository();
    await git(path, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'child');
    await git(join(path, 'child'), 'checkout', 'main');
    const result = await current(path);
    expect(result.repositories.find((group) => group.source === 'ROOT')?.tracking).toMatchObject({
      ahead: 1,
      behind: 1
    });
    expect(result.repositories.find((group) => group.source === 'SUBMODULE')?.tracking).toEqual({
      upstream: 'origin/main',
      ahead: 0,
      behind: 0
    });
    expect(result.repositories.find((group) => group.source === 'WORKTREE')?.tracking).toEqual({
      upstream: 'origin/main',
      ahead: 1,
      behind: 1
    });

    await git(path, 'update-ref', 'refs/remotes/origin/main', 'main~1');
    expect((await current(path)).repositories[0]?.tracking).toMatchObject({ ahead: 1, behind: 0 });
    await git(path, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect((await current(path)).repositories[0]?.tracking).toBeUndefined();
    await git(path, 'checkout', '--detach');
    expect((await current(path)).repositories[0]?.tracking).toBeUndefined();
    const unborn = await directory();
    await git(unborn, 'init', '-b', 'main');
    expect((await workspaceGit.readCurrentChangesSummary(unborn)).tracking).toBeUndefined();
  }, 30_000);

  it('keeps the root repository and an unavailable submodule when a gitlink lacks .gitmodules, without modifying the repository', async () => {
    const path = await repository();
    await gitlink(path, 'lib-zos');
    const index = await readFile(join(path, '.git', 'index'));
    const result = await current(path);
    expect(result).toMatchObject({
      partial: true,
      changes: expect.arrayContaining([expect.objectContaining({ path: 'root.txt' })]),
      repositories: expect.arrayContaining([
        expect.objectContaining({
          source: 'SUBMODULE',
          repositoryPath: 'lib-zos',
          status: 'UNAVAILABLE',
          error: expect.objectContaining({ code: 'GIT_SUBMODULE_MAPPING_MISSING' }),
          changes: []
        })
      ])
    });
    expect(await readFile(join(path, '.git', 'index'))).toEqual(index);
    await expect(readFile(join(path, '.gitmodules'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns the root repository when multiple submodules are unreadable', async () => {
    const path = await repository();
    await gitlink(path, 'missing-mapping');
    await gitlink(path, 'missing-directory', true);
    const result = await current(path);
    expect(result.partial).toBe(true);
    expect(result.repositories).toHaveLength(3);
    expect(result.repositories.slice(1).every((group) => group.status === 'UNAVAILABLE')).toBe(
      true
    );
    expect(result.changes.some((change) => change.path === 'root.txt')).toBe(true);
  });

  it('keeps the root repository and a healthy sibling when a submodule .git entry is damaged', async () => {
    const path = await repository();
    const source = await repository();
    await git(path, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'healthy');
    await gitlink(path, 'broken', true);
    await mkdir(join(path, 'broken'));
    await writeFile(join(path, 'broken', '.git'), 'gitdir: ./missing-metadata\n');
    const result = await current(path);
    expect(result.partial).toBe(true);
    expect(result.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repositoryPath: '',
          changes: expect.arrayContaining([expect.objectContaining({ path: 'root.txt' })])
        }),
        expect.objectContaining({
          repositoryPath: 'healthy',
          source: 'SUBMODULE',
          status: 'CLEAN'
        }),
        expect.objectContaining({
          repositoryPath: 'broken',
          status: 'UNAVAILABLE',
          error: expect.any(Object)
        })
      ])
    );
  });

  it('reports a healthy root repository as a complete result', async () => {
    const result = await current(await repository());
    expect(result.partial).toBe(false);
    expect(result.repositories).toHaveLength(1);
  });

  it('does not read parent repository changes from an uninitialized empty submodule', async () => {
    const path = await repository();
    await gitlink(path, 'empty', true);
    await mkdir(join(path, 'empty'));
    const result = await current(path);
    expect(result.repositories[1]).toMatchObject({
      repositoryPath: 'empty',
      status: 'UNAVAILABLE',
      changes: [],
      error: { code: 'GIT_REPOSITORY_UNREADABLE' }
    });
  });

  it('does not read an external repository through an escaping submodule symlink', async () => {
    const path = await repository();
    const outside = await repository();
    await gitlink(path, 'escape', true);
    await symlink(outside, join(path, 'escape'), 'junction');
    const result = await current(path);
    expect(result.repositories[1]).toMatchObject({
      repositoryPath: 'escape',
      status: 'UNAVAILABLE',
      changes: []
    });
  });

  it('limits a child repository permission failure to that repository group', async () => {
    const path = await repository();
    const source = await repository();
    await git(path, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'child');
    const read = workspaceGit.readCurrentChangesSummary;
    vi.spyOn(workspaceGit, 'readCurrentChangesSummary').mockImplementation((target, isolate) => {
      if (target === join(path, 'child')) {
        return Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
      }
      return read(target, isolate);
    });
    const result = await current(path);
    expect(result.partial).toBe(true);
    expect(result.repositories[1]).toMatchObject({
      status: 'UNAVAILABLE',
      error: { code: 'GIT_REPOSITORY_UNREADABLE' }
    });
    expect(result.changes.some((change) => change.path === 'root.txt')).toBe(true);
  });

  it('limits a missing nested gitlink mapping to that repository group', async () => {
    const path = await repository();
    const source = await repository();
    await git(path, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'child');
    await gitlink(join(path, 'child'), 'orphan');
    const result = await current(path);
    expect(result.partial).toBe(true);
    expect(result.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repositoryPath: 'child', status: 'DIRTY' }),
        expect.objectContaining({ repositoryPath: 'child/orphan', status: 'UNAVAILABLE' })
      ])
    );
  });

  it('hides damaged .gitmodules content while retaining root changes', async () => {
    const path = await repository();
    await gitlink(path, 'broken');
    await writeFile(join(path, '.gitmodules'), '[invalid sensitive-fixture\n');
    const result = await current(path);
    expect(result.repositories[1]).toMatchObject({
      status: 'UNAVAILABLE',
      error: { code: 'GIT_SUBMODULE_MAPPING_INVALID' }
    });
    expect(JSON.stringify(result)).not.toContain('sensitive-fixture');
    expect(result.changes.some((change) => change.path === 'root.txt')).toBe(true);
  });

  it('keeps the root repository when discovery fails or reaches its item limit', async () => {
    const path = await repository();
    const discovery = vi.spyOn(workspaceGit, 'listGitSubmodules');
    discovery.mockRejectedValueOnce(
      new workspaceGit.GitCommandError(128, 'fatal: discovery failed')
    );
    const log = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const failed = await current(path);
      expect(failed).toMatchObject({
        partial: true,
        errors: [
          expect.objectContaining({
            code: 'GIT_SUBMODULE_DISCOVERY_FAILED',
            details: 'fatal: discovery failed',
            parameters: { gitExitCode: 128 }
          })
        ]
      });
      expect(log.mock.calls.map(([line]) => String(line)).join('')).toContain(
        'fatal: discovery failed'
      );
    } finally {
      log.mockRestore();
    }
    discovery.mockResolvedValue(
      Array.from({ length: 129 }, (_, index) => ({
        path: `missing-${index}`,
        mapping: 'MISSING' as const
      }))
    );
    const limited = await current(path);
    expect(limited.repositories).toHaveLength(129);
    expect(limited.errors).toEqual([
      expect.objectContaining({ code: 'GIT_SUBMODULE_LIMIT_EXCEEDED' })
    ]);
  });

  it('does not report a missing Git executable when the root directory is missing', async () => {
    const path = join(await directory(), 'missing');
    await expect(current(path)).rejects.not.toThrow('GIT_NOT_FOUND');
  });

  it('fails globally when the root directory is not a Git repository instead of fabricating partial success', async () => {
    const path = await directory();
    await expect(current(path)).rejects.toThrow('GIT_COMMAND_FAILED');
    await expect(current(path, 'DIRECTORY')).rejects.toThrow('WORKSPACE_NOT_GIT');
  });

  it('fails globally when the Git executable is missing', async () => {
    const path = await repository();
    vi.stubEnv('PATH', await directory());
    const log = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(current(path)).rejects.toThrow('GIT_NOT_FOUND');
      const output = log.mock.calls.map(([line]) => String(line)).join('');
      expect(output).toContain('"event":"node.command.failed"');
      expect(output).toContain('"reason":"ENOENT"');
    } finally {
      log.mockRestore();
    }
  });

  it('marks linked-worktree discovery failure as partial success without dropping root changes', async () => {
    const path = await repository();
    vi.spyOn(workspaceGit, 'listGitWorktrees').mockRejectedValue(
      new workspaceGit.GitCommandError(128, 'fixture failure')
    );
    const result = await current(path);
    expect(result).toMatchObject({
      partial: true,
      errors: [expect.objectContaining({ code: 'GIT_WORKTREE_DISCOVERY_FAILED' })]
    });
    expect(result.changes.some((change) => change.path === 'root.txt')).toBe(true);
  });

  it('keeps changes for a readable locked worktree and reports a reason for a deleted worktree', async () => {
    const path = await repository();
    const parent = await directory();
    const locked = join(parent, 'locked');
    const missing = join(parent, 'missing');
    await git(path, 'worktree', 'add', '-b', 'locked', locked);
    await git(path, 'worktree', 'lock', locked);
    await writeFile(join(locked, 'root.txt'), 'worktree change\n');
    await git(path, 'worktree', 'add', '-b', 'missing', missing);
    await rm(missing, { recursive: true });
    const result = await current(path);
    expect(result.partial).toBe(true);
    expect(result.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ worktreePath: locked, locked: true, status: 'DIRTY' }),
        expect.objectContaining({
          worktreePath: missing,
          status: 'UNAVAILABLE',
          error: expect.any(Object)
        })
      ])
    );
  });
});
