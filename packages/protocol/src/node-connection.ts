export interface NodeConnectionPath<Request, Stream> {
  readonly closed: boolean;
  /** Return undefined only if OPEN was not dispatched. All other failures are final. */
  openStream(request: Request, signal: AbortSignal): Promise<Stream | undefined>;
  /** Release the adapter's resources even if the underlying carrier is already closed. */
  close(): void;
}

type Connect<Path> = (signal: AbortSignal) => Promise<Path>;
type Slot<Path> = {
  connect: Connect<Path>;
  attempt?: Promise<Path>;
  path?: Path;
  failed?: boolean;
};
type Selection<Path> = { slot: Slot<Path>; path: Path };

/** Owns the paths of one logical connection. Its caller owns sharing, idle policy and grants. */
export class NodeConnection<Request, Stream extends { close(): void }> {
  readonly #lifetime = new AbortController();
  readonly #direct: Slot<NodeConnectionPath<Request, Stream>> | undefined;
  readonly #paths: Slot<NodeConnectionPath<Request, Stream>>[];

  constructor(adapters: {
    direct?: Connect<NodeConnectionPath<Request, Stream>>;
    relay?: Connect<NodeConnectionPath<Request, Stream>>;
  }) {
    this.#direct = adapters.direct === undefined ? undefined : { connect: adapters.direct };
    this.#paths = this.#direct === undefined ? [] : [this.#direct];
    if (adapters.relay !== undefined) this.#paths.push({ connect: adapters.relay });
  }

  /** Prepare a path without dispatching any operation, e.g. before an IPC handoff. */
  async ready(options?: { signal?: AbortSignal }): Promise<void> {
    await this.#select(this.#signal(options?.signal));
  }

  /** A caller's Direct readiness notification can refresh that path without dispatching OPEN. */
  async prepareDirect(): Promise<void> {
    this.#lifetime.signal.throwIfAborted();
    const slot = this.#direct;
    if (slot === undefined) return;
    if (slot.failed) delete slot.attempt;
    await this.#prepare(slot);
  }

  async openStream(request: Request, options?: { signal?: AbortSignal }): Promise<Stream> {
    const signal = this.#signal(options?.signal);
    const first = await this.#select(signal);
    const attempt = async (path: NodeConnectionPath<Request, Stream>) => {
      signal.throwIfAborted();
      if (path.closed) return undefined;
      const stream = await path.openStream(request, signal);
      if (signal.aborted) {
        stream?.close();
        signal.throwIfAborted();
      }
      return stream;
    };
    const opened = await attempt(first.path);
    if (opened !== undefined) return opened;

    // An adapter can return no stream only before the dispatch boundary.
    const alternate = this.#paths.find((slot) => slot !== first.slot);
    if (alternate !== undefined) {
      if (alternate.failed) delete alternate.attempt;
      const path = await waitFor(this.#prepare(alternate), signal);
      const stream = await attempt(path);
      if (stream !== undefined) return stream;
    }
    throw new Error('NODE_CONNECTION_UNAVAILABLE');
  }

  close(): void {
    if (this.#lifetime.signal.aborted) return;
    this.#lifetime.abort(new Error('NODE_CONNECTION_CLOSED'));
    for (const slot of this.#paths) slot.path?.close();
  }

  #signal(signal?: AbortSignal): AbortSignal {
    return signal === undefined
      ? this.#lifetime.signal
      : AbortSignal.any([signal, this.#lifetime.signal]);
  }

  #select(signal: AbortSignal): Promise<Selection<NodeConnectionPath<Request, Stream>>> {
    signal.throwIfAborted();
    for (const slot of this.#paths) this.#discardClosed(slot);
    // Prefer an already-ready Direct path, without making a warm Relay wait for ICE.
    const ready = this.#paths.find((slot) => slot.path !== undefined);
    if (ready?.path !== undefined) return Promise.resolve({ slot: ready, path: ready.path });
    // Retry on a new cold request, but not on every request while another path is usable.
    for (const slot of this.#paths) if (slot.failed) delete slot.attempt;
    return waitFor(
      Promise.any(this.#paths.map(async (slot) => ({ slot, path: await this.#prepare(slot) }))),
      signal
    );
  }

  #discardClosed(slot: Slot<NodeConnectionPath<Request, Stream>>): void {
    if (slot.path?.closed) {
      slot.path.close();
      delete slot.path;
      delete slot.attempt;
    }
  }

  #prepare(slot: Slot<NodeConnectionPath<Request, Stream>>) {
    this.#discardClosed(slot);
    if (slot.attempt !== undefined) return slot.attempt;
    slot.failed = false;
    return (slot.attempt = Promise.resolve().then(async () => {
      const signal = this.#lifetime.signal;
      try {
        signal.throwIfAborted();
        const path = await slot.connect(signal);
        const closed = path.closed;
        if (signal.aborted || closed) path.close();
        signal.throwIfAborted();
        if (closed) throw new Error('NODE_PATH_CLOSED');
        slot.path = path;
        return path;
      } catch (error) {
        slot.failed = true;
        throw error;
      }
    }));
  }
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
