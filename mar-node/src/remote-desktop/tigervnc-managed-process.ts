import { RemoteDesktopError } from './desktop-error.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, open, rm, stat, unlink } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { handshakeRfbBackend } from './rfb-backend-handshake.js';
import { TigerVncCleanupChannel } from './tigervnc-cleanup-channel.js';

interface TigerVncProcessOptions {
  binaryPath: string;
  display: string;
  xAuthority: string;
  onUnexpectedExit(): void;
}

type BackendRfbInit = Awaited<ReturnType<typeof handshakeRfbBackend>>;

function obfuscatePassword(secret: Buffer): Buffer {
  // TigerVNC's password file is an obfuscation, not a security boundary.
  const key = Buffer.from('e84ad660c4721ae0'.repeat(3), 'hex');
  try {
    const cipher = createCipheriv('des-ede3', key, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(secret), cipher.final()]);
  } finally {
    key.fill(0);
  }
}

/** Owns one local TigerVNC process and private control stream, never a control lease. */
export class TigerVncManagedProcess {
  readonly #connections = new Set<Socket>();
  readonly #exited: Promise<void>;
  #stopping = false;
  #ready = false;
  #didExit = false;
  #notified = false;
  #stopPromise: Promise<void> | undefined;
  #directoryCleanup: Promise<void> | undefined;

