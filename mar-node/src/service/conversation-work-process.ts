import { createHash } from 'node:crypto';
import type { NodeConversationItem, NodeConversationTurn } from '../runtime-model.js';

const members = new Set([
  'reasoning',
  'tool_call',
  'command_execution',
  'file_change',
  'todo_list'
]);
const boundaries = new Set([
  'user_message',
  'assistant_message',
  'approval_request',
  'user_input_request',
  'plan',
  'turn_summary'
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function visible(item: NodeConversationItem): boolean {
  const payload = record(item.payload);
  if (item.kind === 'assistant_message')
    return typeof payload.text === 'string' && !!payload.text.trim();
  if (item.kind === 'reasoning')
    return (
      Array.isArray(payload.sections) &&
      payload.sections.some((part) => {
        const text = record(part).text;
        return typeof text === 'string' && !!text.trim();
      })
    );
  return true;
}

/** Runtime owns this exact prefix; native history already carries the unprefixed identity. */
function sourceIdentity(item: NodeConversationItem): string {
  if (item.sourceItemId !== undefined) return item.sourceItemId;
  const prefix = item.runId === null ? undefined : `${item.runId}:`;
  return prefix !== undefined && item.id.startsWith(prefix)
    ? item.id.slice(prefix.length)
    : item.id;
}

/** Project complete public input before transport segmentation, without clocks or stored groups. */
export function projectConversationWorkProcesses(turn: NodeConversationTurn): NodeConversationTurn {
  const positions = new Map(turn.items.map((item, index) => [item.id, index]));
  const anchored = new Map<string, NodeConversationItem[]>();
  const relocated = new Set<string>();
  for (const item of turn.items) {
    const payload = record(item.payload);
    if (
      item.kind !== 'context_compaction' ||
      !['BACKGROUND', 'BLOCKING'].includes(String(payload.mode)) ||
      typeof payload.anchorItemId !== 'string' ||
      !positions.has(payload.anchorItemId) ||
      payload.anchorItemId === item.id ||
      turn.items[positions.get(payload.anchorItemId)!]?.kind === 'context_compaction'
    )
      continue;
    const list = anchored.get(payload.anchorItemId) ?? [];
    list.push(item);
    anchored.set(payload.anchorItemId, list);
    relocated.add(item.id);
  }
  const ordered = turn.items.flatMap((item) =>
    relocated.has(item.id) ? [] : [item, ...(anchored.get(item.id) ?? [])]
  );
  let knownBoundary = turn.runId !== null || turn.items.some((item) => item.id === turn.userItemId);
  let current: string | undefined;
  const assigned = new Map<string, string>();
  const items = ordered.map((item): NodeConversationItem => {
    const payload = record(item.payload);
    let group: string | undefined;
    let isStart = false;
    const independent =
      boundaries.has(item.kind) ||
      (item.kind === 'context_compaction' && payload.mode !== 'BACKGROUND') ||
      (item.kind === 'error' && item.parentItemId === null);
    if (visible(item)) {
      if (independent) {
        current = undefined;
        knownBoundary = true;
      } else if (members.has(item.kind) || ['warning', 'error', 'unknown'].includes(item.kind)) {
        group = item.parentItemId === null ? undefined : assigned.get(item.parentItemId);
        if (group === undefined) {
          group = current;
          if (group === undefined && knownBoundary && members.has(item.kind)) {
            group = `process:${createHash('sha256')
              .update(`${turn.sessionId}\0${sourceIdentity(item)}`)
              .digest('hex')}`;
            current = group;
            isStart = true;
          }
        }
        if (group !== undefined) assigned.set(item.id, group);
      }
    }
    if (item.processGroup?.id === group && (item.processGroup?.isStart === true) === isStart)
      return item;
    const { processGroup: _previous, ...rest } = item;
    return group === undefined
      ? rest
      : { ...rest, processGroup: { id: group, ...(isStart ? { isStart: true as const } : {}) } };
  });
  return items.every((item, index) => item === turn.items[index]) ? turn : { ...turn, items };
}
