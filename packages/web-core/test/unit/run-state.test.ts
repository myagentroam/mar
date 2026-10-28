import { describe, expect, it } from 'vitest';
import { conversationWorkProcessBlocks } from '../../src/util/conversation-work-process.js';
import { createRunService } from '../../src/service/run-service.js';
import { isTerminalRunStatus, newestRunSnapshot } from '../../src/util/run-state.js';

describe('Shared Run State Convergence', () => {
  it.each([2, 3])(
    'restores an observed-idle Run from an authoritative snapshot at revision %s',
    (version) => {
      const state = createRunService({ value: 'session-1' } as never);
      const run = {
        id: 'run-1',
        sessionId: 'session-1',
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'message-1',
        version: 2
      };
      state.replaceRuns([run]);
      state.settleSessionRuns('session-1');
      state.observeManagedSessionActive('session-1');
      // An ordinary response is not authority to revive a settled Run.
      state.mergeSnapshots([{ ...run, version }]);
      expect(state.runs.value).toEqual([]);
      state.mergeAuthoritativeSnapshot([{ ...run, version }], [...state.runs.value]);
      expect(state.runs.value).toEqual([{ ...run, version }]);
      expect(state.sessionInterruptionSettled('session-1')).toBe(false);
      const blocks = conversationWorkProcessBlocks(
        [
          {
            id: 'segment-1',
            sessionId: 'session-1',
            runId: run.id,
            status: 'RUNNING',
            items: [
              {
                id: 'command-1',
                kind: 'command_execution',
                status: 'COMPLETED',
                processGroup: { id: 'process-1', isStart: true },
                payload: { command: 'pwd' }
              }
            ]
          }
        ] as never,
        state.runs.value
      );
      expect(blocks[0]).toMatchObject({ active: true, status: 'running' });
    }
  );

  it('preserves stop protection when a user stops an already observed-idle session', () => {
    const state = createRunService({ value: 'session-1' } as never);
    const run = {
      id: 'run-1',
      sessionId: 'session-1',
      status: 'RUNNING',
      recoveryState: 'ACTIVE',
      clientMessageId: 'message-1',
      version: 2
    };
    state.replaceRuns([run]);
    state.settleSessionRuns('session-1');
    state.markSessionInterruptionPending('session-1');
    state.resumeSessionAfterInterruption('session-1');
    state.mergeAuthoritativeSnapshot([run], []);
    expect(state.runs.value).toEqual([]);
  });

  it.each(['settled', 'acknowledged', 'resumed'])(
    'does not restore a user-stopped Run from an authoritative snapshot after %s',
    (phase) => {
      const state = createRunService({ value: 'session-1' } as never);
      const run = {
        id: 'run-1',
        sessionId: 'session-1',
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'message-1',
        version: 2
      };
      state.replaceRuns([run]);
      state.settleSessionRuns('session-1', true);
      if (phase !== 'settled') state.markSessionInterrupted('session-1', run.id);
      if (phase === 'resumed') state.resumeSessionAfterInterruption('session-1');
      state.observeManagedSessionActive('session-1');
      state.mergeAuthoritativeSnapshot([{ ...run, version: 3 }], []);
      expect(state.runs.value).toEqual([]);
      state.mergeAuthoritativeSnapshot([{ ...run, status: 'CANCELLED', version: 4 }], []);
      expect(state.runs.value).toEqual([{ ...run, status: 'CANCELLED', version: 4 }]);
    }
  );

  it('Compares Run revisions first; an old terminal state cannot overwrite a newer active state, and equal revisions cannot move the state backward', () => {
    const current = {
      id: 'run-1',
      sessionId: 'session-1',
      status: 'RUNNING',
      recoveryState: 'ACTIVE',
      clientMessageId: 'message-1',
      version: 3
    };
    expect(newestRunSnapshot(current, { ...current, status: 'SUCCEEDED', version: 2 })).toBe(
      current
    );
    expect(newestRunSnapshot(current, { ...current, status: 'STARTING' })).toBe(current);
    expect(newestRunSnapshot(current, { ...current, status: 'SUCCEEDED' }).status).toBe(
      'SUCCEEDED'
    );
  });

  it('Keeps an active Run received in real time instead of rolling it back with an older snapshot', () => {
    const selectedSessionId = { value: 'session-1' } as never;
    const state = createRunService(selectedSessionId);
    state.replaceRuns([
      {
        id: 'run-live',
        sessionId: 'session-1',
        status: 'RUNNING',
        recoveryState: 'LIVE',
        clientMessageId: 'message-live',
        version: 2
      }
    ]);

    state.mergeSnapshots([
      {
        id: 'run-old',
        sessionId: 'session-1',
        status: 'SUCCEEDED',
        recoveryState: 'FINAL',
        clientMessageId: 'message-old'
      }
    ]);

    expect(state.runs.value.map((run) => run.id)).toEqual(['run-live', 'run-old']);
    expect(
      newestRunSnapshot(state.runs.value[0], { ...state.runs.value[0]!, status: 'STARTING' }).status
    ).toBe('RUNNING');
  });

  it('An authoritative Session snapshot silently removes an active Run that existed before refresh but is no longer returned by Node', () => {
    const state = createRunService({ value: 'session-1' } as never);
    state.replaceRuns([
      {
        id: 'run-stale',
        sessionId: 'session-1',
        status: 'RUNNING',
        recoveryState: 'LIVE',
        clientMessageId: 'message-stale'
      }
    ]);
    state.selectedRunId.value = 'run-stale';

    state.mergeAuthoritativeSnapshot([], [...state.runs.value]);

    expect(state.runs.value).toEqual([]);
    expect(state.selectedRunId.value).toBeUndefined();
  });

  it('An authoritative Session snapshot does not remove a Run added by a real-time event after refresh began', () => {
    const state = createRunService({ value: 'session-1' } as never);
    state.replaceRuns([
      {
        id: 'run-stale',
        sessionId: 'session-1',
        status: 'RUNNING',
        recoveryState: 'LIVE',
        clientMessageId: 'message-stale'
      }
    ]);
    const baseline = [...state.runs.value];
    state.replaceRuns([
      ...state.runs.value,
      {
        id: 'run-realtime',
        sessionId: 'session-1',
        status: 'RUNNING',
        recoveryState: 'LIVE',
        clientMessageId: 'message-realtime'
      }
    ]);

    state.mergeAuthoritativeSnapshot([], baseline);

    expect(state.runs.value).toEqual([expect.objectContaining({ id: 'run-realtime' })]);
  });

  it('An authoritative Session snapshot does not remove the same Run updated by a real-time event while refresh is in flight', () => {
    const state = createRunService({ value: 'session-1' } as never);
    state.replaceRuns([
      {
        id: 'run-1',
        sessionId: 'session-1',
        status: 'STARTING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'message-1',
        version: 1
      }
    ]);
    const baseline = [...state.runs.value];
    state.replaceRuns([{ ...state.runs.value[0]!, status: 'RUNNING', version: 2 }]);

    state.mergeAuthoritativeSnapshot([], baseline);

    expect(state.runs.value).toEqual([
      expect.objectContaining({ id: 'run-1', status: 'RUNNING', version: 2 })
    ]);
  });

  it('Stops settling the Session after recording RUN_NOT_FOUND and clears that state when a new active Run arrives', () => {
    const state = createRunService({ value: 'session-1' } as never);
    state.markSessionInterrupted('session-1');
    expect(state.sessionInterruptionSettled('session-1')).toBe(true);
    state.mergeSnapshots([
      {
        id: 'run-1',
        sessionId: 'session-1',
        status: 'RUNNING',
        recoveryState: 'LIVE',
        clientMessageId: 'message-1'
      }
    ]);
    expect(state.sessionInterruptionSettled('session-1')).toBe(false);
    expect(isTerminalRunStatus('CANCELLED')).toBe(true);
    expect(isTerminalRunStatus('RUNNING')).toBe(false);
  });

  it('A new message after stopping clears the settlement; a late response to the old stop cannot hide the new Run again', () => {
    const state = createRunService({ value: 'session-1' } as never);
    state.replaceRuns([
      {
        id: 'run-old',
        sessionId: 'session-1',
        status: 'RUNNING',
        recoveryState: 'LIVE',
        clientMessageId: 'message-old'
      }
    ]);
    state.settleSessionRuns('session-1');
    state.resumeSessionAfterInterruption('session-1');
    state.markSessionInterrupted('session-1', 'run-old');
    state.mergeSnapshots([
      {
        id: 'run-old',
        sessionId: 'session-1',
        status: 'CANCELLING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'message-old'
      },
      {
        id: 'run-new',
        sessionId: 'session-1',
        status: 'RUNNING',
        recoveryState: 'LIVE',
        clientMessageId: 'message-new'
      }
    ]);

    expect(state.sessionInterruptionSettled('session-1')).toBe(false);
    expect(state.runs.value).toEqual([expect.objectContaining({ id: 'run-new' })]);
  });

  it('A Session idle authority event settles an active Run when its terminal frame is missing', () => {
    const state = createRunService({ value: 'session-1' } as never);
    state.replaceRuns([
      {
        id: 'run-stale',
        sessionId: 'session-1',
        status: 'CANCELLING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'message-stale'
      },
      {
        id: 'run-other',
        sessionId: 'session-2',
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'message-other'
      }
    ]);
    state.selectedRunId.value = 'run-stale';

    expect(state.settleSessionRuns('session-1')).toBe(true);

    expect(state.runs.value.map((run) => run.id)).toEqual(['run-other']);
    expect(state.selectedRunId.value).toBeUndefined();
    expect(state.sessionInterruptionSettled('session-1')).toBe(true);
    expect(state.settleSessionRuns('session-1')).toBe(false);
  });

  it('New managed activity clears ordinary idle settlement but not a user-initiated stop', () => {
    const normal = createRunService({ value: 'session-1' } as never);
    normal.replaceRuns([
      {
        id: 'run-old',
        sessionId: 'session-1',
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'message-old'
      }
    ]);
    normal.settleSessionRuns('session-1');
    normal.observeManagedSessionActive('session-1');
    expect(normal.sessionInterruptionSettled('session-1')).toBe(false);

    const interrupted = createRunService({ value: 'session-1' } as never);
    interrupted.replaceRuns([
      {
        id: 'run-stopped',
        sessionId: 'session-1',
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'message-stopped'
      }
    ]);
    interrupted.settleSessionRuns('session-1', true);
    interrupted.observeManagedSessionActive('session-1');
    expect(interrupted.sessionInterruptionSettled('session-1')).toBe(true);
  });
});
