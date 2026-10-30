import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceChangeService } from '../../src/workspace/workspace-change-service.js';
import { fetchGitRepository } from '../../src/workspace/git.js';
import type { NodeWorkspace } from '../../src/workspace/contracts.js';
import { GitExecutionService } from '../../src/service/git-execution-service.js';
import { GitOperationService } from '../../src/service/git-operation-service.js';
import {
  GitHttpTestServer,
  createGitEnvironment,
  randomSecret
} from './support/git-test-server.js';

const execFile = promisify(execFileCallback);
const directories: string[] = [];
async function git(path: string, ...args: string[]): Promise<string> {
  return (
    await execFile(
      'git',
      [
        '-c',
        'user.name=Fetch Test',
        '-c',
        'user.email=fetch@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'protocol.file.allow=always',
        ...args
      ],
      { cwd: path }
    )
  ).stdout.trim();
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mar-git-fetch-'));
  directories.push(directory);
  const source = join(directory, 'source');
  await git(directory, 'init', '-b', 'main', source);
  await writeFile(join(source, 'sample.txt'), 'base\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'base');
  const path = join(directory, 'workspace');
  await git(directory, 'clone', source, path);
  const workspace = { id: directory, path, kind: 'GIT_WORKSPACE' } as NodeWorkspace;
  return { directory, source, workspace, service: new WorkspaceChangeService() };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('Workspace Git fetch', () => {
  it('fetches with the current user credentials and isolates failed authentication', async () => {
    const { directory, workspace, service } = await fixture();
    const secretA = randomSecret();
    const secretB = randomSecret();
    const server = await GitHttpTestServer.createHttps([
      { username: 'user-a', secret: secretA },
      { username: 'user-b', secret: secretB }
    ]);
    const execution = new GitExecutionService({ directory: join(directory, 'git-runtime') });
    const operations = new GitOperationService({
      git: () => execution,
      workspace: async () => workspace,
      runActive: () => false
    });
    try {
      const remote = await server.createRepository('team/fetch');
      const environment = await createGitEnvironment(directory, {
        GIT_SSL_CAINFO: server.certificateAuthority
      });
      await git(workspace.path, 'remote', 'set-url', 'origin', remote);
      const head = await git(workspace.path, 'rev-parse', 'HEAD');
      const fetchAs = (userId: number, username: string, secret: string) =>
        operations.execute(
          'workspace.git.fetch',
          {
            workspaceId: workspace.id,
            __requestUserId: userId,
            secretEnvironment: environment,
            gitConfiguration: {
              credentials: [
                {
                  id: username,
                  name: username,
                  protocol: 'HTTPS',
                  host: '127.0.0.1',
                  port: server.port,
                  pathPrefix: '',
                  username,
                  commitName: 'Fetch Fixture',
                  commitEmail: 'fetch@example.invalid',
                  secret
                }
              ]
            }
          },
          () => service.fetch(workspace)
        );
      expect(await fetchAs(101, 'user-a', secretA)).toEqual({ fetchFailed: false });
      expect(await git(workspace.path, 'rev-parse', 'origin/main')).toBe(
        await git(join(server.root, 'repositories', 'team', 'fetch.git'), 'rev-parse', 'HEAD')
      );
      const attemptStart = server.attemptsFor('team/fetch').length;
      expect(await fetchAs(202, 'user-b', randomSecret())).toEqual({ fetchFailed: true });
      const attempts = server.attemptsFor('team/fetch').slice(attemptStart);
      expect(attempts.some((attempt) => attempt.username === 'user-b')).toBe(true);
      expect(
        attempts.some((attempt) => attempt.username === 'user-a' || attempt.authenticated)
      ).toBe(false);
      await expect(service.current(workspace)).resolves.toMatchObject({ workspace });
      expect(await fetchAs(202, 'user-b', secretB)).toEqual({ fetchFailed: false });
      expect(await git(workspace.path, 'rev-parse', 'HEAD')).toBe(head);
    } finally {
      await execution.close();
      await server.close();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'bounds remote children that ignore graceful termination',
    async () => {
      const { directory, workspace } = await fixture();
      const ssh = join(directory, 'test-ssh');
      await writeFile(
        ssh,
        '#!/bin/sh\ntrap "" TERM\nprintf ready > "$(dirname "$0")/ssh-ready"\nwhile :; do sleep 30; done\n'
      );
      await chmod(ssh, 0o755);
      vi.stubEnv('GIT_SSH_COMMAND', JSON.stringify(ssh));
      vi.stubEnv('GIT_SSH_VARIANT', 'ssh');
      await git(workspace.path, 'remote', 'set-url', 'origin', 'ssh://git@example.invalid/repo');
      const startedAt = performance.now();
      expect(await fetchGitRepository(workspace.path, 500)).toBe(false);
      expect(performance.now() - startedAt).toBeLessThan(3_000);
      expect(await readFile(join(directory, 'ssh-ready'), 'utf8')).toBe('ready');
    }
  );

  it.skipIf(process.platform === 'win32')(
    'cleans transaction locks when a fetch times out',
    async () => {
      const { source, workspace } = await fixture();
      await writeFile(join(source, 'sample.txt'), 'remote update\n');
      await git(source, 'commit', '-am', 'remote update');
      const hooks = join(workspace.path, '.git', 'hooks');
      const hook = join(hooks, 'reference-transaction');
      await writeFile(
        hook,
        '#!/bin/sh\nif [ "$1" = "prepared" ]; then\n  printf ready > "$(dirname "$0")/fetch-ready"\n  sleep 10\nfi\n'
      );
      await chmod(hook, 0o755);
      expect(await fetchGitRepository(workspace.path, 1_000)).toBe(false);
      expect(await readFile(join(hooks, 'fetch-ready'), 'utf8')).toBe('ready');
      expect(
        await readdir(join(workspace.path, '.git', 'refs', 'remotes', 'origin'))
      ).not.toContain('main.lock');
      await rm(hook);
      expect(await fetchGitRepository(workspace.path, 2_000)).toBe(true);
    }
  );

  it('bounds an unresponsive remote and leaves local refs readable', async () => {
    const { workspace } = await fixture();
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Fixture address missing');
      await git(
        workspace.path,
        'remote',
        'set-url',
        'origin',
        `http://127.0.0.1:${address.port}/repo`
      );
      const startedAt = performance.now();
      expect(await fetchGitRepository(workspace.path, 150)).toBe(false);
      expect(performance.now() - startedAt).toBeLessThan(3_000);
      expect(await git(workspace.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('updates root, submodule and shared worktree tracking and invalidates cached Changes', async () => {
    const { directory, source, workspace, service } = await fixture();
    const child = join(directory, 'child');
    await git(directory, 'clone', source, child);
    await git(workspace.path, 'submodule', 'add', child, 'child');
    await git(workspace.path, 'commit', '-am', 'add child');
    // Align the remote root without changing the submodule remote.
    await git(source, 'fetch', workspace.path, 'main:refs/heads/fetched');
    await git(source, 'reset', '--hard', 'fetched');
    await git(workspace.path, 'fetch', 'origin');
    const linked = join(directory, 'linked');
    await git(workspace.path, 'worktree', 'add', '-b', 'linked', linked, 'main');
    await git(workspace.path, 'branch', '--set-upstream-to=origin/main', 'linked');
    await service.current(workspace);
    await writeFile(join(source, 'sample.txt'), 'remote root\n');
    await git(source, 'commit', '-am', 'remote root');
    await writeFile(join(child, 'sample.txt'), 'remote child\n');
    await git(child, 'commit', '-am', 'remote child');
    const head = await git(workspace.path, 'rev-parse', 'HEAD');
    expect(await service.fetch(workspace)).toEqual({ fetchFailed: false });
    const result = (await service.current(workspace)) as {
      repositories: { repositoryPath: string; source: string; tracking?: { behind: number } }[];
    };
    expect(
      result.repositories
        .filter((group) => group.source !== 'WORKTREE')
        .map((group) => group.tracking?.behind)
    ).toEqual([1, 1]);
    expect(result.repositories.find((group) => group.source === 'WORKTREE')?.tracking?.behind).toBe(
      1
    );
    expect(await git(workspace.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(workspace.path, 'status', '--porcelain')).toBe('');
  });

  it('fetches only the selected History repository', async () => {
    const { directory, source, workspace, service } = await fixture();
    const child = join(directory, 'child');
    await git(directory, 'clone', source, child);
    await git(workspace.path, 'submodule', 'add', child, 'child');
    await writeFile(join(child, 'sample.txt'), 'child update\n');
    await git(child, 'commit', '-am', 'child update');
    await git(workspace.path, 'remote', 'set-url', 'origin', join(directory, 'missing'));
    expect(await service.fetch(workspace, 'child')).toEqual({ fetchFailed: false });
    expect(
      await git(join(workspace.path, 'child'), 'rev-list', '--count', 'HEAD..origin/main')
    ).toBe('1');
    await expect(service.fetch(workspace, '../outside')).rejects.toThrow('GIT_REPOSITORY_INVALID');
  });

  it('returns only a failure flag while local Changes remain readable', async () => {
    const { directory, workspace, service } = await fixture();
    await git(workspace.path, 'remote', 'set-url', 'origin', join(directory, 'missing'));
    expect(await service.fetch(workspace)).toEqual({ fetchFailed: true });
    await expect(service.current(workspace)).resolves.toMatchObject({
      branch: 'main',
      changes: []
    });
    await git(workspace.path, 'remote', 'remove', 'origin');
    expect(await service.fetch(workspace)).toEqual({ fetchFailed: false });
  });
});
