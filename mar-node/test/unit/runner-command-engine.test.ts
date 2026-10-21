import { describe, expect, it } from 'vitest';
import {
  CommandStateStore,
  parseCommandInvocation,
  stripClaudePlanTag,
  withClaudePlanTag
} from '../../src/runner-command-engine.js';

const compact = {
  id: 'compact',
  runner: 'codex' as const,
  label: '/compact',
  description: '',
  inputHint: '/compact',
  source: 'CODEX_APP_SERVER' as const,
  interaction: 'IMMEDIATE_ACTION' as const,
  available: true,
  reasonCode: null
};
const plan = {
  ...compact,
  id: 'plan',
  label: '/plan',
  inputHint: '/plan',
  interaction: 'TOGGLE' as const
};
const clear = {
  ...compact,
  id: 'clear',
  label: '/clear',
  interaction: 'DESTRUCTIVE_ACTION' as const
};

describe('Runner Command Interaction Engine', () => {
  it('validates identity conflicts without moving state and preserves no-op migrations', () => {
    const states = new CommandStateStore();
    const state = {
      commandId: 'plan',
      active: true,
      label: 'Plan',
      detail: '',
      closable: true,
      closeInput: '/plan'
    };
    states.set('source', state);
    states.validateSessionIdentityPromotion('source', 'target');
    expect(states.get('source', 'plan')).toEqual(state);
    expect(states.get('target', 'plan')).toBeUndefined();
    states.set('target', state);
    expect(() => states.validateSessionIdentityPromotion('source', 'target')).toThrow(
      'SESSION_ID_CONFLICT'
    );
    expect(() => states.promoteSessionIdentity('source', 'target')).toThrow('SESSION_ID_CONFLICT');
    states.promoteSessionIdentity('source', 'source');
    states.promoteSessionIdentity('missing', 'target');
    expect(states.get('source', 'plan')).toEqual(state);
    expect(states.get('target', 'plan')).toEqual(state);
    states.removeSession('target');
    states.promoteSessionIdentity('source', 'target');
    expect(states.get('source', 'plan')).toBeUndefined();
    expect(states.get('target', 'plan')).toEqual(state);
  });

  it('validates complete slash text and immediate-command arguments according to the descriptor', () => {
    expect(parseCommandInvocation({ descriptor: compact }, '/compact')).toMatchObject({
      argument: ''
    });
    expect(() => parseCommandInvocation({ descriptor: compact }, '/compact now')).toThrow(
      'RUNNER_COMMAND_ARGUMENT_INVALID'
    );
    expect(() => parseCommandInvocation({ descriptor: compact }, '/unknown')).toThrow(
      'RUNNER_COMMAND_INVALID'
    );
    expect(() => parseCommandInvocation({ descriptor: plan }, '/plan write a plan')).toThrow(
      'RUNNER_COMMAND_ARGUMENT_INVALID'
    );
    expect(parseCommandInvocation({ descriptor: clear }, '/clear')).toMatchObject({ argument: '' });
    expect(() => parseCommandInvocation({ descriptor: clear }, '/clear now')).toThrow(
      'RUNNER_COMMAND_ARGUMENT_INVALID'
    );
  });

  it('projects active state only and removes the tag when closed', () => {
    const states = new CommandStateStore();
    states.set('session-1', {
      commandId: 'custom',
      active: true,
      label: 'custom status',
      detail: 'migration complete',
      closable: true,
      closeInput: '/custom clear'
    });
    expect(states.list('session-1')).toHaveLength(1);
    states.clear('session-1', 'custom');
    expect(states.list('session-1')).toEqual([]);
  });

  it('lets only Node commands manage Plan state', () => {
    const states = new CommandStateStore();
    states.set('session-1', {
      commandId: 'plan',
      active: true,
      label: 'Plan Mode',
      detail: 'Subsequent messages run in plan mode.',
      closable: true,
      closeInput: '/plan',
      continuation: {
        label: 'Execute',
        prompt: 'Start implementing the plan above.'
      }
    });
    expect(states.list('session-1')).toEqual([
      expect.objectContaining({
        commandId: 'plan',
        active: true,
        closable: true,
        continuation: {
          label: 'Execute',
          prompt: 'Start implementing the plan above.'
        }
      })
    ]);
  });

  it("attaches and strips Claude's tag-based Plan Mode instruction without loss", () => {
    const wrapped = withClaudePlanTag('Fix the login failure');
    expect(wrapped).toContain('<plan_mode>');
    expect(wrapped).toContain('<proposed_plan>');
    expect(wrapped.endsWith('Fix the login failure')).toBe(true);
    expect(stripClaudePlanTag(wrapped)).toBe('Fix the login failure');
    expect(stripClaudePlanTag('ordinary message')).toBe('ordinary message');
    expect(stripClaudePlanTag('<plan_mode>unclosed')).toBe('<plan_mode>unclosed');
  });
});
