import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { NodeRuntimeState } from '../../mar-node/src/runtime-state.js';
import { NodeMetrics } from '../../mar-node/src/operational.js';
import { RunDomainState } from '../../mar-node/src/service/run-domain-state.js';
import { RunEventService } from '../../mar-node/src/service/run-event-service.js';
import { NodeRunEventBridge } from '../../mar-node/src/service/node-run-event-bridge.js';
import { conversationSegments } from '../../mar-node/src/service/conversation-segment-service.js';
import { createConversationProjectionService } from '../../packages/web-core/src/service/ConversationProjectionService.js';
import { createWorkbenchEventProjectionService } from '../../packages/web-core/src/service/WorkbenchEventProjectionService.js';
import {
  isConversationSegment,
  segmentPageAsTurnPage
} from '../../packages/web-core/src/util/conversation-segments.js';
import type { ConversationTurn } from '../../packages/web-core/src/model/workbench.js';
import type { WorkbenchEventCategory } from '../../packages/protocol/src/index.js';

describe('Node-to-Web conversation projection boundary', () => {
  it('Runtime and native Turn frames for one submission produce only one user message', () => {
    const turns = ref<ConversationTurn[]>([]);
    const projection = createConversationProjectionService({
      turns,
      nextCursor: ref<string | null>(null),
      limitHistory: (values) => [...values],
      onRecentWindowOverflow: () => undefined
    });
    const runtime = {
      id: 'runtime-turn',
      sessionId: 'session-1',
      runId: 'run-1',
      userItemId: 'runtime-user',
      status: 'RUNNING',
      model: null,
      effort: null,
      access: null,
      items: [
        {
          id: 'runtime-user',
          sessionId: 'session-1',
          turnId: 'runtime-turn',
          runId: 'run-1',
          parentItemId: null,
          sourceSequence: null,
          revision: 0,
          kind: 'user_message',
          status: 'COMPLETED',
          payload: { clientMessageId: 'submission-1', text: 'same input' },
          startedAt: 1,
          completedAt: 1
        }
      ],
      startedAt: 1,
      completedAt: null
    } as const;
    const official = {
      ...runtime,
      id: 'native-turn',
      runId: null,
      userItemId: 'native-turn:user',
      items: [
        {
          ...runtime.items[0],
          id: 'native-turn:user',
          turnId: 'native-turn',
          runId: null
        }
      ]
    } as const;

    projection.mergeLatest(
      segmentPageAsTurnPage({
        unit: 'SEGMENT',
        segments: conversationSegments(runtime as never) as never,
        nextCursor: null,
        snapshotSequence: 1
      })
    );
    projection.mergeLatest(
      segmentPageAsTurnPage({
        unit: 'SEGMENT',
        segments: conversationSegments(official as never) as never,
        nextCursor: null,
        snapshotSequence: 2
      })
    );

    expect(turns.value).toHaveLength(1);
    expect(turns.value.flatMap((turn) => turn.items)).toHaveLength(1);
  });

  it('Terminal states, post-switch snapshots, and late old-Execution callbacks never duplicate user messages', () => {
    const noop = () => undefined;
    const runtime = new NodeRuntimeState(
      () => 'node',
      (id) => ({ id, path: '/isolated', kind: 'DIRECTORY', gitSummary: null })
    );
    const state = new RunDomainState();
    const session = runtime.createAgentSession({
      workspaceId: 'workspace',
      runner: 'mar-agent',
      cwd: '/isolated'
    });
    const turns = ref<ConversationTurn[]>([]);
    const nextCursor = ref<string | null>(null);
    const selectedSessionId = ref(session.id);
    const projection = createConversationProjectionService({
      turns,
      nextCursor,
      limitHistory: (values) => [...values],
      onRecentWindowOverflow: noop
    });
    const web = createWorkbenchEventProjectionService({
      workspaceTarget: ref({ nodeId: 'node', workspaceId: 'workspace' }),
      selectedSessionId,
      conversationNextCursor: nextCursor,
      markLiveTurn: projection.markLive,
      cacheTurn: noop,
      mergeTurns: projection.mergeLatest,
      mergeItem: projection.mergeItem,
      mergeTextDelta: projection.mergeTextDelta
    } as never);
    let sequence = 0;
    const bridge = new NodeRunEventBridge({ runtime } as never);
    const emit = (category: WorkbenchEventCategory, payload: unknown) => {
      const projected = bridge.projectWorkbenchPayload(category, payload);
      if (projected !== undefined && category === 'conversation')
        web.apply({ nodeId: 'node', sequence: ++sequence, category, payload: projected });
    };
    const events = new RunEventService({
      runtime,
      state,
      metrics: new NodeMetrics(),
      isBootstrapSession: () => false,
      presentSession: (value) => value,
      rejectBootstrap: noop,
      emitWorkbench: emit,
      cleanupAttachments: noop,
      expireImages: noop,
      scheduleContextRefresh: noop,
      refreshWorkspaceSessions: async () => undefined,
      dispatchQueue: async () => undefined,
      keepRunActive: () => true,
      releaseExecution: noop
    });
    const snapshot = () => {
      const segments: unknown = JSON.parse(
        JSON.stringify(
          runtime
            .listConversationTurns({ sessionId: session.id })
            .turns.flatMap(conversationSegments)
        )
      );
      if (!Array.isArray(segments) || !segments.every(isConversationSegment))
        throw new Error('Node snapshot contains invalid Segments');
      return projection.replaceAuthoritative(
        segmentPageAsTurnPage({
          unit: 'SEGMENT',
          segments,
          nextCursor: null,
          snapshotSequence: ++sequence
        })
      );
    };
    const users = () =>
      turns.value.flatMap((turn) => turn.items).filter((item) => item.kind === 'user_message');
    try {
      const run = runtime.createMessageRun({
        sessionId: session.id,
        clientMessageId: 'first',
        content: 'same text'
      }).run;
      const first = runtime.createExecution(run.id);
      state.active.add(first.id);
      emit('conversation', { turn: runtime.conversationTurnForRun(run.id)! });
      events.emit(first.id, 'run.running', {}, 'RUNNING');
      events.emit(first.id, 'conversation.item', {
        itemId: 'reply',
        kind: 'assistant_message',
        status: 'COMPLETED',
        payload: { text: 'first reply' }
      });
      events.emit(first.id, 'run.completed', {}, 'SUCCEEDED');
      expect(users()).toHaveLength(1);
      expect(turns.value[0]!.items.some((item) => item.kind === 'assistant_message')).toBe(true);
      runtime.createQueueItem({
        sessionId: session.id,
        clientMessageId: 'second',
        content: 'same text'
      });
      runtime.claimNextQueueItem(session.id);
      const second = runtime.createExecution(run.id);
      state.active.add(second.id);
      emit('conversation', { turn: runtime.conversationTurnForRun(run.id)! });
      events.emit(second.id, 'run.running', {}, 'RUNNING');
      expect(users()).toHaveLength(2);
      const originalIds = turns.value.map((turn) => turn.id);
      // Reopening replaces the entire view with a fresh Node Segment snapshot.
      selectedSessionId.value = 'other-session';
      projection.replaceAuthoritative({ turns: [], nextCursor: null });
      selectedSessionId.value = session.id;
      snapshot();
      events.emit(first.id, 'conversation.item', {
        itemId: 'late-tool',
        kind: 'tool_call',
        status: 'COMPLETED',
        payload: { name: 'late', outputSummary: 'arrived' }
      });
      expect(users()).toHaveLength(2);
      expect(turns.value.every((turn) => turn.segmentIndex !== undefined)).toBe(true);
      expect(turns.value.map((turn) => turn.id)).toEqual(expect.arrayContaining(originalIds));
      expect(
        turns.value.flatMap((turn) => turn.items).some((item) => item.kind === 'tool_call')
      ).toBe(true);
      events.emit(second.id, 'conversation.item', {
        itemId: 'second-reply',
        kind: 'assistant_message',
        status: 'COMPLETED',
        payload: { text: 'second reply' }
      });
      events.emit(second.id, 'run.completed', {}, 'SUCCEEDED');
      expect(users()).toHaveLength(2);
      snapshot();
      expect(users()).toHaveLength(2);
    } finally {
      events.clear();
    }
  });
});
