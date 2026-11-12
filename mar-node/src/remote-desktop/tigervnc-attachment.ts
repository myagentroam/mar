import { RemoteDesktopError } from './desktop-error.js';
import type { Duplex } from 'node:stream';
import type { RfbClientGate } from './rfb-client-gate.js';
import type { TigerVncCleanupTicket } from './tigervnc-cleanup-channel.js';

/** Owns one registered RFB stream and its native cleanup ticket, not the control lease. */
export class TigerVncAttachment {
  #phase: 'active' | 'waiting' | 'closed' = 'active';
  #closing = false;

  constructor(
    private readonly socket: Duplex,
    private readonly gate: RfbClientGate,
    private readonly ticket: TigerVncCleanupTicket
  ) {
    // A pending socket error can arrive after the gate has been disposed.
    socket.on('error', this.#ignoreLateError);
    socket.once('close', () => socket.off('error', this.#ignoreLateError));
  }

  readonly #ignoreLateError = (): void => {};

  async close(signal: AbortSignal): Promise<void> {
    if (this.#phase === 'closed') return;
    if (this.#closing) throw new RemoteDesktopError('DESKTOP_NATIVE_WAIT_IN_PROGRESS');
    this.#closing = true;
    try {
      if (this.#phase === 'active') {
        try {
          // An already-failed stream is still closed and must receive a native
          // cleanup receipt. A write callback alone never proves OS cleanup.
          await this.#waitForFence(signal);
        } finally {
          this.socket.destroy();
          this.gate.dispose();
          this.#phase = 'waiting';
        }
      }
      await this.ticket.wait(signal);
      this.#phase = 'closed';
    } finally {
      this.#closing = false;
    }
  }

  #waitForFence(signal: AbortSignal): Promise<void> {
    const fence = this.gate.fence();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (timedOut: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        if (timedOut) reject(new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_TIMEOUT'));
        else resolve();
      };
      const abort = () => finish(true);
      // A failed fence is followed by socket destruction and native cleanup;
      // the native receipt, not the failed write, decides whether it succeeded.
      fence.then(
        () => finish(false),
        () => finish(false)
      );
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }
}
