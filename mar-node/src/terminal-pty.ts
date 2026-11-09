import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { terminatePtyTree } from './terminal-pty-tree.mjs';
import type { TerminalPty, TerminalSpawnOptions } from './terminal.js';

type Exit = { exitCode: number; signal?: number };
type HostMessage =
  | { type: 'ready' }
  | { type: 'started'; pid: number }
  | { type: 'exit'; event: Exit }
  | { type: 'error'; code: string };
const CLOSE_TIMEOUT_MS = 2_000;
const START_TIMEOUT_MS = 10_000;
const MAX_PENDING_INPUT_BYTES = 1024 * 1024;

/** Owns one PTY host and its IPC, not terminal state, attachments or replay. */
export class TerminalPtyProcess implements TerminalPty {
  readonly pid: number | undefined;
  readonly closed: Promise<void>;
  readonly ready: Promise<void>;
  private child: ChildProcess | undefined;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: Exit) => void>();
  private readonly errorListeners = new Set<(code: string) => void>();
  private readonly closeFailures: unknown[] = [];
  private closing = false;
  private closeTimer: NodeJS.Timeout | undefined;
  private startTimer: NodeJS.Timeout | undefined;
  private nativePid: number | undefined;
  private exit: Exit | undefined;
  private failure: string | undefined;
  private pendingInputBytes = 0;
  private started = false;
  private forcing = false;
  private nativeCleanup: Promise<void> | undefined;
  private rejectReadiness: ((error: Error) => void) | undefined;

  constructor(
    child: ChildProcess = spawn(
      process.execPath,
      [fileURLToPath(new URL('./terminal-pty-host.mjs', import.meta.url))],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true
      }
    )
  ) {
    this.child = child;
    this.pid = child.pid;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (data: string) => {
      for (const listener of this.dataListeners) listener(data);
    });
    // Native diagnostics must not block the host or expose its spawn environment.
    child.stderr!.resume();
    let resolveReady!: () => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      this.rejectReadiness = reject;
    });
    // A standby can be closed without a caller waiting for warmup.
    void this.ready.catch(() => undefined);
    child.on('message', (message: HostMessage) => {
      if (message.type === 'ready') {
        if (this.closing || this.failure !== undefined) return;
        if (!this.started) clearTimeout(this.startTimer);
        resolveReady();
        this.rejectReadiness = undefined;
      }
      if (message.type === 'started') {
        this.nativePid = message.pid;
        clearTimeout(this.startTimer);
      }
      if (message.type === 'exit') {
        this.exit = message.event;
        // The native process is reaped; never signal this PID after it can be reused.
        this.nativePid = undefined;
      } else if (message.type === 'error') {
        this.reportError(message.code);
        this.kill();
      }
    });
    child.on('error', () => {
      this.reportError('TERMINAL_PTY_HOST_FAILED');
      this.kill();
    });
    this.closed = new Promise((resolve, reject) => {
      // Unlike exit, close also joins stdout: no terminal exit can overtake tail output.
      child.once('close', async (code, signal) => {
        clearTimeout(this.closeTimer);
        clearTimeout(this.startTimer);
        this.closeTimer = undefined;
        this.startTimer = undefined;
        this.child = undefined;
        const abnormal = this.exit === undefined || code !== 0 || signal !== null;
        const unexpected = abnormal && !this.forcing;
        let cleanupFailed = false;
        if (abnormal || this.nativeCleanup !== undefined) {
          // A crashed host cannot run its disconnect cleanup; finish its native lease here.
          try {
            await this.reapNative();
          } catch (error) {
            cleanupFailed = true;
            this.closeFailures.push(error);
          }
        }
        this.failReadiness(this.failure ?? 'TERMINAL_PTY_HOST_FAILED');
        try {
          if (unexpected || cleanupFailed) this.reportError('TERMINAL_PTY_HOST_FAILED');
          const event =
            unexpected || this.failure !== undefined
              ? { exitCode: 127 }
              : (this.exit ?? { exitCode: 127 });
          for (const listener of this.exitListeners) {
            try {
              listener(event);
            } catch (error) {
              this.closeFailures.push(error);
            }
          }
        } finally {
          this.dataListeners.clear();
          this.exitListeners.clear();
          this.errorListeners.clear();
          child.removeAllListeners();
          child.stdout!.removeAllListeners();
          this.nativeCleanup = undefined;
          const failures = this.closeFailures.splice(0);
          if (failures.length === 0) resolve();
          else {
            const error =
              failures.length === 1
                ? failures[0]
                : new AggregateError(failures, 'TERMINAL_PTY_CLOSE_FAILED');
            for (const failure of [...failures, error]) {
              if (failure instanceof Error) {
                try {
                  void failure.stack;
                } catch {
                  /* Formatters must not prevent cleanup settlement. */
                }
              }
            }
            reject(error);
          }
        }
      });
    });
    // Natural exit reports cleanup failures through onError even without a join caller.
    void this.closed.catch(() => undefined);
    this.watchStartup();
  }

  start(shell: string, args: readonly string[], options: TerminalSpawnOptions): this {
    if (this.started || this.closing || this.child === undefined)
      throw new Error('TERMINAL_PTY_CLOSED');
    this.started = true;
    this.watchStartup();
    // Private IPC keeps command arguments and secret environment values out of argv.
    this.send({ type: 'start', shell, args, options });
    return this;
  }

  write(data: string): void {
    const bytes = Buffer.byteLength(data);
    if (this.pendingInputBytes + bytes > MAX_PENDING_INPUT_BYTES)
      throw new Error('TERMINAL_BACKPRESSURE');
    this.pendingInputBytes += bytes;
    try {
      this.send({ type: 'input', data }, () => {
        this.pendingInputBytes -= bytes;
      });
    } catch (error) {
      this.pendingInputBytes -= bytes;
      throw error;
    }
  }

  resize(cols: number, rows: number): void {
    this.send({ type: 'resize', cols, rows });
  }

  kill(): boolean {
    if (this.child === undefined) return false;
    if (this.closing) return true;
    this.closing = true;
    this.closeTimer = setTimeout(() => {
      void this.forceClose();
    }, CLOSE_TIMEOUT_MS);
    this.send({ type: 'kill' });
    return true;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      }
    };
  }

  onExit(listener: (event: Exit) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      }
    };
  }

  onError(listener: (code: string) => void): { dispose(): void } {
    this.errorListeners.add(listener);
    return {
      dispose: () => {
        this.errorListeners.delete(listener);
      }
    };
  }

  private send(message: object, complete?: () => void): void {
    const child = this.child;
    if (child === undefined) throw new Error('TERMINAL_PTY_CLOSED');
    if (!child.connected) {
      complete?.();
      return;
    }
    child.send(message, (error) => {
      complete?.();
      if (error !== null && !this.closing) {
        this.reportError('TERMINAL_PTY_HOST_FAILED');
        this.kill();
      }
    });
  }

  private reportError(code: string): void {
    if (this.failure !== undefined) return;
    this.failure = code;
    for (const listener of this.errorListeners) {
      try {
        listener(code);
      } catch (error) {
        this.closeFailures.push(error);
      }
    }
  }

  private watchStartup(): void {
    clearTimeout(this.startTimer);
    this.startTimer = setTimeout(() => {
      this.failReadiness('TERMINAL_PTY_START_FAILED');
      this.reportError('TERMINAL_PTY_START_FAILED');
      this.kill();
    }, START_TIMEOUT_MS);
  }

  private failReadiness(code: string): void {
    if (this.rejectReadiness === undefined) return;
    const error = new Error(code);
    try {
      void error.stack;
    } catch {
      /* Keep the original startup error even if a custom formatter fails. */
    }
    this.rejectReadiness(error);
    this.rejectReadiness = undefined;
  }

  private reapNative(root: number | undefined = this.nativePid): Promise<void> {
    return (this.nativeCleanup ??= terminatePtyTree(root));
  }

  private async forceClose(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    this.forcing = true;
    try {
      await this.reapNative(this.nativePid ?? child.pid);
    } catch {
      if (this.child === child) this.reportError('TERMINAL_PTY_HOST_FAILED');
    } finally {
      if (this.child === child) child.kill('SIGKILL');
    }
  }
}
