import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TigerVncManagedProcess } from '../../src/remote-desktop/tigervnc-managed-process.js';

const directories: string[] = [];
const backends: TigerVncManagedProcess[] = [];
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.forceStop().catch(() => {})));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture(refuseAuthentication = false, ignoreControlClose = false) {
  const directory = await mkdtemp(join(tmpdir(), 'mar-vnc-test-'));
  directories.push(directory);
  const executable = join(directory, 'fake-vnc');
  const pidFile = join(directory, 'pid');
  const source = `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
if (fs.readFileSync('/proc/self/fd/4').length !== 8) process.exit(2);
if (fs.existsSync(process.env.HOME + '/password')) process.exit(3);
const path = process.argv[process.argv.indexOf('-rfbunixpath') + 1];
fs.writeFileSync(${JSON.stringify(join(directory, 'backend-home'))}, process.env.HOME);
const control = new net.Socket({ fd: 3, readable: true, writable: true });
const server = net.createServer();
if (${JSON.stringify(refuseAuthentication)}) server.on('connection', socket => {
  socket.write('RFB 003.008\\n');
  socket.once('data', () => socket.write(Buffer.from([1, 1])));
});
server.listen(path, () => { fs.chmodSync(path, 0o600); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); });
control.on('end', () => { if (!${JSON.stringify(ignoreControlClose)}) server.close(); });
control.on('error', () => { if (!${JSON.stringify(ignoreControlClose)}) server.close(); });
process.on('SIGUSR1', () => control.write('corrupt\\n'));
`;
  await writeFile(executable, source, { mode: 0o700 });
  return {
    executable,
    pidFile,
    homeFile: join(directory, 'backend-home'),
    xAuthority: join(directory, 'xauth')
  };
}

