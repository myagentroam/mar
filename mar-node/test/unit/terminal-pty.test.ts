import { createRequire } from 'node:module';
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TerminalManager, nodePtyFactory } from '../../src/terminal.js';
import { TerminalPtyPool } from '../../src/terminal-pty-pool.js';
import { TerminalPtyProcess } from '../../src/terminal-pty.js';

const options = { name: 'xterm', cols: 80, rows: 24, cwd: tmpdir(), env: process.env };
const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
const commandArgs = (command: string) =>
  process.platform === 'win32' ? ['/D', '/C', command] : ['-c', command];

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return false;
    }
    return true;
  } catch (error) {
    if (!['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    return false;
  }
}

const nativeTree = `const {spawn}=require('node:child_process');
process.on('SIGHUP',()=>{});
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
process.stdout.write('NATIVE_PIDS '+process.pid+' '+child.pid+'\\n');setInterval(()=>{},1000);`;

function rawHost() {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../src/terminal-pty-host.mjs', import.meta.url))],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    }
  );
  child.stderr!.resume();
  return child;
}

describe('isolated terminal PTY', () => {
  it.runIf(process.platform !== 'win32')(
    'keeps ownership when a closing standby refuses handoff',
    async () => {
      const pool = new TerminalPtyPool();
      const refused: TerminalPtyProcess[] = [];
      const failure = new Error('standby is closing');
      try {
        await pool.warmup();
        const start = vi
          .spyOn(TerminalPtyProcess.prototype, 'start')
          .mockImplementationOnce(function (this: TerminalPtyProcess) {
            refused.push(this);
            process.kill(this.pid!, 'SIGSTOP');
            this.kill();
            throw failure;
          });
        try {
          expect(() => pool.open(shell, [], options)).toThrow(failure);
        } finally {
          start.mockRestore();
        }
        await pool.close();
        expect(exists(refused[0]!.pid!)).toBe(false);
      } finally {
        for (const host of refused) host.kill();
        await Promise.all(refused.map((host) => host.closed));
        await pool.close();
      }
    }
  );

  it.each(['message', 'child-error'] as const)(
    'joins the failure watchdog even if a %s error observer throws',
    async (kind) => {
      const child = new ChildProcess();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      vi.spyOn(child, 'kill').mockImplementation(() => {
        child.emit('close', null, 'SIGKILL');
        return true;
      });
      vi.useFakeTimers();
      const pty = new TerminalPtyProcess(child);
      const failure = new Error('error observer failed');
      const exits: number[] = [];
      pty.onError(() => {
        throw failure;
      });
      pty.onExit(({ exitCode }) => exits.push(exitCode));
      try {
        child.emit('message', { type: 'ready' });
        if (kind === 'message')
          child.emit('message', { type: 'error', code: 'TERMINAL_PTY_HOST_FAILED' });
        else child.emit('error', new Error('native host failed'));
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(pty.closed).rejects.toBe(failure);
        expect(exits).toEqual([127]);
      } finally {
        child.emit('close', 0, null);
        await pty.closed.catch(() => undefined);
        vi.useRealTimers();
      }
    }
  );

  it.each(['error', 'exit'] as const)(
    'still delivers exit and rejects closed when a %s observer throws',
    async (kind) => {
      const child = new ChildProcess();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const pty = new TerminalPtyProcess(child);
      const failure = new Error('observer failed');
      const exits: number[] = [];
      if (kind === 'error')
        pty.onError(() => {
          throw failure;
        });
      else
        pty.onExit(() => {
          throw failure;
        });
      pty.onExit(({ exitCode }) => exits.push(exitCode));
      child.emit('message', { type: 'ready' });
      if (kind === 'exit') child.emit('message', { type: 'exit', event: { exitCode: 0 } });
      child.emit('close', kind === 'exit' ? 0 : 1, null);
      await expect(pty.closed).rejects.toBe(failure);
      expect(exits).toEqual([kind === 'exit' ? 0 : 127]);
    }
  );

  it('rejects readiness at its deadline and ignores a late ready message', async () => {
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    vi.useFakeTimers();
    const pty = new TerminalPtyProcess(child);
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      child.emit('message', { type: 'ready' });
      await expect(pty.ready).rejects.toThrow('TERMINAL_PTY_START_FAILED');
      expect(() => pty.start(shell, [], options)).toThrow('TERMINAL_PTY_CLOSED');
    } finally {
      child.emit('close', 0, null);
      await pty.closed;
      vi.useRealTimers();
    }
  });

  it('still rejects readiness and closes when a custom stack formatter throws', async () => {
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    vi.useFakeTimers();
    const pty = new TerminalPtyProcess(child);
    const original = Error.prepareStackTrace;
    try {
      Error.prepareStackTrace = () => {
        throw new Error('formatter failed');
      };
      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      Error.prepareStackTrace = original;
      child.emit('close', 0, null);
      await pty.closed;
      vi.useRealTimers();
    }
    await expect(pty.ready).rejects.toThrow('TERMINAL_PTY_START_FAILED');
  });

  it('starts a parent watchdog for a fatal runtime error even when native kill stalls', async () => {
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const killed = vi.spyOn(child, 'kill').mockImplementation(() => {
      child.emit('close', null, 'SIGKILL');
      return true;
    });
    vi.useFakeTimers();
    const pty = new TerminalPtyProcess(child);
    const errors: string[] = [];
    pty.onError((code) => errors.push(code));
    try {
      child.emit('message', { type: 'ready' });
      child.emit('message', { type: 'error', code: 'TERMINAL_PTY_HOST_FAILED' });
      expect(killed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      await pty.closed;
      expect(killed).toHaveBeenCalledExactlyOnceWith('SIGKILL');
      expect(errors).toEqual(['TERMINAL_PTY_HOST_FAILED']);
    } finally {
      child.emit('close', 0, null);
      await pty.closed;
      vi.useRealTimers();
    }
  });

  it('does not trust an exit IPC message after abnormal host termination', async () => {
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const pty = new TerminalPtyProcess(child);
    const events: string[] = [];
    pty.onError((code) => events.push(code));
    pty.onExit(({ exitCode }) => events.push(`exit:${exitCode}`));
    child.emit('message', { type: 'ready' });
    child.emit('message', { type: 'exit', event: { exitCode: 0 } });
    child.emit('close', 1, null);
    await pty.closed;
    expect(events).toEqual(['TERMINAL_PTY_HOST_FAILED', 'exit:127']);
  });

  it.runIf(process.platform !== 'win32').each([false, true])(
    'reports OS cleanup failures only while the native lease is active (reaped=%s)',
    async (reaped) => {
      const directory = await mkdtemp(join(tmpdir(), 'mar-missing-ps-'));
      const fixture = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        stdio: 'ignore'
      });
      const fixtureExited = once(fixture, 'exit');
      const child = new ChildProcess();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const pty = new TerminalPtyProcess(child);
      const errors: string[] = [];
      pty.onError((code) => errors.push(code));
      const oldPath = process.env['PATH'];
      try {
        await once(fixture, 'spawn');
        child.emit('message', { type: 'ready' });
        child.emit('message', { type: 'started', pid: fixture.pid });
        if (reaped) child.emit('message', { type: 'exit', event: { exitCode: 0 } });
        process.env['PATH'] = directory;
        child.emit('close', 1, null);
        if (reaped) await expect(pty.closed).resolves.toBeUndefined();
        else await expect(pty.closed).rejects.toMatchObject({ code: 'ENOENT' });
        expect(errors).toEqual(['TERMINAL_PTY_HOST_FAILED']);
        // An ended lease must not signal a PID that may now belong to another process.
        expect(exists(fixture.pid!)).toBe(true);
      } finally {
        if (oldPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = oldPath;
        fixture.kill('SIGKILL');
        await fixtureExited;
        child.emit('close', 0, null);
        await pty.closed.catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === 'linux')(
    'activates exactly one standby at startup, not construction',
    async () => {
      const hosts = () =>
        execFileSync('ps', ['-o', 'pid=,args=', '--ppid', String(process.pid)], {
          encoding: 'utf8'
        })
          .split('\n')
          .filter((line) => line.includes('terminal-pty-host.mjs'))
          .map((line) => parseInt(line, 10));
      const before = new Set(hosts());
      const manager = new TerminalManager();
      try {
        expect(hosts().filter((pid) => !before.has(pid))).toEqual([]);
        await manager.warmup();
        const standby = hosts().filter((pid) => !before.has(pid));
        expect(standby).toHaveLength(1);
        await manager.warmup();
        expect(hosts().filter((pid) => !before.has(pid))).toEqual(standby);
        await manager.shutdown();
        expect(standby.some(exists)).toBe(false);
        // NodeLifecycle can activate the same manager again after a completed stop.
        await manager.warmup();
        expect(hosts().filter((pid) => !before.has(pid))).toHaveLength(1);
      } finally {
        await manager.shutdown();
      }
      expect(hosts().filter((pid) => !before.has(pid))).toEqual([]);
    }
  );

  it.runIf(process.platform !== 'win32')(
    'bounds a native spawn that never acknowledges startup',
    async () => {
      const pty = new TerminalPtyProcess();
      const errors: string[] = [];
      pty.onError((code) => errors.push(code));
      try {
        await pty.ready;
        process.kill(pty.pid!, 'SIGSTOP');
        vi.useFakeTimers();
        pty.start(shell, [], options);
        await vi.advanceTimersByTimeAsync(12_000);
        await pty.closed;
        expect(errors).toEqual(['TERMINAL_PTY_START_FAILED']);
        expect(exists(pty.pid!)).toBe(false);
      } finally {
        vi.useRealTimers();
        pty.kill();
        await pty.closed;
      }
    }
  );

  it('keeps the native addon out of the main Node process', async () => {
    const require = createRequire(import.meta.url);
    const pty = nodePtyFactory(shell, commandArgs('echo isolated'), options);
    try {
      expect(pty.pid).not.toBe(process.pid);
      expect(pty.closed).toBeInstanceOf(Promise);
      await pty.closed;
      expect(require.cache[require.resolve('node-pty')]).toBeUndefined();
      expect(exists(pty.pid!)).toBe(false);
    } finally {
      pty.kill();
      await pty.closed;
    }
  });

  it('reports a failed asynchronous spawn and physically releases its host', async () => {
    // A native spawn rejection, as opposed to a successfully started shell exiting 127.
    const pty = nodePtyFactory(shell, [], { ...options, cwd: 42 as unknown as string });
    const errors: string[] = [];
    const exits: number[] = [];
    pty.onError?.((code) => errors.push(code));
    pty.onExit(({ exitCode }) => exits.push(exitCode));
    await pty.closed;
    expect(errors).toEqual(['TERMINAL_PTY_START_FAILED']);
    expect(exits).toEqual([127]);
    expect(exists(pty.pid!)).toBe(false);
    expect(pty.kill()).toBe(false);
  });

  it('joins an immediate close without leaving a starting host behind', async () => {
    const pty = nodePtyFactory(shell, [], options);
    pty.kill();
    pty.kill();
    await pty.closed;
    expect(exists(pty.pid!)).toBe(false);
  });

  it('prewarms and replenishes one standby without reclaiming handed-off hosts', async () => {
    const pool = new TerminalPtyPool();
    const hosts: ReturnType<TerminalPtyPool['open']>[] = [];
    try {
      await pool.warmup();
      const first = pool.open(shell, [], options);
      hosts.push(first);
      await pool.warmup();
      const second = pool.open(shell, [], options);
      hosts.push(second);
      await pool.warmup();
      expect(first.pid).not.toBe(second.pid);
      await pool.close();
      expect(exists(first.pid!)).toBe(true);
      expect(exists(second.pid!)).toBe(true);
      expect(() => pool.open(shell, [], options)).toThrow('TERMINAL_PTY_CLOSED');
    } finally {
      for (const host of hosts) host.kill();
      await Promise.all(hosts.map((host) => host.closed));
      await pool.close();
    }
    expect(hosts.every((host) => !exists(host.pid!))).toBe(true);
  });

  it.runIf(process.platform !== 'win32')(
    'drains Unicode tail output before the physical exit',
    async () => {
      const pty = nodePtyFactory(
        process.execPath,
        ['-e', 'process.stdout.write("尾🙂".repeat(50000));process.exitCode=23'],
        options
      );
      let output = '';
      let exited = false;
      pty.onData((data) => {
        expect(exited).toBe(false);
        output += data;
      });
      pty.onExit(({ exitCode }) => {
        exited = true;
        expect(exitCode).toBe(23);
        expect(exists(pty.pid!)).toBe(false);
      });
      await pty.closed;
      expect(exited).toBe(true);
      expect(output).toBe('尾🙂'.repeat(50000));
    }
  );

  it.runIf(process.platform !== 'win32')(
    'reports an abruptly crashed host once without restarting it',
    async () => {
      const pty = nodePtyFactory(shell, [], options);
      const errors: string[] = [];
      const exits: number[] = [];
      pty.onError?.((code) => errors.push(code));
      pty.onExit(({ exitCode }) => exits.push(exitCode));
      try {
        pty.write("printf 'CRASH_READY\\n'\n");
        let output = '';
        pty.onData((data) => {
          output += data;
        });
        await expect.poll(() => output).toContain('CRASH_READY\r\n');
        process.kill(pty.pid!, 'SIGKILL');
        await pty.closed;
        expect(errors).toEqual(['TERMINAL_PTY_HOST_FAILED']);
        expect(exits).toEqual([127]);
        expect(exists(pty.pid!)).toBe(false);
      } finally {
        pty.kill();
        await pty.closed;
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'force-reaps a host that cannot process the close request',
    async () => {
      const pty = nodePtyFactory(process.execPath, ['-e', nativeTree], options);
      let pids: number[] = [];
      try {
        let output = '';
        pty.onData((data) => {
          output += data;
        });
        await expect.poll(() => output).toMatch(/NATIVE_PIDS \d+ \d+/u);
        pids = output
          .match(/NATIVE_PIDS (\d+) (\d+)/u)!
          .slice(1)
          .map(Number);
        process.kill(pty.pid!, 'SIGSTOP');
        pty.kill();
        await pty.closed;
        expect(exists(pty.pid!)).toBe(false);
        await expect.poll(() => pids.some(exists)).toBe(false);
      } finally {
        pty.kill();
        await pty.closed;
        for (const pid of pids) if (exists(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'reaps the native tree when its host crashes during an already requested close',
    async () => {
      const pty = nodePtyFactory(process.execPath, ['-e', nativeTree], options);
      let output = '';
      let pids: number[] = [];
      const errors: string[] = [];
      pty.onData((data) => {
        output += data;
      });
      pty.onError?.((code) => errors.push(code));
      try {
        await expect.poll(() => output).toMatch(/NATIVE_PIDS \d+ \d+/u);
        pids = output
          .match(/NATIVE_PIDS (\d+) (\d+)/u)!
          .slice(1)
          .map(Number);
        process.kill(pty.pid!, 'SIGSTOP');
        pty.kill();
        process.kill(pty.pid!, 'SIGKILL');
        await pty.closed;
        await expect.poll(() => pids.some(exists)).toBe(false);
        expect(errors).toEqual(['TERMINAL_PTY_HOST_FAILED']);
      } finally {
        pty.kill();
        await pty.closed;
        for (const pid of pids) if (exists(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'reaps native descendants independently after parent IPC disconnects',
    async () => {
      const host = rawHost();
      // Node 22 does not finish its close counter after a parent-initiated IPC disconnect.
      // exit is still the physical process join; output draining is covered separately.
      const exited = once(host, 'exit');
      let pids: number[] = [];
      let output = '';
      host.stdout!.setEncoding('utf8').on('data', (data: string) => {
        output += data;
      });
      try {
        await once(host, 'message');
        host.send({ type: 'start', shell: process.execPath, args: ['-e', nativeTree], options });
        await expect.poll(() => output).toMatch(/NATIVE_PIDS \d+ \d+/u);
        pids = output
          .match(/NATIVE_PIDS (\d+) (\d+)/u)!
          .slice(1)
          .map(Number);
        host.disconnect();
        await exited;
        await expect.poll(() => pids.some(exists)).toBe(false);
      } finally {
        if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
        await exited;
        for (const pid of pids) if (exists(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'drains a backpressured local output pipe before exiting',
    async () => {
      const host = rawHost();
      const closed = once(host, 'close');
      let bytes = 0;
      host.stdout!.on('data', (data: Buffer) => {
        bytes += data.byteLength;
      });
      host.stdout!.pause();
      try {
        await once(host, 'message');
        host.send({
          type: 'start',
          shell: process.execPath,
          args: ['-e', 'process.stdout.write("x".repeat(4*1024*1024))'],
          options
        });
        // Hold the local pipe beyond node-pty's normal exit-drain window.
        await new Promise((resolve) => setTimeout(resolve, 300));
        host.stdout!.resume();
        await closed;
        expect(bytes).toBe(4 * 1024 * 1024);
      } finally {
        host.stdout!.resume();
        if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
        await closed;
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'orders early input and resize after spawn, and joins manager close',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'mar-isolated-pty-'));
      let hostPid = 0;
      const manager = new TerminalManager({
        cwd: directory,
        profiles: [{ id: 'default', label: 'sh', shell, args: [], isDefault: true }],
        ptyFactory: (file, args, spawnOptions) => {
          const pty = nodePtyFactory(file, args, spawnOptions);
          hostPid = pty.pid!;
          return pty;
        }
      });
      let output = '';
      manager.onFrame((frame) => {
        if (frame.type === 'output') output += frame.data;
      });
      try {
        const terminal = manager.open();
        const attachment = manager.authorizeAttach({ terminalId: terminal.id });
        await manager.acceptFrame(attachment.attachmentId, {
          type: 'resize',
          terminalId: terminal.id,
          cols: 101,
          rows: 37
        });
        await manager.acceptFrame(attachment.attachmentId, {
          type: 'input',
          terminalId: terminal.id,
          data: "stty size; printf 'READY_OK\\n'\n"
        });
        await expect.poll(() => output).toContain('37 101');
        await expect.poll(() => output).toContain('READY_OK\r\n');
        await manager.close(terminal.id);
        expect(exists(hostPid)).toBe(false);
        expect(manager.get(terminal.id).state).toBe('CLOSED');
      } finally {
        await manager.shutdown();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
