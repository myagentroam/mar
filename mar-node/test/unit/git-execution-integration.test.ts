import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PersonalGitRuntime } from '../../../packages/protocol/src/git-identity.js';
import { GitExecutionService } from '../../src/service/git-execution-service.js';
import {
  GitHttpTestServer,
  GitSshTestServer,
  contentsUnder,
  createGitEnvironment,
  randomSecret,
  runGit,
  temporaryDirectory
} from './support/git-test-server.js';

vi.setConfig({ testTimeout: 30_000 });

describe('GitExecutionService real Git integration', () => {
  it('isolates HTTPS credentials per user while cloning, fetching, pushing, and injecting commit identity', async () => {
    const secretA = randomSecret();
    const secretB = randomSecret();
    const server = await GitHttpTestServer.createHttps([
      { username: 'user-a', secret: secretA },
      { username: 'user-b', secret: secretB }
    ]);
    const root = await temporaryDirectory();
    const runtimeDirectory = join(root, 'runtime');
    const service = new GitExecutionService({ idleTimeoutMs: 10, directory: runtimeDirectory });
    let closed = false;
    try {
      const remote = await server.createRepository('team/shared');
      const baseEnvironment = await createGitEnvironment(root, {
        GIT_SSL_CAINFO: server.certificateAuthority
      });
      const userA = runtime(
        'Alice Fixture',
        'alice@example.invalid',
        httpsCredential('user-a', secretA, server, '')
      );
      const userB = runtime(
        'Bob Fixture',
        'bob@example.invalid',
        httpsCredential('user-b', secretB, server, '')
      );
      const cloneA = join(root, 'clone-a');
      const cloneB = join(root, 'clone-b');

      const leaseA = await service.acquire(101, userA, baseEnvironment);
      assertNoSecretInEnvironment(leaseA.environment, [secretA, secretB]);
      try {
        await runGitOperation(
          'clone with the first HTTPS user',
          root,
          ['clone', remote, cloneA],
          executionEnvironment(baseEnvironment, leaseA.environment)
        );
      } finally {
        leaseA.release();
      }
      const leaseB = await service.acquire(202, userB, baseEnvironment);
      assertNoSecretInEnvironment(leaseB.environment, [secretA, secretB]);
      try {
        await runGitOperation(
          'clone with the second HTTPS user',
          root,
          ['clone', remote, cloneB],
          executionEnvironment(baseEnvironment, leaseB.environment)
        );
      } finally {
        leaseB.release();
      }

      const configBeforeCommit = await readFile(join(cloneA, '.git', 'config'), 'utf8');
      const leaseAForPush = await service.acquire(101, userA, baseEnvironment);
      try {
        const environment = executionEnvironment(baseEnvironment, leaseAForPush.environment);
        await writeFile(join(cloneA, 'alice.txt'), 'alice\n');
        await runGitOperation(
          'stage the first HTTPS user change',
          cloneA,
          ['add', 'alice.txt'],
          environment
        );
        await runGitOperation(
          'commit the first HTTPS user change',
          cloneA,
          ['commit', '-m', 'Alice change'],
          environment
        );
        expect(
          (
            await runGitOperation(
              'read the first HTTPS user identity',
              cloneA,
              ['log', '-1', '--format=%an <%ae>'],
              environment
            )
          ).trim()
        ).toBe('Alice Fixture <alice@example.invalid>');
        await runGitOperation(
          'push the first HTTPS user change',
          cloneA,
          ['push', 'origin', 'main'],
          environment
        );
      } finally {
        leaseAForPush.release();
      }
      expect(await readFile(join(cloneA, '.git', 'config'), 'utf8')).toBe(configBeforeCommit);

      const configBeforeFetch = await readFile(join(cloneB, '.git', 'config'), 'utf8');
      const leaseBForPush = await service.acquire(202, userB, baseEnvironment);
      try {
        const environment = executionEnvironment(baseEnvironment, leaseBForPush.environment);
        await runGitOperation(
          'fetch the first HTTPS user change as the second user',
          cloneB,
          ['fetch', 'origin', 'main'],
          environment
        );
        await runGitOperation(
          'fast-forward the second HTTPS user clone',
          cloneB,
          ['merge', '--ff-only', 'origin/main'],
          environment
        );
        await writeFile(join(cloneB, 'bob.txt'), 'bob\n');
        await runGitOperation(
          'stage the second HTTPS user change',
          cloneB,
          ['add', 'bob.txt'],
          environment
        );
        await runGitOperation(
          'commit the second HTTPS user change',
          cloneB,
          ['commit', '-m', 'Bob change'],
          environment
        );
        expect(
          (
            await runGitOperation(
              'read the second HTTPS user identity',
              cloneB,
              ['log', '-1', '--format=%an <%ae>'],
              environment
            )
          ).trim()
        ).toBe('Bob Fixture <bob@example.invalid>');
        await runGitOperation(
          'push the second HTTPS user change',
          cloneB,
          ['push', 'origin', 'main'],
          environment
        );
      } finally {
        leaseBForPush.release();
      }
      expect(await readFile(join(cloneB, '.git', 'config'), 'utf8')).toBe(configBeforeFetch);

      expect(
        server.attempts
          .filter((attempt) => attempt.authenticated)
          .map((attempt) => attempt.username)
      ).toEqual(expect.arrayContaining(['user-a', 'user-b']));
      expect(await readFile(join(cloneA, '.git', 'config'), 'utf8')).not.toContain(secretA);
      expect(await readFile(join(cloneB, '.git', 'config'), 'utf8')).not.toContain(secretB);

      await service.close();
      closed = true;
      const runtimeContents = await contentsUnder(runtimeDirectory);
      expect(runtimeContents).not.toContain(secretA);
      expect(runtimeContents).not.toContain(secretB);
    } finally {
      if (!closed) await service.close();
      await server.close();
      await removeDirectory(root);
    }
  });

  it('selects only the most-specific HTTPS account, preserves fallback helpers, and never supplies HTTPS credentials to HTTP', async () => {
    const generalSecret = randomSecret();
    const scopedSecret = randomSecret();
    const fallbackSecret = randomSecret();
    const failedSecret = randomSecret();
    const server = await GitHttpTestServer.createHttps([
      { username: 'general-user', secret: generalSecret },
      { username: 'scoped-user', secret: scopedSecret },
      { username: 'fallback-user', secret: fallbackSecret },
      { username: 'failed-user', secret: randomSecret() }
    ]);
    const httpSecret = randomSecret();
    const httpServer = await GitHttpTestServer.createHttp([
      { username: 'http-user', secret: httpSecret }
    ]);
    const root = await temporaryDirectory();
    const runtimeDirectory = join(root, 'runtime');
    const service = new GitExecutionService({ idleTimeoutMs: 10, directory: runtimeDirectory });
    try {
      const scopedRemote = await server.createRepository('team/scoped');
      const siblingRemote = await server.createRepository('team/scoped-other');
      const fallbackRemote = await server.createRepository('team/fallback');
      const rejectedRemote = await server.createRepository('team/rejected');
      const httpRemote = await httpServer.createRepository('team/http-only');
      const baseEnvironment = await createGitEnvironment(root, {
        GIT_SSL_CAINFO: server.certificateAuthority
      });
      const scopedRuntime = runtime(
        'Scoped Fixture',
        'scoped@example.invalid',
        httpsCredential('general-user', generalSecret, server, ''),
        {
          ...httpsCredential('scoped-user', scopedSecret, server, 'team/scoped.git'),
          commitName: 'Scoped Credential',
          commitEmail: 'scoped-credential@example.invalid'
        }
      );

      const scopedLease = await service.acquire(303, scopedRuntime, baseEnvironment);
      try {
        await runGit(
          root,
          ['clone', scopedRemote, join(root, 'scoped')],
          executionEnvironment(baseEnvironment, scopedLease.environment)
        );
        await runGit(
          root,
          ['clone', siblingRemote, join(root, 'sibling')],
          executionEnvironment(baseEnvironment, scopedLease.environment)
        );
      } finally {
        scopedLease.release();
      }
      expect(authenticatedUsers(server.attemptsFor('team/scoped.git'))).toContain('scoped-user');
      expect(authenticatedUsers(server.attemptsFor('team/scoped.git'))).not.toContain(
        'general-user'
      );
      expect(authenticatedUsers(server.attemptsFor('team/scoped-other.git'))).toContain(
        'general-user'
      );
      expect(authenticatedUsers(server.attemptsFor('team/scoped-other.git'))).not.toContain(
        'scoped-user'
      );
      const scopedIdentityLease = await service.acquire(303, scopedRuntime, baseEnvironment);
      try {
        const scopedClone = join(root, 'scoped');
        await writeFile(join(scopedClone, 'identity.txt'), 'identity\n');
        await runGit(
          scopedClone,
          ['add', 'identity.txt'],
          executionEnvironment(baseEnvironment, scopedIdentityLease.environment)
        );
        await runGit(
          scopedClone,
          ['commit', '-m', 'credential identity'],
          executionEnvironment(baseEnvironment, scopedIdentityLease.environment)
        );
        expect(
          (
            await runGit(
              scopedClone,
              ['log', '-1', '--format=%an <%ae>'],
              executionEnvironment(baseEnvironment, scopedIdentityLease.environment)
            )
          ).trim()
        ).toBe('Scoped Credential <scoped-credential@example.invalid>');
      } finally {
        scopedIdentityLease.release();
      }

      const helperPath = join(root, 'fallback-helper');
      await writeFile(
        helperPath,
        `#!/bin/sh\n[ "$1" = get ] || exit 0\ncat >/dev/null\nprintf 'username=%s\\npassword=%s\\n\\n' fallback-user ${fallbackSecret}\n`,
        { mode: 0o700 }
      );
      await runGit(
        root,
        ['config', '--global', 'credential.helper', `!${helperPath}`],
        baseEnvironment
      );
      const globalConfigBefore = await readFile(join(baseEnvironment.HOME!, '.gitconfig'), 'utf8');
      const fallbackLease = await service.acquire(
        404,
        runtime('Fallback Fixture', 'fallback@example.invalid', {
          ...httpsCredential('unmatched-user', randomSecret(), server, ''),
          host: 'unmatched.example.invalid'
        }),
        baseEnvironment
      );
      try {
        await runGit(
          root,
          ['clone', fallbackRemote, join(root, 'fallback')],
          executionEnvironment(baseEnvironment, fallbackLease.environment)
        );
      } finally {
        fallbackLease.release();
      }
      expect(authenticatedUsers(server.attemptsFor('team/fallback.git'))).toContain(
        'fallback-user'
      );
      expect(await readFile(join(baseEnvironment.HOME!, '.gitconfig'), 'utf8')).toBe(
        globalConfigBefore
      );

      const rejectedLease = await service.acquire(
        505,
        runtime(
          'Rejected Fixture',
          'rejected@example.invalid',
          httpsCredential('general-user', generalSecret, server, ''),
          httpsCredential('failed-user', failedSecret, server, 'team/rejected.git')
        ),
        baseEnvironment
      );
      try {
        await expect(
          runGit(
            root,
            ['clone', rejectedRemote, join(root, 'rejected')],
            executionEnvironment(baseEnvironment, rejectedLease.environment)
          )
        ).rejects.toThrow('The fixture command failed');
      } finally {
        rejectedLease.release();
      }
      const rejectedUsers = attemptedUsers(server.attemptsFor('team/rejected.git'));
      expect(rejectedUsers).toContain('failed-user');
      expect(rejectedUsers).not.toContain('general-user');

      const httpEnvironment = await createGitEnvironment(join(root, 'http-home'));
      const httpLease = await service.acquire(
        606,
        runtime('HTTP Fixture', 'http@example.invalid', {
          id: 'http-only',
          name: 'HTTP only',
          protocol: 'HTTPS',
          host: '127.0.0.1',
          port: portFromRemote(httpRemote),
          pathPrefix: 'team/http-only.git',
          username: 'http-user',
          commitName: '',
          commitEmail: '',
          secret: httpSecret
        }),
        httpEnvironment
      );
      try {
        await expect(
          runGit(
            root,
            ['ls-remote', httpRemote],
            executionEnvironment(httpEnvironment, httpLease.environment)
          )
        ).rejects.toThrow('The fixture command failed');
      } finally {
        httpLease.release();
      }
      expect(authenticatedUsers(httpServer.attemptsFor('team/http-only.git'))).toEqual([]);
    } finally {
      await service.close();
      await httpServer.close();
      await server.close();
      await removeDirectory(root);
    }
  });

  it('uses the branch upstream for credential identity and preserves repository identity without one', async () => {
    const secret = randomSecret();
    const server = await GitHttpTestServer.createHttps([{ username: 'fixture', secret }]);
    const root = await temporaryDirectory();
    const service = new GitExecutionService({
      idleTimeoutMs: 10,
      directory: join(root, 'runtime')
    });
    try {
      const originRemote = await server.createRepository('team/origin');
      const upstreamRemote = await server.createRepository('team/upstream');
      const blankRemote = await server.createRepository('team/blank');
      const baseEnvironment = await createGitEnvironment(root, {
        GIT_SSL_CAINFO: server.certificateAuthority
      });
      const matchedRuntime: PersonalGitRuntime = {
        credentials: [
          {
            ...httpsCredential('fixture', secret, server, 'team/origin.git'),
            id: 'origin',
            commitName: 'Origin Credential',
            commitEmail: 'origin@example.invalid'
          },
          {
            ...httpsCredential('fixture', secret, server, 'team/upstream.git'),
            id: 'upstream',
            commitName: 'Upstream Credential',
            commitEmail: 'upstream@example.invalid'
          }
        ]
      };
      const clone = join(root, 'origin');
      const cloneLease = await service.acquire(1, matchedRuntime, baseEnvironment);
      try {
        await runGit(
          root,
          ['clone', originRemote, clone],
          executionEnvironment(baseEnvironment, cloneLease.environment)
        );
      } finally {
        cloneLease.release();
      }
      await runGit(clone, ['config', 'user.name', 'Repository User'], baseEnvironment);
      await runGit(clone, ['config', 'user.email', 'repository@example.invalid'], baseEnvironment);
      await runGit(clone, ['remote', 'add', 'upstream', upstreamRemote], baseEnvironment);
      await runGit(clone, ['config', 'branch.main.remote', 'upstream'], baseEnvironment);
      await writeFile(join(clone, 'upstream.txt'), 'upstream\n');
      const upstreamLease = await service.acquire(1, matchedRuntime, baseEnvironment);
      try {
        const environment = executionEnvironment(baseEnvironment, upstreamLease.environment);
        expect((await runGit(clone, ['config', 'user.name'], environment)).trim()).toBe(
          'Upstream Credential'
        );
        expect((await runGit(clone, ['config', 'user.email'], environment)).trim()).toBe(
          'upstream@example.invalid'
        );
        await runGit(clone, ['add', 'upstream.txt'], environment);
        await runGit(clone, ['commit', '-m', 'upstream identity'], environment);
        expect((await runGit(clone, ['log', '-1', '--format=%an <%ae>'], environment)).trim()).toBe(
          'Upstream Credential <upstream@example.invalid>'
        );
      } finally {
        upstreamLease.release();
      }
      expect(
        (await runGit(clone, ['config', '--local', 'user.name'], baseEnvironment)).trim()
      ).toBe('Repository User');
      expect(
        (await runGit(clone, ['config', '--local', 'user.email'], baseEnvironment)).trim()
      ).toBe('repository@example.invalid');

      const blankRuntime: PersonalGitRuntime = {
        credentials: [
          {
            ...httpsCredential('fixture', secret, server, 'team/blank.git'),
            id: 'blank',
            commitName: '',
            commitEmail: ''
          }
        ]
      };
      const blankClone = join(root, 'blank');
      const blankCloneLease = await service.acquire(2, blankRuntime, baseEnvironment);
      try {
        await runGit(
          root,
          ['clone', blankRemote, blankClone],
          executionEnvironment(baseEnvironment, blankCloneLease.environment)
        );
      } finally {
        blankCloneLease.release();
      }
      await runGit(blankClone, ['config', 'user.name', 'Repository User'], baseEnvironment);
      await runGit(
        blankClone,
        ['config', 'user.email', 'repository@example.invalid'],
        baseEnvironment
      );
      await writeFile(join(blankClone, 'blank.txt'), 'blank\n');
      const blankLease = await service.acquire(2, blankRuntime, baseEnvironment);
      try {
        const environment = executionEnvironment(baseEnvironment, blankLease.environment);
        await runGit(blankClone, ['add', 'blank.txt'], environment);
        await runGit(blankClone, ['commit', '-m', 'blank credential identity'], environment);
        expect(
          (await runGit(blankClone, ['log', '-1', '--format=%an <%ae>'], environment)).trim()
        ).toBe('Repository User <repository@example.invalid>');
      } finally {
        blankLease.release();
      }

      await writeFile(join(clone, 'unmatched.txt'), 'unmatched\n');
      const unmatchedLease = await service.acquire(
        3,
        {
          credentials: [
            {
              ...httpsCredential('fixture', secret, server, ''),
              id: 'unmatched',
              host: 'unmatched.example.invalid',
              commitName: 'Unexpected Identity',
              commitEmail: 'unexpected@example.invalid'
            }
          ]
        },
        baseEnvironment
      );
      try {
        const environment = executionEnvironment(baseEnvironment, unmatchedLease.environment);
        await runGit(clone, ['add', 'unmatched.txt'], environment);
        await runGit(clone, ['commit', '-m', 'unmatched credential identity'], environment);
        expect((await runGit(clone, ['log', '-1', '--format=%an <%ae>'], environment)).trim()).toBe(
          'Repository User <repository@example.invalid>'
        );
      } finally {
        unmatchedLease.release();
      }
    } finally {
      await service.close();
      await server.close();
      await removeDirectory(root);
    }
  });

  it('uses unencrypted and encrypted SSH keys without exposing them, and rejects an untrusted host key', async () => {
    const root = await temporaryDirectory();
    const ssh = await GitSshTestServer.create();
    const runtimeDirectory = join(root, 'runtime');
    const service = new GitExecutionService({
      idleTimeoutMs: 10,
      directory: runtimeDirectory,
      knownHostsFile: ssh.knownHosts
    });
    let untrustedService: GitExecutionService | undefined;
    let closed = false;
    try {
      const remote = await ssh.createRepository('team/private');
      const passphrase = randomSecret();
      const plainKey = await ssh.createKey('plain');
      const encryptedKey = await ssh.createKey('encrypted', passphrase);
      const baseEnvironment = await createGitEnvironment(root);
      const plainRuntime = runtime(
        'Plain Key Fixture',
        'plain@example.invalid',
        sshCredential('plain-key', ssh, plainKey.privateKey)
      );
      const encryptedRuntime = runtime(
        'Encrypted Key Fixture',
        'encrypted@example.invalid',
        sshCredential('encrypted-key', ssh, encryptedKey.privateKey, encryptedKey.passphrase)
      );

      const plainLease = await service.acquire(707, plainRuntime, baseEnvironment);
      assertNoSecretInEnvironment(plainLease.environment, [plainKey.privateKey]);
      try {
        const environment = executionEnvironment(baseEnvironment, plainLease.environment);
        environment.GIT_SSH_COMMAND = "sh -c 'echo AGENT_SSH_COMMAND_BYPASS >&2; exit 1'";
        await runGitOperation(
          'clone with an unencrypted SSH key despite an Agent command override',
          root,
          ['clone', remote, join(root, 'plain')],
          environment
        );
      } finally {
        plainLease.release();
      }

      const encryptedLease = await service.acquire(808, encryptedRuntime, baseEnvironment);
      assertNoSecretInEnvironment(encryptedLease.environment, [
        encryptedKey.privateKey,
        passphrase
      ]);
      try {
        const environment = executionEnvironment(baseEnvironment, encryptedLease.environment);
        delete environment.GIT_SSH_COMMAND;
        await runGitOperation(
          'clone with an encrypted SSH key after an Agent clears GIT_SSH_COMMAND',
          root,
          ['clone', remote, join(root, 'encrypted')],
          environment
        );
      } finally {
        encryptedLease.release();
      }

      const incorrectKnownHosts = await ssh.incorrectKnownHosts();
      const untrustedEnvironment = await createGitEnvironment(join(root, 'untrusted-home'));
      untrustedService = new GitExecutionService({
        idleTimeoutMs: 10,
        directory: join(root, 'untrusted-runtime'),
        knownHostsFile: incorrectKnownHosts
      });
      const untrustedLease = await untrustedService.acquire(
        909,
        encryptedRuntime,
        untrustedEnvironment
      );
      try {
        await expect(
          runGit(
            root,
            ['clone', remote, join(root, 'untrusted')],
            executionEnvironment(untrustedEnvironment, untrustedLease.environment)
          )
        ).rejects.toThrow('The fixture command failed');
      } finally {
        untrustedLease.release();
      }

      await service.close();
      await untrustedService.close();
      closed = true;
      const runtimeContents = await contentsUnder(runtimeDirectory);
      expect(runtimeContents).not.toContain(plainKey.privateKey);
      expect(runtimeContents).not.toContain(encryptedKey.privateKey);
      expect(runtimeContents).not.toContain(passphrase);
    } finally {
      if (!closed) await service.close();
      if (!closed) await untrustedService?.close();
      await ssh.close();
      await removeDirectory(root);
    }
  });
});

