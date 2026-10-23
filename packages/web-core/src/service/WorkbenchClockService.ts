import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import type { AgentRun } from '../model/workbench.js';

export function resolveWorkingStartedAt(
  sessionId: string | undefined,
  busy: boolean,
  run: Pick<AgentRun, 'sessionId' | 'startedAt'> | undefined
): number | undefined {
  if (!busy || sessionId === undefined || run === undefined) return undefined;
  if (run.sessionId !== undefined && run.sessionId !== sessionId) return undefined;
  const start = run.startedAt;
  return typeof start === 'number' && Number.isFinite(start) && start >= 0 ? start : undefined;
}

export function createWorkbenchClockService(
  sessionId: Readonly<Ref<string | undefined>>,
  busy: Readonly<Ref<boolean>>,
  activeRun: Readonly<Ref<Pick<AgentRun, 'sessionId' | 'startedAt'> | undefined>>
) {
  const workingNow = ref(Date.now());
  const workingStartedAt = computed(() =>
    resolveWorkingStartedAt(sessionId.value, busy.value, activeRun.value)
  );
  const working = computed(() => sessionId.value !== undefined && busy.value);
  const sessionActivityNow = ref(Date.now());
  let workingTimer: ReturnType<typeof setInterval> | undefined;
  const sessionActivityTimer = setInterval(() => {
    sessionActivityNow.value = Date.now();
  }, 30_000);
  watch(
    [working, workingStartedAt],
    ([active, start]) => {
      if (workingTimer !== undefined) clearInterval(workingTimer);
      workingTimer = undefined;
      workingNow.value = Date.now();
      if (active && start !== undefined)
        workingTimer = setInterval(() => {
          workingNow.value = Date.now();
        }, 1_000);
    },
    { immediate: true }
  );
  onBeforeUnmount(() => {
    if (workingTimer !== undefined) clearInterval(workingTimer);
    clearInterval(sessionActivityTimer);
  });
  return { working, workingNow, workingStartedAt, sessionActivityNow };
}
