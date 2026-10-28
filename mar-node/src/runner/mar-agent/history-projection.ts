import type { ExecutionResult, AgentSessionHistoryEntry } from '@myagentroam/agent';
import type { NodeAgentSession } from '../../session/contracts.js';
import type { NodeConversationItem, NodeConversationTurn } from '../../runtime-model.js';
import {
  MarAgentConversationNormalizer,
  type MarAgentGeneratedImageArtifact
} from './conversation-normalizer.js';
import { publicGoalHistoryText } from '../../service/goal-runtime.js';
import { boundedConversationItemId } from '../normalization.js';

interface MarAgentHistoryProjectionOptions {
  readonly registerInputImages?: (
    entry: Extract<AgentSessionHistoryEntry, { readonly kind: 'user' }>
  ) => readonly (Record<string, unknown> | undefined)[];
  readonly registerGeneratedImages?: (
    sessionId: string,
    images: readonly MarAgentGeneratedImageArtifact[]
  ) => readonly Record<string, unknown>[];
}

type MarAgentPermissionStop = NonNullable<ExecutionResult['permissionStop']>;
type MarAgentHistoryItem = NodeConversationItem & {
  readonly permissionStop?: MarAgentPermissionStop;
};

export function projectMarAgentHistory(
  session: NodeAgentSession,
  entries: readonly AgentSessionHistoryEntry[],
  options: MarAgentHistoryProjectionOptions = {}
): NodeConversationTurn[] {
  const turns = new Map<string, NodeConversationTurn>();
  const normalizer = new MarAgentConversationNormalizer();
  const ensure = (turnId: string, at: number) => {
    const existing = turns.get(turnId);
    if (existing) return existing;
    const previous = [...turns.values()].at(-1);
    const created: NodeConversationTurn = {
      id: turnId,
      sessionId: session.id,
      runId: null,
      userItemId: null,
      status: 'INTERRUPTED',
      model: session.model,
      effort: session.effort,
      access: session.access,
      rewind: { before: previous?.id ?? null, after: turnId },
      items: [],
      startedAt: at,
      completedAt: null
    };
    turns.set(turnId, created);
    return created;
  };
  const replace = (turn: NodeConversationTurn, item: NodeConversationItem) => {
    turn = turns.get(turn.id) ?? turn;
    const index = turn.items.findIndex((candidate) => candidate.id === item.id);
    const items = [...turn.items];
    if (index < 0) items.push(item);
    else {
      const existing = items[index]!;
      items[index] = {
        ...existing,
        ...item,
        payload: mergeCompactLifecycleFacts(existing, item),
        startedAt: existing.startedAt
      };
    }
    turns.set(turn.id, { ...turn, items });
  };
  for (const entry of entries) {
    if (entry.kind === 'user') {
      const at = Date.parse(entry.timestamp);
      const turn = ensure(entry.turnId, at);
      // SDK mailbox messages are persisted as additional turn.user records in the same Turn.
      // The first input keeps its existing identity; later inputs use their storage sequence.
      const id = entry.recordId
        ? boundedConversationItemId('mar-agent-input', entry.recordId)
        : turn.userItemId === null
          ? `${entry.turnId}:user`
          : `${entry.turnId}:user:${entry.sequence}`;
      const images = entry.images;
      const registeredImages =
        images === undefined ? [] : (options.registerInputImages?.(entry) ?? []);
      replace(
        turn,
        historyItem(
          session,
          turn,
          id,
          'user_message',
          'COMPLETED',
          {
            clientMessageId: entry.clientMessageId ?? null,
            text: publicGoalHistoryText(entry.text),
            contexts: [],
            delivery: 'ACCEPTED',
            ...(images?.length
              ? {
                  attachments: images.map(
                    (image, imageIndex) =>
                      registeredImages[imageIndex] ?? {
                        name: image.name,
                        mime: image.mimeType,
                        byteSize: image.byteSize
                      }
                  )
                }
              : {})
          },
          at
        )
      );
      if (turn.userItemId === null)
        turns.set(entry.turnId, { ...turns.get(entry.turnId)!, userItemId: id });
      continue;
    }
    const event = entry.event;
    if (event.turnId === undefined) continue;
    const at = Date.parse(event.timestamp);
    const turn = ensure(event.turnId, at);
    if (
      event.type === 'execution.completed' ||
      event.type === 'execution.failed' ||
      event.type === 'execution.cancelled'
    ) {
      turns.set(event.turnId, {
        ...turn,
        status:
          event.type === 'execution.completed'
            ? event.permissionStop === undefined
              ? 'SUCCEEDED'
              : 'INTERRUPTED'
            : event.type === 'execution.failed'
              ? 'FAILED'
              : 'INTERRUPTED',
        completedAt: at
      });
      if (event.type !== 'execution.failed') continue;
    }
    const projectionTurn = turns.get(event.turnId) ?? turn;
    for (const projected of normalizer.normalize(event)) {
      const attachments =
        projected.generatedImages === undefined
          ? []
          : (options.registerGeneratedImages?.(event.sessionId, projected.generatedImages) ?? []);
      replace(
        projectionTurn,
        historyItem(
          session,
          projectionTurn,
          projected.itemId,
          projected.kind,
          projected.status,
          attachments.length === 0 ? projected.payload : { ...projected.payload, attachments },
          at,
          projected.permissionStop
        )
      );
    }
  }
  return [...turns.values()];
}

function mergeCompactLifecycleFacts(
  previous: NodeConversationItem,
  next: NodeConversationItem
): unknown {
  if (previous.kind !== 'context_compaction' || next.kind !== 'context_compaction')
    return next.payload;
  const previousPayload = record(previous.payload);
  const nextPayload = record(next.payload);
  if (previousPayload === undefined || nextPayload === undefined) return next.payload;
  return {
    ...nextPayload,
    ...(nextPayload.mode === undefined && previousPayload.mode !== undefined
      ? { mode: previousPayload.mode }
      : {}),
    ...(nextPayload.anchorItemId === undefined && previousPayload.anchorItemId !== undefined
      ? { anchorItemId: previousPayload.anchorItemId }
      : {})
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function historyItem(
  session: NodeAgentSession,
  turn: NodeConversationTurn,
  id: string,
  kind: string,
  status: string,
  payload: unknown,
  at: number,
  permissionStop?: MarAgentPermissionStop
): MarAgentHistoryItem {
  return {
    id,
    sessionId: session.id,
    turnId: turn.id,
    runId: turn.runId,
    parentItemId: null,
    sourceSequence: null,
    revision: 0,
    kind,
    status,
    payload,
    ...(permissionStop === undefined ? {} : { permissionStop }),
    startedAt: at,
    completedAt: status === 'IN_PROGRESS' ? null : at
  };
}
