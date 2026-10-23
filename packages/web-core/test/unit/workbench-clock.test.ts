import { describe, expect, it } from 'vitest';
import { resolveWorkingStartedAt } from '../../src/service/WorkbenchClockService';
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
    expect(resolveWorkingStartedAt('session', true, { ...run, version: 4 })).toBe(9_000);
    expect(resolveWorkingStartedAt('other', true, run)).toBeUndefined();
    expect(resolveWorkingStartedAt('session', true, run)).toBe(9_000);
  });
  it('uses the new Run origin instead of merging continuous session activity', () => {
    expect(resolveWorkingStartedAt('session', true, { ...run, id: 'new', startedAt: 14_000 })).toBe(
      14_000
    );
  });
  it('does not invent an origin from browser observation, createdAt or a previous session', () => {
    expect(
      resolveWorkingStartedAt('session', true, { ...run, startedAt: null, createdAt: 5_000 })
    ).toBeUndefined();
    expect(resolveWorkingStartedAt('session', true, undefined)).toBeUndefined();
    expect(resolveWorkingStartedAt('session', false, run)).toBeUndefined();
    expect(resolveWorkingStartedAt(undefined, true, run)).toBeUndefined();
    expect(resolveWorkingStartedAt('session', true, { ...run, startedAt: NaN })).toBeUndefined();
  });
});
