import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import type { RunnerCommandState } from '../../src/model/workbench.js';
import {
  createRunnerInteractionService,
  quickPromptAtCursor,
  removeSlashCommandAtCursor,
  replaceQuickPromptAtCursor
} from '../../src/service/runner-interaction-service.js';
import { composerZhCN } from '../../src/i18n/composer.js';
import { localePreferenceService } from '../../src/service/locale-preference-service.js';

const command = {
  id: 'compact',
  runner: 'codex' as const,
  label: 'Compression',
  description: 'Compress Context',
  inputHint: '',
  source: 'CODEX_APP_SERVER' as const,
  interaction: 'IMMEDIATE_ACTION' as const,
  available: true,
  reasonCode: null
};

describe('Runner command availability', () => {
  it('hides unavailable commands and rejects stale picker selections without changing the draft', () => {
    const input = ref('/');
    const available = ref(true);
    const state = createRunnerInteractionService({
      input,
      draftSessionOpen: ref(false),
      selectedSession: ref(undefined),
      profile: ref({
        runner: 'codex',
        models: [],
        accessOptions: [],
        commands: [command],
        capabilities: []
      }),
      commandAvailable: () => available.value
    });
    expect(state.visibleCommands.value).toEqual([command]);
    available.value = false;
    expect(state.visibleCommands.value).toEqual([]);
    let sent = false;
    state.selectCommand(command, () => {
      sent = true;
    });
    expect(sent).toBe(false);
    expect(input.value).toBe('/');
    expect(state.selectedCommand.value).toBeUndefined();
  });
});

