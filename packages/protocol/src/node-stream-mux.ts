import { NodeStream } from './node-stream.js';
import {
  decodeNodeStreamFrame,
  encodeNodeStreamFrame,
  type NodeStreamFrame
} from './node-stream-wire.js';

export type NodeStreamOpen = Pick<Extract<NodeStreamFrame, { type: 'OPEN' }>, 'kind' | 'grant'>;
export type NodeStreamHandler = (stream: NodeStream, signal: AbortSignal) => Promise<void>;
type Entry = {
  stream: NodeStream;
  pending?: PromiseWithResolvers<NodeStream>;
  scope?: AbortController;
  accepting?: boolean;
};

type Options = {
  send(bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  maxStreams: number;
  /** Authorize only. The returned handler starts after the stream is accepted. */
  accept?(request: NodeStreamOpen, signal: AbortSignal): Promise<NodeStreamHandler | undefined>;
};

/** Owns the substreams on one admitted carrier; the path adapter owns the carrier itself. */
export class NodeStreamMux {
  readonly #entries = new Map<number, Entry>();
  #lastStreamId = 0;
  #failure?: Error;

  constructor(private readonly options: Options) {}

  get closed(): boolean {
    return this.#failure !== undefined;
  }

  async openStream(request: NodeStreamOpen, signal?: AbortSignal): Promise<NodeStream | undefined> {
    signal?.throwIfAborted();
    if (this.#failure !== undefined) return undefined;
    if (this.options.accept !== undefined) throw new Error('NODE_STREAM_DIRECTION_INVALID');
    if (this.#lastStreamId === 0xffffffff || this.#entries.size >= this.options.maxStreams)
      throw new Error('NODE_STREAM_LIMIT');

    const id = ++this.#lastStreamId;
    const entry = this.#create(id);
    const opened = (entry.pending = Promise.withResolvers<NodeStream>());
    const abort = () => entry.stream.close();
    signal?.addEventListener('abort', abort, { once: true });
    void this.#send({ type: 'OPEN', streamId: id, kind: request.kind, grant: request.grant }).catch(
      () => entry.stream.fail(new Error('NODE_STREAM_DISCONNECTED'))
    );
    try {
      return await opened.promise;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  receive(input: unknown): void {
    if (this.#failure !== undefined) return;
    const frame = decodeNodeStreamFrame(input);
    if (frame.type === 'OPEN') {
      const accept = this.options.accept;
      if (accept === undefined || frame.streamId <= this.#lastStreamId)
        throw new Error('NODE_STREAM_OPEN_INVALID');
      this.#lastStreamId = frame.streamId;
      if (this.#entries.size >= this.options.maxStreams) {
        void this.#send({
          type: 'RESET',
          streamId: frame.streamId,
          code: 'NODE_STREAM_LIMIT'
        }).catch(() => {});
      } else {
        const entry = this.#create(frame.streamId);
        entry.scope = new AbortController();
        void this.#accept(frame, entry, entry.scope.signal, accept);
      }
      return;
    }

    if (frame.streamId > this.#lastStreamId) throw new Error('NODE_STREAM_ID_INVALID');
    const entry = this.#entries.get(frame.streamId);
    if (entry === undefined) return; // A reset can cross frames already in flight.
    if (frame.type === 'OPENED' && entry.pending !== undefined) {
      entry.pending.resolve(entry.stream);
      delete entry.pending;
    } else if (frame.type === 'RESET') {
      entry.stream.receive(frame);
    } else if (frame.type === 'OPENED' || entry.pending !== undefined || entry.accepting) {
      entry.stream.reset('NODE_STREAM_STATE_INVALID');
    } else {
      entry.stream.receive(frame);
    }
  }

  disconnect(): void {
    if (this.#failure !== undefined) return;
    this.#failure = new Error('NODE_STREAM_DISCONNECTED');
    for (const { stream } of this.#entries.values()) stream.fail(this.#failure);
  }

  #create(id: number): Entry {
    const entry: Entry = {
      stream: new NodeStream(
        id,
        (frame) => this.#send(frame),
        (error) => {
          this.#entries.delete(id);
          if (error !== undefined) {
            entry.pending?.reject(error);
            entry.scope?.abort(error);
          }
        }
      )
    };
    this.#entries.set(id, entry);
    return entry;
  }

  async #send(frame: NodeStreamFrame): Promise<void> {
    if (this.#failure !== undefined) throw this.#failure;
    await this.options.send(encodeNodeStreamFrame(frame));
  }

  async #accept(
    frame: Extract<NodeStreamFrame, { type: 'OPEN' }>,
    entry: Entry,
    signal: AbortSignal,
    accept: NonNullable<Options['accept']>
  ) {
    entry.accepting = true;
    try {
      const handler = await accept({ kind: frame.kind, grant: frame.grant }, signal);
      if (signal.aborted) return;
      if (handler === undefined) {
        entry.stream.reset('RESOURCE_DENIED');
        return;
      }
      entry.accepting = false;
      await this.#send({ type: 'OPENED', streamId: frame.streamId });
      if (!signal.aborted) await handler(entry.stream, signal);
    } catch {
      if (!signal.aborted) entry.stream.reset('NODE_STREAM_HANDLER_FAILED');
    }
  }
}
