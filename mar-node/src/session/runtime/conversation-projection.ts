import {
  permissionStopSchema,
  type PermissionStop,
  type AgentRunStatus
} from '@myagentroam/protocol';
import { projectConversationWorkProcesses } from './work-process.js';
import type {
  NodeAgentRun,
  NodeConversationItem,
  NodeConversationTurn,
  NodeRunEvent
} from '../../runtime-model.js';

type RuntimeRunEvent = Omit<NodeRunEvent, 'id'>;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function runConversationItemId(runId: string, itemId: string, kind?: string): string {
  return kind === 'user_message' ? itemId : `${runId}:${itemId}`;
}

export function projectConversationEvent(
  turn: NodeConversationTurn,
  run: NodeAgentRun,
  event: RuntimeRunEvent,
  runTerminal: boolean
): NodeConversationTurn {
  let needsProcessProjection = false;
  const update = (turn: NodeConversationTurn): NodeConversationTurn => {
    if (
      event.eventType === 'text.delta' &&
      isRecord(event.payload) &&
      typeof event.payload.text === 'string'
    ) {
      const nativeItemId =
        typeof event.payload.itemId === 'string' && event.payload.itemId.length <= 88
          ? event.payload.itemId
          : undefined;
      const stableItemId =
        nativeItemId === undefined ? undefined : `${event.runId}:${nativeItemId}`;
      const lastItem = turn.items.at(-1);
      const existing =
        stableItemId === undefined
          ? lastItem?.kind === 'assistant_message' && activeConversationItem(lastItem.status)
            ? lastItem
            : undefined
          : turn.items.find(
              (item) => item.id === stableItemId && item.kind === 'assistant_message'
            );
      const text = `${existing === undefined ? '' : readableText(existing.payload)}${event.payload.text}`;
      const sourceItemId = conversationSourceItemId(event.payload) ?? existing?.sourceItemId;
      needsProcessProjection =
        existing === undefined ||
        existing.sourceItemId !== sourceItemId ||
        (!readableText(existing.payload).trim() && !!text.trim());
      const item: NodeConversationItem = {
        id: existing?.id ?? stableItemId ?? `${event.runId}:assistant:${event.sequence}`,
        ...(sourceItemId === undefined ? {} : { sourceItemId }),
        sessionId: run.sessionId,
        turnId: turn.id,
        runId: event.runId,
        parentItemId: null,
        sourceSequence: existing?.sourceSequence ?? event.sequence,
        revision: event.sequence,
        kind: 'assistant_message',
        ...(existing?.processGroup === undefined ? {} : { processGroup: existing.processGroup }),
        updatedAt: event.createdAt,
        status: 'IN_PROGRESS',
        payload: { text, format: 'markdown', model: null },
        startedAt: existing?.startedAt ?? event.createdAt,
        completedAt: null
      };
      return {
        ...turn,
        status: 'RUNNING',
        startedAt: turn.startedAt ?? event.createdAt,
        items:
          existing === undefined
            ? [...turn.items, item]
            : turn.items.map((value) => (value.id === item.id ? item : value))
      };
    }
    const projected = conversationItemFromEvent(event);
    if (projected !== undefined) {
      const itemId = runConversationItemId(event.runId, projected.itemId, projected.kind);
      const trailingItem = turn.items.at(-1);
      const orderedItems =
        projected.kind !== 'user_message' &&
        trailingItem?.kind === 'assistant_message' &&
        activeConversationItem(trailingItem.status)
          ? turn.items.map((item) =>
              item.id === trailingItem.id
                ? {
                    ...item,
                    status: 'COMPLETED',
                    completedAt: event.createdAt,
                    updatedAt: event.createdAt
                  }
                : item
            )
          : turn.items;
      const existing =
        orderedItems.find((item) => item.id === itemId) ??
        (projected.kind === 'assistant_message' &&
        projected.itemId.startsWith('codex:') &&
        trailingItem?.kind === 'assistant_message' &&
        trailingItem.id.startsWith(`${event.runId}:assistant:`) &&
        activeConversationItem(trailingItem.status)
          ? trailingItem
          : undefined);
      const status = projected.status;
      const sourceItemId = projected.sourceItemId ?? existing?.sourceItemId;
      const parentItemId =
        projected.parentItemId === undefined
          ? (existing?.parentItemId ?? null)
          : runConversationItemId(event.runId, projected.parentItemId);
      needsProcessProjection =
        existing === undefined ||
        existing.kind !== projected.kind ||
        projected.kind === 'context_compaction' ||
        existing.parentItemId !== parentItemId ||
        existing.sourceItemId !== sourceItemId ||
        (projected.kind === 'assistant_message' &&
          !!readableText(existing.payload).trim() !== !!readableText(projected.payload).trim()) ||
        (projected.kind === 'reasoning' && existing.processGroup === undefined);
      const item: NodeConversationItem = {
        id: itemId,
        sessionId: run.sessionId,
        turnId: turn.id,
        runId: event.runId,
        parentItemId,
        ...(sourceItemId === undefined ? {} : { sourceItemId }),
        sourceSequence: existing?.sourceSequence ?? event.sequence,
        revision: (existing?.revision ?? -1) + 1,
        kind: projected.kind,
        ...(existing?.processGroup === undefined ? {} : { processGroup: existing.processGroup }),
        updatedAt: event.createdAt,
        status,
        payload: mergeConversationItemPayload(existing?.payload, projected),
        ...(projected.permissionStop === undefined
          ? {}
          : { permissionStop: projected.permissionStop }),
        startedAt: existing?.startedAt ?? event.createdAt,
        completedAt: completedConversationItem(status) ? event.createdAt : null
      };
      return {
        ...turn,
        status: runTerminal ? run.status : 'RUNNING',
        startedAt: turn.startedAt ?? event.createdAt,
        items:
          existing === undefined
            ? [...orderedItems, item]
            : orderedItems.map((value) => (value.id === existing.id ? item : value))
      };
    }
    if (event.eventType === 'run.started' || event.eventType === 'run.running')
      return { ...turn, status: 'RUNNING', startedAt: turn.startedAt ?? event.createdAt };
    if (
      event.eventType === 'run.completed' ||
      event.eventType === 'run.failed' ||
      event.eventType === 'run.rejected'
    ) {
      const status = event.status ?? run.status;
      return {
        ...turn,
        status,
        completedAt: event.createdAt,
        items: turn.items.map((item) =>
          activeConversationItem(item.status)
            ? {
                ...item,
                status: completedStatusForRun(status),
                completedAt: event.createdAt
              }
            : item
        )
      };
    }
    return turn;
  };
  const next = update(turn);
  // Ordinary token/output updates retain membership; only structural input needs a scan.
  return needsProcessProjection ? projectConversationWorkProcesses(next) : next;
}