  private constructor(
    private readonly child: ChildProcess,
    private readonly directory: string,
    private readonly socketPath: string,
    private readonly secret: Buffer,
    readonly cleanup: TigerVncCleanupChannel,
    private readonly onUnexpectedExit: () => void
  ) {
    this.#exited = new Promise((resolve) => {
      child.once('close', () => {
        this.#didExit = true;
        this.secret.fill(0);
        this.#notifyFailure();
        this.#directoryCleanup = rm(this.directory, { recursive: true, force: true });
        void this.#directoryCleanup.catch(() => {});
        resolve();
      });
    });
    child.on('error', () => {});
    child.stderr?.resume();
  }

  static async start(
    options: TigerVncProcessOptions,
    signal: AbortSignal
  ): Promise<TigerVncManagedProcess> {
    if (
      process.platform !== 'linux' ||
      !isAbsolute(options.binaryPath) ||
      !options.display ||
      !isAbsolute(options.xAuthority)
    )
      throw new RemoteDesktopError('DESKTOP_BACKEND_CONFIG_INVALID');
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_TIMEOUT');
    let directory: string;
    try {
      directory = await mkdtemp(join(tmpdir(), 'mar-rfb-'));
    } catch {
      throw new RemoteDesktopError('DESKTOP_BACKEND_START_FAILED');
    }
    const socketPath = join(directory, 'rfb.sock');
    const passwordPath = join(directory, 'password');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const secret = randomBytes(8);
    for (let i = 0; i < secret.length; i++) secret[i] = alphabet.charCodeAt(secret[i]! & 63);
    let backend: TigerVncManagedProcess | undefined;
    try {
      const file = await open(passwordPath, 'wx', 0o600);
      try {
        const obfuscated = obfuscatePassword(secret);
        try {
          await file.writeFile(obfuscated);
        } finally {
          obfuscated.fill(0);
        }
        // The inherited descriptor keeps the unlinked password available only
        // to this backend; a crashed Node leaves no password file behind.
        await unlink(passwordPath);
        const child = spawn(
          options.binaryPath,
          [
            '-display',
            options.display,
            '-rfbport',
            '-1',
            '-rfbunixpath',
            socketPath,
            '-rfbunixmode',
            '0600',
            '-SecurityTypes',
            'VncAuth',
            '-PasswordFile',
            '/proc/self/fd/4',
            '-AlwaysShared',
            '-AcceptSetDesktopSize=0',
            '-MaxCutText=1048576'
          ],
          {
            env: {
              PATH: '/usr/bin:/bin',
              HOME: directory,
              DISPLAY: options.display,
              XAUTHORITY: options.xAuthority,
              MAR_RFB_CONTROL_FD: '3'
            },
            stdio: ['ignore', 'ignore', 'pipe', 'pipe', file.fd]
          }
        );
        const control = child.stdio[3];
        if (!(control instanceof Duplex)) {
          child.on('error', () => {});
          child.kill();
          await new Promise<void>((resolve) => child.once('close', () => resolve()));
          throw new RemoteDesktopError('DESKTOP_BACKEND_START_FAILED');
        }
        backend = new TigerVncManagedProcess(
          child,
          directory,
          socketPath,
          secret,
          new TigerVncCleanupChannel(control),
          options.onUnexpectedExit
        );
      } finally {
        await file.close();
      }

      while (!deadline.aborted) {
        if (
          backend.#didExit ||
          backend.child.exitCode !== null ||
          backend.child.signalCode !== null
        )
          throw new RemoteDesktopError('DESKTOP_BACKEND_START_FAILED');
        try {
          const info = await stat(socketPath);
          if (!info.isSocket() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.())
            throw new RemoteDesktopError('DESKTOP_BACKEND_SOCKET_INVALID');
          if (backend.#didExit) throw new RemoteDesktopError('DESKTOP_BACKEND_START_FAILED');
          backend.#ready = true;
          return backend;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await delay(25, undefined, { signal: deadline });
      }
      throw new RemoteDesktopError('DESKTOP_SETUP_TIMEOUT');
    } catch (error) {
      try {
        if (backend) await backend.forceStop();
        else {
          secret.fill(0);
          await rm(directory, { recursive: true, force: true });
        }
      } catch {
        throw new RemoteDesktopError('DESKTOP_BACKEND_STOP_FAILED');
      }
      if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_TIMEOUT');
      if (error instanceof RemoteDesktopError) throw error;
      throw new RemoteDesktopError('DESKTOP_BACKEND_START_FAILED');
    }
  }

  async connect(
    maxPixels: number,
    signal: AbortSignal
  ): Promise<{ socket: Socket; init: BackendRfbInit }> {
    if (this.#stopping || this.child.exitCode !== null || this.child.signalCode !== null)
      throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_TIMEOUT');
    const socket = connect(this.socketPath);
    this.#connections.add(socket);
    socket.once('close', () => this.#connections.delete(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          socket.off('connect', connected);
          socket.off('error', failed);
          deadline.removeEventListener('abort', aborted);
        };
        const connected = () => {
          cleanup();
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(new RemoteDesktopError('DESKTOP_BACKEND_CLOSED'));
        };
        const aborted = () => {
          cleanup();
          reject(new RemoteDesktopError('DESKTOP_SETUP_TIMEOUT'));
        };
        socket.once('connect', connected);
        socket.once('error', failed);
        if (deadline.aborted) aborted();
        else deadline.addEventListener('abort', aborted, { once: true });
      });
      const init = await handshakeRfbBackend(socket, this.secret, maxPixels, deadline);
      return { socket, init };
    } catch (error) {
      const ignoreLateError = () => {};
      socket.on('error', ignoreLateError);
      socket.once('close', () => socket.off('error', ignoreLateError));
      socket.destroy();
      if (error instanceof RemoteDesktopError) throw error;
      throw new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR');
    }
  }

  stop(): Promise<void> {
    if (this.#connections.size || this.cleanup.outstanding)
      return Promise.reject(new RemoteDesktopError('DESKTOP_NATIVE_ATTACHMENTS_ACTIVE'));
    return this.#stop();
  }

  /** Terminates an unusable backend; this never confirms or releases any lease. */
  forceStop(): Promise<void> {
    return this.#stop();
  }

  #stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopping = true;
    this.#stopPromise = (async () => {
      for (const socket of this.#connections) socket.destroy();
      this.cleanup.dispose();
      const timeout = await Promise.race([
        this.#exited.then(() => false),
        delay(5_000, undefined, { ref: false }).then(() => true)
      ]);
      if (timeout) {
        this.child.kill('SIGKILL');
        const stillRunning = await Promise.race([
          this.#exited.then(() => false),
          delay(5_000, undefined, { ref: false }).then(() => true)
        ]);
        if (stillRunning) throw new RemoteDesktopError('DESKTOP_BACKEND_STOP_FAILED');
      }
      try {
        await (this.#directoryCleanup ??= rm(this.directory, { recursive: true, force: true }));
      } catch {
        this.#directoryCleanup = undefined;
        throw new RemoteDesktopError('DESKTOP_BACKEND_STOP_FAILED');
      }
    })();
    const stopping = this.#stopPromise;
    void stopping.catch(() => {
      if (this.#stopPromise === stopping) this.#stopPromise = undefined;
    });
    return this.#stopPromise;
  }

  #notifyFailure(): void {
    if (!this.#ready || this.#stopping || this.#notified) return;
    this.#notified = true;
    this.onUnexpectedExit();
  }
}
