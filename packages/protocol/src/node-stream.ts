import {
  NODE_STREAM_CHUNK_BYTES,
  NODE_STREAM_WINDOW_BYTES,
  nodeStreamCreditCost,
  type NodeStreamFrame
} from './node-stream-wire.js';

type StreamData = Exclude<NodeStreamFrame, { type: 'OPEN' | 'OPENED' }>;

/** The stable code of a stream failure; never contains peer diagnostics. */
export class NodeStreamError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Duplex stream after OPENED. Credit belongs to the end peers, not the relay. */
export class NodeStream implements AsyncIterable<Uint8Array> {
  readonly #queue: Uint8Array[] = [];
  readonly #finished = Promise.withResolvers<void>();
  #sendCredit = NODE_STREAM_WINDOW_BYTES;
  #receiveCredit = NODE_STREAM_WINDOW_BYTES;
  #receivedFin = false;
  #sentFin = false;
  #writing = false;
  #reading = false;
  #failure?: Error;
  #readable: PromiseWithResolvers<void> | undefined;
  #writable: PromiseWithResolvers<void> | undefined;

  constructor(
    readonly id: number,
    private readonly send: (frame: StreamData) => Promise<void>,
    private readonly release: (error?: Error) => void
  ) {}

  /** Settles when both directions end or the stream is reset, independently of the carrier. */
  get finished(): Promise<void> {
    return this.#finished.promise;
  }

  /** Distinguishes failure from normal FIN when a consumer is blocked outside the stream. */
  get failed(): boolean {
    return this.#failure !== undefined;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#sentFin || this.#writing) throw new Error('NODE_STREAM_WRITE_STATE');
    this.#writing = true;
    try {
      for (let offset = 0; offset < bytes.length;) {
        if (this.#failure !== undefined) throw this.#failure;
        if (this.#sendCredit === 0) {
          this.#writable = Promise.withResolvers<void>();
          await this.#writable.promise;
          this.#writable = undefined;
        }
        if (this.#failure !== undefined) throw this.#failure;
        const size = Math.min(bytes.length - offset, this.#sendCredit, NODE_STREAM_CHUNK_BYTES);
        this.#sendCredit -= nodeStreamCreditCost(size);
        await this.#send({
          type: 'DATA',
          streamId: this.id,
          bytes: bytes.subarray(offset, offset + size)
        });
        offset += size;
      }
    } finally {
      this.#writing = false;
    }
  }

  async endWrite(): Promise<void> {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#sentFin) return;
    if (this.#writing) throw new Error('NODE_STREAM_WRITE_STATE');
    this.#sentFin = true;
    await this.#send({ type: 'FIN', streamId: this.id });
    if (this.#receivedFin) this.#release();
  }

  close(): void {
    this.reset('NODE_STREAM_CANCELLED');
  }

  reset(code: string): void {
    if (this.#failure !== undefined || (this.#receivedFin && this.#sentFin)) return;
    this.fail(new NodeStreamError(code));
    void this.send({ type: 'RESET', streamId: this.id, code }).catch(() => {});
  }

  /** The carrier delivers decoded frames in order and owns carrier failure. */
  receive(frame: StreamData): void {
    switch (frame.type) {
      case 'DATA': {
        const cost = nodeStreamCreditCost(frame.bytes.length);
        if (this.#receivedFin || cost > this.#receiveCredit) {
          this.reset('NODE_STREAM_FLOW_INVALID');
          return;
        }
        this.#receiveCredit -= cost;
        this.#queue.push(frame.bytes);
        this.#readable?.resolve();
        return;
      }
      case 'WINDOW':
        if (this.#sendCredit + frame.bytes > NODE_STREAM_WINDOW_BYTES) {
          this.reset('NODE_STREAM_FLOW_INVALID');
          return;
        }
        this.#sendCredit += frame.bytes;
        this.#writable?.resolve();
        return;
      case 'FIN':
        if (this.#receivedFin) {
          this.reset('NODE_STREAM_STATE_INVALID');
          return;
        }
        this.#receivedFin = true;
        this.#readable?.resolve();
        if (this.#sentFin) this.#release();
        return;
      case 'RESET':
        this.fail(new NodeStreamError(frame.code));
    }
  }

  fail(error: Error): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.#queue.length = 0;
    this.#readable?.resolve();
    this.#writable?.resolve();
    this.#release(error);
  }

  #release(error?: Error): void {
    this.release(error);
    this.#finished.resolve();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    if (this.#reading) throw new Error('NODE_STREAM_READ_STATE');
    this.#reading = true;
    let complete = false;
    try {
      for (;;) {
        if (this.#failure !== undefined) throw this.#failure;
        const chunk = this.#queue.shift();
        if (chunk !== undefined) {
          yield chunk;
          // The consumer must request the next chunk before this one restores credit.
          if (!this.#receivedFin && this.#failure === undefined) {
            const bytes = nodeStreamCreditCost(chunk.length);
            this.#receiveCredit += bytes;
            await this.#send({ type: 'WINDOW', streamId: this.id, bytes });
          }
        } else if (this.#receivedFin) {
          complete = true;
          return;
        } else {
          this.#readable = Promise.withResolvers<void>();
          await this.#readable.promise;
          this.#readable = undefined;
        }
      }
    } finally {
      if (!complete) this.close();
    }
  }

  async #send(frame: StreamData): Promise<void> {
    try {
      await this.send(frame);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('NODE_STREAM_DISCONNECTED');
      this.fail(failure);
      throw failure;
    }
  }
}
