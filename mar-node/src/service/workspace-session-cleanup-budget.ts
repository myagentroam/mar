const CLEANUP_EXECUTION_BUDGET_MS = 25_000;

export class WorkspaceSessionCleanupDeadline extends Error {
  constructor() {
    super('Workspace session cleanup reached its execution budget.');
  }
}

/** Read-only work can expire; an admitted native write must settle before returning counts. */
export class WorkspaceSessionCleanupBudget {
  private readonly deadline = performance.now() + CLEANUP_EXECUTION_BUDGET_MS;

  get expired(): boolean {
    return performance.now() >= this.deadline;
  }

  check(): void {
    if (this.expired) throw new WorkspaceSessionCleanupDeadline();
  }

  async read<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new WorkspaceSessionCleanupDeadline()),
            Math.max(0, this.deadline - performance.now())
          );
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
