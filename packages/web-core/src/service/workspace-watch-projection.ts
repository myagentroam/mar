/**
 * Projects already accepted Workspace snapshots into narrow domain ports, preserving application order.
 * Navigation additionally matches the displayed query; catalog updates precede Session reconciliation.
 * Workspace Watch owns protocol identity/revisions and the coordinator owns subscription lifetimes.
 * This projection owns no cache, timers, transport or second source of Workspace/Session state.
 */
import type { Ref } from 'vue';
import type { WorkspaceSessionNavigationQuery } from '@myagentroam/protocol';
import type { Session, WorkspaceTarget } from '../model/workbench.js';
import { currentChangesBranch } from '../util/workbench-presentation.js';
import { sameNavigation, type createWorkspaceWatchService } from './workspace-watch-service.js';
import type { createSessionNavigationProjection } from './session-navigation-projection.js';
import type { createWorkspaceFileToolsController } from './workspace-file-tools-controller.js';
import type { createWorkspaceSessionService } from './workspace-session-service.js';

type SnapshotReceiver = Parameters<typeof createWorkspaceWatchService>[0]['onSnapshot'];

export function createWorkspaceWatchProjection(input: {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly navigation: {
    readonly query: () => WorkspaceSessionNavigationQuery | undefined;
    readonly accept: ReturnType<typeof createSessionNavigationProjection>['accept'];
  };
  readonly files: Pick<ReturnType<typeof createWorkspaceFileToolsController>, 'acceptWatch'>;
  readonly updateBranch: (nodeId: string, workspaceId: string, branch: string | null) => void;
  readonly sessions: {
    readonly current: Readonly<Ref<readonly Session[]>>;
    readonly selectedId: Readonly<Ref<string | undefined>>;
    readonly applySnapshot: ReturnType<typeof createWorkspaceSessionService>['applySnapshot'];
    readonly reconcile: (previous: Session | undefined, current: Session | undefined) => void;
  };
}) {
  const selectedSession = () =>
    input.sessions.current.value.find((session) => session.id === input.sessions.selectedId.value);
  const accept: SnapshotReceiver = (
    nodeId,
    workspaceId,
    snapshot,
    topic,
    revision,
    capturedQuery
  ) => {
    if (topic === 'sessionNavigation') {
      if (
        input.workspaceTarget.value?.nodeId === nodeId &&
        input.workspaceTarget.value.workspaceId === workspaceId &&
        capturedQuery !== undefined &&
        sameNavigation(input.navigation.query(), capturedQuery)
      )
        input.navigation.accept({ nodeId, workspaceId }, capturedQuery, snapshot.sessionNavigation);
      return;
    }
    input.files.acceptWatch(nodeId, workspaceId, snapshot, { topic, revision });
    const branch = currentChangesBranch(snapshot.changes);
    if (branch !== undefined) input.updateBranch(nodeId, workspaceId, branch);
    const page = snapshot.sessions as
      | {
          readonly sessions?: readonly Session[];
          readonly nextCursor?: string | null;
          readonly runningCounts?: import('@myagentroam/protocol').SessionRunningCounts;
        }
      | undefined;
    if (!Array.isArray(page?.sessions)) return;
    const previous = selectedSession();
    input.sessions.applySnapshot(nodeId, workspaceId, {
      sessions: [...page.sessions],
      ...(page.runningCounts === undefined ? {} : { runningCounts: page.runningCounts }),
      nextCursor: page.nextCursor ?? null
    });
    input.sessions.reconcile(previous, selectedSession());
  };
  return { accept };
}