describe.skipIf(process.platform !== 'linux')('TigerVNC managed process', () => {
  it('settles after a forced kill has exited and removed its private directory', async () => {
    const { executable, xAuthority, pidFile, homeFile } = await fixture(false, true);
    const backend = await TigerVncManagedProcess.start(
      { binaryPath: executable, display: ':1', xAuthority, onUnexpectedExit: vi.fn() },
      AbortSignal.timeout(5_000)
    );
    backends.push(backend);
    const pid = Number(await readFile(pidFile, 'utf8'));
    const home = await readFile(homeFile, 'utf8');
    await expect(backend.stop()).resolves.toBeUndefined();
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(access(home)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(backend.stop()).resolves.toBeUndefined();
  }, 12_000);

  it('retries a failed stop after the owned process later exits', async () => {
    const { executable, xAuthority, pidFile, homeFile } = await fixture(false, true);
    const backend = await TigerVncManagedProcess.start(
      { binaryPath: executable, display: ':1', xAuthority, onUnexpectedExit: vi.fn() },
      AbortSignal.timeout(5_000)
    );
    backends.push(backend);
    const pid = Number(await readFile(pidFile, 'utf8'));
    const home = await readFile(homeFile, 'utf8');
    const kill = ChildProcess.prototype.kill;
    const spy = vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(function (
      this: ChildProcess,
      signal
    ) {
      if (this.pid === pid && signal === 'SIGKILL') return true;
      return kill.call(this, signal);
    });
    try {
      await expect(backend.stop()).rejects.toMatchObject({ code: 'DESKTOP_BACKEND_STOP_FAILED' });
      process.kill(pid, 'SIGKILL');
      await expect(backend.stop()).resolves.toBeUndefined();
      await expect(access(home)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      spy.mockRestore();
    }
  }, 16_000);
  it('preserves the credential-free handshake error through the managed connection', async () => {
    const { executable, xAuthority } = await fixture(true);
    const backend = await TigerVncManagedProcess.start(
      { binaryPath: executable, display: ':1', xAuthority, onUnexpectedExit: vi.fn() },
      AbortSignal.timeout(5_000)
    );
    backends.push(backend);
    await expect(backend.connect(1_000_000, AbortSignal.timeout(5_000))).rejects.toMatchObject({
      code: 'DESKTOP_BACKEND_AUTH_UNAVAILABLE',
      message: 'The desktop backend does not offer required authentication.'
    });
  });
  it('stops its own process only after its attachment tickets are settled', async () => {
    const { executable, xAuthority } = await fixture();
    const onUnexpectedExit = vi.fn();
    const backend = await TigerVncManagedProcess.start(
      { binaryPath: executable, display: ':1', xAuthority, onUnexpectedExit },
      AbortSignal.timeout(5_000)
    );
    backends.push(backend);
    const ticket = backend.cleanup.issue();
    await expect(backend.stop()).rejects.toMatchObject({
      code: 'DESKTOP_NATIVE_ATTACHMENTS_ACTIVE',
      message: expect.any(String)
    });
    const pending = expect(ticket.wait(new AbortController().signal)).rejects.toMatchObject({
      code: 'DESKTOP_NATIVE_CHANNEL_CLOSED',
      message: expect.any(String)
    });
    await backend.forceStop();
    await pending;
    expect(onUnexpectedExit).not.toHaveBeenCalled();
  });

  it('notifies once and fails pending cleanup if its owned process exits unexpectedly', async () => {
    const { executable, xAuthority, pidFile } = await fixture();
    const onUnexpectedExit = vi.fn();
    const backend = await TigerVncManagedProcess.start(
      { binaryPath: executable, display: ':1', xAuthority, onUnexpectedExit },
      AbortSignal.timeout(5_000)
    );
    backends.push(backend);
    const ticket = backend.cleanup.issue();
    const pending = expect(ticket.wait(new AbortController().signal)).rejects.toMatchObject({
      code: 'DESKTOP_NATIVE_CHANNEL_CLOSED',
      message: expect.any(String)
    });
    const pid = Number(await readFile(pidFile, 'utf8'));
    process.kill(pid, 'SIGKILL');
    await pending;
    await vi.waitFor(() => expect(onUnexpectedExit).toHaveBeenCalledOnce());
    await backend.forceStop();
    expect(onUnexpectedExit).toHaveBeenCalledOnce();
  });

  it('fails closed and stops the backend on malformed native control data', async () => {
    const { executable, xAuthority, pidFile } = await fixture();
    const onUnexpectedExit = vi.fn();
    const backend = await TigerVncManagedProcess.start(
      { binaryPath: executable, display: ':1', xAuthority, onUnexpectedExit },
      AbortSignal.timeout(5_000)
    );
    backends.push(backend);
    const ticket = backend.cleanup.issue();
    const pending = expect(ticket.wait(new AbortController().signal)).rejects.toMatchObject({
      code: 'DESKTOP_NATIVE_CHANNEL_CLOSED',
      message: expect.any(String)
    });
    process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGUSR1');
    await pending;
    await vi.waitFor(() => expect(onUnexpectedExit).toHaveBeenCalledOnce());
    await backend.forceStop();
    expect(onUnexpectedExit).toHaveBeenCalledOnce();
  });

  it('rejects invalid configuration and a missing executable without advertising readiness', async () => {
    const { xAuthority } = await fixture();
    const onUnexpectedExit = vi.fn();
    await expect(
      TigerVncManagedProcess.start(
        { binaryPath: 'relative', display: ':1', xAuthority, onUnexpectedExit },
        AbortSignal.timeout(1_000)
      )
    ).rejects.toMatchObject({
      code: 'DESKTOP_BACKEND_CONFIG_INVALID',
      message: expect.any(String)
    });
    await expect(
      TigerVncManagedProcess.start(
        {
          binaryPath: join(tmpdir(), 'missing-mar-vnc-executable'),
          display: ':1',
          xAuthority,
          onUnexpectedExit
        },
        AbortSignal.timeout(1_000)
      )
    ).rejects.toMatchObject({ code: 'DESKTOP_BACKEND_START_FAILED', message: expect.any(String) });
    expect(onUnexpectedExit).not.toHaveBeenCalled();
  });
});
