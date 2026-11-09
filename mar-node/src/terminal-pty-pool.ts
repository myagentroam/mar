import { TerminalPtyProcess } from './terminal-pty.js';
import type { TerminalSpawnOptions } from './terminal.js';

/** Owns one warm, unassigned host. Active hosts transfer to TerminalManager's proxies. */
export class TerminalPtyPool {
  private standby: TerminalPtyProcess | undefined;
  private refillTimer: NodeJS.Timeout | undefined;
  private closing: Promise<void> | undefined;

  warmup(): Promise<void> {
    this.refill();
    if (this.standby === undefined) return Promise.reject(new Error('TERMINAL_PTY_CLOSED'));
    return this.standby.ready;
  }

  open(shell: string, args: readonly string[], options: TerminalSpawnOptions): TerminalPtyProcess {
    if (this.closing !== undefined) throw new Error('TERMINAL_PTY_CLOSED');
    clearTimeout(this.refillTimer);
    const host = this.standby ?? new TerminalPtyProcess();
    // A rejected handoff remains owned here until its physical close settles.
    this.standby = host;
    const active = host.start(shell, args, options);
    this.standby = undefined;
    // Handoff changes ownership; ending an active host must never refill the pool.
    this.refill();
    return active;
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    clearTimeout(this.refillTimer);
    const host = this.standby;
    this.standby = undefined;
    this.closing = host?.closed ?? Promise.resolve();
    host?.kill();
    return this.closing;
  }

  private refill(): void {
    if (this.closing !== undefined || this.standby !== undefined) return;
    const host = new TerminalPtyProcess();
    this.standby = host;
    const ended = () => {
      if (this.standby !== host) return;
      this.standby = undefined;
      // Avoid a hot spawn loop when the runtime or native installation is broken.
      this.refillTimer = setTimeout(() => this.refill(), 1_000);
    };
    void host.closed.then(ended, ended);
  }
}
