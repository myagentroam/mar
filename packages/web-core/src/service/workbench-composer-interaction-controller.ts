import type { WorkspaceTarget } from '../model/workbench.js';
import type { Ref } from 'vue';
import type {
  ComposerReferenceCandidate,
  ComposerRangeEdit
} from './composer-reference-service.js';
import type { createComposerReferenceService } from './composer-reference-service.js';
import type { createRunnerInteractionService } from './runner-interaction-service.js';
import { quickPromptAtCursor, slashCommandAtCursor } from './runner-interaction-service.js';

interface WorkbenchComposerInteractionOptions {
  readonly input: Ref<string>;
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly filesReady: Readonly<Ref<boolean>>;
  readonly mobileViewport: Readonly<Ref<boolean>>;
  readonly canInterruptTurn: Readonly<Ref<boolean>>;
  readonly runnerProfilesLoading: Ref<boolean>;
  readonly runnerProfilesFailed: Ref<boolean>;
  readonly commandPickerOpen: Ref<boolean>;
  readonly fileReferences: ReturnType<typeof createComposerReferenceService>;
  readonly runnerInteractions: ReturnType<typeof createRunnerInteractionService>;
  readonly hasRunnerProfile: (nodeId: string) => boolean;
  readonly loadRunnerProfiles: (nodeId: string) => Promise<unknown>;
  readonly ensureComposerSkills: () => void;
  readonly ensureQuickPrompts: () => void;
  readonly selectSkill: (
    skill: Parameters<ReturnType<typeof createRunnerInteractionService>['selectSkill']>[0],
    cursor: number
  ) => void;
  readonly stopActiveRun: () => Promise<unknown>;
  readonly sendMessage: (
    replaceCurrent: boolean,
    preserveDraft?: boolean,
    contentOverride?: string
  ) => void;
  readonly loadOlderConversationTurns: () => Promise<unknown>;
  readonly handleConversationScroll: (loadOlder: () => void) => void;
  readonly scrollToLatest: () => void;
  readonly scrollToLatestAfterLayout: () => Promise<void>;
  readonly editRange: ComposerRangeEdit;
}

export function createWorkbenchComposerInteractionController(
  options: WorkbenchComposerInteractionOptions
) {
  function updatePickers(cursor = options.input.value.length): void {
    options.runnerInteractions.onInput(cursor);
    options.fileReferences.update(cursor);
    if (
      (!options.filesReady.value && !options.fileReferences.sessionAvailable()) ||
      options.workspaceTarget.value?.workspaceId === undefined
    )
      options.fileReferences.close();
    if (options.fileReferences.open.value) options.commandPickerOpen.value = false;
    options.fileReferences.scheduleSearch();
  }

  function onComposerInput(
    cursor = options.input.value.length,
    source: 'keyboard' | 'paste' = 'keyboard'
  ): void {
    if (source === 'paste') {
      options.commandPickerOpen.value = false;
      options.fileReferences.cancelSearch();
      options.fileReferences.close();
      return;
    }
    const slashQuery = slashCommandAtCursor(options.input.value, cursor);
    const quickPromptQuery = quickPromptAtCursor(options.input.value, cursor);
    updatePickers(cursor);
    if (options.fileReferences.open.value) return;
    if (slashQuery !== undefined) options.ensureComposerSkills();
    if (quickPromptQuery !== undefined) options.ensureQuickPrompts();
    if (
      slashQuery !== undefined &&
      options.workspaceTarget.value?.nodeId !== undefined &&
      !options.runnerProfilesLoading.value &&
      (options.runnerProfilesFailed.value ||
        !options.hasRunnerProfile(options.workspaceTarget.value?.nodeId))
    )
      void options.loadRunnerProfiles(options.workspaceTarget.value?.nodeId);
  }

  function onComposerCursor(cursor: number): void {
    updatePickers(cursor);
  }

  function onComposerKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (options.fileReferences.open.value) {
      if (
        (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
        options.fileReferences.candidates.value.length > 0
      ) {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        options.fileReferences.activeIndex.value =
          (options.fileReferences.activeIndex.value +
            delta +
            options.fileReferences.candidates.value.length) %
          options.fileReferences.candidates.value.length;
        return;
      }
      if (
        event.key === 'Enter' &&
        !options.mobileViewport.value &&
        !event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault();
        const entry =
          options.fileReferences.candidates.value[options.fileReferences.activeIndex.value];
        if (entry !== undefined) selectReference(entry);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        options.fileReferences.cancelSearch();
        options.fileReferences.close();
        return;
      }
    }
    options.runnerInteractions.onKeydown(event, {
      mobile: options.mobileViewport.value,
      canInterrupt: options.canInterruptTurn.value,
      stop: () => void options.stopActiveRun(),
      send: options.sendMessage,
      selectQuickPrompt: selectQuickPrompt,
      selectSkill: options.selectSkill
    });
  }

  function selectReference(entry: ComposerReferenceCandidate): void {
    options.fileReferences.selectCandidate(entry, options.editRange);
  }

  function selectQuickPrompt(
    prompt: Parameters<typeof options.runnerInteractions.selectQuickPrompt>[0]
  ): void {
    options.runnerInteractions.selectQuickPrompt(prompt, options.editRange);
  }

  function onComposerScroll(): void {
    options.handleConversationScroll(() => void options.loadOlderConversationTurns());
  }

  return {
    onComposerCursor,
    onComposerInput,
    onComposerKeydown,
    onComposerScroll,
    scrollConversationToLatest: options.scrollToLatest,
    scrollConversationToLatestAfterLayout: options.scrollToLatestAfterLayout,
    selectReference,
    selectQuickPrompt
  };
}
