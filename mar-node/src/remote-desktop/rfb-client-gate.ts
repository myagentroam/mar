import { RemoteDesktopError } from './desktop-error.js';
import type { Writable } from 'node:stream';

/**
 * Frames and admits client-to-backend RFB messages for one attachment after
 * both handshakes. It owns neither socket nor lease; the session owner fences,
 * waits for stream drain, then makes a best-effort standard RFB release.
 */
export class RfbClientGate {
  static readonly maxClipboardBytes = 1024 * 1024;
  static readonly maxEncodings = 256;
  static readonly maxPressedKeys = 256;
  static readonly maxQueuedFrames = 1024;
  static readonly maxFrameBytes = RfbClientGate.maxClipboardBytes + 8;
  readonly #buffer = Buffer.allocUnsafe(RfbClientGate.maxFrameBytes);
  readonly #queue: { bytes: Buffer; input: boolean }[] = [];
  readonly #keys = new Set<number>();
  #begin = 0;
  #end = 0;
  #queuedBytes = 0;
  #buttons = 0;
  #pointerX = 0;
  #pointerY = 0;
  #waitingDrain = false;
  #inFlight = 0;
  #inFlightBytes = 0;
  #extendedClipboard = false;
  #state: 'active' | 'fenced' | 'failed' = 'active';
  #fencePromise: Promise<RfbInputSnapshot> | undefined;
  #fenceResolve: ((snapshot: RfbInputSnapshot) => void) | undefined;
  #fenceReject: ((error: Error) => void) | undefined;

