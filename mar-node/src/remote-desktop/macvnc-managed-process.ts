import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RemoteDesktopError } from './desktop-error.js';
import { handshakeRfbBackend } from './rfb-backend-handshake.js';
import { obfuscateVncPassword } from './vnc-password.js';

interface MacVncOptions {
  readonly binaryPath: string;
  readonly displayIndex?: number;
  readonly onUnexpectedExit: () => void;
}

/** Owns one macVNC process and its authenticated loopback connections. */
export class MacVncManagedProcess {
  readonly #connections = new Set<Socket>();
  readonly #exited: Promise<void>;
  #stopping = false;
  #ready = false;
  #didExit = false;
  #stopPromise: Promise<void> | undefined;

  private constructor(
    private readonly child: ChildProcess,
    private readonly directory: string,
    private readonly port: number,
    private readonly secret: Buffer,
    private readonly onUnexpectedExit: () => void
  ) {
    child.on('error', () => {});
    child.stderr?.resume();
    this.#exited = new Promise((resolve) => {
      child.once('close', () => {
        this.#didExit = true;
        if (this.#ready && !this.#stopping) {
          try {
            this.onUnexpectedExit();
          } catch {
            // A notification failure must not prevent process cleanup.
          }
        }
        resolve();
      });
    });
  }

  static async start(options: MacVncOptions, signal: AbortSignal): Promise<MacVncManagedProcess> {
    if (process.platform !== 'darwin' || !isAbsolute(options.binaryPath))
      throw new RemoteDesktopError('DESKTOP_BACKEND_CONFIG_INVALID');
    if (
      options.displayIndex !== undefined &&
      (!Number.isInteger(options.displayIndex) ||
        options.displayIndex < 0 ||
        options.displayIndex >= 64)
    )
      throw new RemoteDesktopError('DESKTOP_BACKEND_CONFIG_INVALID');
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
    const directory = await mkdtemp(join(tmpdir(), 'mar-macvnc-'));
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const secret = randomBytes(8);
    for (let i = 0; i < secret.length; i++) secret[i] = alphabet.charCodeAt(secret[i]! & 63);
    let backend: MacVncManagedProcess | undefined;
    try {
      const port = await availableLoopbackPort();
      if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
      const config = join(directory, 'vnc-password');
      const encoded = obfuscateVncPassword(secret);
      try {
        await writeFile(config, encoded, { flag: 'wx', mode: 0o600 });
      } finally {
        encoded.fill(0);
      }
      if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
      const child = spawn(
        options.binaryPath,
        [
          '-rfbport',
          String(port),
          '-rfbportv6',
          '0',
          '-listen',
          '127.0.0.1',
          '-rfbauth',
          config,
          '-alwaysshared',
          ...(options.displayIndex === undefined ? [] : ['-display', String(options.displayIndex)])
        ],
        {
          cwd: dirname(options.binaryPath),
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe']
        }
      );
      backend = new MacVncManagedProcess(child, directory, port, secret, options.onUnexpectedExit);
      while (!deadline.aborted && !backend.#didExit) {
        try {
          const connection = await backend.connect(64 * 1024 * 1024, deadline);
          connection.socket.destroy();
          if (backend.#didExit || deadline.aborted)
            throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
          backend.#ready = true;
          return backend;
        } catch (error) {
          if (deadline.aborted || backend.#didExit) throw error;
          await delay(50, undefined, { signal: deadline });
        }
      }
      throw new RemoteDesktopError('DESKTOP_BACKEND_START_FAILED');
    } catch (error) {
      if (backend) await backend.stop();
      else {
        secret.fill(0);
        await rm(directory, { recursive: true, force: true });
      }
      if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
      if (error instanceof RemoteDesktopError) throw error;
      throw new RemoteDesktopError('DESKTOP_BACKEND_START_FAILED');
    }
  }

  async connect(maxPixels: number, signal: AbortSignal) {
    if (this.#stopping || this.#didExit) throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
    const socket = connect({ host: '127.0.0.1', port: this.port });
    this.#connections.add(socket);
    socket.once('close', () => this.#connections.delete(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          socket.off('connect', connected);
          socket.off('error', failed);
          signal.removeEventListener('abort', aborted);
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
          reject(new RemoteDesktopError('DESKTOP_SETUP_CANCELLED'));
        };
        socket.once('connect', connected);
        socket.once('error', failed);
        if (signal.aborted) aborted();
        else signal.addEventListener('abort', aborted, { once: true });
      });
      const init = await handshakeRfbBackend(socket, this.secret, maxPixels, signal);
      return { socket, init };
    } catch (error) {
      socket.on('error', () => {});
      socket.destroy();
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopping = true;
    this.#stopPromise = (async () => {
      for (const socket of this.#connections) socket.destroy();
      if (!this.#didExit) this.child.kill();
      const exited = await Promise.race([
        this.#exited.then(() => true),
        delay(5_000, undefined, { ref: false }).then(() => false)
      ]);
      if (!exited) throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
      this.secret.fill(0);
      await rm(this.directory, { recursive: true, force: true });
    })().catch((error) => {
      this.#stopPromise = undefined;
      throw error;
    });
    return this.#stopPromise;
  }
}

async function availableLoopbackPort(): Promise<number> {
  const listener = createServer();
  return new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (!address || typeof address === 'string')
        return listener.close(() => reject(new Error('port')));
      listener.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
