import {
  conversationSegmentIdentityForItem,
  conversationSegments
} from './conversation-segment-service.js';
import type { WorkbenchEventCategory } from '@myagentroam/protocol';
import { runConversationItemId, type NodeRuntimeState } from '../runtime-state.js';
import type { marctlSessionProgress } from './session-recent-activity.js';
import {
  isNodeAgentRun,
  isNodeConversationTurn,
  isPlainRecord
} from '../runner/codex/conversation-parser.js';

export interface WorkbenchEventProjectionQueries {
  readonly getRun: NodeRuntimeState['getRun'];
  readonly conversationTurnForRun: NodeRuntimeState['conversationTurnForRun'];
  readonly progress: (sessionId: string) => ReturnType<typeof marctlSessionProgress>;
  readonly now?: () => number;
}

export function workbenchPayloadSessionId(
  getRun: NodeRuntimeState['getRun'],
  category: WorkbenchEventCategory,
  payload: unknown
): string | undefined {
  if (!isPlainRecord(payload)) return undefined;
  if (category === 'session') {
    if (isPlainRecord(payload.session)) {
      const id = payload.session.id;
      if (typeof id === 'string') return id;
    }
    return typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
  }
  if (category === 'run' && isNodeAgentRun(payload.run)) return payload.run.sessionId;
  if (category === 'conversation') {
    if (isNodeConversationTurn(payload.turn)) return payload.turn.sessionId;
    if (typeof payload.sessionId === 'string') return payload.sessionId;
    if (isPlainRecord(payload.event)) {
      const runId = payload.event.runId;
      return typeof runId === 'string' ? getRun(runId)?.sessionId : undefined;
    }
  }
  if (category === 'queue') {
    const id = payload.sessionId;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

/** Projects normalized runtime facts without publishing or mutating them. */
export function projectWorkbenchPayload(
  queries: WorkbenchEventProjectionQueries,
  category: WorkbenchEventCategory,
  payload: unknown
): unknown {
  if (
    category === 'conversation' &&
    isPlainRecord(payload) &&
    isPlainRecord(payload.event) &&
    payload.event.eventType !== 'notification'
  ) {
    const runId = typeof payload.event.runId === 'string' ? payload.event.runId : undefined;
    const sequence =
      typeof payload.event.sequence === 'number' ? payload.event.sequence : undefined;
    const turn = runId === undefined ? undefined : queries.conversationTurnForRun(runId);
    if (turn === undefined) return;
    const rawPayload = isPlainRecord(payload.event.payload) ? payload.event.payload : undefined;
    const text =
      payload.event.eventType === 'text.delta' && typeof rawPayload?.text === 'string'
        ? rawPayload.text
        : undefined;
    const nativeItemId =
      typeof rawPayload?.itemId === 'string'
        ? rawPayload.itemId
        : typeof rawPayload?.approvalId === 'string'
          ? `approval:${rawPayload.approvalId}`
          : undefined;
    const item =
      text !== undefined && sequence !== undefined
        ? turn.items.find(
            (candidate) => candidate.kind === 'assistant_message' && candidate.revision === sequence
          )
        : nativeItemId === undefined
          ? undefined
          : turn.items.find(
              (candidate) =>
                candidate.id ===
                runConversationItemId(
                  runId!,
                  nativeItemId,
                  typeof rawPayload?.kind === 'string' ? rawPayload.kind : undefined
                )
            );
    if (text !== undefined && item?.kind === 'assistant_message') {
      const segment = conversationSegmentIdentityForItem(turn, item.id, item.kind);
      payload = {
        sessionId: turn.sessionId,
        delta: {
          turnId: turn.id,
          segmentId: segment.id,
          segmentIndex: segment.index,
          runId: turn.runId,
          itemId: item.id,
          text,
          createdAt:
            typeof payload.event.createdAt === 'number'
              ? payload.event.createdAt
              : (queries.now ?? Date.now)()
        }
      };
    } else if (item !== undefined) {
      const segment = conversationSegmentIdentityForItem(turn, item.id, item.kind);
      payload = {
        sessionId: turn.sessionId,
        runId: turn.runId,
        ...(['assistant_message', 'tool_call', 'command_execution', 'file_change'].includes(
          item.kind
        ) &&
        (rawPayload?.append === undefined || item.status !== 'IN_PROGRESS')
          ? { progress: queries.progress(turn.sessionId) }
          : {}),
        item: {
          turnId: turn.id,
          itemId: item.id,
          kind: item.kind,
          status: item.status,
          payload: item.payload,
          startedAt: item.startedAt,
          completedAt: item.completedAt,
          parentItemId: item.parentItemId,
          ...(item.processGroup === undefined ? {} : { processGroup: item.processGroup }),
          segmentId: segment.id,
          segmentIndex: segment.index
        }
      };
    } else {
      if (payload.event.eventType !== 'run.started' && payload.event.eventType !== 'run.running')
        return;
      payload = { turn };
    }
  }
  if (category === 'conversation' && isPlainRecord(payload) && isNodeConversationTurn(payload.turn))
    return { ...payload, segments: conversationSegments(payload.turn) };
  if (category === 'run' && isPlainRecord(payload) && isNodeAgentRun(payload.run))
    return {
      ...payload,
      progress: queries.progress(payload.run.sessionId)
    };
  return payload;
}
