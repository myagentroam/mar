import { RemoteDesktopError } from './desktop-error.js';
import {
  TigerVncRfbSession,
  TigerVncSetupCleanupError,
  type TigerVncRfbSessionOptions
} from './tigervnc-rfb-session.js';

interface AttachmentOptions extends Omit<TigerVncRfbSessionOptions, 'isControlOwner'> {
  readonly attachmentId: string;
}

/** Owns one Remote attachment and its cleanup, never the shared backend. */
export class RemoteDesktopAttachment {
  #state: 'new' | 'opening' | 'active' | 'cleanup' | 'closed' = 'new';
  #session: TigerVncRfbSession | undefined;
  #pendingCleanup: TigerVncSetupCleanupError | undefined;
  #opening: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #closeRequested = false;
  readonly #cancel = new AbortController();

  constructor(private readonly options: AttachmentOptions) {
    if (!options.attachmentId) throw new RemoteDesktopError('DESKTOP_BACKEND_CONFIG_INVALID');
  }

  open(signal: AbortSignal): Promise<void> {
    if (this.#state !== 'new') return Promise.reject(new RemoteDesktopError('DESKTOP_RFB_CLOSED'));
    if (signal.aborted) return Promise.reject(new RemoteDesktopError('DESKTOP_SETUP_CANCELLED'));
    this.#state = 'opening';
    this.#opening = this.#start(AbortSignal.any([signal, this.#cancel.signal]));
    return this.#opening;
  }

  close(signal: AbortSignal): Promise<void> {
    if (this.#state === 'closed') return Promise.resolve();
    if (this.#closing) return this.#closing;
    this.#closeRequested = true;
    this.#state = 'cleanup';
    this.#cancel.abort();
    if (this.#session) this.#session.fence();
    else this.options.frontend.destroy();
    this.#closing = (async () => {
      await this.#opening?.catch(() => {});
      await this.#finishCleanup(signal);
      this.#state = 'closed';
    })().finally(() => {
      this.#closing = undefined;
    });
    return this.#closing;
  }

  async #start(signal: AbortSignal): Promise<void> {
    try {
      this.#session = await TigerVncRfbSession.open(
        {
          ...this.options,
          isControlOwner: () => !this.#closeRequested,
          onFailure: (code) => {
            void this.close(AbortSignal.timeout(5_000)).catch(() => {});
            this.options.onFailure(code);
          }
        },
        signal
      );
      if (this.#closeRequested || signal.aborted)
        throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
      this.#state = 'active';
    } catch (error) {
      if (error instanceof TigerVncSetupCleanupError) {
        this.#pendingCleanup = error;
        this.#state = 'cleanup';
        throw error;
      }
      try {
        await this.#finishCleanup(AbortSignal.timeout(5_000));
        this.#state = 'closed';
      } catch (cleanupError) {
        this.#state = 'cleanup';
        throw cleanupError;
      }
      throw error;
    }
  }

  async #finishCleanup(signal: AbortSignal): Promise<void> {
    if (this.#session) await this.#session.close(signal);
    if (this.#pendingCleanup) await this.#pendingCleanup.retryCleanup(signal);
    this.#session = undefined;
    this.#pendingCleanup = undefined;
  }
}
