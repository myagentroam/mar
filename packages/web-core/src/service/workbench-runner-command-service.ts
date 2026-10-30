import type { Ref } from 'vue';
import type { AgentRun, GoalExitSummary, Session, WorkspaceTarget } from '../model/workbench.js';

interface RunnerCommandResult {
  readonly session?: Session;
  readonly run?: AgentRun;
  readonly goalAccessChanged?: boolean;
  readonly goalAlreadyActive?: boolean;
  readonly goalExit?: GoalExitSummary;
}

export function createWorkbenchRunnerCommandService(options: {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Readonly<Ref<string | undefined>>;
  readonly currentSelectionRevision: () => number;
  readonly acceptRun: (run: AgentRun) => AgentRun;
  readonly captureCacheTarget: (
    nodeId: string,
    workspaceId: string
  ) =>
    | {
        readonly isCurrent: () => boolean;
        readonly replaceSession: (previousId: string, session: Session) => void;
        readonly cacheRun: (run: AgentRun) => void;
      }
    | undefined;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly sessionPathId: (sessionId: string) => string;
  readonly acceptSession: (
    nodeId: string,
    workspaceId: string,
    previousId: string,
    session: Session,
    applyToSelected: boolean
  ) => void;
  readonly configure: (session: Session) => void;
  readonly resetHistory: (nodeId: string, session: Session) => Promise<void>;
  readonly openRun: (runId: string) => void;
  readonly notifyGoalAlreadyActive: () => void;
}) {
  async function execute(
    session: Session,
    commandId: string,
    input: string,
    destructive = false
  ): Promise<RunnerCommandResult> {
    const target = options.workspaceTarget.value;
    const nodeId = target?.nodeId;
    const cache =
      nodeId === undefined ? undefined : options.captureCacheTarget(nodeId, session.workspaceId);
    let selectionRevision = options.currentSelectionRevision();
    const result = await options.request<RunnerCommandResult>(
      `/api/agent-sessions/${options.sessionPathId(session.id)}/commands`,
      {
        method: 'POST',
        body: JSON.stringify({
          nodeId,
          workspaceId: session.workspaceId,
          commandId,
          input,
          ...(session.runner === 'mar-agent' && session.modelId ? { modelId: session.modelId } : {})
        })
      }
    );
    let selectedIdentity = session.id;
    const stillSelected = () =>
      nodeId !== undefined &&
      options.workspaceTarget.value === target &&
      options.currentSelectionRevision() === selectionRevision &&
      (cache === undefined || cache.isCurrent()) &&
      options.workspaceTarget.value?.nodeId === nodeId &&
      options.workspaceTarget.value.workspaceId === session.workspaceId &&
      options.selectedSessionId.value === selectedIdentity;
    if (result.session !== undefined && nodeId !== undefined) {
      const wasSelected = stillSelected();
      cache?.replaceSession(session.id, result.session);
      if (wasSelected || cache?.isCurrent() === true)
        options.acceptSession(nodeId, session.workspaceId, session.id, result.session, wasSelected);
      if (wasSelected) {
        selectedIdentity = result.session.id;
        if (stillSelected()) options.configure(result.session);
      }
    }
    if (destructive && nodeId !== undefined && stillSelected()) {
      const reset = options.resetHistory(nodeId, session);
      const afterReset = options.currentSelectionRevision();
      // The synchronous reset may reopen this Session once. Any additional revision means the
      // selection changed while starting that reset and must not be adopted by this command.
      if (afterReset === selectionRevision || afterReset === selectionRevision + 1)
        selectionRevision = afterReset;
      await reset;
    }
    if (commandId === 'goal' && result.goalAlreadyActive === true && stillSelected())
      options.notifyGoalAlreadyActive();
    if (result.run !== undefined) {
      if (stillSelected()) {
        options.acceptRun(result.run);
        options.openRun(result.run.id);
      } else cache?.cacheRun(result.run);
    }
    return result;
  }

  return { execute };
}
