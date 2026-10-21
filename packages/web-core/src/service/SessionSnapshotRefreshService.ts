import type { WorkspaceTarget } from '../model/workbench.js';
import type { Ref } from 'vue';

export function createSessionSnapshotRefreshService(options: {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Readonly<Ref<string | undefined>>;
  readonly refresh: (sessionId: string, deferInitialScroll: boolean) => Promise<void> | void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshing = false;
  let queued:
    | {
        readonly workspace: WorkspaceTarget;
        readonly sessionId: string;
        readonly deferInitialScroll: boolean;
      }
    | undefined;

  async function refresh(target: NonNullable<typeof queued>): Promise<void> {
    if (
      options.selectedSessionId.value !== target.sessionId ||
      options.workspaceTarget.value !== target.workspace
    )
      return;
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
      if (pending !== undefined) await refresh(pending);
    }
  }

  function schedule(delayMs = 0, deferInitialScroll = false): void {
    if (timer !== undefined) {
      if (delayMs !== 0) return;
      clearTimeout(timer);
    }
    const sessionId = options.selectedSessionId.value;
    const workspace = options.workspaceTarget.value;
    if (sessionId === undefined || workspace === undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh({ workspace, sessionId, deferInitialScroll });
    }, delayMs);
  }

  function clear(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    queued = undefined;
  }

  return { schedule, clear };
}
