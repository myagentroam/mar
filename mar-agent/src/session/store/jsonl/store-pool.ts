interface PooledStore {
  readonly root: string;
  references: number;
  closed: boolean;
}

/** Shares a storage domain across handles while keeping their close responsibilities separate. */
export class JsonlStorePool<T extends PooledStore> {
  readonly #instances = new Map<string, T>();
  readonly #opening = new Map<string, Promise<T>>();
  readonly #closing = new Map<string, Promise<void>>();

  async acquire(root: string, open: () => Promise<T>): Promise<T> {
    const closing = this.#closing.get(root);
    if (closing) {
      await closing;
      return this.acquire(root, open);
    }
    const existing = this.#instances.get(root);
    if (existing) {
      existing.references++;
      return existing;
    }
    const pending = this.#opening.get(root);
    if (pending) {
      const shared = await pending;
      shared.references++;
      return shared;
    }
    const opening = open();
    this.#opening.set(root, opening);
    try {
      const shared = await opening;
      this.#instances.set(root, shared);
      return shared;
    } finally {
      this.#opening.delete(root);
    }
  }

  async release(shared: T, beforeLastClose: () => Promise<void> | undefined): Promise<void> {
    shared.references--;
    if (shared.references > 0) return;
    const flush = beforeLastClose();
    if (flush) {
      const closing = flush.then(
        () => {
          shared.closed = true;
          this.#instances.delete(shared.root);
          this.#closing.delete(shared.root);
        },
        (error: unknown) => {
          this.#closing.delete(shared.root);
          throw error;
        }
      );
      this.#closing.set(shared.root, closing);
      await closing;
      return;
    }
    shared.closed = true;
    this.#instances.delete(shared.root);
  }
}
