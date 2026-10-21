import { workspaceTargetRef } from './support/workspace-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { AgentRun, CachedSessionDetail, ConversationTurn } from '../../src/model/workbench.js';
import { createWorkbenchConversationRealtimeService } from '../../src/service/WorkbenchConversationRealtimeService.js';

function fixture() {
  const segment = (id: string, segmentIndex: number): ConversationTurn => ({
    id,
    turnId: 'turn-1',
    segmentIndex,
    sessionId: 'session-1',
    runId: 'run-1',
    status: segmentIndex === 0 ? 'SUCCEEDED' : 'RUNNING',
    items: []
  });
  const turns = ref([segment('segment-0', 0), segment('segment-1', 1)]);
  const cached: CachedSessionDetail = {
    sessionId: 'session-1',
    runs: [],
    turns: [segment('segment-0', 0), segment('segment-1', 1)],
    nextCursor: null,
    contextUsage: undefined,
    lastAccessedAt: 0
  };
  const selectedNodeId = ref<string>();
  const selectedRunId = ref<string>();
  const channelToken = ref<string | undefined>('old-token');
  const refreshChannelToken = vi.fn(async () => undefined);
  const service = createWorkbenchConversationRealtimeService({
    workspaceTarget: workspaceTargetRef(selectedNodeId),
    selectedSessionId: ref('session-1'),
    selectedRunId,
    runs: ref<AgentRun[]>([]),
    turns,
    channelToken,
    refreshChannelToken,
    cachedDetail: (id) => (id === cached.sessionId ? cached : undefined)
  });
  return {
    service,
    selectedNodeId,
    selectedRunId,
    channelToken,
    refreshChannelToken,
    turns,
    cached
  };
}

describe('Public Conversation Real-Time Coordination', () => {
  it('Do not open a run without a selected Node; clear the old channel after selection and use the single refresh path', () => {
    const state = fixture();
    state.service.openRun('run-1');
    expect(state.selectedRunId.value).toBeUndefined();
    expect(state.channelToken.value).toBe('old-token');
    expect(state.refreshChannelToken).not.toHaveBeenCalled();
    state.selectedNodeId.value = 'node-1';
    state.service.openRun('run-1');
    expect(state.selectedRunId.value).toBe('run-1');
    expect(state.channelToken.value).toBeUndefined();
    expect(state.refreshChannelToken).toHaveBeenCalledOnce();
  });

  it.each([
    ['STARTING', 'RUNNING'],
    ['CANCELLING', 'RUNNING'],
    ['SUCCEEDED', 'SUCCEEDED'],
    ['FAILED', 'FAILED']
  ])(
    'Synchronize %s to the current and cached latest segments without rewriting completed older segments',
    (status, expected) => {
      const state = fixture();
      state.service.syncConversationTurnStatus('run-1', status, 'session-1');
      expect(state.turns.value.map((turn) => turn.status)).toEqual(['SUCCEEDED', expected]);
      expect(state.cached.turns.map((turn) => turn.status)).toEqual(['SUCCEEDED', expected]);
      expect(state.refreshChannelToken).not.toHaveBeenCalled();
    }
  );

  it('Do not project onto unrelated records or issue a request when no run or cache entry matches', () => {
    const state = fixture();
    const previous = [...state.turns.value];
    state.service.syncConversationTurnStatus('other-run', 'FAILED', 'missing-session');
    expect(state.turns.value).toEqual(previous);
    expect(state.cached.turns.map((turn) => turn.status)).toEqual(['SUCCEEDED', 'RUNNING']);
    expect(state.refreshChannelToken).not.toHaveBeenCalled();
  });
});
