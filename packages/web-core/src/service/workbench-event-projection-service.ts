import type { WorkspaceTarget } from '../model/workbench.js';
import type { Ref } from 'vue';
import { conversationPayload, isConversationTurn } from '../util/conversation-history.js';
import { isAgentRun, isSession } from '../util/workbench-guards.js';
import { sessionHasNativeIdentity } from '../util/session-presentation.js';
import type {
  AgentRun,
  ConversationTurn,
  ConversationTurnPage,
  NodeSummary,
  Session,
  WorkspaceQueue
} from '../model/workbench.js';
import type { WorkbenchLiveEvent } from '../service/workbench-live-service.js';
import type { WorkspaceQueueSnapshotSource } from './workspace-queue-projection-service.js';
import {
  isConversationSegment,
  parseConversationSegmentPage,
  segmentPageAsTurnPage
} from '../util/conversation-segments.js';

export function createWorkbenchEventProjectionService(options: {
  readonly nodes: Ref<NodeSummary[]>;
  readonly sessions: Ref<Session[]>;
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Ref<string | undefined>;
  readonly conversationNextCursor: Readonly<Ref<string | null>>;
  readonly cacheQueue: (
    nodeId: string,
    workspaceId: string,
    sessionId: string,
    queue: WorkspaceQueue,
    source: WorkspaceQueueSnapshotSource
  ) => void;
  readonly mergeQueue: (queue: WorkspaceQueue, source?: WorkspaceQueueSnapshotSource) => void;
  readonly mergeSessions: (sessions: readonly Session[]) => void;
  readonly settleSessionRuns: (sessionId: string) => boolean;
  readonly observeManagedSessionActive: (sessionId: string) => void;
  readonly updateContext: (sessionId: string, context: unknown) => void;
  readonly syncTurnStatus: (runId: string, status: string, sessionId?: string) => void;
  readonly cacheRun: (run: AgentRun) => void;
  readonly acceptRun: (run: AgentRun) => AgentRun;
  readonly openRun: (runId: string) => void;
  readonly markLiveTurn: (turn: ConversationTurn, sequence?: number) => void;
  readonly cacheTurn: (turn: ConversationTurn) => void;
  readonly mergeTurns: (page: ConversationTurnPage) => boolean;
  readonly applyConversationSnapshot: (
    sessionId: string,
    page: ConversationTurnPage,
    mode?: 'initial' | 'refresh'
  ) => boolean;
  readonly mergeItem: (
    runId: string,
    payload: unknown,
    sequence?: number,
    createdAt?: number
  ) => boolean;
  readonly mergeTextDelta: (
    runId: string,
    payload: unknown,
    sequence?: number,
    createdAt?: number
  ) => void;
  readonly invalidateWorkspace: (nodeId: string, workspaceId: string, topic: string) => void;
  readonly onNodeConnected: (nodeId: string) => void;
  readonly receivePerformance?: (sessionId: string, payload: unknown) => void;
}) {
  function updateNodeConnection(nodeId: string, connected: boolean): void {
    const wasConnected = options.nodes.value.some((node) => node.id === nodeId && node.connected);
    options.nodes.value = options.nodes.value.map((node) =>
      node.id === nodeId ? { ...node, connected } : node
    );
    if (connected && !wasConnected) options.onNodeConnected(nodeId);
  }

  function apply(event: WorkbenchLiveEvent, source: WorkspaceQueueSnapshotSource = 'event'): void {
    const payload = conversationPayload(event.payload);
    if (event.category === 'node' && typeof payload?.connected === 'boolean') {
      updateNodeConnection(event.nodeId, payload.connected);
      return;
    }
    if (event.category === 'workspace' && payload !== undefined) {
      if (typeof payload.workspaceId === 'string' && typeof payload.topic === 'string')
        options.invalidateWorkspace(event.nodeId, payload.workspaceId, payload.topic);
      return;
    }
    if (event.category === 'queue' && payload !== undefined) {
      const { sessionId, queue } = payload;
      if (
        typeof sessionId === 'string' &&
        event.nodeId === options.workspaceTarget.value?.nodeId &&
        typeof queue === 'object' &&
        queue !== null
      ) {
        const session = options.sessions.value.find((candidate) => candidate.id === sessionId);
        if (session !== undefined) {
          if (sessionHasNativeIdentity(session))
            options.cacheQueue(
              event.nodeId,
              session.workspaceId,
              sessionId,
              queue as WorkspaceQueue,
              source
            );
        }
        if (sessionId === options.selectedSessionId.value)
          options.mergeQueue(queue as WorkspaceQueue, source);
      }
      return;
    }
    if (
      event.category === 'session' &&
      payload !== undefined &&
      event.nodeId === options.workspaceTarget.value?.nodeId
    ) {
      const session = payload.session;
      if (isSession(session)) {
        const selected = session.id === options.selectedSessionId.value;
        if (selected && session.activity !== undefined && session.activity !== 'MANAGED_ACTIVE')
          options.settleSessionRuns(session.id);
        options.mergeSessions([session]);
        if (selected) {
          if (session.activity === 'MANAGED_ACTIVE')
            options.observeManagedSessionActive(session.id);
        }
      }
      if (typeof payload.sessionId === 'string' && 'context' in payload)
        options.updateContext(payload.sessionId, payload.context ?? null);
      return;
    }
    if (event.category === 'run' && payload !== undefined && isAgentRun(payload.run)) {
      const run = payload.run;
      options.syncTurnStatus(run.id, run.status, run.sessionId);
      if (event.nodeId === options.workspaceTarget.value?.nodeId) options.cacheRun(run);
      if (
        run.sessionId === options.selectedSessionId.value &&
        event.nodeId === options.workspaceTarget.value?.nodeId
      ) {
        const latest = options.acceptRun(run);
        if (['STARTING', 'RUNNING', 'CANCELLING'].includes(latest.status)) options.openRun(run.id);
      }
      return;
    }
    if (event.category !== 'conversation' || payload === undefined) return;
    if (payload.performance !== undefined) {
      if (
        event.nodeId === options.workspaceTarget.value?.nodeId &&
        typeof payload.sessionId === 'string' &&
        payload.sessionId === options.selectedSessionId.value
      )
        options.receivePerformance?.(payload.sessionId, payload.performance);
      return;
    }
    const item = conversationPayload(payload.item);
    if (
      item !== undefined &&
      typeof payload.runId === 'string' &&
      event.nodeId === options.workspaceTarget.value?.nodeId &&
      payload.sessionId === options.selectedSessionId.value
    ) {
      options.mergeItem(
        payload.runId,
        item,
        event.sequence,
        typeof item.startedAt === 'number' ? item.startedAt : undefined
      );
      return;
    }
    const delta = conversationPayload(payload.delta);
    if (
      delta !== undefined &&
      typeof delta.runId === 'string' &&
      typeof delta.itemId === 'string' &&
      typeof delta.text === 'string' &&
      event.nodeId === options.workspaceTarget.value?.nodeId &&
      payload.sessionId === options.selectedSessionId.value
    ) {
      options.mergeTextDelta(
        delta.runId,
        delta,
        event.sequence,
        typeof delta.createdAt === 'number' ? delta.createdAt : undefined
      );
      return;
    }
    const page = parseConversationSegmentPage(payload.snapshot, event.sequence);
    if (page !== undefined && event.nodeId === options.workspaceTarget.value?.nodeId) {
      const sessionId =
        page.turns[0]?.sessionId ??
        (typeof payload.sessionId === 'string' ? payload.sessionId : undefined);
      if (sessionId !== undefined) options.applyConversationSnapshot(sessionId, page, 'refresh');
      return;
    }
    const turn = payload.turn;
    if (isConversationTurn(turn) && event.nodeId === options.workspaceTarget.value?.nodeId) {
      if (!Array.isArray(payload.segments) || !payload.segments.every(isConversationSegment))
        return;
      const projected = segmentPageAsTurnPage({
        segments: payload.segments,
        nextCursor: options.conversationNextCursor.value,
        snapshotSequence: event.sequence
      }).turns;
      if (projected.length === 0) return;
      for (const segment of projected) {
        options.markLiveTurn(segment, event.sequence);
        options.cacheTurn(segment);
      }
      if (turn.sessionId === options.selectedSessionId.value) {
        options.mergeTurns({
          turns: projected,
          nextCursor: options.conversationNextCursor.value,
          snapshotSequence: event.sequence
        });
      }
      return;
    }
  }

  function applyBroadcast(event: WorkbenchLiveEvent): void {
    // Session content enters apply only through the Session Watch receiver.
    if (event.category === 'node' || event.category === 'workspace') apply(event);
  }

  return { apply, applyBroadcast, updateNodeConnection };
}
