export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #valueOffset = 0;
  #waiterOffset = 0;
  #closed = false;
  #observed = false;
  #discarded = false;
  /** Best-effort live values are delivered only to an actively waiting consumer. */
  pushIfWaiting(value: T) {
    if (this.#waiterOffset >= this.#waiters.length || this.#closed || this.#discarded) return false;
    this.push(value);
    return true;
  }
  push(value: T) {
    if (this.#closed || this.#discarded) return;
    const waiter = this.#waiters[this.#waiterOffset];
    if (!waiter) {
      this.#values.push(value);
      return;
    }
    this.#waiterOffset++;
    if (this.#waiterOffset > 1024 && this.#waiterOffset * 2 > this.#waiters.length) {
      this.#waiters.splice(0, this.#waiterOffset);
      this.#waiterOffset = 0;
    }
    waiter({ value, done: false });
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (let index = this.#waiterOffset; index < this.#waiters.length; index++)
      this.#waiters[index]!({ value: undefined, done: true });
    this.#waiters.length = 0;
    this.#waiterOffset = 0;
  }
  discardIfUnobserved() {
    if (this.#observed) return false;
    this.#discarded = true;
    this.#values.length = 0;
    this.#valueOffset = 0;
    return true;
  }
  get bufferedSize() {
    return this.#values.length - this.#valueOffset;
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.#discarded) return { next: () => Promise.resolve({ value: undefined, done: true }) };
    this.#observed = true;
    return {
      next: () => {
        if (this.#valueOffset < this.#values.length) {
          const value = this.#values[this.#valueOffset++]!;
          if (this.#valueOffset > 1024 && this.#valueOffset * 2 > this.#values.length) {
            this.#values.splice(0, this.#valueOffset);
            this.#valueOffset = 0;
          }
          return Promise.resolve({ value, done: false });
        }
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      }
    };
  }
}