describe('Web Runner Interaction Status', () => {
  it('Select any Slash command to consume only the command words at the cursor and keep the draft', () => {
    expect(removeSlashCommandAtCursor('Keep this draft\n/plan')).toBe('Keep this draft\n');
    expect(removeSlashCommandAtCursor('Keep this draft /p')).toBe('Keep this draft ');
    expect(removeSlashCommandAtCursor('Keep this draft\n/px')).toBe('Keep this draft\n');

    type Options = Parameters<typeof createRunnerInteractionService>[0];
    const input = { value: 'Keep this draft\n/p' } as Options['input'];
    const state = createRunnerInteractionService({
      input,
      draftSessionOpen: { value: false } as Options['draftSessionOpen'],
      selectedSession: { value: undefined } as Options['selectedSession'],
      profile: {
        value: {
          runner: 'codex',
          models: [],
          accessOptions: [],
          commands: [command],
          capabilities: []
        }
      } as unknown as Options['profile']
    });
    state.updatePicker(input.value.length);
    let preserveDraft = false;
    state.selectCommand({ ...command, id: 'plan', interaction: 'TOGGLE' }, (value) => {
      preserveDraft = value;
    });

    expect(input.value).toBe('Keep this draft\n');
    expect(preserveDraft).toBe(true);
  });

  it('Enter Select the Slash command to also keep the draft flag', () => {
    type Options = Parameters<typeof createRunnerInteractionService>[0];
    const plan = { ...command, id: 'plan', interaction: 'TOGGLE' as const };
    const input = { value: 'abcd /pla' } as Options['input'];
    const state = createRunnerInteractionService({
      input,
      draftSessionOpen: { value: false } as Options['draftSessionOpen'],
      selectedSession: { value: undefined } as Options['selectedSession'],
      profile: {
        value: {
          runner: 'codex',
          models: [],
          accessOptions: [],
          commands: [plan],
          capabilities: []
        }
      } as unknown as Options['profile']
    });
    state.updatePicker(input.value.length);
    const sends: Array<readonly [boolean, boolean | undefined]> = [];

    state.onKeydown(
      {
        key: 'Enter',
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        preventDefault() {}
      } as KeyboardEvent,
      {
        mobile: false,
        canInterrupt: false,
        stop: () => undefined,
        send: (replaceCurrent, preserveDraft) => sends.push([replaceCurrent, preserveDraft])
      }
    );

    expect(input.value).toBe('abcd ');
    expect(sends).toEqual([[false, true]]);
  });

  it('filters commands at the cursor and projects deferred commands for a new session', () => {
    type Options = Parameters<typeof createRunnerInteractionService>[0];
    const input = { value: 'Existing content\n/comp' } as Options['input'];
    const draftSessionOpen = { value: true } as Options['draftSessionOpen'];
    const selectedSession = { value: undefined } as Options['selectedSession'];
    const profile = {
      value: {
        runner: 'codex',
        models: [],
        accessOptions: [],
        commands: [command],
        capabilities: []
      }
    } as unknown as Options['profile'];
    const state = createRunnerInteractionService({
      input,
      draftSessionOpen,
      selectedSession,
      profile
    });
    state.deferredDraftCommands.value = [{ command, input: '/compact' }];

    expect(state.visibleCommands.value).toEqual([command]);
    state.updatePicker(1);
    expect(state.commandPickerOpen.value).toBe(false);
    state.updatePicker(input.value.length);
    expect(state.commandPickerOpen.value).toBe(true);
    state.activeCommandIndex.value = 2;
    state.updatePicker(input.value.length);
    expect(state.activeCommandIndex.value).toBe(2);
    input.value = 'Existing content\n/plan';
    state.updatePicker(input.value.length);
    expect(state.activeCommandIndex.value).toBe(0);
    expect(state.activeCommandStates.value[0]).toMatchObject({
      commandId: 'compact',
      active: true,
      closable: true
    });

    state.reset();
    expect(state.deferredDraftCommands.value).toEqual([]);
    expect(state.composerMode.value).toBe('message');
  });

  it("New Session Draft State Localized Mar Agent's Plan Command Label", () => {
    type Options = Parameters<typeof createRunnerInteractionService>[0];
    const plan = {
      ...command,
      id: 'plan',
      runner: 'mar-agent' as const,
      label: '/plan',
      interaction: 'TOGGLE' as const
    };
    const state = createRunnerInteractionService({
      input: { value: '' } as Options['input'],
      draftSessionOpen: { value: true } as Options['draftSessionOpen'],
      selectedSession: { value: undefined } as Options['selectedSession'],
      profile: { value: undefined } as Options['profile']
    });
    state.stageDraftCommand(plan, '/plan');

    localePreferenceService().setLocale('zh-CN');
    expect(state.activeCommandStates.value[0]?.label).toBe(
      composerZhCN.runnerProfiles.planModeLabel
    );
    localePreferenceService().setLocale('en-US');
    expect(state.activeCommandStates.value[0]?.label).toBe('Plan Mode');
    localePreferenceService().setLocale('zh-CN');
  });

  it('Keep active when a new session repeatedly enters a persistent task', () => {
    type Options = Parameters<typeof createRunnerInteractionService>[0];
    const goal = { ...command, id: 'goal', interaction: 'TOGGLE' as const };
    const state = createRunnerInteractionService({
      input: { value: '' } as Options['input'],
      draftSessionOpen: { value: true } as Options['draftSessionOpen'],
      selectedSession: { value: undefined } as Options['selectedSession'],
      profile: { value: undefined } as Options['profile']
    });

    state.stageDraftCommand(goal, '/goal');
    state.stageDraftCommand(goal, '/goal');

    expect(state.deferredDraftCommands.value).toEqual([{ command: goal, input: '/goal' }]);
  });

  it('Show the Composer command Tag only when the persistent task is waiting for a target', () => {
    type Options = Parameters<typeof createRunnerInteractionService>[0];
    const selectedSessionSource = ref<{ commandStates: RunnerCommandState[] }>({
      commandStates: [
        {
          commandId: 'goal',
          active: true,
          label: 'Goal',
          detail: null,
          closable: true,
          closeInput: '/goal'
        }
      ]
    });
    const selectedSession = selectedSessionSource as unknown as Options['selectedSession'];
    const state = createRunnerInteractionService({
      input: ref('') as Options['input'],
      draftSessionOpen: ref(false) as Options['draftSessionOpen'],
      selectedSession,
      profile: ref(undefined) as Options['profile']
    });

    expect(state.activeCommandStates.value).toHaveLength(1);
    selectedSessionSource.value = {
      ...selectedSessionSource.value,
      commandStates: [
        {
          commandId: 'goal',
          active: true,
          label: 'Goal',
          detail: 'Objectives',
          closable: true,
          closeInput: '/goal',
          goal: {
            id: '83e62082-b910-4d87-a4a3-9cd94877f35f',
            objective: 'Objectives',
            revision: 1,
            status: 'active',
            turns: 1
          }
        }
      ]
    };
    expect(state.activeCommandStates.value).toEqual([]);
  });

  it.each([false, true])(
    'preserves Enter and Ctrl+Enter intent with Goal active=%s',
    (goalActive) => {
      type Options = Parameters<typeof createRunnerInteractionService>[0];
      const state = createRunnerInteractionService({
        input: { value: 'Continue' } as Options['input'],
        draftSessionOpen: { value: false } as Options['draftSessionOpen'],
        selectedSession: {
          value: goalActive
            ? {
                commandStates: [
                  {
                    commandId: 'goal',
                    active: true,
                    goal: {
                      id: 'goal-1',
                      objective: 'Complete the feature',
                      revision: 1,
                      status: 'active'
                    }
                  }
                ]
              }
            : undefined
        } as Options['selectedSession'],
        profile: { value: undefined } as Options['profile']
      });
      const sends: boolean[] = [];
      const keydown = (ctrlKey: boolean) =>
        state.onKeydown(
          {
            key: 'Enter',
            ctrlKey,
            shiftKey: false,
            altKey: false,
            preventDefault() {}
          } as KeyboardEvent,
          {
            mobile: false,
            canInterrupt: false,
            stop: () => undefined,
            send: (replaceCurrent) => sends.push(replaceCurrent)
          }
        );

      keydown(true);
      keydown(false);
      expect(sends).toEqual([true, false]);

      state.onKeydown(
        {
          key: 'Enter',
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          preventDefault() {}
        } as KeyboardEvent,
        {
          mobile: false,
          canInterrupt: false,
          stop: () => undefined,
          send: (replaceCurrent) => sends.push(replaceCurrent)
        }
      );
      expect(sends).toEqual([true, false, true]);
      state.onKeydown(
        {
          key: 'Enter',
          preventDefault(): void {
            throw new Error('Mobile Enter must remain a newline');
          }
        } as KeyboardEvent,
        {
          mobile: true,
          canInterrupt: true,
          stop: () => undefined,
          send: (replaceCurrent) => sends.push(replaceCurrent)
        }
      );
      expect(sends).toEqual([true, false, true]);
    }
  );

  it('Identify and replace shortcut words at the cursor, leaving drafts around', () => {
    expect(quickPromptAtCursor('Continue with #rev')).toBe('rev');
    expect(quickPromptAtCursor('#codeReview')).toBe('codereview');
    expect(quickPromptAtCursor('Header # normal body')).toBeUndefined();
    expect(replaceQuickPromptAtCursor('Before #rev After', 'Please review the code', 11)).toEqual({
      value: 'Before Please review the code After',
      cursor: 29
    });

    type Options = Parameters<typeof createRunnerInteractionService>[0];
    const input = { value: 'Before #rev After' } as Options['input'];
    const state = createRunnerInteractionService({
      input,
      draftSessionOpen: { value: false } as Options['draftSessionOpen'],
      selectedSession: { value: undefined } as Options['selectedSession'],
      profile: { value: undefined } as Options['profile'],
      quickPrompts: ref([
        { id: 'prompt-1', phrase: 'review', prompt: 'Please review the code', updatedAt: 1 }
      ])
    });
    state.updatePicker(11);
    expect(state.pickerKind.value).toBe('quick-prompt');
    expect(state.visibleQuickPrompts.value).toHaveLength(1);
    expect(state.selectQuickPrompt(state.visibleQuickPrompts.value[0]!)).toBe(29);
    expect(input.value).toBe('Before Please review the code After');
  });

  it('ranks quick prompts by exact, prefix, then substring matches and selects the exact match on Enter', () => {
    type Options = Parameters<typeof createRunnerInteractionService>[0];
    const input = ref('#');
    const prompts = [
      { id: 'body', phrase: 'fix', prompt: 'rfl in the body only', updatedAt: 6 },
      { id: 'prefix', phrase: 'rflc', prompt: 'review, fix, loop, commit', updatedAt: 5 },
      { id: 'contains', phrase: 'full-rfl', prompt: 'review all', updatedAt: 4 },
      { id: 'exact', phrase: 'RFL', prompt: 'review, fix, loop', updatedAt: 3 },
      { id: 'prefix-2', phrase: 'rfl-all', prompt: 'review everything', updatedAt: 2 },
      { id: 'contains-2', phrase: 'my-rfl', prompt: 'review mine', updatedAt: 1 }
    ];
    const state = createRunnerInteractionService({
      input,
      draftSessionOpen: { value: false } as Options['draftSessionOpen'],
      selectedSession: { value: undefined } as Options['selectedSession'],
      profile: { value: undefined } as Options['profile'],
      quickPrompts: ref(prompts)
    });

    state.updatePicker();
    expect(state.visibleQuickPrompts.value).toEqual(prompts);

    for (const query of ['#rfl', '#RfL']) {
      input.value = '#';
      state.updatePicker();
      input.value = query;
      state.activeCommandIndex.value = 2;
      state.updatePicker();
      expect(state.activeCommandIndex.value).toBe(0);
      expect(state.visibleQuickPrompts.value.map((prompt) => prompt.id)).toEqual([
        'exact',
        'prefix',
        'prefix-2',
        'contains',
        'contains-2'
      ]);

      state.onKeydown({ key: 'Enter', preventDefault() {} } as KeyboardEvent, {
        mobile: false,
        canInterrupt: false,
        stop: () => undefined,
        send: () => {
          throw new Error('Picking a quick prompt must not send the message');
        },
        selectQuickPrompt: (prompt) => state.selectQuickPrompt(prompt)
      });
      expect(input.value).toBe('review, fix, loop');
      expect(state.commandPickerOpen.value).toBe(false);
    }

    input.value = '#';
    state.updatePicker();
    expect(state.visibleQuickPrompts.value).toEqual(prompts);
    input.value = '#missing';
    state.updatePicker();
    expect(state.visibleQuickPrompts.value).toEqual([]);
  });
});
