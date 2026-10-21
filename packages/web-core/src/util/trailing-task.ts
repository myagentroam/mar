export interface TrailingTask {
  readonly request: () => Promise<void>;
  readonly running: () => boolean;
}

/** Runs one task at a time and coalesces any triggers during it into one trailing run. */
export function createTrailingTask(task: () => Promise<void>): TrailingTask {
  let active: Promise<void> | undefined;
  let pending = false;

  return {
    request() {
      pending = true;
      if (active !== undefined) return active;
      active = (async () => {
        try {
          while (pending) {
            pending = false;
            await task();
          }
        } finally {
          active = undefined;
        }
      })();
      return active;
    },
    running() {
      return active !== undefined;
    }
  };
}
