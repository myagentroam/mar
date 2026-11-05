import type { Ref } from 'vue';
import type { Session } from '../model/workbench.js';

export function replaceSessionIdentity(
  options: {
    readonly sessions: Readonly<Ref<readonly Session[]>>;
    readonly removeSessionExact: (session: Session) => void;
    readonly selectedSessionId: Readonly<Ref<string | undefined>>;
    readonly setSelectedSessionId: (id: string | undefined) => void;
    readonly currentSelectionRevision: () => number;
    readonly preserveManagedActive: (current: Session | undefined, next: Session) => Session;
    readonly mergeSessions: (sessions: readonly Session[]) => void;
    readonly transferSubmission: (previousId: string, nextId: string) => void;
  },
  previousId: string,
  next: Session
): void {
  const current = options.sessions.value.find((session) => session.id === previousId);
  const value = options.preserveManagedActive(current, next);
  const wasSelected = options.selectedSessionId.value === previousId;
  const selectionRevision = options.currentSelectionRevision();
  options.mergeSessions([value]);
  if (previousId !== value.id) options.transferSubmission(previousId, value.id);
  if (
    previousId !== value.id &&
    current !== undefined &&
    options.sessions.value.includes(current) &&
    !(
      options.selectedSessionId.value === previousId &&
      options.currentSelectionRevision() !== selectionRevision
    )
  )
    options.removeSessionExact(current);
  if (
    wasSelected &&
    (options.selectedSessionId.value === previousId ||
      options.selectedSessionId.value === value.id) &&
    options.currentSelectionRevision() === selectionRevision
  ) {
    if (
      options.selectedSessionId.value === previousId &&
      options.currentSelectionRevision() === selectionRevision
    )
      options.setSelectedSessionId(value.id);
  }
}

export function createWorkbenchSessionIdentity(input: {
  readonly projection: Omit<Parameters<typeof replaceSessionIdentity>[0], 'transferSubmission'>;
  readonly workspaceTarget: Readonly<
    import('vue').Ref<import('../model/workbench.js').WorkspaceTarget | undefined>
  >;
  readonly submissions: ReturnType<
    typeof import('./workbench-submission-service.js').createWorkbenchSubmissionOwner
  >;
}) {
  const {
    sessions,
    selectedSessionId,
    setSelectedSessionId,
    currentSelectionRevision,
    preserveManagedActive,
    mergeSessions,
    removeSessionExact
  } = input.projection;
  const submissionOwner = input.submissions;
  const workspaceTarget = input.workspaceTarget;
  function transferSessionSubmission(
    nodeId: string,
    workspaceId: string,
    previousId: string,
    nextId: string
  ): void {
    if (previousId === nextId) return;
    const target = { kind: 'session' as const, nodeId, workspaceId };
    submissionOwner.transfer(
      submissionOwner.forTarget({ ...target, sessionId: previousId }),
      submissionOwner.forTarget({ ...target, sessionId: nextId }),
      previousId,
      nextId
    );
  }

  function replaceSessionForTarget(
    nodeId: string,
    workspaceId: string,
    previousId: string,
    next: Session
  ): void {
    replaceSessionIdentity(
      {
        sessions,
        removeSessionExact: removeSessionExact,
        selectedSessionId,
        setSelectedSessionId: setSelectedSessionId,
        currentSelectionRevision: currentSelectionRevision,
        preserveManagedActive: preserveManagedActive,
        mergeSessions,
        transferSubmission: (oldId, nextId) =>
          transferSessionSubmission(nodeId, workspaceId, oldId, nextId)
      },
      previousId,
      next
    );
  }

  function replaceSession(previousId: string, next: Session): void {
    const nodeId = workspaceTarget.value?.nodeId;
    if (nodeId !== undefined) replaceSessionForTarget(nodeId, next.workspaceId, previousId, next);
  }

  return {
    transfer: transferSessionSubmission,
    replace: replaceSessionForTarget,
    replaceCurrent: replaceSession
  };
}
