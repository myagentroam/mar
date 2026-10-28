/** Serializes runtime configuration writes, including transient state and rollback. */
export class NodeConfigMutations {
  #pending: Promise<void> | undefined;

  run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#pending;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#pending = pending;
    const finish = () => {
      if (this.#pending === pending) this.#pending = undefined;
      release();
    };
    let result: Promise<T>;
    try {
      // Start an uncontended mutation synchronously so disable closes admission before yielding.
      result = previous === undefined ? operation() : previous.then(operation);
    } catch (error) {
      result = Promise.reject(error);
    }
    void result.then(finish, finish);
    return result;
  }
}
