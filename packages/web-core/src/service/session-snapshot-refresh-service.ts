import type { WorkspaceTarget } from '../model/workbench.js';
import type { Ref } from 'vue';

/**
 * Serializes authoritative session refreshes and owns scheduled/queued settlement.
 * Clearing cancels observers without overlapping in-flight reads.
 */
export function createSessionSnapshotRefreshService(options: {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Readonly<Ref<string | undefined>>;
  readonly refresh: (sessionId: string, deferInitialScroll: boolean) => Promise<void> | void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshing = false;
  const settledWaiters = new Set<(completed: boolean) => void>();
  let queued:
    | {
        readonly workspace: WorkspaceTarget;
        readonly sessionId: string;
        readonly deferInitialScroll: boolean;
      }
    | undefined;

  function settle(cancelled = false): void {
    if (!cancelled && (timer !== undefined || refreshing || queued !== undefined)) return;
    for (const resolve of settledWaiters) resolve(!cancelled);
    settledWaiters.clear();
  }

  async function refresh(target: NonNullable<typeof queued>): Promise<void> {
    if (
      options.selectedSessionId.value !== target.sessionId ||
      options.workspaceTarget.value !== target.workspace
    ) {
      settle();
      return;
    }
    if (refreshing) {
      queued = target;
      return;
    }
    refreshing = true;
    try {
      await options.refresh(target.sessionId, target.deferInitialScroll);
    } finally {
      refreshing = false;
      const pending = queued;
      queued = undefined;
      try {
        if (pending !== undefined) await refresh(pending);
      } finally {
        settle();
      }
    }
  }

  function schedule(delayMs = 0, deferInitialScroll = false): void {
    if (timer !== undefined) {
      if (delayMs !== 0) return;
      clearTimeout(timer);
      timer = undefined;
    }
    const sessionId = options.selectedSessionId.value;
    const workspace = options.workspaceTarget.value;
    if (sessionId === undefined || workspace === undefined) {
      settle();
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void refresh({ workspace, sessionId, deferInitialScroll });
    }, delayMs);
  }

  function clear(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    queued = undefined;
    // Cancel this generation's observers without allowing another refresh to overlap in-flight work.
    settle(true);
  }

  function whenSettled(): Promise<boolean> {
    if (timer === undefined && !refreshing && queued === undefined) return Promise.resolve(true);
    return new Promise((resolve) => settledWaiters.add(resolve));
  }

  return { schedule, clear, whenSettled };
}
