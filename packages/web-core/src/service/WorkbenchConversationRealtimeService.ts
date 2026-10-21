import type { WorkspaceTarget } from '../model/workbench.js';
import type { Ref } from 'vue';
import type { AgentRun, CachedSessionDetail, ConversationTurn } from '../model/workbench.js';
import { syncConversationRunStatus } from '../util/conversation-segments.js';

/** Owns selected Run opening and normalized realtime event projection. */
export function createWorkbenchConversationRealtimeService(options: {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Ref<string | undefined>;
  readonly selectedRunId: Ref<string | undefined>;
  readonly runs: Ref<AgentRun[]>;
  readonly turns: Ref<ConversationTurn[]>;
  readonly channelToken: Ref<string | undefined>;
  readonly refreshChannelToken: () => Promise<void>;
  readonly cachedDetail: (sessionId: string) => CachedSessionDetail | undefined;
}) {
  function syncTurnStatus(runId: string, runStatus: string, sessionId?: string): void {
    const status = (
      ['STARTING', 'RUNNING', 'CANCELLING'].includes(runStatus) ? 'RUNNING' : runStatus
    ) as ConversationTurn['status'];
    options.turns.value = syncConversationRunStatus(options.turns.value, runId, status);
    if (sessionId === undefined) return;
    const detail = options.cachedDetail(sessionId);
    if (detail !== undefined) detail.turns = syncConversationRunStatus(detail.turns, runId, status);
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
