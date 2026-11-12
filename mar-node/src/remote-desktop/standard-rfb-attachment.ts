import type { Duplex } from 'node:stream';
import type { RfbClientGate } from './rfb-client-gate.js';
import { submitRfbInputRelease } from './rfb-input-release.js';

/** Owns a standard RFB connection; submitted releases are not OS execution receipts. */
export class StandardRfbAttachment {
  #closing: Promise<void> | undefined;
  #closed = false;

  constructor(
    private readonly socket: Duplex,
    private readonly gate: RfbClientGate
  ) {
    socket.on('error', this.#ignoreLateError);
    socket.once('close', () => socket.off('error', this.#ignoreLateError));
  }

  readonly #ignoreLateError = (): void => {};

  close(signal: AbortSignal): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closing) return this.#closing;
    this.#closing = this.#close(signal).finally(() => {
      this.#closing = undefined;
    });
    return this.#closing;
  }

  async #close(signal: AbortSignal): Promise<void> {
    try {
      // A lost backend cannot accept releases; still reclaim this attachment.
      await submitRfbInputRelease(this.gate, this.socket, signal).catch(() => {});
    } finally {
      const closed = this.socket.closed
        ? Promise.resolve()
        : new Promise<void>((resolve) => this.socket.once('close', resolve));
      this.socket.destroy();
      this.gate.dispose();
      await closed;
      this.#closed = true;
    }
  }
}
