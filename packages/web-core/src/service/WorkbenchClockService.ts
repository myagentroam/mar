import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import type { AgentRun } from '../model/workbench.js';

const WORKING_HANDOFF_GRACE_MS = 250;

export function shouldDelayWorkingReset(
  previousSessionId: string | undefined,
  nextSessionId: string | undefined
): boolean {
  return nextSessionId === previousSessionId && nextSessionId !== undefined;
}

export function resolveWorkingStartedAt(input: {
  readonly previousSessionId: string | undefined;
  readonly nextSessionId: string | undefined;
  readonly busy: boolean;
  readonly currentStartedAt: number | undefined;
  readonly knownSessionStartedAt?: number | undefined;
  readonly runCreatedAt: number | undefined;
  readonly now: number;
}): number | undefined {
  if (!input.busy || input.nextSessionId === undefined) return undefined;
  if (input.nextSessionId === input.previousSessionId && input.currentStartedAt !== undefined)
    return typeof input.runCreatedAt === 'number' && Number.isFinite(input.runCreatedAt)
      ? Math.min(input.currentStartedAt, input.runCreatedAt)
      : input.currentStartedAt;
  if (input.knownSessionStartedAt !== undefined)
    return typeof input.runCreatedAt === 'number' && Number.isFinite(input.runCreatedAt)
      ? input.runCreatedAt
      : input.knownSessionStartedAt;
  return typeof input.runCreatedAt === 'number' && Number.isFinite(input.runCreatedAt)
    ? input.runCreatedAt
    : input.now;
}

export function createWorkbenchClockService(
  sessionId: Readonly<Ref<string | undefined>>,
  busy: Readonly<Ref<boolean>>,
  activeRun: Readonly<Ref<AgentRun | undefined>>
) {
  const workingNow = ref(Date.now());
  const workingStartedAt = ref<number>();
  const working = ref(false);
  const sessionActivityNow = ref(Date.now());
  let workingTimer: ReturnType<typeof setInterval> | undefined;
  let workingResetTimer: ReturnType<typeof setTimeout> | undefined;
  const sessionStartedAt = new Map<string, number>();
  const sessionActivityTimer = setInterval(() => {
    sessionActivityNow.value = Date.now();
  }, 30_000);

  watch(
    [sessionId, busy, () => activeRun.value?.createdAt] as const,
    ([nextSessionId, nextBusy, runCreatedAt], [previousSessionId, previousBusy]) => {
      if (workingResetTimer !== undefined) clearTimeout(workingResetTimer);
      workingResetTimer = undefined;
      if (previousSessionId !== undefined && previousBusy && workingStartedAt.value !== undefined)
        sessionStartedAt.set(previousSessionId, workingStartedAt.value);
      if (nextSessionId !== undefined && !nextBusy) sessionStartedAt.delete(nextSessionId);
      const nextStartedAt = resolveWorkingStartedAt({
        previousSessionId,
        nextSessionId,
        busy: nextBusy,
        currentStartedAt: workingStartedAt.value,
        knownSessionStartedAt:
          nextSessionId === undefined ? undefined : sessionStartedAt.get(nextSessionId),
        runCreatedAt,
        now: Date.now()
      });
      if (nextStartedAt === undefined) {
        const reset = () => {
          if (workingTimer !== undefined) clearInterval(workingTimer);
          workingTimer = undefined;
          workingStartedAt.value = undefined;
          working.value = false;
        };
        // A brief idle may arrive while the same continuous Run hands off to its next queued Turn.
        // Keep a short window so Working does not disappear and restart timing from zero.
        if (shouldDelayWorkingReset(previousSessionId, nextSessionId))
          workingResetTimer = setTimeout(reset, WORKING_HANDOFF_GRACE_MS);
        else reset();
        return;
      }
      if (nextSessionId === undefined) return;
      workingStartedAt.value = nextStartedAt;
      sessionStartedAt.set(nextSessionId, nextStartedAt);
      working.value = true;
      workingNow.value = Date.now();
      if (workingTimer === undefined)
        workingTimer = setInterval(() => {
          workingNow.value = Date.now();
        }, 1_000);
    },
    { immediate: true }
  );

  onBeforeUnmount(() => {
    if (workingTimer !== undefined) clearInterval(workingTimer);
    if (workingResetTimer !== undefined) clearTimeout(workingResetTimer);
    clearInterval(sessionActivityTimer);
  });

  return { working, workingNow, workingStartedAt, sessionActivityNow };
}
