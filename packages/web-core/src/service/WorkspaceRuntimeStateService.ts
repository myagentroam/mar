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
  return {
    ...(current?.nodeId === nodeId && current.workspaceId === workspaceId ? current : {}),
    nodeId,
    workspaceId,
    ...(snapshot.files === undefined
      ? {}
      : {
          files: snapshot.files,
          ...(update?.topic === 'files' ? { filesWatchRevision: update.revision } : {})
        }),
    ...(snapshot.changes === undefined
      ? {}
      : {
          changes: snapshot.changes,
          ...(update?.topic === 'changes' ? { changesWatchRevision: update.revision } : {})
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
