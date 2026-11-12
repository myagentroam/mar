import { RemoteDesktopError } from './desktop-error.js';
import type { TigerVncManagedProcess } from './tigervnc-managed-process.js';

type Backend = Pick<TigerVncManagedProcess, 'connect' | 'stop'>;

export interface TigerVncBackendReference {
  readonly backend: Backend;
  /** Call after this attachment's connection has closed. */
  release(): Promise<void>;
}

/** Owns one Remote-only backend and its references, not attachments or desktop control leases. */
export class TigerVncBackendPool {
  #tail: Promise<void> = Promise.resolve();
  #backend: Backend | undefined;
  #generation = 0;
  #unavailable = false;
  #retiring = false;
  #references = new Set<symbol>();
  #disposed = false;

  constructor(
    private readonly start: (signal: AbortSignal, onFailure: () => void) => Promise<Backend>,
    private readonly onFailure: () => void
  ) {}

  /** Used alongside the native-session and topology checks when admitting input. */
  isAvailable(): boolean {
    return !this.#disposed && !this.#unavailable && !this.#retiring;
  }

  acquire(signal: AbortSignal): Promise<TigerVncBackendReference> {
    return this.#serialize(async () => {
      if (signal.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
      if (this.#disposed || this.#unavailable || this.#retiring)
        throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
      if (!this.#backend) {
        const generation = ++this.#generation;
        const backend = await this.start(signal, () => {
          if (generation !== this.#generation || this.#unavailable) return;
          this.#unavailable = true;
          try {
            this.onFailure();
          } catch {
            // The unusable backend remains fenced even if its observer fails.
          }
        });
        this.#backend = backend;
        if (signal.aborted || this.#unavailable || this.#disposed) {
          await this.#stopEmpty();
          throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
        }
      }
      const backend = this.#backend;
      const token = Symbol();
      this.#references.add(token);
      return {
        backend,
        release: () => this.#serialize(() => this.#release(token))
      };
    });
  }

  /** Disallow new references; existing owners still close their own connections. */
  dispose(): Promise<void> {
    this.#disposed = true;
    return this.#serialize(async () => {
      if (this.#references.size) throw new RemoteDesktopError('DESKTOP_NATIVE_ATTACHMENTS_ACTIVE');
      await this.#stopEmpty();
    });
  }

  async #release(token: symbol): Promise<void> {
    if (!this.#references.has(token)) return;
    if (this.#references.size === 1) {
      // Keep the token and backend if stopping fails: only this owner can retry.
      await this.#stopEmpty();
    }
    this.#references.delete(token);
  }

  async #stopEmpty(): Promise<void> {
    if (!this.#backend) return;
    this.#retiring = true;
    await this.#backend.stop();
    this.#backend = undefined;
    this.#unavailable = false;
    this.#retiring = false;
    ++this.#generation;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => {},
      () => {}
    );
    return result;
  }
}
