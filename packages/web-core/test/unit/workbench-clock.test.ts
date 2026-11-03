import { describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import {
  createSessionActivityClock,
  createWorkbenchClockService,
  createWorkbenchSecondClock,
  resolveWorkingStartedAt
} from '../../src/service/workbench-clock-service';
import type { AgentRun } from '../../src/model/workbench';

const run: AgentRun = {
  id: 'run',
  sessionId: 'session',
  status: 'RUNNING',
  recoveryState: 'ACTIVE',
  clientMessageId: 'input',
  startedAt: 9_000
};

describe('Run wall-clock origin', () => {
  it('retains the authoritative origin across same-run continuation and session reentry', () => {
    expect(resolveWorkingStartedAt('session', true, run)).toBe(9_000);
    const continued = { ...run, version: 4 };
    expect(resolveWorkingStartedAt('session', true, continued)).toBe(9_000);
    expect(resolveWorkingStartedAt('other', true, run)).toBeUndefined();
    expect(resolveWorkingStartedAt('session', true, run)).toBe(9_000);
  });
  it('uses the new Run origin instead of merging continuous session activity', () => {
    const nextRun = { ...run, id: 'new', startedAt: 14_000 };
    expect(resolveWorkingStartedAt('session', true, nextRun)).toBe(14_000);
  });
  it('does not invent an origin from browser observation, createdAt or a previous session', () => {
    const withoutOrigin = { ...run, startedAt: null, createdAt: 5_000 };
    expect(resolveWorkingStartedAt('session', true, withoutOrigin)).toBeUndefined();
    expect(resolveWorkingStartedAt('session', true, undefined)).toBeUndefined();
    expect(resolveWorkingStartedAt('session', false, run)).toBeUndefined();
    expect(resolveWorkingStartedAt(undefined, true, run)).toBeUndefined();
    expect(resolveWorkingStartedAt('session', true, { ...run, startedAt: NaN })).toBeUndefined();
  });
});

it('keeps the workspace activity clock independent from Pane working clocks', () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const scope = effectScope();
  try {
    const clock = scope.run(() => {
      createWorkbenchClockService(ref('main'), ref(false), ref(undefined));
      createWorkbenchClockService(ref('child'), ref(false), ref(undefined));
      expect(vi.getTimerCount()).toBe(0);
      return createSessionActivityClock();
    })!;
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(clock.value).toBe(40_000);
    scope.stop();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    scope.stop();
    vi.useRealTimers();
  }
});

it('shares one second timer, pauses inactive consumers and cleans up the last subscriber', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', {});
  vi.setSystemTime(10_000);
  const firstScope = effectScope();
  const secondScope = effectScope();
  try {
    const active = ref(false);
    const first = firstScope.run(() => createWorkbenchSecondClock(ref(true)))!;
    const second = secondScope.run(() => createWorkbenchSecondClock(active))!;
    expect(vi.getTimerCount()).toBe(1);
    active.value = true;
    await nextTick();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(first.value).toBe(12_000);
    expect(second.value).toBe(first.value);
    firstScope.stop();
    expect(vi.getTimerCount()).toBe(1);
    active.value = false;
    await nextTick();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3000);
    expect(second.value).toBe(12_000);
    active.value = true;
    await nextTick();
    expect(second.value).toBe(15_000);
    secondScope.stop();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    firstScope.stop();
    secondScope.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