function runtime(
  name: string,
  email: string,
  ...credentials: PersonalGitRuntime['credentials']
): PersonalGitRuntime {
  return {
    credentials: credentials.map((credential) => ({
      ...credential,
      commitName: credential.commitName || name,
      commitEmail: credential.commitEmail || email
    }))
  };
}

function httpsCredential(
  username: string,
  secret: string,
  server: GitHttpTestServer,
  pathPrefix: string
): PersonalGitRuntime['credentials'][number] {
  return {
    id: `${username}-${pathPrefix || 'all'}`,
    name: username,
    protocol: 'HTTPS',
    host: '127.0.0.1',
    port: server.port,
    pathPrefix,
    username,
    commitName: '',
    commitEmail: '',
    secret
  };
}

function sshCredential(
  id: string,
  server: GitSshTestServer,
  secret: string,
  passphrase?: string
): PersonalGitRuntime['credentials'][number] {
  return {
    id,
    name: id,
    protocol: 'SSH',
    host: '127.0.0.1',
    port: server.port,
    pathPrefix: '',
    username: server.username,
    commitName: '',
    commitEmail: '',
    secret,
    ...(passphrase === undefined ? {} : { passphrase })
  };
}

function portFromRemote(remote: string): number {
  const parsed = new URL(remote);
  return Number(parsed.port);
}

function executionEnvironment(
  baseEnvironment: Readonly<Record<string, string | undefined>>,
  environment: Readonly<Record<string, string>>
): Record<string, string | undefined> {
  return { ...process.env, ...baseEnvironment, ...environment };
}

function authenticatedUsers(
  attempts: readonly { readonly username: string | null; readonly authenticated: boolean }[]
): string[] {
  return attempts
    .filter((attempt) => attempt.authenticated && attempt.username !== null)
    .map((attempt) => attempt.username!);
}

function attemptedUsers(attempts: readonly { readonly username: string | null }[]): string[] {
  return attempts
    .filter((attempt): attempt is { readonly username: string } => attempt.username !== null)
    .map((attempt) => attempt.username!);
}

function assertNoSecretInEnvironment(
  environment: Readonly<Record<string, string>>,
  secrets: readonly string[]
): void {
  const values = Object.values(environment).join('\u0000');
  for (const secret of secrets) expect(values).not.toContain(secret);
}

async function runGitOperation(
  operation: string,
  cwd: string,
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): Promise<string> {
  try {
    return await runGit(cwd, args, environment);
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : 'The fixture command failed.';
    throw new Error(`Git operation failed: ${operation}. ${diagnostic}`);
  }
}

async function removeDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
