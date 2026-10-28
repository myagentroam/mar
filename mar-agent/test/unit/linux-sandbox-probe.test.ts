import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeBubblewrapSandbox } from '../../src/sandbox/linux/index.js';
import { waitForProbe } from '../../src/sandbox/linux/bubblewrap-probe.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function backend(body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mar-probe-test-'));
  directories.push(directory);
  const path = join(directory, 'bwrap');
  await writeFile(
    path,
    `#!/bin/sh\nif [ "$1" = --version ]; then echo 'bubblewrap 1.2.3'; exit 0; fi\n${body}\n`
  );
  await chmod(path, 0o700);
  return path;
}

describe.skipIf(process.platform !== 'linux')('Bubblewrap probe ownership', () => {
  it('probes every time without caching a prior success', async () => {
    const path = await backend('exit 0');
    await expect(probeBubblewrapSandbox({ bubblewrapPath: path })).resolves.toMatchObject({
      version: '1.2.3'
    });
    await writeFile(path, '#!/bin/sh\nexit 1\n');
    await expect(probeBubblewrapSandbox({ bubblewrapPath: path })).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE'
    });
  });
  it('does not publish untrusted probe stderr', async () => {
    const path = await backend("echo 'secret /private' >&2; exit 1");
    const error = await probeBubblewrapSandbox({ bubblewrapPath: path }).catch(
      (value: unknown) => value
    );
    expect(error).toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(JSON.stringify(error)).not.toContain('secret');
  });
  it('kills and waits for a timed out probe', async () => {
    const path = await backend('exec sleep 30');
    await expect(probeBubblewrapSandbox({ bubblewrapPath: path })).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE'
    });
  }, 10_000);
  it('bounds the version command even when it ignores SIGTERM', async () => {
    const path = await backend('exit 0');
    await writeFile(path, '#!/bin/sh\ntrap "" TERM\nexec sleep 30\n');
    await expect(probeBubblewrapSandbox({ bubblewrapPath: path })).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE'
    });
  }, 10_000);
  it('terminates the detached version probe group even after the leader exits', async () => {
    const path = await backend('exit 0');
    const pidFile = join(dirname(path), 'descendant-pid');
    await writeFile(
      path,
      `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\necho 'bubblewrap 0.11.0'\nexit 0\n`
    );
    let pid: number | undefined;
    const alive = async () => {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    };
    try {
      const error = await probeBubblewrapSandbox({ bubblewrapPath: path }).catch(
        (value: unknown) => value
      );
      pid = Number((await readFile(pidFile, 'utf8')).trim());
      expect(pid).toBeGreaterThan(1);
      expect(error).toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
      await vi.waitFor(async () => expect(await alive()).toBe(false), {
        timeout: 1500,
        interval: 25
      });
    } finally {
      if (pid !== undefined && pid > 1 && (await alive())) process.kill(pid, 'SIGKILL');
    }
  }, 10_000);
  it('terminates a successful version probe descendant that redirected its pipes', async () => {
    const path = await backend('exit 0');
    const pidFile = join(dirname(path), 'redirected-pid');
    await writeFile(
      path,
      `#!/bin/sh\nif [ "$1" = --version ]; then\n sleep 30 >/dev/null 2>&1 &\n echo $! > '${pidFile}'\n echo 'bubblewrap 0.11.0'\nfi\nexit 0\n`
    );
    let pid: number | undefined;
    const alive = async () => {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    };
    try {
      await expect(probeBubblewrapSandbox({ bubblewrapPath: path })).resolves.toMatchObject({
        version: '0.11.0'
      });
      pid = Number((await readFile(pidFile, 'utf8')).trim());
      expect(pid).toBeGreaterThan(1);
      await vi.waitFor(async () => expect(await alive()).toBe(false), {
        timeout: 1_500,
        interval: 25
      });
    } finally {
      if (pid !== undefined && pid > 1 && (await alive())) process.kill(pid, 'SIGKILL');
    }
  });
  it('rejects version output over its byte budget without exposing it', async () => {
    const path = await backend('exit 0');
    await writeFile(path, `#!/bin/sh\nprintf '%s' '${'x'.repeat(4_097)}'\n`);
    const error = await probeBubblewrapSandbox({ bubblewrapPath: path }).catch(
      (value: unknown) => value
    );
    expect(error).toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(JSON.stringify(error)).not.toContain('xxxx');
  });
  it.each(['throw', 'false'] as const)(
    'bounds probe cleanup when kill returns %s and close never arrives',
    async (kind) => {
      vi.useFakeTimers();
      try {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          exitCode: null,
          signalCode: null,
          kill: () => {
            if (kind === 'throw') throw new Error('secret');
            return false;
          },
          unref: () => undefined
        });
        const result = waitForProbe(child as unknown as ChildProcessWithoutNullStreams).catch(
          (error: unknown) => error
        );
        await vi.advanceTimersByTimeAsync(6_000);
        expect(await result).toMatchObject({
          code: 'SANDBOX_UNAVAILABLE',
          details: { cleanup: ['terminate', 'exit_timeout'] }
        });
        expect(child.listenerCount('close')).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    }
  );
  it('settles once when error and close race', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      unref: () => undefined,
      kill: () => {
        child.emit('close', null);
        return true;
      }
    });
    const result = waitForProbe(child as unknown as ChildProcessWithoutNullStreams).catch(
      (error: unknown) => error
    );
    child.emit('error', new Error('secret'));
    child.emit('close', 0);
    expect(await result).toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(child.listenerCount('close')).toBe(0);
  });
});
