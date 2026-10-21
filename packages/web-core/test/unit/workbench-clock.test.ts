import { describe, expect, it } from 'vitest';
import {
  resolveWorkingStartedAt,
  shouldDelayWorkingReset
} from '../../src/service/WorkbenchClockService';

describe('Web Workbench Working Clock', () => {
  it('Keeps the start time when a Run changes during continuous activity and restarts after idle', () => {
    const first = resolveWorkingStartedAt({
      previousSessionId: undefined,
      nextSessionId: 'session-1',
      busy: true,
      currentStartedAt: undefined,
      runCreatedAt: 9_000,
      now: 10_000
    });
    expect(first).toBe(9_000);
    expect(
      resolveWorkingStartedAt({
        previousSessionId: 'session-1',
        nextSessionId: 'session-1',
        busy: true,
        currentStartedAt: 10_000,
        runCreatedAt: 9_000,
        now: 10_000
      })
    ).toBe(9_000);
    expect(
      resolveWorkingStartedAt({
        previousSessionId: 'session-1',
        nextSessionId: 'session-1',
        busy: true,
        currentStartedAt: first,
        runCreatedAt: 14_000,
        now: 14_000
      })
    ).toBe(9_000);
    expect(
      resolveWorkingStartedAt({
        previousSessionId: 'session-1',
        nextSessionId: 'session-1',
        busy: false,
        currentStartedAt: first,
        runCreatedAt: undefined,
        now: 15_000
      })
    ).toBeUndefined();
    expect(
      resolveWorkingStartedAt({
        previousSessionId: 'session-1',
        nextSessionId: 'session-1',
        busy: true,
        currentStartedAt: undefined,
        runCreatedAt: undefined,
        now: 20_000
      })
    ).toBe(20_000);
  });

  it('Reuses the start time when returning to a busy session and lets the authoritative Run time replace stale cache data', () => {
    expect(
      resolveWorkingStartedAt({
        previousSessionId: 'session-2',
        nextSessionId: 'session-1',
        busy: true,
        currentStartedAt: undefined,
        knownSessionStartedAt: 9_000,
        runCreatedAt: undefined,
        now: 20_000
      })
    ).toBe(9_000);
    expect(
      resolveWorkingStartedAt({
        previousSessionId: 'session-2',
        nextSessionId: 'session-1',
        busy: true,
        currentStartedAt: undefined,
        knownSessionStartedAt: 9_000,
        runCreatedAt: 18_000,
        now: 20_000
      })
    ).toBe(18_000);
  });

  it('Delays the reset for queue handoff only when the same session becomes idle', () => {
    expect(shouldDelayWorkingReset('session-1', 'session-1')).toBe(true);
    expect(shouldDelayWorkingReset('session-1', 'session-2')).toBe(false);
    expect(shouldDelayWorkingReset('session-1', undefined)).toBe(false);
  });
});
