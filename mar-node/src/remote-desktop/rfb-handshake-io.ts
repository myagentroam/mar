import type { Duplex } from 'node:stream';
import { RemoteDesktopError } from './desktop-error.js';

/** Temporarily owns paused stream reads and bounded setup writes; it does not own the stream. */
export class RfbHandshakeIo {
  #error: Error | undefined;
  #pending: ((error?: Error) => void) | undefined;

  constructor(
    private readonly stream: Duplex,
    private readonly signal: AbortSignal
  ) {
    stream.pause();
    stream.on('error', this.#failed);
    stream.on('close', this.#closed);
    stream.on('end', this.#closed);
    signal.addEventListener('abort', this.#aborted);
    if (signal.aborted) this.#aborted();
  }

  async read(size: number): Promise<Buffer> {
    if (size === 0) return Buffer.alloc(0);
    const result = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      this.#check();
      const remaining = size - offset;
      const value = this.stream.read(
        Math.min(remaining, this.stream.readableLength || remaining)
      ) as Buffer | null;
      if (value !== null) {
        if (!Buffer.isBuffer(value) || value.length === 0 || value.length > remaining)
          throw new RemoteDesktopError('DESKTOP_RFB_INVALID');
        value.copy(result, offset);
        offset += value.length;
        continue;
      }
      await new Promise<void>((resolve, reject) => {
        const readable = () => finish();
        const finish = (error?: Error) => {
          this.stream.off('readable', readable);
          this.#pending = undefined;
          if (error) reject(error);
          else resolve();
        };
        this.#pending = finish;
        this.stream.once('readable', readable);
      });
    }
    return result;
  }

  async write(value: Buffer): Promise<void> {
    this.#check();
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error | null) => {
        if (this.#pending !== finish) return;
        this.#pending = undefined;
        if (error) reject(error);
        else resolve();
      };
      this.#pending = finish;
      try {
        this.stream.write(value, (error) =>
          finish(error ? new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR') : undefined)
        );
      } catch {
        finish(new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR'));
      }
    });
  }

  dispose(): void {
    if (this.stream.destroyed && !this.stream.closed) {
      this.stream.once('close', () => this.stream.off('error', this.#failed));
    } else this.stream.off('error', this.#failed);
    this.stream.off('close', this.#closed);
    this.stream.off('end', this.#closed);
    this.signal.removeEventListener('abort', this.#aborted);
  }

  #check(): void {
    if (this.#error) throw this.#error;
    if (this.stream.destroyed || this.stream.readableEnded)
      throw new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR');
  }

  #fail(error: Error): void {
    if (this.#error) return;
    this.#error = error;
    this.#pending?.(error);
  }

  #failed = (): void => this.#fail(new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR'));
  #closed = (): void => this.#fail(new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR'));
  #aborted = (): void => this.#fail(new RemoteDesktopError('DESKTOP_SETUP_CANCELLED'));
}
