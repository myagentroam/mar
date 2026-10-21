import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { createWorkbenchComposerInteractionController } from '../../src/service/WorkbenchComposerInteractionController.js';
import { createRunnerInteractionService } from '../../src/service/RunnerInteractionService.js';
import { createFileReferenceService } from '../../src/service/FileReferenceService.js';

function fixture() {
  const input = ref('');
  const runnerInteractions = createRunnerInteractionService({
    input,
    draftSessionOpen: ref(true),
    selectedSession: ref(undefined),
    profile: ref({
      runner: 'codex',
      models: [],
      accessOptions: [],
      commands: [
        {
          id: 'plan',
          runner: 'codex',
          label: 'Plan',
          description: 'Plan the task',
          inputHint: '',
          source: 'CODEX_APP_SERVER',
          interaction: 'TOGGLE',
          available: true,
          reasonCode: null
        }
      ],
      capabilities: []
    }),
    quickPrompts: ref([
      { id: 'review', phrase: 'review', prompt: 'Review the changes', updatedAt: 1 }
    ])
  });
  const fileReferences = createFileReferenceService(input);
  const options = {
    input,
    workspaceTarget: ref<import('../../src/model/workbench.js').WorkspaceTarget | undefined>({
      nodeId: 'node',
      workspaceId: 'workspace'
    }),
    filesReady: ref(true),
    mobileViewport: ref(false),
    canInterruptTurn: ref(false),
    runnerProfilesLoading: ref(false),
    runnerProfilesFailed: ref(false),
    commandPickerOpen: runnerInteractions.commandPickerOpen,
    fileReferences,
    runnerInteractions,
    hasRunnerProfile: vi.fn(() => false),
    loadRunnerProfiles: vi.fn().mockResolvedValue(undefined),
    ensureComposerSkills: vi.fn(),
    ensureQuickPrompts: vi.fn(),
    selectSkill: vi.fn(),
    stopActiveRun: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(),
    loadOlderConversationTurns: vi.fn().mockResolvedValue(undefined),
    handleConversationScroll: vi.fn(),
    scrollToLatest: vi.fn(),
    scrollToLatestAfterLayout: vi.fn().mockResolvedValue(undefined),
    focusInputAt: vi.fn()
  };
  return { ...options, controller: createWorkbenchComposerInteractionController(options) };
}

describe('Public Composer Input Coordination', () => {
  it('Escape routes an active turn to the same stop callback as the toolbar', () => {
    const f = fixture();
    f.canInterruptTurn.value = true;
    const preventDefault = vi.fn();
    f.controller.onComposerKeydown({ key: 'Escape', preventDefault } as unknown as KeyboardEvent);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(f.stopActiveRun).toHaveBeenCalledOnce();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it('Escape closes a file picker without interrupting the active turn', () => {
    const f = fixture();
    f.canInterruptTurn.value = true;
    f.fileReferences.open.value = true;
    f.controller.onComposerKeydown({
      key: 'Escape',
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent);
    expect(f.fileReferences.open.value).toBe(false);
    expect(f.stopActiveRun).not.toHaveBeenCalled();
  });

  describe.each([false, true])('Picker Escape with mobile viewport %s', (mobile) => {
    it.each([
      { input: '/plan', kind: 'runner', count: 1 },
      { input: '/missing', kind: 'runner', count: 0 },
      { input: '#review', kind: 'quick-prompt', count: 1 },
      { input: '#missing', kind: 'quick-prompt', count: 0 }
    ])('closes $input before stopping an active turn', ({ input, kind, count }) => {
      const f = fixture();
      f.mobileViewport.value = mobile;
      f.canInterruptTurn.value = true;
      f.input.value = `Before ${input} After`;
      f.controller.onComposerInput(`Before ${input}`.length);
      expect(f.commandPickerOpen.value).toBe(true);
      expect(f.runnerInteractions.pickerKind.value).toBe(kind);
      expect(f.runnerInteractions.visibleEntryCount.value).toBe(count);

      const preventDefault = vi.fn();
      f.controller.onComposerKeydown({ key: 'Escape', preventDefault } as unknown as KeyboardEvent);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(f.commandPickerOpen.value).toBe(false);
      expect(f.runnerInteractions.pickerKind.value).toBeUndefined();
      expect(f.input.value).toBe(`Before ${input} After`);
      expect(f.stopActiveRun).not.toHaveBeenCalled();
      expect(f.sendMessage).not.toHaveBeenCalled();

      f.controller.onComposerKeydown({ key: 'Escape', preventDefault } as unknown as KeyboardEvent);
      expect(f.stopActiveRun).toHaveBeenCalledOnce();
    });
  });

  it.each(['/plan', '#review'])(
    'Escape dismisses %s while idle without changing the draft',
    (input) => {
      const f = fixture();
      f.input.value = input;
      f.controller.onComposerInput();
      const preventDefault = vi.fn();
      f.controller.onComposerKeydown({ key: 'Escape', preventDefault } as unknown as KeyboardEvent);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(f.commandPickerOpen.value).toBe(false);
      expect(f.input.value).toBe(input);
      expect(f.stopActiveRun).not.toHaveBeenCalled();
      expect(f.sendMessage).not.toHaveBeenCalled();
      f.controller.onComposerInput();
      expect(f.commandPickerOpen.value).toBe(true);
    }
  );

  it('Keyboard input loads skill, profile, or quick-prompt candidates for the word at the cursor; paste does not load candidates', () => {
    const f = fixture();
    f.input.value = '/plan';
    f.controller.onComposerInput();
    expect(f.ensureComposerSkills).toHaveBeenCalledOnce();
    expect(f.loadRunnerProfiles).toHaveBeenCalledWith('node');
    f.input.value = '#prompt';
    f.controller.onComposerInput();
    expect(f.ensureQuickPrompts).toHaveBeenCalledOnce();
    f.input.value = '/paste';
    f.controller.onComposerInput(f.input.value.length, 'paste');
    expect(f.ensureComposerSkills).toHaveBeenCalledOnce();
    expect(f.loadRunnerProfiles).toHaveBeenCalledOnce();
    expect(f.commandPickerOpen.value).toBe(false);
    expect(f.fileReferences.open.value).toBe(false);
  });

  it('File candidates and commands are mutually exclusive; Enter selects a resource tag, restores the cursor, and does not submit the message', () => {
    const f = fixture();
    f.input.value = '@src';
    f.commandPickerOpen.value = true;
    f.controller.onComposerCursor(f.input.value.length);
    expect(f.commandPickerOpen.value).toBe(false);
    f.fileReferences.entries.value = [{ path: 'src/main.ts', name: 'main.ts', kind: 'FILE' }];
    const preventDefault = vi.fn();
    f.controller.onComposerKeydown({ key: 'Enter', preventDefault } as unknown as KeyboardEvent);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(f.input.value).toBe('');
    expect(f.fileReferences.selected.value).toEqual([
      { type: 'file', path: 'src/main.ts', label: 'main.ts' }
    ]);
    expect(f.focusInputAt).toHaveBeenCalledWith(f.input.value.length);
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it('Closes file candidates when file capabilities or the Workspace is unavailable', () => {
    const f = fixture();
    f.input.value = '@src';
    f.filesReady.value = false;
    f.controller.onComposerInput();
    expect(f.fileReferences.open.value).toBe(false);
    f.filesReady.value = true;
    f.workspaceTarget.value = undefined;
    f.controller.onComposerInput();
    expect(f.fileReferences.open.value).toBe(false);
  });
});
