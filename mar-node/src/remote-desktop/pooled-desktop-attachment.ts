import type { Duplex } from 'node:stream';
import { RemoteDesktopError } from './desktop-error.js';
import type { RemoteDesktopAttachment } from './remote-desktop-attachment.js';
import type { TigerVncBackendPool, TigerVncBackendReference } from './tigervnc-backend-pool.js';

/** Acquires a Remote-owned backend after OPEN and releases it after connection cleanup. */
export class PooledDesktopAttachment {
  readonly #cancel = new AbortController();
  #reference: TigerVncBackendReference | undefined;
  #attachment: RemoteDesktopAttachment | undefined;
  #opening: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #closed = false;
  #started = false;

  constructor(
    private readonly pool: TigerVncBackendPool,
    private readonly frontend: Duplex,
    private readonly create: (
      backend: TigerVncBackendReference['backend']
    ) => RemoteDesktopAttachment
  ) {}

  open(signal: AbortSignal): Promise<void> {
    if (this.#started || this.#closed)
      return Promise.reject(new RemoteDesktopError('DESKTOP_RFB_CLOSED'));
    this.#started = true;
    const deadline = AbortSignal.any([signal, this.#cancel.signal]);
    this.#opening = (async () => {
      this.#reference = await this.pool.acquire(deadline);
      if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
      this.#attachment = this.create(this.#reference.backend);
      await this.#attachment.open(deadline);
    })();
    return this.#opening;
  }

  close(signal: AbortSignal): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closing) return this.#closing;
    this.#cancel.abort();
    // Fence synchronously, even if startup or native cleanup is still pending.
    const closing = this.#attachment?.close(signal).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error })
    );
    if (!this.#attachment) this.frontend.destroy();
    this.#closing = (async () => {
      await this.#opening?.catch(() => {});
      if (closing) {
        const result = await closing;
        if (!result.ok) throw result.error;
      } else if (this.#attachment) await this.#attachment.close(signal);
      if (this.#reference) await this.#reference.release();
      this.#reference = undefined;
      this.#attachment = undefined;
      this.#closed = true;
    })().finally(() => {
      this.#closing = undefined;
    });
    return this.#closing;
  }
}
