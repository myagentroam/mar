import { RemoteDesktopError } from './desktop-error.js';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';

const marker = 0x4d415231;
const maxReceiptBytes = 64;

export interface TigerVncCleanupTicket {
  /** Write once to the authenticated backend before handing it to the RFB gate. */
  readonly registration: Buffer;
  /** A receipt does not replace fencing the attachment or releasing its lease. */
  wait(signal: AbortSignal): Promise<void>;
}

interface PendingReceipt {
  result: 'OK' | Error | null;
  waiter?: {
    signal: AbortSignal;
    abort(): void;
    resolve(): void;
    reject(error: Error): void;
  };
}

/** Owns the private native receipt stream, but neither the RFB stream nor control leases. */
export class TigerVncCleanupChannel {
  readonly #pending = new Map<string, PendingReceipt>();
  #line = '';
  #failed = false;

  constructor(
    private readonly stream: Readable,
    private readonly onFailure: () => void = () => {}
  ) {
    stream.on('data', this.#onData);
    stream.on('error', this.#onFailure);
    stream.on('end', this.#onFailure);
    stream.on('close', this.#onClose);
  }

  get outstanding(): number {
    return this.#pending.size;
  }

  issue(): TigerVncCleanupTicket {
    if (this.#failed || this.stream.destroyed || this.stream.readableEnded)
      throw new RemoteDesktopError('DESKTOP_NATIVE_CHANNEL_CLOSED');
    let token = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const candidate = randomBytes(16).toString('hex');
      if (!this.#pending.has(candidate)) {
        token = candidate;
        break;
      }
    }
    if (!token) throw new RemoteDesktopError('DESKTOP_NATIVE_ID_UNAVAILABLE');

    const pending: PendingReceipt = { result: null };
    this.#pending.set(token, pending);

    const registration = Buffer.alloc(24);
    registration[0] = 2;
    registration.writeUInt16BE(5, 2);
    registration.writeUInt32BE(marker, 4);
    Buffer.from(token, 'hex').copy(registration, 8);
    return {
      registration,
      wait: (signal) =>
        new Promise<void>((accept, fail) => {
          if (pending.result) {
            if (pending.result === 'OK') accept();
            else fail(pending.result);
            return;
          }
          if (pending.waiter) {
            fail(new RemoteDesktopError('DESKTOP_NATIVE_WAIT_IN_PROGRESS'));
            return;
          }
          if (signal.aborted) {
            fail(new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_TIMEOUT'));
            return;
          }
          const abort = () => {
            delete pending.waiter;
            fail(new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_TIMEOUT'));
          };
          pending.waiter = { signal, abort, resolve: accept, reject: fail };
          signal.addEventListener('abort', abort, { once: true });
        })
    };
  }

  dispose(): void {
    this.#fail(false);
    this.stream.destroy();
  }

  readonly #onData = (chunk: Buffer | string): void => {
    if (this.#failed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    for (const byte of bytes) {
      if (byte > 0x7f || this.#line.length >= maxReceiptBytes) {
        this.#fail();
        return;
      }
      this.#line += String.fromCharCode(byte);
      if (byte !== 10) continue;
      const match = /^MAR1 ([0-9a-f]{32}) (OK|FAILED)\n$/.exec(this.#line);
      this.#line = '';
      const pending = match && this.#pending.get(match[1]!);
      if (!pending || !match) {
        this.#fail();
        return;
      }
      this.#pending.delete(match[1]!);
      this.#settle(
        pending,
        match[2] === 'OK' ? 'OK' : new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_FAILED')
      );
    }
  };

  readonly #onFailure = (): void => this.#fail();

  readonly #onClose = (): void => {
    this.#fail();
    this.stream.off('error', this.#onFailure);
    this.stream.off('close', this.#onClose);
  };

  #fail(notify = true): void {
    if (this.#failed) return;
    this.#failed = true;
    this.stream.off('data', this.#onData);
    this.stream.off('end', this.#onFailure);
    for (const pending of this.#pending.values())
      this.#settle(pending, new RemoteDesktopError('DESKTOP_NATIVE_CHANNEL_CLOSED'));
    this.#pending.clear();
    if (notify) {
      this.stream.destroy();
      this.onFailure();
    }
  }

  #settle(pending: PendingReceipt, result: 'OK' | Error): void {
    pending.result = result;
    const waiter = pending.waiter;
    delete pending.waiter;
    if (!waiter) return;
    waiter.signal.removeEventListener('abort', waiter.abort);
    if (result === 'OK') waiter.resolve();
    else waiter.reject(result);
  }
}
