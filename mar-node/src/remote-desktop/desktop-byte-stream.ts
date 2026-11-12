import { Duplex } from 'node:stream';
import type WebSocket from 'ws';
import { RemoteDesktopError } from './desktop-error.js';

const MAX_QUEUED_BYTES = 1024 * 1024;
const DRAIN_MS = 20;

/** Sole byte-stream reader/writer/closer after a reliable RTC or relay channel handoff. */
export class DesktopByteStream extends Duplex {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pending: { bytes: Buffer; offset: number; callback: (error?: Error | null) => void } | undefined;

  constructor(
    private readonly channel: RTCDataChannel | WebSocket,
    private readonly maxMessageBytes: number
  ) {
    super({
      allowHalfOpen: false,
      readableHighWaterMark: 64 * 1024,
      writableHighWaterMark: 64 * 1024
    });
    if (
      (channel.readyState !== 'open' && channel.readyState !== 1) ||
      !Number.isSafeInteger(maxMessageBytes) ||
      maxMessageBytes < 1 ||
      maxMessageBytes > 64 * 1024
    )
      throw new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR');
    channel.binaryType = 'arraybuffer';
    channel.onmessage = this.#message;
    channel.onclose = this.#closed;
    channel.onerror = this.#failed;
  }

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    if (!Buffer.isBuffer(chunk) || this.writableLength > MAX_QUEUED_BYTES) {
      callback(new RemoteDesktopError('DESKTOP_BACKPRESSURE'));
      return;
    }
    this.#pending = { bytes: chunk, offset: 0, callback };
    this.#drain();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.channel.onmessage = null;
    this.channel.onclose = null;
    this.channel.onerror = null;
    try {
      if ('terminate' in this.channel) this.channel.terminate();
      else this.channel.close();
    } catch {
      /* Preserve the original failure. */
    }
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.callback(error ?? new RemoteDesktopError('DESKTOP_RFB_CLOSED'));
    callback(error);
  }

  #message = (event: { readonly data: unknown }): void => {
    const data = event.data;
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : undefined;
    if (!bytes) {
      this.destroy(new RemoteDesktopError('DESKTOP_RFB_INVALID'));
      return;
    }
    if (this.readableLength + bytes.byteLength > MAX_QUEUED_BYTES) {
      this.destroy(new RemoteDesktopError('DESKTOP_BACKPRESSURE'));
      return;
    }
    if (bytes.byteLength) this.push(Buffer.from(bytes));
  };

  #closed = (): void => {
    this.destroy();
  };
  #failed = (): void => {
    this.destroy(new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR'));
  };

  #drain(): void {
    const pending = this.#pending;
    if (!pending || this.destroyed) return;
    if (this.channel.readyState !== 'open' && this.channel.readyState !== 1) {
      this.destroy(new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR'));
      return;
    }
    try {
      let sent = 0;
      while (pending.offset < pending.bytes.length && sent < 4) {
        const end = Math.min(pending.offset + this.maxMessageBytes, pending.bytes.length);
        if (this.channel.bufferedAmount + end - pending.offset > MAX_QUEUED_BYTES) {
          this.#timer = setTimeout(() => {
            this.#timer = undefined;
            this.#drain();
          }, DRAIN_MS);
          this.#timer.unref?.();
          return;
        }
        const chunk = pending.bytes.subarray(pending.offset, end);
        // Both transports may retain the view after send returns; the Node
        // stream write callback lets its caller immediately reuse the buffer.
        const bytes = Uint8Array.from(chunk);
        this.channel.send(bytes);
        pending.offset = end;
        sent++;
      }
    } catch {
      this.destroy(new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR'));
      return;
    }
    if (pending.offset < pending.bytes.length) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#drain();
      }, 0);
      this.#timer.unref?.();
    } else {
      this.#pending = undefined;
      pending.callback();
    }
  }
}
