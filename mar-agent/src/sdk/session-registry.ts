/** An identity index and completion barrier; the open flow owns candidate resources. */
export class SessionRegistry<Runtime extends object> {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly pending = new Map<string, Map<number, Promise<Runtime>>>();
  private readonly opens = new Map<string | undefined, Set<Promise<unknown>>>();

  get(sessionId: string): Runtime | undefined {
    return this.runtimes.get(sessionId);
  }

  values(): IterableIterator<Runtime> {
    return this.runtimes.values();
  }

  [Symbol.iterator](): IterableIterator<[string, Runtime]> {
    return this.runtimes[Symbol.iterator]();
  }

  trackOpen<T>(sessionId: string | undefined, open: () => Promise<T>): Promise<T> {
    let opens = this.opens.get(sessionId);
    if (!opens) {
      opens = new Set();
      this.opens.set(sessionId, opens);
    }
    const group = opens;
    const pending = Promise.resolve().then(open);
    group.add(pending);
    const remove = () => {
      group.delete(pending);
      if (group.size === 0 && this.opens.get(sessionId) === group) this.opens.delete(sessionId);
    };
    void pending.then(remove, remove);
    return pending;
  }

  getOrCreate(
    sessionId: string,
    epoch: number,
    canPublish: () => boolean,
    initialize: (publish: (runtime: Runtime) => boolean) => Promise<Runtime>
  ): Promise<Runtime> {
    const existingPending = this.pending.get(sessionId)?.get(epoch);
    if (existingPending) return existingPending;
    const existing = this.runtimes.get(sessionId);
    if (existing) return Promise.resolve(existing);

    let byEpoch = this.pending.get(sessionId);
    if (!byEpoch) {
      byEpoch = new Map();
      this.pending.set(sessionId, byEpoch);
    }
    const epochs = byEpoch;
    const pending = Promise.resolve().then(() =>
      initialize((runtime) => {
        if (!canPublish() || this.runtimes.has(sessionId)) return false;
        this.runtimes.set(sessionId, runtime);
        return true;
      })
    );
    epochs.set(epoch, pending);
    const removePending = () => {
      if (epochs.get(epoch) !== pending) return;
      epochs.delete(epoch);
      if (epochs.size === 0 && this.pending.get(sessionId) === epochs)
        this.pending.delete(sessionId);
    };
    void pending.then(removePending, removePending);
    return pending;
  }

  unregister(sessionId: string, runtime: Runtime): void {
    if (this.runtimes.get(sessionId) === runtime) this.runtimes.delete(sessionId);
  }

  async whenIdle(sessionIds?: readonly string[]): Promise<void> {
    const selected = sessionIds === undefined ? undefined : new Set(sessionIds);
    const pending = [...this.opens].flatMap(([sessionId, opens]) =>
      selected === undefined || (sessionId !== undefined && selected.has(sessionId))
        ? [...opens]
        : []
    );
    pending.push(
      ...[...this.pending].flatMap(([sessionId, epochs]) =>
        selected === undefined || selected.has(sessionId) ? [...epochs.values()] : []
      )
    );
    const results = await Promise.allSettled(pending);
    const failedCleanup = results.find(
      (result) => result.status === 'rejected' && result.reason instanceof SessionOpenCleanupError
    );
    if (failedCleanup?.status === 'rejected') throw failedCleanup.reason.cause;
  }
}

/** Marks candidate cleanup failures without treating normal invalidation as cleanup failure. */
export class SessionOpenCleanupError extends Error {
  constructor(cause: unknown) {
    super('Session open candidate cleanup failed.', { cause });
  }
}