function readableText(value: unknown): string {
  return isRecord(value) && typeof value.text === 'string' ? value.text : '';
}

type ProjectedConversationItem = {
  readonly sourceItemId?: string;
  readonly parentItemId?: string;
  readonly permissionStop?: PermissionStop;
  readonly itemId: string;
  readonly kind: string;
  readonly status: string;
  readonly payload: Record<string, unknown>;
  readonly merge: boolean;
  readonly append?: 'sections' | 'outputPreview' | 'outputSummary' | 'output';
};

export function conversationItemFromEvent(
  event: RuntimeRunEvent
): ProjectedConversationItem | undefined {
  if (isRecord(event.payload)) {
    const approvalId = event.payload.approvalId;
    if (typeof approvalId === 'string' && approvalId.length > 0) {
      if (event.eventType === 'approval.request')
        return {
          itemId: `approval:${approvalId}`,
          kind: 'approval_request',
          status: 'PENDING',
          payload: {
            approvalId,
            approvalStatus: 'PENDING',
            approval: event.payload.payload,
            expiresAt: event.payload.expiresAt
          },
          merge: false
        };
      if (event.eventType === 'approval.decided') {
        const decision = event.payload.decision;
        if (decision === 'APPROVED' || decision === 'REJECTED')
          return {
            itemId: `approval:${approvalId}`,
            kind: 'approval_request',
            status: decision === 'APPROVED' ? 'COMPLETED' : 'DECLINED',
            payload: { approvalId, approvalStatus: decision },
            merge: true
          };
      }
      if (event.eventType === 'approval.expired')
        return {
          itemId: `approval:${approvalId}`,
          kind: 'approval_request',
          status: 'CANCELLED',
          payload: { approvalId, approvalStatus: 'EXPIRED' },
          merge: true
        };
    }
  }
  if (event.eventType !== 'conversation.item' || !isRecord(event.payload)) return undefined;
  const itemId = event.payload.itemId;
  const kind = event.payload.kind;
  const status = event.payload.status;
  const payload = event.payload.payload;
  if (
    typeof itemId !== 'string' ||
    itemId.length === 0 ||
    itemId.length > 88 ||
    typeof kind !== 'string' ||
    !projectableConversationKind(kind) ||
    typeof status !== 'string' ||
    !projectableConversationStatus(status) ||
    !isRecord(payload)
  )
    return undefined;
  const append = event.payload.append;
  const sourceItemId = conversationSourceItemId(event.payload);
  const permissionStop = permissionStopSchema.safeParse(event.payload.permissionStop);
  return {
    itemId,
    kind,
    status,
    payload,
    ...(sourceItemId === undefined ? {} : { sourceItemId }),
    ...(typeof event.payload.parentItemId === 'string' &&
    event.payload.parentItemId.length > 0 &&
    event.payload.parentItemId.length <= 88
      ? { parentItemId: event.payload.parentItemId }
      : {}),
    ...(permissionStop.success ? { permissionStop: permissionStop.data } : {}),
    merge: event.payload.merge === true,
    ...(append === 'sections' ||
    append === 'outputPreview' ||
    append === 'outputSummary' ||
    append === 'output'
      ? { append }
      : {})
  };
}

