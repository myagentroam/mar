import type { AgentRun } from '../model/workbench.js';

const TERMINAL_RUN_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'LOST']);

export function runStatusRank(status: string): number {
  if (status === 'STARTING') return 1;
  if (status === 'RUNNING') return 2;
  if (status === 'CANCELLING') return 3;
  return TERMINAL_RUN_STATUSES.has(status) ? 4 : -1;
}

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export function newestRunSnapshot(current: AgentRun | undefined, next: AgentRun): AgentRun {
  if (current === undefined) return next;
  if (
    current.version !== undefined &&
    next.version !== undefined &&
    current.version !== next.version
  )
    return current.version > next.version ? current : next;
  return runStatusRank(current.status) > runStatusRank(next.status) ? current : next;
}
