import type { AgentRun, ConversationItem, ConversationTurn } from '../model/workbench.js';
import { translate } from '../service/locale-preference-service.js';
import { isTerminalRunStatus } from './run-state.js';
import { conversationPayload } from './conversation-history.js';
import { preciseElapsedDurationLabel } from './time-presentation.js';

function finiteTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function runDuration(run: Pick<AgentRun, 'startedAt' | 'completedAt'>): number | undefined {
  return finiteTime(run.startedAt) &&
    finiteTime(run.completedAt) &&
    run.completedAt >= run.startedAt
    ? run.completedAt - run.startedAt
    : undefined;
}

export function completedStepDuration(item: ConversationItem): number | undefined {
  if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(item.status)) return undefined;
  const payload = conversationPayload(item.payload);
  // Item timestamps can be projection times, not actual tool boundaries.
  if (item.kind === 'command_execution' && finiteTime(payload?.durationMs))
    return payload.durationMs;
  const presentation = conversationPayload(payload?.toolPresentation);
  return presentation?.kind === 'SLEEP' && finiteTime(presentation.elapsedMs)
    ? presentation.elapsedMs
    : undefined;
}

/** Preserve completed round durations when runtime Run metadata is no longer available. */
export function completedConversationDurations(
  turns: readonly ConversationTurn[]
): Map<string, number> {
  const groups = new Map<string, ConversationTurn[]>();
  for (const turn of turns) {
    const key = JSON.stringify([turn.sessionId, turn.turnId ?? turn.id]);
    const group = groups.get(key) ?? [];
    group.push(turn);
    groups.set(key, group);
  }
  const durations = new Map<string, number>();
  for (const group of groups.values()) {
    const first = group[0]!;
    const last = group.at(-1)!;
    if (!isTerminalRunStatus(last.status)) continue;
    // A later page can contain an appended input, not the round's initial input.
    const user =
      first.segmentIndex === undefined || first.segmentIndex === 0
        ? first.items.find((item) => item.kind === 'user_message')
        : undefined;
    const startedAt = user?.startedAt;
    const completedAt = last.completedAt;
    const duration = runDuration({
      startedAt: startedAt ?? null,
      completedAt: completedAt ?? null
    });
    if (duration !== undefined) durations.set(last.id, duration);
  }
  return durations;
}

function conversationActivityState(
  run: Pick<AgentRun, 'id' | 'status'> | undefined,
  turns: readonly ConversationTurn[]
): string {
  if (run === undefined) return 'running';
  if (isTerminalRunStatus(run.status)) return '';
  if (run.status === 'CANCELLING') return 'stopping';
  const latest = [...turns].reverse().find((turn) => turn.runId === run.id);
  if (latest !== undefined && !isTerminalRunStatus(latest.status)) {
    const items = latest.items;
    const pending = items.filter((item) => item.status === 'PENDING');
    if (pending.some((item) => item.kind === 'approval_request')) return 'approval';
    if (pending.some((item) => item.kind === 'user_input_request')) return 'answer';
  }
  return run.status === 'STARTING' ? 'preparing' : 'running';
}

export function conversationActivityLabel(
  run: Pick<AgentRun, 'id' | 'status'> | undefined,
  turns: readonly ConversationTurn[]
): string {
  const state = conversationActivityState(run, turns);
  return state ? translate(`conversationActivity.${state}`) : '';
}

export function conversationActivityBusy(
  run: Pick<AgentRun, 'id' | 'status'> | undefined,
  turns: readonly ConversationTurn[]
): boolean {
  return ['running', 'preparing', 'stopping'].includes(conversationActivityState(run, turns));
}

export function conversationElapsedLabel(start: number | undefined, now: number): string {
  if (!finiteTime(start) || !finiteTime(now) || now < start) return '';
  return preciseElapsedDurationLabel(now - start);
}
