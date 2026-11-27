import { encodeByteFrame } from '@myagentroam/protocol';
import type { TerminalPipe } from '../terminal.js';
import type { ComputerUseBinding } from './provider.js';
import { ComputerUseError, type ComputerUseInput } from './contracts.js';

const MAX_REQUEST_BYTES = 1024 * 1024;
const CHUNK_BYTES = 32 * 1024;

/** Owns one remote, synchronous desktop binding. Terminal owns transport and backpressure. */
export class RemoteComputerPipe implements TerminalPipe {
  readonly #stop = new AbortController();
  #chunks: Buffer[] = [];
  #received = 0;
  #queue: Buffer[] = [];
  #queuedBytes = 0;
  #ended = false;
  #paused = false;
  #unblock: (() => void) | undefined;
  #active: Promise<void> | undefined;
  #closing?: Promise<void>;
  #binding: ComputerUseBinding | undefined;
  #onData?: (data: Buffer) => void;
  #onExit?: (exitCode: number) => void;

  constructor(
    private readonly bind: (signal: AbortSignal) => Promise<ComputerUseBinding | undefined>,
    private readonly release: () => Promise<void>
  ) {}

  kill(): boolean {
    void this.close().catch(() => undefined);
    return true;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#stop.abort();
    this.resume();
    this.#chunks = [];
    this.#queue = [];
    this.#closing = (async () => {
      await this.#active;
      await this.release();
    })();
    return this.#closing;
  }

  onData(listener: (data: Buffer) => void): void {
    this.#onData = listener;
  }
  onExit(listener: (exitCode: number) => void): void {
    this.#onExit = listener;
  }
  pause(): void {
    this.#paused = true;
  }
  resume(): void {
    this.#paused = false;
    this.#unblock?.();
    this.#unblock = undefined;
  }

  write(data: Buffer): void {
    if (this.#stop.signal.aborted || this.#ended) throw new Error('COMPUTER_STREAM_CLOSED');
    for (let offset = 0; offset < data.length;) {
      const newline = data.indexOf(10, offset);
      const end = newline === -1 ? data.length : newline;
      const size = end - offset;
      if (
        this.#queuedBytes + this.#received + size + 1 > MAX_REQUEST_BYTES + 1 ||
        this.#queue.length >= 64
      )
        throw new Error('COMPUTER_REQUEST_LIMIT');
      if (size) this.#chunks.push(data.subarray(offset, end));
      this.#received += size;
      if (newline === -1) break;
      const bytes = Buffer.concat(this.#chunks, this.#received);
      this.#queue.push(bytes);
      this.#queuedBytes += bytes.length + 1;
      this.#chunks = [];
      this.#received = 0;
      offset = newline + 1;
    }
    this.drain();
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    // The wire requires a newline; never execute an incomplete record.
    if (this.#received !== 0) throw new Error('COMPUTER_REQUEST_INVALID');
    this.drain();
  }

  private drain(): void {
    if (this.#stop.signal.aborted || this.#active !== undefined) return;
    const bytes = this.#queue.shift();
    if (bytes === undefined) {
      if (this.#ended) this.finish(0);
      return;
    }
    this.#queuedBytes -= bytes.length + 1;
    this.#active = this.execute(bytes).then(
      (needsNewSession) => {
        this.#active = undefined;
        if (needsNewSession) {
          if (!this.#stop.signal.aborted) this.finish(1);
        } else this.drain();
      },
      () => {
        this.#active = undefined;
        if (!this.#stop.signal.aborted) this.finish(1);
      }
    );
  }

  private finish(code: number): void {
    void this.close().then(
      () => this.#onExit?.(code),
      () => this.#onExit?.(1)
    );
  }

  private async execute(bytes: Buffer): Promise<boolean> {
    try {
      const input = parseRequest(bytes);
      const binding = (this.#binding ??= await this.bind(this.#stop.signal));
      if (binding === undefined)
        throw new ComputerUseError('COMPUTER_UNAVAILABLE', 'The target desktop is unavailable.');
      const result = await binding.call(input, this.#stop.signal);
      if (result.status !== 'COMPLETED') throw new Error('COMPUTER_RESULT_INVALID');
      const { images = [], logs, message, ...metadata } = result;
      const pngs = images.map((image) => Buffer.from(image.dataBase64, 'base64'));
      const report = Buffer.from(JSON.stringify({ logs, message }));
      if (report.length > 8 * 1024 * 1024)
        throw new ComputerUseError(
          'COMPUTER_RESULT_TOO_LARGE',
          'Computer Use logs exceed the result limit.'
        );
      await this.send({
        type: 'result',
        ...metadata,
        reportBytes: report.length,
        imageCount: images.length
      });
      await this.sendChunks('report', report);
      for (const [index, png] of pngs.entries()) {
        await this.send({ type: 'image', index, size: png.length });
        await this.sendChunks('png', png);
      }
      await this.send({ type: 'complete' });
      return result.outcome === 'OUTCOME_UNKNOWN' || result.cleanupFailed === true;
    } catch (error) {
      await this.send({
        type: 'error',
        code: error instanceof ComputerUseError ? error.code : 'COMPUTER_REMOTE_FAILED',
        message:
          error instanceof ComputerUseError
            ? error.message.slice(0, 400)
            : 'Computer Use could not complete.'
      });
      return false;
    }
  }

  private async sendChunks(type: string, bytes: Buffer): Promise<void> {
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      this.#stop.signal.throwIfAborted();
      await this.send({ type }, bytes.subarray(offset, offset + CHUNK_BYTES));
    }
  }

  private async send(metadata: object, payload?: Uint8Array): Promise<void> {
    if (this.#paused)
      await new Promise<void>((resolve) => {
        this.#unblock = resolve;
      });
    this.#stop.signal.throwIfAborted();
    const frame = encodeByteFrame(metadata, payload);
    const data = Buffer.allocUnsafe(4 + frame.byteLength);
    data.writeUInt32BE(frame.byteLength);
    data.set(frame, 4);
    this.#onData?.(data);
  }
}

function parseRequest(bytes: Buffer): ComputerUseInput {
  try {
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      input === null ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => !['code', 'basedOnObservationId', 'timeoutMs'].includes(key)
      ) ||
      typeof input.code !== 'string' ||
      (input.basedOnObservationId !== undefined &&
        (typeof input.basedOnObservationId !== 'string' ||
          input.basedOnObservationId.length > 128)) ||
      (input.timeoutMs !== undefined &&
        (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120_000))
    )
      throw new Error();
    return {
      code: input.code,
      ...(input.basedOnObservationId === undefined
        ? {}
        : { basedOnObservationId: input.basedOnObservationId }),
      timeoutMs: input.timeoutMs ?? 30_000
    };
  } catch {
    throw new ComputerUseError('COMPUTER_REQUEST_INVALID', 'Invalid Computer Use request.');
  }
}
