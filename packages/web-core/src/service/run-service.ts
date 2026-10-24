import { ref, type Ref } from 'vue';
import type { AgentRun } from '../model/workbench.js';

const ACTIVE_RUN_STATUSES = new Set(['STARTING', 'RUNNING', 'CANCELLING']);
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

export function createRunService(selectedSessionId: Ref<string | undefined>) {
  const runs = ref<AgentRun[]>([]);
  const selectedRunId = ref<string>();
  const settledSessionInterruptions = new Set<string>();
  const pendingSessionInterruptions = new Set<string>();
  const requestedSessionInterruptions = new Set<string>();
  const suppressedInterruptedRunIds = new Map<string, { sessionId: string; requested: boolean }>();

  function mergeSnapshots(next: readonly AgentRun[]): void {
    const currentById = new Map(runs.value.map((run) => [run.id, run]));
    const snapshotRunIds = new Set(next.map((run) => run.id));
    for (const run of next)
      if (isTerminalRunStatus(run.status)) suppressedInterruptedRunIds.delete(run.id);
    const accepted = next.filter(
      (run) =>
        !ACTIVE_RUN_STATUSES.has(run.status) ||
        (!pendingSessionInterruptions.has(run.sessionId ?? '') &&
          !suppressedInterruptedRunIds.has(run.id))
    );
    const merged = accepted.map((run) => newestRunSnapshot(currentById.get(run.id), run));
    const liveOnly = runs.value.filter(
      (run) =>
        run.sessionId === selectedSessionId.value &&
        !snapshotRunIds.has(run.id) &&
        ACTIVE_RUN_STATUSES.has(run.status)
    );
    runs.value = [...liveOnly, ...merged];
    for (const run of runs.value)
      if (run.sessionId !== undefined && ACTIVE_RUN_STATUSES.has(run.status))
        settledSessionInterruptions.delete(run.sessionId);
  }

  function mergeAuthoritativeSnapshot(
    next: readonly AgentRun[],
    baselineRuns: readonly AgentRun[]
  ): void {
    // A fresh Watch snapshot can supersede observed idle, but not a requested stop.
    for (const run of next) {
      const suppressed = suppressedInterruptedRunIds.get(run.id);
      if (
        suppressed !== undefined &&
        !suppressed.requested &&
        suppressed.sessionId === run.sessionId &&
        ACTIVE_RUN_STATUSES.has(run.status) &&
        !requestedSessionInterruptions.has(suppressed.sessionId) &&
        !pendingSessionInterruptions.has(suppressed.sessionId)
      )
        suppressedInterruptedRunIds.delete(run.id);
    }
    const baselineById = new Map(baselineRuns.map((run) => [run.id, run]));
    const currentById = new Map(runs.value.map((run) => [run.id, run]));
    const snapshotRunIds = new Set(next.map((run) => run.id));
    const retainedAfterRequest = runs.value.filter((run) => {
      if (snapshotRunIds.has(run.id)) return false;
      const baseline = baselineById.get(run.id);
      return (
        baseline === undefined ||
        run.sessionId !== baseline.sessionId ||
        run.workspaceId !== baseline.workspaceId ||
        run.version !== baseline.version ||
        run.status !== baseline.status ||
        run.recoveryState !== baseline.recoveryState ||
        run.clientMessageId !== baseline.clientMessageId ||
        run.createdAt !== baseline.createdAt
      );
    });
    const accepted = next.filter(
      (run) =>
        !ACTIVE_RUN_STATUSES.has(run.status) ||
        (!pendingSessionInterruptions.has(run.sessionId ?? '') &&
          !suppressedInterruptedRunIds.has(run.id))
    );
    const merged = accepted.map((run) => newestRunSnapshot(currentById.get(run.id), run));
    const retainedRunIds = new Set(retainedAfterRequest.map((run) => run.id));
    const removed = baselineRuns.filter(
      (run) => !snapshotRunIds.has(run.id) && !retainedRunIds.has(run.id)
    );
    runs.value = [...retainedAfterRequest, ...merged];
    if (
      selectedRunId.value !== undefined &&
      !runs.value.some(
        (run) => run.id === selectedRunId.value && ACTIVE_RUN_STATUSES.has(run.status)
      )
    )
      selectedRunId.value = undefined;
    for (const run of next)
      if (isTerminalRunStatus(run.status)) suppressedInterruptedRunIds.delete(run.id);
    for (const run of removed) suppressedInterruptedRunIds.delete(run.id);
    for (const run of runs.value)
      if (run.sessionId !== undefined && ACTIVE_RUN_STATUSES.has(run.status))
        settledSessionInterruptions.delete(run.sessionId);
  }

  function markSessionInterrupted(sessionId: string, runId?: string): void {
    if (runId !== undefined && !settledSessionInterruptions.has(sessionId)) return;
    settledSessionInterruptions.add(sessionId);
    if (runId !== undefined) {
      pendingSessionInterruptions.delete(sessionId);
      suppressedInterruptedRunIds.set(runId, { sessionId, requested: true });
    }
  }

  function markSessionInterruptionPending(sessionId: string): void {
    settledSessionInterruptions.add(sessionId);
    pendingSessionInterruptions.add(sessionId);
    requestedSessionInterruptions.add(sessionId);
    for (const suppressed of suppressedInterruptedRunIds.values())
      if (suppressed.sessionId === sessionId) suppressed.requested = true;
  }

  function settleSessionRuns(sessionId: string, requested = false): boolean {
    // Node idle and explicit interruption both settle the active Runs known to Node.
    const activeRunIds = new Set(
      runs.value
        .filter((run) => run.sessionId === sessionId && ACTIVE_RUN_STATUSES.has(run.status))
        .map((run) => run.id)
    );
    if (activeRunIds.size > 0) runs.value = runs.value.filter((run) => !activeRunIds.has(run.id));
    if (selectedRunId.value !== undefined && activeRunIds.has(selectedRunId.value))
      selectedRunId.value = undefined;
    if (activeRunIds.size > 0) settledSessionInterruptions.add(sessionId);
    if (requested) markSessionInterruptionPending(sessionId);
    for (const runId of activeRunIds)
      suppressedInterruptedRunIds.set(runId, {
        sessionId,
        requested:
          requestedSessionInterruptions.has(sessionId) ||
          suppressedInterruptedRunIds.get(runId)?.requested === true
      });
    return activeRunIds.size > 0;
  }

  function observeManagedSessionActive(sessionId: string): void {
    if (!requestedSessionInterruptions.has(sessionId))
      settledSessionInterruptions.delete(sessionId);
  }

  function clearSessionInterruption(sessionId: string): void {
    settledSessionInterruptions.delete(sessionId);
    pendingSessionInterruptions.delete(sessionId);
    requestedSessionInterruptions.delete(sessionId);
    for (const [runId, suppressed] of suppressedInterruptedRunIds)
      if (suppressed.sessionId === sessionId) suppressedInterruptedRunIds.delete(runId);
  }

  function resumeSessionAfterInterruption(sessionId: string): void {
    settledSessionInterruptions.delete(sessionId);
    pendingSessionInterruptions.delete(sessionId);
    requestedSessionInterruptions.delete(sessionId);
  }

  function sessionInterruptionSettled(sessionId: string | undefined): boolean {
    return sessionId !== undefined && settledSessionInterruptions.has(sessionId);
  }

  return {
    runs,
    selectedRunId,
    mergeSnapshots,
    mergeAuthoritativeSnapshot,
    markSessionInterrupted,
    markSessionInterruptionPending,
    settleSessionRuns,
    observeManagedSessionActive,
    clearSessionInterruption,
    resumeSessionAfterInterruption,
    sessionInterruptionSettled
  };
}
