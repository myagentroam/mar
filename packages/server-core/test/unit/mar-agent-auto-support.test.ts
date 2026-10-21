import { describe, expect, it, vi } from 'vitest';
import { requireMarAgentAutoSupport } from '../../src/mar-agent-auto-support.js';

const profile = {
  runner: 'mar-agent',
  models: [],
  commands: [],
  capabilities: [],
  accessOptions: [{ id: 'auto', label: 'Auto', description: 'Auto', isDefault: true }]
};

describe('MAR Agent Auto compatibility preflight', () => {
  it('leaves explicit Full access and other runners alone', async () => {
    const request = vi.fn();
    await requireMarAgentAutoSupport({ access: 'full-access', runner: 'mar-agent', request });
    await requireMarAgentAutoSupport({ access: 'auto', runner: 'opencode', request });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { manifest: { runners: [] } },
    { manifest: { runners: [{ ...profile, accessOptions: [] }] } }
  ])('rejects unsupported or malformed Node capabilities', async (result) => {
    await expect(
      requireMarAgentAutoSupport({
        access: 'auto',
        runner: 'mar-agent',
        request: async () => result
      })
    ).rejects.toThrow('MAR_AGENT_AUTO_UNSUPPORTED');
  });

  it('accepts a current Node profile for new and existing sessions', async () => {
    const request = vi.fn(async (operation: string) =>
      operation === 'session.get'
        ? { session: { runner: 'mar-agent' } }
        : { manifest: { runners: [profile] } }
    );
    await requireMarAgentAutoSupport({ access: 'auto', runner: 'mar-agent', request });
    await requireMarAgentAutoSupport({ access: 'auto', sessionId: 'session-1', request });
    expect(request).toHaveBeenCalledWith('session.get', { sessionId: 'session-1' });
  });
});
