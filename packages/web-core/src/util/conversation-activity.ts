import type { AgentRun, ConversationItem, ConversationTurn } from '../model/workbench.js';
import { translate } from '../service/LocalePreferenceService.js';
import { isTerminalRunStatus } from '../service/RunService.js';
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

export function conversationActivityLabel(
  run: Pick<AgentRun, 'id' | 'status'> | undefined,
  turns: readonly ConversationTurn[]
): string {
  const label = (key: string) => translate(`conversationActivity.${key}`);
  if (run === undefined) return label('running');
  if (isTerminalRunStatus(run.status)) return '';
  if (run.status === 'CANCELLING') return label('stopping');
  const latest = [...turns].reverse().find((turn) => turn.runId === run.id);
  if (latest !== undefined && !isTerminalRunStatus(latest.status)) {
    const items = latest.items;
    const pending = items.filter((item) => item.status === 'PENDING');
    if (pending.some((item) => item.kind === 'approval_request')) return label('approval');
    if (pending.some((item) => item.kind === 'user_input_request')) return label('answer');
  }
  return label(run.status === 'STARTING' ? 'preparing' : 'running');
}

export function conversationElapsedLabel(start: number | undefined, now: number): string {
  if (!finiteTime(start) || !finiteTime(now) || now < start) return '';
  return preciseElapsedDurationLabel(now - start);
}
