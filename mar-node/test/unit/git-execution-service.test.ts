import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitExecutionService } from '../../src/service/git-execution-service.js';

const execute = promisify(execFile);
const configuration = {
  credentials: [
    {
      id: 'default',
      name: 'default',
      protocol: 'HTTPS' as const,
      host: 'example.test',
      port: 443,
      pathPrefix: '',
      username: 'user-a',
      commitName: 'User A',
      commitEmail: 'a@example.test',
      secret: 'test-only-password'
    }
  ]
};
const services: GitExecutionService[] = [];
beforeEach(async () => {
  // Do not nest fixture capabilities inside the Agent host's Git broker.
  const { stdout } = await execute(
    process.platform === 'win32' ? 'where.exe' : '/bin/sh',
    process.platform === 'win32' ? ['git.exe'] : ['-lc', 'command -p -v git']
  );
  const binary = stdout
    .split(/\r?\n/u)
    .find((line) => line.trim() !== '')!
    .trim();
  const pathKey = process.platform === 'win32' && process.env.Path !== undefined ? 'Path' : 'PATH';
  vi.stubEnv(pathKey, `${dirname(binary)}${delimiter}${process.env[pathKey] ?? ''}`);
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('MAR_GIT_') || name === 'GIT_SSH_COMMAND' || name === 'GIT_SSH_VARIANT')
      vi.stubEnv(name, undefined);
  }
});
afterEach(async () => {
  try {
    await Promise.all(services.splice(0).map((service) => service.close()));
  } finally {
    vi.unstubAllEnvs();
  }
});