  constructor(
    private readonly target: Writable,
    private readonly mode: 'VIEW' | 'CONTROL',
    private readonly isControlOwner: () => boolean,
    private readonly onFailure: (code: RfbGateError) => void
  ) {
    target.on('drain', this.#drain);
    target.on('error', this.#streamError);
    target.on('close', this.#streamError);
  }

  receive(data: Uint8Array): void {
    if (this.#state !== 'active') return;
    let offset = 0;
    while (offset < data.byteLength && this.#state === 'active') {
      if (this.#end === this.#buffer.length && this.#begin > 0) {
        this.#buffer.copyWithin(0, this.#begin, this.#end);
        this.#end -= this.#begin;
        this.#begin = 0;
      }
      const count = Math.min(data.byteLength - offset, this.#buffer.length - this.#end);
      if (count === 0) {
        this.#fail('DESKTOP_RFB_INVALID');
        return;
      }
      this.#buffer.set(data.subarray(offset, offset + count), this.#end);
      this.#end += count;
      offset += count;
      this.#parse();
    }
  }

  /** Fencing discards unwritten messages; write completion is not an OS input ACK. */
  fence(): Promise<RfbInputSnapshot> {
    if (this.#fencePromise !== undefined) return this.#fencePromise;
    if (this.#state === 'failed')
      return Promise.reject(new RemoteDesktopError('DESKTOP_RFB_CLOSED'));
    this.#state = 'fenced';
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.#begin = this.#end = 0;
    this.#fencePromise =
      this.#waitingDrain || this.#inFlight > 0
        ? new Promise((resolve, reject) => {
            this.#fenceResolve = resolve;
            this.#fenceReject = reject;
          })
        : Promise.resolve(this.#snapshot());
    return this.#fencePromise;
  }

  /** Available after failure for native cleanup; it does not confirm delivery or release. */
  submittedInputSnapshot(): RfbInputSnapshot {
    return this.#snapshot();
  }

  dispose(): void {
    this.#state = 'failed';
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.target.removeListener('drain', this.#drain);
    this.target.removeListener('error', this.#streamError);
    this.target.removeListener('close', this.#streamError);
    this.#fenceReject?.(new RemoteDesktopError('DESKTOP_RFB_CLOSED'));
    this.#fenceResolve = this.#fenceReject = undefined;
  }

  #parse(): void {
    while (this.#begin < this.#end && this.#state === 'active') {
      const length = this.#frameLength();
      if (length === undefined || this.#state !== 'active') return;
      if (this.#end - this.#begin < length) return;
      let bytes = Buffer.from(this.#buffer.subarray(this.#begin, this.#begin + length));
      this.#begin += length;
      if (this.#begin === this.#end) this.#begin = this.#end = 0;
      const input = bytes[0] === 4 || bytes[0] === 5 || bytes[0] === 6;
      if (input && this.mode === 'VIEW') {
        this.#fail('DESKTOP_INPUT_DENIED');
        return;
      }
      if (bytes[0] === 4 && bytes[1]! > 1) {
        this.#fail('DESKTOP_RFB_INVALID');
        return;
      }
      if (bytes[0] === 2) {
        bytes = this.#filterEncodings(bytes);
        this.#extendedClipboard = this.mode === 'CONTROL' && this.#hasExtendedClipboard(bytes);
      }
      if (bytes[0] === 6 && !this.#validClipboard(bytes)) {
        this.#fail('DESKTOP_RFB_INVALID');
        return;
      }
      if (
        this.#queue.length >= RfbClientGate.maxQueuedFrames ||
        this.#queuedBytes + bytes.length > RfbClientGate.maxFrameBytes
      ) {
        this.#fail('DESKTOP_BACKPRESSURE');
        return;
      }
      this.#queue.push({ bytes, input });
      this.#queuedBytes += bytes.length;
      this.#pump();
    }
  }

  #frameLength(): number | undefined {
    const available = this.#end - this.#begin;
    const type = this.#buffer[this.#begin];
    switch (type) {
      case 0:
        return 20;
      case 2: {
        if (available < 4) return undefined;
        const count = this.#buffer.readUInt16BE(this.#begin + 2);
        if (count > RfbClientGate.maxEncodings) {
          this.#fail('DESKTOP_RFB_INVALID');
          return undefined;
        }
        return 4 + count * 4;
      }
      case 3:
        return 10;
      case 4:
        return 8;
      case 5:
        return 6;
      case 6: {
        if (available < 8) return undefined;
        const declared = this.#buffer.readInt32BE(this.#begin + 4);
        const length = Math.abs(declared);
        if (length > RfbClientGate.maxClipboardBytes) {
          this.#fail('DESKTOP_RFB_INVALID');
          return undefined;
        }
        return 8 + length;
      }
      default:
        this.#fail('DESKTOP_RFB_INVALID');
        return undefined;
    }
  }

  #filterEncodings(frame: Buffer): Buffer<ArrayBuffer> {
    const allowed: number[] = [];
    for (let offset = 4; offset < frame.length; offset += 4) {
      const encoding = frame.readInt32BE(offset);
      if (
        [0, 1, 2, 5, 7, 16, 21, -223, -224, -239, -308].includes(encoding) ||
        (encoding >= -32 && encoding <= -23) ||
        (encoding >= -256 && encoding <= -247) ||
        (this.mode === 'CONTROL' && encoding === -1063131698)
      )
        allowed.push(encoding);
    }
    const filtered = Buffer.allocUnsafe(4 + allowed.length * 4);
    filtered[0] = 2;
    filtered[1] = 0;
    filtered.writeUInt16BE(allowed.length, 2);
    allowed.forEach((encoding, index) => filtered.writeInt32BE(encoding, 4 + index * 4));
    return filtered;
  }

  #hasExtendedClipboard(frame: Buffer): boolean {
    for (let offset = 4; offset < frame.length; offset += 4) {
      if (frame.readInt32BE(offset) === -1063131698) return true;
    }
    return false;
  }

  #validClipboard(frame: Buffer): boolean {
    if (frame.readInt32BE(4) >= 0) return true;
    if (!this.#extendedClipboard || frame.length < 12) return false;
    const flags = frame.readUInt32BE(8);
    const formats = flags & 0xffff;
    const actions = flags & 0xff000000;
    if ((flags & 0x00ff0000) !== 0 || (formats & ~1) !== 0) return false;
    if ((actions & 0x01000000) !== 0) {
      return (actions & ~0x1b000000) === 0 && frame.length === 12 + (formats === 1 ? 4 : 0);
    }
    if (actions === 0x08000000) return frame.length === 12;
    return actions === 0x10000000 && formats === 1 && frame.length > 12;
  }

  #pump(): void {
    while (this.#state === 'active' && !this.#waitingDrain && this.#queue.length > 0) {
      const next = this.#queue[0]!;
      if (
        this.#inFlight >= RfbClientGate.maxQueuedFrames ||
        this.#inFlightBytes + next.bytes.length > RfbClientGate.maxFrameBytes
      )
        return;
      const frame = this.#queue.shift()!;
      this.#queuedBytes -= frame.bytes.length;
      if (frame.input) {
        let ownsControl = false;
        try {
          ownsControl = this.isControlOwner();
        } catch {
          // An unavailable authority is not evidence of ownership.
        }
        if (!ownsControl) {
          this.#fail('DESKTOP_CONTROL_LOST');
          return;
        }
      }
      if (
        frame.bytes[0] === 4 &&
        frame.bytes[1] === 1 &&
        !this.#keys.has(frame.bytes.readUInt32BE(4)) &&
        this.#keys.size >= RfbClientGate.maxPressedKeys
      ) {
        this.#fail('DESKTOP_RFB_INVALID');
        return;
      }
      try {
        this.#inFlight++;
        this.#inFlightBytes += frame.bytes.length;
        const accepted = this.target.write(frame.bytes, (error) => {
          this.#inFlight--;
          this.#inFlightBytes -= frame.bytes.length;
          if (error) this.#fail('DESKTOP_TRANSPORT_ERROR');
          else if (this.#state === 'fenced') this.#finishFence();
          else this.#pump();
        });
        this.#recordInput(frame.bytes);
        this.#waitingDrain = !accepted;
      } catch {
        this.#inFlight--;
        this.#inFlightBytes -= frame.bytes.length;
        this.#fail('DESKTOP_TRANSPORT_ERROR');
      }
    }
  }

  #recordInput(frame: Buffer): void {
    if (frame[0] === 4) {
      const key = frame.readUInt32BE(4);
      if (frame[1] !== 0) this.#keys.add(key);
      else this.#keys.delete(key);
    } else if (frame[0] === 5) {
      this.#buttons = frame[1]!;
      this.#pointerX = frame.readUInt16BE(2);
      this.#pointerY = frame.readUInt16BE(4);
    }
  }

  #snapshot(): RfbInputSnapshot {
    return { keys: [...this.#keys], buttons: this.#buttons, x: this.#pointerX, y: this.#pointerY };
  }

  #drain = (): void => {
    this.#waitingDrain = false;
    if (this.#state === 'fenced') this.#finishFence();
    else this.#pump();
  };

  #finishFence(): void {
    if (this.#state === 'fenced' && !this.#waitingDrain && this.#inFlight === 0) {
      this.#fenceResolve?.(this.#snapshot());
      this.#fenceResolve = this.#fenceReject = undefined;
    }
  }

  #streamError = (): void => this.#fail('DESKTOP_TRANSPORT_ERROR');

  #fail(code: RfbGateError): void {
    if (this.#state === 'failed') return;
    this.#state = 'failed';
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.#fenceReject?.(new RemoteDesktopError(code));
    this.#fenceResolve = this.#fenceReject = undefined;
    this.onFailure(code);
  }
}

export type RfbGateError =
  | 'DESKTOP_RFB_INVALID'
  | 'DESKTOP_INPUT_DENIED'
  | 'DESKTOP_CONTROL_LOST'
  | 'DESKTOP_BACKPRESSURE'
  | 'DESKTOP_TRANSPORT_ERROR';

export interface RfbInputSnapshot {
  readonly keys: readonly number[];
  readonly buttons: number;
  readonly x: number;
  readonly y: number;
}
