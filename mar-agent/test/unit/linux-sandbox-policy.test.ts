import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { compileBubblewrapPolicy } from '../../src/sandbox/linux/bubblewrap-policy.js';
import { BubblewrapSandboxExecutor } from '../../src/sandbox/linux/index.js';
import { LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION as version } from '../../src/sandbox/linux/profile.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

it.skipIf(process.platform !== 'linux').each(['original', 'replacement'] as const)(
  'uses the original cancellation signal when the %s signal is aborted during compilation',
  async (abortedSignal) => {
    const root = await mkdtemp(join(tmpdir(), 'mar-policy-signal-'));
    directories.push(root);
    const backend = join(root, 'backend');
    await writeFile(backend, 'unused', { mode: 0o700 });
    const original = new AbortController();
    const replacement = new AbortController();
    const reason = new Error('operation cancelled');
    const request = {
      command: '/bin/true',
      cwd: root,
      environment: {},
      detached: true,
      signal: original.signal
    };
    const result = new BubblewrapSandboxExecutor({
      bubblewrapPath: backend,
      profile: { policyVersion: version, workingDirectory: { kind: 'REQUEST' } }
    })
      .spawn(request)
      .catch((error: unknown) => error);
    request.signal = replacement.signal;
    (abortedSignal === 'original' ? original : replacement).abort(reason);
    if (abortedSignal === 'original') expect(await result).toBe(reason);
    else expect(await result).toMatchObject({ code: 'SANDBOX_POLICY_INVALID' });
  }
);

it.skipIf(process.platform !== 'linux')(
  'compiles mount, cwd and filtered environment without executing bwrap',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-policy-'));
    directories.push(root);
    const backend = join(root, 'backend');
    const source = join(root, 'source');
    await writeFile(backend, 'unused');
    await chmod(backend, 0o700);
    await mkdir(source);
    await mkdir(join(source, 'sub'));
    const profile = {
      policyVersion: version,
      mounts: [{ source, destination: '/project', access: 'READ_ONLY' as const }],
      workingDirectory: { kind: 'REQUEST' as const }
    };
    const spec = await compileBubblewrapPolicy({ profile }, backend, {
      command: '/bin/true',
      cwd: join(source, 'sub'),
      environment: { SAFE: 'yes', PATH: 'host-secret', HIDDEN: 'host-secret' },
      environmentKeys: ['SAFE', 'PATH'],
      detached: true
    });
    expect(spec.arguments).toContain('--unshare-net');
    expect(spec.arguments).toContainEqual('/project/sub');
    expect(spec.arguments).toContainEqual(source);
    expect(spec.arguments).toContainEqual('yes');
    expect(spec.arguments).not.toContain('host-secret');
    await expect(
      compileBubblewrapPolicy(
        {
          profile: {
            ...profile,
            mounts: [{ source, destination: '/etc/unsafe', access: 'READ_WRITE' }]
          }
        },
        backend,
        { command: '/bin/true', cwd: '/', environment: {}, detached: true }
      )
    ).rejects.toMatchObject({ code: 'SANDBOX_POLICY_INVALID' });
  }
);