describe('Git execution environments', () => {
  it('reuses stable Git capabilities while rotating or removing execution credentials', async () => {
    const service = new GitExecutionService({ idleTimeoutMs: 10 });
    services.push(service);
    const first = await service.acquire(1, configuration, { MAR_CTL_USER_TOKEN: 'first-fixture' });
    const second = await service.acquire(1, configuration, {
      MAR_CTL_USER_TOKEN: 'second-fixture'
    });
    const removed = await service.acquire(1, configuration);
    expect(second.environment.MAR_GIT_TOKEN).toBe(first.environment.MAR_GIT_TOKEN);
    expect(removed.environment.MAR_GIT_TOKEN).toBe(first.environment.MAR_GIT_TOKEN);
    expect(first.environment.MAR_CTL_USER_TOKEN).toBe('first-fixture');
    expect(second.environment.MAR_CTL_USER_TOKEN).toBe('second-fixture');
    expect(removed.environment).not.toHaveProperty('MAR_CTL_USER_TOKEN');
    expect(Object.isFrozen(second.environment)).toBe(true);
    const restored = await fetch(`${first.environment.MAR_GIT_ENDPOINT}/restore`, {
      method: 'POST',
      headers: { authorization: `Bearer ${first.environment.MAR_GIT_TOKEN}` },
      body: '{}'
    });
    const restore = await restored.json();
    expect(restore.restore).not.toHaveProperty('MAR_CTL_USER_TOKEN');
    expect(JSON.stringify(restore)).not.toContain('first-fixture');
    expect(JSON.stringify(restore)).not.toContain('second-fixture');
    first.release();
    second.release();
    removed.release();
  });

  it('shares one capability across concurrent acquisitions with distinct execution credentials', async () => {
    const service = new GitExecutionService();
    services.push(service);
    const leases = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        service.acquire(1, configuration, { MAR_CTL_USER_TOKEN: `fixture-${index}` })
      )
    );
    expect(new Set(leases.map((lease) => lease.environment.MAR_GIT_TOKEN)).size).toBe(1);
    expect(leases.map((lease) => lease.environment.MAR_CTL_USER_TOKEN)).toEqual([
      'fixture-0',
      'fixture-1',
      'fixture-2',
      'fixture-3'
    ]);
    for (const lease of leases) lease.release();
  });

  it('still isolates principals, Git snapshots and stable environment changes', async () => {
    const service = new GitExecutionService();
    services.push(service);
    const leases = await Promise.all([
      service.acquire(1, configuration),
      service.acquire(2, configuration),
      service.acquire(1, {
        credentials: [{ ...configuration.credentials[0]!, secret: 'changed-fixture' }]
      }),
      service.acquire(1, configuration, { MAR_CTL_SERVER_URL: 'https://other.invalid' }),
      service.acquire(1, configuration, { FIXTURE_SCOPE: 'other' })
    ]);
    expect(new Set(leases.map((lease) => lease.environment.MAR_GIT_TOKEN)).size).toBe(
      leases.length
    );
    for (const lease of leases) lease.release();
  });

  it('provides a real empty SSH config shared by concurrent requests and removes it with the context', async () => {
    const service = new GitExecutionService();
    services.push(service);
    const lease = await service.acquire(1, {
      ...configuration,
      credentials: [
        {
          id: 'ssh',
          name: 'ssh',
          protocol: 'SSH',
          host: 'example.test',
          port: 22,
          pathPrefix: '',
          username: 'git',
          commitName: '',
          commitEmail: '',
          secret: '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----'
        }
      ]
    });
    const request = async () => {
      const response = await fetch(`${lease.environment.MAR_GIT_ENDPOINT}/ssh`, {
        method: 'POST',
        headers: { authorization: `Bearer ${lease.environment.MAR_GIT_TOKEN}` },
        body: JSON.stringify({ host: 'example.test', port: 22, path: 'repo.git' })
      });
      expect(response.ok).toBe(true);
      return (await response.json()) as { configFile: string; keyFile: string };
    };
    const [first, second] = await Promise.all([request(), request()]);
    expect(first.configFile).toEqual(expect.any(String));
    expect(first.configFile).toBe(second.configFile);
    expect(await readFile(first.configFile, 'utf8')).toBe('');
    expect(first.keyFile).toBe(second.keyFile);
    lease.release();
    await service.close();
    await expect(readFile(first.configFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves repository core.sshCommand for an unmatched SSH remote', async () => {
    if (process.platform === 'win32') return;
    const directory = await mkdtemp(join(tmpdir(), 'mar-git-fallback-'));
    const service = new GitExecutionService();
    services.push(service);
    try {
      await execute('git', ['init', directory]);
      await execute(
        'git',
        [
          'config',
          'core.sshCommand',
          'sh -c \'echo ORIGINAL_SSH_COMMAND > "$MAR_TEST_SSH_MARKER"; echo ORIGINAL_SSH_COMMAND >&2; exit 1\''
        ],
        { cwd: directory }
      );
      const lease = await service.acquire(1, {
        ...configuration,
        credentials: [
          {
            id: 'unrelated',
            name: 'unrelated',
            protocol: 'SSH',
            host: 'configured.example.test',
            port: 22,
            pathPrefix: '',
            username: 'git',
            commitName: '',
            commitEmail: '',
            secret:
              '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-only\n-----END OPENSSH PRIVATE KEY-----'
          }
        ]
      });
      try {
        await expect(
          execute('git', ['ls-remote', 'git@unmatched.invalid:team/repo.git'], {
            cwd: directory,
            env: {
              ...process.env,
              ...lease.environment,
              MAR_TEST_SSH_MARKER: join(directory, 'ssh-command-executed')
            },
            timeout: 5000
          })
        ).rejects.toMatchObject({
          stderr: expect.stringContaining('ORIGINAL_SSH_COMMAND')
        });
        expect(await readFile(join(directory, 'ssh-command-executed'), 'utf8')).toBe(
          'ORIGINAL_SSH_COMMAND\n'
        );
      } finally {
        lease.release();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'an Agent-provided GIT_SSH_COMMAND',
      args: (_command: string) => ['ls-remote', 'git@unmatched.invalid:team/repo.git'],
      environment: (command: string) => ({ GIT_SSH_COMMAND: command }),
      expected: 'AGENT_SSH_COMMAND'
    },
    {
      name: 'an invocation-level core.sshCommand',
      args: (command: string) => [
        '-c',
        `core.sshCommand=${command}`,
        'ls-remote',
        'git@unmatched.invalid:team/repo.git'
      ],
      environment: () => ({}),
      expected: 'INVOCATION_SSH_COMMAND'
    },
    {
      name: 'an invocation-level core.sshCommand from --config-env',
      args: () => [
        '--config-env=core.sshCommand=MAR_TEST_SSH_COMMAND',
        'ls-remote',
        'git@unmatched.invalid:team/repo.git'
      ],
      environment: (command: string) => ({ MAR_TEST_SSH_COMMAND: command }),
      expected: 'CONFIG_ENV_SSH_COMMAND'
    }
  ])('preserves $name for an unmatched SSH remote', async ({ args, environment, expected }) => {
    if (process.platform === 'win32') return;
    const directory = await mkdtemp(join(tmpdir(), 'mar-git-command-fallback-'));
    const command = join(directory, 'ssh-fallback');
    const service = new GitExecutionService();
    services.push(service);
    try {
      await execute('git', ['init', directory]);
      await writeFile(
        command,
        `#!/bin/sh\necho ${expected} > "$MAR_TEST_SSH_MARKER"\necho ${expected} >&2\nexit 1\n`,
        { mode: 0o700 }
      );
      const lease = await service.acquire(1, {
        ...configuration,
        credentials: [
          {
            id: 'unrelated',
            name: 'unrelated',
            protocol: 'SSH',
            host: 'configured.example.test',
            port: 22,
            pathPrefix: '',
            username: 'git',
            commitName: '',
            commitEmail: '',
            secret:
              '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-only\n-----END OPENSSH PRIVATE KEY-----'
          }
        ]
      });
      try {
        await expect(
          execute('git', args(command), {
            cwd: directory,
            env: {
              ...process.env,
              ...lease.environment,
              ...environment(command),
              MAR_TEST_SSH_MARKER: join(directory, 'ssh-command-executed')
            },
            timeout: 5000
          })
        ).rejects.toMatchObject({
          stderr: expect.stringContaining(expected)
        });
        expect(await readFile(join(directory, 'ssh-command-executed'), 'utf8')).toBe(
          `${expected}\n`
        );
      } finally {
        lease.release();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves native SSH command precedence for an unmatched remote', async () => {
    if (process.platform === 'win32') return;
    const directory = await mkdtemp(join(tmpdir(), 'mar-git-command-precedence-'));
    const originalCommand = join(directory, 'original-ssh');
    const invocationCommand = join(directory, 'invocation-ssh');
    const service = new GitExecutionService();
    services.push(service);
    try {
      await execute('git', ['init', directory]);
      await writeFile(originalCommand, '#!/bin/sh\necho ORIGINAL_SSH_COMMAND >&2\nexit 1\n', {
        mode: 0o700
      });
      await writeFile(invocationCommand, '#!/bin/sh\necho INVOCATION_SSH_COMMAND >&2\nexit 1\n', {
        mode: 0o700
      });
      const lease = await service.acquire(
        1,
        {
          ...configuration,
          credentials: [
            {
              id: 'unrelated',
              name: 'unrelated',
              protocol: 'SSH',
              host: 'configured.example.test',
              port: 22,
              pathPrefix: '',
              username: 'git',
              commitName: '',
              commitEmail: '',
              secret:
                '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-only\n-----END OPENSSH PRIVATE KEY-----'
            }
          ]
        },
        { GIT_SSH_COMMAND: originalCommand }
      );
      try {
        await expect(
          execute(
            'git',
            [
              '-c',
              `core.sshCommand=${invocationCommand}`,
              'ls-remote',
              'git@unmatched.invalid:team/repo.git'
            ],
            {
              cwd: directory,
              env: { ...process.env, ...lease.environment },
              timeout: 5000
            }
          )
        ).rejects.toMatchObject({
          stderr: expect.stringContaining('ORIGINAL_SSH_COMMAND')
        });
      } finally {
        lease.release();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('isolates credential contexts and resolves a matched credential identity at Git invocation', async () => {
    const service = new GitExecutionService({ idleTimeoutMs: 10 });
    services.push(service);
    const a = await service.acquire(1, configuration);
    const same = await service.acquire(1, configuration);
    const b = await service.acquire(2, configuration);
    expect(a.environment.MAR_GIT_TOKEN).toBe(same.environment.MAR_GIT_TOKEN);
    expect(a.environment.MAR_GIT_TOKEN).not.toBe(b.environment.MAR_GIT_TOKEN);
    expect(a.environment.GIT_AUTHOR_NAME).toBeUndefined();
    expect(a.environment.MAR_GIT_BINARY).toBeUndefined();
    const directory = await mkdtemp(join(tmpdir(), 'mar-git-identity-'));
    try {
      await execute('git', ['init', directory]);
      await execute('git', ['remote', 'add', 'origin', 'https://example.test/team/repo.git'], {
        cwd: directory
      });
      const result = await execute('git', ['var', 'GIT_AUTHOR_IDENT'], {
        cwd: directory,
        env: { ...process.env, ...a.environment }
      });
      expect(result.stdout).toContain('User A <a@example.test>');
      const name = await execute('git', ['config', 'user.name'], {
        cwd: directory,
        env: { ...process.env, ...a.environment }
      });
      const email = await execute('git', ['config', 'user.email'], {
        cwd: directory,
        env: { ...process.env, ...a.environment }
      });
      expect(name.stdout).toBe('User A\n');
      expect(email.stdout).toBe('a@example.test\n');
    } finally {
      a.release();
      same.release();
      b.release();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains queued environments and rejects retired capabilities', async () => {
    const service = new GitExecutionService({ idleTimeoutMs: 10 });
    services.push(service);
    const lease = await service.acquire(1, configuration);
    const retained = service.retain(lease.environment);
    lease.release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const response = await fetch(`${lease.environment.MAR_GIT_ENDPOINT}/credential`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lease.environment.MAR_GIT_TOKEN}` },
      body: JSON.stringify({ protocol: 'https', host: 'example.test', path: 'repo' })
    });
    expect(response.status).toBe(200);
    retained();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      (
        await fetch(`${lease.environment.MAR_GIT_ENDPOINT}/credential`, {
          method: 'POST',
          headers: { authorization: `Bearer ${lease.environment.MAR_GIT_TOKEN}` },
          body: '{}'
        })
      ).status
    ).toBe(403);
  });
});
