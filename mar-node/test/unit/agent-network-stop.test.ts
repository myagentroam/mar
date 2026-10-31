import { describe, expect, it, vi } from 'vitest';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { RunWorkbenchService } from '../../src/service/run-workbench-service.js';

function fixture() {
  const runtime = new NodeRuntimeState(
    () => 'node',
    (id) => ({
      id,
      path: '/workspace',
      kind: 'DIRECTORY',
      gitSummary: null,
      createdAt: 1,
      updatedAt: 1
    })
  );
  const session = runtime.createAgentSession({
    workspaceId: 'workspace',
    runner: 'mar-agent',
    cwd: '/workspace'
  });
  const pauseQueue = vi.fn();
  const clearGoal = vi.fn<() => Readonly<Record<string, unknown>> | undefined>();
  const control = vi.fn();
  const service = new RunWorkbenchService({
    runtime,
    readImage: async () => undefined,
    respondUserInput: vi.fn(),
    pauseQueue,
    runInterrupted: clearGoal,
    emitRun: vi.fn(),
    control,
    markInterrupted: vi.fn()
  });
  return { runtime, session, pauseQueue, clearGoal, control, service };
}

describe('Agent Session stop owner', () => {
  it('clears an idle Session Goal and pauses its queue without fabricating execution cancellation', () => {
    const f = fixture();
    f.clearGoal.mockReturnValueOnce({ goalExit: { status: 'stopped' } });
    expect(f.service.stopAgentSession({ sessionId: f.session.id })).toEqual({
      status: 'IDLE',
      goalExit: { status: 'stopped' }
    });
    expect(f.pauseQueue).toHaveBeenCalledWith(f.session.id);
    expect(f.clearGoal).toHaveBeenCalledWith(f.session.id);
    expect(f.control).not.toHaveBeenCalled();
    expect(f.runtime.activeSessionRun(f.session.id)).toBeUndefined();
    expect(f.service.stopAgentSession({ sessionId: f.session.id })).toEqual({ status: 'IDLE' });
  });

  it('preserves queued-input ownership for an idle Session', () => {
    const f = fixture();
    f.runtime.createQueueItem({
      sessionId: f.session.id,
      clientMessageId: 'pending',
      content: 'work',
      initiatedByUserId: 7
    });
    expect(() => f.service.stopAgentSession({ sessionId: f.session.id, requestUserId: 8 })).toThrow(
      'RUN_OWNED_BY_ANOTHER_USER'
    );
    expect(f.pauseQueue).not.toHaveBeenCalled();
    expect(f.clearGoal).not.toHaveBeenCalled();
    expect(f.service.stopAgentSession({ sessionId: f.session.id, requestUserId: 7 })).toMatchObject(
      { status: 'IDLE' }
    );
  });

  it('does not clean up an unknown Session', () => {
    const f = fixture();
    expect(() => f.service.stopAgentSession({ sessionId: 'missing' })).toThrow('SESSION_NOT_FOUND');
    expect(f.pauseQueue).not.toHaveBeenCalled();
    expect(f.clearGoal).not.toHaveBeenCalled();
  });

  it('still clears an idle Goal when pausing its queue fails', () => {
    const f = fixture();
    f.pauseQueue.mockImplementationOnce(() => {
      throw new Error('QUEUE_PAUSE_FAILED');
    });
    expect(() => f.service.stopAgentSession({ sessionId: f.session.id })).toThrow(
      'QUEUE_PAUSE_FAILED'
    );
    expect(f.clearGoal).toHaveBeenCalledWith(f.session.id);
    expect(f.control).not.toHaveBeenCalled();
  });
});
