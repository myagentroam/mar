import { describe, expect, it, vi } from 'vitest';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';

const { history, close } = vi.hoisted(() => ({ history: vi.fn(), close: vi.fn() }));
vi.mock('@myagentroam/agent', async (original) => ({
  ...(await original<typeof import('@myagentroam/agent')>()),
  openAgentSessionCatalog: async () => ({ history, close })
}));

describe('MAR Agent restart input reconciliation', () => {
  const user = { kind: 'user', turnId: 'turn', clientMessageId: 'input' };
  const event = (type: string, extra = {}) => ({
    kind: 'event',
    event: { type, turnId: 'turn', ...extra }
  });
  it.each([
    ['execution.completed', {}, 'completed'],
    ['execution.completed', { permissionStop: { decision: 'ask' } }, 'paused'],
    ['execution.failed', { code: 'FAILED' }, 'completed'],
    ['execution.cancelled', {}, 'interrupted']
  ])('reads the SDK terminal fact %s as %s', async (type, extra, state) => {
    history
      .mockReset()
      .mockResolvedValue({ entries: [user, event(type as string, extra)], nextCursor: undefined });
    close.mockReset();
    expect(await new MarAgentRunner('/isolated-home').restartInputState('session', 'input')).toBe(
      state
    );
    expect(close).toHaveBeenCalledOnce();
  });
  it('keeps terminal facts when their user record is on an earlier history page', async () => {
    history
      .mockReset()
      .mockResolvedValueOnce({ entries: [event('execution.completed')], nextCursor: 'older' })
      .mockResolvedValueOnce({ entries: [user] });
    expect(await new MarAgentRunner('/isolated-home').restartInputState('session', 'input')).toBe(
      'completed'
    );
    expect(history).toHaveBeenLastCalledWith('session', { cursor: 'older', limit: 1000 });
  });
  it.each([
    [[], 'missing'],
    [[user], 'interrupted']
  ])('distinguishes unaccepted inputs from interrupted ones', async (entries, state) => {
    history.mockReset().mockResolvedValue({ entries });
    expect(await new MarAgentRunner('/isolated-home').restartInputState('session', 'input')).toBe(
      state
    );
  });
});
