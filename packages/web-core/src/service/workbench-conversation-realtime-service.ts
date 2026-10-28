import type { WorkspaceTarget } from '../model/workbench.js';
import type { Ref } from 'vue';
import type { AgentRun, ConversationTurn } from '../model/workbench.js';

/** Owns selected Run opening and normalized realtime event projection. */
export function createWorkbenchConversationRealtimeService(options: {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Ref<string | undefined>;
  readonly selectedRunId: Ref<string | undefined>;
  readonly runs: Readonly<Ref<readonly AgentRun[]>>;
  readonly syncTurnStatus: (runId: string, status: ConversationTurn['status']) => void;
  readonly channelToken: Ref<string | undefined>;
  readonly refreshChannelToken: () => Promise<void>;
  readonly syncCachedRunStatus: (
    sessionId: string,
    runId: string,
    status: ConversationTurn['status']
  ) => void;
}) {
  function syncTurnStatus(runId: string, runStatus: string, sessionId?: string): void {
    const status = (
      ['STARTING', 'RUNNING', 'CANCELLING'].includes(runStatus) ? 'RUNNING' : runStatus
    ) as ConversationTurn['status'];
    options.syncTurnStatus(runId, status);
    if (sessionId === undefined) return;
    options.syncCachedRunStatus(sessionId, runId, status);
  }

  function openRun(runId: string): void {
    if (options.workspaceTarget.value?.nodeId === undefined) return;
    options.selectedRunId.value = runId;
    options.channelToken.value = undefined;
    void options.refreshChannelToken();
  }

  return {
    openRun,
    syncConversationTurnStatus: syncTurnStatus
  };
}
