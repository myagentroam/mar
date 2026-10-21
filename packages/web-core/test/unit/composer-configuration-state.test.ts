import { describe, expect, it } from 'vitest';
import { createComposerConfigurationService } from '../../src/service/ComposerConfigurationService.js';

describe('Web Composer Configuration State', () => {
  it('Prefers MAR Agent for a new session', () => {
    const state = createComposerConfigurationService({
      selectedSession: { value: undefined } as never,
      profiles: { value: [] } as never,
      effortLabel: (value) => value
    });

    expect(state.runner.value).toBe('mar-agent');
    expect(state.runnerLabel.value).toBe('MAR Agent');
  });

  it('Falls back to the model default reasoning effort when the runner configuration is incompatible', () => {
    const selectedSession = { value: undefined };
    const profiles = {
      value: [
        {
          runner: 'codex' as const,
          models: [{ id: 'gpt-5.6', label: 'GPT-5.6', supportedEfforts: ['low', 'medium'] }],
          accessOptions: [{ id: 'on-request', label: 'On-request' }],
          commands: [],
          capabilities: []
        }
      ]
    };
    const state = createComposerConfigurationService({
      selectedSession: selectedSession as never,
      profiles: profiles as never,
      effortLabel: (value) => value
    });

    state.apply({ runner: 'codex', model: 'removed-model', effort: 'high', access: 'full' });

    expect(state.model.value).toBe('gpt-5.6');
    expect(state.effort.value).toBe('medium');
    expect(state.modelEffortLabel.value).toBe('GPT-5.6 medium');
    expect(state.access.value).toBe('on-request');
  });

  it('Clears the old effort when the model does not support reasoning effort', () => {
    const state = createComposerConfigurationService({
      selectedSession: { value: undefined } as never,
      profiles: {
        value: [
          {
            runner: 'codex',
            models: [{ id: 'gpt-5.6', label: 'GPT-5.6', supportedEfforts: [] }],
            accessOptions: [{ id: 'on-request', label: 'On-request' }],
            commands: [],
            capabilities: []
          }
        ]
      } as never,
      effortLabel: (value) => value
    });

    state.apply({ runner: 'codex', model: 'gpt-5.6', effort: 'medium', access: 'on-request' });

    expect(state.effort.value).toBe('');
    expect(state.modelEffortLabel.value).toBe('GPT-5.6');
  });

  it('Restores the model default effort when the public reasoning effort is empty but a default exists', () => {
    const state = createComposerConfigurationService({
      selectedSession: { value: undefined } as never,
      profiles: {
        value: [
          {
            runner: 'mar-agent',
            models: [
              {
                id: 'gpt-5.6-terra',
                label: 'GPT-5.6 Terra',
                supportedEfforts: [],
                defaultEffort: 'medium'
              }
            ],
            accessOptions: [{ id: 'on-request', label: 'On-request' }],
            commands: [],
            capabilities: []
          }
        ]
      } as never,
      effortLabel: (value) => value
    });

    state.apply({
      runner: 'mar-agent',
      model: 'gpt-5.6-terra',
      effort: 'high',
      access: 'on-request'
    });

    expect(state.effort.value).toBe('medium');
  });

  it('Uses the selected session to determine the displayed runner', () => {
    const selectedSession = {
      value: {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'claude-code' as const
      }
    };
    const profiles = {
      value: [
        {
          runner: 'claude-code' as const,
          models: [],
          accessOptions: [],
          commands: [],
          capabilities: []
        }
      ]
    };
    const state = createComposerConfigurationService({
      selectedSession: selectedSession as never,
      profiles: profiles as never,
      effortLabel: (value) => value
    });

    expect(state.activeRunner.value).toBe('claude-code');
    expect(state.runnerLabel.value).toBe('Claude Code');
  });
});
