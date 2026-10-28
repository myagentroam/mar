import { describe, expect, it, vi } from 'vitest';
import { ExecutionLifecycle } from '../../src/application/execution-lifecycle.js';

describe('execution lifecycle', () => {
  it('suppresses queued dispatch during upgrade and otherwise respects the delay', async () => {
    let pending = true;
    const continuous = { schedule: vi.fn(), dispatch: vi.fn(async () => {}) };
    const owner = new ExecutionLifecycle(
      () => true,
      {} as never,
      continuous as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { pending: () => pending } as never
    );
    await owner.dispatchQueue('session');
    expect(continuous.dispatch).not.toHaveBeenCalled();
    pending = false;
    await owner.dispatchQueue('session', 10);
    expect(continuous.schedule).toHaveBeenCalledWith('session', 10);
    await owner.dispatchQueue('session');
    expect(continuous.dispatch).toHaveBeenCalledWith('session');
  });

  it('keeps terminal, progress and release ordering across owners', () => {
    const calls: string[] = [];
    const scheduled = { executionTerminated: vi.fn(() => calls.push('scheduled')) };
    const continuous = {
      runTerminated: vi.fn(() => calls.push('terminal')),
      remove: vi.fn(() => calls.push('remove'))
    };
    const goal = {
      releaseExecution: vi.fn(() => calls.push('goal-release')),
      executionProgress: vi.fn(() => calls.push('progress'))
    };
    const usage = { release: vi.fn(() => calls.push('usage')) };
    const mcp = (name: string) => ({ revoke: vi.fn(() => calls.push(name)) });
    const events = { emitConversationItem: vi.fn(() => calls.push('event')) };
    let available = true;
    const owner = new ExecutionLifecycle(
      () => available,
      scheduled as never,
      continuous as never,
      goal as never,
      usage as never,
      mcp('goal-mcp') as never,
      mcp('schedule-mcp') as never,
      mcp('notification-mcp') as never,
      events as never,
      { pending: () => false } as never
    );
    owner.terminal({ sessionId: 'session' } as never, 'SUCCEEDED');
    owner.emitItem('run', {});
    owner.release('run');
    expect(calls).toEqual([
      'scheduled',
      'terminal',
      'progress',
      'event',
      'usage',
      'goal-release',
      'goal-mcp',
      'schedule-mcp',
      'notification-mcp',
      'remove'
    ]);
    available = false;
    owner.terminal({ sessionId: 'session' } as never, 'FAILED');
    expect(scheduled.executionTerminated).toHaveBeenCalledOnce();
    expect(continuous.runTerminated).toHaveBeenCalledTimes(2);
  });
});