function conversationSourceItemId(payload: Record<string, unknown>): string | undefined {
  return typeof payload.sourceItemId === 'string' &&
    payload.sourceItemId.length > 0 &&
    payload.sourceItemId.length <= 1024
    ? payload.sourceItemId
    : undefined;
}

function projectableConversationKind(value: string): boolean {
  return (
    value === 'user_message' ||
    value === 'assistant_message' ||
    value === 'reasoning' ||
    value === 'tool_call' ||
    value === 'command_execution' ||
    value === 'approval_request' ||
    value === 'user_input_request' ||
    value === 'plan' ||
    value === 'todo_list' ||
    value === 'file_change' ||
    value === 'context_compaction' ||
    value === 'unknown' ||
    value === 'warning' ||
    value === 'error'
  );
}

function projectableConversationStatus(value: string): boolean {
  return [
    'PENDING',
    'IN_PROGRESS',
    'COMPLETED',
    'FAILED',
    'DECLINED',
    'CANCELLED',
    'INTERRUPTED'
  ].includes(value);
}

export function mergeConversationItemPayload(
  existing: unknown,
  next: ProjectedConversationItem
): Record<string, unknown> {
  const base = next.merge && isRecord(existing) ? existing : {};
  const value = { ...base, ...next.payload };
  if (next.append === 'sections') {
    const prior = Array.isArray(base.sections) ? base.sections : [];
    const incoming = Array.isArray(next.payload.sections) ? next.payload.sections : [];
    const sections = new Map<number, string>();
    for (const section of [...prior, ...incoming]) {
      if (
        !isRecord(section) ||
        typeof section.index !== 'number' ||
        !Number.isInteger(section.index) ||
        section.index < 0 ||
        typeof section.text !== 'string'
      )
        continue;
      sections.set(
        section.index,
        appendProjectionText(sections.get(section.index) ?? '', section.text)
      );
    }
    value.sections = [...sections]
      .sort(([left], [right]) => left - right)
      .map(([index, text]) => ({ index, text }));
  }
  if (next.append === 'outputPreview') {
    const prior = typeof base.outputPreview === 'string' ? base.outputPreview : '';
    const incoming =
      typeof next.payload.outputPreview === 'string' ? next.payload.outputPreview : '';
    value.outputPreview = appendProjectionText(prior, incoming);
  }
  if (next.append === 'outputSummary') {
    const prior = typeof base.outputSummary === 'string' ? base.outputSummary : '';
    const incoming =
      typeof next.payload.outputSummary === 'string' ? next.payload.outputSummary : '';
    value.outputSummary = appendProjectionText(prior, incoming);
  }
  if (
    next.append === 'output' &&
    isRecord(next.payload.output) &&
    typeof next.payload.output.text === 'string'
  ) {
    const prior =
      isRecord(base.output) && typeof base.output.text === 'string' ? base.output : undefined;
    const text = `${prior?.text ?? ''}${next.payload.output.text}`;
    value.output = {
      text: boundedOutputTail(text),
      truncated:
        prior?.truncated === true || next.payload.output.truncated === true || text.length > 10_000
    };
    if (typeof next.payload.outputPreview === 'string') {
      value.outputPreview = boundedOutputTail(
        `${typeof base.outputPreview === 'string' ? base.outputPreview : ''}${next.payload.outputPreview}`
      );
    }
  }
  return value;
}

function boundedOutputTail(text: string): string {
  if (text.length <= 10_000) return text;
  const tail = text.slice(-10_000);
  return /^[\uDC00-\uDFFF]/u.test(tail) ? tail.slice(1) : tail;
}

function appendProjectionText(previous: string, next: string): string {
  const text = `${previous}${next}`;
  return text.length <= 10_000 ? text : `${text.slice(0, 9_999).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

export function activeConversationItem(status: string): boolean {
  return status === 'PENDING' || status === 'IN_PROGRESS';
}

function completedConversationItem(status: string): boolean {
  return !activeConversationItem(status);
}

export function completedStatusForRun(status: AgentRunStatus): string {
  if (status === 'INTERRUPTED') return 'INTERRUPTED';
  if (status === 'CANCELLED') return 'CANCELLED';
  if (status === 'FAILED') return 'FAILED';
  return 'COMPLETED';
}
