import { describe, expect, it } from 'vitest';
import { parseAgentGoal } from '../../src/service/agent-network-goal.js';

describe('Agent Network Goal input', () => {
  it('leaves the Goal unchanged when omitted or null', () => {
    expect(parseAgentGoal(undefined)).toEqual({ kind: 'unchanged' });
    expect(parseAgentGoal(null)).toEqual({ kind: 'unchanged' });
  });

  it('sets an objective or explicitly clears it', () => {
    expect(parseAgentGoal({ objective: '  Build it  ' })).toEqual({
      kind: 'set',
      objective: 'Build it'
    });
    expect(parseAgentGoal({ clear: true })).toEqual({ kind: 'clear' });
  });

  it.each([
    {},
    { clear: false },
    { objective: '' },
    { objective: 'x', clear: true },
    { objective: 'x', extra: true },
    'x',
    []
  ])('rejects invalid Goal input %j', (input) => {
    expect(() => parseAgentGoal(input)).toThrow('AGENT_GOAL_INVALID');
  });
});
