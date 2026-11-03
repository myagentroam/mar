import { computed, onScopeDispose, readonly, ref, watch, type Ref } from 'vue';
import type { AgentRun } from '../model/workbench.js';

const secondClockNow = ref(Date.now());
let secondClockTimer: ReturnType<typeof setInterval> | undefined;
let secondClockUsers = 0;

/** Share one second tick between visible process durations and Run footers. */
export function createWorkbenchSecondClock(active: Readonly<Ref<boolean>>) {
  watch(
    active,
    (enabled, _previous, onCleanup) => {
      if (!enabled || typeof window === 'undefined') return;
      secondClockNow.value = Date.now();
      secondClockUsers += 1;
      secondClockTimer ??= setInterval(() => {
        secondClockNow.value = Date.now();
      }, 1_000);
      onCleanup(() => {
        secondClockUsers -= 1;
        if (secondClockUsers === 0) {
          clearInterval(secondClockTimer);
          secondClockTimer = undefined;
        }
      });
    },
    { immediate: true }
  );
  return readonly(secondClockNow);
}

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
  const workingStartedAt = computed(() =>
    resolveWorkingStartedAt(sessionId.value, busy.value, activeRun.value)
  );
  const working = computed(() => sessionId.value !== undefined && busy.value);
  const workingNow = createWorkbenchSecondClock(
    computed(() => working.value && workingStartedAt.value !== undefined)
  );
  return { working, workingNow, workingStartedAt };
}

/** Workspace lists use one activity clock regardless of how many Panes are visible. */
export function createSessionActivityClock() {
  const now = ref(Date.now());
  const timer = setInterval(() => {
    now.value = Date.now();
  }, 30_000);
  onScopeDispose(() => clearInterval(timer));
  return readonly(now);
}
