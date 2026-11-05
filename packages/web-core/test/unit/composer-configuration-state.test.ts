import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { createComposerConfigurationService } from '../../src/service/composer-configuration-service.js';

describe('Web Composer Configuration State', () => {
  it('keeps the saved child model visible without granting it selectable status', () => {
    const selectedSession = ref({
      id: 'child',
      runner: 'mar-agent',
      sessionGroup: 'CHILD',
      modelId: 'configured-model',
      effort: 'high'
    });
    const profiles = ref([
      {
        runner: 'mar-agent',
        models: [{ id: 'configured-model', label: 'Configured model', subagentModel: false }],
        accessOptions: [],
        commands: [],
        capabilities: []
      }
    ]);
    const state = createComposerConfigurationService({
      selectedSession: selectedSession as never,
      profiles: profiles as never,
      effortLabel: (value) => value
    });
    state.apply({
      runner: 'mar-agent',
      modelId: 'configured-model',
      effort: 'high',
      access: 'auto'
    });
    expect(state.modelEffortLabel.value).toBe('Configured model high');
    expect(state.models.value).toEqual([]);
    expect(state.modelId.value).toBe('');
    profiles.value = [];
    expect(state.modelEffortLabel.value).toBe('configured-model high');
    expect(state.models.value).toEqual([]);
  });

  it('limits MAR child session models to the Subagent-enabled conversation candidates', () => {
    const session = ref({
      id: 'child',
      workspaceId: 'workspace',
      runner: 'mar-agent',
      sessionGroup: 'CHILD'
    });
    const profiles = ref([
      {
        runner: 'mar-agent',
        models: [
          {
            id: 'conversation',
            label: 'Conversation',
            supportedEfforts: ['medium'],
            subagentModel: false
          },
          {
            id: 'delegation',
            label: 'Delegation',
            supportedEfforts: ['medium'],
            subagentModel: true
          }
        ],
        accessOptions: [],
        commands: [],
        capabilities: []
      }
    ]);
    const state = createComposerConfigurationService({
      selectedSession: session as never,
      profiles: profiles as never,
      effortLabel: (value) => value
    });
    expect(state.models.value.map((model) => model.id)).toEqual(['delegation']);
    state.apply({ runner: 'mar-agent', modelId: 'conversation', effort: 'medium', access: 'auto' });
    expect(state.modelId.value).toBe('delegation');
    profiles.value[0]!.models[1]!.subagentModel = false;
    expect(state.models.value).toEqual([]);
    state.normalize();
    expect(state.modelId.value).toBe('');
    session.value.sessionGroup = 'MAIN';
    expect(state.models.value.map((model) => model.id)).toEqual(['conversation', 'delegation']);
    session.value.runner = 'codex';
    profiles.value[0]!.runner = 'codex';
    session.value.sessionGroup = 'CHILD';
    expect(state.models.value.map((model) => model.id)).toEqual(['conversation', 'delegation']);
  });
  it('Prefers MAR Agent for a new session', () => {
    const state = createComposerConfigurationService({
      selectedSession: { value: undefined } as never,
      profiles: { value: [] } as never,
      effortLabel: (value) => value
    });

    expect(state.runner.value).toBe('mar-agent');
    expect(state.runnerLabel.value).toBe('MAR Agent');
    // Keep these ownership checks type-only; executing them would mutate the fixture.
    const assertReadonly = () => {
      // @ts-expect-error Configuration values are writable only through their owner.
      state.runner.value = 'codex';
      // @ts-expect-error Model selection is installed through its owner command.
      state.modelId.value = 'other';
      // @ts-expect-error The owner controls the transient selection.
      state.modelEffortSelection.value = undefined;
    };
    expect(assertReadonly).toBeTypeOf('function');
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

    state.apply({ runner: 'codex', modelId: 'removed-model', effort: 'high', access: 'full' });

    expect(state.modelId.value).toBe('gpt-5.6');
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

    state.apply({ runner: 'codex', modelId: 'gpt-5.6', effort: 'medium', access: 'on-request' });

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
      modelId: 'gpt-5.6-terra',
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
