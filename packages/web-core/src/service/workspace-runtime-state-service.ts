import { ref } from 'vue';
import type { RunnerProfile, WorkspaceQueue } from '../model/workbench.js';

export interface WorkspaceWatchSnapshot {
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly files?: unknown;
  readonly filesWatchRevision?: number;
  readonly changes?: unknown;
  readonly changesWatchRevision?: number;
}

export function mergeWorkspaceWatchSnapshot(
  current: WorkspaceWatchSnapshot | undefined,
  nodeId: string,
  workspaceId: string,
  snapshot: { readonly files?: unknown; readonly changes?: unknown },
  update?: {
    readonly topic: 'sessions' | 'files' | 'changes';
    readonly revision: number;
  }
): WorkspaceWatchSnapshot {
  const previous =
    current?.nodeId === nodeId && current.workspaceId === workspaceId ? current : undefined;
  // The Watch service already filters stale events. Node revisions can restart with a new Watch.
  return {
    ...previous,
    nodeId,
    workspaceId,
    ...(snapshot.files === undefined
      ? {}
      : {
          files: snapshot.files,
          ...(update?.topic === 'files'
            ? { filesWatchRevision: (previous?.filesWatchRevision ?? 0) + 1 }
            : {})
        }),
    ...(snapshot.changes === undefined
      ? {}
      : {
          changes: snapshot.changes,
          ...(update?.topic === 'changes'
            ? { changesWatchRevision: (previous?.changesWatchRevision ?? 0) + 1 }
            : {})
        })
  };
}

export function createWorkspaceRuntimeStateService() {
  return {
    filesRevision: ref(0),
    changesRevision: ref(0),
    watchSnapshot: ref<WorkspaceWatchSnapshot | undefined>(),
    runnerProfiles: ref<readonly RunnerProfile[]>([]),
    runnerProfilesLoading: ref(false),
    runnerProfilesFailed: ref(false),
    queue: ref<WorkspaceQueue>({ version: 0, paused: false, items: [] })
  };
}
